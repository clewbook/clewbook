//! The recount check before listing (PROTOTYPE, no payments): in-process relays holding invented campaigns, and a stand in for the chain
//! that hands invented notes to the same `ll_core::recount` the browser module runs (the real chain path is measured against public servers,
//! not here). Each test breaks one thing and checks what the job does with it.

use ll_core::keys::{CampaignSecrets, ContributorKeys};
use ll_core::ledger::{Close, Contribution, Entry, GENESIS_PREV, Ticket};
use ll_core::payload::Payload;
use ll_core::recount::{ChainNote, Spend};
use ll_listing::chain::{Chain, FullRequest, ScanStats};
use ll_listing::host;
use ll_listing::job::{self, JobConfig, State};
use ll_listing::recount::{Limits, Setup};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const UFVK: &str = "uvftest1example";
const NOW: u64 = 1_800_000_000;

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ll-listing-recount-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The chain, as far as these tests need it: the notes each campaign's viewing key would find, given to the core recount.
#[derive(Default)]
struct FakeChain {
    notes: Mutex<HashMap<String, Vec<ChainNote>>>,
    delay: Duration,
    calls: AtomicUsize,
}

impl Chain for FakeChain {
    fn tip(&self, _: &str) -> anyhow::Result<u32> {
        anyhow::bail!("the job takes its heights from the pass")
    }
    fn full_report(&self, req: &FullRequest, deadline: Instant) -> anyhow::Result<(serde_json::Value, ScanStats)> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let until = Instant::now() + self.delay;
        while Instant::now() < until {
            anyhow::ensure!(Instant::now() < deadline, "the recount took longer than its time limit (scanning)");
            std::thread::sleep(Duration::from_millis(20));
        }
        let rules: ll_core::rules::Rules = serde_json::from_str(&req.rules_json)?;
        let ledger: Vec<Entry> = serde_json::from_str(&req.ledger_json)?;
        let notes = self.notes.lock().unwrap().get(&req.rules_id).cloned().unwrap_or_default();
        let r = ll_core::recount::recount(&rules, &req.rules_id, &ledger, &notes, &[], req.end, true);
        let report = serde_json::json!({
            "all_pass": r.all_pass(),
            "rules": r.results.iter().map(|x| serde_json::json!({"id": x.id, "title": x.title, "pass": x.pass, "details": x.details})).collect::<Vec<_>>(),
        });
        Ok((report, ScanStats { blocks: req.end - req.start + 1, ..Default::default() }))
    }
}

/// A valid refund receiver (a wallet could pay it).
fn receiver() -> [u8; 43] {
    let sk: orchard::keys::SpendingKey = Option::from(orchard::keys::SpendingKey::from_bytes([7; 32])).unwrap();
    orchard::keys::FullViewingKey::from(&sk).address_at(0u32, orchard::keys::Scope::External).to_raw_address_bytes()
}

/// An invented testnet campaign (goal 0.02 ZEC, blocks 100 to 200, K = 30), its relay, its folder for the host, and helpers.
struct Camp {
    id: String,
    rules: String,
    secrets: CampaignSecrets,
    dir: PathBuf,
}

impl Camp {
    fn new(root: &Path, name: &str, auction: bool) -> Camp {
        Camp::on(root, name, auction, "test")
    }

    fn on(root: &Path, name: &str, auction: bool, network: &str) -> Camp {
        let secrets = CampaignSecrets::generate();
        let mut rules = serde_json::json!({"v":1,"network":network,"mode": if auction { "auction" } else { "raise" },"start_height":100,"deadline_height":200,
            "ticket_k":30,"close_grace":10,"reissue_window":20,"refund_fee_zat":10000,"min_contribution_zat":20000,
            "ledger_pubkey":secrets.ledger_pubkey_hex().unwrap(),"payload_pubkey":secrets.payload_pubkey_hex().unwrap(),"name":name});
        if auction {
            rules["items"] = 1.into();
            rules["ufvk_hash"] = ll_core::rules::ufvk_hash(UFVK).into();
        } else {
            rules["goal_zat"] = 2_000_000.into();
            rules["campaign_ufvk"] = UFVK.into();
        }
        let rules = rules.to_string();
        let r: ll_core::rules::Rules = serde_json::from_str(&rules).unwrap();
        let id = hex::encode(r.id().unwrap());
        let dir = root.join("campaigns").join(&id[..8]);
        std::fs::create_dir_all(dir.join("private")).unwrap();
        std::fs::write(dir.join("rules.json"), &rules).unwrap();
        std::fs::write(dir.join("secrets.json"), serde_json::to_vec(&secrets).unwrap()).unwrap();
        Camp { id, rules, secrets, dir }
    }

    fn register(&self, relay: &str) {
        ureq::put(&format!("{relay}/v1/campaigns/{}", self.id)).send_string(&self.rules).unwrap();
        let mut rel = std::fs::read_to_string(self.dir.join("private/relays")).unwrap_or_default();
        rel.push_str(&format!("{relay}\n"));
        std::fs::write(self.dir.join("private/relays"), rel).unwrap();
    }

    /// A contribution as the chain shows it: a real payload memo for this campaign.
    fn note(&self, i: u8, value: u64, height: u32) -> ChainNote {
        let memo = Payload { rules_id: ll_core::hex32(&self.id).unwrap(), sign_pubkey: [0; 32], enc_pubkey: [0; 32], refund_typecode: 3, refund_receiver: receiver(), amount_zat: None }
            .to_memo(&ll_core::hex32(&serde_json::from_str::<serde_json::Value>(&self.rules).unwrap()["payload_pubkey"].as_str().unwrap().to_string()).unwrap(), &ContributorKeys { seed: [i; 32] }.memo_ephemeral_key())
            .unwrap();
        ChainNote { txid: hex::encode([i; 32]), action: 0, value_zat: value, nf: Some(hex::encode([i + 100; 32])), height: Some(height), tx_index: None,
            memo_text: Some(memo), is_change: false, spent_by: None }
    }

    fn issue(&self, n: &ChainNote, issue_height: u32) -> Entry {
        let mut e = Entry::new(&self.id, "issue");
        e.contribution = Some(Contribution { txid: n.txid.clone(), action: n.action, nf: n.nf.clone().unwrap(), height: n.height.unwrap(), value_zat: Some(n.value_zat), amount_commit: None });
        e.ticket = Some(Ticket { txid: format!("ticket-{}", n.txid), issue_height, branch_id: "77190ad9".into() });
        e.blob_hash = Some("ab".repeat(32)); // the relay wants the sealed ticket's hash; the recount does not read the ticket itself
        e
    }

    fn close(&self, outcome: &str) -> Entry {
        let mut e = Entry::new(&self.id, "close");
        e.close = Some(Close { close_height: 205, outcome: outcome.into(), winners: None, ufvk: None, amount_key: None, clearing_price_zat: None, drand_signature: None });
        e
    }

    /// Signs and chains entries as the host does, starting after `before` entries.
    fn chain(&self, before: &[Entry], entries: Vec<Entry>) -> Vec<Entry> {
        let sk = self.secrets.ledger_key().unwrap();
        let mut out: Vec<Entry> = before.to_vec();
        for mut e in entries {
            e.seq = out.len() as u64;
            e.prev = out.last().map_or(GENESIS_PREV.into(), |p| p.hash().unwrap());
            e.sign(&sk).unwrap();
            out.push(e);
        }
        out[before.len()..].to_vec()
    }

    /// Publishes entries the way a host does (the relay checks each one).
    fn publish(&self, relay: &str, entries: &[Entry]) {
        for e in entries {
            ureq::put(&format!("{relay}/v1/campaigns/{}/ledger/{}", self.id, e.seq)).send_string(&ll_core::canon::to_canonical(e).unwrap()).unwrap();
        }
    }

    /// Writes an entry straight into a relay's folder, past its checks (a damaged or dishonest relay).
    fn plant(&self, relay_dir: &Path, e: &Entry) {
        std::fs::write(relay_dir.join("campaigns").join(&self.id).join("ledger").join(format!("{:06}.json", e.seq)), ll_core::canon::to_canonical(e).unwrap()).unwrap();
    }
}

struct World {
    root: PathBuf,
    relay: String,
    relay_dir: PathBuf,
    chain: Arc<FakeChain>,
    cfg: JobConfig,
    runs: PathBuf,
    host_key: String,
    _server: Arc<tiny_http::Server>,
}

fn world(name: &str, delay: Duration, wall: Duration) -> World {
    let root = scratch(name);
    let relay_dir = root.join("relay");
    let (server, relay) = ll_relay::spawn(&relay_dir, "127.0.0.1:0").unwrap();
    let chain = Arc::new(FakeChain { delay, ..Default::default() });
    let mut cfg = JobConfig::new(root.join("listing"));
    cfg.fetch.test_allow_loopback = true;
    cfg.fetch.connect_timeout = Duration::from_secs(1);
    cfg.fetch.total_timeout = Duration::from_secs(2);
    cfg.recount = Some(Setup { chain: chain.clone(), limits: Limits { wall, max_blocks: 1_000, per_pass: 10, ..Default::default() } });
    let runs = root.join("host");
    let host_key = host::init_key(&runs).unwrap();
    World { root, relay, relay_dir, chain, cfg, runs, host_key, _server: server }
}

impl World {
    fn submit(&self, c: &Camp) {
        let rec = host::record_for(&self.runs, &c.dir, vec![], host::now_secs()).unwrap();
        job::submit(&self.cfg, &serde_json::to_vec(&rec).unwrap()).unwrap();
    }
    fn approve(&self) {
        job::approve(&self.cfg, &self.host_key, Some("Test Collective")).unwrap();
    }
    fn pass(&self, tip: u32, now: u64) -> Vec<job::Status> {
        job::run_pass_at(&self.cfg, tip, now).unwrap()
    }
    fn listed(&self) -> Vec<String> {
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(self.cfg.dir.join("out/campaigns.json")).unwrap()).unwrap();
        v["campaigns"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect()
    }
    fn notes(&self, c: &Camp, notes: Vec<ChainNote>) {
        self.chain.notes.lock().unwrap().insert(c.id.clone(), notes);
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn own<'a>(st: &'a [job::Status], id: &str) -> &'a job::Status {
    st.iter().find(|s| s.campaign == id && s.state != State::Fixed).unwrap_or_else(|| panic!("no status for {id}"))
}

fn failed_ids(s: &job::Status) -> Vec<String> {
    s.recount.as_ref().and_then(|r| r["failed"].as_array().cloned()).unwrap_or_default().iter().map(|f| f["id"].as_str().unwrap().to_string()).collect()
}

fn honest(w: &World, name: &str) -> (Camp, ChainNote, Vec<Entry>) {
    let c = Camp::new(&w.root, name, false);
    c.register(&w.relay);
    let a = c.note(1, 1_000_000, 110);
    let l = c.chain(&[], vec![c.issue(&a, 111)]);
    c.publish(&w.relay, &l);
    w.notes(&c, vec![a.clone()]);
    (c, a, l)
}

#[test]
fn a_clean_campaign_passes_its_recount_and_is_listed() {
    let w = world("clean", Duration::ZERO, Duration::from_secs(5));
    let (c, _, _) = honest(&w, "Clean Garden");
    w.submit(&c);
    // before approval: queued, and the queue shows its recount for the operator
    let st = w.pass(150, NOW);
    assert_eq!(own(&st, &c.id).state, State::Queued);
    let q = job::read_queue(&w.cfg).unwrap();
    assert!(q[0]["note"].as_str().unwrap().contains("the recount passes (full"), "{}", q[0]["note"]);
    w.approve();
    let st = w.pass(150, NOW + 60);
    let s = own(&st, &c.id);
    assert_eq!(s.state, State::Listed, "{s:?}");
    let r = s.recount.as_ref().unwrap();
    assert_eq!(r["tip"], 150);
    assert_eq!(r["scope"], "full");
    assert!(r["at"].as_u64().unwrap() > 0);
    for id in ["R1", "R2", "R3", "R4", "R4b", "R5", "R6", "R7", "R8"] {
        assert!(r["passed"].as_array().unwrap().iter().any(|x| x == id), "{id} in {r}");
    }
    assert!(r["failed"].as_array().unwrap().is_empty());
    assert_eq!(w.listed(), vec![c.id.clone()]);
    // nothing about the recount reaches the home page's list
    let out: serde_json::Value = serde_json::from_slice(&std::fs::read(w.cfg.dir.join("out/campaigns.json")).unwrap()).unwrap();
    let keys: Vec<&String> = out["campaigns"][0].as_object().unwrap().keys().collect();
    assert_eq!(keys, vec!["host", "id", "relays"]);
    // the cache: nothing moved, so the next pass does not recount; a new entry on the ledger does
    let calls = w.chain.calls.load(Ordering::SeqCst);
    w.pass(151, NOW + 120);
    assert_eq!(w.chain.calls.load(Ordering::SeqCst), calls, "nothing moved, nothing recounted");
    let b = c.note(2, 500_000, 140);
    let more = c.chain(&serde_json::from_str::<Vec<Entry>>(&ureq::get(&format!("{}/v1/campaigns/{}/ledger?from=0", w.relay, c.id)).call().unwrap().into_string().unwrap()).unwrap(), vec![c.issue(&b, 141)]);
    c.publish(&w.relay, &more);
    w.notes(&c, vec![c.note(1, 1_000_000, 110), b]);
    w.pass(152, NOW + 180);
    assert_eq!(w.chain.calls.load(Ordering::SeqCst), calls + 1, "the ledger moved, so it was recounted");
    // a listed campaign is recounted again after the recheck time even if nothing moved (an ignored payment does not move the ledger)
    w.pass(153, NOW + 180 + 6 * 3600);
    assert_eq!(w.chain.calls.load(Ordering::SeqCst), calls + 2);
}

#[test]
fn a_tampered_or_forged_entry_and_a_broken_entry_chain_keep_a_campaign_off_the_list() {
    let w = world("tampered", Duration::ZERO, Duration::from_secs(5));
    w.approve();
    // edited after signing
    let (c1, _, l1) = honest(&w, "Tampered One");
    let mut bad = l1[0].clone();
    bad.contribution.as_mut().unwrap().value_zat = Some(5_000_000);
    c1.plant(&w.relay_dir, &bad);
    // signed by a key that is not the campaign's
    let (c2, a2, _) = honest(&w, "Forged Two");
    let mut forged = c2.issue(&a2, 111);
    forged.seq = 0;
    forged.prev = GENESIS_PREV.into();
    forged.sign(&CampaignSecrets::generate().ledger_key().unwrap()).unwrap();
    c2.plant(&w.relay_dir, &forged);
    // a valid signature, but the entry does not point at the one before it
    let (c3, _, _) = honest(&w, "Chain Three");
    let b3 = c3.note(2, 500_000, 120);
    let mut skip = c3.issue(&b3, 121);
    skip.seq = 1;
    skip.prev = "11".repeat(32);
    skip.sign(&c3.secrets.ledger_key().unwrap()).unwrap();
    c3.plant(&w.relay_dir, &skip);
    for c in [&c1, &c2, &c3] {
        w.submit(c);
    }
    let st = w.pass(150, NOW);
    for c in [&c1, &c2, &c3] {
        let s = own(&st, &c.id);
        assert!(s.state == State::Refused && s.reason.contains("intact, signed ledger"), "{s:?}");
    }
    assert!(w.listed().is_empty());
}

#[test]
fn a_late_ticket_a_missing_ticket_and_a_relay_that_disagrees_are_refused() {
    let w = world("r4", Duration::ZERO, Duration::from_secs(5));
    w.approve();
    // R4b: the ticket was issued 40 blocks after the payment (K = 30)
    let late = Camp::new(&w.root, "Late Ticket", false);
    late.register(&w.relay);
    let a = late.note(1, 1_000_000, 110);
    late.publish(&w.relay, &late.chain(&[], vec![late.issue(&a, 150)]));
    w.notes(&late, vec![a]);
    // R4: a payment on the chain with no ticket at all, more than K blocks ago
    let missing = Camp::new(&w.root, "Missing Ticket", false);
    missing.register(&w.relay);
    w.notes(&missing, vec![missing.note(1, 1_000_000, 110)]);
    // two relays: the second is one entry behind
    let (_s2, relay2) = ll_relay::spawn(&w.root.join("relay2"), "127.0.0.1:0").unwrap();
    let (split, _, l) = honest(&w, "Split Relays");
    split.register(&relay2);
    let b = split.note(2, 500_000, 120);
    let second = split.chain(&l, vec![split.issue(&b, 121)]);
    split.publish(&w.relay, &second);
    split.publish(&relay2, &l);
    for c in [&late, &missing, &split] {
        w.submit(c);
    }
    let st = w.pass(150, NOW);
    let s = own(&st, &late.id);
    assert!(s.state == State::Refused && failed_ids(s) == vec!["R4b"], "{s:?}");
    assert!(s.reason.contains("the recount fails R4b"), "{}", s.reason);
    let s = own(&st, &missing.id);
    assert!(s.state == State::Refused && failed_ids(s) == vec!["R4"], "{s:?}");
    let s = own(&st, &split.id);
    assert!(s.state == State::Refused && s.reason.contains("do not show the same ledger"), "{s:?}");
    assert!(w.listed().is_empty());
}

#[test]
fn a_listed_campaign_that_later_fails_is_flagged_not_removed() {
    let w = world("attention", Duration::ZERO, Duration::from_secs(5));
    w.approve();
    let (c, a, l) = honest(&w, "Later Wrong");
    w.submit(&c);
    let st = w.pass(150, NOW);
    assert_eq!(own(&st, &c.id).state, State::Listed);
    // the close: the goal (0.02 ZEC) was missed, but the host says "goal met" and sweeps the money: R6 and R7 fail
    let close = c.chain(&l, vec![c.close("goal_met")]);
    c.publish(&w.relay, &close);
    let mut swept = a.clone();
    swept.spent_by = Some(Spend { txid: "sweep".into(), height: Some(206) });
    w.notes(&c, vec![swept]);
    let st = w.pass(210, NOW + 600);
    let s = own(&st, &c.id);
    assert_eq!(s.state, State::Listed, "it stays listed");
    assert_eq!(failed_ids(s), vec!["R6", "R7"]);
    let att = s.attention.as_ref().expect("flagged");
    assert_eq!(att.since, NOW + 600);
    assert!(s.reason.contains("ATTENTION") && att.failing.contains("R6"), "{}", s.reason);
    assert!(w.listed().contains(&c.id));
    let q = job::read_queue(&w.cfg).unwrap();
    let item = q.iter().find(|i| i["kind"] == "attention").expect("in the queue output");
    assert_eq!(item["campaign"], c.id.as_str());
    assert_eq!(item["attention"]["since"], NOW + 600);
    // later passes keep the first time it failed; the operator decides: hiding takes it off
    let st = w.pass(211, NOW + 1200);
    assert_eq!(own(&st, &c.id).attention.as_ref().unwrap().since, NOW + 600);
    job::hide(&w.cfg, &c.id, true).unwrap();
    w.pass(212, NOW + 1800);
    assert!(!w.listed().contains(&c.id));
}

#[test]
fn a_recount_over_its_time_limit_gives_no_listing() {
    let w = world("slow", Duration::from_secs(3), Duration::from_millis(500));
    w.approve();
    let (c, _, _) = honest(&w, "Slow Chain");
    w.submit(&c);
    let t0 = Instant::now();
    let st = w.pass(150, NOW);
    assert!(t0.elapsed() < Duration::from_secs(3), "the pass did not wait for the slow scan ({:?})", t0.elapsed());
    let s = own(&st, &c.id);
    assert!(s.state == State::Refused && s.reason.contains("time limit"), "{s:?}");
    assert!(w.listed().is_empty());
}

#[test]
fn a_sealed_auction_runs_only_the_checks_that_can_run_and_new_records_go_first() {
    let w = world("sealed", Duration::ZERO, Duration::from_secs(5));
    w.approve();
    let auction = Camp::new(&w.root, "Sealed Auction", true);
    auction.register(&w.relay);
    w.submit(&auction);
    let st = w.pass(150, NOW);
    let s = own(&st, &auction.id);
    assert_eq!(s.state, State::Listed, "{s:?}");
    let r = s.recount.as_ref().unwrap();
    assert_eq!(r["scope"], "sealed");
    assert_eq!(r["passed"], serde_json::json!(["R1", "R2"]));
    assert!(r["waiting"].as_array().unwrap().iter().any(|x| x == "R4"));
    assert_eq!(w.chain.calls.load(Ordering::SeqCst), 0, "a sealed auction is not scanned");
    // at the close the key is revealed: the close state moved, so the next pass runs the full recount
    let close = auction.chain(&[], vec![{
        let mut e = auction.close("auction");
        e.close.as_mut().unwrap().ufvk = Some(UFVK.into());
        e.close.as_mut().unwrap().winners = Some(vec![]);
        e.close.as_mut().unwrap().amount_key = Some("00".repeat(32));
        e
    }]);
    auction.publish(&w.relay, &close);
    let st = w.pass(210, NOW + 30);
    let r = own(&st, &auction.id).recount.clone().unwrap();
    assert_eq!(r["scope"], "full", "{r}");
    assert_eq!(w.chain.calls.load(Ordering::SeqCst), 1, "scanned once the key is known");
    // the per pass limit: with room for one recount, a new record waits for the next pass ("checking"), then is listed
    let mut one = w.cfg.clone();
    if let Some(s) = one.recount.as_mut() { s.limits.per_pass = 1; }
    let (x, _, _) = honest(&w, "First Newcomer");
    let (y, _, _) = honest(&w, "Second Newcomer");
    w.submit(&x);
    w.submit(&y);
    let st = job::run_pass_at(&one, 150, NOW + 60).unwrap();
    let states: Vec<State> = [&x, &y].iter().map(|c| own(&st, &c.id).state.clone()).collect();
    assert!(states.contains(&State::Listed) && states.contains(&State::Checking), "{states:?}");
    let st = job::run_pass_at(&one, 150, NOW + 120).unwrap();
    assert!([&x, &y].iter().all(|c| own(&st, &c.id).state == State::Listed));
}

#[test]
fn fixed_entries_show_their_recount_and_are_never_removed() {
    let w = world("fixed", Duration::ZERO, Duration::from_secs(5));
    let bad = Camp::new(&w.root, "Hand Kept", false);
    bad.register(&w.relay);
    w.notes(&bad, vec![bad.note(1, 1_000_000, 110)]); // a missing ticket: R4 fails
    let hand = w.root.join("hand.json");
    let text = format!("{{\"campaigns\":[{{\"id\":\"{}\",\"relays\":[\"{}\"]}}]}}", bad.id, w.relay);
    std::fs::write(&hand, &text).unwrap();
    let mut cfg = w.cfg.clone();
    cfg.hand_list = Some(hand);
    let st = job::run_pass_at(&cfg, 150, NOW).unwrap();
    let s = st.iter().find(|s| s.campaign == bad.id).unwrap();
    assert_eq!(s.state, State::Fixed);
    assert_eq!(failed_ids(s), vec!["R4"]);
    assert!(s.reason.contains("for information: the recount fails R4"), "{}", s.reason);
    assert_eq!(std::fs::read(cfg.dir.join("out/campaigns.json")).unwrap(), text.as_bytes(), "still listed, exactly as written");
    // a fixed entry is recounted again after 24 hours, not after 6 (a submitted campaign's recheck)
    let calls = w.chain.calls.load(Ordering::SeqCst);
    job::run_pass_at(&cfg, 151, NOW + 7 * 3600).unwrap();
    assert_eq!(w.chain.calls.load(Ordering::SeqCst), calls, "not after 7 hours");
    job::run_pass_at(&cfg, 152, NOW + 24 * 3600).unwrap();
    assert_eq!(w.chain.calls.load(Ordering::SeqCst), calls + 1, "after 24 hours");
}

#[test]
fn mainnet_needs_its_own_allowance_and_a_close_before_nu7() {
    let w = world("mainnet", Duration::ZERO, Duration::from_secs(5));
    w.approve();
    let m = Camp::on(&w.root, "Main Garden", false, "main");
    m.register(&w.relay);
    w.submit(&m);
    // kept waiting, never recounted, while only testnet is listed (the default)
    let st = w.pass(150, NOW);
    assert_eq!(own(&st, &m.id).state, State::WaitingMainnet, "{:?}", own(&st, &m.id));
    assert!(own(&st, &m.id).recount.is_none() && w.chain.calls.load(Ordering::SeqCst) == 0, "no scan while mainnet listing is off");
    // a queued mainnet record (host not approved) is never recounted, even with mainnet allowed
    let mut queued = w.cfg.clone();
    queued.allowed_networks = vec!["test".into(), "main".into()];
    queued.nu7_mainnet_height = Some(400);
    std::fs::remove_file(w.cfg.dir.join("approved_hosts.txt")).unwrap();
    let st = job::run_pass_at(&queued, 150, NOW + 30).unwrap();
    assert_eq!(own(&st, &m.id).state, State::Queued);
    assert!(own(&st, &m.id).recount.is_none() && w.chain.calls.load(Ordering::SeqCst) == 0, "no scan for a queued mainnet record");
    assert!(job::read_queue(&w.cfg).unwrap()[0]["note"].as_str().unwrap().contains("recounted only after its host is approved"));
    w.approve();
    // with mainnet allowed, a campaign that could still run at the NU7 height is refused
    let mut main = w.cfg.clone();
    main.allowed_networks = vec!["test".into(), "main".into()];
    main.nu7_mainnet_height = Some(180);
    let st = job::run_pass_at(&main, 150, NOW + 60).unwrap();
    assert!(own(&st, &m.id).reason.contains("NU7"), "{:?}", own(&st, &m.id));
    // deadline 200 + K 30 + close grace 10 + re-issue window 20 + margin 50 = 310: block 300 is too early, 311 is enough
    main.nu7_mainnet_height = Some(300);
    let st = job::run_pass_at(&main, 150, NOW + 90).unwrap();
    assert!(own(&st, &m.id).reason.contains("NU7"), "{:?}", own(&st, &m.id));
    main.nu7_mainnet_height = Some(311);
    w.notes(&m, vec![]);
    let st = job::run_pass_at(&main, 150, NOW + 120).unwrap();
    assert_eq!(own(&st, &m.id).state, State::Listed, "{:?}", own(&st, &m.id));
}
