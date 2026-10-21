//! Recount in the browser (spike S4). JavaScript fetches compact blocks and full
//! transactions over gRPC-web; this module trial-decrypts them with the campaign's viewing
//! key, tracks spends by nullifier, and runs the same `ll-core` recount as the command line.

use std::collections::HashMap;

use prost::Message;
use wasm_bindgen::prelude::*;
use zcash_client_backend::{
    proto::{
        compact_formats::CompactBlock,
        service::{BlockId, BlockRange, RawTransaction, TxFilter},
    },
    scanning::{ScanningKeys, SpendIdentifiers, scan_block},
};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network, NetworkType, NetworkUpgrade, Parameters};

/// The chain a recount reads: mainnet, testnet, or a private regtest chain (tests only; only a campaign whose own rules say "regtest" uses
/// it, with the activation heights of app/regtest: every upgrade at block 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Params {
    Net(Network),
    Regtest(zcash_protocol::local_consensus::LocalNetwork),
}

impl Parameters for Params {
    fn network_type(&self) -> NetworkType {
        match self { Params::Net(n) => n.network_type(), Params::Regtest(l) => l.network_type() }
    }
    fn activation_height(&self, nu: NetworkUpgrade) -> Option<BlockHeight> {
        match self { Params::Net(n) => n.activation_height(nu), Params::Regtest(l) => l.activation_height(nu) }
    }
}

fn regtest() -> zcash_protocol::local_consensus::LocalNetwork {
    let one = Some(BlockHeight::from_u32(1));
    zcash_protocol::local_consensus::LocalNetwork { overwinter: one, sapling: one, blossom: one, heartwood: one, canopy: one, nu5: one, nu6: one, nu6_1: one, nu6_2: one, nu6_3: one, nu7: one }
}

use ll_core::{
    keys::ContributorKeys,
    ledger::{Entry, blob_hash, check_chain, verifying_key},
    payload::Payload,
    receiver::{TYPECODE_ORCHARD, network_type, orchard_receiver},
    recount::{ChainNote, Challenge, CoinFact, DisclosureCheck, Extra, Spend, TxFacts, recount, recount_with, render},
    rules::Rules,
};

mod contribute;
mod sealed;

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// An auction before its close: its viewing key is sealed, so only R1 (the rules) and R2 (the signed list) can run, and every other check
/// waits for the key, as the command line recount shows them. Returns `{"all_pass":..,"rules":[{"id","title","pass","waiting","details"}]}`.
#[wasm_bindgen]
pub fn report_sealed(rules_json: &str, rules_id: &str, ledger_json: &str) -> Result<String, JsError> {
    let rules: Rules = serde_json::from_str(rules_json).map_err(js_err)?;
    let ledger: Vec<Entry> = serde_json::from_str(ledger_json).map_err(js_err)?;
    let r = ll_core::recount::recount(&rules, rules_id, &ledger, &[], &[], 0, false);
    Ok(serde_json::json!({
        "all_pass": r.all_pass(),
        "rules": r.results.iter().map(|x| serde_json::json!({"id": x.id, "title": x.title, "pass": x.pass, "waiting": x.waiting, "details": x.details})).collect::<Vec<_>>(),
    })
    .to_string())
}

/// A sealed bid auction before its viewing key is published, at chain height `tip` (no chain data needed): R1, R2, the waiting checks,
/// and whether the host did not finish (no close by the late ticket block, or no viewing key soon after it).
#[wasm_bindgen]
pub fn report_sealed_at(rules_json: &str, rules_id: &str, ledger_json: &str, tip: u32) -> Result<String, JsError> {
    let rules: Rules = serde_json::from_str(rules_json).map_err(js_err)?;
    let ledger: Vec<Entry> = serde_json::from_str(ledger_json).map_err(js_err)?;
    let r = ll_core::recount::recount(&rules, rules_id, &ledger, &[], &[], tip, false);
    Ok(serde_json::json!({
        "all_pass": r.all_pass(), "did_not_finish": r.did_not_finish, "tip": tip, "warnings": r.warnings,
        "rules": r.results.iter().map(|x| serde_json::json!({"id": x.id, "title": x.title, "pass": x.pass, "waiting": x.waiting, "details": x.details})).collect::<Vec<_>>(),
    })
    .to_string())
}

/// Builds a GetBlockRange request (inclusive range).
#[wasm_bindgen]
pub fn block_range_request(start: u32, end: u32) -> Vec<u8> {
    BlockRange {
        start: Some(BlockId { height: start.into(), hash: vec![] }),
        end: Some(BlockId { height: end.into(), hash: vec![] }),
        ..Default::default()
    }
    .encode_to_vec()
}

/// Builds a GetTransaction request for a txid in display order.
#[wasm_bindgen]
pub fn tx_filter_request(txid: &str) -> Result<Vec<u8>, JsError> {
    let mut hash = hex::decode(txid).map_err(js_err)?;
    hash.reverse();
    Ok(TxFilter { hash, ..Default::default() }.encode_to_vec())
}

/// Watches compact blocks for the spending of given coins by their nullifiers. Needs no viewing key: compact blocks
/// carry every action's nullifier. Used by the contribute page to see whether (and by which transaction, in which
/// block) a contributor's coin was spent.
#[wasm_bindgen]
pub struct SpendWatch {
    targets: std::collections::HashSet<String>,
    found: HashMap<String, (String, u32)>,
    last_height: u32,
}

#[wasm_bindgen]
impl SpendWatch {
    /// `nfs_json`: a JSON array of nullifiers in transaction byte order (lowercase hex).
    #[wasm_bindgen(constructor)]
    pub fn new(nfs_json: &str) -> Result<SpendWatch, JsError> {
        let v: Vec<String> = serde_json::from_str(nfs_json).map_err(js_err)?;
        Ok(SpendWatch { targets: v.into_iter().map(|x| x.to_lowercase()).collect(), found: HashMap::new(), last_height: 0 })
    }

    pub fn scan_block(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let block = CompactBlock::decode(bytes).map_err(js_err)?;
        let height = block.height as u32;
        for tx in &block.vtx {
            let mut txid = tx.txid.clone();
            txid.reverse();
            let txid = hex::encode(txid);
            for a in tx.ironwood_actions.iter() {
                let nf = hex::encode(&a.nullifier);
                if self.targets.contains(&nf) && !self.found.contains_key(&nf) {
                    self.found.insert(nf, (txid.clone(), height));
                }
            }
        }
        self.last_height = height;
        Ok(())
    }

    /// `{"txid": ..., "height": ...}` if this nullifier was seen spent, else an empty string.
    pub fn spent(&self, nf: &str) -> String {
        self.found.get(&nf.to_lowercase()).map(|(t, h)| serde_json::json!({ "txid": t, "height": h }).to_string()).unwrap_or_default()
    }

    pub fn last_height(&self) -> u32 {
        self.last_height
    }
}

#[wasm_bindgen]
pub struct Recount {
    params: Params,
    ufvk: UnifiedFullViewingKey,
    keys: ScanningKeys<u32, (u32, zip32::Scope)>,
    spend_ids: SpendIdentifiers<u32>,
    notes: Vec<ChainNote>,
    by_nf: HashMap<String, usize>,
    /// Full transactions seen so far (raw bytes by txid) and what they showed.
    raw_txs: HashMap<String, Vec<u8>>,
    facts: Vec<TxFacts>,
    /// Sealed bid auctions: the transparent outputs of the coin transactions named on the list, and the time of each block scanned.
    coins: Vec<CoinFact>,
    block_times: Vec<(u32, u64)>,
    last_height: u32,
    blocks: u32,
    actions: u64,
}

#[wasm_bindgen]
impl Recount {
    /// `network`: "test" or "main"; `ufvk`: the campaign's viewing key (any encoding).
    #[wasm_bindgen(constructor)]
    pub fn new(network: &str, ufvk: &str) -> Result<Recount, JsError> {
        let params = match network {
            "test" => Params::Net(Network::TestNetwork),
            "main" => Params::Net(Network::MainNetwork),
            "regtest" => Params::Regtest(regtest()),
            n => return Err(js_err(format!("unsupported network {n}"))),
        };
        let ufvk = UnifiedFullViewingKey::decode(&params, ufvk).map_err(js_err)?;
        let keys = ScanningKeys::from_account_ufvks([(0u32, ufvk.clone())]);
        Ok(Recount {
            params,
            ufvk,
            keys,
            spend_ids: SpendIdentifiers::empty(),
            notes: vec![],
            by_nf: HashMap::new(),
            raw_txs: HashMap::new(),
            facts: vec![],
            coins: vec![],
            block_times: vec![],
            last_height: 0,
            blocks: 0,
            actions: 0,
        })
    }

    /// Scans one CompactBlock (protobuf bytes). Blocks must be given in height order.
    pub fn scan_block(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        let block = CompactBlock::decode(bytes).map_err(js_err)?;
        self.block_times.push((block.height as u32, u64::from(block.time)));
        self.actions += block.vtx.iter().map(|t| (t.ironwood_actions.len() + t.actions.len()) as u64).sum::<u64>();
        let scanned = scan_block::<_, _, _, std::convert::Infallible>(&self.params, block, &self.keys, &self.spend_ids, None)
            .map_err(|e| js_err(format!("{e:?}")))?;
        let height = u32::from(scanned.height());
        let mut found = 0;
        for tx in scanned.transactions() {
            let txid = tx.txid().to_string();
            for out in tx.ironwood_outputs() {
                let nf = out.nf().map(|n| hex::encode(n.to_bytes()));
                if let Some(nf) = &nf {
                    self.by_nf.insert(nf.clone(), self.notes.len());
                }
                self.notes.push(ChainNote {
                    txid: txid.clone(),
                    action: out.index() as u32,
                    value_zat: out.note().0.value().inner(),
                    nf,
                    height: Some(height),
                    tx_index: Some(u32::from(tx.block_index())),
                    memo_text: None,
                    is_change: out.is_change(),
                    spent_by: None,
                });
                found += 1;
            }
            for spend in tx.ironwood_spends() {
                let nf = hex::encode(spend.nf().to_bytes());
                if let Some(&i) = self.by_nf.get(&nf) {
                    self.notes[i].spent_by = Some(Spend { txid: txid.clone(), height: Some(height) });
                }
            }
        }
        self.spend_ids.update_with(&scanned);
        self.last_height = height;
        self.blocks += 1;
        Ok(found)
    }

    /// Txids whose full transaction is needed (received, non-change notes: their memos).
    pub fn txids_needing_memos(&self) -> Vec<String> {
        let mut t: Vec<String> = self
            .notes
            .iter()
            .filter(|n| !n.is_change && n.memo_text.is_none())
            .map(|n| n.txid.clone())
            .collect();
        t.dedup();
        t
    }

    /// Txids of transactions that spent one of our notes (settlements and tickets): their full data
    /// shows the fee, the number of outputs and what a winner's key can open.
    pub fn txids_spending_notes(&self) -> Vec<String> {
        let mut t: Vec<String> = self.notes.iter().filter_map(|n| n.spent_by.as_ref().map(|s| s.txid.clone())).collect();
        t.sort();
        t.dedup();
        t
    }

    /// The notes found, as JSON (the treasury's notes are passed to `report_json` this way).
    pub fn notes_for_report(&self) -> String {
        serde_json::to_string(&self.notes).unwrap_or_default()
    }

    /// Decrypts a full transaction (RawTransaction protobuf) and records memos of our notes.
    pub fn add_raw_transaction(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        let raw = RawTransaction::decode(bytes).map_err(js_err)?;
        let height = BlockHeight::from_u32(raw.height as u32);
        let tx = Transaction::read(&raw.data[..], BranchId::for_height(&self.params, height)).map_err(js_err)?;
        let txid = tx.txid().to_string();
        if !self.raw_txs.contains_key(&txid) {
            let money = |z: zcash_protocol::value::ZatBalance| i64::from(z);
            let fee_zat = money(tx.sapling_value_balance())
                + tx.orchard_bundle().map_or(0, |b| money(*b.value_balance()))
                + tx.ironwood_bundle().map_or(0, |b| money(*b.value_balance()));
            self.facts.push(TxFacts {
                txid: txid.clone(),
                fee_zat,
                ironwood_actions: tx.ironwood_bundle().map_or(0, |b| b.actions().len()),
                has_orchard: tx.orchard_bundle().is_some(),
                has_sapling: tx.sapling_bundle().is_some(),
                has_transparent: tx.transparent_bundle().is_some(),
            });
            self.raw_txs.insert(txid.clone(), raw.data.clone());
        }
        let ufvks = HashMap::from([(0u32, self.ufvk.clone())]);
        let dec = zcash_client_backend::decrypt_transaction(&self.params, Some(height), None, &tx, &ufvks);
        let mut matched = 0;
        for out in dec.ironwood_outputs() {
            if let Some(n) = self.notes.iter_mut().find(|n| n.txid == txid && n.action as usize == out.index()) {
                n.memo_text = ll_core::memo_text(out.memo().as_slice());
                matched += 1;
            }
        }
        Ok(matched)
    }

    /// Sealed bid auctions: the coin transactions named on the list (`coin` entries), which the recount fetches in full.
    pub fn coin_txids(&self, ledger_json: &str) -> Result<Vec<String>, JsError> {
        let ledger: Vec<Entry> = serde_json::from_str(ledger_json).map_err(js_err)?;
        let mut t: Vec<String> = ledger.iter().filter_map(|e| e.coin.as_ref().map(|c| c.txid.clone())).collect();
        t.sort();
        t.dedup();
        Ok(t)
    }

    /// Records the transparent outputs of a coin transaction (RawTransaction protobuf; height 0 or less when not mined).
    pub fn add_coin_transaction(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        let raw = RawTransaction::decode(bytes).map_err(js_err)?;
        let mined = u32::try_from(raw.height).ok().filter(|h| *h > 0 && *h != u32::MAX);
        let tx = Transaction::read(&raw.data[..], BranchId::for_height(&self.params, BlockHeight::from_u32(mined.unwrap_or(self.last_height)))).map_err(js_err)?;
        let txid = tx.txid().to_string();
        self.coins.retain(|c| c.txid != txid);
        let outs = tx.transparent_bundle().map_or(&[][..], |b| &b.vout[..]);
        for (i, out) in outs.iter().enumerate() {
            let mut w = vec![];
            out.write(&mut w).map_err(js_err)?;
            self.coins.push(CoinFact { txid: txid.clone(), index: i as u32, value_zat: out.value().into_u64(), script_hex: hex::encode(script_of(&w[8..])), height: mined });
        }
        Ok(outs.len() as u32)
    }

    /// Runs the recount and returns the same text as `ll-recount`.
    pub fn report(&self, rules_json: &str, rules_id: &str, ledger_json: &str, challenges_json: &str) -> Result<String, JsError> {
        let rules: Rules = serde_json::from_str(rules_json).map_err(js_err)?;
        let ledger: Vec<Entry> = serde_json::from_str(ledger_json).map_err(js_err)?;
        let challenges: Vec<Challenge> = serde_json::from_str(challenges_json).map_err(js_err)?;
        let r = recount(&rules, rules_id, &ledger, &self.notes, &challenges, self.last_height, true);
        Ok(render(&r, &rules))
    }


    /// The recount as structured JSON for the recount page: each rule with PASS/FAIL and its evidence,
    /// the totals, warnings, and a fingerprint of everything the scan found (so two servers can be compared).
    pub fn report_json(&self, rules_json: &str, rules_id: &str, ledger_json: &str, challenges_json: &str, treasury_notes_json: &str) -> Result<String, JsError> {
        let rules: Rules = serde_json::from_str(rules_json).map_err(js_err)?;
        let ledger: Vec<Entry> = serde_json::from_str(ledger_json).map_err(js_err)?;
        let challenges: Vec<Challenge> = serde_json::from_str(challenges_json).map_err(js_err)?;
        let treasury_notes: Vec<ChainNote> = if treasury_notes_json.is_empty() { vec![] } else { serde_json::from_str(treasury_notes_json).map_err(js_err)? };
        // SPEC 9.1, open_payouts: who each payment the host signed to a person pays, opened with its key from the transactions already fetched
        let payouts = ll_core::sealed_recount::payout_keys(&rules, &ledger, &self.notes)
            .into_iter()
            .map(|(txid, k)| {
                let opened = match self.raw_txs.get(&txid) {
                    None => Err("the transaction was not fetched".to_string()),
                    Some(raw) => ll_core::hex32(&k).map_err(|e| e.to_string()).and_then(|ovk| ll_ticketcheck::recover_outputs(raw, &ovk)),
                };
                match opened {
                    Ok(o) => ll_core::recount::PayoutFact { txid, outputs: o.into_iter().map(|(r, v)| ll_core::recount::PaidOutput { receiver_hex: r, value_zat: v }).collect(), error: None },
                    Err(e) => ll_core::recount::PayoutFact { txid, outputs: vec![], error: Some(e) },
                }
            })
            .collect();
        let extra = Extra {
            checks: self.disclosure_checks(&rules, rules_id, &challenges),
            treasury_notes,
            tx_facts: self.facts.clone(),
            coins: self.coins.clone(),
            block_times: self.block_times.clone(),
            payouts,
        };
        let r = recount_with(&rules, rules_id, &ledger, &self.notes, &challenges, self.last_height, true, &extra);
        let t = &r.totals;
        let auction = r.auction.as_ref().map(|a| serde_json::json!({
            "price_zat": a.price_zat, "reserve_zat": a.reserve_zat, "winners": a.winners, "settled": a.settled, "awaiting": a.awaiting,
            "defaulted": a.defaulted, "settle_by": rules.settle_by(), "settle_window": rules.settle_by() - rules.deadline_height, "treasury_total_zat": a.treasury_total_zat, "excess_zat": a.excess_zat,
            "proofs_ok": a.proofs_ok, "complaints": a.complaints,
        }));
        let mut fp_lines: Vec<String> = extra.treasury_notes.iter().map(|n| format!("T {}:{}|{}|{:?}", n.txid, n.action, n.value_zat, n.height)).collect();
        fp_lines.extend(self.facts.iter().map(|f| format!("F {}|{}|{}|{}{}{}", f.txid, f.fee_zat, f.ironwood_actions, f.has_orchard, f.has_sapling, f.has_transparent)));
        fp_lines.sort();
        let fingerprint = hex::encode(ll_core::hash(b"LL fingerprint2", format!("{}\n{}", self.fingerprint(), fp_lines.join("\n")).as_bytes()));
        let mut out = serde_json::json!({
            "tip": r.tip, "phase": r.phase, "all_pass": r.all_pass(),
            "rules": r.results.iter().map(|x| serde_json::json!({"id": x.id, "title": x.title, "pass": x.pass, "details": x.details})).collect::<Vec<_>>(),
            "totals": {
                "raised_zat": t.raised_zat, "contributions": t.contributions, "withdrawn_zat": t.withdrawn_zat,
                "refunded_zat": t.refunded_zat, "kept_zat": t.kept_zat, "pending_zat": t.pending_zat,
                "donations_zat": t.donations_zat, "donations": t.donations,
            },
            "totals_visible": r.goal_met.is_some() || r.winners.is_some(),
            "goal_zat": rules.goal_zat, "goal_met": r.goal_met, "winners": r.winners, "warnings": r.warnings,
            "auction": auction,
            "fingerprint": fingerprint,
        });
        // a sealed bid auction only: its opened bids and outcome, and whether its host did not finish (other reports stay exactly as before)
        if let Some(s) = &r.sealed {
            out["sealed"] = serde_json::to_value(s).map_err(js_err)?;
            // a check that waits, or cannot conclude (L2), is marked so, and is never shown as a failure of the host
            for (i, _) in r.results.iter().enumerate().filter(|(_, x)| x.waiting) {
                out["rules"][i]["waiting"] = true.into();
            }
            out["did_not_finish"] = r.did_not_finish.into();
            out["totals_visible"] = (s.opened || s.void).into();
        }
        // a fundraiser with a hard cap only: the cap and what is over it (a report without a cap stays exactly as before, and so does its hash)
        if let Some(cap) = rules.cap_zat {
            out["cap_zat"] = cap.into();
            out["over_cap"] = t.over_cap.into();
            out["over_cap_zat"] = t.over_cap_zat.into();
        }
        Ok(out.to_string())
    }

    /// For each uniform-auction winner who published a viewing key (SPEC §8.5): does it derive the refund
    /// address inside the winner's own payload, and which outputs of the settlement transaction does it open?
    fn disclosure_checks(&self, rules: &Rules, rules_id: &str, challenges: &[Challenge]) -> Vec<DisclosureCheck> {
        use orchard::keys::{IncomingViewingKey, Scope};
        let Ok(payload_pk) = ll_core::hex32(&rules.payload_pubkey) else { return vec![] };
        let mut out = vec![];
        for c in challenges.iter().filter(|c| c.uivk.is_some()) {
            let mut chk = DisclosureCheck { txid: c.txid.clone(), action: c.action, key_matches_refund: false, delivered: vec![], error: None };
            let result = (|| -> Result<(), String> {
                let n = self.notes.iter().find(|n| n.txid == c.txid && n.action == c.action).ok_or("no such payment")?;
                let memo = n.memo_text.as_deref().ok_or("the payment's message was not read")?;
                let esk = crypto_box::SecretKey::from(ll_core::hex32(&c.eph_sk).map_err(|e| e.to_string())?);
                let p = Payload::open_challenged(memo, &payload_pk, &esk).map_err(|_| "the secret does not open the payload".to_string())?;
                if hex::encode(p.rules_id) != rules_id {
                    return Err("the payload belongs to another campaign".into());
                }
                // the key: an incoming viewing key (uivk...) or a full viewing key (uview.../uvf...)
                let text = c.uivk.as_deref().unwrap_or_default();
                let ivk: IncomingViewingKey = match zcash_keys::keys::UnifiedIncomingViewingKey::decode(&self.params, text) {
                    Ok(u) => u.orchard().clone().ok_or("the viewing key has no Orchard/Ironwood part")?,
                    Err(_) => {
                        let f = UnifiedFullViewingKey::decode(&self.params, text).map_err(|_| "not a viewing key".to_string())?;
                        f.orchard().ok_or("the viewing key has no Orchard/Ironwood part")?.to_ivk(Scope::External)
                    }
                };
                let addr = Option::from(orchard::Address::from_raw_address_bytes(&p.refund_receiver)).ok_or("bad refund address in the payload")?;
                chk.key_matches_refund = ivk.diversifier_index(&addr).is_some();
                if !chk.key_matches_refund {
                    return Ok(());
                }
                let settle_txid = n.spent_by.as_ref().map(|s| s.txid.clone()).ok_or("the note has not been spent yet")?;
                let raw = self.raw_txs.get(&settle_txid).ok_or("the settlement transaction was not fetched")?;
                let height = BlockHeight::from_u32(0);
                let tx = Transaction::read(&raw[..], BranchId::for_height(&self.params, height)).map_err(|e| e.to_string())?;
                if let Some(b) = tx.ironwood_bundle() {
                    for i in 0..b.actions().len() {
                        if let Some((note, _, _)) = b.decrypt_output_with_key(i, &ivk) {
                            chk.delivered.push(note.value().inner());
                        }
                    }
                }
                Ok(())
            })();
            if let Err(e) = result {
                chk.error = Some(e);
            }
            out.push(chk);
        }
        out
    }

    /// A hash of every payment found (position, amount, nullifier, memo, who spent it): equal on two
    /// servers exactly when both showed the same chain data for the scanned range.
    pub fn fingerprint(&self) -> String {
        let mut lines: Vec<String> = self
            .notes
            .iter()
            .map(|n| format!("{}:{}|{}|{:?}|{:?}|{}|{:?}|{:?}", n.txid, n.action, n.value_zat, n.nf, n.height, n.is_change, n.memo_text, n.spent_by.as_ref().map(|s| (&s.txid, s.height))))
            .collect();
        lines.sort();
        hex::encode(ll_core::hash(b"LL fingerprint ", lines.join("\n").as_bytes()))
    }

    /// The payment (`txid:action`) whose memo is exactly `memo`, if it has been seen (needs the
    /// memos fetched with `add_raw_transaction`). Lets a contributor find their own payment.
    pub fn find_payment(&self, memo: &str) -> Option<String> {
        self.notes
            .iter()
            .find(|n| !n.is_change && n.memo_text.as_deref() == Some(memo))
            .map(|n| format!("{}:{}", n.txid, n.action))
    }

    /// The amount (zatoshis) of the payment whose memo is exactly `memo`, if it has been seen (see `find_payment`).
    pub fn find_payment_value(&self, memo: &str) -> Option<f64> {
        self.notes.iter().find(|n| !n.is_change && n.memo_text.as_deref() == Some(memo)).map(|n| n.value_zat as f64)
    }

    /// Diagnostics: notes found so far, as JSON.
    pub fn notes_json(&self) -> String {
        serde_json::to_string(
            &self
                .notes
                .iter()
                .map(|n| {
                    serde_json::json!({
                        "txid": n.txid, "action": n.action, "value": n.value_zat, "nf": n.nf,
                        "height": n.height, "change": n.is_change, "memo": n.memo_text.as_deref().map(|m| m.chars().take(12).collect::<String>()),
                        "spent_by": n.spent_by.as_ref().map(|s| s.txid.clone()),
                    })
                })
                .collect::<Vec<_>>(),
        )
        .unwrap_or_default()
    }

    pub fn last_height(&self) -> u32 {
        self.last_height
    }
    pub fn blocks_scanned(&self) -> u32 {
        self.blocks
    }
    pub fn actions_seen(&self) -> f64 {
        self.actions as f64
    }
}

/// The script inside a serialized script field (a CompactSize length, then the bytes).
fn script_of(field: &[u8]) -> &[u8] {
    let (skip, len) = match field.first() {
        Some(&n) if n < 0xfd => (1, n as usize),
        Some(0xfd) if field.len() >= 3 => (3, u16::from_le_bytes([field[1], field[2]]) as usize),
        _ => return &[],
    };
    field.get(skip..skip + len).unwrap_or(&[])
}
