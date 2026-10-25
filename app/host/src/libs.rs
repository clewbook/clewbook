//! Option B: wallet operations through the Zcash wallet libraries directly (no devtool).
//! Uses the same wallet directory layout as zcash-devtool (`data.sqlite`, `keys.toml`).

use std::{
    collections::BTreeSet,
    fs,
    num::NonZeroUsize,
    path::PathBuf,
    str::FromStr,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, anyhow, bail};
use async_trait::async_trait;
use pczt::{
    Pczt,
    roles::{prover::Prover, signer::Signer, spend_finalizer::SpendFinalizer, tx_extractor::TransactionExtractor, verifier::Verifier},
};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use secrecy::{ExposeSecret, SecretVec};
use tokio::runtime::Runtime;
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        Account as _, OutputLockStore, TransactionDataRequest, TransactionStatus, WalletRead, WalletWrite,
        chain::{BlockCache, BlockSource, error as chain_error},
        locking::LockOwner,
        scanning::ScanRange,
        wallet::{
            ConfirmationsPolicy, create_pczt_from_proposal, decrypt_and_store_transaction,
            input_selection::{GreedyInputSelector, LockedInputPolicy, NonEmptyBTreeSet, SpendPolicy},
            propose_transfer,
        },
    },
    fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule, standard::MultiOutputChangeStrategy},
    proto::{
        compact_formats::CompactBlock,
        service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    },
    wallet::{OutputRef, OvkPolicy},
};
use zcash_client_sqlite::{WalletDb, util::SystemClock};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    PoolType, ShieldedPool, TxId,
    consensus::{BlockHeight, BranchId, Network, NetworkType, NetworkUpgrade, Parameters},
    value::Zatoshis,
};
use zip321::{Payment, TransactionRequest};

use ll_core::walletdb::{self, WalletNote};

use crate::backend::{AccountInfo, ChainTip, SpendRequest, WalletBackend};

mod sealed;
pub use sealed::CoinInput;

type Rng = UnwrapErr<SysRng>;
type Db = WalletDb<rusqlite::Connection, Params, SystemClock, Rng>;

/// The chain's consensus parameters: mainnet or testnet, or, in test builds with the `regtest` feature only, a private regtest chain with
/// the activation heights its wallet was created with. Normal builds have no regtest network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Params {
    Net(Network),
    #[cfg(feature = "regtest")]
    Local(zcash_protocol::local_consensus::LocalNetwork),
}

impl Parameters for Params {
    fn network_type(&self) -> NetworkType {
        match self {
            Params::Net(n) => n.network_type(),
            #[cfg(feature = "regtest")]
            Params::Local(l) => l.network_type(),
        }
    }
    fn activation_height(&self, nu: NetworkUpgrade) -> Option<BlockHeight> {
        match self {
            Params::Net(n) => n.activation_height(nu),
            #[cfg(feature = "regtest")]
            Params::Local(l) => l.activation_height(nu),
        }
    }
}

/// The address of the private chain's light wallet service (zebrad's own, plain gRPC on this machine).
#[cfg(feature = "regtest")]
pub fn regtest_server() -> String {
    std::env::var("CB_REGTEST_SERVER").unwrap_or_else(|_| "http://127.0.0.1:19067".into())
}

/// The private chain's current height, from its light wallet service (to give new regtest wallets a birthday after block 2).
#[cfg(feature = "regtest")]
pub fn regtest_tip() -> Result<u32> {
    let rt = Runtime::new()?;
    rt.block_on(async {
        let channel = Channel::from_shared(regtest_server())?.connect().await?;
        let mut c = CompactTxStreamerClient::new(channel);
        Ok::<u32, anyhow::Error>(c.get_latest_block(service::ChainSpec {}).await?.into_inner().height as u32)
    })
}

/// A regtest wallet's activation heights, as the wallet tool stores them in `keys.toml` (`[activation_heights]`, each a height or "never").
#[cfg(feature = "regtest")]
fn local_network(keys: &toml::Value) -> Result<zcash_protocol::local_consensus::LocalNetwork> {
    let t = keys.get("activation_heights").and_then(|v| v.as_table()).context("a regtest wallet needs its activation heights")?;
    let h = |k: &str| t.get(k).and_then(|v| v.as_integer()).map(|n| BlockHeight::from_u32(n as u32));
    Ok(zcash_protocol::local_consensus::LocalNetwork {
        overwinter: h("overwinter"), sapling: h("sapling"), blossom: h("blossom"), heartwood: h("heartwood"), canopy: h("canopy"),
        nu5: h("nu5"), nu6: h("nu6"), nu6_1: h("nu6_1"), nu6_2: h("nu6_2"), nu6_3: h("nu6_3"), nu7: h("nu7"),
    })
}

fn rng() -> Rng {
    UnwrapErr(SysRng)
}

pub struct LibsBackend {
    wallet: PathBuf,
    identity: PathBuf,
    params: Params,
    server: String,
    rt: Runtime,
    proving_key: Option<(u32, orchard::circuit::ProvingKey)>,
}

/// Blocks until a send that may expire (the coins of a blind bid auction) expires, on a network past NU7: ZIP 218 advises 120 for 25 second
/// blocks (the owner's decision of 22 Oct 2026). Before NU7 the wallet library's default stays (40 blocks).
pub const SEND_EXPIRY_AFTER_NU7: u32 = 120;

/// The expiry of a send that may expire, mined from `target` on: `None` (the library's default) before NU7 on its network.
pub fn send_expiry(params: &impl Parameters, target: u32) -> Option<BlockHeight> {
    let network = match params.network_type() {
        NetworkType::Main => "main",
        NetworkType::Test => "test",
        NetworkType::Regtest => "regtest",
    };
    ll_core::rules::after_nu7(network, target).then(|| BlockHeight::from_u32(target + SEND_EXPIRY_AFTER_NU7))
}

/// Same derivation as the devtool's `wallet lock-note --owner`.
fn lock_owner(label: &str) -> LockOwner {
    LockOwner::new(ll_core::hash(b"ledgerlab_lock", label.as_bytes()))
}

#[derive(serde::Deserialize)]
struct KeysToml {
    mnemonic: Option<String>,
    network: Option<String>,
}

/// The chain's height now, from the default chain server of `network`, without any wallet (a check before wallets are made).
pub fn server_tip(network: &str) -> Result<u32> {
    let server = match network {
        "test" => "https://testnet.zec.rocks:443",
        "main" => "https://zec.rocks:443",
        other => bail!("no default chain server for the network {other}"),
    };
    let host = server.trim_start_matches("https://").split(':').next().unwrap_or_default().to_string();
    let rt = Runtime::new()?;
    rt.block_on(async {
        let endpoint = Channel::from_shared(server.to_string())?.tls_config(ClientTlsConfig::new().domain_name(host).assume_http2(true).with_webpki_roots())?;
        let channel = tokio::time::timeout(std::time::Duration::from_secs(20), endpoint.connect())
            .await
            .map_err(|_| anyhow::anyhow!("the chain server {server} did not answer within 20 s"))??;
        let info = CompactTxStreamerClient::new(channel).get_lightd_info(service::Empty {}).await?.into_inner();
        Ok(info.block_height as u32)
    })
}

impl LibsBackend {
    pub fn new(wallet: PathBuf, identity: PathBuf) -> Result<Self> {
        let keys: KeysToml = toml::from_str(&fs::read_to_string(wallet.join("keys.toml"))?)?;
        let (params, server) = match keys.network.as_deref().unwrap_or("test") {
            "test" => (Params::Net(Network::TestNetwork), "https://testnet.zec.rocks:443".to_string()),
            "main" => (Params::Net(Network::MainNetwork), "https://zec.rocks:443".to_string()),
            #[cfg(feature = "regtest")]
            "regtest" => (Params::Local(local_network(&toml::from_str(&fs::read_to_string(wallet.join("keys.toml"))?)?)?), regtest_server()),
            other => bail!("unsupported network {other}"),
        };
        Ok(Self { wallet, identity, params, server, rt: Runtime::new()?, proving_key: None })
    }

    fn db(&self) -> Result<Db> {
        Ok(WalletDb::for_path(self.wallet.join("data.sqlite"), self.params, SystemClock, rng())?)
    }

    /// The connection to the chain server. A stalled server must not hang a watcher pass: connecting (TCP, TLS and the HTTP/2 set-up together)
    /// has to finish within CONNECT_TIMEOUT, and a connection that goes silent later is noticed by keepalive pings (KEEPALIVE_EVERY, with
    /// KEEPALIVE_ANSWER to answer each) and closed, so the call fails and the next pass connects again.
    fn client(&self) -> Result<CompactTxStreamerClient<Channel>> {
        const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
        const KEEPALIVE_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
        const KEEPALIVE_ANSWER: std::time::Duration = std::time::Duration::from_secs(20);
        let host = self.server.trim_start_matches("https://").split(':').next().unwrap_or_default().to_string();
        self.rt.block_on(async {
            let mut endpoint = Channel::from_shared(self.server.clone())?;
            // only a regtest node on this machine is reached without TLS
            if !(cfg!(feature = "regtest") && self.server.starts_with("http://")) {
                endpoint = endpoint.tls_config(ClientTlsConfig::new().domain_name(host).assume_http2(true).with_webpki_roots())?;
            }
            let endpoint = endpoint
                .connect_timeout(CONNECT_TIMEOUT)
                .tcp_keepalive(Some(KEEPALIVE_EVERY))
                .http2_keep_alive_interval(KEEPALIVE_EVERY)
                .keep_alive_timeout(KEEPALIVE_ANSWER)
                .keep_alive_while_idle(true);
            // the endpoint's own connect timeout covers only the TCP connect; this bounds the TLS and HTTP/2 set-up as well
            let channel = tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect())
                .await
                .map_err(|_| anyhow::anyhow!("the chain server {} did not answer within {} s", self.server, CONNECT_TIMEOUT.as_secs()))??;
            Ok(CompactTxStreamerClient::new(channel))
        })
    }

    /// Decrypts the wallet's mnemonic with the age identity and derives the seed.
    fn seed(&self) -> Result<SecretVec<u8>> {
        let keys: KeysToml = toml::from_str(&fs::read_to_string(self.wallet.join("keys.toml"))?)?;
        let ciphertext = keys.mnemonic.context("wallet has no mnemonic")?;
        let identities = age::IdentityFile::from_file(self.identity.to_string_lossy().into_owned())?
            .into_identities()?;
        let decryptor = age::Decryptor::new(age::armor::ArmoredReader::new(ciphertext.as_bytes()))?;
        let mut phrase = vec![];
        std::io::Read::read_to_end(
            &mut decryptor.decrypt(identities.iter().map(|i| i.as_ref() as _))?,
            &mut phrase,
        )?;
        let phrase = SecretVec::new(phrase);
        let mnemonic = bip0039::Mnemonic::<bip0039::English>::from_phrase(std::str::from_utf8(phrase.expose_secret())?)?;
        Ok(SecretVec::new(mnemonic.to_seed("").to_vec()))
    }

    fn account_id(db: &Db) -> Result<<Db as WalletRead>::AccountId> {
        db.get_account_ids()?.into_iter().next().context("wallet has no account")
    }

    fn enhance(&self, client: &mut CompactTxStreamerClient<Channel>) -> Result<()> {
        let mut db = self.db()?;
        let tip = db.chain_height()?.context("wallet has not synced")?;
        let mut done = BTreeSet::new();
        loop {
            let mut progressed = false;
            for request in db.transaction_data_requests()? {
                if !done.insert(request.clone()) {
                    continue;
                }
                progressed = true;
                match &request {
                    TransactionDataRequest::GetStatus(txid) => {
                        let status = self.fetch(client, tip, *txid)?.map_or(
                            TransactionStatus::TxidNotRecognized,
                            |(_, h)| h.map_or(TransactionStatus::NotInMainChain, TransactionStatus::Mined),
                        );
                        db.set_transaction_status(*txid, status)?;
                    }
                    TransactionDataRequest::Enhancement(txid) => match self.fetch(client, tip, *txid)? {
                        None => db.set_transaction_status(*txid, TransactionStatus::TxidNotRecognized)?,
                        Some((tx, h)) => decrypt_and_store_transaction(&self.params, &mut db, &tx, h)?,
                    },
                    // The campaign account receives only shielded funds.
                    TransactionDataRequest::TransactionsInvolvingAddress(_) => {}
                }
            }
            if !progressed {
                return Ok(());
            }
        }
    }

    fn fetch(
        &self,
        client: &mut CompactTxStreamerClient<Channel>,
        tip: BlockHeight,
        txid: TxId,
    ) -> Result<Option<(Transaction, Option<BlockHeight>)>> {
        let request = service::TxFilter { hash: txid.as_ref().to_vec(), ..Default::default() };
        let raw = match self.rt.block_on(client.get_transaction(request)) {
            Ok(r) => r.into_inner(),
            Err(s) if s.code() == tonic::Code::NotFound => return Ok(None),
            Err(s) => return Err(s.into()),
        };
        let height = (raw.height > 0 && raw.height <= u64::from(u32::MAX))
            .then(|| BlockHeight::from_u32(raw.height as u32));
        let tx = Transaction::read(&raw.data[..], BranchId::for_height(&self.params, height.unwrap_or(tip)))?;
        Ok(Some((tx, height)))
    }

    fn extract_raw(signed: &[u8]) -> Result<(Vec<u8>, String)> {
        let pczt = Pczt::parse(signed).map_err(|e| anyhow!("unreadable PCZT: {e:?}"))?;
        let finalized = SpendFinalizer::new(pczt).finalize_spends().map_err(|e| anyhow!("{e:?}"))?;
        let tx = TransactionExtractor::new(finalized).extract(rng()).map_err(|e| anyhow!("{e:?}"))?;
        let mut raw = vec![];
        tx.write(&mut raw)?;
        Ok((raw, tx.txid().to_string()))
    }
}

/// In-memory compact block cache for the library's sync loop.
#[derive(Default, Clone)]
struct MemoryCache(Arc<Mutex<Vec<CompactBlock>>>);

impl BlockSource for MemoryCache {
    type Error = std::convert::Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), chain_error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), chain_error::Error<WalletErrT, Self::Error>>,
    {
        let mut blocks: Vec<CompactBlock> = self
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|b| from_height.is_none_or(|h| b.height >= u64::from(h)))
            .cloned()
            .collect();
        blocks.sort_by_key(|b| b.height);
        for b in blocks.into_iter().take(limit.unwrap_or(usize::MAX)) {
            with_block(b)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemoryCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|b| BlockHeight::from_u32(b.height as u32))
            .filter(|h| range.is_none_or(|r| r.block_range().contains(h)))
            .max())
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|b| range.block_range().contains(&BlockHeight::from_u32(b.height as u32)))
            .cloned()
            .collect())
    }

    async fn insert(&self, mut blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        self.0.lock().unwrap().append(&mut blocks);
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        self.0
            .lock()
            .unwrap()
            .retain(|b| !range.block_range().contains(&BlockHeight::from_u32(b.height as u32)));
        Ok(())
    }
}

impl WalletBackend for LibsBackend {
    fn name(&self) -> &'static str {
        "libs"
    }

    fn sync(&mut self) -> Result<()> {
        let mut client = self.client()?;
        let mut db = self.db()?;
        let cache = MemoryCache::default();
        self.rt
            .block_on(zcash_client_backend::sync::run(&mut client, &self.params, &cache, &mut db, 1000))
            .map_err(|e| anyhow!("sync failed: {e:?}"))?;
        drop(db);
        self.enhance(&mut client)
    }

    fn chain_tip(&mut self) -> Result<ChainTip> {
        let mut client = self.client()?;
        let info = self.rt.block_on(client.get_lightd_info(service::Empty {}))?.into_inner();
        Ok(ChainTip { height: info.block_height as u32, branch_id: info.consensus_branch_id })
    }

    fn account(&mut self) -> Result<AccountInfo> {
        let db = self.db()?;
        let account = db.get_account(Self::account_id(&db)?)?.context("no account")?;
        let ufvk = account.ufvk().context("account has no UFVK")?.encode(&self.params).map_err(|e| anyhow!("{e:?}"))?;
        let (ua, _) = db
            .get_last_generated_address_matching(account.id(), zcash_keys::keys::UnifiedAddressRequest::AllAvailableKeys)?
            .map(|a| (a.encode(&self.params), ()))
            .context("no address")?;
        drop(account);
        // Prefer the stored UFVK string so it matches what other tools publish.
        let stored = walletdb::account_ufvk(&self.wallet.join("data.sqlite"))?.unwrap_or(ufvk);
        Ok(AccountInfo { ufvk: stored, address: ua })
    }

    fn notes(&mut self) -> Result<Vec<WalletNote>> {
        walletdb::read_notes(&self.wallet.join("data.sqlite"))
    }

    fn lock(&mut self, txid: &str, action: u32, owner: &str, until: u32) -> Result<()> {
        let mut bytes = ll_core::hex32(txid)?;
        bytes.reverse();
        let output = OutputRef::new(TxId::from_bytes(bytes), PoolType::Shielded(ShieldedPool::Ironwood), action);
        self.db()?
            .lock_outputs(&[output], lock_owner(owner), BlockHeight::from_u32(until))
            .map_err(|e| anyhow!("lock failed: {e:?}"))?;
        Ok(())
    }

    fn unlock(&mut self, txid: &str, action: u32, owner: &str) -> Result<bool> {
        let mut bytes = ll_core::hex32(txid)?;
        bytes.reverse();
        let output = OutputRef::new(TxId::from_bytes(bytes), PoolType::Shielded(ShieldedPool::Ironwood), action);
        Ok(self.db()?.unlock_output(&output, lock_owner(owner))?)
    }

    fn build(&mut self, req: &SpendRequest) -> Result<Vec<u8>> {
        let mut db = self.db()?;
        let account = Self::account_id(&db)?;
        let change = MultiOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            ShieldedPool::Orchard,
            DustOutputPolicy::default(),
            SplitPolicy::with_min_output_value(NonZeroUsize::new(4).unwrap(), Zatoshis::from_u64(10_000_000)?),
        );
        let payment = |to: &str, value: u64| -> Result<Payment> {
            Payment::new(ZcashAddress::from_str(to).map_err(|e| anyhow!("{e}"))?, Some(Zatoshis::from_u64(value)?), None, None, None, vec![])
                .map_err(|e| anyhow!("{e:?}"))
        };
        // The wallet's fee model always reserves a change output, which would make a two-payment transaction
        // cost one more logical action than it needs. So the proposal is made for the first payment, and a
        // two-payment, no-change step is rebuilt from its note selection below.
        // With further outputs the proposal only chooses the note: it asks for everything the outputs will carry, so the note is spent
        // exactly (no change, no change output's fee), which a small deposit that pays a price and a little excess still covers.
        let selection = req.value_zat + req.also_pay.iter().map(|(_, v)| *v).sum::<u64>();
        let request = TransactionRequest::new(vec![payment(&req.to_address, selection)?]).map_err(|e| anyhow!("{e:?}"))?;
        let owners = NonEmptyBTreeSet::from_set(req.lock_owners.iter().map(|o| lock_owner(o)).collect())
            .context("no lock owners given")?;
        let policy = SpendPolicy::default().with_locked_input_policy(LockedInputPolicy::PreferLocked(owners));
        let proposal = propose_transfer::<_, _, _, _, std::convert::Infallible>(
            &mut db,
            &self.params,
            account,
            &GreedyInputSelector::new(),
            &change,
            request,
            ConfirmationsPolicy::new_symmetrical(std::num::NonZeroU32::MIN, true),
            &policy,
            None,
            None,
        )
        .map_err(|e| anyhow!("proposal failed: {e:?}"))?;
        let proposal = if req.also_pay.is_empty() {
            proposal
        } else {
            // outputs: the first payment and every `also_pay`; no change; the exact ZIP 317 fee for one spend and two
            // outputs (the proposal validates that inputs = outputs + fee exactly)
            let mut payments = vec![payment(&req.to_address, req.value_zat)?];
            for (to, value) in &req.also_pay {
                payments.push(payment(to, *value)?);
            }
            let outputs = payments.len();
            let full = TransactionRequest::new(payments).map_err(|e| anyhow!("{e:?}"))?;
            let step = proposal.steps().first();
            let pool = *step.payment_pools().get(&0).context("no payment pool")?;
            let pools = (0..outputs).map(|i| (i, pool)).collect();
            let fee = Zatoshis::from_u64(5_000 * outputs.max(2) as u64)?;
            zcash_client_backend::proposal::Proposal::single_step(
                full,
                pools,
                vec![],
                step.shielded_inputs().cloned(),
                step.anchor_height().context("no anchor height")?,
                zcash_client_backend::fees::TransactionBalance::new(vec![], fee).map_err(|e| anyhow!("{e:?}"))?,
                StandardFeeRule::Zip317,
                proposal.min_target_height(),
                proposal.confirmations_policy(),
                false,
                true,
            )
            .map_err(|e| anyhow!("two-output proposal rejected: {e:?}"))?
        };
        let pczt = create_pczt_from_proposal::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut db,
            &self.params,
            &SystemClock,
            &mut rng(),
            account,
            req.ovk.map_or(OvkPolicy::Discard, |k| OvkPolicy::custom_from_common_bytes(&k)),
            &proposal,
            req.expiry_height.or(req.no_expiry.then_some(0)).map(BlockHeight::from_u32).or_else(|| send_expiry(&self.params, u32::from(proposal.min_target_height()))),
            zcash_primitives::transaction::builder::BundlePadding::DEFAULT,
        )
        .map_err(|e| anyhow!("PCZT creation failed: {e:?}"))?;

        // Prove (Ironwood only; tickets have no Sapling or Orchard parts).
        let raw_branch = *pczt.global().consensus_branch_id();
        let branch = BranchId::try_from(raw_branch).map_err(|_| anyhow!("unknown branch"))?;
        let mut prover = Prover::new(pczt);
        if prover.requires_ironwood_proof() {
            if self.proving_key.as_ref().is_none_or(|(b, _)| *b != raw_branch) {
                let version = zcash_primitives::transaction::components::orchard::bundle_version_for_branch(
                    branch,
                    orchard::ValuePool::Orchard,
                )
                .context("branch does not support Orchard circuits")?
                .circuit_version();
                self.proving_key = Some((raw_branch, orchard::circuit::ProvingKey::build(version)));
            }
            let pk = &self.proving_key.as_ref().expect("built").1;
            prover = prover.create_ironwood_proof(rng(), pk).map_err(|e| anyhow!("prove: {e:?}"))?;
        }
        if prover.requires_orchard_proof() || prover.requires_sapling_proofs() {
            bail!("ticket unexpectedly needs Orchard or Sapling proofs");
        }
        Ok(prover.finish().serialize().map_err(|e| anyhow!("{e:?}"))?)
    }

    fn sign(&mut self, pczt: &[u8]) -> Result<Vec<u8>> {
        let pczt = Pczt::parse(pczt).map_err(|e| anyhow!("unreadable PCZT: {e:?}"))?;
        let seed = self.seed()?;
        let db = self.db()?;
        let account = db.get_account(Self::account_id(&db)?)?.context("no account")?;
        let index = match account.source() {
            zcash_client_backend::data_api::AccountSource::Derived { derivation, .. } => derivation.account_index(),
            _ => bail!("campaign account must be derived from the wallet seed"),
        };
        let usk = UnifiedSpendingKey::from_seed(&self.params, seed.expose_secret(), index)?;

        // Our spends carry a ZIP 32 derivation; dummy spends do not and are already signed.
        let mut ours = vec![];
        let pczt = Verifier::new(pczt)
            .with_ironwood::<(), _>(|bundle| {
                for (i, a) in bundle.actions().iter().enumerate() {
                    if a.spend().zip32_derivation().is_some() {
                        ours.push(i);
                    }
                }
                Ok(())
            })
            .map_err(|e| anyhow!("{e:?}"))?
            .finish();
        let ask = orchard::keys::SpendAuthorizingKey::from(usk.orchard());
        let mut signer = Signer::new(pczt).map_err(|e| anyhow!("{e:?}"))?;
        for i in ours {
            signer.sign_ironwood(rng(), i, &ask).map_err(|e| anyhow!("sign action {i}: {e:?}"))?;
        }
        Ok(signer.finish().serialize().map_err(|e| anyhow!("{e:?}"))?)
    }

    fn broadcast(&mut self, signed: &[u8]) -> Result<String> {
        let (raw, txid) = Self::extract_raw(signed)?;
        self.broadcast_raw(&raw)?;
        Ok(txid)
    }

    fn broadcast_raw(&mut self, raw: &[u8]) -> Result<String> {
        let txid = {
            let tx = Transaction::read(raw, BranchId::Nu7).or_else(|_| Transaction::read(raw, BranchId::Nu6_3)).map_err(|e| anyhow!("unreadable transaction: {e}"))?;
            tx.txid().to_string()
        };
        #[cfg(feature = "test-cheats")]
        if test_drop_first(&self.wallet, &txid)? {
            return Ok(txid); // pretend it was sent
        }
        let mut client = self.client()?;
        let resp = self
            .rt
            .block_on(client.send_transaction(service::RawTransaction { data: raw.to_vec(), height: 0 }))?
            .into_inner();
        if resp.error_code != 0 {
            bail!("broadcast rejected ({}): {}", resp.error_code, resp.error_message);
        }
        Ok(txid)
    }

    fn signed_refund(&mut self, owner: &str, to: &str, value_zat: u64) -> Result<(Vec<u8>, String)> {
        self.signed_refund_impl(owner, to, value_zat)
    }

    fn finish_refund(&mut self, signed: &[u8], owner: &str, to: &str, value_zat: u64) -> Result<Vec<u8>> {
        self.finish_refund_impl(signed, owner, to, value_zat)
    }

    fn late_ticket(&mut self, owner: &str, to: &str, value_zat: u64, coin: &CoinInput, lock_time: u32, ovk: Option<[u8; 32]>) -> Result<(Vec<u8>, String)> {
        self.late_ticket_impl(owner, to, value_zat, coin, lock_time, ovk)
    }

    fn pay_coins(&mut self, outs: &[([u8; 33], u64)]) -> Result<(String, Vec<u32>)> {
        self.pay_coins_impl(outs)
    }

    fn tip_time(&mut self) -> Result<u64> {
        self.tip_time_impl()
    }

    fn payout_facts(&mut self, targets: &[(String, Option<String>)]) -> Result<Vec<ll_core::recount::PayoutFact>> {
        self.payout_facts_impl(targets)
    }

    fn coin_facts(&mut self, txids: &[String]) -> Result<Vec<ll_core::recount::CoinFact>> {
        self.coin_facts_impl(txids)
    }

    fn block_times(&mut self, from: u32, to: u32) -> Result<Vec<(u32, u64)>> {
        self.block_times_impl(from, to)
    }

    fn tx_known(&mut self, txid: &str) -> Result<bool> {
        let mut hash = ll_core::hex32(txid)?.to_vec();
        hash.reverse();
        let mut client = self.client()?;
        match self.rt.block_on(client.get_transaction(service::TxFilter { hash, ..Default::default() })) {
            Ok(r) => Ok(!r.into_inner().data.is_empty()),
            Err(s) if s.code() == tonic::Code::NotFound || s.code() == tonic::Code::InvalidArgument => Ok(false),
            Err(s) => Err(anyhow!("server error: {s}")),
        }
    }
}

#[cfg(test)]
mod expiry_tests {
    use super::{SEND_EXPIRY_AFTER_NU7, send_expiry};
    use zcash_protocol::consensus::{BlockHeight, Network};

    #[test]
    fn a_coin_send_after_nu7_expires_after_120_blocks_and_before_it_keeps_the_default() {
        let nu7 = ll_core::sealed::NU7_MAIN_HEIGHT;
        assert_eq!(send_expiry(&Network::MainNetwork, nu7 - 1), None, "before NU7: the library's default, as for the sends of today's auctions");
        assert_eq!(send_expiry(&Network::MainNetwork, nu7), Some(BlockHeight::from_u32(nu7 + SEND_EXPIRY_AFTER_NU7)));
        assert_eq!(send_expiry(&Network::TestNetwork, 4_600_000), Some(BlockHeight::from_u32(4_600_120)));
    }
}

#[cfg(test)]
mod branch_tests {
    use zcash_protocol::consensus::{BlockHeight, BranchId, Network, NetworkUpgrade, Parameters};

    /// The libraries pick the branch a transaction is signed for from their own network settings, at the height it is built for (the next
    /// block), never from the chain. With zcash_protocol 0.11.0 they know the mainnet NU7 height of ZIP 259 (3,543,405): a send built for
    /// that block or later is signed for NU7 (77190ad9), one built for an earlier block still for NU6.3 (37a5165b). Testnet is on NU7
    /// since 4,465,026. The heights are the pages' and the core's own (blocktime.js, ll_core::sealed::NU7_MAIN_HEIGHT).
    #[test]
    fn libraries_pick_the_branch_the_networks_report() {
        let at = |net: &Network, h: u32| u32::from(BranchId::for_height(net, BlockHeight::from_u32(h)));
        let nu7 = ll_core::sealed::NU7_MAIN_HEIGHT;
        assert_eq!(nu7, 3_543_405);
        assert_eq!(at(&Network::MainNetwork, nu7 - 1), 0x37a5_165b, "a mainnet send before NU7 keeps the old branch");
        assert_eq!(at(&Network::MainNetwork, 3_527_753), 0x37a5_165b, "today's mainnet blocks");
        for h in [nu7, nu7 + 1, 3_900_000] {
            assert_eq!(at(&Network::MainNetwork, h), 0x7719_0ad9, "mainnet at block {h} is NU7");
            assert_ne!(at(&Network::MainNetwork, h), 0x37a5_165b);
        }
        assert_eq!(Network::MainNetwork.activation_height(NetworkUpgrade::Nu7), Some(BlockHeight::from_u32(nu7)));
        assert_eq!(at(&Network::TestNetwork, 4_465_025), 0x37a5_165b);
        assert_eq!(at(&Network::TestNetwork, 4_465_026), 0x7719_0ad9);
        assert_eq!(at(&Network::TestNetwork, 4_539_961), 0x7719_0ad9, "the block of the test network return of 25 Oct");
    }
}

#[cfg(test)]
mod key_format_tests {
    use zcash_protocol::consensus::Network;

    /// The viewing keys a wallet database stores (`uvf…` and `uvi…`) must decode, since winners paste them.
    #[test]
    fn stored_testnet_keys_decode() {
        let (Ok(uivk), Ok(ufvk)) = (std::env::var("LL_TEST_UIVK"), std::env::var("LL_TEST_UFVK")) else { return };
        let u = zcash_keys::keys::UnifiedIncomingViewingKey::decode(&Network::TestNetwork, &uivk).expect("uivk decodes");
        assert!(u.orchard().is_some());
        let f = zcash_keys::keys::UnifiedFullViewingKey::decode(&Network::TestNetwork, &ufvk).expect("ufvk decodes");
        assert!(f.orchard().is_some());
    }
}

/// TEST ONLY (`test-cheats` builds): drops the FIRST broadcast of every transaction, as a flaky public server
/// sometimes does (the call reports success but nothing is sent), so the outbox's recovery can be proven.
#[cfg(feature = "test-cheats")]
fn test_drop_first(wallet: &std::path::Path, txid: &str) -> Result<bool> {
    if std::env::var("LL_TEST_DROP_FIRST_BROADCAST").is_err() {
        return Ok(false);
    }
    let seen = wallet.join("test-dropped.txt");
    let list = fs::read_to_string(&seen).unwrap_or_default();
    if list.lines().any(|l| l == txid) {
        return Ok(false);
    }
    fs::write(&seen, format!("{list}{txid}\n"))?;
    eprintln!("\n################################################################");
    eprintln!("#  FAKE FLAKY SERVER (test-cheats build): the first broadcast of");
    eprintln!("#  {txid} is being DROPPED. Never use for real.");
    eprintln!("################################################################\n");
    Ok(true)
}

#[cfg(test)]
mod connect_tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Normal builds know only mainnet and testnet: a regtest wallet is refused (the private chain needs a build with `--features regtest`).
    #[test]
    fn a_regtest_wallet_needs_the_test_build() {
        let dir = std::env::temp_dir().join(format!("ll-regtest-wallet-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("keys.toml"), "network = \"regtest\"\n[activation_heights]\nnu7 = 1\n").unwrap();
        let r = LibsBackend::new(dir.clone(), dir.join("x.age"));
        if cfg!(feature = "regtest") {
            assert!(r.is_ok());
        } else {
            assert!(r.err().unwrap().to_string().contains("unsupported network regtest"));
        }
        let _ = fs::remove_dir_all(dir);
    }

    fn backend(server: &str) -> LibsBackend {
        LibsBackend { wallet: PathBuf::new(), identity: PathBuf::new(), params: Params::Net(Network::TestNetwork), server: server.into(), rt: Runtime::new().unwrap(), proving_key: None }
    }

    /// A chain server that takes the connection and then says nothing (the way a stalled server behaves): the host must give up within the
    /// connect timeout, so a watcher pass ends with an error instead of hanging, and the next pass tries again.
    #[test]
    fn a_server_that_accepts_the_connection_and_never_answers_fails_within_the_timeout() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut held = vec![];
            for c in listener.incoming().take(4) {
                held.push(c); // accepted, never read, never answered
            }
            std::thread::sleep(Duration::from_secs(120));
        });
        let started = Instant::now();
        let err = backend(&format!("https://127.0.0.1:{port}")).chain_tip().err().expect("a silent server must give an error, not an answer");
        let took = started.elapsed();
        assert!(took >= Duration::from_secs(19) && took < Duration::from_secs(30), "gave up after {took:?}, expected about 20 s");
        assert!(format!("{err:#}").contains("did not answer within 20 s"), "{err:#}");
    }

    /// The same code path still reaches a real chain server (the public testnet one) and gets an answer: after a failure, the next pass connects
    /// again from scratch. Needs the network, so it runs only when asked: cargo test -p ll-host -- --ignored connect_tests
    #[test]
    #[ignore]
    fn the_real_testnet_server_still_answers() {
        let tip = backend("https://testnet.zec.rocks:443").chain_tip().expect("the testnet server answers");
        assert!(tip.height > 4_000_000, "{}", tip.height);
    }
}
