//! The wallet operations the host app needs, behind one interface so the implementation can
//! change (devtool subprocesses now, wallet libraries directly later).

use anyhow::Result;
use ll_core::walletdb::WalletNote;

pub struct ChainTip {
    pub height: u32,
    /// Consensus branch ID the server reports for the next block, lowercase hex.
    pub branch_id: String,
}

pub struct AccountInfo {
    pub ufvk: String,
    pub address: String,
}

/// A transaction to build: pay `value_zat` to `to_address`, spending exactly the notes
/// locked by `lock_owners`, with the outgoing viewing key discarded. Tickets never expire
/// (`no_expiry`); a sweep uses the normal expiry.
pub struct SpendRequest {
    pub to_address: String,
    pub value_zat: u64,
    pub lock_owners: Vec<String>,
    pub no_expiry: bool,
    /// Further outputs (address, zatoshis), e.g. a uniform-price settlement's excess for the winner.
    pub also_pay: Vec<(String, u64)>,
}

pub trait WalletBackend {
    fn name(&self) -> &'static str;

    /// Scans new blocks and fetches full transactions (memos need full data).
    fn sync(&mut self) -> Result<()>;
    fn chain_tip(&mut self) -> Result<ChainTip>;
    fn account(&mut self) -> Result<AccountInfo>;
    fn notes(&mut self) -> Result<Vec<WalletNote>>;

    /// Locks one Ironwood note (`txid` in display order) under `owner` until `until`.
    /// Locking again under the same owner is idempotent (used when a ticket is re-issued).
    fn lock(&mut self, txid: &str, action: u32, owner: &str, until: u32) -> Result<()>;

    /// Releases `owner`'s lock on a note; returns whether a lock was released.
    fn unlock(&mut self, txid: &str, action: u32, owner: &str) -> Result<bool>;

    /// Builds and proves an unsigned PCZT.
    fn build(&mut self, req: &SpendRequest) -> Result<Vec<u8>>;
    fn sign(&mut self, pczt: &[u8]) -> Result<Vec<u8>>;

    /// Broadcasts a signed PCZT without storing it in the wallet; returns the txid.
    fn broadcast(&mut self, signed: &[u8]) -> Result<String>;

    /// Sends final transaction bytes. Sending the same bytes again is harmless: the node answers "already known".
    fn broadcast_raw(&mut self, raw: &[u8]) -> Result<String>;

    /// Whether the server knows this transaction (in its mempool or in a block).
    fn tx_known(&mut self, txid: &str) -> Result<bool>;
}
