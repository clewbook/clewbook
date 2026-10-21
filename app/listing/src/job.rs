//! The listing job (PROTOTYPE). Everything lives in one data folder:
//!
//!   records/<campaign id>.json   submitted records whose two signatures verified (one per campaign; a newer one replaces an older one)
//!   approved_hosts.txt           host public keys (64 hex) allowed to be listed, one per line, then the display label; # starts a comment.
//!                                The label shown is only ever taken from here: `approve` writes the operator's --label, or without one
//!                                the name the host suggested in its signed record.
//!   revoked_hosts.txt            host keys whose campaigns must disappear (same form)
//!   hidden.txt                   campaign ids or host keys never to list (same form)
//!   reserved.txt                 names no campaign may look like; a line "contains:<word>" refuses any name with that word in it, and a line
//!                                "relay:<word>" refuses any relay address with that word in it (labels are never checked against this file)
//!   reserved-labels.txt          words no host may put in the name it suggests for itself (one per line, # starts a comment; case,
//!                                spaces, symbols and look alike letters do not matter). The operator's own --label is never checked here.
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
//! A mainnet record while mainnet listing is off (no `--network main`) is accepted and kept: it waits, marked as mainnet, until mainnet
//! listing opens. It is never listed, never recounted and never removed by time before then; its relays are read only for its name. Its
//! host may be approved meanwhile. At most `max_mainnet_waiting` such records are kept.
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
/// Whether a campaign name contains the built in reserved word (Clewbook, in any look alike spelling). Other reserved words live only in
/// the server's `reserved.txt` (`contains:<word>` for names, `relay:<word>` for relay addresses), never in the code.
pub fn reserved_word_in_name(name: &str) -> Option<&'static str> {
    contains_reserved(name, RESERVED_WORD).then_some(RESERVED_WORD)
}

/// The words relay addresses may not contain: the `relay:<word>` lines of reserved.txt, in their order (put a longer word first, so the
/// reason names it). Clewbook is not one of them: the project's own relay is relay.clewbook.xyz.
pub fn relay_words(cfg: &JobConfig) -> Vec<String> {
    read_lines(&cfg.p("reserved.txt")).iter().filter_map(|l| l.strip_prefix("relay:").map(|w| w.trim().to_string())).filter(|w| !w.is_empty()).collect()
}

/// Refuses relay addresses that contain one of `words`, in any case or look alike spelling.
pub fn check_relays(relays: &[String], words: &[String]) -> Result<()> {
    for r in relays {
        if let Some(w) = words.iter().find(|w| contains_reserved(r, w)) {
            bail!("a relay address contains a reserved word ({w}): {}", r.chars().take(80).collect::<String>());
        }
    }
    Ok(())
}
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
    /// At most this many mainnet records waiting for mainnet listing to open (they are never removed by time, so this caps them).
    pub max_mainnet_waiting: usize,
    /// Telegram notices for the operator (None: off). Used by the endpoint's passes only.
    pub notify: Option<crate::notify::NotifyConfig>,
    /// Mainnet only: the published NU7 activation height. A new mainnet campaign whose deadline is not before it is refused (its tickets
    /// would not survive the upgrade).
    pub nu7_mainnet_height: Option<u32>,
    /// Our relays on each network (network, url; a network may have several). A Blind bid auction is listed only if its record names one
    /// of ours: ours refuse entries added once the bids are about to open, so the recount sees a late added bid as relays that disagree (the
    /// second review, M2 and M3).
    pub our_relays: Vec<(String, String)>,
    /// The second review, M6: at most this many new records from one address while their hosts are not approved, per queue time.
    pub max_queue_per_source: usize,
    /// The recount check (None: no recount, as before; the command line always sets it).
    #[cfg(feature = "recount")]
    pub recount: Option<crate::recount::Setup>,
}

impl JobConfig {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        JobConfig {
            dir: dir.into(), allowed_networks: vec!["test".into()], fetch: FetchPolicy::default(), max_records_per_key: 10, max_records: 1000,
            max_queue: 200, hand_list: None, queue_ttl: 7 * 24 * 3600, max_mainnet_waiting: 100, notify: None, nu7_mainnet_height: None,
            // testnet: the test relay and, since 21 Oct 2026, the live relay (it runs the same build, which refuses late entries)
            our_relays: vec![("test".into(), "https://relay-test.clewbook.xyz".into()), ("test".into(), "https://relay.clewbook.xyz".into()),
                ("main".into(), "https://relay.clewbook.xyz".into())],
            max_queue_per_source: 5,
            #[cfg(feature = "recount")]
            recount: None,
        }
    }
    fn p(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
}

/// A mainnet record while mainnet listing is off here: kept, never listed, never recounted and never removed by time until it opens.
pub fn waits_for_mainnet(cfg: &JobConfig, network: &str) -> bool {
    network == "main" && !cfg.allowed_networks.iter().any(|n| n == "main")
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
/// characters, no < or >) and has no #. The operator may give any such label, reserved words included (the owner's decision of 21 Oct 2026).
pub fn check_label(label: &str) -> Result<()> {
    ensure!(!label.contains('#'), "a label may not contain #");
    ll_core::rules::check_name(label).map_err(|e| anyhow!("{}", e.to_string().replace("campaign name", "label")))?;
    Ok(())
}

/// The words of reserved-labels.txt, in their order.
pub fn reserved_label_words(cfg: &JobConfig) -> Vec<String> {
    read_lines(&cfg.p("reserved-labels.txt")).into_iter().map(|w| w.trim().to_string()).filter(|w| !w.is_empty()).collect()
}

/// The name a host suggests for itself: its form (as in the record), and none of the words of reserved-labels.txt, in any spelling.
pub fn check_suggested_label(cfg: &JobConfig, label: &str) -> Result<()> {
    crate::record::check_suggested_label_shape(label)?;
    if let Some(w) = reserved_label_words(cfg).iter().find(|w| contains_reserved(label, w)) {
        bail!("the suggested name contains a reserved word ({w}); choose another name, or leave it empty");
    }
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
    submit_from(cfg, bytes, None)
}

/// Our relays for `network` (none if none is configured).
pub fn our_relays<'a>(cfg: &'a JobConfig, network: &str) -> Vec<&'a str> {
    cfg.our_relays.iter().filter(|(n, _)| n == network).map(|(_, u)| u.trim_end_matches('/')).collect()
}

/// A submission from `source` (the client address the endpoint sees; `None` from the command line, which has no budget).
pub fn submit_from(cfg: &JobConfig, bytes: &[u8], source: Option<&str>) -> Result<String> {
    ensure!(bytes.len() <= MAX_RECORD_BYTES, "a listing record is at most {MAX_RECORD_BYTES} bytes");
    let r = ListingRecord::parse_and_verify(bytes)?;
    check_relays(&r.relays, &relay_words(cfg))?;
    if let Some(l) = &r.host_label {
        check_suggested_label(cfg, l)?;
    }
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
    let waits = waits_for_mainnet(cfg, &r.network);
    if existing.is_none() {
        ensure!(all.len() < cfg.max_records, "the listing is full");
        if waits {
            let waiting = all.iter().filter(|x| waits_for_mainnet(cfg, &x.network)).count();
            ensure!(waiting < cfg.max_mainnet_waiting, "the list of mainnet campaigns waiting for mainnet listing to open is full");
        } else {
            let approved = read_list(&cfg.p("approved_hosts.txt"));
            if !approved.contains(&r.host_pubkey) {
                let queued = all.iter().filter(|x| !approved.contains(&x.host_pubkey) && !waits_for_mainnet(cfg, &x.network)).count();
                ensure!(queued < cfg.max_queue, "the queue for hosts not approved yet is full");
                // the second review, M6: host keys cost nothing, so new records from hosts not approved are also counted per address
                if let Some(src) = source {
                    let now = crate::host::now_secs();
                    let path = cfg.p("state/sources.json");
                    let mut book: BTreeMap<String, Vec<u64>> = fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
                    book.retain(|_, v| { v.retain(|t| now < t.saturating_add(cfg.queue_ttl)); !v.is_empty() });
                    let mine = book.entry(src.to_string()).or_default();
                    ensure!(mine.len() < cfg.max_queue_per_source, "this address has sent {} requests from hosts not approved yet; try again after {}", cfg.max_queue_per_source, plain_duration(cfg.queue_ttl));
                    mine.push(now);
                    write_atomic(&path, &serde_json::to_vec(&book)?)?;
                }
            }
        }
    }
    write_atomic(&cfg.p(&format!("records/{}.json", r.campaign)), &serde_json::to_vec_pretty(&r)?)?;
    let note = if waits { "; mainnet listing is not open yet, so it is kept until it opens" } else { "" };
    Ok(format!("received: campaign {}…, host {}{note}", &r.campaign[..8], r.host_fingerprint()))
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
    /// A mainnet record while mainnet listing is off: kept until it opens, never listed or recounted before then, never removed by time.
    #[serde(rename = "waiting_mainnet")]
    WaitingMainnet,
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
    /// The name the host suggests for itself in this record, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_label: Option<String>,
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
    // records stored before a word was reserved are checked again here
    check_relays(&r.relays, &relay_words(cfg))?;
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
            // the second review, M2 and M3: a Blind bid auction is listed here only if it publishes to our relay, which refuses entries added
            // once the bids are about to open; read from ours too, a bid added late on another relay shows as relays that disagree
            if rules.is_sealed() {
                let ours = our_relays(cfg, &rules.network);
                ensure!(!ours.is_empty(), "no relay of ours is set for network {:?}", rules.network);
                ensure!(r.relays.iter().any(|u| ours.contains(&u.trim_end_matches('/'))),
                    "a Blind bid auction is listed here only if it publishes to {}, which refuse{} late entries; this one does not",
                    ours.join(" or "), if ours.len() == 1 { "s" } else { "" });
            }
            // as cb-host's guard (app/host/src/mainnet.rs): the campaign's whole life (deadline, ticket window, close grace, re-issue window)
            // and a margin of 50 blocks must end before the NU7 activation; its refund tickets would not survive the upgrade
            if let (true, "main", Some(nu7)) = (require_open, rules.network.as_str(), cfg.nu7_mainnet_height) {
                // a sealed bid auction lives until its late tickets are done (the review, L7: from the late ticket block)
                let end = match rules.sealed.as_ref() {
                    Some(s) => ll_core::sealed::life_end(&rules, s),
                    None => rules.deadline_height.saturating_add(rules.ticket_k).saturating_add(rules.close_grace).saturating_add(rules.reissue_window).saturating_add(50),
                };
                ensure!(tip < nu7 && end < nu7, "the campaign could still be running at the NU7 upgrade (block {nu7}; it runs until about block {end}): its refund tickets would not survive it");
            }
            Ok(rules)
        }
        Some(_) => bail!("not every relay serves this campaign ({})", errors.join("; ")),
        None => bail!("{}", errors.join("; ")),
    }
}

/// A waiting mainnet record: its relays' rules must match it (id, ledger key, network), for its name and the name checks. No chain height
/// is read and no deadline is checked: nothing about it is decided until mainnet listing opens.
fn check_waiting(r: &ListingRecord, cfg: &JobConfig) -> Result<ll_core::rules::Rules> {
    check_relays(&r.relays, &relay_words(cfg))?;
    let main = ["main".to_string()];
    let (mut first, mut errors) = (None, vec![]);
    for relay in &r.relays {
        match get_text(&format!("{relay}/v1/campaigns/{}", r.campaign), &cfg.fetch).and_then(|t| r.check_against_rules(&t, 0, &main, false)) {
            Ok(rules) => { first.get_or_insert(rules); }
            Err(e) => errors.push(format!("{}: {e}", host_of(relay))),
        }
    }
    match first {
        Some(rules) if errors.is_empty() => Ok(rules),
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
    let mut waiting: Vec<(ListingRecord, bool, Result<ll_core::rules::Rules>)> = vec![];
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
        if waits_for_mainnet(cfg, &r.network) {
            // its queue time starts only once mainnet listing opens
            st.queued_since = None;
            let checked = check_waiting(&r, cfg);
            waiting.push((r, is_approved, checked));
            continue;
        }
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
        if let Some(w) = reserved_word_in_name(n) {
            return Some(format!("the name contains a reserved word ({w})"));
        }
        reserved.iter().filter(|res| !res.starts_with("relay:")).find_map(|res| match res.strip_prefix("contains:") {
            Some(word) => contains_reserved(n, word.trim()).then(|| format!("the name contains a reserved word ({})", word.trim())),
            None => collides(n, res).then(|| "the name looks like a reserved name".to_string()),
        })
    };
    // mainnet records while mainnet listing is off: shown in the queue and the status, never listed, never recounted
    for (r, is_approved, checked) in waiting {
        let fp = r.host_fingerprint();
        let name = checked.as_ref().ok().and_then(|x| x.name.clone());
        let problem = match &checked { Err(e) => Some(e.to_string()), Ok(_) => name.as_deref().and_then(|n| reserved_hit(n)) };
        let note = format!("mainnet listing is not open yet; {}; host key {}",
            match &problem { Some(p) => format!("as it stands it would be refused when it opens: {p}"), None => "kept until it opens, never listed or recounted before then".into() },
            if is_approved { "approved" } else { "not approved yet" });
        let since = seen_state.get(&r.campaign).map(|s| s.first_seen).unwrap_or(now);
        queue.push(QueueItem {
            fingerprint: fp.clone(), host_pubkey: r.host_pubkey.clone(), campaign: r.campaign.clone(), network: r.network.clone(), name: name.clone(),
            relays: r.relays.clone(), created: r.created, checks_pass: problem.is_none(), note: note.clone(),
            queued_since: since, expires_at: 0, kind: "mainnet".into(), suggested_label: r.host_label.clone(), recount: None, attention: None,
        });
        status.push(Status { campaign: r.campaign.clone(), host: fp, state: State::WaitingMainnet, reason: note, name, recount: None, attention: None });
    }
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
                queued_since: since, expires_at, kind: "approval".into(), suggested_label: x.r.host_label.clone(), recount: recounts.get(&x.r.campaign).map(|r| r.outcome.clone()), attention: None,
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
                        queued_since: a.since, expires_at: 0, kind: "attention".into(), suggested_label: x.r.host_label.clone(), recount: rc_value.clone(), attention: Some(a.clone()),
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

/// Approves a host key with a display label (shown as "Hosted by <label>" once a page shows it): the operator's `label`, or without one the
/// name the host suggested in its newest record (checked again against reserved-labels.txt, which may have changed since).
pub fn approve(cfg: &JobConfig, key_or_fp: &str, label: Option<&str>) -> Result<String> {
    let k = resolve_key(cfg, key_or_fp)?;
    let suggested;
    let from_host = label.is_none();
    let label = match label {
        Some(l) => l.trim(),
        None => {
            suggested = load_records(cfg).into_iter().filter(|r| r.host_pubkey == k && r.host_label.is_some()).max_by_key(|r| r.created).and_then(|r| r.host_label)
                .ok_or_else(|| anyhow!("host {} suggested no name: give one with --label", fingerprint(&k)))?;
            check_suggested_label(cfg, &suggested)?;
            suggested.as_str()
        }
    };
    check_label(label)?;
    check_label_unique(cfg, &k, label)?;
    edit_list(&cfg.p("revoked_hosts.txt"), &k, false, "")?;
    let changed = edit_list(&cfg.p("approved_hosts.txt"), &k, true, label)?;
    Ok(if changed { format!("approved host {} as {label:?}{}", fingerprint(&k), if from_host { " (the name the host suggested)" } else { "" }) } else { format!("host {} was already approved (use `label` to change its label)", fingerprint(&k)) })
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

/// What anyone may learn about the request for one campaign (`GET /v1/records/<campaign id>`): a plain state and a plain reason from the
/// last pass, nothing else (no host key, no label, no recount details). States: "Waiting", "Listed", "Not listed", "Waiting for mainnet
/// listing to open". None: no request for this campaign here.
pub fn record_status(cfg: &JobConfig, campaign: &str) -> Option<(&'static str, String)> {
    let id = campaign.to_lowercase();
    if !is_hex64(&id) {
        return None;
    }
    let has_record = cfg.p(&format!("records/{id}.json")).exists();
    let last = fs::read(cfg.p("out/status.json")).ok().and_then(|b| serde_json::from_slice::<Vec<serde_json::Value>>(&b).ok()).unwrap_or_default()
        .into_iter().find(|s| s["campaign"] == id.as_str());
    let received = || ("Waiting", "received; it is checked on the next pass (every 10 minutes)".to_string());
    let Some(s) = last else { return has_record.then(received) };
    let reason = s["reason"].as_str().unwrap_or("").to_string();
    Some(match s["state"].as_str().unwrap_or("") {
        "listed" | "fixed" => ("Listed", "shown on the home page".into()),
        "queued" => ("Waiting", "waiting for the Clewbook team to approve the host key".into()),
        "checking" => ("Waiting", "every other check passed; waiting for its first recount".into()),
        "waiting_mainnet" => ("Waiting for mainnet listing to open", "mainnet campaigns are listed once mainnet listing opens after the next network upgrade; the request is kept until then".into()),
        // a request sent again after it expired waits again
        "expired" if has_record => received(),
        "expired" => ("Not listed", reason),
        "hidden" => ("Not listed", "this campaign is not listed here".into()),
        "revoked" => ("Not listed", "this host key was revoked".into()),
        "refused" => ("Not listed", reason),
        _ => received(),
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
        *by.entry(serde_json::to_value(&s.state).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default().replace('_', " ")).or_default() += 1;
    }
    by.iter().map(|(k, v)| format!("{v} {k}")).collect::<Vec<_>>().join(", ")
}
