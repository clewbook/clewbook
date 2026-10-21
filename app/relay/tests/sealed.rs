//! The relay and sealed bid auctions (SPEC §9): it stores their rules and their own list entries, and refuses those entries for any other
//! campaign. Over real HTTP against a relay started on a free port.

use ll_core::{
    keys::CampaignSecrets,
    ledger::{Close, Coin, Contribution, Entry, GENESIS_PREV, Reveal, Settle, Ticket, blob_hash},
    rules::Rules,
    sealed::{COIN_CUTOFF_BLOCKS, COIN_ZAT, CoinSending, QUICKNET_CHAIN_HASH, Sealed},
};
use ll_relay::client::{Relay, RelayError};

struct Campaign {
    rules: Rules,
    id: String,
    secrets: CampaignSecrets,
}

fn campaign(seed: u8, sealed: bool) -> Campaign {
    let secrets = CampaignSecrets { ledger_sk: hex::encode([seed ^ 0xA5; 32]), payload_sk: hex::encode([seed ^ 0x5A; 32]), amount_key: None };
    let mut rules = Rules {
        v: 1, network: "test".into(), mode: "raise".into(), goal_zat: Some(5_000_000), items: None,
        start_height: 100, deadline_height: 1_000, ticket_k: 10, close_grace: 10, reissue_window: 20,
        refund_fee_zat: 10_000, min_contribution_zat: 20_000, campaign_ufvk: Some("uvftest1x".into()), ufvk_hash: None,
        pay_to: None, early_close: None, cap_zat: None, sealed: None, name: None,
        pricing: None, settle_window: None, reserve_zat: None, treasury_address: None, treasury_ufvk: None,
        ledger_pubkey: secrets.ledger_pubkey_hex().unwrap(), payload_pubkey: secrets.payload_pubkey_hex().unwrap(),
    };
    if sealed {
        rules.mode = "sealed_auction".into();
        rules.goal_zat = None;
        rules.campaign_ufvk = None;
        rules.items = Some(1);
        rules.ufvk_hash = Some(hex::encode([1u8; 32]));
        rules.treasury_address = Some("utest1treasury".into());
        rules.treasury_ufvk = Some("uviewtest1treasury".into());
        rules.min_contribution_zat = 10_000_000;
        rules.sealed = Some(Sealed {
            tranches_zat: vec![10_000_000, 30_000_000],
            pricing: "second".into(),
            drand_chain: QUICKNET_CHAIN_HASH.into(),
            drand_round: 40_000_000,
            claim_after: 1_500,
            coin_zat: COIN_ZAT,
            coin_cutoff: COIN_CUTOFF_BLOCKS,
            coin_sending: CoinSending::EveryMinutes { n: 10 },
            timing: Default::default(),
            open_payouts: false,
            long_tag: false,
            early_key: false,
            coin_margin: 0,
        });
    }
    let id = hex::encode(rules.id().unwrap());
    Campaign { rules, id, secrets }
}

impl Campaign {
    fn issue(&self, n: u8, sealed_parts: bool) -> Entry {
        let mut e = Entry::new(&self.id, "issue");
        e.contribution = Some(Contribution { txid: hex::encode([n; 32]), action: 0, nf: nf(n), height: 110, value_zat: None, amount_commit: Some(hex::encode([n; 32])) });
        e.ticket = Some(Ticket { txid: hex::encode([n + 50; 32]), issue_height: 111, branch_id: "77190ad9".into() });
        e.blob_hash = Some(blob_hash(&[n]));
        if sealed_parts {
            e.refund = Some(hex::encode([n + 70; 32]));
        }
        e
    }
    fn coin(&self, n: u8) -> Entry {
        let mut e = Entry::new(&self.id, "coin");
        e.coin = Some(Coin { nf: nf(n), txid: hex::encode([n + 80; 32]), index: 0, value_zat: COIN_ZAT });
        e.late = Some(hex::encode([n + 60; 32]));
        e.blob_hash = Some(blob_hash(&[n, 1]));
        e
    }
    fn close(&self) -> Entry {
        let mut e = Entry::new(&self.id, "close");
        e.close = Some(Close { close_height: 1_001, outcome: "sealed_auction".into(), winners: Some(vec![nf(1)]), ufvk: None, amount_key: None, clearing_price_zat: Some(20_000_000), drand_signature: Some("aa".into()) });
        e
    }
    fn reveal(&self) -> Entry {
        let mut e = Entry::new(&self.id, "reveal");
        e.reveal = Some(Reveal { ufvk: "uviewtest1campaign".into(), height: 1_010, payload_sk: None });
        e
    }
    fn settle(&self) -> Entry {
        let mut e = Entry::new(&self.id, "settle");
        e.settle = Some(Settle { nf: nf(1), txid: hex::encode([9u8; 32]), price_zat: 20_000_000, excess_zat: 9_990_000, fee_zat: 10_000 });
        e
    }
}

fn nf(n: u8) -> String {
    hex::encode([n + 100; 32])
}

/// Signs and chains `next` after `before` (already stored), like the host does.
fn signed(c: &Campaign, before: &[Entry], next: Entry) -> Entry {
    let mut e = next;
    e.seq = before.len() as u64;
    e.prev = before.last().map_or(GENESIS_PREV.into(), |p| p.hash().unwrap());
    e.sign(&c.secrets.ledger_key().unwrap()).unwrap();
    e
}

fn status(e: &RelayError) -> u16 {
    match e {
        RelayError::Refused { status, .. } => *status,
        RelayError::Unreachable(_) => 0,
    }
}

fn relay() -> (std::path::PathBuf, Relay) {
    let dir = std::env::temp_dir().join(format!("ll-relay-sealed-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&dir).unwrap();
    let (server, url) = ll_relay::spawn(&dir, "127.0.0.1:0").unwrap();
    std::mem::forget(server);
    (dir, Relay::new(&url))
}

/// Tries to store `next`; on success it becomes part of `stored`.
fn put(r: &Relay, c: &Campaign, stored: &mut Vec<Entry>, next: Entry) -> Result<(), u16> {
    let e = signed(c, stored, next);
    match r.put_entry(&c.id, &e) {
        Ok(()) => {
            stored.push(e);
            Ok(())
        }
        Err(err) => Err(status(&err)),
    }
}

#[test]
fn a_sealed_bid_auction_and_its_entries_are_stored_in_order() {
    let (dir, r) = relay();
    let c = campaign(1, true);
    r.register(&c.rules).unwrap();
    assert_eq!(r.rules(&c.id).unwrap(), c.rules);
    let mut stored = vec![];
    // a deposit without its signed refund is refused, and so is one that names a late ticket (that comes with the coin)
    assert_eq!(put(&r, &c, &mut stored, c.issue(1, false)), Err(400));
    let mut with_late = c.issue(1, true);
    with_late.late = Some(hex::encode([9u8; 32]));
    assert_eq!(put(&r, &c, &mut stored, with_late), Err(400));
    // a coin before its deposit is on the list is refused
    assert_eq!(put(&r, &c, &mut stored, c.coin(1)), Err(400));
    put(&r, &c, &mut stored, c.issue(1, true)).unwrap();
    // a coin without its late ticket is refused
    let mut bare = c.coin(1);
    bare.late = None;
    assert_eq!(put(&r, &c, &mut stored, bare), Err(400));
    put(&r, &c, &mut stored, c.coin(1)).unwrap();
    // the viewing key is not revealed before the close
    assert_eq!(put(&r, &c, &mut stored, c.reveal()), Err(400));
    put(&r, &c, &mut stored, c.close()).unwrap();
    // after the close: settlements, then the reveal, once; nothing else
    put(&r, &c, &mut stored, c.settle()).unwrap();
    assert_eq!(put(&r, &c, &mut stored, c.issue(2, true)), Err(409));
    put(&r, &c, &mut stored, c.reveal()).unwrap();
    assert!(put(&r, &c, &mut stored, c.reveal()).is_err());
    let back = r.ledger(&c.id, 0).unwrap();
    assert_eq!(back.len(), 5);
    assert_eq!(back.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["issue", "coin", "close", "settle", "reveal"]);
    assert_eq!(back[1].coin.as_ref().unwrap().value_zat, COIN_ZAT);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn other_campaigns_never_take_sealed_bid_entries() {
    let (dir, r) = relay();
    let c = campaign(2, false);
    r.register(&c.rules).unwrap();
    let mut stored = vec![];
    // an ordinary fundraiser's issue entry stays as it was, and may not carry signed refunds
    assert_eq!(put(&r, &c, &mut stored, c.issue(1, true)), Err(400));
    put(&r, &c, &mut stored, c.issue(1, false)).unwrap();
    assert_eq!(put(&r, &c, &mut stored, c.coin(1)), Err(400));
    let mut close = c.close();
    close.close.as_mut().unwrap().outcome = "goal_missed".into();
    put(&r, &c, &mut stored, close).unwrap();
    assert!(put(&r, &c, &mut stored, c.reveal()).is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn rules_with_bad_sealed_settings_are_refused() {
    let (dir, r) = relay();
    let mut c = campaign(3, true);
    c.rules.sealed.as_mut().unwrap().tranches_zat = (1..=11).map(|i| i * 10_000_000).collect();
    assert!(r.register(&c.rules).is_err(), "eleven tranches");
    let _ = std::fs::remove_dir_all(dir);
}

fn late_return(c: &Campaign, n: u8, height: u32) -> Entry {
    let mut e = Entry::new(&c.id, "late_return");
    e.contribution = Some(Contribution { txid: hex::encode([n; 32]), action: 0, nf: nf(n), height, value_zat: None, amount_commit: None });
    e.refund = Some(hex::encode([n + 50; 32]));
    e
}

#[test]
fn a_late_payment_or_a_deposit_without_tickets_is_recorded_as_sent_back() {
    let (dir, r) = relay();
    let c = campaign(4, true);
    r.register(&c.rules).unwrap();
    let mut stored = vec![];
    put(&r, &c, &mut stored, c.issue(1, true)).unwrap();
    // a payment mined more than 3 blocks before the deadline is a deposit, not late (before the close)
    assert_eq!(put(&r, &c, &mut stored, late_return(&c, 6, c.rules.deadline_height - 3)), Err(400));
    // one in the last 3 blocks before the deadline is late
    put(&r, &c, &mut stored, late_return(&c, 6, c.rules.deadline_height - 1)).unwrap();
    // no amount on the public list, and the return named by its id
    let mut with_amount = late_return(&c, 7, c.rules.deadline_height + 3);
    with_amount.contribution.as_mut().unwrap().value_zat = Some(20_000_000);
    assert_eq!(put(&r, &c, &mut stored, with_amount), Err(400));
    let mut no_return = late_return(&c, 7, c.rules.deadline_height + 3);
    no_return.refund = None;
    assert_eq!(put(&r, &c, &mut stored, no_return), Err(400));
    put(&r, &c, &mut stored, late_return(&c, 7, c.rules.deadline_height + 3)).unwrap();
    // once per payment
    assert_eq!(put(&r, &c, &mut stored, late_return(&c, 7, c.rules.deadline_height + 3)), Err(400));
    // after the close too, after the reveal too; and after the close the safety net: a deposit without tickets, at any height in the auction
    put(&r, &c, &mut stored, c.close()).unwrap();
    put(&r, &c, &mut stored, late_return(&c, 5, c.rules.start_height + 1)).unwrap();
    assert_eq!(put(&r, &c, &mut stored, late_return(&c, 1, c.rules.start_height + 1)), Err(400), "a ticketed deposit is not sent back this way");
    put(&r, &c, &mut stored, late_return(&c, 8, c.rules.deadline_height + 9)).unwrap();
    put(&r, &c, &mut stored, c.reveal()).unwrap();
    put(&r, &c, &mut stored, late_return(&c, 9, c.rules.deadline_height + 20)).unwrap();
    // never for another kind of campaign
    let o = campaign(5, false);
    r.register(&o.rules).unwrap();
    let mut os = vec![];
    assert_eq!(put(&r, &o, &mut os, late_return(&o, 7, o.rules.deadline_height + 3)), Err(400));
    let _ = std::fs::remove_dir_all(dir);
}

fn relay_at(now: u64) -> (std::path::PathBuf, Relay) {
    let dir = std::env::temp_dir().join(format!("ll-relay-sealed-at-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&dir).unwrap();
    let (server, url) = ll_relay::spawn_with(&dir, "127.0.0.1:0", ll_relay::Limits { test_now: Some(now), ..ll_relay::Limits::default() }).unwrap();
    std::mem::forget(server);
    (dir, Relay::new(&url))
}

#[test]
fn h1_no_deposit_reject_or_coin_is_added_once_the_bids_are_about_to_open() {
    let c = campaign(6, true);
    let opens = ll_core::sealed::round_time(c.rules.sealed.as_ref().unwrap().drand_round);
    // well before round R: a deposit and its coin are taken
    let (dir, r) = relay_at(opens - ll_relay::SEALED_ENTRY_MARGIN_SECS - 60);
    r.register(&c.rules).unwrap();
    let mut stored = vec![];
    put(&r, &c, &mut stored, c.issue(1, true)).unwrap();
    put(&r, &c, &mut stored, c.coin(1)).unwrap();
    let _ = std::fs::remove_dir_all(dir);
    // within the margin before round R (and after it): the host could be reading bids, so no issue, reject or coin entry is taken
    for now in [opens - ll_relay::SEALED_ENTRY_MARGIN_SECS + 1, opens + 3600] {
        let (dir, r) = relay_at(now);
        r.register(&c.rules).unwrap();
        let mut stored = vec![];
        assert_eq!(put(&r, &c, &mut stored, c.issue(1, true)), Err(409), "at {now}");
        let mut rej = Entry::new(&c.id, "reject");
        rej.contribution = Some(Contribution { txid: hex::encode([3u8; 32]), action: 0, nf: nf(3), height: 120, value_zat: None, amount_commit: None });
        assert_eq!(put(&r, &c, &mut stored, rej), Err(409));
        // the close (with the round's signature) is what comes then
        put(&r, &c, &mut stored, c.close()).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn h3_a_rejected_payment_and_l6_a_deposit_a_reorg_made_late_are_sent_back() {
    let reject = |c: &Campaign, n: u8| {
        let mut e = Entry::new(&c.id, "reject");
        e.contribution = Some(Contribution { txid: hex::encode([n; 32]), action: 0, nf: nf(n), height: 120, value_zat: None, amount_commit: None });
        e.reason = Some("replayed memo".into());
        e
    };
    let (dir, r) = relay();
    let mut c = campaign(7, true);
    c.rules.sealed.as_mut().unwrap().open_payouts = true;
    c.id = hex::encode(c.rules.id().unwrap());
    r.register(&c.rules).unwrap();
    let mut stored = vec![];
    put(&r, &c, &mut stored, c.issue(1, true)).unwrap();
    put(&r, &c, &mut stored, reject(&c, 3)).unwrap();
    // H3: with open payouts a rejected payment goes back at once, before the close
    put(&r, &c, &mut stored, late_return(&c, 3, 120)).unwrap();
    assert_eq!(put(&r, &c, &mut stored, late_return(&c, 3, 120)), Err(400), "once");
    // L6: a deposit with tickets that the chain now shows in the last blocks before the deadline
    put(&r, &c, &mut stored, late_return(&c, 1, c.rules.deadline_height - 2)).unwrap();
    // a ticketed deposit still inside the window is not sent back this way
    put(&r, &c, &mut stored, c.issue(2, true)).unwrap();
    assert_eq!(put(&r, &c, &mut stored, late_return(&c, 2, 110)), Err(400));
    let _ = std::fs::remove_dir_all(dir);
    // an auction made before open payouts keeps its old rule: a reject is not sent back this way
    let (dir, r) = relay();
    let o = campaign(8, true);
    r.register(&o.rules).unwrap();
    let mut os = vec![];
    put(&r, &o, &mut os, reject(&o, 3)).unwrap();
    assert_eq!(put(&r, &o, &mut os, late_return(&o, 3, 120)), Err(400));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn second_review_h2_junk_cannot_fill_a_rejected_payments_challenge_slots() {
    use ll_core::{keys::ContributorKeys, payload::Payload, recount::Challenge};
    let (dir, r) = relay();
    let mut c = campaign(9, true);
    c.rules.sealed.as_mut().unwrap().open_payouts = true;
    c.id = hex::encode(c.rules.id().unwrap());
    r.register(&c.rules).unwrap();
    // a real blind bid memo for this auction, sealed with the person's one time secret
    let keys = ContributorKeys { seed: [21; 32] };
    let esk = keys.memo_ephemeral_key();
    let p = Payload { rules_id: c.rules.id().unwrap(), sign_pubkey: [0; 32], enc_pubkey: [0; 32], refund_typecode: 3, refund_receiver: [5; 43], amount_zat: Some(10_000_000) };
    let pk = ll_core::hex32(&c.rules.payload_pubkey).unwrap();
    let sealed = ll_core::payload::sealed_bytes(&p.to_memo(&pk, &esk).unwrap()).unwrap();
    let mut page_key = [3u8; ll_core::bid::PAGE_KEY_LEN];
    page_key[0] = 0x02;
    let memo = ll_core::bid::BidMemo { sealed, lock: [7; ll_core::bid::LOCK_LEN], page_key, bound: None }.to_text();
    // the host rejects the payment; the reject names the memo by its hash
    let mut stored = vec![];
    let mut rej = Entry::new(&c.id, "reject");
    rej.contribution = Some(Contribution { txid: hex::encode([4u8; 32]), action: 0, nf: nf(4), height: 120, value_zat: None, amount_commit: None });
    rej.blob_hash = Some(blob_hash(memo.as_bytes()));
    put(&r, &c, &mut stored, rej).unwrap();
    let ch = |secret: [u8; 32], memo: Option<String>| Challenge { txid: hex::encode([4u8; 32]), action: 0, eph_sk: hex::encode(secret), uivk: None, complaint: false, memo };
    // the cheat: twenty junk secrets for that payment; none is stored, so none takes a slot
    for i in 0..20u8 {
        let e = r.put_challenge(&c.id, &ch([i + 1; 32], Some(memo.clone()))).unwrap_err();
        assert_eq!(status(&e), 400, "junk {i}");
    }
    assert_eq!(status(&r.put_challenge(&c.id, &ch([1; 32], None)).unwrap_err()), 400, "no memo");
    let other = memo.replace('A', "B");
    assert_eq!(status(&r.put_challenge(&c.id, &ch(esk.to_bytes(), Some(other))).unwrap_err()), 400, "another memo");
    // the person's real challenge is still taken
    r.put_challenge(&c.id, &ch(esk.to_bytes(), Some(memo.clone()))).unwrap();
    assert_eq!(r.challenges(&c.id).unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(dir);
    // an auction made before open payouts keeps its old rule, and takes no memo
    let (dir, r) = relay();
    let o = campaign(10, true);
    r.register(&o.rules).unwrap();
    let mut os = vec![];
    let mut rej = Entry::new(&o.id, "reject");
    rej.contribution = Some(Contribution { txid: hex::encode([4u8; 32]), action: 0, nf: nf(4), height: 120, value_zat: None, amount_commit: None });
    put(&r, &o, &mut os, rej).unwrap();
    r.put_challenge(&o.id, &ch([1; 32], None)).unwrap();
    assert_eq!(status(&r.put_challenge(&o.id, &ch([2; 32], Some(memo))).unwrap_err()), 400);
    let _ = std::fs::remove_dir_all(dir);
}
