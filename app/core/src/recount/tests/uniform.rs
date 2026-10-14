//! Fake uniform-price auctions (SPEC §8) with one kind of misconduct each.

use super::*;
use crate::{
    ledger::{Close, Entry, Settle},
    recount::{DisclosureCheck, Extra, TxFacts},
};

const FEE: u64 = 10_000;
const RESERVE: u64 = 50_000;

/// 3 bids of 300k, 200k, 100k (gross), 2 items, reserve 50k (net): winners A and B, price = B's net bid 190k.
/// A is owed an excess of 300k - 190k - 10k = 100k; B's excess is 0 (the marginal winner).
struct U {
    f: Fx,
    a: ChainNote,
    b: ChainNote,
    c: ChainNote,
}

fn base(items: u32) -> Fx {
    let mut f = fx("auction");
    f.rules.items = Some(items);
    f.rules.pricing = Some("uniform".into());
    f.rules.reserve_zat = Some(RESERVE);
    f.rules.treasury_address = Some("utest1treasury".into());
    f.rules.treasury_ufvk = Some("uviewtest1treasury".into());
    f.id = hex::encode(f.rules.id().unwrap());
    f
}

fn u() -> U {
    let f = base(2);
    let a = f.note(1, 300_000, 110, f.good_memo(1));
    let b = f.note(2, 200_000, 111, f.good_memo(2));
    let c = f.note(3, 100_000, 112, f.good_memo(3));
    U { f, a, b, c }
}

fn nf(n: &ChainNote) -> String {
    n.nf.clone().unwrap()
}

fn settle(f: &Fx, n: &ChainNote, txid: &str, price: u64, excess: u64) -> Entry {
    let mut e = Entry::new(&f.id, "settle");
    e.settle = Some(Settle { nf: nf(n), txid: txid.into(), price_zat: price, excess_zat: excess, fee_zat: FEE });
    e
}

fn close_u(f: &Fx, winners: Vec<String>, price: u64) -> Entry {
    let mut e = f.close("auction", Some(winners));
    e.close.as_mut().unwrap().clearing_price_zat = Some(price);
    e
}

fn tnote(txid: &str, value: u64) -> ChainNote {
    ChainNote { txid: txid.into(), action: 0, value_zat: value, nf: None, height: Some(203), tx_index: None, memo_text: None, is_change: false, spent_by: None }
}

fn facts(txid: &str) -> TxFacts {
    TxFacts { txid: txid.into(), fee_zat: FEE as i64, ironwood_actions: 2, has_orchard: false, has_sapling: false, has_transparent: false }
}

/// Everything honest: A and B settled in blocks 203, C refunded by its ticket.
fn honest(u: &U) -> (Vec<Entry>, Vec<ChainNote>, Extra) {
    let f = &u.f;
    let l = f.ledger(vec![
        f.entry("issue", &u.a), f.entry("issue", &u.b), f.entry("issue", &u.c),
        close_u(f, vec![nf(&u.a), nf(&u.b)], 190_000),
        settle(f, &u.a, "settle-a", 190_000, 100_000), settle(f, &u.b, "settle-b", 190_000, 0),
    ]);
    let tc = ticket_of(&u.c);
    let notes = vec![spent(u.a.clone(), "settle-a", 203), spent(u.b.clone(), "settle-b", 203), spent(u.c.clone(), &tc, 204)];
    let extra = Extra {
        treasury_notes: vec![tnote("settle-a", 190_000), tnote("settle-b", 190_000)],
        tx_facts: vec![facts("settle-a"), facts("settle-b")],
        checks: vec![],
    };
    (l, notes, extra)
}

fn run(f: &Fx, l: &[Entry], notes: &[ChainNote], ch: &[Challenge], extra: &Extra, tip: u32) -> Report {
    recount_with(&f.rules, &f.id, l, notes, ch, tip, true, extra)
}

#[test]
fn honest_uniform_auction_passes_and_totals_are_exact() {
    let u = u();
    let (l, notes, extra) = honest(&u);
    let r = run(&u.f, &l, &notes, &[], &extra, 220);
    assert!(r.all_pass(), "{:?} {:?}", failing(&r), r.results.iter().filter(|x| !x.pass).map(|x| &x.details).collect::<Vec<_>>());
    let a = r.auction.unwrap();
    assert_eq!((a.price_zat, a.winners, a.settled, a.treasury_total_zat, a.excess_zat), (190_000, 2, 2, 380_000, 100_000));
    assert_eq!(r.totals.kept_zat, 380_000);
    // R12 states plainly what it cannot see
    assert!(r.results.iter().find(|x| x.id == "R12").unwrap().details[0].contains("cannot be seen"));
}

#[test]
fn undersubscribed_auction_pays_the_reserve_and_low_bids_do_not_win() {
    let mut f = base(3);
    f.rules.reserve_zat = Some(100_000); // net bids must reach 100k: gross 110k
    f.id = hex::encode(f.rules.id().unwrap());
    let a = f.note(1, 300_000, 110, f.good_memo(1));
    let b = f.note(2, 200_000, 111, f.good_memo(2));
    let low = f.note(3, 100_000, 112, f.good_memo(3)); // net 90k < reserve
    let l = f.ledger(vec![f.entry("issue", &a), f.entry("issue", &b), f.entry("issue", &low), close_u(&f, vec![nf(&a), nf(&b)], 100_000)]);
    let notes = vec![spent(a, "s-a", 203), spent(b, "s-b", 203), spent(low, "t", 204)];
    let r = run(&f, &l, &notes, &[], &Extra::default(), 207);
    let an = analyze(&f.rules, &f.id, &l, &notes, &[]);
    assert_eq!(an.plan.unwrap().price_zat, 100_000);
    assert!(!failing(&r).contains(&"R7"), "{:?}", by_id(&r, "R7").details);
}

#[test]
fn wrong_clearing_price_in_the_close_entry_fails_r7() {
    let u = u();
    let (_, notes, extra) = honest(&u);
    let f = &u.f;
    let l = f.ledger(vec![
        f.entry("issue", &u.a), f.entry("issue", &u.b), f.entry("issue", &u.c),
        close_u(f, vec![nf(&u.a), nf(&u.b)], 290_000), // pay-your-bid price for the top bid
        settle(f, &u.a, "settle-a", 190_000, 100_000), settle(f, &u.b, "settle-b", 190_000, 0),
    ]);
    assert_eq!(failing(&run(f, &l, &notes, &[], &extra, 220)), vec!["R7"]);
}

#[test]
fn host_charging_the_wrong_price_fails_r9_and_r10() {
    let u = u();
    let (_, notes, mut extra) = honest(&u);
    let f = &u.f;
    // the host takes 200k from A (its own bid minus the fee is 290k; the clearing price is 190k) and says so
    let l = f.ledger(vec![
        f.entry("issue", &u.a), f.entry("issue", &u.b), f.entry("issue", &u.c),
        close_u(f, vec![nf(&u.a), nf(&u.b)], 190_000),
        settle(f, &u.a, "settle-a", 200_000, 90_000), settle(f, &u.b, "settle-b", 190_000, 0),
    ]);
    extra.treasury_notes[0] = tnote("settle-a", 200_000);
    let r = run(f, &l, &notes, &[], &extra, 220);
    assert_eq!(failing(&r), vec!["R9", "R10"]);
}

#[test]
fn treasury_short_and_treasury_over_fail_r9_and_r10() {
    let u = u();
    let (l, notes, mut extra) = honest(&u);
    extra.treasury_notes[1] = tnote("settle-b", 180_000);
    assert_eq!(failing(&run(&u.f, &l, &notes, &[], &extra, 220)), vec!["R9", "R10"]);
    let (l, notes, mut extra) = honest(&u);
    extra.treasury_notes[1] = tnote("settle-b", 200_000);
    assert_eq!(failing(&run(&u.f, &l, &notes, &[], &extra, 220)), vec!["R9", "R10"]);
    // the treasury received nothing at all
    let (l, notes, mut extra) = honest(&u);
    extra.treasury_notes.remove(0);
    assert_eq!(failing(&run(&u.f, &l, &notes, &[], &extra, 220)), vec!["R9", "R10"]);
}

#[test]
fn extra_output_or_change_back_to_the_campaign_fails_r11() {
    let u = u();
    // a third action in the settlement
    let (l, notes, mut extra) = honest(&u);
    extra.tx_facts[0].ironwood_actions = 3;
    assert_eq!(failing(&run(&u.f, &l, &notes, &[], &extra, 220)), vec!["R11"]);
    // a note back to the campaign account (value returned to its own address)
    let (l, mut notes, extra) = honest(&u);
    notes.push(tnote("settle-a", 100_000));
    assert_eq!(failing(&run(&u.f, &l, &notes, &[], &extra, 220)), vec!["R11"]);
    // a zero-valued padding note moves nothing and is allowed
    let (l, mut notes, extra) = honest(&u);
    notes.push(tnote("settle-b", 0));
    assert!(run(&u.f, &l, &notes, &[], &extra, 220).all_pass());
    // a transparent part, or the wrong fee
    let (l, notes, mut extra) = honest(&u);
    extra.tx_facts[1].has_transparent = true;
    assert_eq!(failing(&run(&u.f, &l, &notes, &[], &extra, 220)), vec!["R11"]);
    let (l, notes, mut extra) = honest(&u);
    extra.tx_facts[0].fee_zat = 15_000;
    assert_eq!(failing(&run(&u.f, &l, &notes, &[], &extra, 220)), vec!["R9"]);
}

fn disclosure(u: &U, delivered: Vec<u64>, matches: bool) -> (Challenge, DisclosureCheck) {
    let mut c = challenge(&u.a, 1);
    c.uivk = Some("uivktest1winner".into());
    let chk = DisclosureCheck { txid: u.a.txid.clone(), action: u.a.action, key_matches_refund: matches, delivered, error: None };
    (c, chk)
}

#[test]
fn diverted_excess_is_caught_only_with_the_winners_disclosure() {
    let u = u();
    let (l, notes, mut extra) = honest(&u);
    // Without a disclosure the diversion cannot be seen: everything passes, and R12 says so plainly.
    let r = run(&u.f, &l, &notes, &[], &extra, 220);
    assert!(r.all_pass());
    // A complaint without evidence is only a warning.
    let mut complaint = challenge(&u.a, 1);
    complaint.complaint = true;
    let r = run(&u.f, &l, &notes, &[complaint], &extra, 220);
    assert!(r.all_pass());
    assert_eq!(r.auction.as_ref().unwrap().complaints, 1);
    assert!(r.warnings.iter().any(|w| w.contains("cannot be verified")));
    // With the winner's viewing key the diversion is a FAIL with evidence.
    let (c, chk) = disclosure(&u, vec![], true);
    extra.checks = vec![chk];
    let r = run(&u.f, &l, &notes, &[c], &extra, 220);
    assert_eq!(failing(&r), vec!["R12"]);
    assert!(r.results.iter().find(|x| x.id == "R12").unwrap().details[0].contains("excess not delivered"));
    // The honest case: the key opens an output of exactly the excess.
    let (c, chk) = disclosure(&u, vec![100_000], true);
    extra.checks = vec![chk];
    let r = run(&u.f, &l, &notes, &[c], &extra, 220);
    assert!(r.all_pass());
    assert_eq!(r.auction.unwrap().proofs_ok, 1);
}

#[test]
fn a_disclosure_key_that_does_not_match_the_refund_address_is_ignored() {
    let u = u();
    let (l, notes, mut extra) = honest(&u);
    let (c, chk) = disclosure(&u, vec![], false);
    extra.checks = vec![chk];
    let r = run(&u.f, &l, &notes, &[c], &extra, 220);
    assert!(r.all_pass());
    assert!(r.warnings.iter().any(|w| w.contains("does not belong to the refund address")));
    // someone who cannot open the payload is not the winner: ignored entirely
    let mut stranger = challenge(&u.a, 99);
    stranger.complaint = true;
    let r = run(&u.f, &l, &notes, &[stranger], &extra, 220);
    assert_eq!(r.auction.unwrap().complaints, 0);
}

#[test]
fn tie_order_follows_the_chain_not_the_ledger_or_the_hosts_choice() {
    let f = base(1);
    let mut x = f.note(1, 300_000, 110, f.good_memo(1));
    let mut y = f.note(2, 300_000, 110, f.good_memo(2));
    x.tx_index = Some(5);
    y.tx_index = Some(2); // earlier in the same block: y wins the tie
    let l = f.ledger(vec![f.entry("issue", &x), f.entry("issue", &y), close_u(&f, vec![nf(&y)], 290_000)]);
    let notes = vec![spent(x.clone(), &ticket_of(&x), 204), spent(y.clone(), "s-y", 203)];
    let r = run(&f, &l, &notes, &[], &Extra::default(), 207);
    assert!(!failing(&r).contains(&"R7"), "{:?}", by_id(&r, "R7").details);
    // the ledger lists x first, but the chain says y; a host that declares x the winner is caught
    let l = f.ledger(vec![f.entry("issue", &x), f.entry("issue", &y), close_u(&f, vec![nf(&x)], 290_000)]);
    let r = run(&f, &l, &notes, &[], &Extra::default(), 207);
    assert!(failing(&r).contains(&"R7"));
    // same ledger in the other order: same recomputed winner
    let l = f.ledger(vec![f.entry("issue", &y), f.entry("issue", &x), close_u(&f, vec![nf(&y)], 290_000)]);
    assert!(!failing(&run(&f, &l, &notes, &[], &Extra::default(), 207)).contains(&"R7"));
}

#[test]
fn a_defaulted_winner_is_listed_but_is_not_a_failure() {
    let u = u();
    let (_, mut notes, mut extra) = honest(&u);
    let f = &u.f;
    // A takes its own refund ticket at block 204 (inside the settlement window), before settlement
    notes[0] = spent(u.a.clone(), &ticket_of(&u.a), 204);
    let l = f.ledger(vec![
        f.entry("issue", &u.a), f.entry("issue", &u.b), f.entry("issue", &u.c),
        close_u(f, vec![nf(&u.a), nf(&u.b)], 190_000), // price still from the bids unspent at the deadline
        settle(f, &u.b, "settle-b", 190_000, 0),
    ]);
    extra.treasury_notes = vec![tnote("settle-b", 190_000)];
    extra.tx_facts = vec![facts("settle-b")];
    let r = run(f, &l, &notes, &[], &extra, 220);
    assert!(r.all_pass(), "{:?}", r.results.iter().filter(|x| !x.pass).map(|x| &x.details).collect::<Vec<_>>());
    let a = r.auction.unwrap();
    assert_eq!((a.defaulted.len(), a.settled, a.treasury_total_zat), (1, 1, 190_000));
    assert!(r.warnings.iter().any(|w| w.contains("defaulted") && w.contains("no promotion")));
}

#[test]
fn a_note_taken_back_before_the_deadline_is_a_withdrawal_not_a_bid() {
    let u = u();
    let (l, mut notes, extra) = honest(&u);
    // A withdrew with its ticket at block 190 (before the deadline 200): B and C are now the bids
    notes[0] = spent(u.a.clone(), &ticket_of(&u.a), 190);
    let an = analyze(&u.f.rules, &u.f.id, &l, &notes, &[]);
    assert_eq!(an.plan.unwrap().winners, vec![nf(&u.b), nf(&u.c)]);
    let _ = extra;
}

#[test]
fn late_or_missing_settlement_fails_r9_and_a_late_self_refund_is_the_hosts_failure() {
    let u = u();
    // not settled by deadline + K
    let (l, mut notes, extra) = honest(&u);
    notes[1].spent_by = None;
    assert!(failing(&run(&u.f, &l, &notes, &[], &extra, 220)).contains(&"R9"));
    // still inside the window: waiting, not a failure
    assert!(!failing(&run(&u.f, &l, &notes, &[], &extra, 209)).contains(&"R9"));
    // settled late (block 215 > 210)
    let (l, mut notes, extra) = honest(&u);
    notes[1] = spent(u.b.clone(), "settle-b", 215);
    assert!(failing(&run(&u.f, &l, &notes, &[], &extra, 220)).contains(&"R9"));
    // winner self-refunded after the window because the host never settled: the host's failure
    let (l, mut notes, extra) = honest(&u);
    notes[1] = spent(u.b.clone(), &ticket_of(&u.b), 212);
    let r = run(&u.f, &l, &notes, &[], &extra, 220);
    assert!(failing(&r).contains(&"R9"));
}

#[test]
fn a_settlement_entry_that_lies_fails_r9() {
    let u = u();
    let (_, notes, extra) = honest(&u);
    let f = &u.f;
    let l = f.ledger(vec![
        f.entry("issue", &u.a), f.entry("issue", &u.b), f.entry("issue", &u.c),
        close_u(f, vec![nf(&u.a), nf(&u.b)], 190_000),
        settle(f, &u.a, "settle-a", 190_000, 90_000), // wrong excess
        settle(f, &u.b, "settle-b", 190_000, 0),
    ]);
    assert_eq!(failing(&run(f, &l, &notes, &[], &extra, 220)), vec!["R9"]);
    // no settlement entry at all
    let l = f.ledger(vec![f.entry("issue", &u.a), f.entry("issue", &u.b), f.entry("issue", &u.c), close_u(f, vec![nf(&u.a), nf(&u.b)], 190_000)]);
    assert_eq!(failing(&run(f, &l, &notes, &[], &extra, 220)), vec!["R9"]);
    let _ = Close { close_height: 0, outcome: String::new(), winners: None, ufvk: None, amount_key: None, clearing_price_zat: None };
}

#[test]
fn settlement_window_has_bounds_and_only_applies_to_uniform_auctions() {
    let mut f = base(2);
    f.rules.settle_window = Some(40);
    assert!(f.rules.validate().is_ok());
    assert_eq!(f.rules.settle_by(), 240);
    f.rules.settle_window = Some(5); // below K
    assert!(f.rules.validate().is_err());
    f.rules.settle_window = Some(crate::rules::MAX_SETTLE_WINDOW + 1);
    assert!(f.rules.validate().is_err());
    let mut raise = fx("raise");
    raise.rules.settle_window = Some(40);
    assert!(raise.rules.validate().is_err());
}

#[test]
fn a_rebuilt_settlement_counts_by_its_latest_entry_and_an_announced_but_unmined_one_fails() {
    let u = u();
    let (_, notes, extra) = honest(&u);
    let f = &u.f;
    // the host announced a settlement for A that died, then rebuilt it: two entries, the latest is the truth
    let l = f.ledger(vec![
        f.entry("issue", &u.a), f.entry("issue", &u.b), f.entry("issue", &u.c),
        close_u(f, vec![nf(&u.a), nf(&u.b)], 190_000),
        settle(f, &u.a, "dead-tx", 190_000, 100_000), settle(f, &u.a, "settle-a", 190_000, 100_000), settle(f, &u.b, "settle-b", 190_000, 0),
    ]);
    assert!(run(f, &l, &notes, &[], &extra, 220).all_pass());
    // announced, never reached the chain, window over: R9 says so and the winner may self-refund
    let mut notes = notes;
    notes[0].spent_by = None;
    let r = run(f, &l, &notes, &[], &extra, 220);
    assert_eq!(failing(&r), vec!["R9"]); // R10 counts only winners that were settled on chain
    assert!(r.results.iter().find(|x| x.id == "R9").unwrap().details.iter().any(|d| d.contains("announced but never reached the chain")));
}
