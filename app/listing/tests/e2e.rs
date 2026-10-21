//! End to end (PROTOTYPE, testnet only, no payments): a local relay holding invented testnet campaigns, host keys and records made the way
//! cb-host makes them, the listing job's passes and operator commands, the submission endpoint, and the hardening against stranger addresses.

use ll_core::keys::CampaignSecrets;
use ll_listing::host;
use ll_listing::job::{self, JobConfig, State};
use ll_listing::record::ListingRecord;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const TIP: u32 = 1_000;

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ll-listing-e2e-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// An invented testnet campaign: rules and secrets in a campaign folder, as cb-host would leave them (no wallet, no money).
fn campaign(dir: &Path, name: &str, relays: &[String], deadline: u32) -> (String, String) {
    campaign_on(dir, name, relays, deadline, "test")
}

/// The same on a chosen network (an invented mainnet campaign holds no wallet and no money either).
fn campaign_on(dir: &Path, name: &str, relays: &[String], deadline: u32, network: &str) -> (String, String) {
    let s = CampaignSecrets::generate();
    let rules = serde_json::json!({"v":1,"network":network,"mode":"raise","goal_zat":5000000,"start_height":100,"deadline_height":deadline,"ticket_k":30,
        "close_grace":10,"reissue_window":20,"refund_fee_zat":10000,"min_contribution_zat":20000,"campaign_ufvk":"uvftest1x",
        "ledger_pubkey":s.ledger_pubkey_hex().unwrap(),"payload_pubkey":s.payload_pubkey_hex().unwrap(),"name":name}).to_string();
    let r: ll_core::rules::Rules = serde_json::from_str(&rules).unwrap();
    let id = hex::encode(r.id().unwrap());
    let c = dir.join(&id[..8]);
    std::fs::create_dir_all(c.join("private")).unwrap();
    std::fs::write(c.join("rules.json"), &rules).unwrap();
    std::fs::write(c.join("secrets.json"), serde_json::to_vec(&s).unwrap()).unwrap();
    std::fs::write(c.join("private/relays"), relays.join("\n")).unwrap();
    (id, rules)
}

fn register(relay: &str, id: &str, rules: &str) {
    ureq::put(&format!("{relay}/v1/campaigns/{id}")).send_string(rules).unwrap();
}

fn cfg(dir: &Path) -> JobConfig {
    let mut c = JobConfig::new(dir);
    c.fetch.test_allow_loopback = true;
    c.fetch.connect_timeout = Duration::from_secs(1);
    c.fetch.total_timeout = Duration::from_secs(2);
    c
}

fn submit_record(cfg: &JobConfig, runs: &Path, campaign_dir: &Path) -> anyhow::Result<String> {
    let rec = host::record_for(runs, campaign_dir, vec![], host::now_secs())?;
    job::submit(cfg, &serde_json::to_vec(&rec)?)
}

fn state_of(status: &[job::Status], id: &str) -> (State, String) {
    let s = status.iter().find(|s| s.campaign == id).expect("a status for the campaign");
    (s.state.clone(), s.reason.clone())
}

fn listed(cfg: &JobConfig) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(cfg.dir.join("out/campaigns.json")).unwrap()).unwrap();
    v["campaigns"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect()
}

/// A stand in for a misbehaving relay: answers every connection with `reply` (after `delay`), counting the connections.
fn fake_relay(reply: Vec<u8>, delay: Duration) -> (String, Arc<AtomicUsize>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(mut s) = s else { continue };
            h.fetch_add(1, Ordering::SeqCst);
            let reply = reply.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                std::thread::sleep(delay);
                let _ = s.write_all(&reply);
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), hits)
}

#[test]
fn listing_end_to_end() {
    let root = scratch("main");
    let (_server, relay) = ll_relay::spawn(&root.join("relay"), "127.0.0.1:0").unwrap();
    let relays = vec![relay.clone()];
    let campaigns = root.join("campaigns");
    let (runs_a, runs_b) = (root.join("host-a"), root.join("host-b"));
    let pk_a = host::init_key(&runs_a).unwrap();
    let pk_b = host::init_key(&runs_b).unwrap();
    // the key file is private and never replaced
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(host::key_path(&runs_a)).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(host::init_key(&runs_a).is_err());
    let data = root.join("listing");
    let c = cfg(&data);

    // 1. an approved host is listed
    let (id1, rules1) = campaign(&campaigns, "Garden Fund", &relays, 5_000_000);
    register(&relay, &id1, &rules1);
    job::approve(&c, &pk_a, Some("Garden Collective")).unwrap();
    submit_record(&c, &runs_a, &campaigns.join(&id1[..8])).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    assert_eq!(state_of(&st, &id1).0, State::Listed, "{:?}", state_of(&st, &id1));
    assert_eq!(listed(&c), vec![id1.clone()]);
    // the list holds only id and relays
    let out: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("out/campaigns.json")).unwrap()).unwrap();
    let keys: Vec<&String> = out["campaigns"][0].as_object().unwrap().keys().collect();
    assert_eq!(keys, vec!["host", "id", "relays"]);
    assert_eq!(out["campaigns"][0]["host"]["label"], "Garden Collective");
    assert_eq!(out["campaigns"][0]["host"]["fingerprint"], ll_listing::record::fingerprint(&pk_a).as_str());
    // the label only ever comes from the approved hosts file: a record that carries one is refused outright
    let mut v = serde_json::to_value(host::record_for(&runs_a, &campaigns.join(&id1[..8]), vec![], host::now_secs() + 1).unwrap()).unwrap();
    v["label"] = serde_json::json!("Official Clewbook");
    assert!(job::submit(&c, &serde_json::to_vec(&v).unwrap()).is_err());
    // a label must be plain text
    assert!(job::approve(&c, &pk_b, Some("<b>bold</b>")).is_err());
    // changing a label
    job::set_label(&c, &pk_a, "Garden Collective Lagos").unwrap();
    job::run_pass(&c, TIP).unwrap();
    let out: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("out/campaigns.json")).unwrap()).unwrap();
    assert_eq!(out["campaigns"][0]["host"]["label"], "Garden Collective Lagos");

    // 2. a host not approved goes to the queue, and is listed after approval
    let (id2, rules2) = campaign(&campaigns, "School Roof", &relays, 5_000_000);
    register(&relay, &id2, &rules2);
    submit_record(&c, &runs_b, &campaigns.join(&id2[..8])).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    assert_eq!(state_of(&st, &id2).0, State::Queued);
    let q = job::read_queue(&c).unwrap();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0]["name"], "School Roof");
    assert_eq!(q[0]["campaign"], id2.as_str());
    assert_eq!(q[0]["checks_pass"], true);
    let fp_b = ll_listing::record::fingerprint(&pk_b);
    assert_eq!(q[0]["fingerprint"], fp_b.as_str());
    job::approve(&c, &fp_b, Some("School Friends")).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    assert_eq!(state_of(&st, &id2).0, State::Listed);
    assert!(listed(&c).contains(&id2));
    assert!(job::read_queue(&c).unwrap().is_empty());

    // 3. a hidden campaign is not listed (and comes back when unhidden)
    job::hide(&c, &id2, true).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    assert_eq!(state_of(&st, &id2).0, State::Hidden);
    assert!(!listed(&c).contains(&id2));
    job::hide(&c, &id2, false).unwrap();
    job::run_pass(&c, TIP).unwrap();
    assert!(listed(&c).contains(&id2));

    // 4. a name that looks like one already listed is refused (Cyrillic а), and so is a reserved word in disguise
    let (id3, rules3) = campaign(&campaigns, "Gаrden Fund", &relays, 5_000_000);
    register(&relay, &id3, &rules3);
    submit_record(&c, &runs_a, &campaigns.join(&id3[..8])).unwrap();
    std::fs::write(data.join("reserved.txt"), "contains:clewbook\n").unwrap();
    let (id4, rules4) = campaign(&campaigns, "Official C1ewb00k Raise", &relays, 5_000_000);
    register(&relay, &id4, &rules4);
    submit_record(&c, &runs_a, &campaigns.join(&id4[..8])).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    let (s3, r3) = state_of(&st, &id3);
    assert!(s3 == State::Refused && r3.contains("looks like a campaign already listed"), "{r3}");
    let (s4, r4) = state_of(&st, &id4);
    assert!(s4 == State::Refused && r4.contains("reserved word"), "{r4}");

    // 4b. two NEW campaigns whose names look alike: neither is listed (a record's own time is the host's word and decides nothing) until the
    // operator hides one; then the other is listed
    let (h1, hr1) = campaign(&campaigns, "Harbor Lights", &relays, 5_000_000);
    let (h2, hr2) = campaign(&campaigns, "Harb0r Lights", &relays, 5_000_000);
    register(&relay, &h1, &hr1); register(&relay, &h2, &hr2);
    submit_record(&c, &runs_b, &campaigns.join(&h1[..8])).unwrap();
    submit_record(&c, &runs_b, &campaigns.join(&h2[..8])).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    for id in [&h1, &h2] {
        let (s, r) = state_of(&st, id);
        assert!(s == State::Refused && r.contains("waiting to be listed"), "{r}");
    }
    job::hide(&c, &h2, true).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    assert_eq!(state_of(&st, &h1).0, State::Listed);
    assert_eq!(state_of(&st, &h2).0, State::Hidden);

    // 5. a past deadline is refused
    let (id5, rules5) = campaign(&campaigns, "Old Drive", &relays, 900);
    register(&relay, &id5, &rules5);
    submit_record(&c, &runs_a, &campaigns.join(&id5[..8])).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    assert!(state_of(&st, &id5).1.contains("not ahead of the chain"));

    // 6. a revoked key's campaigns disappear; nothing is deleted from the relay; it cannot submit again
    job::revoke(&c, &pk_a).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    assert_eq!(state_of(&st, &id1).0, State::Revoked);
    assert!(!listed(&c).contains(&id1) && listed(&c).contains(&id2));
    assert!(ureq::get(&format!("{relay}/v1/campaigns/{id1}")).call().is_ok(), "the relay still has the campaign");
    assert!(submit_record(&c, &runs_a, &campaigns.join(&id1[..8])).unwrap_err().to_string().contains("revoked"));

    // 7. stranger addresses: loopback without the test flag never connects; a private address is refused even with the test flag
    let (lo, lo_hits) = fake_relay(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec(), Duration::ZERO);
    let strict = JobConfig::new(&data);
    for (name, relay_url) in [("Loopback Plain", lo.clone()), ("Loopback Tls", lo.replace("http://", "https://"))] {
        let (id, _) = campaign(&campaigns, name, &[relay_url.clone()], 5_000_000);
        let rec = host::record_for(&runs_b, &campaigns.join(&id[..8]), vec![], host::now_secs()).unwrap();
        let e = ll_listing::fetch::get_text(&format!("{}/v1/campaigns/{id}", rec.relays[0]), &strict.fetch).unwrap_err().to_string();
        assert!(e.contains("only https") || e.contains("private or reserved"), "{e}");
    }
    assert_eq!(lo_hits.load(Ordering::SeqCst), 0, "a forbidden address was never contacted");
    let (idp, _) = campaign(&campaigns, "Private Net", &["https://10.255.255.1".into()], 5_000_000);
    submit_record(&c, &runs_b, &campaigns.join(&idp[..8])).unwrap();
    // 8. an oversize answer, a slow relay and a redirect are refused
    let huge = { let mut v = b"HTTP/1.1 200 OK\r\n\r\n".to_vec(); v.extend(std::iter::repeat_n(b'x', 200_000)); v };
    let (big, _) = fake_relay(huge, Duration::ZERO);
    let (slow, _) = fake_relay(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec(), Duration::from_secs(5));
    let (redir, _) = fake_relay(b"HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\n\r\n".to_vec(), Duration::ZERO);
    let mut cases = vec![(idp.clone(), "private or reserved")];
    for (name, url, want) in [("Big Answer", big, "too large"), ("Slow Relay", slow, "could not be read"), ("Moved Away", redir, "302")] {
        let (id, _) = campaign(&campaigns, name, &[url], 5_000_000);
        submit_record(&c, &runs_b, &campaigns.join(&id[..8])).unwrap();
        cases.push((id, want));
    }
    let t0 = std::time::Instant::now();
    let st = job::run_pass(&c, TIP).unwrap();
    for (id, want) in &cases {
        let (s, r) = state_of(&st, id);
        assert!(s == State::Refused && r.contains(want), "{id}: {s:?} {r}");
    }
    assert!(t0.elapsed() < Duration::from_secs(12), "the slow relay was cut off ({:?})", t0.elapsed());

    // 9. caps: records per host key, and the queue
    let capped = { let mut x = cfg(&root.join("capped")); x.max_records_per_key = 1; x.max_queue = 1; x };
    let (ia, _) = campaign(&campaigns, "Cap One", &relays, 5_000_000);
    let (ib, _) = campaign(&campaigns, "Cap Two", &relays, 5_000_000);
    submit_record(&capped, &runs_b, &campaigns.join(&ia[..8])).unwrap();
    assert!(submit_record(&capped, &runs_b, &campaigns.join(&ib[..8])).unwrap_err().to_string().contains("already has 1 records"));
    let runs_c = root.join("host-c");
    host::init_key(&runs_c).unwrap();
    assert!(submit_record(&capped, &runs_c, &campaigns.join(&ib[..8])).unwrap_err().to_string().contains("queue"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_endpoint_limits_size_and_rate_and_only_stores() {
    let root = scratch("endpoint");
    let data = root.join("listing");
    let port = { let l = TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let c = cfg(&data);
    std::thread::spawn(move || {
        ll_listing::serve::serve(c, &format!("127.0.0.1:{port}"), 3, Duration::from_secs(3600), Arc::new(|_: &str| Ok(TIP))).unwrap();
    });
    std::thread::sleep(Duration::from_millis(300));
    let base = format!("http://127.0.0.1:{port}");
    let runs = root.join("host");
    host::init_key(&runs).unwrap();
    let (id, _) = campaign(&root.join("campaigns"), "Endpoint Test", &["https://relay.example.org".into()], 5_000_000);
    let rec = host::record_for(&runs, &root.join("campaigns").join(&id[..8]), vec![], host::now_secs()).unwrap();
    // too large: refused without being read further
    let big = vec![b' '; 5000];
    match ureq::post(&format!("{base}/v1/records")).send_bytes(&big) {
        Err(ureq::Error::Status(413, _)) => {}
        other => panic!("expected 413, got {other:?}"),
    }
    // a valid record is accepted and stored (no relay is contacted by a submission)
    let ans = host::post(&base, &rec).unwrap();
    assert!(ans.contains("received"), "{ans}");
    assert!(data.join(format!("records/{id}.json")).exists());
    // a tampered one is refused
    let mut bad = rec.clone();
    bad.relays = vec!["https://other.example.org".into()];
    let e = host::post(&base, &bad).unwrap_err().to_string();
    assert!(e.contains("HTTP 400"), "refused for the tampering, not the rate: {e}");
    // the per source limit, for the address a tunnel passes on
    let mut codes = vec![];
    for _ in 0..4 {
        let r = ureq::get(&format!("{base}/v1/health")).set("CF-Connecting-IP", "203.0.113.9").call();
        codes.push(match r { Ok(r) => r.status(), Err(ureq::Error::Status(c, _)) => c, Err(_) => 0 });
    }
    assert_eq!(codes, vec![200, 200, 200, 429]);
    // the health answer names the last good pass; a request from this computer without the tunnel's header has its own limit ("local")
    let h: serde_json::Value = serde_json::from_str(&ureq::get(&format!("{base}/v1/health")).set("CF-Connecting-IP", "198.51.100.7").call().unwrap().into_string().unwrap()).unwrap();
    assert!(h["message"] == "ok" && h["block"] == TIP && h["last_pass"].as_u64().is_some(), "{h}");
    // (the three requests above without the header used up the local allowance)
    match ureq::get(&format!("{base}/v1/health")).call() {
        Err(ureq::Error::Status(429, _)) => {}
        other => panic!("the local source is limited too: {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_record_made_by_hand_from_another_campaigns_key_is_refused_at_submission() {
    // the ledger signature must come from the key the record names; the pass then checks that key against the rules
    let root = scratch("forge");
    let runs = root.join("host");
    host::init_key(&runs).unwrap();
    let (id, _) = campaign(&root.join("campaigns"), "Forge Test", &["https://relay.example.org".into()], 5_000_000);
    let mut rec: ListingRecord = host::record_for(&runs, &root.join("campaigns").join(&id[..8]), vec![], 1).unwrap();
    rec.ledger_pubkey = CampaignSecrets::generate().ledger_pubkey_hex().unwrap();
    assert!(job::submit(&cfg(&root.join("listing")), &serde_json::to_vec(&rec).unwrap()).is_err());
    let _ = std::fs::remove_dir_all(&root);
}

/// A mainnet id in the hand kept list (invented; nothing is fetched for a fixed entry). The fixed entries are not subject to the testnet rule.
const FIXED_MAIN: &str = "1111111111111111111111111111111111111111111111111111111111111111";

#[test]
fn the_hand_list_closed_campaigns_and_queue_expiry() {
    let root = scratch("owner-rules");
    let (_server, relay) = ll_relay::spawn(&root.join("relay"), "127.0.0.1:0").unwrap();
    let relays = vec![relay.clone()];
    let campaigns = root.join("campaigns");
    let (runs_a, runs_b) = (root.join("host-a"), root.join("host-b"));
    let pk_a = host::init_key(&runs_a).unwrap();
    host::init_key(&runs_b).unwrap();
    let data = root.join("listing");
    // the hand kept list: the operator's own file, with its own spacing and an extra field, and a mainnet entry
    let hand_path = root.join("hand").join("campaigns.json");
    std::fs::create_dir_all(hand_path.parent().unwrap()).unwrap();
    let hand = format!("{{\"campaigns\": [\n  {{\"id\": \"{FIXED_MAIN}\", \"relays\": [\"https://relay.example.org\"]}},\n  {{\"id\": \"{}\", \"relays\": [\"https://relay.example.org\"], \"note\": \"kept by hand\"}}\n]}}\n", "2".repeat(64));
    std::fs::write(&hand_path, &hand).unwrap();
    let mut c = cfg(&data);
    c.hand_list = Some(hand_path.clone());
    let combined = || std::fs::read(data.join("out/campaigns.json")).unwrap();

    // 1. with nothing listed here the combined list is the hand kept list byte for byte (a queued record changes nothing)
    let st = job::run_pass_at(&c, TIP, 1_000_000).unwrap();
    assert_eq!(combined(), hand.as_bytes());
    assert_eq!(st.iter().filter(|s| s.state == State::Fixed).count(), 2);
    let (q1, qr1) = campaign(&campaigns, "Queued Garden", &relays, 5_000_000);
    register(&relay, &q1, &qr1);
    submit_record(&c, &runs_b, &campaigns.join(&q1[..8])).unwrap();
    job::run_pass_at(&c, TIP, 1_000_000).unwrap();
    assert_eq!(combined(), hand.as_bytes(), "a queued record leaves the combined list equal to the hand kept list");
    // the job never writes the hand kept list
    assert_eq!(std::fs::read(&hand_path).unwrap(), hand.as_bytes());

    // 2. fixed entries come first, unchanged; then the campaigns listed here with their host
    let (id1, rules1) = campaign(&campaigns, "Garden Fund", &relays, 5_000);
    register(&relay, &id1, &rules1);
    job::approve(&c, &pk_a, Some("Garden Collective")).unwrap();
    submit_record(&c, &runs_a, &campaigns.join(&id1[..8])).unwrap();
    let st = job::run_pass_at(&c, TIP, 1_000_100).unwrap();
    assert_eq!(state_of(&st, &id1).0, State::Listed);
    let out: serde_json::Value = serde_json::from_slice(&combined()).unwrap();
    let want: serde_json::Value = serde_json::from_str(&hand).unwrap();
    let list = out["campaigns"].as_array().unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(list[0], want["campaigns"][0]);
    assert_eq!(list[1], want["campaigns"][1], "the extra field of a fixed entry is kept");
    assert_eq!(list[2]["id"], id1.as_str());
    assert_eq!(list[2]["host"]["label"], "Garden Collective");
    // a record for a campaign that is already a fixed entry is not repeated
    // (made by hand: a fixed id is only an id, so here the fixed list names a campaign the job also lists)
    let hand2 = format!("{{\"campaigns\":[{{\"id\":\"{id1}\",\"relays\":[\"{relay}\"]}}]}}");
    std::fs::write(&hand_path, &hand2).unwrap();
    let st = job::run_pass_at(&c, TIP, 1_000_150).unwrap();
    let own = st.iter().find(|s| s.campaign == id1 && s.state != State::Fixed).unwrap();
    assert!(own.state == State::Listed && own.reason.contains("not repeated"), "{own:?}");
    assert_eq!(combined(), hand2.as_bytes());
    std::fs::write(&hand_path, &hand).unwrap();

    // 2b. the word Clewbook is reserved for names without any reserved.txt
    let (cw, cw_rules) = campaign(&campaigns, "C1ewbook Garden", &relays, 5_000_000);
    register(&relay, &cw, &cw_rules);
    submit_record(&c, &runs_a, &campaigns.join(&cw[..8])).unwrap();
    let st = job::run_pass_at(&c, TIP, 1_000_160).unwrap();
    assert!(state_of(&st, &cw).1.contains("reserved word (clewbook)"), "{:?}", state_of(&st, &cw));
    job::hide(&c, &cw, true).unwrap();

    // 3. a broken hand kept list stops the pass: the last good combined list stays as it was
    job::run_pass_at(&c, TIP, 1_000_200).unwrap();
    let good = combined();
    std::fs::write(&hand_path, "{\"campaigns\": [ {\"id\": \"short\"} ]}").unwrap();
    assert!(job::run_pass_at(&c, TIP, 1_000_300).is_err());
    std::fs::remove_file(&hand_path).unwrap();
    assert!(job::run_pass_at(&c, TIP, 1_000_300).is_err(), "a missing hand kept list is an error, not an empty home page");
    assert_eq!(combined(), good);
    std::fs::write(&hand_path, &hand).unwrap();

    // 4. a campaign listed before its deadline stays listed after it (history and proof); a new one past its deadline is still refused
    let st = job::run_pass_at(&c, 6_000, 1_000_400).unwrap();
    let (s, r) = state_of(&st, &id1);
    assert!(s == State::Listed && r.contains("stays listed as a closed campaign"), "{r}");
    let out: serde_json::Value = serde_json::from_slice(&combined()).unwrap();
    assert_eq!(out["campaigns"][2]["id"], id1.as_str());
    let (late, late_rules) = campaign(&campaigns, "Late Comer", &relays, 5_500);
    register(&relay, &late, &late_rules);
    submit_record(&c, &runs_a, &campaigns.join(&late[..8])).unwrap();
    let st = job::run_pass_at(&c, 6_000, 1_000_500).unwrap();
    assert!(state_of(&st, &late).1.contains("not ahead of the chain"));

    // 5. queue expiry: the record of a host never approved waits 7 days, the queue says when it goes, then it is removed
    let day = 24 * 3600;
    let q = job::read_queue(&c).unwrap();
    let item = q.iter().find(|i| i["campaign"] == q1.as_str()).expect("queued");
    assert_eq!(item["queued_since"], 1_000_000);
    assert_eq!(item["expires_at"], 1_000_000 + 7 * day);
    let st = job::run_pass_at(&c, TIP, 1_000_000 + 7 * day - 1).unwrap();
    assert_eq!(state_of(&st, &q1).0, State::Queued);
    let st = job::run_pass_at(&c, TIP, 1_000_000 + 7 * day).unwrap();
    let (s, r) = state_of(&st, &q1);
    assert!(s == State::Expired && r.contains("not approved within 7 d"), "{r}");
    assert!(!data.join(format!("records/{q1}.json")).exists());
    assert!(job::read_queue(&c).unwrap().iter().all(|i| i["campaign"] != q1.as_str()));
    // an approved host's record never expires, and the host may send an expired one again (the wait starts again)
    assert_eq!(state_of(&st, &id1).0, State::Listed);
    submit_record(&c, &runs_b, &campaigns.join(&q1[..8])).unwrap();
    job::run_pass_at(&c, TIP, 1_000_000 + 8 * day).unwrap();
    let q = job::read_queue(&c).unwrap();
    assert_eq!(q.iter().find(|i| i["campaign"] == q1.as_str()).unwrap()["expires_at"], 1_000_000 + 15 * day);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_operators_labels_follow_the_name_rules_and_may_use_any_word() {
    let root = scratch("labels");
    let data = root.join("listing");
    let c = cfg(&data);
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    for bad in ["<i>x</i>", "", "Tab\there", "Me # you"] {
        assert!(job::approve(&c, &a, Some(bad)).is_err(), "{bad:?} must be refused");
    }
    // the owner's decision of 21 Oct 2026: the operator may give any label, reserved words included
    let z = "f".repeat(64);
    job::approve(&c, &z, Some("Clewbook Team")).unwrap();
    job::approve(&c, &a, Some("Garden Collective")).unwrap();
    // a second host may not take a look alike label
    assert!(job::approve(&c, &b, Some("Gаrden Collective")).unwrap_err().to_string().contains("another approved host"));
    job::approve(&c, &b, Some("School Friends")).unwrap();
    assert!(job::set_label(&c, &b, "Garden Collectives").is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn operator_words_in_reserved_txt_cover_names_and_relays_but_not_the_operators_labels() {
    // invented words; the real ones live only in the server's reserved.txt
    let root = scratch("words");
    let (_server, relay) = ll_relay::spawn(&root.join("relay"), "127.0.0.1:0").unwrap();
    let relays = vec![relay.clone()];
    let campaigns = root.join("campaigns");
    let runs = root.join("host");
    let pk = host::init_key(&runs).unwrap();
    let data = root.join("listing");
    let hand_path = root.join("hand.json");
    let mut c = cfg(&data);
    c.max_records_per_key = 20;
    // without the file nothing but Clewbook is reserved: the code holds no other word
    let (free_id, free_rules) = campaign(&campaigns, "Morvey Before", &relays, 5_000_000);
    register(&relay, &free_id, &free_rules);
    job::approve(&c, &pk, Some("Morvey Labs")).unwrap();
    submit_record(&c, &runs, &campaigns.join(&free_id[..8])).unwrap();
    assert_eq!(state_of(&job::run_pass(&c, TIP).unwrap(), &free_id).0, State::Listed);
    // the operator's file: names (contains:) and relay addresses (relay:), longer word first
    std::fs::write(data.join("reserved.txt"), "# operator words\ncontains:zmorvey\ncontains:morvey\nrelay:zmorvey\nrelay:morvey\n").unwrap();
    // the label rule: the operator may use both words (approve and label), and Clewbook too (any label is the operator's choice)
    job::set_label(&c, &pk, "Clewbook zmorvey").unwrap();
    job::set_label(&c, &pk, "zmorvey").unwrap();
    // names a host submits: plain, mixed case, look alike letters, inside a longer name
    let mut refused = vec![];
    for (name, word) in [("morvey", "morvey"), ("MorVEY Garden", "morvey"), ("M0rv3y Drive", "morvey"), ("Fund of mоrvеу", "morvey"),
                         ("The Morvey Fund 2026", "morvey"), ("zmorvey", "zmorvey"), ("Zmorvey Presale", "zmorvey"), ("SuperZm0rv3yFund", "zmorvey")] {
        let (id, rules) = campaign(&campaigns, name, &relays, 5_000_000);
        register(&relay, &id, &rules);
        submit_record(&c, &runs, &campaigns.join(&id[..8])).unwrap();
        refused.push((id, word));
    }
    let (ok_id, ok_rules) = campaign(&campaigns, "Morven Day Garden", &relays, 5_000_000);
    register(&relay, &ok_id, &ok_rules);
    submit_record(&c, &runs, &campaigns.join(&ok_id[..8])).unwrap();
    // a fixed entry is not affected, whatever its campaign is called
    let (fixed_id, fixed_rules) = campaign(&campaigns, "Morvey Fixed Entry", &relays, 5_000_000);
    register(&relay, &fixed_id, &fixed_rules);
    let hand = format!("{{\"campaigns\":[{{\"id\":\"{fixed_id}\",\"relays\":[\"{relay}\"]}}]}}");
    std::fs::write(&hand_path, &hand).unwrap();
    c.hand_list = Some(hand_path);
    let st = job::run_pass(&c, TIP).unwrap();
    for (id, word) in &refused {
        let (s, r) = state_of(&st, id);
        assert!(s == State::Refused && r == format!("the name contains a reserved word ({word})"), "{id}: {s:?} {r}");
    }
    assert_eq!(state_of(&st, &ok_id).0, State::Listed);
    assert_eq!(state_of(&st, &fixed_id).0, State::Fixed);
    // as before: names are checked on every pass, so a listed campaign whose name gets a reserved word is taken off the list
    assert_eq!(state_of(&st, &free_id), (State::Refused, "the name contains a reserved word (morvey)".to_string()));
    let out: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("out/campaigns.json")).unwrap()).unwrap();
    let ids: Vec<&str> = out["campaigns"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids[0], fixed_id.as_str(), "the fixed entry first");
    assert!(ids.contains(&ok_id.as_str()));
    assert_eq!(out["campaigns"][1]["host"]["label"], "zmorvey", "the operator's label is shown");
    // a relay address with either word is refused at submission (Clewbook is allowed there: the project's own relay)
    let (rid, _) = campaign(&campaigns, "Relay Word", &["https://relay.morvey.example".into()], 5_000_000);
    let e = submit_record(&c, &runs, &campaigns.join(&rid[..8])).unwrap_err().to_string();
    assert!(e.contains("a relay address contains a reserved word (morvey)"), "{e}");
    let (rid2, _) = campaign(&campaigns, "Relay Word Two", &["https://zm0rv3y-relay.example".into()], 5_000_000);
    assert!(submit_record(&c, &runs, &campaigns.join(&rid2[..8])).unwrap_err().to_string().contains("(zmorvey)"));
    let (rid3, _) = campaign(&campaigns, "Relay Word Three", &["https://relay.clewbook.xyz".into()], 5_000_000);
    submit_record(&c, &runs, &campaigns.join(&rid3[..8])).unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn mainnet_records_wait_while_mainnet_listing_is_off_and_testnet_is_unchanged() {
    let root = scratch("mainnet-wait");
    let (_server, relay) = ll_relay::spawn(&root.join("relay"), "127.0.0.1:0").unwrap();
    let relays = vec![relay.clone()];
    let campaigns = root.join("campaigns");
    let runs = root.join("host");
    let pk = host::init_key(&runs).unwrap();
    let data = root.join("listing");
    let mut c = cfg(&data);
    c.max_mainnet_waiting = 2;
    assert_eq!(JobConfig::new(&data).max_mainnet_waiting, 100, "the default cap");
    // a testnet and a mainnet campaign from the same host, not approved yet
    let (tid, trules) = campaign(&campaigns, "Garden Fund", &relays, 5_000_000);
    register(&relay, &tid, &trules);
    let (mid, mrules) = campaign_on(&campaigns, "Harbour Fund", &relays, 5_000_000, "main");
    register(&relay, &mid, &mrules);
    assert!(!submit_record(&c, &runs, &campaigns.join(&tid[..8])).unwrap().contains("mainnet"));
    let msg = submit_record(&c, &runs, &campaigns.join(&mid[..8])).unwrap();
    assert!(msg.contains("mainnet listing is not open yet, so it is kept until it opens"), "{msg}");
    let now = host::now_secs();
    let st = job::run_pass_at(&c, TIP, now).unwrap();
    assert_eq!(state_of(&st, &tid).0, State::Queued, "testnet: queued as before");
    let (s, r) = state_of(&st, &mid);
    assert!(s == State::WaitingMainnet && r.contains("mainnet listing is not open yet") && r.contains("not approved yet"), "{s:?} {r}");
    // the queue shows it, marked as mainnet, with no expiry; its name was read from the relay
    let q = job::read_queue(&c).unwrap();
    let m = q.iter().find(|x| x["campaign"] == mid.as_str()).unwrap();
    assert_eq!((m["kind"].as_str(), m["network"].as_str(), m["expires_at"].as_u64(), m["name"].as_str()), (Some("mainnet"), Some("main"), Some(0), Some("Harbour Fund")));
    assert_eq!(q.iter().find(|x| x["campaign"] == tid.as_str()).unwrap()["kind"], "approval");
    // past the queue time: the testnet record expires as before, the mainnet one stays
    let later = now + c.queue_ttl + 60;
    let st = job::run_pass_at(&c, TIP, later).unwrap();
    assert_eq!(state_of(&st, &tid).0, State::Expired);
    assert_eq!(state_of(&st, &mid).0, State::WaitingMainnet);
    assert!(data.join(format!("records/{mid}.json")).exists() && !data.join(format!("records/{tid}.json")).exists());
    // approving the host lists its testnet campaign, never the mainnet one, and nothing mainnet is recounted (no recount is set up here,
    // and a waiting record is never a recount candidate: it never reaches that step)
    job::approve(&c, &pk, Some("Harbour Collective")).unwrap();
    submit_record(&c, &runs, &campaigns.join(&tid[..8])).unwrap();
    let st = job::run_pass_at(&c, TIP, later + 60).unwrap();
    assert_eq!(state_of(&st, &tid).0, State::Listed);
    let (s, r) = state_of(&st, &mid);
    assert!(s == State::WaitingMainnet && r.contains("host key approved"), "{s:?} {r}");
    assert_eq!(listed(&c), vec![tid.clone()]);
    assert!(st.iter().find(|x| x.campaign == mid).unwrap().recount.is_none());
    // the cap: two waiting mainnet records at most (a newer record for one already waiting still replaces it)
    let (m2, r2) = campaign_on(&campaigns, "Second Harbour", &relays, 5_000_000, "main");
    register(&relay, &m2, &r2);
    submit_record(&c, &runs, &campaigns.join(&m2[..8])).unwrap();
    let (m3, _) = campaign_on(&campaigns, "Third Harbour", &relays, 5_000_000, "main");
    let e = submit_record(&c, &runs, &campaigns.join(&m3[..8])).unwrap_err().to_string();
    assert!(e.contains("waiting for mainnet listing to open is full"), "{e}");
    std::thread::sleep(Duration::from_millis(1100));
    submit_record(&c, &runs, &campaigns.join(&mid[..8])).unwrap();
    // a reserved word in a waiting mainnet name is reported now, in the queue, so the operator sees it before mainnet opens
    let (m4, r4) = campaign_on(&root.join("more"), "Clewbook Harbour", &relays, 5_000_000, "main");
    register(&relay, &m4, &r4);
    std::fs::remove_file(data.join(format!("records/{m2}.json"))).unwrap();
    submit_record(&c, &runs, &root.join("more").join(&m4[..8])).unwrap();
    let st = job::run_pass_at(&c, TIP, later + 120).unwrap();
    let (s, r) = state_of(&st, &m4);
    assert!(s == State::WaitingMainnet && r.contains("would be refused when it opens: the name contains a reserved word (clewbook)"), "{s:?} {r}");
    // once mainnet listing is turned on (the existing switches), the waiting record is decided like any other
    let mut open = c.clone();
    open.allowed_networks = vec!["test".into(), "main".into()];
    open.nu7_mainnet_height = Some(9_000_000);
    let st = job::run_pass_at(&open, TIP, later + 180).unwrap();
    assert_eq!(state_of(&st, &mid).0, State::Listed, "{:?}", state_of(&st, &mid));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_status_lookup_says_only_the_state_and_a_plain_reason() {
    let root = scratch("lookup");
    let (_server, relay) = ll_relay::spawn(&root.join("relay"), "127.0.0.1:0").unwrap();
    let relays = vec![relay.clone()];
    let campaigns = root.join("campaigns");
    let runs = root.join("host");
    let pk = host::init_key(&runs).unwrap();
    let data = root.join("listing");
    let c = cfg(&data);
    let port = { let l = TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let sc = c.clone();
    std::thread::spawn(move || {
        ll_listing::serve::serve(sc, &format!("127.0.0.1:{port}"), 60, Duration::from_secs(3600), Arc::new(|_: &str| Ok(TIP))).unwrap();
    });
    std::thread::sleep(Duration::from_millis(400));
    let base = format!("http://127.0.0.1:{port}");
    let ask = |id: &str| match host::status_outcome(&base, id).unwrap() {
        host::StatusOutcome::Known(s, r) => (s, r),
        other => panic!("{other:?}"),
    };
    // nothing sent yet, and a malformed id
    let (tid, trules) = campaign(&campaigns, "Garden Fund", &relays, 5_000_000);
    register(&relay, &tid, &trules);
    assert_eq!(ask(&tid).0, "Not found");
    match ureq::get(&format!("{base}/v1/records/not-an-id")).call() {
        Err(ureq::Error::Status(404, r)) => assert_eq!(serde_json::from_str::<serde_json::Value>(&r.into_string().unwrap()).unwrap()["state"], "Not found"),
        other => panic!("{other:?}"),
    }
    // received, then waiting for approval, then listed
    submit_record(&c, &runs, &campaigns.join(&tid[..8])).unwrap();
    assert_eq!(ask(&tid), ("Waiting".into(), "received; it is checked on the next pass (every 10 minutes)".into()));
    job::run_pass(&c, TIP).unwrap();
    assert_eq!(ask(&tid), ("Waiting".into(), "waiting for the Clewbook team to approve the host key".into()));
    job::approve(&c, &pk, Some("Garden Collective")).unwrap();
    job::run_pass(&c, TIP).unwrap();
    assert_eq!(ask(&tid), ("Listed".into(), "shown on the home page".into()));
    // the answer holds the state and the reason, nothing else
    let raw: serde_json::Value = serde_json::from_str(&ureq::get(&format!("{base}/v1/records/{tid}")).call().unwrap().into_string().unwrap()).unwrap();
    let keys: Vec<&String> = raw.as_object().unwrap().keys().collect();
    assert_eq!(keys, vec!["reason", "state"]);
    // a mainnet request waits for mainnet listing; a hidden campaign is not listed
    let (mid, mrules) = campaign_on(&campaigns, "Harbour Fund", &relays, 5_000_000, "main");
    register(&relay, &mid, &mrules);
    submit_record(&c, &runs, &campaigns.join(&mid[..8])).unwrap();
    job::hide(&c, &tid, true).unwrap();
    job::run_pass(&c, TIP).unwrap();
    assert_eq!(ask(&mid).0, "Waiting for mainnet listing to open");
    assert!(ask(&mid).1.contains("the request is kept until then"));
    assert_eq!(ask(&tid), ("Not listed".into(), "this campaign is not listed here".into()));
    // a refusal carries the pass's own reason
    std::fs::write(data.join("reserved.txt"), "contains:garden\n").unwrap();
    job::hide(&c, &tid, false).unwrap();
    let (gid, grules) = campaign(&campaigns, "Garden Two", &relays, 5_000_000);
    register(&relay, &gid, &grules);
    submit_record(&c, &runs, &campaigns.join(&gid[..8])).unwrap();
    job::run_pass(&c, TIP).unwrap();
    assert_eq!(ask(&gid), ("Not listed".into(), "the name contains a reserved word (garden)".into()));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_host_may_suggest_its_name_and_reserved_labels_bind_only_the_host() {
    // invented words stand in for the operator's own; the real list lives only in the server's reserved-labels.txt
    let root = scratch("suggest");
    let (_server, relay) = ll_relay::spawn(&root.join("relay"), "127.0.0.1:0").unwrap();
    let relays = vec![relay.clone()];
    let campaigns = root.join("campaigns");
    let data = root.join("listing");
    let c = cfg(&data);
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("reserved-labels.txt"), "# words no host may suggest\nclewbook\nzcash\nzksnarks\nzmorvey\n").unwrap();
    let send = |runs: &Path, name: &str, label: Option<&str>| -> (String, anyhow::Result<String>) {
        let (id, rules) = campaign(&campaigns, name, &relays, 5_000_000);
        register(&relay, &id, &rules);
        let rec = host::record_for_with_label(runs, &campaigns.join(&id[..8]), vec![], host::now_secs(), label).unwrap();
        (id, job::submit(&c, &serde_json::to_vec(&rec).unwrap()))
    };
    // a reserved word in a suggested name is refused at once, with the reason, in any case or spelling
    let runs_x = root.join("host-x");
    let pk_x = host::init_key(&runs_x).unwrap();
    for bad in ["ZCash Foundation", "z cash friends", "Clewb00k team", "the zkSNARKs club", "Zm0rvey"] {
        let e = send(&runs_x, "Garden Fund", Some(bad)).1.unwrap_err().to_string();
        assert!(e.starts_with("the suggested name contains a reserved word (") && e.contains("choose another name"), "{bad}: {e}");
    }
    // a campaign NAME with such a word is a different list: "Zcash builders grant" is submitted and listed as before
    let (grant, r) = send(&runs_x, "Zcash builders grant", None);
    r.unwrap();
    // the operator's own label may be anything, reserved or not
    job::approve(&c, &pk_x, Some("zcash")).unwrap();
    let st = job::run_pass(&c, TIP).unwrap();
    assert_eq!(state_of(&st, &grant).0, State::Listed, "{:?}", state_of(&st, &grant));
    let out: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("out/campaigns.json")).unwrap()).unwrap();
    assert_eq!(out["campaigns"][0]["host"]["label"], "zcash");
    // a host that suggests a plain name: shown in the queue and in the notice; approve without --label takes it
    let runs_y = root.join("host-y");
    let pk_y = host::init_key(&runs_y).unwrap();
    let (yid, r) = send(&runs_y, "Harbour Fund", Some("Harbour Collective"));
    r.unwrap();
    job::run_pass(&c, TIP).unwrap();
    let q = job::read_queue(&c).unwrap();
    let item = q.iter().find(|i| i["campaign"] == yid.as_str()).unwrap();
    assert_eq!(item["suggested_label"], "Harbour Collective");
    let text = ll_listing::notify::message(&[item], &[]);
    assert!(text.contains("Host suggests: Harbour Collective") && text.contains(&format!("approve {}\"", host::describe_key(&runs_y).unwrap().1.replace(' ', ""))), "{text}");
    assert!(job::approve(&c, &pk_y, None).unwrap().contains("as \"Harbour Collective\" (the name the host suggested)"));
    let st = job::run_pass(&c, TIP).unwrap();
    assert_eq!(state_of(&st, &yid).0, State::Listed);
    let out: serde_json::Value = serde_json::from_slice(&std::fs::read(data.join("out/campaigns.json")).unwrap()).unwrap();
    let shown = out["campaigns"].as_array().unwrap().iter().find(|e| e["id"] == yid.as_str()).unwrap();
    assert_eq!(shown["host"]["label"], "Harbour Collective");
    // --label overrides the suggestion
    let runs_z = root.join("host-z");
    let pk_z = host::init_key(&runs_z).unwrap();
    send(&runs_z, "Orchard Fund", Some("Orchard People")).1.unwrap();
    job::approve(&c, &pk_z, Some("Orchard Group")).unwrap();
    assert_eq!(job::read_labels(&data.join("approved_hosts.txt")).get(&pk_z).map(String::as_str), Some("Orchard Group"));
    // a host that suggested nothing: approve asks for --label
    let runs_n = root.join("host-n");
    let pk_n = host::init_key(&runs_n).unwrap();
    send(&runs_n, "School Roof", None).1.unwrap();
    assert!(job::approve(&c, &pk_n, None).unwrap_err().to_string().contains("suggested no name: give one with --label"));
    let _ = std::fs::remove_dir_all(&root);
}
