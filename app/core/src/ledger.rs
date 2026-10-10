//! Ticket ledger entries (SPEC §4): numbered, hash-chained, signed.

use std::{fs, path::Path};

use anyhow::{Context, Result, bail};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::{canon::to_canonical, hash, hex32};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Contribution {
    pub txid: String,
    pub action: u32,
    pub nf: String,
    pub height: u32,
    /// Raise: the amount, public. Auction: omitted until close (sealed bids).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_zat: Option<u64>,
    /// Auction: `BLAKE2b-256("ledgerlab_amount", amount_key || nf || value_le64)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_commit: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ticket {
    pub txid: String,
    pub issue_height: u32,
    pub branch_id: String,
}

/// The host's declared outcome, checked by the recount (R7).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Close {
    pub close_height: u32,
    /// Raise: `"goal_met"` or `"goal_missed"`. Auction: `"auction"`.
    pub outcome: String,
    /// Auction: nullifiers of the winning bids, best first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub winners: Option<Vec<String>>,
    /// Auction: the revealed UFVK (its hash is in the rules).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ufvk: Option<String>,
    /// Auction: the key opening every `amount_commit`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_key: Option<String>,
    /// Uniform auction: the price every winner pays (net, in zatoshis).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clearing_price_zat: Option<u64>,
}

/// Uniform auction: the host's signed statement of one winner's settlement transaction.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settle {
    /// The winner's note (nullifier) that the settlement spends.
    pub nf: String,
    pub txid: String,
    pub price_zat: u64,
    /// What the winner is sent back: note value - price - fee.
    pub excess_zat: u64,
    pub fee_zat: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub v: u32,
    pub rules_id: String,
    pub seq: u64,
    pub prev: String,
    /// `"issue"`, `"reissue"`, `"reject"`, `"close"` or (uniform auction) `"settle"`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contribution: Option<Contribution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket: Option<Ticket>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_hash: Option<String>,
    /// Reject: why the memo could not be accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close: Option<Close>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settle: Option<Settle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub const GENESIS_PREV: &str = "0000000000000000000000000000000000000000000000000000000000000000";

pub fn blob_hash(blob: &[u8]) -> String {
    hex::encode(hash(b"ledgerlab_blob", blob))
}

pub fn amount_commit(amount_key: &[u8; 32], nf: &str, value_zat: u64) -> Result<String> {
    let mut data = amount_key.to_vec();
    data.extend_from_slice(&hex32(nf)?);
    data.extend_from_slice(&value_zat.to_le_bytes());
    Ok(hex::encode(hash(b"ledgerlab_amount", &data)))
}

impl Entry {
    pub fn new(rules_id: &str, kind: &str) -> Self {
        Entry {
            v: 1,
            rules_id: rules_id.into(),
            seq: 0,
            prev: String::new(),
            kind: kind.into(),
            contribution: None,
            ticket: None,
            blob_hash: None,
            reason: None,
            close: None,
            settle: None,
            sig: None,
        }
    }

    fn signing_bytes(&self) -> Result<Vec<u8>> {
        let mut unsigned = self.clone();
        unsigned.sig = None;
        Ok(to_canonical(&unsigned)?.into_bytes())
    }

    pub fn sign(&mut self, sk: &SigningKey) -> Result<()> {
        let sig = sk.sign(&self.signing_bytes()?);
        self.sig = Some(hex::encode(sig.to_bytes()));
        Ok(())
    }

    pub fn verify(&self, pk: &VerifyingKey) -> Result<()> {
        let sig = self.sig.as_deref().context("unsigned entry")?;
        let sig = Signature::from_slice(&hex::decode(sig)?)?;
        pk.verify(&self.signing_bytes()?, &sig)?;
        Ok(())
    }

    /// `entry_hash = BLAKE2b-256("ledgerlab_entry", canonical entry including sig)`.
    pub fn hash(&self) -> Result<String> {
        Ok(hex::encode(hash(b"ledgerlab_entry", to_canonical(self)?.as_bytes())))
    }

    pub fn nf(&self) -> Option<&str> {
        self.contribution.as_ref().map(|c| c.nf.as_str())
    }
}

pub fn verifying_key(hex_pk: &str) -> Result<VerifyingKey> {
    Ok(VerifyingKey::from_bytes(&hex32(hex_pk)?)?)
}

/// Checks a ledger as served by an untrusted source: signatures, numbering, hash chain, and
/// that every entry belongs to the campaign. Returns one line per problem (empty = intact).
pub fn check_chain(entries: &[Entry], pk: &VerifyingKey, rules_id: &str) -> Vec<String> {
    let mut problems = vec![];
    let mut prev = GENESIS_PREV.to_string();
    for (i, e) in entries.iter().enumerate() {
        if e.seq != i as u64 {
            problems.push(format!("entry {i} has seq {} (an entry is missing or out of order)", e.seq));
        }
        if e.prev != prev {
            problems.push(format!("entry {} does not follow the previous entry (hash chain broken)", e.seq));
        }
        if e.rules_id != rules_id {
            problems.push(format!("entry {} belongs to another campaign", e.seq));
        }
        if let Err(err) = e.verify(pk) {
            problems.push(format!("entry {} has a bad signature ({err})", e.seq));
        }
        prev = e.hash().unwrap_or_default();
    }
    problems
}

/// A ledger stored as one JSON file per entry, `NNNNNN.json`, in a directory.
pub struct LedgerDir<'a>(pub &'a Path);

impl LedgerDir<'_> {
    pub fn load(&self) -> Result<Vec<Entry>> {
        let mut entries = vec![];
        if self.0.exists() {
            let mut paths: Vec<_> = fs::read_dir(self.0)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect();
            paths.sort();
            for p in paths {
                entries.push(serde_json::from_slice(&fs::read(&p)?).with_context(|| p.display().to_string())?);
            }
        }
        Ok(entries)
    }

    /// Appends a new entry after filling in `seq` and `prev` and signing it.
    pub fn append(&self, mut entry: Entry, sk: &SigningKey) -> Result<Entry> {
        let existing = self.load()?;
        entry.seq = existing.len() as u64;
        entry.prev = match existing.last() {
            Some(last) => last.hash()?,
            None => GENESIS_PREV.to_string(),
        };
        entry.sign(sk)?;
        fs::create_dir_all(self.0)?;
        let path = self.0.join(format!("{:06}.json", entry.seq));
        // Exclusive and all-or-nothing: the entry is written to a private temporary name, then linked under its number. The link fails if
        // that number already exists, so two writers can never both write entry N, and a crash never leaves half an entry under its number.
        let tmp = self.0.join(format!(".{:06}.{}.{}.tmp", entry.seq, std::process::id(), TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::write(&tmp, to_canonical(&entry)?)?;
        let linked = fs::hard_link(&tmp, &path);
        let _ = fs::remove_file(&tmp);
        match linked {
            Ok(()) => Ok(entry),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => bail!("ledger entry {} already exists (another writer got there first)", path.display()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod append_tests {
    use super::*;

    #[test]
    fn two_simultaneous_appends_never_overwrite_each_other() {
        let dir = std::env::temp_dir().join(format!("ll-ledger-race-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let id = "ab".repeat(32);
        for round in 0..30u32 {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
            let handles: Vec<_> = (0..4u32)
                .map(|w| {
                    let (dir, sk, id, b) = (dir.clone(), sk.clone(), id.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        let mut e = Entry::new(&id, "reject");
                        e.reason = Some(format!("round {round} writer {w}"));
                        b.wait();
                        LedgerDir(&dir).append(e, &sk).ok()
                    })
                })
                .collect();
            let written: Vec<Entry> = handles.into_iter().filter_map(|h| h.join().unwrap()).collect();
            // every append that reported success is exactly what is on disk under its number
            for e in &written {
                let on_disk: Entry = serde_json::from_slice(&fs::read(dir.join(format!("{:06}.json", e.seq))).unwrap()).unwrap();
                assert_eq!(&on_disk, e, "an entry reported as written was overwritten");
            }
            let mut seqs: Vec<u64> = written.iter().map(|e| e.seq).collect();
            seqs.sort();
            seqs.dedup();
            assert_eq!(seqs.len(), written.len(), "two writers both reported the same number");
        }
        let all = LedgerDir(&dir).load().unwrap();
        assert!(check_chain(&all, &sk.verifying_key(), &id).is_empty(), "the list on disk is one intact chain");
        assert!(fs::read_dir(&dir).unwrap().all(|f| !f.unwrap().file_name().to_string_lossy().ends_with(".tmp")), "no temporary file is left behind");
        let _ = fs::remove_dir_all(&dir);
    }
}
