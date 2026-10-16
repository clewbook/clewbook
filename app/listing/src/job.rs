//! The listing job (PROTOTYPE). Everything lives in one data folder:
//!
//!   records/<campaign id>.json   submitted records whose two signatures verified (one per campaign; a newer one replaces an older one)
//!   approved_hosts.txt           host public keys (64 hex) allowed to be listed, one per line, then the display label the operator chose;
//!                                # starts a comment. The label is only ever taken from here, never from a record.
//!   revoked_hosts.txt            host keys whose campaigns must disappear (same form)
//!   hidden.txt                   campaign ids or host keys never to list (same form)
//!   reserved.txt                 names no campaign may look like; a line "contains:<word>" refuses any name with that word in it
//!   state/seen.json              per campaign: when its record was first seen, since when it waits in the queue, when it was first listed
//!   out/campaigns.json           the combined list for the home page, written atomically: first the fixed entries of the hand kept list
//!                                (--hand-list, exactly as written there), then {"id","relays","host":{"label","fingerprint"}} for each
//!                                campaign listed here (pages that read only id and relays ignore "host"). With nothing listed here it is a
//!                                byte for byte copy of the hand kept list.
//!   out/status.json              why each record was listed, queued, hidden, revoked, refused or expired, and each fixed entry
//!   out/queue.json               records from hosts not approved yet: fingerprint, key, name, id, network, and when they expire
//!
//! The hand kept list is the operator's own file. The job only reads it: it is never written, its entries are never checked or dropped (the
//! network rule does not apply to them), and a pass that cannot read it writes nothing, so the home page is never emptied by mistake.
//!
//! A campaign stays listed after its deadline (history and proof): the deadline is checked only before a campaign is listed for the first
//! time. A record from a host that is never approved is removed after `queue_ttl` (7 days by default); the host may send it again.
//!
//! A pass reads every record and decides. Records are only ever added by a submission (the HTTP endpoint or `submit`); nothing here writes to
//! any relay, and nothing is deleted from any relay.

use crate::fetch::{FetchPolicy, get_text};
use crate::names::{collides, contains_reserved, unusual_letters};
use crate::record::{ListingRecord, MAX_RECORD_BYTES, fingerprint};
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// The word no label and no listed campaign name may contain, in any look alike spelling.
pub const RESERVED_WORD: &str = "clewbook";
/// The largest hand kept list read.
pub const MAX_HAND_LIST_BYTES: usize = 1 << 20;

#[derive(Clone, Debug)]
pub struct JobConfig {
    pub dir: PathBuf,
    pub allowed_networks: Vec<String>,
    pub fetch: FetchPolicy,
    /// At most this many records per host key are kept.
    pub max_records_per_key: usize,
    /// At most this many records in all (queued or not).
    pub max_records: usize,
    /// At most this many records from hosts that are not approved.
    pub max_queue: usize,
    /// The operator's hand kept list (read only): its entries come first in the combined list.
    pub hand_list: Option<PathBuf>,
    /// Seconds a record from a host that is never approved waits in the queue before it is removed.
    pub queue_ttl: u64,
    /// Mainnet only: the published NU7 activation height. A new mainnet campaign whose deadline is not before it is refused (its tickets
    /// would not survive the upgrade).
    pub nu7_mainnet_height: Option<u32>,
    /// The recount check (None: no recount, as before; the command line always sets it).
    #[cfg(feature = "recount")]
    pub recount: Option<crate::recount::Setup>,
}

impl JobConfig {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        JobConfig {
            dir: dir.into(), allowed_networks: vec!["test".into()], fetch: FetchPolicy::default(), max_records_per_key: 10, max_records: 1000,
            max_queue: 200, hand_list: None, queue_ttl: 7 * 24 * 3600, nu7_mainnet_height: None,
            #[cfg(feature = "recount")]
            recount: None,
        }
    }
    fn p(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
}

/// A key list file: the first word of each line that is not a comment, lowercased.
pub fn read_list(path: &Path) -> Vec<String> {
    fs::read_to_string(path).unwrap_or_default().lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| !l.is_empty())
        .filter_map(|l| l.split_whitespace().next().map(|w| w.to_lowercase()))
        .collect()
}
/// The labels of approved_hosts.txt: key -> the rest of its line (before any #), trimmed.
pub fn read_labels(path: &Path) -> std::collections::HashMap<String, String> {
    fs::read_to_string(path).unwrap_or_default().lines()
        .filter_map(|l| {
            let l = l.split('#').next().unwrap_or("").trim();
            let (k, rest) = l.split_once(char::is_whitespace).unwrap_or((l, ""));
            (!k.is_empty()).then(|| (k.to_lowercase(), rest.trim().to_string()))
        })
        .collect()
}

/// A label is shown on a page, so it follows the campaign name rules (plain text, 1 to 60 characters, no control, invisible or direction
/// characters, no < or >), and may not contain the word Clewbook in any spelling.
pub fn check_label(label: &str) -> Result<()> {
    ensure!(!label.contains('#'), "a label may not contain #");
    ll_core::rules::check_name(label).map_err(|e| anyhow!("{}", e.to_string().replace("campaign name", "label")))?;
    ensure!(!contains_reserved(label, RESERVED_WORD), "a label may not contain the word Clewbook (in any spelling)");
    Ok(())
}

/// What the job remembers about each campaign between passes (unix seconds).
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Seen {
    pub first_seen: u64,
    /// Since when its host is not approved (cleared once it is).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_since: Option<u64>,
    /// When it was first listed. A campaign listed once is never refused for its deadline afterwards, and never expires from the queue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listed_at: Option<u64>,
}

pub fn read_seen(cfg: &JobConfig) -> BTreeMap<String, Seen> {
    fs::read(cfg.p("state/seen.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// The hand kept list: its exact bytes and the ids of its entries. It must be {"campaigns":[{"id":<64 hex>,"relays":[...]}, ...]}; anything
/// else stops the pass before anything is written.
pub fn read_hand_list(path: &Path) -> Result<(Vec<u8>, serde_json::Value, Vec<String>)> {
    let bytes = fs::read(path).with_context(|| format!("cannot read the hand kept list {}", path.display()))?;
    ensure!(bytes.len() <= MAX_HAND_LIST_BYTES, "the hand kept list is larger than {MAX_HAND_LIST_BYTES} bytes");
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| anyhow!("the hand kept list is not valid JSON: {e}"))?;
    let list = v.get("campaigns").and_then(|c| c.as_array()).ok_or_else(|| anyhow!("the hand kept list has no \"campaigns\" list"))?;
    let mut ids = vec![];
    for (i, e) in list.iter().enumerate() {
        let id = e.get("id").and_then(|x| x.as_str()).filter(|x| is_hex64(x)).ok_or_else(|| anyhow!("entry {} of the hand kept list has no 64 hex id", i + 1))?;
        ensure!(e.get("relays").is_some_and(|r| r.as_array().is_some_and(|a| a.iter().all(|x| x.is_string()))), "entry {} of the hand kept list has no relays list", i + 1);
        ids.push(id.to_lowercase());
    }
    Ok((bytes, v, ids))
}

fn read_lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path).unwrap_or_default().lines().map(|l| l.split('#').next().unwrap_or("").trim().to_string()).filter(|l| !l.is_empty()).collect()
}

/// Writes a file so a reader sees either the old or the new content, never half of it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(d) = path.parent() {
        fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn load_records(cfg: &JobConfig) -> Vec<ListingRecord> {
    let mut out = vec![];
    if let Ok(rd) = fs::read_dir(cfg.p("records")) {
        for e in rd.flatten() {
            if let Ok(b) = fs::read(e.path()) {
                if let Ok(r) = ListingRecord::parse_and_verify(&b) {
                    out.push(r);
                }
            }
        }
    }
    out.sort_by(|a, b| a.created.cmp(&b.created).then(a.campaign.cmp(&b.campaign)));
    out
}

/// Accepts one submitted record: size, shape and both signatures (no network), the caps, then stores it. Returns a plain sentence.
pub fn submit(cfg: &JobConfig, bytes: &[u8]) -> Result<String> {
    ensure!(bytes.len() <= MAX_RECORD_BYTES, "a listing record is at most {MAX_RECORD_BYTES} bytes");
    let r = ListingRecord::parse_and_verify(bytes)?;
    let hidden = read_list(&cfg.p("hidden.txt"));
    let revoked = read_list(&cfg.p("revoked_hosts.txt"));
    ensure!(!revoked.contains(&r.host_pubkey), "this host key was revoked");
    ensure!(!hidden.contains(&r.campaign) && !hidden.contains(&r.host_pubkey), "this campaign is not listed here");
    let all = load_records(cfg);
    let existing = all.iter().find(|x| x.campaign == r.campaign);
    if let Some(old) = existing {
        ensure!(r.created > old.created, "a newer record for this campaign is already here");
    }
    let same_key = all.iter().filter(|x| x.host_pubkey == r.host_pubkey && x.campaign != r.campaign).count();
    ensure!(same_key < cfg.max_records_per_key, "this host key already has {} records here", cfg.max_records_per_key);
    if existing.is_none() {
        ensure!(all.len() < cfg.max_records, "the listing is full");
        let approved = read_list(&cfg.p("approved_hosts.txt"));
        if !approved.contains(&r.host_pubkey) {
            let queued = all.iter().filter(|x| !approved.contains(&x.host_pubkey)).count();
            ensure!(queued < cfg.max_queue, "the queue for hosts not approved yet is full");
        }
    }
    write_atomic(&cfg.p(&format!("records/{}.json", r.campaign)), &serde_json::to_vec_pretty(&r)?)?;
    Ok(format!("received: campaign {}…, host {}", &r.campaign[..8], r.host_fingerprint()))
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Listed,
    Queued,
    Hidden,
    Revoked,
    Refused,
    /// Waited in the queue longer than the queue time without its host being approved; the record was removed.
    Expired,
    /// An entry of the hand kept list (read only, never removed; its recount is shown for information).
    Fixed,
    /// An approved host's new campaign that passed every other check and waits for its first recount.
    Checking,
}

/// A listed campaign whose recount fails: it stays listed, and the operator decides whether to hide it.
#[derive(Serialize, Debug, Clone)]
pub struct Attention {
    pub failing: String,
    /// Unix seconds since when the recount fails.
    pub since: u64,
}

#[derive(Serialize, Debug, Clone)]
pub struct Status {
    pub campaign: String,
    pub host: String,
    pub state: State,
    pub reason: String,
    /// Display only (never used as a key, a path or a link).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The last recount: when, at which height, the checks passed, failed and waiting, and what it cost.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recount: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<Attention>,
}

#[derive(Serialize, Debug, Clone)]
pub struct QueueItem {
    pub fingerprint: String,
    pub host_pubkey: String,
    pub campaign: String,
    pub network: String,
    pub name: Option<String>,
    pub relays: Vec<String>,
    pub created: u64,
    /// Whether everything but the approval passed when it was last checked.
    pub checks_pass: bool,
    pub note: String,
    /// Since when it waits (unix seconds), and when it is removed if its host is still not approved by then.
    pub queued_since: u64,
    pub expires_at: u64,
    /// "approval" (a host not approved yet) or "attention" (a listed campaign whose recount fails: the operator decides whether to hide it).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recount: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<Attention>,
}

/// "6 d 23 h", "5 h 10 min", "40 min".
pub fn plain_duration(secs: u64) -> String {
    let (d, h, m) = (secs / 86400, secs % 86400 / 3600, secs % 3600 / 60);
    if d > 0 { format!("{d} d {h} h") } else if h > 0 { format!("{h} h {m} min") } else { format!("{} min", m.max(1)) }
}

/// Reads the campaign from its relays: at least one must answer, and every relay that answers must serve rules that pass the checks.
fn check_campaign(r: &ListingRecord, cfg: &JobConfig, tips: &dyn Fn(&str) -> Option<u32>, require_open: bool) -> Result<ll_core::rules::Rules> {
    let tip = tips(&r.network).ok_or_else(|| anyhow!("the chain height of network {:?} could not be read this pass", r.network))?;
    let mut first: Option<ll_core::rules::Rules> = None;
    let mut errors = vec![];
    for relay in &r.relays {
        match get_text(&format!("{relay}/v1/campaigns/{}", r.campaign), &cfg.fetch).and_then(|t| r.check_against_rules(&t, tip, &cfg.allowed_networks, require_open)) {
            Ok(rules) => {
                if first.is_none() {
                    first = Some(rules);
                }
            }
            Err(e) => errors.push(format!("{}: {e}", host_of(relay))),
        }
    }
    match first {
        Some(rules) if errors.is_empty() => {
            // as cb-host's guard (app/host/src/mainnet.rs): the campaign's whole life (deadline, ticket window, close grace, re-issue window)
            // and a margin of 50 blocks must end before the NU7 activation; its refund tickets would not survive the upgrade
            if let (true, "main", Some(nu7)) = (require_open, rules.network.as_str(), cfg.nu7_mainnet_height) {
                let end = rules.deadline_height.saturating_add(rules.ticket_k).saturating_add(rules.close_grace).saturating_add(rules.reissue_window).saturating_add(50);
                ensure!(tip < nu7 && end < nu7, "the campaign could still be running at the NU7 upgrade (block {nu7}; it runs until about block {end}): its refund tickets would not survive it");
            }
            Ok(rules)
        }
        Some(_) => bail!("not every relay serves this campaign ({})", errors.join("; ")),
        None => bail!("{}", errors.join("; ")),
    }
}

fn host_of(url: &str) -> String {
    url.split_once("://").map(|(_, r)| r.split(['/', '?', '#']).next().unwrap_or("")).unwrap_or(url).chars().take(80).collect()
}

/// One pass at the current time: decides for every record, then writes the list, the status and the queue (each atomically).
pub fn run_pass(cfg: &JobConfig, tip: u32) -> Result<Vec<Status>> {
    run_pass_at(cfg, tip, crate::host::now_secs())
}

/// One pass at the time `now` (unix seconds), with the same chain height for every network (tests).
pub fn run_pass_at(cfg: &JobConfig, tip: u32, now: u64) -> Result<Vec<Status>> {
    run_pass_with(cfg, &|_: &str| Some(tip), now)
}

/// What the last recount says about one campaign, for the decisions below.
struct RecountView {
    outcome: serde_json::Value,
    /// It ran over the ledger the relays show now (nothing moved since).
    current: bool,
    passes: bool,
    flagged: bool,
    transient: bool,
    summary: String,
    attention_since: Option<u64>,
}

/// One pass at the time `now`; `tips` gives each network's chain height (None: unknown this pass).
pub fn run_pass_with(cfg: &JobConfig, tips: &dyn Fn(&str) -> Option<u32>, now: u64) -> Result<Vec<Status>> {
    // the hand kept list first: a pass that cannot read it writes nothing, so the home page keeps its last good list
    let hand = cfg.hand_list.as_deref().map(read_hand_list).transpose()?;
    let fixed: HashSet<String> = hand.as_ref().map(|(_, _, ids)| ids.iter().cloned().collect()).unwrap_or_default();
    let approved = read_list(&cfg.p("approved_hosts.txt"));
    let revoked = read_list(&cfg.p("revoked_hosts.txt"));
    let hidden = read_list(&cfg.p("hidden.txt"));
    let reserved = read_lines(&cfg.p("reserved.txt"));
    let labels = read_labels(&cfg.p("approved_hosts.txt"));
    let mut seen_state = read_seen(cfg);
    let mut listed: Vec<(String, Vec<String>, String)> = vec![];
    let mut listed_names: Vec<(String, String)> = vec![]; // (name, campaign)
    let mut status = vec![];
    let mut queue = vec![];
    for id in hand.as_ref().map(|(_, _, ids)| ids.as_slice()).unwrap_or_default() {
        status.push(Status { campaign: id.clone(), host: "-".into(), state: State::Fixed, reason: "an entry of the hand kept list (read only; listed first, never removed)".into(), name: None, recount: None, attention: None });
    }
    // a campaign listed by the last pass keeps its place: when two names collide, the one already listed stays and the newcomer is refused,
    // whatever their times (records made in the same second would otherwise be decided by their ids)
    let before: HashSet<String> = fs::read(cfg.p("out/status.json")).ok()
        .and_then(|b| serde_json::from_slice::<Vec<serde_json::Value>>(&b).ok()).unwrap_or_default().into_iter()
        .filter(|v| v["state"] == "listed").filter_map(|v| v["campaign"].as_str().map(str::to_string)).collect();
    let records = load_records(cfg);
    let present: HashSet<String> = records.iter().map(|r| r.campaign.clone()).collect();
    seen_state.retain(|id, _| present.contains(id));
    // first, each record on its own: hidden, revoked, or the campaign as its relays serve it
    struct Checked { r: ListingRecord, approved: bool, checked: Result<ll_core::rules::Rules>, name: Option<String> }
    let mut seen = vec![];
    for r in records {
        let fp = r.host_fingerprint();
        let st = seen_state.entry(r.campaign.clone()).or_insert_with(|| Seen { first_seen: now, ..Default::default() });
        if hidden.contains(&r.campaign) || hidden.contains(&r.host_pubkey) {
            status.push(Status { campaign: r.campaign.clone(), host: fp, state: State::Hidden, reason: "on the hidden list".into(), name: None, recount: None, attention: None });
            continue;
        }
        if revoked.contains(&r.host_pubkey) {
            status.push(Status { campaign: r.campaign.clone(), host: fp, state: State::Revoked, reason: "the host key was revoked".into(), name: None, recount: None, attention: None });
            continue;
        }
        let is_approved = approved.contains(&r.host_pubkey);
        if is_approved {
            st.queued_since = None;
        } else if st.queued_since.is_none() {
            st.queued_since = Some(now);
        }
        // a record whose host was never approved is removed once it has waited the queue time (it is not even fetched)
        if let (false, Some(since), None) = (is_approved, st.queued_since, st.listed_at) {
            if now >= since.saturating_add(cfg.queue_ttl) {
                let _ = fs::remove_file(cfg.p(&format!("records/{}.json", r.campaign)));
                seen_state.remove(&r.campaign);
                status.push(Status { campaign: r.campaign.clone(), host: fp, state: State::Expired,
                    reason: format!("its host key was not approved within {}; the record was removed (the host may send it again)", plain_duration(cfg.queue_ttl)), name: None, recount: None, attention: None });
                continue;
            }
        }
        // the deadline counts only before a campaign is first listed: once listed, it stays listed after its close
        let checked = check_campaign(&r, cfg, tips, st.listed_at.is_none());
        let name = checked.as_ref().ok().and_then(|x| x.name.clone());
        seen.push(Checked { approved: is_approved, r, checked, name });
    }
    let reserved_hit = |n: &str| {
        if contains_reserved(n, RESERVED_WORD) {
            return Some(format!("the name contains a reserved word ({RESERVED_WORD})"));
        }
        reserved.iter().find_map(|res| match res.strip_prefix("contains:") {
            Some(word) => contains_reserved(n, word).then(|| format!("the name contains a reserved word ({word})")),
            None => collides(n, res).then(|| "the name looks like a reserved name".to_string()),
        })
    };
    // then the names. A campaign listed by the last pass keeps its place: a newcomer whose name looks like it is refused. Newcomers whose names
    // look like each other are ALL refused until the operator hides one: the record's own time is the host's word, so it cannot decide.
    let mut verdict: HashMap<String, Result<(), String>> = HashMap::new();
    let ok = |x: &Checked| x.approved && x.checked.is_ok();
    for x in seen.iter().filter(|x| ok(x) && before.contains(&x.r.campaign)) {
        let v = match x.name.as_deref().and_then(|n| reserved_hit(n)) { Some(e) => Err(e), None => Ok(()) };
        if v.is_ok() {
            if let Some(n) = &x.name { listed_names.push((n.clone(), x.r.campaign.clone())); }
        }
        verdict.insert(x.r.campaign.clone(), v);
    }
    let newcomers: Vec<&Checked> = seen.iter().filter(|x| ok(x) && !before.contains(&x.r.campaign)).collect();
    for x in &newcomers {
        let n = match &x.name { Some(n) => n, None => { verdict.insert(x.r.campaign.clone(), Ok(())); continue; } };
        let v = if let Some(e) = reserved_hit(n) { Err(e) }
            else if let Some((other, _)) = listed_names.iter().find(|(o, id)| id != &x.r.campaign && collides(n, o)) { Err(format!("the name looks like a campaign already listed ({other})")) }
            else if let Some(y) = newcomers.iter().find(|y| y.r.campaign != x.r.campaign && y.name.as_deref().is_some_and(|m| collides(n, m))) {
                Err(format!("the name looks like another campaign waiting to be listed ({}…, {}); hide one of them to list the other", &y.r.campaign[..8], y.name.as_deref().unwrap_or("")))
            } else { Ok(()) };
        verdict.insert(x.r.campaign.clone(), v);
    }
    for x in newcomers.iter().filter(|x| verdict.get(&x.r.campaign).is_some_and(|v| v.is_ok())) {
        if let Some(n) = &x.name { listed_names.push((n.clone(), x.r.campaign.clone())); }
    }
    // the recount, for what passed everything else: new campaigns of approved hosts first, then listed ones that are due, then the queue,
    // then the fixed entries (information only). It decides nothing about names, networks or approvals; those were decided above.
    #[allow(unused_mut)]
    let mut recounts: HashMap<String, RecountView> = HashMap::new();
    #[allow(unused_mut, unused_variables)]
    let mut recount_on = false;
    #[cfg(feature = "recount")]
    if let Some(setup) = &cfg.recount {
        use crate::recount::{Candidate, Kind};
        recount_on = true;
        let mut cache: BTreeMap<String, crate::recount::Cached> = fs::read(cfg.p("state/recount.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut cands = vec![];
        for x in &seen {
            let Ok(rules) = &x.checked else { continue };
            let names_ok = verdict.get(&x.r.campaign).is_none_or(|v| v.is_ok());
            let ever = seen_state.get(&x.r.campaign).is_some_and(|s| s.listed_at.is_some());
            let kind = if !x.approved {
                // a host nobody approved does not get the chain scanned for its mainnet campaigns (owner decision)
                if rules.network == "main" { continue }
                Kind::Queued
            } else if fixed.contains(&x.r.campaign) || !names_ok { continue } else if ever { Kind::Listed } else { Kind::New };
            cands.push(Candidate { id: x.r.campaign.clone(), relays: x.r.relays.clone(), kind, network: Some(rules.network.clone()), deadline: Some(rules.deadline_height) });
        }
        if let Some((_, v, _)) = &hand {
            for e in v["campaigns"].as_array().into_iter().flatten() {
                let id = e["id"].as_str().unwrap_or("").to_lowercase();
                let relays: Vec<String> = e["relays"].as_array().into_iter().flatten().filter_map(|r| r.as_str().map(|r| r.trim_end_matches('/').to_string())).collect();
                cands.push(Candidate { id, relays, kind: Kind::Fixed, network: None, deadline: None });
            }
        }
        crate::recount::run_due(setup, &cands, &mut cache, tips, &cfg.fetch, now);
        let keep: HashSet<&String> = cands.iter().map(|c| &c.id).collect();
        cache.retain(|id, _| keep.contains(id));
        for c in &cands {
            let Some(x) = cache.get(&c.id) else { continue };
            // "current": the recount ran over the ledger the relays show now (a head that cannot be read counts as not current)
            let current = crate::recount::heads(&c.relays, &c.id, &cfg.fetch).is_ok_and(|k| k == x.key);
            recounts.insert(c.id.clone(), RecountView {
                outcome: serde_json::to_value(&x.outcome).unwrap_or_default(), current, passes: x.outcome.passes(), flagged: x.flagged(),
                transient: x.outcome.transient, summary: x.outcome.summary(), attention_since: x.attention_since,
            });
        }
        write_atomic(&cfg.p("state/recount.json"), serde_json::to_string_pretty(&cache)?.as_bytes())?;
    }
    for s in status.iter_mut().filter(|s| s.state == State::Fixed) {
        if let Some(r) = recounts.get(&s.campaign) {
            s.recount = Some(r.outcome.clone());
            s.reason = format!("an entry of the hand kept list (read only; listed first, never removed); for information: {}", r.summary);
        }
    }
    for x in seen {
        let fp = x.r.host_fingerprint();
        let v: Result<(), String> = match &x.checked {
            Err(e) => Err(e.to_string()),
            Ok(_) => verdict.remove(&x.r.campaign).unwrap_or_else(|| match x.name.as_deref() {
                // not approved: the same name checks, for the operator's information
                Some(n) => match reserved_hit(n).or_else(|| listed_names.iter().find(|(o, id)| id != &x.r.campaign && collides(n, o)).map(|(o, _)| format!("the name looks like a campaign already listed ({o})"))) {
                    Some(e) => Err(e), None => Ok(()) },
                None => Ok(()),
            }),
        };
        let st = seen_state.entry(x.r.campaign.clone()).or_default();
        if !x.approved {
            let odd = x.name.as_deref().map(unusual_letters).unwrap_or_default();
            let since = st.queued_since.unwrap_or(now);
            let expires_at = since.saturating_add(cfg.queue_ttl);
            queue.push(QueueItem {
                fingerprint: fp.clone(), host_pubkey: x.r.host_pubkey.clone(), campaign: x.r.campaign.clone(), network: x.r.network.clone(), name: x.name.clone(),
                relays: x.r.relays.clone(), created: x.r.created, checks_pass: v.is_ok(),
                note: format!("{}{}{}",
                    v.as_ref().err().cloned().unwrap_or_else(|| "passes every check; waits for approval of the host key".into()),
                    if odd.is_empty() { String::new() } else { format!("; the name has letters outside plain Latin: {}", odd.join(", ")) },
                    match (recount_on, recounts.get(&x.r.campaign)) {
                        (true, Some(r)) => format!("; {}", r.summary),
                        (true, None) if x.r.network == "main" => "; a mainnet record is recounted only after its host is approved".into(),
                        (true, None) if v.is_ok() => "; its recount has not run yet".into(),
                        _ => String::new(),
                    }),
                queued_since: since, expires_at, kind: "approval".into(), recount: recounts.get(&x.r.campaign).map(|r| r.outcome.clone()), attention: None,
            });
            status.push(Status { campaign: x.r.campaign.clone(), host: fp, state: State::Queued, reason: "the host key is not approved yet".into(), name: x.name,
                recount: recounts.get(&x.r.campaign).map(|r| r.outcome.clone()), attention: None });
            continue;
        }
        let rc = recounts.get(&x.r.campaign);
        let rc_value = rc.map(|r| r.outcome.clone());
        // a new campaign is listed only once a recount over the ledger the relays show now passes; one listed before stays listed
        let v = match v {
            Ok(()) if recount_on && !fixed.contains(&x.r.campaign) && st.listed_at.is_none() => match rc {
                Some(r) if r.current && r.passes => Ok(()),
                Some(r) if r.current && !r.transient => Err(r.summary.clone()),
                Some(r) => {
                    status.push(Status { campaign: x.r.campaign.clone(), host: fp, state: State::Checking, name: x.name, recount: rc_value, attention: None,
                        reason: format!("every other check passed; waits for a recount over its current ledger ({}); tried again on the next pass", r.summary) });
                    continue;
                }
                None => {
                    status.push(Status { campaign: x.r.campaign.clone(), host: fp, state: State::Checking, name: x.name, recount: None, attention: None,
                        reason: "every other check passed; waits for its first recount (at most a few per pass, new campaigns first)".into() });
                    continue;
                }
            },
            other => other,
        };
        let attention = rc.filter(|r| r.flagged && st.listed_at.is_some()).map(|r| Attention { failing: r.summary.clone(), since: r.attention_since.unwrap_or(now) });
        match v {
            Ok(()) if fixed.contains(&x.r.campaign) => {
                st.listed_at.get_or_insert(now);
                status.push(Status { campaign: x.r.campaign.clone(), host: fp, state: State::Listed, reason: "every check passed; already listed as an entry of the hand kept list, so not repeated".into(), name: x.name, recount: rc_value, attention: None });
            }
            Ok(()) => {
                st.listed_at.get_or_insert(now);
                let closed = x.checked.as_ref().ok().map(|r| r.deadline_height).filter(|d| tips(&x.r.network).is_some_and(|t| *d <= t));
                listed.push((x.r.campaign.clone(), x.r.relays.clone(), x.r.host_pubkey.clone()));
                if let Some(a) = &attention {
                    queue.push(QueueItem {
                        fingerprint: fp.clone(), host_pubkey: x.r.host_pubkey.clone(), campaign: x.r.campaign.clone(), network: x.r.network.clone(), name: x.name.clone(),
                        relays: x.r.relays.clone(), created: x.r.created, checks_pass: false,
                        note: format!("ATTENTION: listed, but {} (since {}); it stays listed until you hide it", a.failing, a.since),
                        queued_since: a.since, expires_at: 0, kind: "attention".into(), recount: rc_value.clone(), attention: Some(a.clone()),
                    });
                }
                let mut reason = match closed {
                    Some(d) => format!("approved host; every check passed; its deadline (block {d}) has passed and it stays listed as a closed campaign"),
                    None => "approved host; every check passed".into(),
                };
                if let Some(a) = &attention {
                    reason = format!("{reason}; ATTENTION: {}", a.failing);
                } else if let Some(r) = rc {
                    reason = format!("{reason}; {}", r.summary);
                }
                status.push(Status { campaign: x.r.campaign.clone(), host: fp, state: State::Listed, name: x.name, reason, recount: rc_value, attention });
            }
            Err(e) => status.push(Status { campaign: x.r.campaign.clone(), host: fp, state: State::Refused, reason: e, name: x.name, recount: rc_value, attention: None }),
        }
    }
    // the label comes from approved_hosts.txt only (a record carries none); a host approved without one shows its fingerprint
    let entries: Vec<serde_json::Value> = listed.iter().map(|(id, relays, pk)| {
        let fp = fingerprint(pk);
        let label = labels.get(pk).filter(|l| !l.is_empty() && check_label(l).is_ok()).cloned().unwrap_or_else(|| format!("Host {fp}"));
        serde_json::json!({ "id": id, "relays": relays, "host": { "label": label, "fingerprint": fp } })
    }).collect();
    // with nothing listed here, the combined list is the hand kept list byte for byte; otherwise its entries first, then these
    let combined: Vec<u8> = match hand {
        Some((bytes, _, _)) if entries.is_empty() => bytes,
        Some((_, mut v, _)) => {
            v["campaigns"].as_array_mut().expect("checked when read").extend(entries);
            serde_json::to_string_pretty(&v)?.into_bytes()
        }
        None => serde_json::to_string_pretty(&serde_json::json!({ "campaigns": entries }))?.into_bytes(),
    };
    write_atomic(&cfg.p("state/seen.json"), serde_json::to_string_pretty(&seen_state)?.as_bytes())?;
    write_atomic(&cfg.p("out/campaigns.json"), &combined)?;
    write_atomic(&cfg.p("out/status.json"), serde_json::to_string_pretty(&status)?.as_bytes())?;
    write_atomic(&cfg.p("out/queue.json"), serde_json::to_string_pretty(&queue)?.as_bytes())?;
    Ok(status)
}

// ---------- operator commands ----------

/// Finds the full host key for a fingerprint (or takes a full key as it is), from the records here.
pub fn resolve_key(cfg: &JobConfig, key_or_fp: &str) -> Result<String> {
    let k = key_or_fp.trim().to_lowercase();
    if is_hex64(&k) {
        return Ok(k);
    }
    let want = k.replace(' ', "");
    let mut found: Vec<String> = load_records(cfg).into_iter().map(|r| r.host_pubkey).filter(|pk| fingerprint(pk).replace(' ', "") == want).collect();
    found.dedup();
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => bail!("no record here has a host key with that fingerprint"),
        _ => bail!("more than one key has that fingerprint; give the full key"),
    }
}

fn edit_list(path: &Path, key: &str, add: bool, note: &str) -> Result<bool> {
    let text = fs::read_to_string(path).unwrap_or_default();
    let present = read_list(path).contains(&key.to_string());
    if add == present {
        return Ok(false);
    }
    let new = if add {
        format!("{text}{}{key} {note}\n", if text.is_empty() || text.ends_with('\n') { "" } else { "\n" })
    } else {
        text.lines().filter(|l| l.split('#').next().unwrap_or("").split_whitespace().next().map(|w| w.to_lowercase()) != Some(key.to_string())).map(|l| format!("{l}\n")).collect()
    };
    write_atomic(path, new.as_bytes())?;
    Ok(true)
}

/// Two approved hosts may not have labels that look alike (the same rule as campaign names).
fn check_label_unique(cfg: &JobConfig, key: &str, label: &str) -> Result<()> {
    if let Some((other, l)) = read_labels(&cfg.p("approved_hosts.txt")).into_iter().find(|(k, l)| k != key && !l.is_empty() && collides(label, l)) {
        bail!("the label looks like the label of another approved host ({l:?}, {})", fingerprint(&other));
    }
    Ok(())
}

/// Approves a host key with the display label the operator chooses (shown as "Hosted by <label>" once a page shows it).
pub fn approve(cfg: &JobConfig, key_or_fp: &str, label: &str) -> Result<String> {
    let label = label.trim();
    check_label(label)?;
    let k = resolve_key(cfg, key_or_fp)?;
    check_label_unique(cfg, &k, label)?;
    edit_list(&cfg.p("revoked_hosts.txt"), &k, false, "")?;
    let changed = edit_list(&cfg.p("approved_hosts.txt"), &k, true, label)?;
    Ok(if changed { format!("approved host {} as {label:?}", fingerprint(&k)) } else { format!("host {} was already approved (use `label` to change its label)", fingerprint(&k)) })
}

/// Changes the label of an approved host.
pub fn set_label(cfg: &JobConfig, key_or_fp: &str, label: &str) -> Result<String> {
    let label = label.trim();
    check_label(label)?;
    let k = resolve_key(cfg, key_or_fp)?;
    let path = cfg.p("approved_hosts.txt");
    ensure!(read_list(&path).contains(&k), "host {} is not approved", fingerprint(&k));
    check_label_unique(cfg, &k, label)?;
    edit_list(&path, &k, false, "")?;
    edit_list(&path, &k, true, label)?;
    Ok(format!("host {} is now labelled {label:?}", fingerprint(&k)))
}

pub fn revoke(cfg: &JobConfig, key_or_fp: &str) -> Result<String> {
    let k = resolve_key(cfg, key_or_fp)?;
    edit_list(&cfg.p("approved_hosts.txt"), &k, false, "")?;
    edit_list(&cfg.p("revoked_hosts.txt"), &k, true, "# revoked")?;
    Ok(format!("revoked host {}: its campaigns disappear on the next pass (nothing is deleted from any relay)", fingerprint(&k)))
}

/// Hides a campaign id, or every campaign of a host (key or fingerprint).
pub fn hide(cfg: &JobConfig, what: &str, hide: bool) -> Result<String> {
    let w = what.trim().to_lowercase();
    let key = if is_hex64(&w) { w } else { resolve_key(cfg, &w)? };
    let changed = edit_list(&cfg.p("hidden.txt"), &key, hide, if hide { "# hidden" } else { "" })?;
    Ok(match (hide, changed) {
        (true, true) => format!("hidden: {}…", &key[..8]),
        (true, false) => format!("{}… was already hidden", &key[..8]),
        (false, true) => format!("no longer hidden: {}…", &key[..8]),
        (false, false) => format!("{}… was not hidden", &key[..8]),
    })
}

pub fn read_queue(cfg: &JobConfig) -> Result<Vec<serde_json::Value>> {
    let t = fs::read_to_string(cfg.p("out/queue.json")).context("no queue yet: run a pass first")?;
    Ok(serde_json::from_str(&t)?)
}

/// The summary a pass leaves, one line per record.
pub fn describe(status: &[Status]) -> String {
    let mut by: BTreeMap<String, usize> = BTreeMap::new();
    for s in status {
        *by.entry(format!("{:?}", s.state).to_lowercase()).or_default() += 1;
    }
    by.iter().map(|(k, v)| format!("{v} {k}")).collect::<Vec<_>>().join(", ")
}
