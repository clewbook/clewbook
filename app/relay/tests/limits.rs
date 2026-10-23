//! The relay's limits, over real HTTP against relays started on free ports: how many campaigns, how many entries, how big a request, how many at
//! once, and how many per minute from one source. Legitimate use within the limits keeps working.

use std::{
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

use ll_core::{keys::CampaignSecrets, ledger::{Entry, GENESIS_PREV}, rules::Rules};
use ll_relay::{Limits, client::{Relay, RelayError}};

fn rules(seed: u8) -> (Rules, CampaignSecrets) {
    let secrets = CampaignSecrets { ledger_sk: hex::encode([seed; 32]), payload_sk: hex::encode([seed ^ 0x5A; 32]), amount_key: None };
    let rules = Rules {
        v: 1, network: "test".into(), mode: "raise".into(), goal_zat: Some(5_000_000), items: None,
        start_height: 100, deadline_height: 200, ticket_k: 10, close_grace: 10, reissue_window: 20,
        refund_fee_zat: 10_000, min_contribution_zat: 20_000, campaign_ufvk: Some("uvftest1x".into()), ufvk_hash: None,
        pay_to: None, early_close: None, cancellable: None, cap_zat: None, sealed: None, name: None, pricing: None, settle_window: None, reserve_zat: None, treasury_address: None, treasury_ufvk: None,
        ledger_pubkey: secrets.ledger_pubkey_hex().unwrap(), payload_pubkey: secrets.payload_pubkey_hex().unwrap(),
    };
    (rules, secrets)
}

fn relay(limits: Limits) -> (String, std::path::PathBuf) {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!("ll-relay-limits-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    std::fs::create_dir_all(&dir).unwrap();
    let (server, url) = ll_relay::spawn_with(&dir, "127.0.0.1:0", limits).unwrap();
    std::mem::forget(server);
    (url, dir)
}

/// One raw request; returns the status code. `source` is sent as `CF-Connecting-IP`, as the tunnel does.
fn raw(url: &str, method: &str, path: &str, body: &[u8], source: Option<&str>) -> u16 {
    let addr = url.trim_start_matches("http://");
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let extra = source.map(|ip| format!("CF-Connecting-IP: {ip}\r\n")).unwrap_or_default();
    let head = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", body.len());
    s.write_all(head.as_bytes()).unwrap();
    let _ = s.write_all(body);
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0)
}

fn refused(r: Result<(), RelayError>) -> u16 {
    match r {
        Err(RelayError::Refused { status, .. }) => status,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_defaults_are_far_below_the_old_ceiling_and_say_so() {
    let d = Limits::default();
    assert_eq!((d.max_campaigns, d.max_entries, d.max_body, d.max_concurrent, d.per_source_per_minute), (200, 5_000, 64 * 1024, 64, 600));
}

#[test]
fn only_so_many_campaigns_may_be_registered_but_a_registered_one_keeps_working() {
    let (url, _) = relay(Limits { max_campaigns: 2, ..Limits::default() });
    let r = Relay::new(&url);
    let (a, _) = rules(1);
    let (b, _) = rules(2);
    let (c, _) = rules(3);
    r.register(&a).unwrap();
    r.register(&b).unwrap();
    assert_eq!(refused(r.register(&c)), 409, "a third campaign is refused");
    r.register(&a).unwrap(); // registering one that is already there is fine
}

#[test]
fn a_list_may_not_grow_past_the_entry_limit() {
    let (url, _) = relay(Limits { max_entries: 3, ..Limits::default() });
    let r = Relay::new(&url);
    let (rules, secrets) = rules(4);
    let id = hex::encode(rules.id().unwrap());
    r.register(&rules).unwrap();
    let sk = secrets.ledger_key().unwrap();
    let mut prev = GENESIS_PREV.to_string();
    for seq in 0..4u64 {
        let mut e = Entry::new(&id, "reject");
        e.contribution = Some(ll_core::ledger::Contribution { txid: hex::encode([seq as u8; 32]), action: 0, nf: hex::encode([seq as u8 + 9; 32]), height: 110, value_zat: Some(30_000), amount_commit: None });
        e.reason = Some("test".into());
        e.seq = seq;
        e.prev = prev.clone();
        e.sign(&sk).unwrap();
        let res = r.put_entry(&id, &e);
        if seq < 3 {
            res.unwrap();
        } else {
            assert_eq!(refused(res), 409, "the fourth entry is refused");
        }
        prev = e.hash().unwrap();
    }
}

#[test]
fn a_body_over_the_size_limit_is_refused() {
    let (url, _) = relay(Limits { max_body: 1000, ..Limits::default() });
    let id = "ab".repeat(32);
    assert_eq!(raw(&url, "PUT", &format!("/v1/campaigns/{id}"), &[b'x'; 1001], None), 413);
    assert_eq!(raw(&url, "PUT", &format!("/v1/campaigns/{id}"), &[b'x'; 900], None), 400, "a small body is read (and here rejected as not rules)");
}

#[test]
fn one_source_is_held_to_its_rate_but_others_and_this_computer_are_not() {
    let (url, _) = relay(Limits { per_source_per_minute: 5, ..Limits::default() });
    let codes: Vec<u16> = (0..8).map(|_| raw(&url, "GET", "/v1/health", b"", Some("203.0.113.7"))).collect();
    assert_eq!(codes.iter().filter(|&&c| c == 200).count(), 5, "{codes:?}");
    assert!(codes[5..].iter().all(|&c| c == 429), "{codes:?}");
    assert_eq!(raw(&url, "GET", "/v1/health", b"", Some("198.51.100.2")), 200, "another source is not affected");
    assert!((0..20).all(|_| raw(&url, "GET", "/v1/health", b"", None) == 200), "a program on this computer (the host publishing) is not limited");
}

#[test]
fn more_requests_at_once_than_allowed_are_answered_busy() {
    let (url, _) = relay(Limits { max_concurrent: 2, ..Limits::default() });
    let addr = url.trim_start_matches("http://").to_string();
    // two requests that announce a body (larger than the 1 KiB the HTTP library reads for itself) and never send it hold both places
    let mut held = vec![];
    for _ in 0..2 {
        let mut s = TcpStream::connect(&addr).unwrap();
        s.write_all(format!("PUT /v1/campaigns/{} HTTP/1.1\r\nHost: x\r\nContent-Length: 5000\r\n\r\n", "cd".repeat(32)).as_bytes()).unwrap();
        held.push(s);
    }
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(raw(&url, "GET", "/v1/health", b"", None), 503, "a third is told the relay is busy");
    drop(held);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(raw(&url, "GET", "/v1/health", b"", None), 200, "and served again once they are gone");
}

fn reject_entry(id: &str, seq: u64, prev: &str, secrets: &CampaignSecrets) -> Entry {
    let mut e = Entry::new(id, "reject");
    e.contribution = Some(ll_core::ledger::Contribution { txid: hex::encode([seq as u8; 32]), action: 0, nf: hex::encode([seq as u8 + 9; 32]), height: 110, value_zat: Some(30_000), amount_commit: None });
    e.reason = Some("test".into());
    e.seq = seq;
    e.prev = prev.to_string();
    e.sign(&secrets.ledger_key().unwrap()).unwrap();
    e
}

#[test]
fn set2_m4_a_public_relay_takes_no_regtest_rules_and_no_unknown_network() {
    let (url, _) = relay(Limits::default());
    let r = Relay::new(&url);
    let (mut ru, _) = rules(21);
    ru.network = "regtest".into();
    assert_eq!(refused(r.register(&ru)), 400, "a public relay refuses rules for a private chain");
    ru.network = "testnet-ish".into();
    assert_eq!(refused(r.register(&ru)), 400, "an unknown network is refused by the rules check");
    let (url, _) = relay(Limits { allow_regtest: true, ..Limits::default() });
    let (mut ru, _) = rules(22);
    ru.network = "regtest".into();
    Relay::new(&url).register(&ru).unwrap();
}

#[test]
fn set2_m5_a_campaign_and_the_relay_have_a_storage_cap() {
    // one campaign may store about two entries' worth; a stranger's third entry is refused (507), and other campaigns keep working
    let (url, _) = relay(Limits { max_campaign_bytes: 2_200, ..Limits::default() });
    let r = Relay::new(&url);
    let (rules_a, sa) = rules(23);
    let id = hex::encode(rules_a.id().unwrap());
    r.register(&rules_a).unwrap();
    let mut prev = GENESIS_PREV.to_string();
    let mut stored = 0;
    for seq in 0..10u64 {
        let e = reject_entry(&id, seq, &prev, &sa);
        match r.put_entry(&id, &e) {
            Ok(()) => { stored += 1; prev = e.hash().unwrap(); }
            Err(err) => { assert_eq!(refused(Err(err)), 507, "full, not another error"); break; }
        }
    }
    assert!((1..10).contains(&stored), "{stored} entries stored before the cap");
    let (rules_b, sb) = rules(24);
    let idb = hex::encode(rules_b.id().unwrap());
    r.register(&rules_b).unwrap();
    r.put_entry(&idb, &reject_entry(&idb, 0, GENESIS_PREV, &sb)).unwrap();
    // the whole relay: a cap reached by registrations alone refuses the next campaign
    let (url, _) = relay(Limits { max_total_bytes: 2_000, ..Limits::default() });
    let r = Relay::new(&url);
    let mut n = 0;
    for seed in 30..40u8 {
        match r.register(&rules(seed).0) {
            Ok(()) => n += 1,
            Err(err) => { assert_eq!(refused(Err(err)), 507); break; }
        }
    }
    assert!((1..10).contains(&n), "{n} campaigns before the relay was full");
}
