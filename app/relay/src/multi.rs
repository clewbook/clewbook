//! Reading one campaign from several relays and judging whether they agree (SPEC §6).
//!
//! A relay can be down, behind, or dishonest; none of that proves anything about the host.
//! So when the ledgers differ, or the only ledger available is damaged, the answer is
//! "cannot conclude", never a verdict against the host.

use ll_core::{
    ledger::{Entry, check_chain, verifying_key},
    recount::Challenge,
    rules::Rules,
};

use crate::client::{Relay, RelayError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Ok,
    Unreachable(String),
    Refused(String),
    /// Reached, but its ledger does not verify (signature, numbering or hash chain).
    Damaged(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct RelayRead {
    pub url: String,
    pub rules: Option<Rules>,
    pub entries: Vec<Entry>,
    pub challenges: Vec<Challenge>,
    pub state: State,
}

pub fn read_one(url: &str, rules_id: &str) -> RelayRead {
    let mut out = RelayRead { url: url.to_string(), rules: None, entries: vec![], challenges: vec![], state: State::Ok };
    let relay = Relay::new(url);
    let classify = |e: &anyhow::Error| match e.downcast_ref::<RelayError>() {
        Some(RelayError::Unreachable(m)) => State::Unreachable(m.clone()),
        _ => State::Refused(e.to_string()),
    };
    let rules = match relay.rules(rules_id) {
        Ok(r) => r,
        Err(e) => {
            out.state = classify(&e);
            return out;
        }
    };
    match relay.ledger(rules_id, 0) {
        Ok(entries) => out.entries = entries,
        Err(e) => {
            out.state = classify(&e);
            out.rules = Some(rules);
            return out;
        }
    }
    // Challenges are optional extras: a relay without them is not a problem.
    out.challenges = relay.challenges(rules_id).unwrap_or_default();
    match verifying_key(&rules.ledger_pubkey) {
        Ok(pk) => {
            let problems = check_chain(&out.entries, &pk, rules_id);
            if !problems.is_empty() {
                out.state = State::Damaged(problems);
            }
        }
        Err(e) => out.state = State::Refused(format!("bad ledger key in the rules: {e}")),
    }
    out.rules = Some(rules);
    out
}

pub fn read_all(urls: &[String], rules_id: &str) -> Vec<RelayRead> {
    urls.iter().map(|u| read_one(u, rules_id)).collect()
}

#[derive(Debug)]
pub enum Judgement<'a> {
    /// At least two relays answered with the same, intact ledger.
    Agree(&'a RelayRead),
    /// Exactly one relay gave an intact ledger. A verdict from it is only as good as that relay.
    Single(&'a RelayRead),
    /// Intact ledgers differ between relays (or one is behind). No conclusion is possible.
    Disagree(Vec<String>),
    /// No relay gave an intact ledger. No conclusion is possible.
    NoUsableLedger(Vec<String>),
}

fn head_note(r: &RelayRead) -> String {
    let head = r.entries.last().and_then(|e| e.hash().ok()).map_or("none".to_string(), |h| h[..12].to_string());
    format!("{}: {} entries, newest {head}", r.url, r.entries.len())
}

/// Lines describing every relay that could not be used (down, refusing, damaged).
pub fn excluded_notes(reads: &[RelayRead]) -> Vec<String> {
    reads
        .iter()
        .filter_map(|r| match &r.state {
            State::Ok => None,
            State::Unreachable(m) => Some(format!("{}: not reachable ({m})", r.url)),
            State::Refused(m) => Some(format!("{}: answered with an error ({m})", r.url)),
            State::Damaged(p) => Some(format!("{}: its ledger is damaged ({})", r.url, p.join("; "))),
        })
        .collect()
}

pub fn judge(reads: &[RelayRead]) -> Judgement<'_> {
    let ok: Vec<&RelayRead> = reads.iter().filter(|r| r.state == State::Ok).collect();
    match ok.as_slice() {
        [] => Judgement::NoUsableLedger(excluded_notes(reads)),
        [one] => Judgement::Single(one),
        [first, rest @ ..] => {
            if rest.iter().all(|r| r.entries == first.entries) {
                return Judgement::Agree(first);
            }
            let mut lines: Vec<String> = ok.iter().map(|r| head_note(r)).collect();
            // First sequence number on which any two relays differ (or where one stops).
            let longest = ok.iter().map(|r| r.entries.len()).max().unwrap_or(0);
            if let Some(seq) = (0..longest).find(|&i| ok.iter().any(|r| r.entries.get(i) != first.entries.get(i))) {
                lines.push(format!("they first differ at entry {seq}"));
            }
            Judgement::Disagree(lines)
        }
    }
}

/// Challenges from every relay that answered, without duplicates.
pub fn merged_challenges(reads: &[RelayRead]) -> Vec<Challenge> {
    let mut all: Vec<Challenge> = vec![];
    for r in reads.iter().filter(|r| !matches!(r.state, State::Unreachable(_))) {
        for c in &r.challenges {
            if !all.iter().any(|x| x.txid == c.txid && x.action == c.action && x.eph_sk == c.eph_sk) {
                all.push(c.clone());
            }
        }
    }
    all
}
