//! Fake campaigns with one kind of misconduct each; the recount must flag exactly it.

use super::*;
use crate::{
    keys::{CampaignSecrets, ContributorKeys},
    ledger::{Close, Contribution, Entry, Ticket, amount_commit},
    payload::Payload,
    rules::ufvk_hash,
};

const UFVK: &str = "uvftest1example";

struct Fx {
    /// amount sealed into the memos this fixture makes (None: old-format memos without an amount)
    amount: Option<u64>,
    rules: Rules,
    id: String,
    secrets: CampaignSecrets,
    amount_key: [u8; 32],
}

fn fx(mode: &str) -> Fx {
    let secrets = CampaignSecrets { ledger_sk: hex::encode([1u8; 32]), payload_sk: hex::encode([2u8; 32]), amount_key: None };
    let auction = mode == "auction";
    let rules = Rules {
        v: 1, network: "test".into(), mode: mode.into(),
        goal_zat: (!auction).then_some(2_000_000), items: auction.then_some(1),
        start_height: 100, deadline_height: 200, ticket_k: 10, close_grace: 10, reissue_window: 20,
        refund_fee_zat: 10_000, min_contribution_zat: 20_000,
        campaign_ufvk: (!auction).then(|| UFVK.into()), ufvk_hash: auction.then(|| ufvk_hash(UFVK)),
        pay_to: None, pricing: None, settle_window: None, reserve_zat: None, treasury_address: None, treasury_ufvk: None,
        name: None,
        ledger_pubkey: secrets.ledger_pubkey_hex().unwrap(), payload_pubkey: secrets.payload_pubkey_hex().unwrap(),
    };
    let id = hex::encode(rules.id().unwrap());
    Fx { amount: None, rules, id, secrets, amount_key: [3u8; 32] }
}

impl Fx {
    /// A real payload memo for this campaign, sealed with `seed`'s one-time key.
    fn memo(&self, seed: u8, rules_id: [u8; 32]) -> String {
        let k = ContributorKeys { seed: [seed; 32] };
        Payload { rules_id, sign_pubkey: [0; 32], enc_pubkey: [0; 32], refund_typecode: 3, refund_receiver: [0; 43], amount_zat: self.amount }
            .to_memo(&hex32(&self.rules.payload_pubkey).unwrap(), &k.memo_ephemeral_key())
            .unwrap()
    }

    fn good_memo(&self, seed: u8) -> String {
        self.memo(seed, hex32(&self.id).unwrap())
    }

    fn note(&self, i: u8, value: u64, height: u32, memo: String) -> ChainNote {
        ChainNote {
            txid: hex::encode([i; 32]), action: 0, value_zat: value, nf: Some(hex::encode([i + 100; 32])),
            height: Some(height), tx_index: None, memo_text: Some(memo), is_change: false, spent_by: None,
        }
    }

    fn entry(&self, kind: &str, n: &ChainNote) -> Entry {
        let mut e = Entry::new(&self.id, kind);
        let nf = n.nf.clone().unwrap();
        e.contribution = Some(Contribution {
            txid: n.txid.clone(), action: n.action, nf: nf.clone(), height: n.height.unwrap(),
            value_zat: (!self.rules.is_auction()).then_some(n.value_zat),
            amount_commit: self.rules.is_auction().then(|| amount_commit(&self.amount_key, &nf, n.value_zat).unwrap()),
        });
        if kind == "reject" {
            e.reason = Some("payload does not open".into());
        } else {
            e.ticket = Some(Ticket { txid: format!("ticket-{}", n.txid), issue_height: n.height.unwrap() + 1, branch_id: "77190ad9".into() });
        }
        e
    }

    fn close(&self, outcome: &str, winners: Option<Vec<String>>) -> Entry {
        let mut e = Entry::new(&self.id, "close");
        let auction = self.rules.is_auction();
        e.close = Some(Close {
            close_height: 205, outcome: outcome.into(), winners,
            ufvk: auction.then(|| UFVK.into()), amount_key: auction.then(|| hex::encode(self.amount_key)), clearing_price_zat: None,
        });
        e
    }

    /// Signs and chains entries like the host does.
    fn ledger(&self, entries: Vec<Entry>) -> Vec<Entry> {
        let sk = self.secrets.ledger_key().unwrap();
        let mut out: Vec<Entry> = vec![];
        for mut e in entries {
            e.seq = out.len() as u64;
            e.prev = out.last().map_or(GENESIS_PREV.into(), |p| p.hash().unwrap());
            e.sign(&sk).unwrap();
            out.push(e);
        }
        out
    }

    fn run(&self, ledger: &[Entry], notes: &[ChainNote], challenges: &[Challenge], tip: u32) -> Report {
        recount(&self.rules, &self.id, ledger, notes, challenges, tip, true)
    }
}

fn spent(mut n: ChainNote, txid: &str, h: u32) -> ChainNote {
    n.spent_by = Some(Spend { txid: txid.into(), height: Some(h) });
    n
}

fn ticket_of(n: &ChainNote) -> String {
    format!("ticket-{}", n.txid)
}

fn failing(r: &Report) -> Vec<&'static str> {
    r.results.iter().filter(|x| !x.pass).map(|x| x.id).collect()
}

impl Fx {
    /// a note with the default test txid for index `i` (used to build a challenge for a note made elsewhere)
    fn dummy(f: &Fx, i: u8) -> ChainNote { f.note(i, 1, 100, String::new()) }
}

fn challenge(n: &ChainNote, seed: u8) -> Challenge {
    let esk = ContributorKeys { seed: [seed; 32] }.memo_ephemeral_key();
    Challenge { txid: n.txid.clone(), action: n.action, eph_sk: hex::encode(esk.to_bytes()), uivk: None, complaint: false }
}

// ---- raise ----

#[test]
fn honest_raise_open_passes_and_donations_are_separate() {
    let f = fx("raise");
    let a = f.note(1, 1_000_000, 110, f.good_memo(1));
    let gift = f.note(2, 500_000, 120, "thanks!".into());
    let l = f.ledger(vec![f.entry("issue", &a)]);
    let r = f.run(&l, &[a, gift], &[], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.donations, r.totals.donations_zat), (1, 1, 500_000));
}

#[test]
fn a_payment_below_the_smallest_contribution_is_a_donation_with_no_ticket_and_no_ledger_entry() {
    // the contributor page refuses such an amount, but a wallet can still send it: the campaign sets it aside without writing anything, and
    // the recount lists it under donations (not refundable) while every check still passes
    let f = fx("raise");
    let ok = f.note(1, 1_000_000, 110, f.good_memo(1));
    let small = f.note(2, 10_000, 120, f.good_memo(2)); // a well-formed message, but below min_contribution_zat (20 000)
    let l = f.ledger(vec![f.entry("issue", &ok)]);
    let r = f.run(&l, &[ok, small], &[], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.donations, r.totals.donations_zat), (1, 1, 10_000));
    assert_eq!(l.len(), 1, "no entry was written for the small payment");
}

#[test]
fn early_spend_by_non_ticket_fails_r5() {
    let f = fx("raise");
    let a = f.note(1, 1_000_000, 110, f.good_memo(1));
    let l = f.ledger(vec![f.entry("issue", &a)]);
    assert_eq!(failing(&f.run(&l, &[spent(a, "cheat", 150)], &[], 160)), vec!["R5"]);
}

#[test]
fn early_withdrawal_by_ticket_passes_and_lowers_the_net_raise() {
    let f = fx("raise");
    let (a, b) = (f.note(1, 1_500_000, 110, f.good_memo(1)), f.note(2, 1_000_000, 111, f.good_memo(2)));
    let l = f.ledger(vec![f.entry("issue", &a), f.entry("issue", &b), f.close("goal_missed", None)]);
    let ta = ticket_of(&a);
    let r = f.run(&l, &[spent(a, &ta, 150), b], &[], 206);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!(r.totals.withdrawn_zat, 1_500_000);
    assert_eq!(r.goal_met, Some(false)); // 2.5M raised, but only 1.0M left at the deadline
}

#[test]
fn goal_met_sweep_passes_and_counts_as_kept() {
    let f = fx("raise");
    let (a, b) = (f.note(1, 1_500_000, 110, f.good_memo(1)), f.note(2, 1_000_000, 111, f.good_memo(2)));
    let l = f.ledger(vec![f.entry("issue", &a), f.entry("issue", &b), f.close("goal_met", None)]);
    let r = f.run(&l, &[spent(a, "sweep", 206), spent(b, "sweep", 206)], &[], 210);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!(r.totals.kept_zat, 2_500_000);
}

#[test]
fn goal_missed_keeping_money_fails_r6_and_lying_about_the_outcome_fails_r7() {
    let f = fx("raise");
    let a = f.note(1, 1_000_000, 110, f.good_memo(1));
    let l = f.ledger(vec![f.entry("issue", &a), f.close("goal_met", None)]);
    let r = f.run(&l, &[spent(a, "sweep", 206)], &[], 210);
    assert_eq!(failing(&r), vec!["R6", "R7"]);
}

#[test]
fn goal_missed_refunds_pass() {
    let f = fx("raise");
    let a = f.note(1, 1_000_000, 110, f.good_memo(1));
    let l = f.ledger(vec![f.entry("issue", &a), f.close("goal_missed", None)]);
    let t = ticket_of(&a);
    let r = f.run(&l, &[spent(a, &t, 206)], &[], 210);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!(r.totals.refunded_zat, 1_000_000);
}

#[test]
fn reissued_ticket_is_honest_too() {
    let f = fx("raise");
    let a = f.note(1, 1_000_000, 110, f.good_memo(1));
    let mut re = f.entry("reissue", &a);
    re.ticket.as_mut().unwrap().txid = "reissued".into();
    let l = f.ledger(vec![f.entry("issue", &a), re]);
    assert!(f.run(&l, &[spent(a, "reissued", 150)], &[], 160).all_pass());
}

#[test]
fn tampered_dropped_or_foreign_entries_fail() {
    let f = fx("raise");
    let (a, b) = (f.note(1, 1_000_000, 110, f.good_memo(1)), f.note(2, 1_000_000, 111, f.good_memo(2)));
    let mut l = f.ledger(vec![f.entry("issue", &a), f.entry("issue", &b)]);
    l[1].contribution.as_mut().unwrap().value_zat = Some(1); // edited after signing
    assert!(failing(&f.run(&l, &[a.clone(), b.clone()], &[], 150)).contains(&"R2"));
    let l = f.ledger(vec![f.entry("issue", &a), f.entry("issue", &b)]);
    assert!(failing(&f.run(&l[1..], &[a.clone(), b.clone()], &[], 150)).contains(&"R2"));
    assert!(failing(&recount(&f.rules, &"00".repeat(32), &l, &[a, b], &[], 150, true)).contains(&"R1"));
}

#[test]
fn missing_ticket_fails_r4_only_after_k_blocks() {
    let f = fx("raise");
    let a = f.note(1, 1_000_000, 110, f.good_memo(1));
    assert!(f.run(&[], &[a.clone()], &[], 115).all_pass());
    assert_eq!(failing(&f.run(&[], &[a], &[], 121)), vec!["R4"]);
}

#[test]
fn closing_before_the_deadline_fails_r2() {
    let f = fx("raise");
    let mut c = f.close("goal_missed", None);
    c.close.as_mut().unwrap().close_height = 150;
    assert!(failing(&f.run(&f.ledger(vec![c]), &[], &[], 210)).contains(&"R2"));
}

// ---- rejects and challenges ----

#[test]
fn false_reject_is_exposed_by_the_contributor_secret() {
    let f = fx("raise");
    let a = f.note(1, 1_000_000, 110, f.good_memo(7));
    let l = f.ledger(vec![f.entry("reject", &a)]);
    // Without a challenge the reject stands and the payment is a donation.
    let r = f.run(&l, &[a.clone()], &[], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!(r.totals.donations, 1);
    // A challenge with the wrong secret proves nothing.
    assert!(f.run(&l, &[a.clone()], &[challenge(&a, 6)], 150).all_pass());
    // With the contributor's published secret, anyone can see the payload was valid.
    let r = f.run(&l, &[a.clone()], &[challenge(&a, 7)], 115);
    assert_eq!(failing(&r), vec!["R8"]);
    assert!(r.results[7].details[0].contains("opens a valid payload"));
    // ...and once K blocks pass without a ticket, R4 fails too.
    assert_eq!(failing(&f.run(&l, &[a.clone()], &[challenge(&a, 7)], 121)), vec!["R4", "R8"]);
}

#[test]
fn genuine_garbage_memo_reject_is_upheld_even_when_challenged() {
    let f = fx("raise");
    // Sealed for another campaign: it has the right shape but cannot be accepted here.
    let other = f.note(1, 1_000_000, 110, f.memo(8, [9u8; 32]));
    // Random bytes with the right shape: nobody can open it.
    let mut junk = format!("{}{}", crate::payload::PREFIX, "A".repeat(252));
    junk.truncate(256);
    let garbage = f.note(2, 1_000_000, 111, junk);
    assert!(crate::payload::is_payload_shaped(garbage.memo_text.as_deref().unwrap()));
    let l = f.ledger(vec![f.entry("reject", &other), f.entry("reject", &garbage)]);
    let r = f.run(&l, &[other.clone(), garbage.clone()], &[challenge(&other, 8), challenge(&garbage, 3)], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.donations), (0, 2));
}

#[test]
fn rejecting_a_payment_without_an_ll1_memo_fails_r3() {
    let f = fx("raise");
    let gift = f.note(1, 1_000_000, 110, "hello".into());
    let l = f.ledger(vec![f.entry("reject", &gift)]);
    assert_eq!(failing(&f.run(&l, &[gift], &[], 150)), vec!["R3"]);
}

// ---- auction ----

fn auction_bids(f: &Fx) -> (ChainNote, ChainNote, ChainNote) {
    (f.note(1, 1_000_000, 110, f.good_memo(1)), f.note(2, 3_000_000, 111, f.good_memo(2)), f.note(3, 2_000_000, 112, f.good_memo(3)))
}

#[test]
fn honest_auction_passes() {
    let f = fx("auction");
    let (a, b, c) = auction_bids(&f);
    let winners = Some(vec![b.nf.clone().unwrap()]);
    let l = f.ledger(vec![f.entry("issue", &a), f.entry("issue", &b), f.entry("issue", &c), f.close("auction", winners)]);
    let (ta, tc) = (ticket_of(&a), ticket_of(&c));
    let r = f.run(&l, &[spent(a, &ta, 206), spent(b, "sweep", 206), spent(c, &tc, 207)], &[], 210);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.kept_zat, r.totals.refunded_zat), (3_000_000, 3_000_000));
}

#[test]
fn auction_sweeping_a_loser_fails_r6_and_wrong_winners_fail_r7() {
    let f = fx("auction");
    let (a, b, c) = auction_bids(&f);
    let wrong = Some(vec![c.nf.clone().unwrap()]);
    let l = f.ledger(vec![f.entry("issue", &a), f.entry("issue", &b), f.entry("issue", &c), f.close("auction", wrong)]);
    let r = f.run(&l, &[a, b, spent(c, "sweep", 206)], &[], 210);
    assert_eq!(failing(&r), vec!["R6", "R7"]);
}

#[test]
fn auction_ledger_never_reveals_bids_and_commitments_are_checked() {
    let f = fx("auction");
    let (a, b, c) = auction_bids(&f);
    let mut leaky = f.entry("issue", &a);
    leaky.contribution.as_mut().unwrap().value_zat = Some(a.value_zat);
    let mut lying = f.entry("issue", &b);
    lying.contribution.as_mut().unwrap().amount_commit = Some(amount_commit(&f.amount_key, b.nf.as_deref().unwrap(), 1).unwrap());
    let winners = Some(vec![b.nf.clone().unwrap()]);
    let l = f.ledger(vec![leaky, lying, f.entry("issue", &c), f.close("auction", winners)]);
    let r = f.run(&l, &[a, b, c], &[], 210);
    assert_eq!(failing(&r), vec!["R3"]);
    assert_eq!(r.results[2].details.len(), 2);
}

#[test]
fn auction_reveal_must_match_the_committed_key_and_is_sealed_until_then() {
    let f = fx("auction");
    let mut c = f.close("auction", Some(vec![]));
    c.close.as_mut().unwrap().ufvk = Some("uvftest1someotherkey".into());
    assert!(failing(&f.run(&f.ledger(vec![c]), &[], &[], 210)).contains(&"R1"));
    let sealed = recount(&f.rules, &f.id, &[], &[], &[], 150, false);
    assert!(sealed.all_pass());
    assert!(sealed.results[3].details[0].contains("waiting"));
}

#[test]
fn node_printed_nullifiers_are_reversed() {
    assert_eq!(reverse_hex("0102").unwrap(), "0201");
}

#[test]
fn sweeping_a_rejected_payment_warns_with_the_amount_but_does_not_fail() {
    let f = fx("raise");
    let a = f.note(1, 1_250_000, 110, f.good_memo(7));
    let l = f.ledger(vec![f.entry("reject", &a)]);
    // Unspent: no warning.
    assert!(f.run(&l, &[a.clone()], &[], 150).warnings.is_empty());
    // The host moves it: still PASS (the reject stands), but the warning names the amount.
    let r = f.run(&l, &[spent(a.clone(), "host-spend", 160)], &[], 170);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!(r.warnings.len(), 1);
    assert!(r.warnings[0].contains("1250000 zat") && r.warnings[0].contains("host-spend"));
    // A challenge is valid at any time, including after the host spent the money.
    let r = f.run(&l, &[spent(a.clone(), "host-spend", 160)], &[challenge(&a, 7)], 100_000);
    assert!(failing(&r).contains(&"R8"));
}

mod uniform;

// ---- replayed payloads: the same sealed message twice ----

#[test]
fn a_replayed_payload_is_one_contribution_and_one_donation_with_a_plain_note() {
    let f = fx("raise");
    let original = f.note(1, 1_000_000, 110, f.good_memo(1));
    let mut copy = f.note(2, 400_000, 120, f.good_memo(1)); // the very same sealed message, paid again later
    copy.nf = Some(hex::encode([202u8; 32]));
    let l = f.ledger(vec![f.entry("issue", &original), f.entry("reject", &copy)]);
    let r = f.run(&l, &[original.clone(), copy.clone()], &[], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.donations, r.totals.donations_zat), (1, 1, 400_000));
    assert!(r.warnings.iter().any(|w| w.contains("repeated the sealed message of an earlier payment") && w.contains("400000 zat")), "{:?}", r.warnings);
}

#[test]
fn a_host_that_tickets_the_replay_fails_and_a_challenge_cannot_revive_it() {
    let f = fx("raise");
    let original = f.note(1, 1_000_000, 110, f.good_memo(1));
    let mut copy = f.note(2, 400_000, 120, f.good_memo(1));
    copy.nf = Some(hex::encode([202u8; 32]));
    // a second ticket for the copy: it is not a contribution
    let l = f.ledger(vec![f.entry("issue", &original), f.entry("issue", &copy)]);
    assert!(failing(&f.run(&l, &[original.clone(), copy.clone()], &[], 150)).contains(&"R3"));
    // the sender of the original publishes the one-time secret for the copy's memo: it still does not become a contribution
    let l = f.ledger(vec![f.entry("issue", &original), f.entry("reject", &copy)]);
    let r = f.run(&l, &[original.clone(), copy.clone()], &[challenge(&copy, 1)], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!(r.totals.contributions, 1);
}

#[test]
fn the_earliest_payment_by_chain_order_is_the_original_even_in_the_same_block() {
    let f = fx("raise");
    let mut a = f.note(1, 1_000_000, 110, f.good_memo(1));
    let mut b = f.note(2, 1_000_000, 110, f.good_memo(1));
    a.tx_index = Some(5);
    b.tx_index = Some(2); // b is earlier in the same block, so b is the original
    let l = f.ledger(vec![f.entry("issue", &b), f.entry("reject", &a)]);
    let r = f.run(&l, &[a.clone(), b.clone()], &[], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    // a host that tickets the later one and rejects the earlier one cannot be told apart publicly (a reject does not use up the message), but
    // the earlier payment's owner can challenge the reject: its payload is valid, so it is a false reject (R8)
    let l = f.ledger(vec![f.entry("issue", &a), f.entry("reject", &b)]);
    assert!(f.run(&l, &[a.clone(), b.clone()], &[], 150).all_pass());
    assert!(failing(&f.run(&l, &[a, b.clone()], &[challenge(&b, 1)], 150)).contains(&"R8"));
}

#[test]
fn different_payloads_and_garbage_are_not_replays() {
    let f = fx("raise");
    let x = f.note(1, 1_000_000, 110, f.good_memo(1));
    let y = f.note(2, 1_000_000, 111, f.good_memo(2));
    let l = f.ledger(vec![f.entry("issue", &x), f.entry("issue", &y)]);
    let r = f.run(&l, &[x, y], &[], 150);
    assert!(r.all_pass() && r.warnings.is_empty(), "{:?}", r.warnings);
}

/// KNOWN LIMITATION (SPEC §2): the payload does not bind the payment. Anyone who can read a pending payment's sealed message
/// (a fundraiser's viewing key is public) can copy it into a payment that mines first; the original contributor's payment then
/// becomes the "replay" and is set aside as a donation, and the ticket goes to the contributor's refund address for the COPIER's
/// payment. The recount cannot tell which of the two identical messages was sent first by the real contributor; it states the
/// outcome plainly and names both payments with their amounts, and the contributor's page notices the amount does not match.
#[test]
fn a_message_copied_into_an_earlier_payment_takes_the_contributors_place_but_is_visible() {
    let f = fx("raise");
    let victim = f.note(1, 5_000_000, 120, f.good_memo(1)); // the real contributor pays 0.05, mined at 120
    let mut copier = f.note(2, 20_000, 119, f.good_memo(1)); // someone copies the message into a minimum payment that mines at 119
    copier.nf = Some(hex::encode([202u8; 32]));
    // an honest host follows the rule: the copy is the contribution, the real payment is set aside
    let l = f.ledger(vec![f.entry("issue", &copier), f.entry("reject", &victim)]);
    let r = f.run(&l, &[victim.clone(), copier.clone()], &[], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.raised_zat, r.totals.donations_zat), (1, 20_000, 5_000_000));
    let w = r.warnings.join(" ");
    assert!(w.contains("repeated the sealed message of an earlier payment") && w.contains("5000000 zat"), "{w}");
    // a host that rejects the earlier payment and tickets the later one: a reject does not use up the message, so this is consistent for
    // the public (it cannot see why); the contributor's published secret shows the earlier payment was a valid contribution after all (R8)
    let l = f.ledger(vec![f.entry("issue", &victim), f.entry("reject", &copier)]);
    assert!(f.run(&l, &[victim.clone(), copier.clone()], &[], 150).all_pass());
    assert!(failing(&f.run(&l, &[victim, copier.clone()], &[challenge(&copier, 1)], 150)).contains(&"R8"));
}

// ---- amount bound into the payload (SPEC §2, payload version 2): "at least the intended amount" ----

fn v2fx(amount: u64) -> Fx {
    let mut f = fx("raise");
    f.amount = Some(amount);
    f
}

#[test]
fn a_copier_paying_less_does_not_take_the_contributors_place() {
    let f = v2fx(1_000_000);
    let mut copy = f.note(2, 20_000, 119, f.good_memo(1)); // copies the message into a minimum payment that mines first
    copy.nf = Some(hex::encode([202u8; 32]));
    let victim = f.note(1, 1_000_000, 120, f.good_memo(1));
    // the honest host rejects the underpaid copy (it does not use up the message) and tickets the real payment
    let l = f.ledger(vec![f.entry("reject", &copy), f.entry("issue", &victim)]);
    let r = f.run(&l, &[victim.clone(), copy.clone()], &[], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.raised_zat, r.totals.donations_zat), (1, 1_000_000, 20_000));
    assert!(r.warnings.is_empty(), "the real payment is not a replay: {:?}", r.warnings);
    // a host that accepts the underpaid copy and sets the real payment aside passes publicly... until the contributor reveals the secret
    let l = f.ledger(vec![f.entry("issue", &copy), f.entry("reject", &victim)]);
    assert!(f.run(&l, &[victim.clone(), copy.clone()], &[], 150).all_pass(), "without the secret the public cannot see the promised amount");
    let r = f.run(&l, &[victim.clone(), copy.clone()], &[challenge(&copy, 1)], 150);
    assert_eq!(failing(&r), vec!["R8"]);
    assert!(r.results.iter().find(|x| x.id == "R8").unwrap().details.iter().any(|d| d.contains("promising at least 1000000") && d.contains("only 20000")));
}

#[test]
fn a_copier_paying_exactly_the_same_amount_still_wins_but_costs_them_the_whole_amount() {
    let f = v2fx(1_000_000);
    let mut copy = f.note(2, 1_000_000, 119, f.good_memo(1));
    copy.nf = Some(hex::encode([202u8; 32]));
    let victim = f.note(1, 1_000_000, 120, f.good_memo(1));
    // known and documented: the copy is the contribution (its ticket refunds the copier's money to the contributor's address)
    let l = f.ledger(vec![f.entry("issue", &copy), f.entry("reject", &victim)]);
    let r = f.run(&l, &[victim.clone(), copy.clone()], &[], 150);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.raised_zat, r.totals.donations_zat), (1, 1_000_000, 1_000_000));
    assert!(r.warnings.iter().any(|w| w.contains("repeated the sealed message of an earlier payment") && w.contains("1000000 zat")), "{:?}", r.warnings);
    // a challenge cannot revive the later payment: it is a repeat, not a new contribution
    assert!(f.run(&l, &[victim.clone(), copy.clone()], &[challenge(&victim, 1)], 150).all_pass());
}

#[test]
fn a_wallet_that_lowers_the_amount_makes_the_payment_a_donation_and_the_reject_is_justified() {
    let f = v2fx(1_000_000);
    let low = f.note(1, 900_000, 120, f.good_memo(1)); // the wallet edited the amount down
    let l = f.ledger(vec![f.entry("reject", &low)]);
    assert!(f.run(&l, &[low.clone()], &[], 150).all_pass());
    let r = f.run(&l, &[low.clone()], &[challenge(&low, 1)], 150);
    assert!(r.all_pass(), "a reject for being too small stands even when the contributor reveals the secret: {:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.donations_zat), (0, 900_000));
    // but rejecting a payment of exactly the sealed amount is a false reject, caught by the same challenge
    let exact = f.note(2, 1_000_000, 121, f.good_memo(2));
    let f2 = v2fx(1_000_000);
    let l = f2.ledger(vec![f2.entry("reject", &exact)]);
    assert!(failing(&f2.run(&l, &[exact.clone()], &[challenge(&exact, 2)], 150)).contains(&"R8"));
    // paying MORE than intended is fine
    let more = f.note(3, 1_500_000, 122, f.good_memo(3));
    let l = f.ledger(vec![f.entry("issue", &more)]);
    assert!(f.run(&l, &[more], &[challenge(&Fx::dummy(&f, 3), 3)], 150).all_pass());
}

#[test]
fn an_old_format_memo_still_works_and_stays_copyable() {
    let f = fx("raise"); // amount: None = version 1 payloads
    let tiny = f.note(1, 20_000, 110, f.good_memo(1));
    let l = f.ledger(vec![f.entry("issue", &tiny)]);
    let r = f.run(&l, &[tiny.clone()], &[challenge(&tiny, 1)], 150);
    assert!(r.all_pass(), "any amount counts for an old-format memo: {:?}", failing(&r));
    assert_eq!(r.totals.contributions, 1);
    // copyable: a copy of the old-format message that mines first takes the place (the known limitation, only for old-format memos)
    let mut copy = f.note(2, 20_000, 109, f.good_memo(1));
    copy.nf = Some(hex::encode([202u8; 32]));
    let real = f.note(3, 5_000_000, 111, f.good_memo(1));
    let l = f.ledger(vec![f.entry("issue", &copy), f.entry("reject", &real)]);
    let r = f.run(&l, &[copy, real], &[], 150);
    assert!(r.all_pass() && r.warnings.iter().any(|w| w.contains("repeated the sealed message")), "{:?}", r.warnings);
    assert!(crate::payload::sealed_bytes(&f.good_memo(1)).is_some_and(|b| b.len() == crate::payload::SEALED_LEN), "old format is 256 characters");
    assert!(crate::payload::sealed_bytes(&v2fx(1).good_memo(1)).is_some_and(|b| b.len() == crate::payload::SEALED_LEN_V2), "new format carries the amount");
}

#[test]
fn the_ticket_window_is_a_per_campaign_setting_within_bounds() {
    let mut r = fx("raise").rules;
    for k in [10, 30, 1000] { r.ticket_k = k; assert!(r.validate().is_ok(), "K = {k}"); }
    for k in [0, 9, 1001] { r.ticket_k = k; assert!(r.validate().is_err(), "K = {k}"); }
    // a different window is a different campaign: it is part of the committed rules
    let a = { r.ticket_k = 10; r.id().unwrap() };
    let b = { r.ticket_k = 30; r.id().unwrap() };
    assert_ne!(a, b);
}
