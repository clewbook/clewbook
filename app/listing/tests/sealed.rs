//! The listing job and sealed bid auctions (SPEC §9): before the close (no viewing key yet) it recounts what can be checked without the
//! chain and does not mark the host "did not finish". In-process relay, no chain server, no payments.

use ll_core::keys::CampaignSecrets;
use ll_core::rules::Rules;
use ll_core::sealed::{COIN_CUTOFF_BLOCKS, COIN_ZAT, CoinSending, QUICKNET_CHAIN_HASH, Sealed};
use ll_listing::chain::{Chain, FullRequest, ScanStats};
use ll_listing::fetch::FetchPolicy;
use ll_listing::recount::{Limits, recount_campaign};
use std::sync::Arc;
use std::time::Instant;

struct NoChain;
impl Chain for NoChain {
    fn tip(&self, _: &str) -> anyhow::Result<u32> {
        anyhow::bail!("not used")
    }
    fn full_report(&self, _: &FullRequest, _: Instant) -> anyhow::Result<(serde_json::Value, ScanStats)> {
        anyhow::bail!("a sealed bid auction before its reveal has no viewing key, so no chain scan is made")
    }
}

#[test]
fn a_sealed_bid_auction_before_its_close_is_recounted_without_the_chain() {
    let dir = std::env::temp_dir().join(format!("ll-listing-sealed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (_server, relay) = ll_relay::spawn(&dir, "127.0.0.1:0").unwrap();
    let secrets = CampaignSecrets::generate();
    let mut rules: Rules = serde_json::from_value(serde_json::json!({"v":1,"network":"test","mode":"sealed_auction","items":2,"start_height":100,
        "deadline_height":1000,"ticket_k":30,"close_grace":10,"reissue_window":20,"refund_fee_zat":10000,"min_contribution_zat":10000000,
        "ufvk_hash":"aa","treasury_address":"utest1x","treasury_ufvk":"uviewtest1x",
        "ledger_pubkey":secrets.ledger_pubkey_hex().unwrap(),"payload_pubkey":secrets.payload_pubkey_hex().unwrap()})).unwrap();
    rules.sealed = Some(Sealed { tranches_zat: vec![10_000_000, 50_000_000], pricing: "pay_your_bid".into(), drand_chain: QUICKNET_CHAIN_HASH.into(),
        drand_round: 40_000_000, claim_after: 1_500, coin_zat: COIN_ZAT, coin_cutoff: COIN_CUTOFF_BLOCKS, coin_sending: CoinSending::AtOnce, timing: Default::default(), open_payouts: false, long_tag: false, early_key: false, coin_margin: 0 });
    let id = hex::encode(rules.id().unwrap());
    ureq::put(&format!("{relay}/v1/campaigns/{id}")).send_string(&serde_json::to_string(&rules).unwrap()).unwrap();
    let chain: Arc<dyn Chain> = Arc::new(NoChain);
    let fetch = FetchPolicy { test_allow_loopback: true, ..FetchPolicy::default() };
    let o = recount_campaign(&chain, &[relay], &id, "test", 500, &Limits::default(), &fetch);
    assert!(o.verdict, "{:?}", o.error);
    assert_eq!(o.scope, "sealed");
    assert!(o.passed.iter().any(|p| p == "R1") && o.passed.iter().any(|p| p == "R2"), "{:?}", o.passed);
    assert!(!o.did_not_finish);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Blind bid rules on the test network (round R far in the future unless a test sets the relay's clock), and their secrets.
fn blind_rules(name: &str) -> (Rules, CampaignSecrets, String) {
    let secrets = CampaignSecrets::generate();
    let mut rules: Rules = serde_json::from_value(serde_json::json!({"v":1,"network":"test","mode":"sealed_auction","items":1,"start_height":100,
        "deadline_height":1000,"ticket_k":30,"close_grace":10,"reissue_window":20,"refund_fee_zat":10000,"min_contribution_zat":10000000,
        "ufvk_hash":"aa","treasury_address":"utest1x","treasury_ufvk":"uviewtest1x","name":name,
        "ledger_pubkey":secrets.ledger_pubkey_hex().unwrap(),"payload_pubkey":secrets.payload_pubkey_hex().unwrap()})).unwrap();
    rules.sealed = Some(Sealed { tranches_zat: vec![10_000_000, 50_000_000], pricing: "uniform".into(), drand_chain: QUICKNET_CHAIN_HASH.into(),
        drand_round: 40_000_000, claim_after: 1_500, coin_zat: COIN_ZAT, coin_cutoff: COIN_CUTOFF_BLOCKS, coin_sending: CoinSending::AtOnce, timing: Default::default(), open_payouts: true, long_tag: true, early_key: true, coin_margin: 0 });
    let id = hex::encode(rules.id().unwrap());
    (rules, secrets, id)
}

fn relay_at(dir: &std::path::Path, now: Option<u64>) -> String {
    std::fs::create_dir_all(dir).unwrap();
    let (server, url) = ll_relay::spawn_with(dir, "127.0.0.1:0", ll_relay::Limits { test_now: now, ..ll_relay::Limits::default() }).unwrap();
    std::mem::forget(server);
    url
}

fn scratch(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("ll-listing-sealed2-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn second_review_m2_a_blind_bid_auction_is_listed_only_through_our_relay() {
    let root = scratch("ours");
    let ours = relay_at(&root.join("ours"), None);
    let theirs = relay_at(&root.join("theirs"), None);
    let (rules, secrets, id) = blind_rules("Own relay only");
    for r in [&ours, &theirs] {
        ureq::put(&format!("{r}/v1/campaigns/{id}")).send_string(&serde_json::to_string(&rules).unwrap()).unwrap();
    }
    let mut cfg = ll_listing::job::JobConfig::new(root.join("listing"));
    cfg.fetch = FetchPolicy { test_allow_loopback: true, ..FetchPolicy::default() };
    cfg.our_relays = vec![("test".into(), ours.clone())];
    let host = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
    // published only to its own relay: refused, with the reason
    let rec = ll_listing::record::ListingRecord::make(&id, "test", vec![theirs.clone()], &host, &secrets.ledger_key().unwrap(), 1).unwrap();
    ll_listing::job::submit(&cfg, &serde_json::to_vec(&rec).unwrap()).unwrap();
    ll_listing::job::approve(&cfg, &rec.host_pubkey, Some("Tester")).unwrap();
    let st = ll_listing::job::run_pass_with(&cfg, &|_| Some(500), 1_000).unwrap();
    let s = st.iter().find(|s| s.campaign == id).unwrap();
    assert_eq!(s.state, ll_listing::job::State::Refused, "{s:?}");
    assert!(s.reason.contains("only if it publishes to") && s.reason.contains(&ours), "{}", s.reason);
    // the same auction naming our relay too passes that check (its recount is the rest of the listing's business)
    let rec2 = ll_listing::record::ListingRecord::make(&id, "test", vec![theirs.clone(), ours.clone()], &host, &secrets.ledger_key().unwrap(), 2).unwrap();
    ll_listing::job::submit(&cfg, &serde_json::to_vec(&rec2).unwrap()).unwrap();
    let st = ll_listing::job::run_pass_with(&cfg, &|_| Some(500), 1_001).unwrap();
    let s = st.iter().find(|s| s.campaign == id).unwrap();
    assert!(!s.reason.contains("only if it publishes to"), "{s:?}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_testnet_blind_bid_auction_lists_through_either_of_our_relays_and_never_through_a_strangers_only() {
    // the defaults: on testnet both the test relay and the live relay are ours; on mainnet the live relay
    let d = ll_listing::job::JobConfig::new("unused");
    assert_eq!(ll_listing::job::our_relays(&d, "test"), vec!["https://relay-test.clewbook.xyz", "https://relay.clewbook.xyz"]);
    assert_eq!(ll_listing::job::our_relays(&d, "main"), vec!["https://relay.clewbook.xyz"]);
    // stand ins for the two: an auction on the second one (the live relay) lists; one on a stranger's relay only is refused
    let root = scratch("either");
    let (test_relay, live_relay, stranger) = (relay_at(&root.join("test"), None), relay_at(&root.join("live"), None), relay_at(&root.join("stranger"), None));
    let mut cfg = ll_listing::job::JobConfig::new(root.join("listing"));
    cfg.fetch = FetchPolicy { test_allow_loopback: true, ..FetchPolicy::default() };
    cfg.our_relays = vec![("test".into(), test_relay.clone()), ("test".into(), live_relay.clone())];
    let host = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
    let mut ids = vec![];
    for (name, relay) in [("On the live relay", &live_relay), ("On a stranger's relay", &stranger)] {
        let (rules, secrets, id) = blind_rules(name);
        ureq::put(&format!("{relay}/v1/campaigns/{id}")).send_string(&serde_json::to_string(&rules).unwrap()).unwrap();
        let rec = ll_listing::record::ListingRecord::make(&id, "test", vec![relay.clone()], &host, &secrets.ledger_key().unwrap(), 1).unwrap();
        ll_listing::job::submit(&cfg, &serde_json::to_vec(&rec).unwrap()).unwrap();
        ids.push(id);
    }
    ll_listing::job::approve(&cfg, &hex::encode(host.verifying_key().as_bytes()), Some("Tester")).unwrap();
    let st = ll_listing::job::run_pass_with(&cfg, &|_| Some(500), 1_000).unwrap();
    let on_live = st.iter().find(|s| s.campaign == ids[0]).unwrap();
    assert_eq!(on_live.state, ll_listing::job::State::Listed, "{on_live:?}");
    let on_stranger = st.iter().find(|s| s.campaign == ids[1]).unwrap();
    assert_eq!(on_stranger.state, ll_listing::job::State::Refused, "{on_stranger:?}");
    assert!(on_stranger.reason.contains(&format!("only if it publishes to {test_relay} or {live_relay}, which refuse late entries")), "{}", on_stranger.reason);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn second_review_m2_a_late_entry_only_on_the_hosts_relay_shows_the_relays_disagree() {
    let root = scratch("late");
    let (rules, secrets, id) = blind_rules("Late entry");
    let opens = ll_core::sealed::round_time(40_000_000);
    // our relay's clock is a minute before round R; the host's relay does not care (any clock, or a relay it runs)
    let ours = relay_at(&root.join("ours"), Some(opens - 60));
    let theirs = relay_at(&root.join("theirs"), Some(opens - 86_400));
    for r in [&ours, &theirs] {
        ureq::put(&format!("{r}/v1/campaigns/{id}")).send_string(&serde_json::to_string(&rules).unwrap()).unwrap();
    }
    let mut e = ll_core::ledger::Entry::new(&id, "reject");
    e.contribution = Some(ll_core::ledger::Contribution { txid: hex::encode([4u8; 32]), action: 0, nf: hex::encode([5u8; 32]), height: 900, value_zat: None, amount_commit: None });
    e.blob_hash = Some(ll_core::ledger::blob_hash(b"memo"));
    e.seq = 0;
    e.prev = ll_core::ledger::GENESIS_PREV.into();
    e.sign(&secrets.ledger_key().unwrap()).unwrap();
    let body = ll_core::canon::to_canonical(&e).unwrap();
    let put = |r: &str| ureq::put(&format!("{r}/v1/campaigns/{id}/ledger/0")).send_string(&body);
    assert!(matches!(put(&ours), Err(ureq::Error::Status(409, _))), "our relay refuses an entry added once the bids are about to open");
    put(&theirs).unwrap();
    let chain: Arc<dyn Chain> = Arc::new(NoChain);
    let fetch = FetchPolicy { test_allow_loopback: true, ..FetchPolicy::default() };
    let o = recount_campaign(&chain, &[ours, theirs], &id, "test", 500, &Limits::default(), &fetch);
    assert!(!o.verdict && o.error.as_deref().is_some_and(|m| m.contains("the relays do not show the same ledger")), "{:?}", o.error);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn second_review_m2_a_host_that_never_closes_is_marked_did_not_finish_by_the_listing() {
    let root = scratch("dnf");
    let relay = relay_at(&root.join("relay"), None);
    let (rules, _secrets, id) = blind_rules("Never closed");
    ureq::put(&format!("{relay}/v1/campaigns/{id}")).send_string(&serde_json::to_string(&rules).unwrap()).unwrap();
    let chain: Arc<dyn Chain> = Arc::new(NoChain);
    let fetch = FetchPolicy { test_allow_loopback: true, ..FetchPolicy::default() };
    // past the late ticket block (1500) with no close: did not finish
    let o = recount_campaign(&chain, &[relay.clone()], &id, "test", 1_600, &Limits::default(), &fetch);
    assert!(o.verdict && o.did_not_finish, "{:?} {:?}", o.error, o.failed);
    let o = recount_campaign(&chain, &[relay], &id, "test", 1_200, &Limits::default(), &fetch);
    assert!(!o.did_not_finish, "before the late ticket block it is not");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn second_review_m6_one_address_cannot_fill_the_queue_with_new_host_keys() {
    let root = scratch("m6");
    let mut cfg = ll_listing::job::JobConfig::new(root.join("listing"));
    cfg.max_queue_per_source = 5;
    let rec = |n: u8| {
        let (_, secrets, id) = blind_rules(&format!("Queue filler {n}"));
        let host = ed25519_dalek::SigningKey::from_bytes(&[n; 32]);
        serde_json::to_vec(&ll_listing::record::ListingRecord::make(&id, "test", vec!["https://relay-test.clewbook.xyz".into()], &host, &secrets.ledger_key().unwrap(), 1).unwrap()).unwrap()
    };
    // a stranger with free host keys: five new records from one address, the sixth refused
    for n in 1..=5u8 {
        ll_listing::job::submit_from(&cfg, &rec(n), Some("203.0.113.7")).unwrap();
    }
    let e = ll_listing::job::submit_from(&cfg, &rec(6), Some("203.0.113.7")).unwrap_err().to_string();
    assert!(e.contains("this address has sent 5 requests"), "{e}");
    // another address is not affected
    ll_listing::job::submit_from(&cfg, &rec(7), Some("198.51.100.2")).unwrap();
    let _ = std::fs::remove_dir_all(&root);
}
