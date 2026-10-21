//! The recount check (PROTOTYPE): before a campaign is listed, the real recount runs over its relays' ledger and the public chain, read only.
//!
//! Nothing here decides a rule. The ledger is read from every relay the record names (through the hardened `fetch`, so a stranger's address
//! is treated as before), each relay's ledger is verified with `ll_core::ledger::check_chain`, and the relays are compared with the relay
//! crate's own `multi::judge`, as cb-recount does. Then:
//! - a fundraiser (its viewing key is in the rules), or an auction after its close (the key is in the close entry): the full recount, through
//!   the browser's module (`chain::Chain::full_report`, `ll_web::Recount::report_json`), R1 to R8 and R4b, plus R9 to R12 for a uniform-price
//!   auction;
//! - an auction before its close (the key is sealed): `ll_web::report_sealed`, the page's own sealed recount: R1 (the rules are the committed
//!   ones) and R2 (the signed list is intact) run; every other check waits for the key and is reported as waiting, not as failed.
//!
//! Limits: one recount at a time (a pass runs them in turn), a wall clock limit and a block range limit for each.

use crate::chain::{Chain, FullRequest, ScanStats};
use crate::fetch::{FetchPolicy, get_text};
use anyhow::{Result, anyhow};
use ll_core::ledger::{Entry, check_chain, verifying_key};
use ll_core::recount::{Challenge, close_entry};
use ll_core::rules::Rules;
use ll_relay::multi::{self, Judgement, RelayRead, State as RelayState};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Limits {
    /// Longest a recount may take, all included.
    pub wall: Duration,
    /// Largest block range a full recount scans (start height to tip).
    pub max_blocks: u32,
    /// At most this many recounts in one pass (new records first); the rest wait for the next pass.
    pub per_pass: usize,
    /// A listed campaign is recounted again after this long even if its ledger did not move (a payment the host ignored does not move it).
    pub recheck: Duration,
    /// The same for an entry of the hand kept list (information only).
    pub recheck_fixed: Duration,
    /// Largest ledger read from one relay.
    pub max_ledger_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        // measured on 16 Oct 2026 against public servers: 25 to 60 blocks a second, so 20 000 blocks (about 17 days of mainnet) fit in 600 s
        Limits { wall: Duration::from_secs(600), max_blocks: 20_000, per_pass: 2, recheck: Duration::from_secs(6 * 3600),
            recheck_fixed: Duration::from_secs(24 * 3600), max_ledger_bytes: 8 << 20 }
    }
}

/// One check that did not pass, and why (the recount's own words).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Failed {
    pub id: String,
    pub why: String,
}

/// What a recount found. `verdict` is false when no verdict could be reached (the relays disagree, no intact ledger, a limit was hit, a
/// server did not answer): then `error` says why, and `transient` says whether trying again later may help.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Outcome {
    /// Unix seconds when it finished, and the chain height it counted to.
    pub at: u64,
    pub tip: u32,
    pub network: String,
    /// "full", or "sealed" (an auction before its close: only R1 and R2 can run).
    pub scope: String,
    pub verdict: bool,
    pub all_pass: bool,
    pub passed: Vec<String>,
    pub failed: Vec<Failed>,
    pub waiting: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub transient: bool,
    /// The ledger the recount saw: entries and the hash of the newest (with every relay's, joined).
    pub head: String,
    pub closed: bool,
    pub seconds: f64,
    pub stats: ScanStats,
    /// Bytes read from the relays.
    pub relay_bytes: u64,
    /// A sealed bid auction whose host did not finish it (SPEC §9.7): shown as "did not finish" in the listing.
    #[serde(default)]
    pub did_not_finish: bool,
}

impl Outcome {
    fn none(network: &str, tip: u32, error: String, transient: bool, t0: Instant) -> Outcome {
        Outcome {
            at: crate::host::now_secs(), tip, network: network.into(), scope: String::new(), verdict: false, all_pass: false, passed: vec![], failed: vec![],
            waiting: vec![], error: Some(error), transient, head: String::new(), closed: false, seconds: t0.elapsed().as_secs_f64(), stats: ScanStats::default(), relay_bytes: 0,
            did_not_finish: false,
        }
    }

    /// Passes for listing: a verdict, and every check that could run passed.
    pub fn passes(&self) -> bool {
        self.verdict && self.all_pass
    }

    /// One line for status and queue: "recount passes (full, R1..R8, R4b)" or "the recount fails R4: ...".
    pub fn summary(&self) -> String {
        if !self.verdict {
            return format!("no recount verdict: {}", self.error.as_deref().unwrap_or("unknown"));
        }
        if self.all_pass {
            let w = if self.waiting.is_empty() { String::new() } else { format!("; waiting for the viewing key: {}", self.waiting.join(", ")) };
            return format!("the recount passes ({}: {}{w})", self.scope, self.passed.join(", "));
        }
        format!("the recount fails {}", self.failed.iter().map(|f| format!("{}: {}", f.id, f.why)).collect::<Vec<_>>().join("; "))
    }
}

/// The ledger head every relay shows (cheap: `/v1/campaigns/<id>/head`), joined, to tell whether anything moved since the last recount.
pub fn heads(relays: &[String], id: &str, fetch: &FetchPolicy) -> Result<String> {
    let mut out = vec![];
    for r in relays {
        let t = get_text(&format!("{r}/v1/campaigns/{id}/head"), fetch)?;
        let v: serde_json::Value = serde_json::from_str(&t).map_err(|_| anyhow!("the relay's head is not readable"))?;
        out.push(format!("{}:{}", v["entries"].as_u64().unwrap_or(0), v["last_hash"].as_str().unwrap_or("").chars().take(64).collect::<String>()));
    }
    Ok(out.join(","))
}

/// Reads one relay as `ll_relay::multi::read_one` does, but through the hardened fetch.
fn read_relay(url: &str, id: &str, fetch: &FetchPolicy, max_ledger: usize, bytes: &mut u64) -> RelayRead {
    let mut out = RelayRead { url: url.to_string(), rules: None, entries: vec![], challenges: vec![], state: RelayState::Ok };
    let mut big = fetch.clone();
    big.max_bytes = max_ledger;
    big.total_timeout = big.total_timeout.max(Duration::from_secs(30));
    let rules: Rules = match get_text(&format!("{url}/v1/campaigns/{id}"), fetch).and_then(|t| { *bytes += t.len() as u64; serde_json::from_str(&t).map_err(|e| anyhow!("unreadable rules: {e}")) }) {
        Ok(r) => r,
        Err(e) => { out.state = RelayState::Unreachable(e.to_string()); return out; }
    };
    if rules.id().map(hex::encode).ok().as_deref() != Some(id) {
        out.state = RelayState::Refused("its rules do not hash to the campaign id".into());
        return out;
    }
    match get_text(&format!("{url}/v1/campaigns/{id}/ledger?from=0"), &big).and_then(|t| { *bytes += t.len() as u64; serde_json::from_str::<Vec<Entry>>(&t).map_err(|e| anyhow!("unreadable ledger: {e}")) }) {
        Ok(e) => out.entries = e,
        Err(e) => { out.state = RelayState::Unreachable(e.to_string()); out.rules = Some(rules); return out; }
    }
    // challenges are optional extras, as in the relay crate
    out.challenges = get_text(&format!("{url}/v1/campaigns/{id}/challenges"), &big).ok()
        .and_then(|t| { *bytes += t.len() as u64; serde_json::from_str::<Vec<Challenge>>(&t).ok() }).unwrap_or_default();
    match verifying_key(&rules.ledger_pubkey) {
        Ok(pk) => {
            let problems = check_chain(&out.entries, &pk, id);
            if !problems.is_empty() {
                out.state = RelayState::Damaged(problems);
            }
        }
        Err(e) => out.state = RelayState::Refused(format!("bad ledger key in the rules: {e}")),
    }
    out.rules = Some(rules);
    out
}

fn results(report: &serde_json::Value) -> (Vec<String>, Vec<Failed>, Vec<String>) {
    let (mut passed, mut failed, mut waiting) = (vec![], vec![], vec![]);
    for r in report["rules"].as_array().into_iter().flatten() {
        let id = r["id"].as_str().unwrap_or("?").to_string();
        if r["waiting"].as_bool() == Some(true) {
            waiting.push(id);
        } else if r["pass"].as_bool() == Some(true) {
            passed.push(id);
        } else {
            let why = r["details"].as_array().map(|d| d.iter().filter_map(|x| x.as_str()).take(2).collect::<Vec<_>>().join("; ")).unwrap_or_default();
            failed.push(Failed { id, why: why.chars().take(300).collect() });
        }
    }
    (passed, failed, waiting)
}

/// The recount of one campaign, read only. `tip` is the chain height of the campaign's network.
pub fn recount_campaign(chain: &Arc<dyn Chain>, relays: &[String], id: &str, network: &str, tip: u32, limits: &Limits, fetch: &FetchPolicy) -> Outcome {
    let t0 = Instant::now();
    let deadline = t0 + limits.wall;
    let mut relay_bytes = 0u64;
    let reads: Vec<RelayRead> = relays.iter().map(|u| read_relay(u, id, fetch, limits.max_ledger_bytes, &mut relay_bytes)).collect();
    // every relay that answers must show the same intact ledger (owner decision 4): a relay that answers with a damaged ledger, or refuses,
    // while another serves an intact one, leaves no verdict; a relay that cannot be reached at all is left out, as in cb-recount
    let answered_badly: Vec<String> = reads.iter().filter(|r| matches!(r.state, RelayState::Damaged(_) | RelayState::Refused(_))).map(|r| r.url.clone()).collect();
    let (rules, entries, challenges) = match multi::judge(&reads) {
        Judgement::Agree(_) | Judgement::Single(_) if !answered_badly.is_empty() => {
            let mut o = Outcome::none(network, tip, format!("not every relay that answers shows an intact ledger ({})", multi::excluded_notes(&reads).join("; ")), false, t0);
            o.relay_bytes = relay_bytes;
            return o;
        }
        Judgement::Agree(r) | Judgement::Single(r) => (r.rules.clone(), r.entries.clone(), multi::merged_challenges(&reads)),
        // a relay that is down or behind says nothing about the host: no verdict (as cb-recount: "cannot conclude"), never a FAIL
        Judgement::Disagree(lines) => {
            let mut o = Outcome::none(network, tip, format!("the relays do not show the same ledger ({})", lines.join("; ")), false, t0);
            o.relay_bytes = relay_bytes;
            return o;
        }
        Judgement::NoUsableLedger(lines) => {
            let transient = reads.iter().all(|r| matches!(r.state, RelayState::Unreachable(_)));
            let mut o = Outcome::none(network, tip, format!("no relay gave an intact, signed ledger ({})", lines.join("; ")), transient, t0);
            o.relay_bytes = relay_bytes;
            return o;
        }
    };
    let Some(rules) = rules else { return Outcome::none(network, tip, "the relay sent no rules".into(), true, t0) };
    let head = reads.iter().filter(|r| r.state == RelayState::Ok)
        .map(|r| format!("{}:{}", r.entries.len(), r.entries.last().and_then(|e| e.hash().ok()).unwrap_or_else(|| ll_core::ledger::GENESIS_PREV.into())))
        .collect::<Vec<_>>().join(",");
    let close = close_entry(&entries);
    let closed = close.is_some() || tip >= rules.deadline_height;
    // a sealed bid auction publishes its viewing key in a reveal entry, once every winner is settled (SPEC §9.6)
    let ufvk = if rules.is_sealed() {
        entries.iter().find(|e| e.kind == "reveal").and_then(|e| e.reveal.as_ref()).map(|r| r.ufvk.clone())
    } else if rules.is_auction() {
        close.and_then(|c| c.ufvk.clone())
    } else {
        rules.campaign_ufvk.clone()
    };
    let (Ok(rules_json), Ok(ledger_json), Ok(challenges_json)) = (serde_json::to_string(&rules), serde_json::to_string(&entries), serde_json::to_string(&challenges)) else {
        return Outcome::none(network, tip, "the campaign could not be written out for the recount".into(), false, t0);
    };
    let mut o = Outcome { at: 0, tip, network: network.into(), scope: String::new(), verdict: true, all_pass: false, passed: vec![], failed: vec![], waiting: vec![],
        error: None, transient: false, head, closed, seconds: 0.0, stats: ScanStats::default(), relay_bytes, did_not_finish: false };
    let report: Result<serde_json::Value> = match ufvk {
        None => {
            o.scope = "sealed".into();
            // the second review, M2: at the chain's height, so a host that never closes is marked "did not finish"
            std::panic::catch_unwind(|| ll_web::report_sealed_at(&rules_json, id, &ledger_json, tip)).map_err(|_| anyhow!("the sealed recount failed"))
                .and_then(|r| r.map_err(|_| anyhow!("the sealed recount could not read the campaign")))
                .and_then(|t| Ok(serde_json::from_str(&t)?))
        }
        Some(ufvk) => {
            o.scope = "full".into();
            let span = tip.saturating_sub(rules.start_height) + 1;
            if span > limits.max_blocks {
                let mut n = Outcome::none(network, tip, format!("the campaign spans {span} blocks, more than the limit of {} for one recount", limits.max_blocks), false, t0);
                n.relay_bytes = relay_bytes;
                return n;
            }
            let req = FullRequest { network: network.into(), ufvk, treasury_ufvk: rules.treasury_ufvk.clone(), start: rules.start_height, end: tip, rules_json, rules_id: id.into(), ledger_json, challenges_json };
            // the wall clock limit holds even if a chain server stops answering mid request: the scan runs in its own thread, which also
            // stops itself at the deadline, so at most one abandoned scan can still be finishing its last request
            let (tx, rx) = std::sync::mpsc::channel();
            let c = chain.clone();
            std::thread::spawn(move || { let _ = tx.send(c.full_report(&req, deadline)); });
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Ok((r, stats))) => { o.stats = stats; Ok(r) }
                Ok(Err(e)) => {
                    let limit = e.to_string().contains("time limit");
                    let mut n = Outcome::none(network, tip, e.to_string(), !limit, t0);
                    n.relay_bytes = relay_bytes;
                    n.head = o.head;
                    return n;
                }
                Err(_) => {
                    let mut n = Outcome::none(network, tip, format!("the recount took longer than its time limit of {} s", limits.wall.as_secs()), false, t0);
                    n.relay_bytes = relay_bytes;
                    n.head = o.head;
                    return n;
                }
            }
        }
    };
    match report {
        Ok(r) => {
            let (p, f, w) = results(&r);
            o.all_pass = f.is_empty() && !p.is_empty();
            // a sealed bid auction whose host did not finish is marked so in the listing (the owner's decision, 20 Oct 2026)
            o.did_not_finish = r.get("did_not_finish").and_then(serde_json::Value::as_bool).unwrap_or(false);
            (o.passed, o.failed, o.waiting) = (p, f, w);
        }
        Err(e) => { o.verdict = false; o.error = Some(e.to_string()); }
    }
    o.at = crate::host::now_secs();
    o.seconds = t0.elapsed().as_secs_f64();
    o
}

// ---------- which campaigns are recounted in a pass, and the cache ----------

/// The recount part of the job's configuration.
#[derive(Clone)]
pub struct Setup {
    pub chain: Arc<dyn Chain>,
    pub limits: Limits,
}

impl std::fmt::Debug for Setup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Setup").field("limits", &self.limits).finish_non_exhaustive()
    }
}

/// Why a campaign is recounted, in the order a pass serves them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    /// An approved host's campaign that was never listed: it is listed only once its recount passes.
    New,
    /// A listed campaign: rechecked when its ledger or close state moves, every `recheck`, and once more after its close.
    Listed,
    /// A record from a host not approved yet: recounted for the operator's information when there is time left (testnet only: a queued
    /// mainnet record is never recounted).
    Queued,
    /// An entry of the hand kept list: for information only (it is never removed).
    Fixed,
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: String,
    pub relays: Vec<String>,
    pub kind: Kind,
    /// Known for records (from the rules checked this pass); a fixed entry's are read once from its relay.
    pub network: Option<String>,
    pub deadline: Option<u32>,
}

/// The last recount of one campaign, kept in state/recount.json.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cached {
    /// The ledger heads the relays showed when it ran ("" if they could not be read).
    pub key: String,
    pub closed: bool,
    pub network: String,
    pub deadline: u32,
    pub outcome: Outcome,
    /// Since when the recount fails (unix seconds); cleared when it passes again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_since: Option<u64>,
}

impl Cached {
    /// A result that needs a person: a check failed, or no verdict for a reason trying again will not fix (relays disagree, a limit).
    pub fn flagged(&self) -> bool {
        (self.outcome.verdict && !self.outcome.all_pass) || (!self.outcome.verdict && !self.outcome.transient)
    }
}

/// A fixed entry's network and deadline, from the first of its relays that serves rules for its id.
fn rules_of(relays: &[String], id: &str, fetch: &FetchPolicy) -> Option<(String, u32)> {
    relays.iter().find_map(|r| {
        let t = get_text(&format!("{r}/v1/campaigns/{id}"), fetch).ok()?;
        let rules: Rules = serde_json::from_str(&t).ok()?;
        (rules.id().ok().map(hex::encode).as_deref() == Some(id)).then(|| (rules.network.clone(), rules.deadline_height))
    })
}

/// Runs the recounts that are due, in order (new records first), at most `limits.per_pass` of them, one at a time. `tips` gives the chain
/// height of a network (None: unknown this pass, so nothing on it is recounted). Returns how many ran.
pub fn run_due(setup: &Setup, cands: &[Candidate], cache: &mut std::collections::BTreeMap<String, Cached>, tips: &dyn Fn(&str) -> Option<u32>, fetch: &FetchPolicy, now: u64) -> usize {
    let mut order: Vec<&Candidate> = cands.iter().collect();
    // within a kind, the one recounted longest ago first (never recounted: first of all)
    order.sort_by_key(|c| (c.kind, cache.get(&c.id).map_or(0, |x| x.outcome.at)));
    let mut ran = 0;
    for c in order {
        if ran >= setup.limits.per_pass {
            break;
        }
        let known = cache.get(&c.id).map(|x| (x.network.clone(), x.deadline));
        let Some((network, deadline)) = c.network.clone().zip(c.deadline).or(known).or_else(|| rules_of(&c.relays, &c.id, fetch)) else { continue };
        let Some(tip) = tips(&network) else { continue };
        let Ok(key) = heads(&c.relays, &c.id, fetch) else { continue };
        let closed = tip >= deadline;
        let due = match cache.get(&c.id) {
            None => true,
            Some(x) => x.key != key || x.closed != closed || x.outcome.transient
                || (c.kind == Kind::Listed && now.saturating_sub(x.outcome.at) >= setup.limits.recheck.as_secs())
                || (c.kind == Kind::Fixed && now.saturating_sub(x.outcome.at) >= setup.limits.recheck_fixed.as_secs()),
        };
        if !due {
            continue;
        }
        let mut outcome = recount_campaign(&setup.chain, &c.relays, &c.id, &network, tip, &setup.limits, fetch);
        outcome.at = now; // the pass's own time, which the recheck is measured against
        ran += 1;
        if outcome.transient {
            // a server that did not answer says nothing about the campaign: keep the last real result, and try again next pass
            if let Some(x) = cache.get_mut(&c.id) {
                x.outcome.transient = true;
                x.outcome.error = outcome.error.clone();
                continue;
            }
        }
        let since = cache.get(&c.id).and_then(|x| x.attention_since);
        let mut entry = Cached { key, closed, network: network.clone(), deadline, outcome, attention_since: None };
        entry.attention_since = if entry.flagged() { Some(since.unwrap_or(now)) } else { None };
        cache.insert(c.id.clone(), entry);
    }
    ran
}
