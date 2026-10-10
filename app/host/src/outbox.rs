//! The host's outbox: every transaction the host broadcasts (close refunds, sweeps, settlements) is recorded
//! before it is sent and followed until it is mined. A public server sometimes drops a transaction, so each
//! watch pass checks, and after about ten blocks without it being mined or known to the server the SAME bytes
//! are sent again. The same bytes mean the same txid and the same spent coins, so a second copy can never
//! become a second spend. A transaction is rebuilt only if it is provably dead (the network changed version)
//! and its coins are unspent. The file survives restarts: `private/outbox.json`.

use std::{fs, path::{Path, PathBuf}};

use anyhow::Result;
use ll_core::walletdb::WalletNote;
use serde::{Deserialize, Serialize};

use crate::backend::{ChainTip, WalletBackend};

/// Blocks to wait before a transaction that is not mined and unknown to the server is sent again.
pub fn resend_after() -> u32 {
    std::env::var("LL_RESEND_AFTER_BLOCKS").ok().and_then(|v| v.parse().ok()).unwrap_or(10)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Sent {
    /// What it is for: `refund`, `sweep` or `settle`.
    pub kind: String,
    /// A short human label for the dashboard.
    pub label: String,
    pub txid: String,
    /// The final transaction bytes (signed, no keys inside).
    pub raw_hex: String,
    /// Nullifiers of the coins it spends (transaction byte order).
    pub nfs: Vec<String>,
    /// Consensus branch the transaction was built for.
    pub branch: String,
    pub first_height: u32,
    pub last_sent_height: u32,
    /// Times the bytes were handed to a server (0 until the first send succeeds).
    pub sends: u32,
    /// `sent` (waiting), `resent`, `confirmed`, `superseded` (another transaction spent the coin) or `dead`
    /// (built for a network version that is no longer current and its coins are unspent).
    pub status: String,
    pub mined_height: Option<u32>,
    pub note: Option<String>,
}

impl Sent {
    pub fn live(&self) -> bool {
        matches!(self.status.as_str(), "sent" | "resent" | "confirmed")
    }
    fn waiting(&self) -> bool {
        matches!(self.status.as_str(), "sent" | "resent")
    }
}

pub struct Outbox {
    path: PathBuf,
    pub items: Vec<Sent>,
}

/// A node answer that means the transaction is already there: not an error.
pub fn already_known(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("already") || m.contains("duplicate") || m.contains("txn-already")
}

impl Outbox {
    pub fn load(run_dir: &Path) -> Result<Self> {
        let path = run_dir.join("private").join("outbox.json");
        let items = match fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b)?,
            Err(_) => vec![],
        };
        Ok(Outbox { path, items })
    }

    pub fn save(&self) -> Result<()> {
        let tmp = self.path.with_extension("tmp");
        crate::write_private(&tmp, &serde_json::to_vec_pretty(&self.items)?)?; // private folder and file, from the start
        fs::rename(&tmp, &self.path)?; // never a half-written file after a crash
        Ok(())
    }

    /// The live (not dead, not superseded) entry that spends this coin, if any.
    pub fn live_for(&self, nf: &str) -> Option<&Sent> {
        self.items.iter().find(|s| s.live() && s.nfs.iter().any(|x| x == nf))
    }

    /// Records a transaction BEFORE it is sent (so a crash cannot lose it), then sends it once.
    pub fn send(&mut self, backend: &mut dyn WalletBackend, tip: u32, branch: &str, mut item: Sent, log: &mut Vec<String>) -> Result<String> {
        item.first_height = tip;
        item.last_sent_height = tip;
        item.status = "sent".into();
        item.branch = branch.into();
        let txid = item.txid.clone();
        let raw = hex::decode(&item.raw_hex)?;
        self.items.push(item);
        self.save()?;
        match backend.broadcast_raw(&raw) {
            Ok(_) => {
                if let Some(s) = self.items.last_mut() {
                    s.sends = 1;
                }
            }
            Err(e) if already_known(&e.to_string()) => {
                if let Some(s) = self.items.last_mut() {
                    s.sends = 1;
                }
            }
            Err(e) => {
                let msg = format!("{e:#}");
                if let Some(s) = self.items.last_mut() {
                    s.note = Some(msg.clone());
                }
                log.push(format!("broadcast of {txid} failed ({msg}); it stays in the outbox and will be sent again"));
            }
        }
        self.save()?;
        Ok(txid)
    }

    /// One pass: mark what was mined, and send again what a server dropped. `notes` come from a freshly
    /// synced wallet.
    pub fn process(&mut self, backend: &mut dyn WalletBackend, tip: &ChainTip, notes: &[WalletNote], log: &mut Vec<String>) -> Result<()> {
        let wait = resend_after();
        for i in 0..self.items.len() {
            if !self.items[i].waiting() {
                continue;
            }
            // 1. Is the coin spent on chain, and by what?
            let spend = notes.iter().find_map(|w| {
                let n = &w.note;
                n.nf.as_ref().filter(|nf| self.items[i].nfs.contains(nf)).and_then(|_| n.spent_by.clone())
            });
            if let Some(s) = spend {
                if s.txid == self.items[i].txid {
                    if s.height.is_some() {
                        self.items[i].status = "confirmed".into();
                        self.items[i].mined_height = s.height;
                        self.items[i].note = None;
                        log.push(format!("{} confirmed in block {}: {}", self.items[i].label, s.height.unwrap_or(0), self.items[i].txid));
                    }
                } else {
                    self.items[i].status = "superseded".into();
                    self.items[i].note = Some(format!("the coin was spent by another transaction, {}", s.txid));
                    log.push(format!("{}: the coin was spent by another transaction ({}), not by {}", self.items[i].label, s.txid, self.items[i].txid));
                }
                continue;
            }
            // 2. Unspent. If the network changed version since it was built, it can never be mined: it is dead.
            if self.items[i].branch != tip.branch_id {
                self.items[i].status = "dead".into();
                self.items[i].note = Some(format!("built for network version {}, now {}; it has to be rebuilt", self.items[i].branch, tip.branch_id));
                log.push(format!("{} {} is dead (built for network version {}, now {}); rebuilding it", self.items[i].label, self.items[i].txid, self.items[i].branch, tip.branch_id));
                continue;
            }
            // 3. Never sent successfully yet, or ten blocks without it being mined.
            let due = self.items[i].sends == 0 || tip.height >= self.items[i].last_sent_height + wait;
            if !due {
                continue;
            }
            if self.items[i].sends > 0 {
                match backend.tx_known(&self.items[i].txid) {
                    Ok(true) => {
                        self.items[i].last_sent_height = tip.height; // the server has it (mempool or chain): keep waiting
                        continue;
                    }
                    Ok(false) => {}
                    Err(e) => log.push(format!("could not ask the server about {}: {e:#}", self.items[i].txid)),
                }
            }
            let raw = hex::decode(&self.items[i].raw_hex)?;
            match backend.broadcast_raw(&raw) {
                Ok(_) => {
                    self.items[i].sends += 1;
                    self.items[i].last_sent_height = tip.height;
                    self.items[i].status = if self.items[i].sends > 1 { "resent".into() } else { "sent".into() };
                    self.items[i].note = None;
                    log.push(format!("{} {} was not mined after {wait} blocks and the server does not know it: sent the same bytes again (send {})", self.items[i].label, self.items[i].txid, self.items[i].sends));
                }
                Err(e) if already_known(&e.to_string()) => {
                    self.items[i].last_sent_height = tip.height;
                    self.items[i].sends = self.items[i].sends.max(1);
                }
                Err(e) => {
                    self.items[i].note = Some(format!("{e:#}"));
                    self.items[i].last_sent_height = tip.height;
                    log.push(format!("sending {} again failed: {e:#}", self.items[i].txid));
                }
            }
        }
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::AccountInfo;
    use ll_core::{recount::{ChainNote, Spend}, walletdb::WalletNote};

    /// A server that drops everything it is sent the first `drop` times.
    struct Server { drop: u32, sent: Vec<Vec<u8>>, known: Vec<String> }
    impl WalletBackend for Server {
        fn name(&self) -> &'static str { "test" }
        fn sync(&mut self) -> Result<()> { Ok(()) }
        fn chain_tip(&mut self) -> Result<ChainTip> { unimplemented!() }
        fn account(&mut self) -> Result<AccountInfo> { unimplemented!() }
        fn notes(&mut self) -> Result<Vec<WalletNote>> { unimplemented!() }
        fn lock(&mut self, _: &str, _: u32, _: &str, _: u32) -> Result<()> { Ok(()) }
        fn unlock(&mut self, _: &str, _: u32, _: &str) -> Result<bool> { Ok(false) }
        fn build(&mut self, _: &crate::backend::SpendRequest) -> Result<Vec<u8>> { unimplemented!() }
        fn sign(&mut self, p: &[u8]) -> Result<Vec<u8>> { Ok(p.to_vec()) }
        fn broadcast(&mut self, _: &[u8]) -> Result<String> { unimplemented!() }
        fn broadcast_raw(&mut self, raw: &[u8]) -> Result<String> {
            if self.drop > 0 { self.drop -= 1; return Ok("dropped".into()); } // accepted, then lost
            if self.sent.iter().any(|s| s == raw) { anyhow::bail!("txn-already-in-mempool"); }
            self.sent.push(raw.to_vec());
            Ok("ok".into())
        }
        fn tx_known(&mut self, txid: &str) -> Result<bool> { Ok(self.known.iter().any(|k| k == txid)) }
    }

    fn item() -> Sent {
        Sent { kind: "refund".into(), label: "refund".into(), txid: "t1".into(), raw_hex: "aabb".into(), nfs: vec!["nf1".into()], branch: "77190ad9".into(),
            first_height: 0, last_sent_height: 0, sends: 0, status: String::new(), mined_height: None, note: None }
    }
    fn tip(h: u32) -> ChainTip { ChainTip { height: h, branch_id: "77190ad9".into() } }
    fn note(spent: Option<(&str, Option<u32>)>) -> WalletNote {
        WalletNote { note: ChainNote { txid: "p".into(), action: 0, value_zat: 1, nf: Some("nf1".into()), height: Some(1), tx_index: None, memo_text: None, is_change: false,
            spent_by: spent.map(|(t, h)| Spend { txid: t.into(), height: h }) }, memo_raw: None, lock_owner: None, lock_expiry: None }
    }
    fn dir() -> PathBuf { let d = std::env::temp_dir().join(format!("ll-outbox-{}-{:?}", std::process::id(), std::thread::current().id())); let _ = fs::remove_dir_all(&d); fs::create_dir_all(&d).unwrap(); d }

    #[test]
    fn a_dropped_transaction_is_sent_again_after_ten_blocks_with_the_same_bytes_and_confirmed_once() {
        let d = dir();
        let mut srv = Server { drop: 1, sent: vec![], known: vec![] };
        let mut ob = Outbox::load(&d).unwrap();
        let mut log = vec![];
        ob.send(&mut srv, 100, "77190ad9", item(), &mut log).unwrap();
        assert_eq!((ob.items[0].sends, ob.items[0].status.as_str()), (1, "sent")); // "sent", but the server lost it
        ob.process(&mut srv, &tip(105), &[note(None)], &mut log).unwrap();
        assert!(srv.sent.is_empty(), "not yet: only 5 blocks");
        ob.process(&mut srv, &tip(110), &[note(None)], &mut log).unwrap();
        assert_eq!(srv.sent, vec![vec![0xaa, 0xbb]], "same bytes sent again");
        assert_eq!((ob.items[0].sends, ob.items[0].status.as_str()), (2, "resent"));
        // another pass 10 blocks later while it is still unknown: sent again, but the node says it already has it
        ob.process(&mut srv, &tip(120), &[note(None)], &mut log).unwrap();
        assert_eq!(srv.sent.len(), 1, "a duplicate is refused by the node, never a second transaction");
        // mined
        ob.process(&mut srv, &tip(125), &[note(Some(("t1", Some(123))))], &mut log).unwrap();
        assert_eq!((ob.items[0].status.as_str(), ob.items[0].mined_height), ("confirmed", Some(123)));
        // a restart sees the same state and does nothing more
        let mut again = Outbox::load(&d).unwrap();
        again.process(&mut srv, &tip(300), &[note(Some(("t1", Some(123))))], &mut log).unwrap();
        assert_eq!(srv.sent.len(), 1);
        assert_eq!(again.items[0].status, "confirmed");
    }

    #[test]
    fn a_transaction_the_server_knows_is_waited_for_not_resent() {
        let d = dir();
        let mut srv = Server { drop: 0, sent: vec![], known: vec!["t1".into()] };
        let mut ob = Outbox::load(&d).unwrap();
        let mut log = vec![];
        ob.send(&mut srv, 100, "77190ad9", item(), &mut log).unwrap();
        ob.process(&mut srv, &tip(115), &[note(None)], &mut log).unwrap();
        assert_eq!((srv.sent.len(), ob.items[0].sends), (1, 1));
    }

    #[test]
    fn a_coin_spent_by_something_else_supersedes_and_a_new_network_version_marks_it_dead() {
        let d = dir();
        let mut srv = Server { drop: 0, sent: vec![], known: vec![] };
        let mut ob = Outbox::load(&d).unwrap();
        let mut log = vec![];
        ob.send(&mut srv, 100, "77190ad9", item(), &mut log).unwrap();
        ob.process(&mut srv, &tip(103), &[note(Some(("other", Some(102))))], &mut log).unwrap();
        assert_eq!(ob.items[0].status, "superseded");
        let mut ob2 = Outbox::load(&dir_two()).unwrap();
        ob2.send(&mut srv, 100, "77190ad9", item(), &mut log).unwrap();
        ob2.process(&mut srv, &ChainTip { height: 130, branch_id: "deadbeef".into() }, &[note(None)], &mut log).unwrap();
        assert_eq!(ob2.items[0].status, "dead");
        assert!(ob2.live_for("nf1").is_none(), "a dead entry no longer blocks a rebuild");
    }
    fn dir_two() -> PathBuf { let d = std::env::temp_dir().join(format!("ll-outbox2-{}", std::process::id())); let _ = fs::remove_dir_all(&d); fs::create_dir_all(&d).unwrap(); d }

    #[test]
    fn a_failed_first_send_stays_in_the_outbox_and_is_retried() {
        struct Down(u32);
        impl WalletBackend for Down {
            fn name(&self) -> &'static str { "down" }
            fn sync(&mut self) -> Result<()> { Ok(()) }
            fn chain_tip(&mut self) -> Result<ChainTip> { unimplemented!() }
            fn account(&mut self) -> Result<AccountInfo> { unimplemented!() }
            fn notes(&mut self) -> Result<Vec<WalletNote>> { unimplemented!() }
            fn lock(&mut self, _: &str, _: u32, _: &str, _: u32) -> Result<()> { Ok(()) }
            fn unlock(&mut self, _: &str, _: u32, _: &str) -> Result<bool> { Ok(false) }
            fn build(&mut self, _: &crate::backend::SpendRequest) -> Result<Vec<u8>> { unimplemented!() }
            fn sign(&mut self, p: &[u8]) -> Result<Vec<u8>> { Ok(p.to_vec()) }
            fn broadcast(&mut self, _: &[u8]) -> Result<String> { unimplemented!() }
            fn broadcast_raw(&mut self, _: &[u8]) -> Result<String> { if self.0 > 0 { self.0 -= 1; anyhow::bail!("server unreachable") } Ok("ok".into()) }
            fn tx_known(&mut self, _: &str) -> Result<bool> { Ok(false) }
        }
        let d = dir();
        let mut srv = Down(1);
        let mut ob = Outbox::load(&d).unwrap();
        let mut log = vec![];
        ob.send(&mut srv, 100, "77190ad9", item(), &mut log).unwrap();
        assert_eq!(ob.items[0].sends, 0);
        // not waiting ten blocks: it was never sent
        ob.process(&mut srv, &tip(101), &[note(None)], &mut log).unwrap();
        assert_eq!(ob.items[0].sends, 1);
    }
}
