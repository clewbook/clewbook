//! Sealed bid auctions (SPEC §9): the transactions a deposit needs besides its early ticket, built from the campaign wallet's own notes,
//! and the host's coins, paid from a separate wallet of the host's own funds. Ported from the two ticket prototype (research note 16).

use anyhow::ensure;
use incrementalmerkletree::Position;
use zcash_address::ToAddress as _;
use orchard::{
    builder::{Builder as IwBuilder, BundleType},
    bundle::BundleVersion,
    value::NoteValue,
};
use zcash_client_backend::data_api::WalletCommitmentTrees;
use zcash_primitives::transaction::{
    TransactionData,
    builder::{BundlePadding, DeferredPcztBuilder},
    fees::zip317,
    sighash::{SignableInput, signature_hash},
    txid::{TxIdDigester, to_txid},
};
use zcash_protocol::{memo::MemoBytes, value::ZatBalance};
use zcash_transparent::{
    address::{Script, TransparentAddress},
    builder::{SpendInfo, TransparentBuilder, TransparentInputInfo},
    bundle::{Authorized as TAuthorized, Bundle as TBundle, OutPoint, TxIn, TxOut},
};

use super::*;

/// A transparent input's sequence number below the final one, so that the lock time is enforced (14, section 3.5).
pub const SEQUENCE_NON_FINAL: u32 = 0xffff_fffe;

/// The person who bid page's coin, which the late ticket spends next to the deposit.
pub struct CoinInput {
    /// The coin transaction (display order) and the output's index in it.
    pub txid: String,
    pub index: u32,
    pub value_zat: u64,
    /// The page's compressed public key (from the deposit's memo); the coin pays its P2PKH address.
    pub page_key: [u8; 33],
}

impl LibsBackend {
    /// The Ironwood proving key for `branch`, built once.
    fn ironwood_pk(&mut self, branch: BranchId) -> Result<&orchard::circuit::ProvingKey> {
        let raw = u32::from(branch);
        if self.proving_key.as_ref().is_none_or(|(b, _)| *b != raw) {
            let version = zcash_primitives::transaction::components::orchard::bundle_version_for_branch(branch, orchard::ValuePool::Orchard)
                .context("branch does not support Orchard circuits")?
                .circuit_version();
            self.proving_key = Some((raw, orchard::circuit::ProvingKey::build(version)));
        }
        Ok(&self.proving_key.as_ref().expect("built").1)
    }

    /// The campaign account's full viewing key and spend authorizing key (Ironwood uses the Orchard keys).
    fn campaign_keys(&self, db: &Db) -> Result<(orchard::keys::FullViewingKey, orchard::keys::SpendAuthorizingKey)> {
        let account = db.get_account(Self::account_id(db)?)?.context("no account")?;
        let fvk = account.ufvk().and_then(|u| u.orchard().cloned()).context("the account has no Orchard/Ironwood key")?;
        let index = match account.source() {
            zcash_client_backend::data_api::AccountSource::Derived { derivation, .. } => derivation.account_index(),
            _ => bail!("campaign account must be derived from the wallet seed"),
        };
        let usk = UnifiedSpendingKey::from_seed(&self.params, self.seed()?.expose_secret(), index)?;
        Ok((fvk, orchard::keys::SpendAuthorizingKey::from(usk.orchard())))
    }

    /// The deposit locked under `owner` (the same selection as its early ticket): its note, its position in the note tree and the height
    /// the wallet would anchor a spend of it at.
    fn locked_note(&self, db: &mut Db, owner: &str, to: &str, value: u64) -> Result<(orchard::Note, Position, BlockHeight)> {
        let account = Self::account_id(db)?;
        let change = MultiOutputChangeStrategy::new(StandardFeeRule::Zip317, None, ShieldedPool::Orchard, DustOutputPolicy::default(), SplitPolicy::single_output());
        let payment = Payment::new(ZcashAddress::from_str(to).map_err(|e| anyhow!("{e}"))?, Some(Zatoshis::from_u64(value)?), None, None, None, vec![])
            .map_err(|e| anyhow!("{e:?}"))?;
        let request = TransactionRequest::new(vec![payment]).map_err(|e| anyhow!("{e:?}"))?;
        let owners = NonEmptyBTreeSet::from_set([lock_owner(owner)].into_iter().collect()).context("no owner")?;
        let policy = SpendPolicy::default().with_locked_input_policy(LockedInputPolicy::PreferLocked(owners));
        let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
            db, &self.params, account, &GreedyInputSelector::new(), &change, request,
            ConfirmationsPolicy::new_symmetrical(std::num::NonZeroU32::MIN, true), &policy, None, None,
        )
        .map_err(|e| anyhow!("proposal failed: {e:?}"))?;
        let step = proposal.steps().first();
        let inputs = step.shielded_inputs().context("the deposit is not selected")?;
        ensure!(inputs.notes().len() == 1, "expected exactly the deposit, the wallet selected {} notes", inputs.notes().len());
        let selected = &inputs.notes()[0];
        let note = match selected.note() {
            zcash_client_backend::wallet::Note::Orchard { note, pool: orchard::ValuePool::Ironwood } => *note,
            _ => bail!("the deposit is not an Ironwood note"),
        };
        Ok((note, selected.note_commitment_tree_position(), step.anchor_height().context("no anchor height")?))
    }

    /// The note tree's root at `height` and the witness of the note at `position` against it.
    fn witness(db: &mut Db, position: Position, height: BlockHeight) -> Result<(orchard::Anchor, orchard::tree::MerklePath)> {
        db.with_ironwood_tree_mut::<_, _, anyhow::Error>(|tree| {
            let root = tree.root_at_checkpoint_id(&height)?.context("no note tree root at the anchor height")?;
            let path = tree.witness_at_checkpoint_id_caching(position, &height)?.context("the witness was pruned")?;
            Ok((orchard::Anchor::from(root), orchard::tree::MerklePath::from(path)))
        })?
        .context("the wallet has no Ironwood note tree")
    }

    fn next_height(db: &Db) -> Result<BlockHeight> {
        Ok(db.chain_height()?.context("the wallet has not synced")? + 1)
    }

    fn ironwood_address(to: &str) -> Result<orchard::Address> {
        let (_, raw) = ll_core::receiver::orchard_receiver(to)?;
        Option::from(orchard::Address::from_raw_address_bytes(&raw)).context("not a valid Ironwood address")
    }

    /// The refund signed now and finished only at the close (ZIP 374): it spends the deposit locked under `owner` and pays `value` to `to`,
    /// with no anchor, witness or proof yet. Returns the signed PCZT and the transaction's id, which a version 6 transaction fixes before
    /// its anchor and proof (they are authorizing data).
    pub fn signed_refund_impl(&mut self, owner: &str, to: &str, value: u64) -> Result<(Vec<u8>, String)> {
        let mut db = self.db()?;
        let (note, _, _) = self.locked_note(&mut db, owner, to, value)?;
        let (fvk, ask) = self.campaign_keys(&db)?;
        let target = Self::next_height(&db)?;
        let mut b = DeferredPcztBuilder::new::<std::convert::Infallible>(self.params, target, BundlePadding::DEFAULT, BundlePadding::DEFAULT)
            .map_err(|e| anyhow!("deferred builder: {e:?}"))?
            .with_expiry_height(BlockHeight::from_u32(0));
        b.add_ironwood_spend::<std::convert::Infallible>(fvk, note).map_err(|e| anyhow!("{e:?}"))?;
        b.add_ironwood_output::<std::convert::Infallible>(None, Self::ironwood_address(to)?, Zatoshis::from_u64(value)?, MemoBytes::empty())
            .map_err(|e| anyhow!("{e:?}"))?;
        let res = b.build_for_pczt(rng(), &zip317::FeeRule::standard()).map_err(|e| anyhow!("deferred build: {e:?}"))?;
        let idx = res.ironwood_meta.spend_action_index(0).context("no spend action")?;
        let pczt = pczt::roles::creator::Creator::build_from_parts(res.pczt_parts).context("creator")?;
        let pczt = pczt::roles::io_finalizer::IoFinalizer::new(pczt).finalize_io(rng()).map_err(|e| anyhow!("io: {e:?}"))?;
        let mut s = Signer::new(pczt).map_err(|e| anyhow!("{e:?}"))?;
        s.sign_ironwood(rng(), idx, &ask).map_err(|e| anyhow!("sign: {e:?}"))?;
        let pczt = s.finish();
        let txid = pczt_txid(&pczt)?;
        Ok((pczt.serialize().map_err(|e| anyhow!("{e:?}"))?, txid))
    }

    /// Finishes a signed refund at the close: the anchor and witness of today's note tree, the proof. Returns the final transaction bytes.
    pub fn finish_refund_impl(&mut self, signed: &[u8], owner: &str, to: &str, value: u64) -> Result<Vec<u8>> {
        let mut db = self.db()?;
        let (note, position, height) = self.locked_note(&mut db, owner, to, value)?;
        let (anchor, path) = Self::witness(&mut db, position, height)?;
        let (fvk, _) = self.campaign_keys(&db)?;
        let nf = note.nullifier(&fvk).to_bytes();
        let pczt = Pczt::parse(signed).map_err(|e| anyhow!("unreadable PCZT: {e:?}"))?;
        let idx = pczt.ironwood().actions().iter().position(|a| *a.spend().nullifier() == nf).context("the signed refund does not spend this deposit")?;
        let pczt = pczt::roles::updater::Updater::new(pczt)
            .set_ironwood_anchor(anchor)
            .map_err(|e| anyhow!("{e:?}"))?
            .set_ironwood_spend_witnesses([(idx, path)])
            .map_err(|e| anyhow!("{e:?}"))?
            .finish();
        let branch = BranchId::try_from(*pczt.global().consensus_branch_id()).map_err(|_| anyhow!("unknown branch"))?;
        let pk = self.ironwood_pk(branch)?;
        let pczt = Prover::new(pczt).create_ironwood_proof(rng(), pk).map_err(|e| anyhow!("prove: {e:?}"))?.finish();
        let pczt = SpendFinalizer::new(pczt).finalize_spends().map_err(|e| anyhow!("{e:?}"))?;
        let tx = TransactionExtractor::new(pczt).extract(rng()).map_err(|e| anyhow!("extract: {e:?}"))?;
        let mut raw = vec![];
        tx.write(&mut raw)?;
        Ok(raw)
    }

    /// The host's part of the late ticket: it spends the deposit locked under `owner` and the page's coin, pays `value` to `to`, has lock
    /// time `lock_time` and no expiry. The host proves and signs the Ironwood part; the coin's signature is left empty for the page, which
    /// checks everything before it signs. The refund output is made with a fresh outgoing viewing key, given to the page with the anchor's
    /// height. Returns that package (`ticket_blob::LatePart`, encoded) and the transaction's id (which does not cover signatures).
    pub fn late_ticket_impl(&mut self, owner: &str, to: &str, value: u64, coin: &CoinInput, lock_time: u32) -> Result<(Vec<u8>, String)> {
        let mut db = self.db()?;
        // the selection is the early ticket's (the deposit minus the refund fee); the late ticket also spends the coin, whose value pays
        // the fee of its extra action, so it pays the same amount back
        let (note, position, height) = self.locked_note(&mut db, owner, to, value)?;
        let (anchor, path) = Self::witness(&mut db, position, height)?;
        let (fvk, ask) = self.campaign_keys(&db)?;
        let branch = BranchId::for_height(&self.params, Self::next_height(&db)?);
        let mut r = rng();
        let v = BundleVersion::ironwood_v3();
        let mut b = IwBuilder::new(BundleType::DEFAULT, v, v.default_flags(), anchor).map_err(|e| anyhow!("{e:?}"))?;
        b.add_spend(fvk, note, path).map_err(|e| anyhow!("{e:?}"))?;
        let mut ovk = [0u8; 32];
        rand::Rng::fill_bytes(&mut rng(), &mut ovk);
        b.add_output(Some(orchard::keys::OutgoingViewingKey::from(ovk)), Self::ironwood_address(to)?, NoteValue::from_raw(value), [0u8; 512])
            .map_err(|e| anyhow!("{e:?}"))?;
        let iw = b.build::<ZatBalance>(&mut r).map_err(|e| anyhow!("{e:?}"))?.context("empty bundle")?.0;
        let pubkey = secp256k1::PublicKey::from_slice(&coin.page_key).map_err(|_| anyhow!("the page key is not a public key"))?;
        let mut prevout = ll_core::hex32(&coin.txid)?;
        prevout.reverse();
        let mut tb = TransparentBuilder::empty();
        tb.add_input(
            TransparentInputInfo::from_parts(
                OutPoint::new(prevout, coin.index),
                TxOut::new(Zatoshis::from_u64(coin.value_zat)?, TransparentAddress::from_pubkey(&pubkey).script().into()),
                SpendInfo::P2pkh { pubkey },
            )
            .map_err(|e| anyhow!("{e:?}"))?,
        );
        let mut t = tb.build().context("transparent part")?;
        #[allow(deprecated)]
        {
            t.vin[0].sequence = SEQUENCE_NON_FINAL; // the libraries write the final number otherwise, which switches the lock time off
        }
        let unauthed: TransactionData<zcash_primitives::transaction::Unauthorized> = TransactionData::from_parts_v6(branch, lock_time, BlockHeight::from_u32(0), Some(t.clone()), None, None, Some(iw.clone()));
        let parts = unauthed.digest(TxIdDigester);
        let sighash = signature_hash(&unauthed, &SignableInput::Shielded, &parts);
        let pk = self.ironwood_pk(branch)?;
        let iw = iw.create_proof(pk, &mut r).map_err(|e| anyhow!("prove: {e:?}"))?.apply_signatures(&mut r, *sighash.as_ref(), &[ask]).map_err(|e| anyhow!("sign: {e:?}"))?;
        #[allow(deprecated)]
        let vin = t.vin.iter().map(|i| Ok(TxIn { prevout: i.prevout.clone(), script_sig: Script::read(&mut &[0u8][..])?, sequence: i.sequence })).collect::<Result<_>>()?;
        let t = TBundle { vin, vout: vec![], authorization: TAuthorized };
        let tx = TransactionData::from_parts_v6(branch, lock_time, BlockHeight::from_u32(0), Some(t), None, None, Some(iw)).freeze()?;
        let mut raw = vec![];
        tx.write(&mut raw)?;
        let part = ll_core::ticket_blob::LatePart { ovk, anchor_height: u32::from(height), raw };
        Ok((part.encode(), tx.txid().to_string()))
    }

    /// Pays each `(page key, zatoshis)` to the page key's transparent address in one transaction from this wallet (the host's coin wallet),
    /// and sends it. Returns the transaction's id and, for each payment, its output index.
    pub fn pay_coins_impl(&mut self, outs: &[([u8; 33], u64)]) -> Result<(String, Vec<u32>)> {
        let mut db = self.db()?;
        let account = Self::account_id(&db)?;
        let net = self.params.network_type();
        let scripts: Vec<Vec<u8>> = outs.iter().map(|(k, _)| p2pkh_script(k)).collect();
        let payments = outs
            .iter()
            .map(|(k, v)| {
                let pk = secp256k1::PublicKey::from_slice(k).map_err(|_| anyhow!("a page key is not a public key"))?;
                let TransparentAddress::PublicKeyHash(h) = TransparentAddress::from_pubkey(&pk) else { unreachable!() };
                Payment::new(ZcashAddress::from_transparent_p2pkh(net, h), Some(Zatoshis::from_u64(*v)?), None, None, None, vec![]).map_err(|e| anyhow!("{e:?}"))
            })
            .collect::<Result<Vec<_>>>()?;
        let request = TransactionRequest::new(payments).map_err(|e| anyhow!("{e:?}"))?;
        let change = MultiOutputChangeStrategy::new(StandardFeeRule::Zip317, None, ShieldedPool::Orchard, DustOutputPolicy::default(), SplitPolicy::single_output());
        let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
            &mut db, &self.params, account, &GreedyInputSelector::new(), &change, request,
            ConfirmationsPolicy::new_symmetrical(std::num::NonZeroU32::MIN, true), &SpendPolicy::default(), None, None,
        )
        .map_err(|e| anyhow!("the coin wallet cannot pay the coins: {e:?}"))?;
        let pczt = create_pczt_from_proposal::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut db, &self.params, &SystemClock, &mut rng(), account, OvkPolicy::Discard, &proposal, None, zcash_primitives::transaction::builder::BundlePadding::DEFAULT,
        )
        .map_err(|e| anyhow!("PCZT creation failed: {e:?}"))?;
        let branch = BranchId::try_from(*pczt.global().consensus_branch_id()).map_err(|_| anyhow!("unknown branch"))?;
        let mut prover = Prover::new(pczt);
        if prover.requires_ironwood_proof() {
            let pk = self.ironwood_pk(branch)?;
            prover = prover.create_ironwood_proof(rng(), pk).map_err(|e| anyhow!("prove: {e:?}"))?;
        }
        ensure!(!prover.requires_orchard_proof() && !prover.requires_sapling_proofs(), "the coin wallet must hold Ironwood funds only");
        let unsigned = prover.finish().serialize().map_err(|e| anyhow!("{e:?}"))?;
        let signed = self.sign(&unsigned)?;
        let (raw, txid) = Self::extract_raw(&signed)?;
        let tx = Transaction::read(&raw[..], branch)?;
        let vout = tx.transparent_bundle().map(|b| b.vout.clone()).unwrap_or_default();
        let index = scripts
            .iter()
            .map(|s| vout.iter().position(|o| out_script(o) == *s).map(|i| i as u32).context("a coin output is missing"))
            .collect::<Result<Vec<_>>>()?;
        self.broadcast_raw(&raw)?;
        Ok((txid, index))
    }

    /// SPEC §9.1, open_payouts: the outputs of each payment the host signed to a person, opened on the chain with its outgoing viewing key: `keys` is
    /// `(txid display order, ovk hex)` as `sealed_recount::payout_keys` names them.
    pub fn payout_facts_impl(&mut self, keys: &[(String, String)]) -> Result<Vec<ll_core::recount::PayoutFact>> {
        let mut client = self.client()?;
        let tip = Self::next_height(&self.db()?)?;
        let mut out = vec![];
        for (t, k) in keys {
            let mut b = ll_core::hex32(t)?;
            b.reverse();
            let ovk = orchard::keys::OutgoingViewingKey::from(ll_core::hex32(k)?);
            let fact = match self.fetch(&mut client, tip, TxId::from_bytes(b))? {
                None => ll_core::recount::PayoutFact { txid: t.clone(), outputs: vec![], error: Some("the transaction is not on the chain".into()) },
                Some((tx, _)) => ll_core::recount::PayoutFact {
                    txid: t.clone(),
                    outputs: tx
                        .ironwood_bundle()
                        .map(|b| b.recover_outputs_with_ovks(&[ovk]))
                        .unwrap_or_default()
                        .into_iter()
                        .map(|r| ll_core::recount::PaidOutput { receiver_hex: hex::encode(r.3.to_raw_address_bytes()), value_zat: r.2.value().inner() })
                        .collect(),
                    error: None,
                },
            };
            out.push(fact);
        }
        Ok(out)
    }

    /// The transparent outputs of the coin transactions `txids` (display order), with the height each was mined at.
    pub fn coin_facts_impl(&mut self, txids: &[String]) -> Result<Vec<ll_core::recount::CoinFact>> {
        let mut client = self.client()?;
        let tip = Self::next_height(&self.db()?)?;
        let mut out = vec![];
        for t in txids {
            let mut b = ll_core::hex32(t)?;
            b.reverse();
            let Some((tx, height)) = self.fetch(&mut client, tip, TxId::from_bytes(b))? else { continue };
            for (i, o) in tx.transparent_bundle().map(|b| b.vout.clone()).unwrap_or_default().iter().enumerate() {
                out.push(ll_core::recount::CoinFact {
                    txid: t.clone(),
                    index: i as u32,
                    value_zat: o.value().into_u64(),
                    script_hex: hex::encode(out_script(o)),
                    height: height.map(u32::from),
                });
            }
        }
        Ok(out)
    }

    /// The times of blocks `from` to `to` (unix seconds).
    pub fn block_times_impl(&mut self, from: u32, to: u32) -> Result<Vec<(u32, u64)>> {
        let mut client = self.client()?;
        (from..=to)
            .map(|h| {
                let b = self.rt.block_on(client.get_block(service::BlockId { height: u64::from(h), hash: vec![] }))?.into_inner();
                Ok((h, u64::from(b.time)))
            })
            .collect()
    }

    /// The time of the chain's latest block (unix seconds), from the server.
    pub fn tip_time_impl(&mut self) -> Result<u64> {
        let mut client = self.client()?;
        let tip = self.rt.block_on(client.get_latest_block(service::ChainSpec {}))?.into_inner();
        let block = self.rt.block_on(client.get_block(service::BlockId { height: tip.height, hash: vec![] }))?.into_inner();
        Ok(u64::from(block.time))
    }
}

/// The P2PKH script of a compressed public key.
pub fn p2pkh_script(page_key: &[u8; 33]) -> Vec<u8> {
    hex::decode(ll_core::sealed_recount::p2pkh_script_hex(page_key)).expect("hex")
}

fn out_script(o: &TxOut) -> Vec<u8> {
    let mut w = vec![];
    o.write(&mut w).expect("in memory");
    // value (8 bytes), then the script with its CompactSize length (one byte below 0xfd)
    w.get(9..).map(<[u8]>::to_vec).unwrap_or_default()
}

/// The id of a PCZT's transaction, from its effects (version 6 ids do not cover anchors, proofs or signatures).
pub fn pczt_txid(pczt: &Pczt) -> Result<String> {
    let effects = pczt.clone().into_effects().map_err(|e| anyhow!("{e:?}"))?;
    let digests = effects.digest(TxIdDigester);
    Ok(to_txid(effects.version(), effects.consensus_branch_id(), &digests).to_string())
}
