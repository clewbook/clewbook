use anyhow::anyhow;
use clap::Args;
use zcash_client_backend::{
    data_api::{OutputLockStore, locking::LockOwner},
    wallet::OutputRef,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock};
use zcash_protocol::{PoolType, ShieldedPool, TxId, consensus::BlockHeight};

use crate::{config::get_wallet_network, data::get_db_paths, rng::OsRng};

/// Derives a wallet lock owner from a human-readable label, so that other tools can name
/// the same owner (`BLAKE2b-256("ledgerlab_lock", label)`).
pub(crate) fn lock_owner_from_label(label: &str) -> LockOwner {
    let hash = blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"ledgerlab_lock")
        .hash(label.as_bytes());
    LockOwner::new(hash.as_bytes().try_into().expect("32 bytes"))
}

/// Parses `<txid>:<action index>` (txid in display order) as an Ironwood output reference.
pub(crate) fn parse_ironwood_note(s: &str) -> anyhow::Result<OutputRef> {
    let (txid, index) = s
        .split_once(':')
        .ok_or_else(|| anyhow!("expected <txid>:<action index>"))?;
    let mut bytes: [u8; 32] = hex::decode(txid)?
        .try_into()
        .map_err(|_| anyhow!("txid must be 32 bytes"))?;
    bytes.reverse();
    Ok(OutputRef::new(
        TxId::from_bytes(bytes),
        PoolType::Shielded(ShieldedPool::Ironwood),
        index.parse()?,
    ))
}

// Options accepted for the `lock-note` command
#[derive(Debug, Args)]
pub(crate) struct Command {
    /// The Ironwood note to lock, as `<txid>:<action index>`
    #[arg(long)]
    note: String,

    /// Label naming the lock owner; the same label lets `pczt create --spend-locked-by` use it
    #[arg(long)]
    owner: String,

    /// The note is not selected for ordinary spending at any height up to and including this one
    #[arg(long)]
    until: u32,

    /// Release this owner's lock instead of taking it
    #[arg(long)]
    unlock: bool,
}

impl Command {
    pub(crate) fn run(self, wallet_dir: Option<String>) -> Result<(), anyhow::Error> {
        let params = get_wallet_network(wallet_dir.as_ref())?;
        let (_, db_data) = get_db_paths(wallet_dir);
        let mut db_data = WalletDb::for_path(db_data, params, SystemClock, OsRng)?;

        let output = parse_ironwood_note(&self.note)?;
        let owner = lock_owner_from_label(&self.owner);

        if self.unlock {
            let released = db_data.unlock_output(&output, owner)?;
            println!("{}", if released { "unlocked" } else { "not locked by this owner" });
        } else {
            db_data
                .lock_outputs(&[output], owner, BlockHeight::from_u32(self.until))
                .map_err(|e| anyhow!("Failed to lock note: {:?}", e))?;
            println!("locked until {}", self.until);
        }
        Ok(())
    }
}
