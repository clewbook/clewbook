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
/// locked by `lock_owners`, with the outgoing viewing key discarded. Refund tickets, sweeps
/// and auction settlements all set `no_expiry` (expiry height 0), so they never expire.
pub struct SpendRequest {
    pub to_address: String,
    pub value_zat: u64,
    pub lock_owners: Vec<String>,
    pub no_expiry: bool,
    /// An exact expiry height instead (a sealed bid auction's early ticket expires at the deadline). Takes precedence over `no_expiry`.
    pub expiry_height: Option<u32>,
    /// Further outputs (address, zatoshis), e.g. a uniform-price settlement's excess for the winner.
    pub also_pay: Vec<(String, u64)>,
    /// The outgoing viewing key the outputs are made with (a sealed bid auction's payments to people, SPEC §9.1, open_payouts), or none (discarded).
    pub ovk: Option<[u8; 32]>,
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

    // ---- sealed bid auctions (SPEC §9): the wallet library backend only ----

    /// The refund signed now and finished at the close (no anchor, witness or proof yet): the signed PCZT and the transaction's id.
    fn signed_refund(&mut self, _owner: &str, _to: &str, _value_zat: u64) -> Result<(Vec<u8>, String)> {
        anyhow::bail!("blind bid auctions need the wallet library backend")
    }

    /// Finishes a signed refund with today's anchor, witness and proof: the final transaction bytes.
    fn finish_refund(&mut self, _signed: &[u8], _owner: &str, _to: &str, _value_zat: u64) -> Result<Vec<u8>> {
        anyhow::bail!("blind bid auctions need the wallet library backend")
    }

    /// The host's part of a late ticket (the page signs the coin input): `ticket_blob::LatePart`, encoded, and the transaction's id.
    fn late_ticket(&mut self, _owner: &str, _to: &str, _value_zat: u64, _coin: &crate::libs::CoinInput, _lock_time: u32, _ovk: Option<[u8; 32]>) -> Result<(Vec<u8>, String)> {
        anyhow::bail!("blind bid auctions need the wallet library backend")
    }

    /// Pays each page key its coin in one transaction from this (coin) wallet and sends it: the id and each coin's output index.
    fn pay_coins(&mut self, _outs: &[([u8; 33], u64)]) -> Result<(String, Vec<u32>)> {
        anyhow::bail!("blind bid auctions need the wallet library backend")
    }

    /// The time of the chain's latest block (unix seconds).
    fn tip_time(&mut self) -> Result<u64> {
        anyhow::bail!("blind bid auctions need the wallet library backend")
    }

    /// The transparent outputs of these coin transactions, for the recount's coin check.
    fn coin_facts(&mut self, _txids: &[String]) -> Result<Vec<ll_core::recount::CoinFact>> {
        anyhow::bail!("blind bid auctions need the wallet library backend")
    }

    /// The times of blocks `from` to `to`, for the recount's void rule.
    fn block_times(&mut self, _from: u32, _to: u32) -> Result<Vec<(u32, u64)>> {
        anyhow::bail!("blind bid auctions need the wallet library backend")
    }

    /// SPEC §9.1, open_payouts: the outputs of the host's payments to people, opened with their keys `(txid, ovk hex)`, for the recount.
    fn payout_facts(&mut self, _targets: &[(String, Option<String>)]) -> Result<Vec<ll_core::recount::PayoutFact>> {
        anyhow::bail!("blind bid auctions need the wallet library backend")
    }
}
