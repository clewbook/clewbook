//! Fake sealed bid auctions (SPEC §9) with one kind of misconduct each: the recount must flag exactly it. Bids are locked to a real quicknet
//! round and opened with its published signature; the cheating cases are those of research note 16 (B3 to B5, H1 to H6, CH1 to CH3).

use super::*;
use crate::{
    keys::{CampaignSecrets, ContributorKeys},
    ledger::{Close, Coin, Contribution, Reveal, Settle, Ticket},
    recount::{CoinFact, PaidOutput, PayoutFact, Spend, TxFacts, TxShape, recount_with},
    rules::ufvk_hash,
    sealed::{COIN_ZAT, CoinSending, QUICKNET_CHAIN_HASH, Sealed},
};

const UFVK: &str = "uviewtest1sealedcampaign";
const FEE: u64 = 10_000;
const RESERVE: u64 = 1_000_000;
const SMALL: u64 = 10_000_000;
const BIG: u64 = 30_000_000;
/// A real quicknet round and its published signature (the same as in `bid`'s tests).
const ROUND: u64 = 33_187_201;
const SIG: &str = "943614203a936e3d4ac466aa2b475e9c1e614f4759fe45b7f4bedeb0316d172e6cacadb08a46b39c67c09555dc6db3a5";
const SIG_1000: &str = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";
/// Start 100, deadline 200, coin cutoff 190, late tickets valid after 300.
const DEADLINE: u32 = 200;
const CLAIM_AFTER: u32 = 300;
const TIP: u32 = 400;

struct Sx {
    rules: Rules,
    id: String,
    secrets: CampaignSecrets,
    amount_key: [u8; 32],
}

struct Dep {
    note: ChainNote,
    memo: BidMemo,
    seed: u8,
}

/// One auction as the chain, the host and the relays would show it, before the list is signed.
struct Case {
    sx: Sx,
    deps: Vec<Dep>,
    entries: Vec<Entry>,
    notes: Vec<ChainNote>,
    extra: Extra,
    challenges: Vec<Challenge>,
    tip: u32,
}

fn sx(pricing: &str, items: u32) -> Sx {
    sx_with(pricing, items, false)
}

fn sx_with(pricing: &str, items: u32, open_payouts: bool) -> Sx {
    let secrets = CampaignSecrets { ledger_sk: hex::encode([11u8; 32]), payload_sk: hex::encode([12u8; 32]), amount_key: None };
    let rules = Rules {
        v: 1, network: "test".into(), mode: "sealed_auction".into(), goal_zat: None, items: Some(items),
        start_height: 100, deadline_height: DEADLINE, ticket_k: 10, close_grace: 10, reissue_window: 20,
        refund_fee_zat: FEE, min_contribution_zat: SMALL, campaign_ufvk: None, ufvk_hash: Some(ufvk_hash(UFVK)),
        pay_to: None, early_close: None, cancellable: None, cap_zat: None, name: None, pricing: None, settle_window: None, reserve_zat: Some(RESERVE),
        treasury_address: Some("utest1treasury".into()), treasury_ufvk: Some("uviewtest1treasury".into()),
        sealed: Some(Sealed {
            tranches_zat: vec![SMALL, BIG], pricing: pricing.into(), drand_chain: QUICKNET_CHAIN_HASH.into(), drand_round: ROUND,
            claim_after: CLAIM_AFTER, coin_zat: COIN_ZAT, coin_cutoff: 10, coin_sending: CoinSending::EveryBids { n: 3 }, timing: Default::default(), open_payouts, long_tag: open_payouts, early_key: open_payouts, late_key: open_payouts, coin_margin: if open_payouts { 10 } else { 0 },
        }),
        ledger_pubkey: secrets.ledger_pubkey_hex().unwrap(), payload_pubkey: secrets.payload_pubkey_hex().unwrap(),
    };
    rules.validate().unwrap();
    let id = hex::encode(rules.id().unwrap());
    Sx { rules, id, secrets, amount_key: [13u8; 32] }
}

impl Sx {
    fn rid(&self) -> [u8; 32] {
        hex32(&self.id).unwrap()
    }

    /// What a bid page writes: the sealed payload for `tranche`, and `bid` locked to round R with the tag for `tranche`.
    fn memo(&self, seed: u8, tranche: u64, bid: u64) -> BidMemo {
        let esk = ContributorKeys { seed: [seed; 32] }.memo_ephemeral_key();
        let p = Payload { rules_id: self.rid(), sign_pubkey: [0; 32], enc_pubkey: [0; 32], refund_typecode: 3, refund_receiver: valid_receiver(), amount_zat: Some(tranche) };
        let sealed = payload::sealed_bytes(&p.to_memo(&hex32(&self.rules.payload_pubkey).unwrap(), &esk).unwrap()).unwrap();
        let mut page_key = [seed; bid::PAGE_KEY_LEN];
        page_key[0] = 0x02;
        if self.rules.sealed.as_ref().unwrap().long_tag {
            let (lock, bound) = bid::lock_bid_bound(bid, &self.rid(), &sealed, &page_key, tranche, ROUND).unwrap();
            return BidMemo { sealed, lock, page_key, bound: Some(bound) };
        }
        let t = bid::tag(&self.rid(), &sealed, &page_key, tranche);
        BidMemo { sealed, lock: bid::lock_bid(bid, &t, ROUND).unwrap(), page_key, bound: None }
    }

    fn note(&self, i: u8, value: u64, height: u32, memo: &BidMemo) -> ChainNote {
        ChainNote {
            txid: hex::encode([i; 32]), action: 0, value_zat: value, nf: Some(hex::encode([i + 100; 32])),
            height: Some(height), tx_index: None, memo_text: Some(memo.to_text()), is_change: false, spent_by: None,
        }
    }

    fn issue(&self, n: &ChainNote) -> Entry {
        let mut e = Entry::new(&self.id, "issue");
        let nf = n.nf.clone().unwrap();
        e.contribution = Some(Contribution {
            txid: n.txid.clone(), action: n.action, nf: nf.clone(), height: n.height.unwrap(), value_zat: None,
            amount_commit: Some(crate::ledger::amount_commit(&self.amount_key, &nf, n.value_zat).unwrap()),
        });
        e.ticket = Some(Ticket { txid: early(n), issue_height: n.height.unwrap() + 1, branch_id: "77190ad9".into() });
        e.refund = Some(refund(n));
        e
    }

    fn reject(&self, n: &ChainNote) -> Entry {
        let mut e = self.issue(n);
        e.kind = "reject".into();
        e.ticket = None;
        e.refund = None;
        e.reason = Some("the payment is smaller than the tranche its memo was made for".into());
        e
    }

    fn coin(&self, n: &ChainNote, index: u32) -> Entry {
        let mut e = Entry::new(&self.id, "coin");
        e.coin = Some(Coin { nf: n.nf.clone().unwrap(), txid: "coins".into(), index, value_zat: COIN_ZAT });
        e.late = Some(late(n));
        e
    }

    fn close(&self, winners: Vec<String>, price: Option<u64>, sig: &str) -> Entry {
        let mut e = Entry::new(&self.id, "close");
        e.close = Some(Close {
            close_height: DEADLINE + 1, outcome: "sealed_auction".into(), winners: Some(winners), ufvk: None,
            amount_key: Some(hex::encode(self.amount_key)), clearing_price_zat: price, drand_signature: Some(sig.into()),
        });
        e
    }

    fn settle(&self, n: &ChainNote, price: u64) -> Entry {
        let mut e = Entry::new(&self.id, "settle");
        e.settle = Some(Settle { nf: n.nf.clone().unwrap(), txid: settle_tx(n), price_zat: price, excess_zat: n.value_zat - price - FEE, fee_zat: FEE });
        e
    }

    fn reveal(&self, height: u32) -> Entry {
        let mut e = Entry::new(&self.id, "reveal");
        e.reveal = Some(Reveal { ufvk: UFVK.into(), height, payload_sk: None });
        e
    }
}

/// A valid Ironwood receiver (a refund address a wallet can pay).
fn valid_receiver() -> [u8; 43] {
    let sk: orchard::keys::SpendingKey = Option::from(orchard::keys::SpendingKey::from_bytes([7; 32])).expect("a valid spending key");
    orchard::keys::FullViewingKey::from(&sk).address_at(0u32, orchard::keys::Scope::External).to_raw_address_bytes()
}

fn early(n: &ChainNote) -> String {
    format!("early-{}", n.txid)
}
fn late(n: &ChainNote) -> String {
    format!("late-{}", n.txid)
}
fn refund(n: &ChainNote) -> String {
    format!("refund-{}", n.txid)
}
fn settle_tx(n: &ChainNote) -> String {
    format!("settle-{}", n.txid)
}
fn nf(n: &ChainNote) -> String {
    n.nf.clone().unwrap()
}
fn spent(mut n: ChainNote, txid: &str, h: u32) -> ChainNote {
    n.spent_by = Some(Spend { txid: txid.into(), height: Some(h) });
    n
}
fn tnote(txid: &str, value: u64) -> ChainNote {
    ChainNote { txid: txid.into(), action: 0, value_zat: value, nf: None, height: Some(230), tx_index: None, memo_text: None, is_change: false, spent_by: None }
}
fn facts(txid: &str) -> TxFacts {
    TxFacts { txid: txid.into(), fee_zat: FEE as i64, ironwood_actions: 2, has_orchard: false, has_sapling: false, has_transparent: false }
}

/// Block times for blocks 150 to 200 such that round R comes `margin` seconds after the earliest moment allowed (MTP at the deadline + GAP).
fn block_times(margin: i64) -> Vec<(u32, u64)> {
    let mtp_target = (sealed::round_time(ROUND) as i64 - sealed::GAP_SECS as i64 - margin) as u64;
    // blocks 190..=200 are 75 s apart, so the median (block 195) is the target
    (150..=DEADLINE).map(|h| (h, mtp_target + (h as u64) * 75 - 195 * 75)).collect()
}

/// The four bids: A 25M in the 30M tranche, B 8M, C 5M, D 2M in the 10M tranche. Two items.
fn bids() -> [(u64, u64); 4] {
    [(BIG, 25_000_000), (SMALL, 8_000_000), (SMALL, 5_000_000), (SMALL, 2_000_000)]
}

/// What each pricing type gives for `bids()`: winners A and B, and what each pays.
fn expected(pricing: &str) -> (Option<u64>, [u64; 2]) {
    match pricing {
        "uniform" => (Some(8_000_000), [8_000_000; 2]),
        "second" => (Some(5_000_000), [5_000_000; 2]),
        _ => (None, [25_000_000, 8_000_000]),
    }
}

/// An honest auction, fully finished: tickets, coins before the cutoff, the close with round R, A and B settled in block 230, C and D
/// refunded in block 231, the viewing key revealed at block 240.
fn honest(pricing: &str) -> Case {
    honest_with(pricing, false)
}

/// The same honest auction, made with open payouts (SPEC §9.1, open_payouts): the reveal publishes the payload key and the chain shows who each refund
/// and each winner's change pays.
fn honest_open(pricing: &str) -> Case {
    honest_with(pricing, true)
}

/// The shape of an honest payment from one deposit to one person: two actions, only the fee leaving the pool (the mentor's second review).
fn plain_shape() -> TxShape {
    TxShape { actions: 2, value_balance: FEE as i64, ..Default::default() }
}

fn paid(to: [u8; 43], value: u64) -> PaidOutput {
    PaidOutput { receiver_hex: hex::encode(to), value_zat: value }
}

fn honest_with(pricing: &str, open: bool) -> Case {
    let sx = sx_with(pricing, 2, open);
    let deps: Vec<Dep> = bids()
        .iter()
        .enumerate()
        .map(|(i, &(tranche, b))| {
            let seed = i as u8 + 1;
            let memo = sx.memo(seed, tranche, b);
            Dep { note: sx.note(seed, tranche, 110 + i as u32, &memo), memo, seed }
        })
        .collect();
    let (price, pays) = expected(pricing);
    let (a, b) = (&deps[0].note, &deps[1].note);
    let mut entries: Vec<Entry> = deps.iter().map(|d| sx.issue(&d.note)).collect();
    entries.extend(deps.iter().enumerate().map(|(i, d)| sx.coin(&d.note, i as u32)));
    entries.push(sx.close(vec![nf(a), nf(b)], price, SIG));
    entries.push(sx.settle(a, pays[0]));
    entries.push(sx.settle(b, pays[1]));
    entries.push(sx.reveal(240));
    if open {
        entries.last_mut().unwrap().reveal.as_mut().unwrap().payload_sk = Some(sx.secrets.payload_sk.clone());
    }
    let notes = vec![
        spent(a.clone(), &settle_tx(a), 230),
        spent(b.clone(), &settle_tx(b), 230),
        spent(deps[2].note.clone(), &refund(&deps[2].note), 231),
        spent(deps[3].note.clone(), &refund(&deps[3].note), 231),
    ];
    let extra = Extra {
        treasury_notes: vec![tnote(&settle_tx(a), pays[0]), tnote(&settle_tx(b), pays[1])],
        tx_facts: vec![facts(&settle_tx(a)), facts(&settle_tx(b))],
        checks: vec![],
        coins: deps.iter().enumerate().map(|(i, d)| CoinFact { txid: "coins".into(), index: i as u32, value_zat: COIN_ZAT, script_hex: p2pkh_script_hex(&d.memo.page_key), height: Some(150) }).collect(),
        block_times: block_times(600),
        payouts: if open {
            let r = valid_receiver();
            let (dp, dq) = (&deps[2].note, &deps[3].note);
            vec![
                PayoutFact { txid: refund(dp), outputs: vec![paid(r, dp.value_zat - FEE)], error: None, shape: Some(plain_shape()) },
                PayoutFact { txid: refund(dq), outputs: vec![paid(r, dq.value_zat - FEE)], error: None, shape: Some(plain_shape()) },
                PayoutFact { txid: settle_tx(a), outputs: vec![paid(r, a.value_zat - pays[0] - FEE)], error: None, shape: Some(plain_shape()) },
                PayoutFact { txid: settle_tx(b), outputs: vec![paid(r, b.value_zat - pays[1] - FEE)], error: None, shape: Some(plain_shape()) },
            ]
        } else {
            vec![]
        },
    };
    Case { sx, deps, entries, notes, extra, challenges: vec![], tip: TIP }
}

impl Case {
    fn run(&self) -> Report {
        let sk = self.sx.secrets.ledger_key().unwrap();
        let mut l: Vec<Entry> = vec![];
        for e in &self.entries {
            let mut e = e.clone();
            e.seq = l.len() as u64;
            e.prev = l.last().map_or(GENESIS_PREV.into(), |p| p.hash().unwrap());
            e.sign(&sk).unwrap();
            l.push(e);
        }
        recount_with(&self.sx.rules, &self.sx.id, &l, &self.notes, &self.challenges, self.tip, true, &self.extra)
    }
    fn n(&self, i: usize) -> ChainNote {
        self.deps[i].note.clone()
    }
    fn entry_mut(&mut self, kind: &str, nf_of: usize) -> &mut Entry {
        let nf = nf(&self.deps[nf_of].note);
        self.entries.iter_mut().find(|e| e.kind == kind && (e.nf() == Some(nf.as_str()) || e.coin.as_ref().is_some_and(|c| c.nf == nf) || e.settle.as_ref().is_some_and(|s| s.nf == nf))).unwrap()
    }
    fn close_mut(&mut self) -> &mut Close {
        self.entries.iter_mut().find_map(|e| e.close.as_mut()).unwrap()
    }
    fn set_note(&mut self, n: ChainNote) {
        let i = self.notes.iter().position(|x| x.nf == n.nf && x.txid == n.txid).unwrap();
        self.notes[i] = n;
    }
}

fn failing(r: &Report) -> Vec<&'static str> {
    r.results.iter().filter(|x| !x.pass).map(|x| x.id).collect()
}
fn details(r: &Report, id: &str) -> String {
    r.results.iter().find(|x| x.id == id).unwrap().details.join(" | ")
}

#[test]
fn an_honest_auction_passes_for_each_pricing_type() {
    for pricing in ["uniform", "second", "pay_your_bid"] {
        let c = honest(pricing);
        let r = c.run();
        assert!(r.all_pass(), "{pricing}: {:?} {:?}", failing(&r), r.results);
        assert!(!r.did_not_finish, "{pricing}");
        let s = r.sealed.as_ref().unwrap();
        assert!(s.opened && !s.void);
        assert_eq!(s.winners, vec![nf(&c.n(0)), nf(&c.n(1))], "{pricing}");
        let (price, pays) = expected(pricing);
        assert_eq!(s.price_zat, price, "{pricing}");
        let opened: Vec<_> = s.deposits.iter().map(|d| (d.bid_zat, d.winner, d.price_zat)).collect();
        assert_eq!(opened, vec![(Some(25_000_000), true, Some(pays[0])), (Some(8_000_000), true, Some(pays[1])), (Some(5_000_000), false, None), (Some(2_000_000), false, None)], "{pricing}");
        assert_eq!((r.totals.contributions, r.totals.kept_zat, r.totals.refunded_zat), (4, pays[0] + pays[1], 2 * SMALL), "{pricing}");
    }
}

#[test]
fn before_the_reveal_only_the_list_is_checked_and_nothing_fails() {
    let c = honest("uniform");
    let mut early = Case { entries: c.entries[..8].to_vec(), tip: 150, ..c };
    early.notes.iter_mut().for_each(|n| n.spent_by = None);
    let sk = early.sx.secrets.ledger_key().unwrap();
    let mut l: Vec<Entry> = vec![];
    for e in &early.entries {
        let mut e = e.clone();
        e.seq = l.len() as u64;
        e.prev = l.last().map_or(GENESIS_PREV.into(), |p| p.hash().unwrap());
        e.sign(&sk).unwrap();
        l.push(e);
    }
    // without the viewing key: R1 and R2 run, S1 to S8 wait
    let r = recount_with(&early.sx.rules, &early.sx.id, &l, &[], &[], 150, false, &Extra::default());
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!(r.results.iter().filter(|x| x.waiting).count(), 8);
    // with the chain (the host's own view): bidding is open, nothing fails, the bids stay locked
    let r = recount_with(&early.sx.rules, &early.sx.id, &l, &early.notes, &[], 150, true, &early.extra);
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert!(!r.sealed.unwrap().opened);
}

#[test]
fn the_outcome_rules_for_ties_and_too_few_bids() {
    let b = |v: &[u64]| v.iter().enumerate().map(|(i, x)| (format!("n{i}"), *x)).collect::<Vec<_>>();
    // ties go to the earlier deposit
    assert_eq!(plan_outcome("uniform", 1, None, &b(&[5, 7, 7])), vec![("n1".into(), 7)]);
    // too few bids: the reserve, else the lowest winning bid
    assert_eq!(plan_outcome("uniform", 3, Some(2), &b(&[5, 7])), vec![("n1".into(), 2), ("n0".into(), 2)]);
    assert_eq!(plan_outcome("uniform", 3, None, &b(&[5, 7])), vec![("n1".into(), 5), ("n0".into(), 5)]);
    assert_eq!(plan_outcome("second", 2, Some(2), &b(&[5, 7])), vec![("n1".into(), 2), ("n0".into(), 2)]);
    assert_eq!(plan_outcome("second", 1, None, &b(&[5])), vec![("n0".into(), 5)]);
    assert_eq!(plan_outcome("second", 1, None, &b(&[5, 9, 3])), vec![("n1".into(), 5)]);
    assert_eq!(plan_outcome("pay_your_bid", 2, Some(2), &b(&[5, 9, 3])), vec![("n1".into(), 9), ("n0".into(), 5)]);
    assert!(plan_outcome("uniform", 2, None, &[]).is_empty());
}

/// Replaces deposit `i`'s memo (and the coin's script) and returns the case.
fn with_memo(mut c: Case, i: usize, memo: BidMemo) -> Case {
    c.notes[i].memo_text = Some(memo.to_text());
    c.deps[i].note.memo_text = Some(memo.to_text());
    c.extra.coins[i].script_hex = p2pkh_script_hex(&memo.page_key);
    c.deps[i].memo = memo;
    c
}

/// Makes the case's close, settlements and treasury match a new outcome (what an honest host would do with these bids).
fn reoutcome(c: &mut Case, winners: &[usize], price: u64, losers: &[usize]) {
    c.close_mut().winners = Some(winners.iter().map(|&i| nf(&c.deps[i].note)).collect());
    c.close_mut().clearing_price_zat = Some(price);
    c.entries.retain(|e| e.kind != "settle" && e.kind != "reveal");
    c.extra.treasury_notes.clear();
    c.extra.tx_facts.clear();
    for &i in winners {
        let n = c.n(i);
        c.entries.push(c.sx.settle(&n, price));
        c.extra.treasury_notes.push(tnote(&settle_tx(&n), price));
        c.extra.tx_facts.push(facts(&settle_tx(&n)));
        c.set_note(spent(n.clone(), &settle_tx(&n), 230));
    }
    for &i in losers {
        let n = c.n(i);
        c.set_note(spent(n.clone(), &refund(&n), 231));
    }
    c.entries.push(c.sx.reveal(240));
}

#[test]
fn b3_a_bid_above_its_tranche_is_no_bid() {
    // B pays the small tranche but locks 25M: no bid, so C and A win at C's price
    let c = honest("uniform");
    let memo = c.sx.memo(2, SMALL, 25_000_000);
    let mut c = with_memo(c, 1, memo);
    let r = c.run();
    assert_eq!(failing(&r), vec!["S5", "S6", "S7"], "the old outcome is now wrong");
    let s = r.sealed.as_ref().unwrap();
    assert!(s.deposits[1].no_bid.as_deref().unwrap().contains("more than its tranche"));
    reoutcome(&mut c, &[0, 2], 5_000_000, &[1, 3]);
    let r = c.run();
    assert!(r.all_pass(), "{:?} {}", failing(&r), details(&r, "S5"));
    assert_eq!(r.sealed.unwrap().winners, vec![nf(&c.n(0)), nf(&c.n(2))]);
}

#[test]
fn b4_a_lock_copied_into_another_memo_is_no_bid_and_the_original_still_counts() {
    // D copies A's locked bid into D's own memo: D's tag does not match, D has no bid, A still wins
    let c = honest("uniform");
    let mut stolen = c.sx.memo(4, SMALL, 1);
    stolen.lock = c.deps[0].memo.lock;
    let c = with_memo(c, 3, stolen);
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
    let s = r.sealed.unwrap();
    assert!(s.deposits[3].no_bid.as_deref().unwrap().contains("tag does not match"));
    assert_eq!(s.deposits[3].bid_zat, Some(25_000_000), "the copied lock opens to A's bid, with A's tag");
    assert_eq!(s.winners, vec![nf(&c.n(0)), nf(&c.n(1))]);
}

#[test]
fn b5_a_payment_between_tranches_counts_as_the_tranche_below() {
    // C pays 20M with a memo for the 10M tranche: it counts as 10M; its bid of 9.99M fits, so C wins at B's price
    let mut c = honest("uniform");
    let memo = c.sx.memo(3, SMALL, SMALL - FEE);
    c = with_memo(c, 2, memo);
    c.deps[2].note.value_zat = 20_000_000;
    c.notes[2].value_zat = 20_000_000;
    c.entries[2] = c.sx.issue(&c.n(2));
    reoutcome(&mut c, &[0, 2], 9_990_000, &[1, 3]);
    let r = c.run();
    assert!(r.all_pass(), "{:?} {} {}", failing(&r), details(&r, "S5"), details(&r, "S6"));
    let s = r.sealed.unwrap();
    assert_eq!((s.deposits[2].tranche_zat, s.deposits[2].bid_zat, s.price_zat), (SMALL, Some(SMALL - FEE), Some(9_990_000)));
    // a bid above the tranche below is no bid, even though the payment would cover it
    let mut c = honest("uniform");
    let memo = c.sx.memo(3, SMALL, 15_000_000);
    c = with_memo(c, 2, memo);
    c.deps[2].note.value_zat = 20_000_000;
    c.notes[2].value_zat = 20_000_000;
    c.entries[2] = c.sx.issue(&c.n(2));
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert!(r.sealed.unwrap().deposits[2].no_bid.is_some());
}

#[test]
fn h1_spending_a_deposit_other_than_by_its_tickets_fails() {
    // before the deadline, by anything but the early ticket: S4
    let mut c = honest("uniform");
    let d = c.n(3);
    c.set_note(spent(d.clone(), "host-wallet", 150));
    let r = c.run();
    assert!(failing(&r).contains(&"S4"), "{:?}", failing(&r));
    assert!(details(&r, "S4").contains("not by its early ticket"));
    // after the deadline, a loser moved anywhere but its refund or late ticket: S7
    let mut c = honest("uniform");
    let d = c.n(3);
    c.set_note(spent(d.clone(), "host-wallet", 231));
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"]);
    // a withdrawal by the early ticket before the deadline is fine, and the deposit is out of the auction
    let mut c = honest("uniform");
    let d = c.n(3);
    c.set_note(spent(d.clone(), &early(&d), 150));
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert!(r.sealed.unwrap().deposits[3].withdrawn);
}

#[test]
fn h2_a_host_that_does_not_finish_is_marked_did_not_finish() {
    // never closes: after the late ticket block every deposit goes back with its late ticket
    let mut c = honest("uniform");
    c.entries.retain(|e| matches!(e.kind.as_str(), "issue" | "coin"));
    for i in 0..4 {
        let n = c.n(i);
        c.set_note(spent(n.clone(), &late(&n), CLAIM_AFTER + 2));
    }
    c.extra.treasury_notes.clear();
    c.tip = CLAIM_AFTER - 1;
    let r = c.run();
    assert!(!r.did_not_finish, "still in time");
    c.tip = TIP;
    let r = c.run();
    assert!(r.did_not_finish);
    assert_eq!(failing(&r), vec!["S5", "S8"]);
    // closes but leaves a winner unsettled: the winner takes the deposit back with the late ticket
    let mut c = honest("uniform");
    let a = c.n(0);
    c.set_note(spent(a.clone(), &late(&a), CLAIM_AFTER + 1));
    c.entries.retain(|e| !(e.kind == "settle" && e.settle.as_ref().unwrap().nf == nf(&a)));
    c.extra.treasury_notes.remove(0);
    let r = c.run();
    assert!(r.did_not_finish);
    assert_eq!(failing(&r), vec!["S6"]);
    // closes and settles but never publishes the viewing key
    let mut c = honest("uniform");
    c.entries.retain(|e| e.kind != "reveal");
    let r = c.run();
    assert!(r.did_not_finish);
    assert_eq!(failing(&r), vec!["S8"]);
}

#[test]
fn h3_a_copy_paying_a_smaller_tranche_cannot_take_the_real_deposit() {
    // the host copies A's memo (made for the 30M tranche) into a 10M payment mined first
    let copy_of = |c: &Case| ChainNote { txid: hex::encode([9u8; 32]), nf: Some(hex::encode([109u8; 32])), height: Some(105), value_zat: SMALL, ..c.n(0) };
    // honest host: rejects the copy (its payload says 30M), tickets A; the copy is a donation
    let mut c = honest("uniform");
    let copy = copy_of(&c);
    c.notes.push(copy.clone());
    c.entries.insert(0, c.sx.reject(&copy));
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.donations_zat), (4, SMALL));
    // dishonest host: takes the copy as the deposit and sets A's real 30M aside as a replay. Once the bids open, the tags show it.
    let mut c = honest("uniform");
    let copy = copy_of(&c);
    c.notes.push(copy.clone());
    c.entries[0] = c.sx.issue(&copy);
    c.entries[4] = { let mut e = c.sx.coin(&copy, 0); e.coin.as_mut().unwrap().nf = nf(&copy); e };
    reoutcome(&mut c, &[1, 2], 5_000_000, &[3]);
    c.set_note(spent(copy.clone(), &refund(&copy), 231));
    let r = c.run();
    assert!(failing(&r).contains(&"S5"), "{:?}", failing(&r));
    assert!(details(&r, "S5").contains("accepted the copy and kept the real deposit"), "{}", details(&r, "S5"));
    // a host that rejects A's real deposit instead: shown false when A publishes the memo's one-time secret
    let mut c = honest("uniform");
    let a = c.n(0);
    c.entries[0] = c.sx.reject(&a);
    c.entries.remove(4);
    reoutcome(&mut c, &[1, 2], 5_000_000, &[3]);
    c.notes.retain(|n| n.nf != a.nf);
    c.notes.push(a.clone());
    c.extra.coins.remove(0);
    let r = c.run();
    assert!(r.all_pass(), "without the secret the public cannot see the memo: {:?}", failing(&r));
    let esk = ContributorKeys { seed: [c.deps[0].seed; 32] }.memo_ephemeral_key();
    c.challenges.push(Challenge { txid: a.txid.clone(), action: 0, eph_sk: hex::encode(esk.to_bytes()), uivk: None, complaint: false , memo: None });
    let r = c.run();
    assert_eq!(failing(&r), vec!["S1"]);
    assert!(details(&r, "S1").contains("the person who paid it showed that its memo is valid"));
}

#[test]
fn h5_wrong_winners_wrong_price_or_keeping_more_fail() {
    // declares C instead of B
    let mut c = honest("uniform");
    c.close_mut().winners = Some(vec![nf(&c.n(0)), nf(&c.n(2))]);
    assert!(failing(&c.run()).contains(&"S5"));
    // declares a higher price
    let mut c = honest("second");
    c.close_mut().clearing_price_zat = Some(8_000_000);
    assert_eq!(failing(&c.run()), vec!["S5"]);
    // the treasury receives more than the price from A's settlement
    let mut c = honest("uniform");
    c.extra.treasury_notes[0].value_zat = 9_000_000;
    let r = c.run();
    assert_eq!(failing(&r), vec!["S6"]);
    assert!(details(&r, "S6").contains("the treasury received"));
    // a loser "settled" (its deposit taken to the treasury)
    let mut c = honest("uniform");
    let d = c.n(3);
    c.entries.push(c.sx.settle(&d, 8_000_000));
    c.set_note(spent(d.clone(), &settle_tx(&d), 230));
    let r = c.run();
    assert_eq!(failing(&r), vec!["S6", "S7"]);
}

#[test]
fn h6_the_bids_open_only_with_round_rs_real_signature() {
    for sig in [SIG_1000.to_string(), "00".repeat(48), "zz".into()] {
        let mut c = honest("uniform");
        c.close_mut().drand_signature = Some(sig);
        let r = c.run();
        assert!(failing(&r).contains(&"S5"));
        assert!(details(&r, "S5").contains("drand quicknet's signature"));
        assert!(!r.sealed.unwrap().opened);
    }
}

#[test]
fn the_auction_is_void_only_if_round_r_came_too_early() {
    // blocks were slower than the cautious range: round R came before the deadline plus the gap. The honest host declares it void and
    // refunds everyone.
    let mut c = honest("uniform");
    c.extra.block_times = block_times(-60);
    c.close_mut().outcome = "void".into();
    c.close_mut().winners = Some(vec![]);
    c.close_mut().clearing_price_zat = None;
    c.entries.retain(|e| e.kind != "settle");
    c.extra.treasury_notes.clear();
    for i in 0..4 {
        let n = c.n(i);
        c.set_note(spent(n.clone(), &refund(&n), 231));
    }
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert!(r.sealed.as_ref().unwrap().void);
    assert_eq!(r.totals.refunded_zat, BIG + 3 * SMALL);
    // a host that goes ahead anyway fails, and so does one that calls a good auction void
    let mut c = honest("uniform");
    c.extra.block_times = block_times(-60);
    assert_eq!(failing(&c.run()), vec!["S5"]);
    let mut c = honest("uniform");
    c.close_mut().outcome = "void".into();
    assert!(failing(&c.run()).contains(&"S5"));
}

#[test]
fn ch1_to_ch3_the_coin_must_come_in_time_to_the_right_address_from_outside_the_campaign() {
    // CH1 no coin: fails after the cutoff, unless the person who bid left with the early ticket
    let mut c = honest("uniform");
    c.entries.retain(|e| !(e.kind == "coin" && e.coin.as_ref().unwrap().nf == nf(&c.deps[3].note)));
    assert_eq!(failing(&c.run()), vec!["S3"]);
    let d = c.n(3);
    c.set_note(spent(d.clone(), &early(&d), 189));
    assert!(c.run().all_pass());
    // CH2 mined after the cutoff (block 190)
    let mut c = honest("uniform");
    c.extra.coins[3].height = Some(191);
    let r = c.run();
    assert_eq!(failing(&r), vec!["S3"]);
    assert!(details(&r, "S3").contains("after the cutoff"));
    // CH3 too small, or to another address
    let mut c = honest("uniform");
    c.extra.coins[3].value_zat = 1_000;
    assert_eq!(failing(&c.run()), vec!["S3"]);
    let mut c = honest("uniform");
    c.extra.coins[3].script_hex = c.extra.coins[2].script_hex.clone();
    assert!(details(&c.run(), "S3").contains("not paid to the address of the bid's page"));
    // paid from the campaign's own funds (owner decision 7)
    let mut c = honest("uniform");
    let d = c.n(2);
    c.set_note(spent(d, "coins", 231));
    let r = c.run();
    assert!(details(&r, "S3").contains("from the campaign's funds"));
}

#[test]
fn the_viewing_key_comes_once_after_every_settlement_and_matches() {
    let mut c = honest("uniform");
    *c.entries.last_mut().unwrap() = c.sx.reveal(229);
    assert_eq!(failing(&c.run()), vec!["S8"]);
    let mut c = honest("uniform");
    c.entries.last_mut().unwrap().reveal.as_mut().unwrap().ufvk = "uviewtest1other".into();
    assert_eq!(failing(&c.run()), vec!["R1"]);
    let mut c = honest("uniform");
    let rv = c.entries.pop().unwrap();
    c.entries.insert(4, rv);
    assert!(failing(&c.run()).contains(&"R2"));
}

#[test]
fn tickets_late_or_a_replayed_memo() {
    let mut c = honest("uniform");
    c.entry_mut("issue", 2).ticket.as_mut().unwrap().issue_height = 140;
    assert_eq!(failing(&c.run()), vec!["S2"]);
    // a later payment repeating D's memo is a donation with a plain note, not a second bid
    let mut c = honest("uniform");
    let again = ChainNote { txid: hex::encode([8u8; 32]), nf: Some(hex::encode([108u8; 32])), height: Some(150), ..c.n(3) };
    c.notes.push(again);
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert_eq!((r.totals.contributions, r.totals.donations), (4, 1));
    assert!(r.warnings.iter().any(|w| w.contains("repeated the memo")));
}

#[test]
fn a_deposit_after_the_coin_cutoff_owes_no_coin_and_does_not_bid() {
    // D pays in block 195, after the cutoff (190): no coin, its bid (the highest) does not count, it is refunded
    let mut c = honest("uniform");
    let memo = c.sx.memo(4, SMALL, SMALL - FEE);
    c = with_memo(c, 3, memo);
    c.deps[3].note.height = Some(195);
    c.notes[3].height = Some(195);
    c.entries[3] = c.sx.issue(&c.n(3));
    c.entries.retain(|e| !(e.kind == "coin" && e.coin.as_ref().unwrap().nf == nf(&c.deps[3].note)));
    let r = c.run();
    assert!(r.all_pass(), "{:?} {}", failing(&r), details(&r, "S3"));
    let s = r.sealed.unwrap();
    assert!(s.deposits[3].no_bid.as_deref().unwrap().contains("after the coin cutoff"));
    assert_eq!(s.winners, vec![nf(&c.n(0)), nf(&c.n(1))]);
}

#[test]
fn a_deposit_after_the_deadline_must_be_sent_back_by_the_return_on_the_list() {
    let late_entry = |c: &Case, n: &ChainNote, txid: &str| {
        let mut e = Entry::new(&c.sx.id, "late_return");
        e.contribution = Some(Contribution { txid: n.txid.clone(), action: n.action, nf: nf(n), height: n.height.unwrap(), value_zat: None, amount_commit: None });
        e.refund = Some(txid.into());
        e
    };
    let c0 = honest("uniform");
    let late = c0.sx.note(9, SMALL, DEADLINE + 2, &c0.sx.memo(9, SMALL, 5_000_000));
    // sent back by the return the list names: S7 passes and says so
    let mut c = honest("uniform");
    c.notes.push(spent(late.clone(), "late-return", DEADLINE + 4));
    c.entries.push(late_entry(&c, &late, "late-return"));
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert!(details(&r, "S7").contains("came too late to bid") && details(&r, "S7").contains("sent back by late-return"), "{}", details(&r, "S7"));
    // not sent back within the ticket window: S7 fails
    let mut c = honest("uniform");
    c.notes.push(late.clone());
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"]);
    assert!(details(&r, "S7").contains("was not sent back within 30 blocks") || details(&r, "S7").contains("was not sent back within"), "{}", details(&r, "S7"));
    // still inside the ticket window: waiting, nothing fails
    let mut c = honest("uniform");
    c.notes.push(c0.sx.note(9, SMALL, TIP - 1, &c0.sx.memo(9, SMALL, 5_000_000)));
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
    assert!(details(&r, "S7").contains("waiting to be sent back"));
    // spent by anything but the named return (the host kept it): S7 fails
    let mut c = honest("uniform");
    c.notes.push(spent(late.clone(), "host-wallet", DEADLINE + 4));
    c.entries.push(late_entry(&c, &late, "late-return"));
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"]);
    assert!(details(&r, "S7").contains("which is not its return on the list"));
    // a payment too small to pay the network fee, or without a bid memo, is not something the host can send back
    let mut c = honest("uniform");
    c.notes.push(c0.sx.note(9, FEE, DEADLINE + 2, &c0.sx.memo(9, SMALL, 5_000_000)));
    let mut plain = c0.sx.note(10, SMALL, DEADLINE + 2, &c0.sx.memo(10, SMALL, 5_000_000));
    plain.memo_text = Some("thanks".into());
    c.notes.push(plain);
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
}

#[test]
fn a_payment_in_the_last_three_blocks_is_late_and_must_be_sent_back() {
    let late_entry = |c: &Case, n: &ChainNote, txid: &str| {
        let mut e = Entry::new(&c.sx.id, "late_return");
        e.contribution = Some(Contribution { txid: n.txid.clone(), action: n.action, nf: nf(n), height: n.height.unwrap(), value_zat: None, amount_commit: None });
        e.refund = Some(txid.into());
        e
    };
    let c0 = honest("uniform");
    // one block before the deadline: no early ticket can be built for it, so it is not a deposit
    let edge = c0.sx.note(9, SMALL, DEADLINE - 1, &c0.sx.memo(9, SMALL, 5_000_000));
    let mut c = honest("uniform");
    c.notes.push(edge.clone());
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"], "not sent back: S7 (and not S2: it is not a deposit)");
    assert_eq!(r.sealed.as_ref().unwrap().deposits.len(), 4);
    let mut c = honest("uniform");
    c.notes.push(spent(edge.clone(), "late-return", DEADLINE + 2));
    c.entries.push(late_entry(&c, &edge, "late-return"));
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
    // three blocks before the deadline it is still a deposit
    assert_eq!(sealed::last_deposit_height(DEADLINE), DEADLINE - 3);
    assert!(!is_late_deposit(&c0.sx.rules, &c0.sx.note(9, SMALL, DEADLINE - 3, &c0.sx.memo(9, SMALL, 5_000_000))));
    assert!(is_late_deposit(&c0.sx.rules, &c0.sx.note(9, SMALL, DEADLINE - 2, &c0.sx.memo(9, SMALL, 5_000_000))));
}

#[test]
fn a_deposit_without_tickets_does_not_bid_and_must_be_sent_back_after_the_close() {
    let late_entry = |c: &Case, n: &ChainNote, txid: &str| {
        let mut e = Entry::new(&c.sx.id, "late_return");
        e.contribution = Some(Contribution { txid: n.txid.clone(), action: n.action, nf: nf(n), height: n.height.unwrap(), value_zat: None, amount_commit: None });
        e.refund = Some(txid.into());
        e
    };
    // the host never ticketed deposit 3 (a loser): no issue entry, no coin, no signed refund
    let untick = |c: &mut Case| {
        let n3 = nf(&c.deps[3].note);
        c.entries.retain(|e| e.nf() != Some(n3.as_str()) && !e.coin.as_ref().is_some_and(|x| x.nf == n3));
    };
    let mut c = honest("uniform");
    untick(&mut c);
    let d = c.n(3);
    c.set_note(spent(d.clone(), "sent-back", 232));
    let e = late_entry(&c, &d, "sent-back");
    c.entries.push(e);
    let r = c.run();
    assert_eq!(failing(&r), vec!["S2"], "the missing tickets stay the host's failure (S2); the money went back (S7 passes)");
    assert!(details(&r, "S7").contains("had no tickets from the host and was sent back by sent-back"), "{}", details(&r, "S7"));
    assert!(r.sealed.as_ref().unwrap().deposits[3].no_bid.as_deref().is_some_and(|w| w.contains("no tickets from the host")));
    // not sent back within the ticket window after the close: S7 fails too
    let mut c = honest("uniform");
    untick(&mut c);
    let d = c.n(3);
    c.set_note(d.clone());
    let r = c.run();
    assert_eq!(failing(&r), vec!["S2", "S7"]);
    assert!(details(&r, "S7").contains("had no tickets from the host and was not sent back"), "{}", details(&r, "S7"));
}

#[test]
fn c1_h2_with_open_payouts_every_refund_and_change_must_pay_the_refund_address_in_the_memo() {
    // honest: every payment pays the refund address in its memo the right amount
    let c = honest_open("uniform");
    let r = c.run();
    assert!(r.all_pass(), "{:?} {}", failing(&r), details(&r, "S7"));
    // the keys the recount names for the chain readers: one per refund and per change, each the key the page works out on its own
    let l: Vec<Entry> = c.entries.clone();
    let keys = payout_keys(&c.sx.rules, &l, &c.notes);
    assert_eq!(keys.len(), 4, "{keys:?}");
    let d = &c.deps[2].note;
    let shared = payout::shared_secret(&hex32(&c.sx.secrets.payload_sk).unwrap(), &[0u8; 32]);
    assert!(keys.contains(&(refund(d), hex::encode(payout::payment_ovk(&shared, &nf(d), payout::REFUND)))));
    // C1: a refund that pays the host (another address): S7 fails, naming it
    let mut c = honest_open("uniform");
    let other = { let mut x = valid_receiver(); x[0] ^= 1; x };
    c.extra.payouts[0].outputs = vec![paid(other, c.deps[2].note.value_zat - FEE)];
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"]);
    assert!(details(&r, "S7").contains("does not pay") && details(&r, "S7").contains("the refund"), "{}", details(&r, "S7"));
    // C1: a refund that pays the right address too little
    let mut c = honest_open("uniform");
    c.extra.payouts[1].outputs = vec![paid(valid_receiver(), 1_000)];
    assert_eq!(failing(&c.run()), vec!["S7"]);
    // H2: a winner's change sent elsewhere: S6 fails
    let mut c = honest_open("second");
    c.extra.payouts[2].outputs = vec![paid(other, 0)];
    let r = c.run();
    assert_eq!(failing(&r), vec!["S6"]);
    assert!(details(&r, "S6").contains("the change in"), "{}", details(&r, "S6"));
    // a payment the recount could not read from the chain is not taken on trust
    let mut c = honest_open("uniform");
    c.extra.payouts.remove(0);
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"]);
    assert!(details(&r, "S7").contains("was not read from the chain"));
    // a reveal without the payload key, or with another one: S8 fails (and the payments cannot be checked)
    let mut c = honest_open("uniform");
    c.entries.last_mut().unwrap().reveal.as_mut().unwrap().payload_sk = None;
    let r = c.run();
    assert!(failing(&r).contains(&"S8"), "{:?}", failing(&r));
    assert!(details(&r, "S8").contains("does not publish the payload key"));
    let mut c = honest_open("uniform");
    c.entries.last_mut().unwrap().reveal.as_mut().unwrap().payload_sk = Some(hex::encode([99u8; 32]));
    assert!(failing(&c.run()).contains(&"S8"));
    // an auction made before open payouts is not checked this way, and still passes
    assert!(honest("uniform").run().all_pass());
}

#[test]
fn h1_an_entry_added_to_the_list_long_after_later_payments_shows() {
    // the host adds its own deposit's issue entry at the end of the list, after the entries of deposits mined much later
    let mut c = honest("uniform");
    let first = c.entries.iter().position(|e| e.kind == "issue").unwrap();
    let e = c.entries.remove(first);
    let coin = c.entries.iter().position(|x| x.kind == "coin").unwrap();
    c.entries.insert(coin, e);
    // its deposit was mined in block 110, the others in 111 to 113: within the ticket window, a retry, not a failure
    assert!(c.run().all_pass(), "{:?}", failing(&c.run()));
    // the same, but the later deposits came long after (more than the ticket window): S2 fails, naming the entry
    let mut c = honest("uniform");
    for (i, n) in c.notes.iter_mut().enumerate() {
        if i > 0 { n.height = Some(n.height.unwrap() + 40); }
    }
    for e in c.entries.iter_mut().filter(|e| e.kind == "issue") {
        let nf = e.nf().unwrap().to_string();
        if let Some(h) = c.notes.iter().find(|n| n.nf.as_deref() == Some(nf.as_str())).and_then(|n| n.height) {
            e.contribution.as_mut().unwrap().height = h;
            e.ticket.as_mut().unwrap().issue_height = h + 1;
        }
    }
    let first = c.entries.iter().position(|e| e.kind == "issue").unwrap();
    let e = c.entries.remove(first);
    let coin = c.entries.iter().position(|x| x.kind == "coin").unwrap();
    c.entries.insert(coin, e);
    let r = c.run();
    assert!(failing(&r).contains(&"S2"), "{:?}", failing(&r));
    assert!(details(&r, "S2").contains("added to the list late"), "{}", details(&r, "S2"));
}

fn return_entry(c: &Case, n: &ChainNote, txid: &str) -> Entry {
    let mut e = Entry::new(&c.sx.id, "late_return");
    e.contribution = Some(Contribution { txid: n.txid.clone(), action: n.action, nf: nf(n), height: n.height.unwrap(), value_zat: None, amount_commit: None });
    e.refund = Some(txid.into());
    e.blob_hash = Some(crate::ledger::blob_hash(n.memo_text.as_deref().unwrap().as_bytes()));
    e
}

/// A reject the host writes with open payouts: it carries the hash of the payment's memo, so the person's page finds it.
fn open_reject(c: &Case, n: &ChainNote) -> Entry {
    let mut e = c.sx.reject(n);
    e.blob_hash = Some(crate::ledger::blob_hash(n.memo_text.as_deref().unwrap().as_bytes()));
    e
}

fn before_close(c: &mut Case, e: Entry) {
    let at = c.entries.iter().position(|x| x.kind == "close").unwrap();
    c.entries.insert(at, e);
}

#[test]
fn before_the_close_a_late_payment_sent_back_waits_for_the_payload_key_instead_of_failing() {
    // the auction is still open: no close and no reveal yet, so the payload key is not published
    let mut c = honest_open("uniform");
    let at = c.entries.iter().position(|x| x.kind == "close").unwrap();
    c.entries.truncate(at);
    c.notes = c.deps.iter().map(|d| d.note.clone()).collect();
    let late = c.sx.note(9, SMALL, DEADLINE + 2, &c.sx.memo(9, SMALL, 5_000_000));
    c.notes.push(spent(late.clone(), "late-return", DEADLINE + 4));
    let e = return_entry(&c, &late, "late-return");
    c.entries.push(e);
    c.extra.payouts.push(PayoutFact { txid: "late-return".into(), outputs: vec![paid(valid_receiver(), SMALL - FEE)], error: None, shape: Some(plain_shape()) });
    let r = c.run();
    assert!(!failing(&r).contains(&"S7"), "{:?} {}", failing(&r), details(&r, "S7"));
}

#[test]
fn h3_a_rejected_payment_must_be_sent_back_and_its_reject_must_name_its_memo() {
    let c0 = honest_open("uniform");
    let x = c0.sx.note(9, SMALL, 150, &c0.sx.memo(9, SMALL, 5_000_000));
    let returned = |c: &mut Case, to: [u8; 43]| {
        c.notes.push(spent(x.clone(), "rej-return", 152));
        c.entries.push(return_entry(c, &x, "rej-return"));
        c.extra.payouts.push(PayoutFact { txid: "rej-return".into(), outputs: vec![paid(to, SMALL - FEE)], error: None, shape: Some(plain_shape()) });
    };
    // the host rejects a valid deposit and sends it back, minus the fee, to the refund address in its memo: nothing fails
    let mut c = honest_open("uniform");
    let rej = open_reject(&c, &x);
    before_close(&mut c, rej);
    returned(&mut c, valid_receiver());
    let r = c.run();
    assert!(r.all_pass(), "{:?} {}", failing(&r), details(&r, "S7"));
    assert!(details(&r, "S7").contains("was rejected or repeated a deposit's memo, and was sent back by rej-return"), "{}", details(&r, "S7"));
    // the cheat of the review: a false reject that keeps the deposit. S7 fails
    let mut c = honest_open("uniform");
    let rej = open_reject(&c, &x);
    before_close(&mut c, rej);
    c.notes.push(x.clone());
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"]);
    assert!(details(&r, "S7").contains("was rejected or repeated a deposit's memo, and was not sent back within 10 blocks"), "{}", details(&r, "S7"));
    // or spends it to the host
    let mut c = honest_open("uniform");
    let rej = open_reject(&c, &x);
    before_close(&mut c, rej);
    c.notes.push(spent(x.clone(), "host-wallet", 152));
    assert_eq!(failing(&c.run()), vec!["S7"]);
    // or "returns" it to another address
    let mut c = honest_open("uniform");
    let rej = open_reject(&c, &x);
    before_close(&mut c, rej);
    returned(&mut c, { let mut o = valid_receiver(); o[0] ^= 1; o });
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"]);
    assert!(details(&r, "S7").contains("does not pay"), "{}", details(&r, "S7"));
    // a reject without the memo's hash, which the person's page could not find: S1 fails
    let mut c = honest_open("uniform");
    before_close(&mut c, c0.sx.reject(&x));
    returned(&mut c, valid_receiver());
    let r = c.run();
    assert_eq!(failing(&r), vec!["S1"]);
    assert!(details(&r, "S1").contains("does not carry the hash of the payment's memo"));
    // an auction made before open payouts keeps the old rule (a reject stays, only a challenge shows a false one)
    let mut c = honest("uniform");
    let y = c.sx.note(9, SMALL, 150, &c.sx.memo(9, SMALL, 5_000_000));
    let rej = c.sx.reject(&y);
    before_close(&mut c, rej);
    c.notes.push(y);
    let r = c.run();
    assert!(r.all_pass(), "{:?}", failing(&r));
}

#[test]
fn m5_a_second_payment_with_a_deposits_memo_goes_back() {
    let mut c = honest_open("uniform");
    let again = ChainNote { txid: hex::encode([8u8; 32]), nf: Some(hex::encode([108u8; 32])), height: Some(150), ..c.n(3) };
    let rej = open_reject(&c, &again);
    before_close(&mut c, rej);
    c.notes.push(again.clone());
    // kept as a donation, as before: S7 now fails
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"], "{}", details(&r, "S7"));
    // sent back to the refund address in the memo: nothing fails
    let i = c.notes.len() - 1;
    c.notes[i] = spent(again.clone(), "again-return", 152);
    c.entries.push(return_entry(&c, &again, "again-return"));
    c.extra.payouts.push(PayoutFact { txid: "again-return".into(), outputs: vec![paid(valid_receiver(), SMALL - FEE)], error: None, shape: Some(plain_shape()) });
    let r = c.run();
    assert!(r.all_pass(), "{:?} {}", failing(&r), details(&r, "S7"));
    // a host that never lists the second payment at all must still send it back (each honest case locks its bids afresh, so the copy is
    // made from this one)
    let mut c = honest_open("uniform");
    let again = ChainNote { txid: hex::encode([8u8; 32]), nf: Some(hex::encode([108u8; 32])), height: Some(150), ..c.n(3) };
    c.notes.push(again);
    assert_eq!(failing(&c.run()), vec!["S7"]);
}

#[test]
fn l6_a_deposit_a_reorg_moves_into_the_last_blocks_still_goes_back() {
    // D was ticketed in block 113; a reorganised chain mines it in block 198 (deadline 200, last block to bid 197)
    let moved = |c: &mut Case| {
        let mut d = c.n(3);
        d.height = Some(DEADLINE - 2);
        d.spent_by = None;
        c.set_note(d.clone());
        d
    };
    // not sent back: S7 fails (before the fix neither the close nor the return code sent it)
    let mut c = honest("uniform");
    moved(&mut c);
    let r = c.run();
    assert!(failing(&r).contains(&"S7"), "{:?}", failing(&r));
    assert!(!failing(&r).contains(&"S1"), "the issue entry is not a lie: {}", details(&r, "S1"));
    // sent back by the return the list names: passes, and S1 says why its entry names no deposit
    let mut c = honest("uniform");
    let d = moved(&mut c);
    c.set_note(spent(d.clone(), "reorg-return", DEADLINE + 3));
    c.entries.push(return_entry(&c, &d, "reorg-return"));
    let r = c.run();
    assert!(r.all_pass(), "{:?} {} {}", failing(&r), details(&r, "S3"), details(&r, "S7"));
    assert!(details(&r, "S1").contains("the chain was reorganised"), "{}", details(&r, "S1"));
    // or by its own signed refund: passes too
    let mut c = honest("uniform");
    let d = moved(&mut c);
    c.set_note(spent(d.clone(), &refund(&d), DEADLINE + 3));
    let r = c.run();
    assert!(r.all_pass(), "{:?} {}", failing(&r), details(&r, "S7"));
}

#[test]
fn m4_with_the_long_tag_a_copied_lock_and_an_older_memo_are_no_bid() {
    // the honest auction made with the long tag passes (its memos are the bound kind)
    let c = honest_open("uniform");
    assert!(c.deps.iter().all(|d| d.memo.bound.is_some()));
    // D copies A's lock and A's encrypted bid with its tag into D's own memo: the tag, made with A's locked key, does not match D's memo
    let mut stolen = c.sx.memo(4, SMALL, 1);
    stolen.lock = c.deps[0].memo.lock;
    stolen.bound = c.deps[0].memo.bound;
    let c = with_memo(c, 3, stolen);
    let r = c.run();
    assert!(r.all_pass(), "{:?} {}", failing(&r), details(&r, "S7"));
    let s = r.sealed.unwrap();
    assert!(s.deposits[3].no_bid.as_deref().unwrap().contains("tag does not match"), "{:?}", s.deposits[3].no_bid);
    assert_eq!(s.winners, vec![nf(&c.n(0)), nf(&c.n(1))]);
    // a memo of the older kind (7 byte tag) in an auction with the long tag is no bid
    let c = honest_open("uniform");
    let old = honest("uniform").sx.memo(4, SMALL, 1);
    let mut older = c.sx.memo(4, SMALL, 1);
    older.bound = None;
    older.lock = old.lock;
    let c = with_memo(c, 3, older);
    let s = c.run().sealed.unwrap();
    assert_eq!(s.deposits[3].no_bid.as_deref(), Some("the memo is not of the kind this auction takes"));
}

#[test]
fn l2_without_the_block_times_a_void_close_cannot_be_concluded() {
    // the cheat: a host declares a good auction void (every deposit refunded, no winner pays) where nobody can read the block times
    let mut c = honest("uniform");
    c.extra.block_times = vec![];
    c.close_mut().outcome = "void".into();
    c.close_mut().winners = Some(vec![]);
    c.close_mut().clearing_price_zat = None;
    c.entries.retain(|e| e.kind != "settle");
    c.extra.treasury_notes.clear();
    for i in 0..4 {
        let n = c.n(i);
        c.set_note(spent(n.clone(), &refund(&n), 231));
    }
    let r = c.run();
    let s = r.sealed.as_ref().unwrap();
    assert!(!s.void, "never taken as void");
    assert!(s.cannot_conclude.as_deref().is_some_and(|w| w.contains("block times")));
    assert!(!r.all_pass(), "never a pass");
    let s5 = r.results.iter().find(|x| x.id == "S5").unwrap();
    assert!(s5.waiting && !s5.pass && s5.details[0].starts_with("cannot conclude"), "{:?}", s5.details);
    // with the block times, the same close fails S5 (round R came after bidding closed)
    let mut c2 = c;
    c2.extra.block_times = block_times(600);
    assert!(failing(&c2.run()).contains(&"S5"));
    // and a good auction whose block times are missing cannot be concluded either, though its bids still open and the rest is checked
    let mut c = honest("uniform");
    c.extra.block_times = vec![];
    let r = c.run();
    assert!(r.sealed.as_ref().unwrap().opened && r.sealed.as_ref().unwrap().cannot_conclude.is_some());
    assert_eq!(r.results.iter().filter(|x| !x.pass).map(|x| x.id).collect::<Vec<_>>(), vec!["S5"]);
}

#[test]
fn second_review_c1_a_deposit_taken_back_must_have_paid_its_refund_address() {
    // D takes its deposit back before the deadline with its early ticket (block 150); with the early key the recount opens that ticket
    let withdraw = |c: &mut Case, to: Option<[u8; 43]>| {
        let d = c.n(3);
        c.set_note(spent(d.clone(), &early(&d), 150));
        c.extra.payouts.retain(|f| f.txid != refund(&d));
        if let Some(to) = to {
            c.extra.payouts.push(PayoutFact { txid: early(&d), outputs: vec![paid(to, d.value_zat - FEE)], error: None, shape: Some(plain_shape()) });
        }
    };
    let mut c = honest_open("uniform");
    withdraw(&mut c, Some(valid_receiver()));
    let r = c.run();
    assert!(r.all_pass(), "{:?} {}", failing(&r), details(&r, "S4"));
    assert!(r.sealed.as_ref().unwrap().deposits[3].withdrawn);
    // the cheat: the early ticket the host made pays the host; the page was told to use it. S4 fails, naming it
    let mut c = honest_open("uniform");
    withdraw(&mut c, Some({ let mut o = valid_receiver(); o[0] ^= 1; o }));
    let r = c.run();
    assert_eq!(failing(&r), vec!["S4"]);
    assert!(details(&r, "S4").contains("the early ticket") && details(&r, "S4").contains("does not pay"), "{}", details(&r, "S4"));
    // not read from the chain: not taken on trust
    let mut c = honest_open("uniform");
    withdraw(&mut c, None);
    assert_eq!(failing(&c.run()), vec!["S4"]);
    // the keys the chain readers get name the early ticket with its own kind
    let c = { let mut c = honest_open("uniform"); withdraw(&mut c, Some(valid_receiver())); c };
    let d = c.n(3);
    let shared = payout::shared_secret(&hex32(&c.sx.secrets.payload_sk).unwrap(), &[0u8; 32]);
    assert!(payout_keys(&c.sx.rules, &c.entries, &c.notes).contains(&(early(&d), hex::encode(payout::payment_ovk(&shared, &nf(&d), payout::EARLY)))));
    // an auction made before the early key is not checked this way
    let mut c = honest("uniform");
    let d = c.n(3);
    c.set_note(spent(d.clone(), &early(&d), 150));
    assert!(c.run().all_pass());
}

#[test]
fn a_deposit_too_close_to_the_coin_cutoff_is_late_so_an_honest_host_never_fails_s3() {
    // open auctions here have a coin margin of 10: the cutoff is 190, so the last block for a deposit is 180
    let c0 = honest_open("uniform");
    assert_eq!(c0.sx.rules.sealed.as_ref().unwrap().last_deposit(DEADLINE), 180);
    // a payment mined at block 188, two blocks before the cutoff: its coin could not be mined in time. It is not a deposit (S3 owes it no
    // coin) and goes back on its own like any late payment
    let near = c0.sx.note(9, SMALL, 188, &c0.sx.memo(9, SMALL, 5_000_000));
    let mut c = honest_open("uniform");
    c.notes.push(spent(near.clone(), "near-return", 190));
    c.entries.push(return_entry(&c, &near, "near-return"));
    c.extra.payouts.push(PayoutFact { txid: "near-return".into(), outputs: vec![paid(valid_receiver(), SMALL - FEE)], error: None, shape: Some(plain_shape()) });
    let r = c.run();
    assert!(r.all_pass(), "{:?} {} {}", failing(&r), details(&r, "S3"), details(&r, "S7"));
    assert_eq!(r.sealed.as_ref().unwrap().deposits.len(), 4, "it is not a deposit");
    assert!(details(&r, "S7").contains("came too late to bid"), "{}", details(&r, "S7"));
    // not sent back: S7 fails (never S3)
    let mut c = honest_open("uniform");
    c.notes.push(near.clone());
    assert_eq!(failing(&c.run()), vec!["S7"]);
    // an auction made before the margin keeps its rule: the same payment there is a deposit that owes a coin
    let old = honest("uniform");
    assert_eq!(old.sx.rules.sealed.as_ref().unwrap().last_deposit(DEADLINE), DEADLINE - 3);
}

/// The honest late ticket of deposit `i`: two actions, only the fee leaving the pool, exactly its page's coin, the late ticket block as lock.
fn late_shape(i: u32) -> TxShape {
    TxShape { transparent_inputs: vec![format!("coins:{i}")], lock_time: CLAIM_AFTER, ..plain_shape() }
}

/// A valid receiver that is not the person's: the host's own address.
fn host_receiver() -> [u8; 43] {
    let sk: orchard::keys::SpendingKey = Option::from(orchard::keys::SpendingKey::from_bytes([8; 32])).expect("a valid spending key");
    orchard::keys::FullViewingKey::from(&sk).address_at(0u32, orchard::keys::Scope::External).to_raw_address_bytes()
}

/// The mentor's second review, the Blind bid hole: before 22 Oct 2026 a spend after the late ticket block counted as refunded whenever its id
/// was the "late" id the host wrote on its own list, without checking who it paid. A host that never closes names its own spend of each deposit
/// as the late ticket. A real late ticket spends the bid page's coin, which only the page can sign (after checking whom the ticket pays), so
/// a spend without that coin is caught with no key at all.
#[test]
fn a_hosts_own_spend_named_as_the_late_ticket_is_caught_by_its_shape() {
    let mut c = honest_open("uniform");
    c.entries.retain(|e| matches!(e.kind.as_str(), "issue" | "coin"));
    c.extra.treasury_notes.clear();
    c.extra.payouts.clear();
    for i in 0..4 {
        let n = c.n(i);
        c.set_note(spent(n.clone(), &late(&n), CLAIM_AFTER + 2));
        c.extra.payouts.push(PayoutFact { txid: late(&n), shape: Some(late_shape(i as u32)), ..Default::default() });
    }
    // every deposit back by its real late ticket: the host did not finish, and nothing else is wrong
    let r = c.run();
    assert!(r.did_not_finish);
    assert_eq!(failing(&r), vec!["S5", "S8"], "{}", details(&r, "S7"));
    // the host's own spend of deposit 2, written as its late ticket: no coin of the page's in it
    c.extra.payouts[2].shape = Some(TxShape { transparent_inputs: vec![], lock_time: CLAIM_AFTER, ..plain_shape() });
    let r = c.run();
    assert_eq!(failing(&r), vec!["S5", "S7", "S8"]);
    assert!(details(&r, "S7").contains("does not spend exactly the bid page's coin"), "{}", details(&r, "S7"));
    // or one that also takes another note out of the pool
    c.extra.payouts[2].shape = Some(TxShape { actions: 3, value_balance: FEE as i64 + 5_000_000, ..late_shape(2) });
    assert!(details(&c.run(), "S7").contains("shielded actions"));
    // or whose transaction was not read: for an auction made with every check, that is a failure too, never a pass
    c.extra.payouts.remove(2);
    let r = c.run();
    assert_eq!(failing(&r), vec!["S5", "S7", "S8"]);
    assert!(details(&r, "S7").contains("was not read"), "{}", details(&r, "S7"));
}

/// The same after an honest looking close: a losing deposit is not refunded but spent after the late ticket block by the "late" id on the
/// list. With late_key and the published payload key the recount opens it with its own key and sees whom it pays.
#[test]
fn a_late_ticket_that_does_not_pay_the_person_fails_s7_once_the_key_is_published() {
    let mut c = honest_open("uniform");
    let d = c.n(2);
    c.set_note(spent(d.clone(), &late(&d), CLAIM_AFTER + 1));
    c.extra.payouts.retain(|f| f.txid != refund(&d));
    c.extra.payouts.push(PayoutFact { txid: late(&d), outputs: vec![paid(valid_receiver(), d.value_zat - FEE)], shape: Some(late_shape(2)), error: None });
    let r = c.run();
    assert!(!failing(&r).contains(&"S7"), "an honest late ticket passes: {}", details(&r, "S7"));
    c.extra.payouts.last_mut().unwrap().outputs = vec![paid(host_receiver(), d.value_zat - FEE)];
    let r = c.run();
    assert_eq!(failing(&r), vec!["S7"]);
    assert!(details(&r, "S7").contains("the late ticket") && details(&r, "S7").contains("does not pay"), "{}", details(&r, "S7"));
}

/// Every new auction carries all four checks; an older one is said plainly to be not fully checkable, and the shape of a payment whose
/// transaction was not read is then left to that warning (an older auction's honest list still passes).
#[test]
fn an_auction_without_every_check_is_flagged_not_fully_checkable() {
    let c = honest_open("uniform");
    assert!(c.sx.rules.sealed.as_ref().unwrap().missing_checks().is_empty());
    assert!(!c.run().warnings.iter().any(|w| w.contains("cannot be fully checked")));
    let mut c = honest("uniform");
    let r = c.run();
    assert!(r.warnings.iter().any(|w| w.contains("cannot be fully checked") && w.contains("who a late ticket paid")), "{:?}", r.warnings);
    assert!(failing(&r).is_empty(), "{:?}", failing(&r));
    // an older auction whose late ticket was read and has the wrong shape still fails
    c.entries.retain(|e| matches!(e.kind.as_str(), "issue" | "coin"));
    c.extra.treasury_notes.clear();
    let d = c.n(1);
    c.set_note(spent(d.clone(), &late(&d), CLAIM_AFTER + 2));
    c.extra.payouts.push(PayoutFact { txid: late(&d), shape: Some(plain_shape()), ..Default::default() });
    assert!(details(&c.run(), "S7").contains("does not spend exactly the bid page's coin"));
}
