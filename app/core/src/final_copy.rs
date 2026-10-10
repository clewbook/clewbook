//! The final fingerprint (SPEC section 6): once the host has closed a campaign it signs a short record of the list as it then stands: how many entries
//! there are and the hash of the last one. The record is kept next to the final public copy, served by relays and put inside a saved copy. Anyone
//! holding a list can compare it: a list with entries cut off the end, or a different list, does not match. It shows that the list is the one the host
//! fixed at the close; it does not show that the host was honest, that nothing was left out before, or that this record is the one others were shown.

use anyhow::{Result, bail};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::{canon::to_canonical, ledger::Entry};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FinalRecord {
    pub v: u32,
    pub rules_id: String,
    /// How many entries the list had.
    pub entries: u64,
    /// The hash of the last of them (`Entry::hash`).
    pub last_hash: String,
    /// The height at which the close entry was written.
    pub close_height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

/// How a list compares with a final record.
#[derive(Debug, PartialEq, Eq)]
pub enum Comparison {
    /// The very list the host fixed (a list with only settlement entries after it also counts: they may follow the close).
    Matches,
    /// Fewer entries than the host fixed: something was cut off the end.
    CutOff { has: u64, fixed: u64 },
    /// Entries the record does not cover that are not settlements.
    ExtraEntries { has: u64, fixed: u64 },
    /// As many entries (or the covered part) but not the same last entry: a different list.
    Different,
}

impl FinalRecord {
    /// The record for a list that has been closed: its length, its last entry and the close height. Fails if there is no close entry.
    pub fn of(rules_id: &str, entries: &[Entry]) -> Result<Self> {
        let Some(close) = entries.iter().find(|e| e.kind == "close").and_then(|e| e.close.as_ref()) else { bail!("the list has no close entry yet") };
        let Some(last) = entries.last() else { bail!("the list is empty") };
        Ok(FinalRecord { v: 1, rules_id: rules_id.to_string(), entries: entries.len() as u64, last_hash: last.hash()?, close_height: close.close_height, sig: None })
    }

    fn signing_bytes(&self) -> Result<Vec<u8>> {
        let mut unsigned = self.clone();
        unsigned.sig = None;
        let mut bytes = b"clewbook_final\n".to_vec();
        bytes.extend(to_canonical(&unsigned)?.as_bytes());
        Ok(bytes)
    }

    pub fn sign(&mut self, sk: &SigningKey) -> Result<()> {
        self.sig = Some(hex::encode(sk.sign(&self.signing_bytes()?).to_bytes()));
        Ok(())
    }

    /// The version, the campaign and the signature.
    pub fn verify(&self, pk: &VerifyingKey, rules_id: &str) -> Result<()> {
        if self.v != 1 {
            bail!("unknown final record version {}", self.v);
        }
        if self.rules_id != rules_id {
            bail!("this final record is for another campaign");
        }
        let Some(sig) = self.sig.as_deref() else { bail!("unsigned final record") };
        let sig = Signature::from_slice(&hex::decode(sig)?)?;
        pk.verify(&self.signing_bytes()?, &sig).map_err(|_| anyhow::anyhow!("the final record's signature is not the campaign's"))?;
        Ok(())
    }

    /// The line to show and to post somewhere durable.
    pub fn line(&self) -> String {
        format!("{} entries, last entry {}", self.entries, self.last_hash)
    }

    /// Compares a list (already checked for signatures and the chain) with this record.
    pub fn compare(&self, list: &[Entry]) -> Comparison {
        let (has, fixed) = (list.len() as u64, self.entries);
        if has < fixed {
            return Comparison::CutOff { has, fixed };
        }
        let covered = &list[..fixed as usize];
        match covered.last().map(|e| e.hash()) {
            Some(Ok(h)) if h == self.last_hash => {}
            _ => return Comparison::Different,
        }
        if list[fixed as usize..].iter().all(|e| e.kind == "settle") { Comparison::Matches } else { Comparison::ExtraEntries { has, fixed } }
    }

    /// Whether `later` may replace `self` at a relay: it covers more of the same list (more settlement entries after the close).
    pub fn is_extended_by(&self, later: &FinalRecord) -> bool {
        later.entries > self.entries
    }
}

/// The fingerprint line of any list: how many entries, and the hash of the last one (empty list: `0 entries`).
pub fn list_line(list: &[Entry]) -> Result<String> {
    Ok(match list.last() {
        Some(last) => format!("{} entries, last entry {}", list.len(), last.hash()?),
        None => "0 entries".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::GENESIS_PREV;

    const ID: &str = "ab00000000000000000000000000000000000000000000000000000000000001";
    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }
    /// A signed, chained list of the given kinds (the close entry carries a close height).
    fn list(sk: &SigningKey, kinds: &[&str], salt: u32) -> Vec<Entry> {
        let mut out: Vec<Entry> = vec![];
        for (i, k) in kinds.iter().enumerate() {
            let mut e = Entry::new(ID, k);
            e.seq = i as u64;
            e.prev = out.last().map_or(GENESIS_PREV.to_string(), |p: &Entry| p.hash().unwrap());
            if *k == "close" {
                e.close = Some(crate::ledger::Close { close_height: 100 + salt, outcome: "goal_missed".into(), winners: None, ufvk: None, amount_key: None, clearing_price_zat: None });
            }
            if *k == "reject" {
                e.reason = Some(format!("r{salt}"));
            }
            e.sign(sk).unwrap();
            out.push(e);
        }
        out
    }
    fn record(sk: &SigningKey, l: &[Entry]) -> FinalRecord {
        let mut r = FinalRecord::of(ID, l).unwrap();
        r.sign(sk).unwrap();
        r
    }

    #[test]
    fn a_signed_record_verifies_and_any_change_breaks_it() {
        let sk = key(1);
        let l = list(&sk, &["reject", "reject", "close"], 0);
        let r = record(&sk, &l);
        r.verify(&sk.verifying_key(), ID).unwrap();
        assert_eq!(r.entries, 3);
        for tweak in [|r: &mut FinalRecord| r.entries += 1, |r: &mut FinalRecord| r.last_hash = "00".repeat(32), |r: &mut FinalRecord| r.close_height += 1] {
            let mut t = r.clone();
            tweak(&mut t);
            assert!(t.verify(&sk.verifying_key(), ID).is_err());
        }
        assert!(r.verify(&key(2).verifying_key(), ID).is_err(), "another key");
        assert!(r.verify(&sk.verifying_key(), &"cd".repeat(32)).is_err(), "another campaign");
        let mut unsigned = r.clone();
        unsigned.sig = None;
        assert!(unsigned.verify(&sk.verifying_key(), ID).is_err());
    }

    #[test]
    fn there_is_no_record_before_the_close() {
        let sk = key(1);
        assert!(FinalRecord::of(ID, &list(&sk, &["reject", "reject"], 0)).is_err());
        assert!(FinalRecord::of(ID, &[]).is_err());
    }

    #[test]
    fn the_same_list_matches_a_cut_off_list_does_not_and_a_forked_list_does_not() {
        let sk = key(1);
        let full = list(&sk, &["reject", "reject", "reject", "close"], 0);
        let r = record(&sk, &full);
        assert_eq!(r.compare(&full), Comparison::Matches);
        // cut off the end: the close entry, or more
        assert_eq!(r.compare(&full[..3]), Comparison::CutOff { has: 3, fixed: 4 }, "the close entry cut off the end");
        let mut with_close_somewhere = full[..3].to_vec();
        with_close_somewhere.push(full[3].clone());
        assert_eq!(r.compare(&with_close_somewhere), Comparison::Matches);
        // a list that still has a close entry but lost entries before the end cannot chain; a list that simply ends earlier is a cut-off one:
        let early_close = list(&sk, &["reject", "close"], 0);
        assert_eq!(r.compare(&early_close), Comparison::CutOff { has: 2, fixed: 4 });
        // a fork: the same key signed a different close at the same place (a different history, equally well signed)
        let fork = list(&sk, &["reject", "reject", "reject", "close"], 7);
        assert_ne!(fork.last().unwrap().hash().unwrap(), full.last().unwrap().hash().unwrap());
        assert_eq!(r.compare(&fork), Comparison::Different);
    }

    #[test]
    fn settlement_entries_may_follow_but_nothing_else() {
        let sk = key(1);
        let at_close = list(&sk, &["reject", "close"], 0);
        let r = record(&sk, &at_close);
        let mut longer = list(&sk, &["reject", "close", "settle", "settle"], 0);
        assert_eq!(r.compare(&longer), Comparison::Matches, "settlements follow a close");
        longer = list(&sk, &["reject", "close", "reject"], 0);
        assert_eq!(r.compare(&longer), Comparison::ExtraEntries { has: 3, fixed: 2 });
    }

    #[test]
    fn a_later_record_may_replace_an_earlier_one_only_if_it_covers_more() {
        let sk = key(1);
        let a = record(&sk, &list(&sk, &["close"], 0));
        let b = record(&sk, &list(&sk, &["close", "settle"], 0));
        assert!(a.is_extended_by(&b) && !b.is_extended_by(&a) && !a.is_extended_by(&a));
    }

    #[test]
    fn the_line_names_the_count_and_the_last_hash() {
        let sk = key(1);
        let l = list(&sk, &["close"], 0);
        let line = record(&sk, &l).line();
        assert_eq!(line, list_line(&l).unwrap());
        assert!(line.starts_with("1 entries, last entry ") && line.len() == "1 entries, last entry ".len() + 64);
        assert_eq!(list_line(&[]).unwrap(), "0 entries");
    }
}
