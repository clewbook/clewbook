//! The relay's rules, tested over real HTTP against a relay started on a free port.

use ll_core::{
    canon::to_canonical,
    keys::CampaignSecrets,
    ledger::{Close, Contribution, Entry, GENESIS_PREV, Ticket, blob_hash},
    rules::Rules,
};
use ll_relay::client::{Relay, RelayError};

struct Campaign {
    rules: Rules,
    id: String,
    secrets: CampaignSecrets,
}

fn campaign(seed: u8) -> Campaign {
    let secrets = CampaignSecrets { ledger_sk: hex::encode([seed ^ 0xA5; 32]), payload_sk: hex::encode([seed ^ 0x5A; 32]), amount_key: None };
    let rules = Rules {
        v: 1, network: "test".into(), mode: "raise".into(), goal_zat: Some(5_000_000), items: None,
        start_height: 100, deadline_height: 200, ticket_k: 10, close_grace: 10, reissue_window: 20,
        refund_fee_zat: 10_000, min_contribution_zat: 20_000, campaign_ufvk: Some("uvftest1x".into()), ufvk_hash: None,
        pay_to: None, early_close: None, cancellable: None, cap_zat: None, sealed: None, name: None,
        pricing: None, settle_window: None, reserve_zat: None, treasury_address: None, treasury_ufvk: None, ledger_pubkey: secrets.ledger_pubkey_hex().unwrap(), payload_pubkey: secrets.payload_pubkey_hex().unwrap(),
    };
    let id = hex::encode(rules.id().unwrap());
    Campaign { rules, id, secrets }
}

impl Campaign {
    fn issue(&self, n: u8, blob: &[u8]) -> Entry {
        let mut e = Entry::new(&self.id, "issue");
        e.contribution = Some(Contribution {
            txid: hex::encode([n; 32]), action: 0, nf: hex::encode([n + 100; 32]), height: 110, value_zat: Some(1_000_000), amount_commit: None,
        });
        e.ticket = Some(Ticket { txid: hex::encode([n + 50; 32]), issue_height: 111, branch_id: "77190ad9".into() });
        e.blob_hash = Some(blob_hash(blob));
        e
    }

    /// Signs and chains like the host does.
    fn chain(&self, mut entries: Vec<Entry>) -> Vec<Entry> {
        let sk = self.secrets.ledger_key().unwrap();
        let mut out: Vec<Entry> = vec![];
        for e in entries.drain(..) {
            let mut e = e;
            e.seq = out.len() as u64;
            e.prev = out.last().map_or(GENESIS_PREV.into(), |p| p.hash().unwrap());
            e.sign(&sk).unwrap();
            out.push(e);
        }
        out
    }
}

fn relay() -> (tempdir::Dir, Relay, String) {
    let dir = tempdir::Dir::new();
    let (_server, url) = ll_relay::spawn(dir.path(), "127.0.0.1:0").unwrap();
    std::mem::forget(_server); // the server thread lives for the test process
    let r = Relay::new(&url);
    (dir, r, url)
}

mod tempdir {
    pub struct Dir(std::path::PathBuf);
    impl Dir {
        pub fn new() -> Self {
            let p = std::env::temp_dir().join(format!("ll-relay-test-{}-{}", std::process::id(), rand_suffix()));
            std::fs::create_dir_all(&p).unwrap();
            Dir(p)
        }
        pub fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }
}

fn status(e: &RelayError) -> u16 {
    match e {
        RelayError::Refused { status, .. } => *status,
        RelayError::Unreachable(_) => 0,
    }
}

fn raw_put(url: &str, path: &str, body: &[u8]) -> u16 {
    match ureq::put(&format!("{url}/v1/{path}")).send_bytes(body) {
        Ok(r) => r.status(),
        Err(ureq::Error::Status(s, _)) => s,
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn accepts_a_signed_chain_and_serves_it_to_anyone() {
    let (_d, r, url) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let blob = b"sealed ticket bytes (opaque)".to_vec();
    let ledger = c.chain(vec![c.issue(1, &blob), c.issue(2, b"other")]);
    for e in &ledger {
        r.put_entry(&c.id, e).unwrap();
    }
    r.put_blob(&c.id, &blob_hash(&blob), &blob).unwrap();

    assert_eq!(r.ledger(&c.id, 0).unwrap(), ledger);
    assert_eq!(r.ledger(&c.id, 1).unwrap(), vec![ledger[1].clone()]);
    assert_eq!(r.head_entries(&c.id).unwrap(), 2);
    assert_eq!(r.rules(&c.id).unwrap(), c.rules);
    assert_eq!(r.ticket(&c.id, &hex::encode([101u8; 32])).unwrap(), blob);
    // CORS: a web page on any origin can read it.
    let resp = ureq::get(&format!("{url}/v1/campaigns/{}/head", c.id)).call().unwrap();
    assert_eq!(resp.header("access-control-allow-origin"), Some("*"));
}

#[test]
fn refuses_entries_not_signed_by_the_campaign() {
    let (_d, r, _) = relay();
    let c = campaign(1);
    let imposter = campaign(9); // different ledger key, same rules shape
    r.register(&c.rules).unwrap();

    // Signed by someone else (but claiming this campaign).
    let mut forged = imposter.chain(vec![imposter.issue(1, b"x")]).remove(0);
    forged.rules_id = c.id.clone();
    assert_eq!(status(&r.put_entry(&c.id, &forged).unwrap_err()), 400);

    // Right key, tampered after signing.
    let mut tampered = c.chain(vec![c.issue(1, b"x")]).remove(0);
    tampered.contribution.as_mut().unwrap().value_zat = Some(1);
    assert_eq!(status(&r.put_entry(&c.id, &tampered).unwrap_err()), 400);

    // Unsigned.
    let mut unsigned = c.chain(vec![c.issue(1, b"x")]).remove(0);
    unsigned.sig = None;
    assert_eq!(status(&r.put_entry(&c.id, &unsigned).unwrap_err()), 400);

    // Nothing was stored.
    assert_eq!(r.head_entries(&c.id).unwrap(), 0);
}

#[test]
fn refuses_gaps_wrong_chain_other_campaigns_and_sloppy_json() {
    let (_d, r, url) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let ledger = c.chain(vec![c.issue(1, b"a"), c.issue(2, b"b"), c.issue(3, b"c")]);

    assert_eq!(status(&r.put_entry(&c.id, &ledger[1]).unwrap_err()), 400, "gap: seq 1 before seq 0");
    r.put_entry(&c.id, &ledger[0]).unwrap();

    // seq 1 with a prev that is not the hash of entry 0.
    let sk = c.secrets.ledger_key().unwrap();
    let mut wrong_prev = ledger[1].clone();
    wrong_prev.prev = "11".repeat(32);
    wrong_prev.sign(&sk).unwrap();
    assert_eq!(status(&r.put_entry(&c.id, &wrong_prev).unwrap_err()), 400);

    // Pretty-printed JSON is not the canonical form that was signed.
    let pretty = serde_json::to_vec_pretty(&ledger[1]).unwrap();
    assert_eq!(raw_put(&url, &format!("campaigns/{}/ledger/1", c.id), &pretty), 400);

    // Path and body must agree on seq.
    assert_eq!(raw_put(&url, &format!("campaigns/{}/ledger/5", c.id), to_canonical(&ledger[1]).unwrap().as_bytes()), 400);

    // An entry of another (registered) campaign cannot be filed here.
    let other = campaign(7);
    r.register(&other.rules).unwrap();
    let foreign = other.chain(vec![other.issue(1, b"a")]).remove(0);
    assert_eq!(status(&r.put_entry(&c.id, &foreign).unwrap_err()), 400);
    assert_eq!(r.head_entries(&c.id).unwrap(), 1);
}

#[test]
fn is_idempotent_but_refuses_a_second_story_for_the_same_seq() {
    let (_d, r, _) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let ledger = c.chain(vec![c.issue(1, b"a")]);
    r.put_entry(&c.id, &ledger[0]).unwrap();
    r.put_entry(&c.id, &ledger[0]).unwrap(); // same bytes again: fine
    // The host (or anyone with the key) signs a different entry 0: refused, the first one stays.
    let second_story = c.chain(vec![c.issue(2, b"b")]);
    assert_eq!(status(&r.put_entry(&c.id, &second_story[0]).unwrap_err()), 409);
    assert_eq!(r.ledger(&c.id, 0).unwrap(), ledger);
}

#[test]
fn nothing_after_close() {
    let (_d, r, _) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let mut close = Entry::new(&c.id, "close");
    close.close = Some(Close { close_height: 205, outcome: "goal_missed".into(), winners: None, ufvk: None, amount_key: None, clearing_price_zat: None, drand_signature: None });
    let ledger = c.chain(vec![c.issue(1, b"a"), close, c.issue(2, b"b")]);
    r.put_entry(&c.id, &ledger[0]).unwrap();
    r.put_entry(&c.id, &ledger[1]).unwrap();
    assert_eq!(status(&r.put_entry(&c.id, &ledger[2]).unwrap_err()), 409);
}

#[test]
fn rules_must_hash_to_their_id() {
    let (_d, r, url) = relay();
    let c = campaign(1);
    let body = to_canonical(&c.rules).unwrap();
    assert_eq!(raw_put(&url, &format!("campaigns/{}", "ab".repeat(32)), body.as_bytes()), 400, "wrong id");
    assert_eq!(raw_put(&url, "campaigns/not-hex", body.as_bytes()), 400);
    r.register(&c.rules).unwrap();
    // Unknown campaign
    assert_eq!(status(&r.rules(&"cd".repeat(32)).unwrap_err().downcast::<RelayError>().unwrap()), 404);
}

#[test]
fn blobs_are_opaque_and_only_accepted_when_a_signed_entry_names_them() {
    let (_d, r, _) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let blob = b"ciphertext".to_vec();
    // Before any entry names it: refused.
    assert_eq!(status(&r.put_blob(&c.id, &blob_hash(&blob), &blob).unwrap_err()), 400);
    let ledger = c.chain(vec![c.issue(1, &blob)]);
    r.put_entry(&c.id, &ledger[0]).unwrap();
    // Wrong bytes for the hash: refused.
    assert_eq!(status(&r.put_blob(&c.id, &blob_hash(&blob), b"something else").unwrap_err()), 400);
    // A random blob nobody named: refused.
    assert_eq!(status(&r.put_blob(&c.id, &blob_hash(b"junk"), b"junk").unwrap_err()), 400);
    r.put_blob(&c.id, &blob_hash(&blob), &blob).unwrap();
    assert!(r.has_blob(&c.id, &blob_hash(&blob)).unwrap());
    assert!(!r.has_blob(&c.id, &blob_hash(b"nope")).unwrap());
}

#[test]
fn stores_only_what_it_was_sent_no_secrets_exist_to_leak() {
    let (d, r, _) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let blob = b"sealed".to_vec();
    r.put_entry(&c.id, &c.chain(vec![c.issue(1, &blob)])[0]).unwrap();
    r.put_blob(&c.id, &blob_hash(&blob), &blob).unwrap();
    // Everything on disk: the public rules, signed entries, ciphertext. Check no file contains
    // the campaign's secret keys.
    let mut files = 0;
    let mut stack = vec![d.path().to_path_buf()];
    while let Some(p) = stack.pop() {
        for e in std::fs::read_dir(p).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else {
                files += 1;
                let bytes = std::fs::read(&p).unwrap();
                let text = String::from_utf8_lossy(&bytes);
                assert!(!text.contains(&c.secrets.ledger_sk) && !text.contains(&c.secrets.payload_sk), "{} leaks a key", p.display());
            }
        }
    }
    assert_eq!(files, 3);
}

#[test]
fn a_relay_that_is_down_is_reported_as_unreachable_not_as_empty() {
    let dead = Relay::new("http://127.0.0.1:1"); // nothing listens there
    match dead.head_entries(&"ab".repeat(32)) {
        Err(RelayError::Unreachable(_)) => {}
        other => panic!("expected Unreachable, got {other:?}"),
    }
}

fn reject(c: &Campaign, n: u8) -> Entry {
    let mut e = Entry::new(&c.id, "reject");
    e.contribution = Some(Contribution { txid: hex::encode([n; 32]), action: 1, nf: hex::encode([n + 100; 32]), height: 110, value_zat: Some(1_000_000), amount_commit: None });
    e.reason = Some("payload does not open".into());
    e
}

fn challenge(n: u8, action: u32, secret: u8) -> ll_core::recount::Challenge {
    ll_core::recount::Challenge { txid: hex::encode([n; 32]), action, eph_sk: hex::encode([secret; 32]), uivk: None, complaint: false , memo: None }
}

#[test]
fn challenges_are_stored_only_against_rejected_payments_and_served_to_anyone() {
    let (_d, r, url) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let ledger = c.chain(vec![reject(&c, 7), c.issue(8, b"ok")]);
    for e in &ledger {
        r.put_entry(&c.id, e).unwrap();
    }
    // Against the rejected payment: accepted, then idempotent.
    r.put_challenge(&c.id, &challenge(7, 1, 0x33)).unwrap();
    r.put_challenge(&c.id, &challenge(7, 1, 0x33)).unwrap();
    // A different secret for the same payment is kept too (anyone may post one; the recount opens the memo to check).
    r.put_challenge(&c.id, &challenge(7, 1, 0x34)).unwrap();
    assert_eq!(r.challenges(&c.id).unwrap().len(), 2);
    // Against a payment that was NOT rejected (issue entry), or an unknown payment, or the wrong action: refused.
    assert_eq!(status(&r.put_challenge(&c.id, &challenge(8, 0, 0x33)).unwrap_err()), 400);
    assert_eq!(status(&r.put_challenge(&c.id, &challenge(9, 1, 0x33)).unwrap_err()), 400);
    assert_eq!(status(&r.put_challenge(&c.id, &challenge(7, 2, 0x33)).unwrap_err()), 400);
    // Malformed.
    assert_eq!(raw_put(&url, &format!("campaigns/{}/challenges", c.id), b"{\"txid\":\"zz\"}"), 400);
    assert_eq!(raw_put(&url, &format!("campaigns/{}/challenges", c.id), b"not json"), 400);
    // Served with CORS to any page.
    let resp = ureq::get(&format!("{url}/v1/campaigns/{}/challenges", c.id)).call().unwrap();
    assert_eq!(resp.header("access-control-allow-origin"), Some("*"));
}

#[test]
fn challenges_per_payment_are_capped() {
    let (_d, r, _) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    r.put_entry(&c.id, &c.chain(vec![reject(&c, 7)])[0]).unwrap();
    for secret in 0..ll_relay::MAX_CHALLENGES_PER_PAYMENT as u8 {
        r.put_challenge(&c.id, &challenge(7, 1, 0x40 + secret)).unwrap();
    }
    assert_eq!(status(&r.put_challenge(&c.id, &challenge(7, 1, 0x7f)).unwrap_err()), 409);
    assert_eq!(r.challenges(&c.id).unwrap().len(), ll_relay::MAX_CHALLENGES_PER_PAYMENT);
}

// ---- several relays ----

use ll_relay::multi::{Judgement, State, judge, merged_challenges, read_all};

fn two_relays_with(c: &Campaign, ledger_a: &[Entry], ledger_b: &[Entry]) -> (Vec<tempdir::Dir>, Vec<String>) {
    let mut dirs = vec![];
    let mut urls = vec![];
    for ledger in [ledger_a, ledger_b] {
        let (d, r, url) = relay();
        r.register(&c.rules).unwrap();
        for e in ledger {
            r.put_entry(&c.id, e).unwrap();
        }
        dirs.push(d);
        urls.push(url);
    }
    (dirs, urls)
}

#[test]
fn identical_relays_agree_and_one_relay_is_labelled_single() {
    let c = campaign(1);
    let ledger = c.chain(vec![c.issue(1, b"a"), c.issue(2, b"b")]);
    let (_d, urls) = two_relays_with(&c, &ledger, &ledger);
    let reads = read_all(&urls, &c.id);
    assert!(matches!(judge(&reads), Judgement::Agree(_)));
    // A second relay that is down leaves one relay: a verdict is possible but labelled single.
    let mut with_dead = urls.clone();
    with_dead.push("http://127.0.0.1:1".into());
    let reads = read_all(&with_dead[1..], &c.id);
    assert!(matches!(judge(&reads), Judgement::Single(_)));
    assert!(matches!(reads[1].state, State::Unreachable(_)));
}

#[test]
fn relays_that_differ_cannot_conclude() {
    let c = campaign(1);
    let ledger = c.chain(vec![c.issue(1, b"a"), c.issue(2, b"b"), c.issue(3, b"c")]);
    // B has silently lost the newest entry (the chain is still intact).
    let (_d, urls) = two_relays_with(&c, &ledger, &ledger[..2]);
    let reads = read_all(&urls, &c.id);
    match judge(&reads) {
        Judgement::Disagree(lines) => assert!(lines.iter().any(|l| l.contains("first differ at entry 2")), "{lines:?}"),
        other => panic!("expected Disagree, got {other:?}"),
    }
}

#[test]
fn a_damaged_ledger_is_excluded_and_never_the_basis_of_a_verdict() {
    let c = campaign(1);
    let ledger = c.chain(vec![c.issue(1, b"a"), c.issue(2, b"b"), c.issue(3, b"c")]);
    let (dirs, urls) = two_relays_with(&c, &ledger, &ledger);
    // Relay B's storage loses the middle entry.
    std::fs::remove_file(dirs[1].path().join(format!("campaigns/{}/ledger/000001.json", c.id))).unwrap();
    let reads = read_all(&urls, &c.id);
    assert!(matches!(reads[1].state, State::Damaged(_)));
    assert!(matches!(judge(&reads), Judgement::Single(_)), "the intact relay stands alone, labelled single");
    // Only the damaged one: no usable ledger at all.
    let reads = read_all(&urls[1..], &c.id);
    match judge(&reads) {
        Judgement::NoUsableLedger(lines) => assert!(lines[0].contains("damaged"), "{lines:?}"),
        other => panic!("expected NoUsableLedger, got {other:?}"),
    }
}

#[test]
fn challenges_from_every_relay_are_merged() {
    let c = campaign(1);
    let ledger = c.chain(vec![reject(&c, 7)]);
    let (_d, urls) = two_relays_with(&c, &ledger, &ledger);
    Relay::new(&urls[0]).put_challenge(&c.id, &challenge(7, 1, 0x33)).unwrap();
    Relay::new(&urls[1]).put_challenge(&c.id, &challenge(7, 1, 0x44)).unwrap();
    Relay::new(&urls[1]).put_challenge(&c.id, &challenge(7, 1, 0x33)).unwrap(); // duplicate across relays
    let reads = read_all(&urls, &c.id);
    assert_eq!(merged_challenges(&reads).len(), 2);
}

#[test]
fn settlement_entries_may_follow_the_close_and_winners_statements_need_a_settlement() {
    let (_d, r, _) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let mut close = Entry::new(&c.id, "close");
    close.close = Some(Close { close_height: 205, outcome: "auction".into(), winners: Some(vec![hex::encode([108u8; 32])]), ufvk: None, amount_key: None, clearing_price_zat: Some(190_000), drand_signature: None });
    let mut settle = Entry::new(&c.id, "settle");
    settle.settle = Some(ll_core::ledger::Settle { nf: hex::encode([108u8; 32]), txid: hex::encode([9u8; 32]), price_zat: 190_000, excess_zat: 100_000, fee_zat: 10_000 });
    let ledger = c.chain(vec![c.issue(8, b"w"), close, settle, c.issue(2, b"late")]);
    for e in &ledger[..3] {
        r.put_entry(&c.id, e).unwrap(); // the settle entry follows the close entry
    }
    // anything but a settle entry after the close is still refused
    assert_eq!(status(&r.put_entry(&c.id, &ledger[3]).unwrap_err()), 409);
    // a statement from the winner (viewing key or complaint) is accepted for the settled payment only
    let mut proof = challenge(8, 0, 0x44);
    proof.uivk = Some("uivktest1example".into());
    r.put_challenge(&c.id, &proof).unwrap();
    let mut complaint = challenge(8, 0, 0x45);
    complaint.complaint = true;
    r.put_challenge(&c.id, &complaint).unwrap();
    assert_eq!(status(&r.put_challenge(&c.id, &challenge(2, 0, 0x44)).unwrap_err()), 400);
    assert_eq!(r.challenges(&c.id).unwrap().len(), 2);
}

// ---- the host's "last seen" heartbeat (SPEC §6) ----

fn signed_hb(c: &Campaign, height: u32, time: u64) -> ll_core::heartbeat::Heartbeat {
    let mut hb = ll_core::heartbeat::Heartbeat::new(&c.id, height, time);
    hb.sign(&c.secrets.ledger_key().unwrap()).unwrap();
    hb
}

#[test]
fn a_heartbeat_is_kept_served_and_only_replaced_by_a_later_one() {
    let (_d, r, url) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    // none yet
    assert_eq!(ureq::get(&format!("{url}/v1/campaigns/{}/heartbeat", c.id)).call().map(|r| r.status()).unwrap_or_else(|e| match e { ureq::Error::Status(s, _) => s, _ => 0 }), 404);
    let a = signed_hb(&c, 1000, 5000);
    r.put_heartbeat(&c.id, &a).unwrap();
    let got: ll_core::heartbeat::Heartbeat = serde_json::from_str(&ureq::get(&format!("{url}/v1/campaigns/{}/heartbeat", c.id)).call().unwrap().into_string().unwrap()).unwrap();
    assert_eq!(got, a);
    r.put_heartbeat(&c.id, &a).unwrap(); // the same one again is not an error
    let b = signed_hb(&c, 1001, 5015);
    r.put_heartbeat(&c.id, &b).unwrap();
    let old = r.put_heartbeat(&c.id, &a).unwrap_err();
    assert_eq!(status(&old), 409, "an older heartbeat cannot replace a newer one (a replay does not make the host look alive)");
    let same_height_older_time = signed_hb(&c, 1001, 5000);
    assert_eq!(status(&r.put_heartbeat(&c.id, &same_height_older_time).unwrap_err()), 409);
}

#[test]
fn a_heartbeat_must_be_signed_by_this_campaigns_key_and_be_for_it() {
    let (_d, r, _url) = relay();
    let c = campaign(1);
    let other = campaign(2);
    r.register(&c.rules).unwrap();
    r.register(&other.rules).unwrap();
    // signed by another campaign's key
    let mut forged = ll_core::heartbeat::Heartbeat::new(&c.id, 5, 5);
    forged.sign(&other.secrets.ledger_key().unwrap()).unwrap();
    assert_eq!(status(&r.put_heartbeat(&c.id, &forged).unwrap_err()), 400);
    // a good heartbeat of another campaign, sent to this one
    assert_eq!(status(&r.put_heartbeat(&c.id, &signed_hb(&other, 5, 5)).unwrap_err()), 400);
    // unsigned, and changed after signing
    assert_eq!(status(&r.put_heartbeat(&c.id, &ll_core::heartbeat::Heartbeat::new(&c.id, 5, 5)).unwrap_err()), 400);
    let mut changed = signed_hb(&c, 5, 5);
    changed.height = 6_000_000;
    assert_eq!(status(&r.put_heartbeat(&c.id, &changed).unwrap_err()), 400);
    // not a heartbeat at all, and too big
    assert_eq!(raw_put(&_url, &format!("campaigns/{}/heartbeat", c.id), b"{\"hello\":1}"), 400);
    assert_eq!(raw_put(&_url, &format!("campaigns/{}/heartbeat", c.id), &vec![b' '; 4096]), 400);
    // for a campaign the relay does not know
    let stranger = campaign(3);
    assert_eq!(status(&r.put_heartbeat(&stranger.id, &signed_hb(&stranger, 1, 1)).unwrap_err()), 404);
}

// ---- the host's final fingerprint of a closed campaign (SPEC §6) ----

fn close_entry(c: &Campaign, height: u32) -> Entry {
    let mut e = Entry::new(&c.id, "close");
    e.close = Some(ll_core::ledger::Close { close_height: height, outcome: "goal_missed".into(), winners: None, ufvk: None, amount_key: None, clearing_price_zat: None, drand_signature: None });
    e
}

fn signed_final(c: &Campaign, list: &[Entry]) -> ll_core::final_copy::FinalRecord {
    let mut r = ll_core::final_copy::FinalRecord::of(&c.id, list).unwrap();
    r.sign(&c.secrets.ledger_key().unwrap()).unwrap();
    r
}

#[test]
fn a_final_record_is_kept_only_for_a_list_the_relay_holds_and_is_served() {
    let (_d, r, url) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let list = c.chain(vec![c.issue(1, b"a"), close_entry(&c, 150)]);
    // before any entry, or before the close entry is stored, there is nothing to keep
    let rec = signed_final(&c, &list);
    assert_eq!(status(&r.put_final(&c.id, &rec).unwrap_err()), 409, "the relay does not hold the entries yet");
    r.put_blob(&c.id, &ll_core::ledger::blob_hash(b"a"), b"a").ok();
    for e in &list {
        r.put_entry(&c.id, e).unwrap();
    }
    assert_eq!(ureq::get(&format!("{url}/v1/campaigns/{}/final", c.id)).call().map(|r| r.status()).unwrap_or_else(|e| match e { ureq::Error::Status(s, _) => s, _ => 0 }), 404);
    r.put_final(&c.id, &rec).unwrap();
    let got: ll_core::final_copy::FinalRecord = serde_json::from_str(&ureq::get(&format!("{url}/v1/campaigns/{}/final", c.id)).call().unwrap().into_string().unwrap()).unwrap();
    assert_eq!(got, rec);
    r.put_final(&c.id, &rec).unwrap(); // again: not an error
}

#[test]
fn a_final_record_that_is_forged_foreign_or_for_another_list_is_refused() {
    let (_d, r, url) = relay();
    let c = campaign(1);
    let other = campaign(2);
    r.register(&c.rules).unwrap();
    r.register(&other.rules).unwrap();
    let list = c.chain(vec![c.issue(1, b"a"), close_entry(&c, 150)]);
    for e in &list {
        r.put_entry(&c.id, e).unwrap();
    }
    // signed by another campaign's key; a changed count or hash; unsigned
    let mut forged = ll_core::final_copy::FinalRecord::of(&c.id, &list).unwrap();
    forged.sign(&other.secrets.ledger_key().unwrap()).unwrap();
    assert_eq!(status(&r.put_final(&c.id, &forged).unwrap_err()), 400);
    let mut longer = signed_final(&c, &list);
    longer.entries = 5;
    assert_eq!(status(&r.put_final(&c.id, &longer).unwrap_err()), 400, "a changed record breaks its signature");
    assert_eq!(status(&r.put_final(&c.id, &ll_core::final_copy::FinalRecord::of(&c.id, &list).unwrap()).unwrap_err()), 400, "unsigned");
    // a good signature over a list the relay does not hold: more entries than it has, or another last entry (a fork)
    let mut beyond = ll_core::final_copy::FinalRecord::of(&c.id, &list).unwrap();
    beyond.entries = 9;
    beyond.sign(&c.secrets.ledger_key().unwrap()).unwrap();
    assert_eq!(status(&r.put_final(&c.id, &beyond).unwrap_err()), 409);
    let fork = c.chain(vec![c.issue(1, b"a"), close_entry(&c, 777)]);
    assert_eq!(status(&r.put_final(&c.id, &signed_final(&c, &fork)).unwrap_err()), 400, "a different, equally well signed list is not the one the relay holds");
    // not a final record, too big, unknown campaign
    assert_eq!(raw_put(&url, &format!("campaigns/{}/final", c.id), b"{\"hello\":1}"), 400);
    assert_eq!(raw_put(&url, &format!("campaigns/{}/final", c.id), &vec![b' '; 4096]), 400);
    let stranger = campaign(3);
    assert_eq!(status(&r.put_final(&stranger.id, &signed_final(&stranger, &stranger.chain(vec![close_entry(&stranger, 1)]))).unwrap_err()), 404);
}

#[test]
fn a_later_final_record_replaces_an_earlier_one_only_when_it_covers_more() {
    let (_d, r, _url) = relay();
    let c = campaign(1);
    r.register(&c.rules).unwrap();
    let mut settle = Entry::new(&c.id, "settle");
    settle.settle = Some(ll_core::ledger::Settle { nf: "00".repeat(32), txid: "11".repeat(32), price_zat: 1, excess_zat: 0, fee_zat: 1 });
    let list = c.chain(vec![close_entry(&c, 150), settle]);
    r.put_entry(&c.id, &list[0]).unwrap();
    let early = signed_final(&c, &list[..1]);
    r.put_final(&c.id, &early).unwrap();
    r.put_entry(&c.id, &list[1]).unwrap();
    let later = signed_final(&c, &list);
    r.put_final(&c.id, &later).unwrap();
    assert_eq!(status(&r.put_final(&c.id, &early).unwrap_err()), 409, "an earlier one cannot come back");
}

#[test]
fn a_capped_campaign_is_accepted_with_the_same_id_and_its_cap_is_kept() {
    let (_d, r, _) = relay();
    let mut c = campaign(41);
    c.rules.cap_zat = Some(12_000_000);
    c.id = hex::encode(c.rules.id().unwrap());
    r.register(&c.rules).unwrap();
    let back = r.rules(&c.id).unwrap();
    assert_eq!(back.cap_zat, Some(12_000_000), "the relay keeps the field");
    assert_eq!(hex::encode(back.id().unwrap()), c.id, "and the id it serves under is the one computed with the cap");
}

/// A fundraiser that opted in to cancel and refund all (SPEC §4.4), as the host makes it.
fn cancellable(seed: u8) -> Campaign {
    let mut c = campaign(seed);
    c.rules.cancellable = Some(true);
    c.id = hex::encode(c.rules.id().unwrap());
    c
}

fn cancel_entry(c: &Campaign, height: u32) -> Entry {
    let mut e = Entry::new(&c.id, "close");
    e.close = Some(Close { close_height: height, outcome: "cancelled".into(), winners: None, ufvk: None, amount_key: None, clearing_price_zat: None, drand_signature: None });
    e
}

fn sent_back(c: &Campaign, n: u8) -> Entry {
    let mut e = Entry::new(&c.id, "late_return");
    e.contribution = Some(Contribution { txid: hex::encode([n; 32]), action: 0, nf: hex::encode([n + 100; 32]), height: 150, value_zat: None, amount_commit: None });
    e.refund = Some(hex::encode([n + 70; 32]));
    e
}

#[test]
fn a_fundraiser_that_opted_in_can_be_cancelled_and_payments_after_the_cancel_are_sent_back() {
    let (_d, r, _) = relay();
    let c = cancellable(7);
    r.register(&c.rules).unwrap();
    assert_eq!(r.rules(&c.id).unwrap(), c.rules, "the opt in is kept in the rules the relay serves");
    // before the cancel no payment is sent back: it gets its ticket
    let early = c.chain(vec![c.issue(1, b"a"), sent_back(&c, 2)]);
    r.put_entry(&c.id, &early[0]).unwrap();
    assert_eq!(status(&r.put_entry(&c.id, &early[1]).unwrap_err()), 400);
    // the cancel, then: a payment the list never named is sent back; one it names is refunded by its ticket; no new ticket
    let ledger = c.chain(vec![c.issue(1, b"a"), cancel_entry(&c, 150), sent_back(&c, 2), sent_back(&c, 1), c.issue(3, b"c")]);
    r.put_entry(&c.id, &ledger[1]).unwrap();
    r.put_entry(&c.id, &ledger[2]).unwrap();
    let named = c.chain(vec![c.issue(1, b"a"), cancel_entry(&c, 150), sent_back(&c, 2), sent_back(&c, 1)]);
    assert_eq!(status(&r.put_entry(&c.id, &named[3]).unwrap_err()), 400, "a listed payment is refunded by its ticket, never sent back");
    let after = c.chain(vec![c.issue(1, b"a"), cancel_entry(&c, 150), sent_back(&c, 2), c.issue(3, b"c")]);
    assert_eq!(status(&r.put_entry(&c.id, &after[3]).unwrap_err()), 409, "no ticket after the cancel");
}

#[test]
fn a_campaign_that_did_not_opt_in_cannot_be_cancelled_or_send_payments_back() {
    let (_d, r, _) = relay();
    let c = campaign(8);
    r.register(&c.rules).unwrap();
    let ledger = c.chain(vec![c.issue(1, b"a"), cancel_entry(&c, 150)]);
    r.put_entry(&c.id, &ledger[0]).unwrap();
    assert_eq!(status(&r.put_entry(&c.id, &ledger[1]).unwrap_err()), 400);
    let mut close = Entry::new(&c.id, "close");
    close.close = Some(Close { close_height: 205, outcome: "goal_missed".into(), winners: None, ufvk: None, amount_key: None, clearing_price_zat: None, drand_signature: None });
    let ledger = c.chain(vec![c.issue(1, b"a"), close, sent_back(&c, 2)]);
    r.put_entry(&c.id, &ledger[1]).unwrap();
    assert_eq!(status(&r.put_entry(&c.id, &ledger[2]).unwrap_err()), 400);
}
