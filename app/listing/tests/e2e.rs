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
    let s = CampaignSecrets::generate();
    let rules = serde_json::json!({"v":1,"network":"test","mode":"raise","goal_zat":5000000,"start_height":100,"deadline_height":deadline,"ticket_k":30,
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
    job::approve(&c, &pk_a, "Garden Collective").unwrap();
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
    assert!(job::approve(&c, &pk_b, "<b>bold</b>").is_err());
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
    job::approve(&c, &fp_b, "School Friends").unwrap();
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
    job::approve(&c, &pk_a, "Garden Collective").unwrap();
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
fn labels_follow_the_name_rules_and_reserve_clewbook() {
    let root = scratch("labels");
    let data = root.join("listing");
    let c = cfg(&data);
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    for bad in ["Clewbook Team", "c1ewb00k friends", "<i>x</i>", "", "Tab\there"] {
        assert!(job::approve(&c, &a, bad).is_err(), "{bad:?} must be refused");
    }
    job::approve(&c, &a, "Garden Collective").unwrap();
    // a second host may not take a look alike label
    assert!(job::approve(&c, &b, "Gаrden Collective").unwrap_err().to_string().contains("another approved host"));
    job::approve(&c, &b, "School Friends").unwrap();
    assert!(job::set_label(&c, &b, "Garden Collectives").is_err());
    let _ = std::fs::remove_dir_all(&root);
}
