//! Recount (SPEC §5): checks R1 to R8 and R4b from the rules, the ledger, published challenges and
//! the notes a viewing key finds on chain. `analyze` is shared with the host app, so the
//! host's close decisions and the public recount are computed by the same code.

use std::collections::{BTreeMap, BTreeSet};

use crate::{
    hex32,
    ledger::{Close, Entry, GENESIS_PREV, amount_commit, verifying_key},
    payload::{Payload, is_payload_shaped},
    rules::{Rules, ufvk_hash},
};

/// A note received by the campaign account, as seen with its full viewing key.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ChainNote {
    pub txid: String,
    pub action: u32,
    pub value_zat: u64,
    /// Nullifier in transaction byte order (SPEC §0).
    pub nf: Option<String>,
    pub height: Option<u32>,
    /// Position of the transaction inside its block (tie-breaking by chain order).
    #[serde(default)]
    pub tx_index: Option<u32>,
    pub memo_text: Option<String>,
    pub is_change: bool,
    pub spent_by: Option<Spend>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Spend {
    pub txid: String,
    pub height: Option<u32>,
}

/// A contributor's published one-time memo secret, disputing a reject (SPEC §4).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Challenge {
    pub txid: String,
    pub action: u32,
    pub eph_sk: String,
    /// Uniform auction, winner's opt-in proof (SPEC §8.5): the incoming viewing key of the
    /// dedicated account that the refund address in the payload belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uivk: Option<String>,
    /// Uniform auction: the winner says the excess did not arrive (unverified without `uivk`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub complaint: bool,
    /// Blind bid auction with open payouts (the second review, H2): the rejected payment's memo, so a relay can check the secret opens it
    /// (the reject names the memo by its hash) and refuse junk that would fill the challenge slots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

/// Reverses a hex string's byte order (for nullifiers printed by nodes, SPEC §0).
pub fn reverse_hex(h: &str) -> Option<String> {
    let mut b = hex::decode(h).ok()?;
    b.reverse();
    Some(hex::encode(b))
}

/// What the rules say should happen to every payment, computed from public data.
#[derive(Debug, Default)]
pub struct Analysis {
    /// Payments owed a ticket (including falsely rejected ones).
    pub contributions: Vec<ChainNote>,
    /// Payments without a valid payload, or rejected justly: never refundable.
    pub donations: Vec<ChainNote>,
    /// Evidence lines for rejects that a challenge proved false.
    pub false_rejects: Vec<String>,
    /// Rejects that stand (no challenge, or the challenge did not open a valid payload).
    pub upheld_rejects: usize,
    /// The payments behind the upheld rejects (non-refundable donations).
    pub rejected_payments: Vec<ChainNote>,
    pub tickets: BTreeMap<String, BTreeSet<String>>,
    pub first_issue: BTreeMap<String, u32>,
    /// Contributions refunded by their own ticket at or before the deadline.
    pub withdrawn: BTreeSet<String>,
    /// Contributions the host may keep after the deadline.
    pub keep: BTreeSet<String>,
    pub goal_met: Option<bool>,
    pub winners: Option<Vec<String>>,
    /// Uniform auction: the price and the winners who defaulted.
    pub plan: Option<AuctionPlan>,
    /// Payments that repeated the sealed message of an earlier payment (SPEC §2): never contributions, always donations.
    pub replayed: Vec<ChainNote>,
    /// A fundraiser with a hard cap: the contributions not taken back that do not fit under the cap (chain order), refunded whole by their
    /// own ticket at the close. Empty for every campaign without a cap.
    pub over_cap: Vec<ChainNote>,
    /// A fundraiser its host cancelled (opt in, SPEC §4.4): nothing is kept, every contribution goes back by its own ticket.
    pub cancelled: bool,
}

/// Uniform auction (SPEC §8), computed from public data by the host and the recount alike.
#[derive(Clone, Debug, Default)]
pub struct AuctionPlan {
    /// Nullifiers of the winning bids, best first (defaulted winners included).
    pub winners: Vec<String>,
    /// What every winner pays the treasury (net of the fee).
    pub price_zat: u64,
    pub reserve_zat: u64,
    /// Winners whose note was spent by their own ticket after the deadline, before settlement.
    pub defaulted: Vec<String>,
}

/// Payments (txid, action) in the contribution window that repeat the sealed message of an earlier payment (chain order).
/// Shared by the host (which rejects them) and the recount (which sets them aside as donations).
pub fn replayed_keys(rules: &Rules, notes: &[ChainNote], rejected: &BTreeSet<String>) -> BTreeSet<(String, u32)> {
    replayed_keys_until(rules, rules.deadline_height, notes, rejected)
}

/// `replayed_keys` for payments up to `end` (the deadline, or an early close: see `contribution_end`).
pub fn replayed_keys_until(rules: &Rules, end: u32, notes: &[ChainNote], rejected: &BTreeSet<String>) -> BTreeSet<(String, u32)> {
    let in_range = |n: &ChainNote| n.height.is_some_and(|h| h >= rules.start_height && h <= end);
    let mut keys = BTreeSet::new();
    // A payment below the campaign minimum is never a contribution (the host skips it without an entry), so it cannot use up a message
    // either: otherwise a small copy mined first would turn the real payment into a "replay" (the encrypted bids research, flaw 2).
    let mut order: Vec<&ChainNote> = notes
        .iter()
        .filter(|n| !n.is_change && in_range(n) && n.value_zat >= rules.min_contribution_zat && n.memo_text.as_deref().is_some_and(is_payload_shaped))
        .collect();
    order.sort_by(|x, y| x.height.cmp(&y.height).then(x.tx_index.cmp(&y.tx_index)).then(x.txid.cmp(&y.txid)).then(x.action.cmp(&y.action)));
    // A payment the host rejected (for instance because it was smaller than the amount sealed in its message) does not use up the
    // message: a later payment with the same message can still be the contribution. Only an accepted payment does.
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for n in order {
        let memo = n.memo_text.as_deref().unwrap_or_default();
        let is_rejected = n.nf.as_ref().is_some_and(|nf| rejected.contains(nf));
        if seen.contains(memo) {
            keys.insert((n.txid.clone(), n.action));
        } else if !is_rejected {
            seen.insert(memo);
        }
    }
    keys
}

/// The last height whose payments count as contributions: the deadline, or the close height of a fundraiser that allows closing early
/// and was closed early (SPEC §4), or of a fundraiser that allows cancelling and was cancelled (SPEC §4.4). For every other campaign,
/// including one whose host wrote an early close or a cancel it was not allowed (R2 fails then), it is the deadline, so nothing else about
/// such a campaign changes.
pub fn contribution_end(rules: &Rules, ledger: &[Entry]) -> u32 {
    match close_entry(ledger) {
        Some(c) if rules.allows_early_close() && c.close_height <= rules.deadline_height => c.close_height,
        _ if cancel_of(rules, ledger).is_some() => cancel_of(rules, ledger).map_or(rules.deadline_height, |c| c.close_height),
        _ => rules.deadline_height,
    }
}

/// The host's cancel, when it counts (SPEC §4.4): the close entry says "cancelled", the campaign's rules allow it, and it was written by the
/// deadline. A cancel on any other campaign is not one: R2 fails and the campaign is judged as if it were an ordinary close.
pub fn cancel_of<'a>(rules: &Rules, ledger: &'a [Entry]) -> Option<&'a Close> {
    close_entry(ledger).filter(|c| c.outcome == "cancelled" && rules.allows_cancel() && c.close_height <= rules.deadline_height)
}

pub fn analyze(rules: &Rules, rules_id: &str, ledger: &[Entry], notes: &[ChainNote], challenges: &[Challenge]) -> Analysis {
    let mut a = Analysis::default();
    let end = contribution_end(rules, ledger);
    let in_range = |n: &ChainNote| {
        n.height.is_some_and(|h| h >= rules.start_height && h <= end)
    };

    let rejected: BTreeSet<&str> =
        ledger.iter().filter(|e| e.kind == "reject").filter_map(Entry::nf).collect();
    let rejected_nfs: BTreeSet<String> = rejected.iter().map(|x| x.to_string()).collect();
    let replay_keys = replayed_keys_until(rules, end, notes, &rejected_nfs);
    for e in ledger.iter().filter(|e| e.ticket.is_some()) {
        let (Some(nf), Some(t)) = (e.nf(), &e.ticket) else { continue };
        a.tickets.entry(nf.into()).or_default().insert(t.txid.clone());
        let h = a.first_issue.entry(nf.into()).or_insert(t.issue_height);
        *h = (*h).min(t.issue_height);
    }

    // Replays: the same sealed message in a later payment. Only the earliest payment (chain order) can be a contribution;
    // a copy cannot become one, not even by a challenge, because it is not a new contribution by anyone.
    for n in notes.iter().filter(|n| !n.is_change && in_range(n)) {
        let shaped = n.memo_text.as_deref().is_some_and(is_payload_shaped);
        if replay_keys.contains(&(n.txid.clone(), n.action)) {
            a.replayed.push(n.clone());
            a.donations.push(n.clone());
            continue;
        }
        if !shaped || n.value_zat < rules.min_contribution_zat {
            a.donations.push(n.clone());
            continue;
        }
        let nf = n.nf.clone().unwrap_or_default();
        if !rejected.contains(nf.as_str()) {
            a.contributions.push(n.clone());
            continue;
        }
        // A rejected payment: did its contributor prove the reject false?
        let proven = challenges.iter().filter(|c| c.txid == n.txid && c.action == n.action).find_map(|c| {
            let esk = crypto_box::SecretKey::from(hex32(&c.eph_sk).ok()?);
            let payload_pk = hex32(&rules.payload_pubkey).ok()?;
            let p = Payload::open_challenged(n.memo_text.as_deref()?, &payload_pk, &esk).ok()?;
            // a payload smaller than... : a payment below the amount sealed in its message is not a contribution (SPEC §2), so a
            // reject for that reason is justified, not false
            // ...and the same goes for every other part of the one validity rule the host applies (`payload::check`): a reject for a
            // refund address that cannot be paid, or for nothing left after the fee, is justified too
            crate::payload::check(&p, rules_id, n.value_zat, rules.refund_fee_zat).is_ok().then_some(p)
        });
        match proven {
            Some(_) => {
                a.false_rejects.push(format!(
                    "{}:{} was rejected, but the published secret opens a valid payload for this campaign",
                    n.txid, n.action
                ));
                a.contributions.push(n.clone());
            }
            None => {
                a.upheld_rejects += 1;
                a.rejected_payments.push(n.clone());
                a.donations.push(n.clone());
            }
        }
    }

    // A contribution the host accepted although its (challenged) message promised more than was paid: visible only when the contributor
    // reveals the one-time secret.
    for n in &a.contributions {
        for c in challenges.iter().filter(|c| c.txid == n.txid && c.action == n.action && c.uivk.is_none() && !c.complaint) {
            let opened = (|| {
                let esk = crypto_box::SecretKey::from(hex32(&c.eph_sk).ok()?);
                let pk = hex32(&rules.payload_pubkey).ok()?;
                let p = Payload::open_challenged(n.memo_text.as_deref()?, &pk, &esk).ok()?;
                (hex::encode(p.rules_id) == rules_id).then_some(p)
            })();
            if let Some(amt) = opened.and_then(|p| p.amount_zat) {
                if n.value_zat < amt {
                    a.false_rejects.push(format!(
                        "{}:{} was accepted as a contribution, but the published secret opens a message promising at least {} and only {} were paid",
                        n.txid, n.action, rules.amount(amt), rules.amount(n.value_zat)
                    ));
                }
            }
        }
    }

    for n in &a.contributions {
        let (Some(nf), Some(s)) = (&n.nf, &n.spent_by) else { continue };
        let by_ticket = a.tickets.get(nf).is_some_and(|t| t.contains(&s.txid));
        if by_ticket && s.height.is_some_and(|h| h <= end) {
            a.withdrawn.insert(nf.clone());
        }
    }
    let mut active: Vec<&ChainNote> = a
        .contributions
        .iter()
        .filter(|n| n.nf.as_ref().is_some_and(|nf| !a.withdrawn.contains(nf)))
        .collect();

    if rules.is_auction() {
        // Ties: chain order (height, position in the block, action), never the host's ledger order.
        active.sort_by(|x, y| {
            y.value_zat
                .cmp(&x.value_zat)
                .then(x.height.cmp(&y.height))
                .then(x.tx_index.cmp(&y.tx_index))
                .then(x.txid.cmp(&y.txid))
                .then(x.action.cmp(&y.action))
        });
        let items = rules.items.unwrap_or(0) as usize;
        if rules.is_uniform() {
            let fee = rules.refund_fee_zat;
            let reserve = rules.reserve_zat.unwrap_or(0);
            let winning: Vec<&&ChainNote> = active
                .iter()
                .filter(|n| n.value_zat.saturating_sub(fee) >= reserve)
                .take(items)
                .collect();
            let price = if winning.len() == items { winning.last().map_or(reserve, |n| n.value_zat - fee) } else { reserve };
            let winners: Vec<String> = winning.iter().filter_map(|n| n.nf.clone()).collect();
            let defaulted: Vec<String> = winning
                .iter()
                .filter(|n| {
                    let (Some(nf), Some(s)) = (&n.nf, &n.spent_by) else { return false };
                    let own_ticket = a.tickets.get(nf).is_some_and(|t| t.contains(&s.txid));
                    own_ticket && s.height.is_some_and(|h| h > rules.deadline_height && h <= rules.settle_by())
                })
                .filter_map(|n| n.nf.clone())
                .collect();
            a.keep = winners.iter().cloned().collect();
            a.plan = Some(AuctionPlan { winners: winners.clone(), price_zat: price, reserve_zat: reserve, defaulted });
            a.winners = Some(winners);
        } else {
            let winners: Vec<String> = active.iter().take(items).filter_map(|n| n.nf.clone()).collect();
            a.keep = winners.iter().cloned().collect();
            a.winners = Some(winners);
        }
    } else if let Some(cap) = rules.cap_zat {
        // A hard cap (SPEC §4): in chain order, keep each contribution that still fits under the cap; one that does not fit is refunded whole by
        // its own ticket (a ticket cannot split a payment). A large payment that does not fit does not stop later ones that do. The goal (the
        // soft cap) is counted on the kept amount only.
        active.sort_by(|x, y| x.height.cmp(&y.height).then(x.tx_index.cmp(&y.tx_index)).then(x.txid.cmp(&y.txid)).then(x.action.cmp(&y.action)));
        let mut room = cap;
        let mut kept: Vec<&ChainNote> = vec![];
        for n in active {
            if n.value_zat <= room {
                room -= n.value_zat;
                kept.push(n);
            } else {
                a.over_cap.push(n.clone());
            }
        }
        let met = cap - room >= rules.goal_zat.unwrap_or(u64::MAX);
        a.goal_met = Some(met);
        if met {
            a.keep = kept.iter().filter_map(|n| n.nf.clone()).collect();
        }
    } else {
        let net: u64 = active.iter().map(|n| n.value_zat).sum();
        let met = net >= rules.goal_zat.unwrap_or(u64::MAX);
        a.goal_met = Some(met);
        if met {
            a.keep = active.iter().filter_map(|n| n.nf.clone()).collect();
        }
    }
    // cancelled: whatever the goal, nothing is kept; every contribution goes back by its own ticket
    if cancel_of(rules, ledger).is_some() {
        a.cancelled = true;
        a.keep.clear();
    }
    a
}

#[derive(Debug)]
pub struct RuleResult {
    pub id: &'static str,
    pub title: &'static str,
    pub pass: bool,
    pub details: Vec<String>,
    /// The check could not run yet (an auction before its close: the viewing key is not published). `pass` stays true so that
    /// verdicts do not change, but the text output says WAIT, not PASS.
    pub waiting: bool,
}

#[derive(Debug, Default)]
pub struct Totals {
    pub raised_zat: u64,
    pub contributions: usize,
    pub withdrawn_zat: u64,
    pub refunded_zat: u64,
    pub kept_zat: u64,
    pub pending_zat: u64,
    pub donations_zat: u64,
    pub donations: usize,
    /// A fundraiser with a hard cap: the contributions that do not fit under it (refunded by ticket at the close), and their amount.
    pub over_cap: usize,
    pub over_cap_zat: u64,
}

/// Facts about a full transaction that the compact blocks do not show.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TxFacts {
    pub txid: String,
    /// Net value leaving the shielded pools (= the fee for a fully shielded transaction).
    pub fee_zat: i64,
    pub ironwood_actions: usize,
    pub has_orchard: bool,
    pub has_sapling: bool,
    pub has_transparent: bool,
}

/// What a winner's opt-in viewing key saw in their settlement transaction (SPEC §8.5), computed
/// next to the chain data (the browser module or the host).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DisclosureCheck {
    /// The contribution the disclosure belongs to.
    pub txid: String,
    pub action: u32,
    /// The viewing key derives the refund address inside the opened payload.
    pub key_matches_refund: bool,
    /// Values of the outputs of the settlement transaction that the key can open.
    pub delivered: Vec<u64>,
    pub error: Option<String>,
}

/// Sealed bid auction: a transparent output the chain shows (the coin the host sent to a bid page, SPEC §9.4).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CoinFact {
    pub txid: String,
    pub index: u32,
    pub value_zat: u64,
    /// The output's script (hex): a payment to a transparent address.
    pub script_hex: String,
    /// The block it was mined in (absent: not mined).
    pub height: Option<u32>,
}

/// Extra chain data for a uniform or a sealed bid auction.
#[derive(Clone, Debug, Default)]
pub struct Extra {
    /// Notes received by the treasury (scanned with its public viewing key).
    pub treasury_notes: Vec<ChainNote>,
    pub tx_facts: Vec<TxFacts>,
    pub checks: Vec<DisclosureCheck>,
    /// Sealed bid auction: the coins named on the list, as the chain shows them.
    pub coins: Vec<CoinFact>,
    /// Sealed bid auction: (height, block time) of the 11 blocks up to the deadline, for the void rule (SPEC §9.7).
    pub block_times: Vec<(u32, u64)>,
    /// Sealed bid auction with `open_payouts`: the outputs of each payment the host signed to a person, opened on the chain with the key
    /// `sealed_recount::payout_keys` names (SPEC §9.1, open_payouts).
    pub payouts: Vec<PayoutFact>,
}

/// One payment's outputs as its outgoing viewing key opens them on the chain.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct PayoutFact {
    pub txid: String,
    pub outputs: Vec<PaidOutput>,
    /// Why the transaction could not be read or opened.
    pub error: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct PaidOutput {
    /// The raw Orchard/Ironwood receiver (43 bytes, hex).
    pub receiver_hex: String,
    pub value_zat: u64,
}

/// The uniform auction's result lines for the report.
#[derive(Debug, Default)]
pub struct AuctionReport {
    pub price_zat: u64,
    pub reserve_zat: u64,
    pub winners: usize,
    pub settled: usize,
    pub awaiting: usize,
    pub defaulted: Vec<String>,
    pub treasury_total_zat: u64,
    pub excess_zat: u64,
    pub proofs_ok: usize,
    pub complaints: usize,
}

#[derive(Debug)]
pub struct Report {
    pub tip: u32,
    pub phase: &'static str,
    pub results: Vec<RuleResult>,
    pub totals: Totals,
    pub winners: Option<Vec<String>>,
    pub goal_met: Option<bool>,
    /// Not rule failures, but things readers should see (e.g. a swept rejected payment).
    pub warnings: Vec<String>,
    pub auction: Option<AuctionReport>,
    /// Sealed bid auction: the host did not finish (SPEC §9.7): shown as "did not finish" on the recount and in the listing.
    pub did_not_finish: bool,
    /// Sealed bid auction: the opened bids and the outcome.
    pub sealed: Option<crate::sealed_recount::SealedReport>,
}

impl Report {
    pub fn all_pass(&self) -> bool {
        self.results.iter().all(|r| r.pass)
    }
}

fn rule(id: &'static str, title: &'static str, fails: Vec<String>, info: Vec<String>) -> RuleResult {
    let pass = fails.is_empty();
    RuleResult { id, title, pass, details: if pass { info } else { fails }, waiting: false }
}

pub fn close_entry(ledger: &[Entry]) -> Option<&Close> {
    ledger.iter().find(|e| e.kind == "close").and_then(|e| e.close.as_ref())
}

/// `chain_visible` is false while an auction's viewing key is still sealed: then only the
/// rules and the ledger's integrity can be checked.
pub fn recount(
    rules: &Rules,
    published_rules_id: &str,
    ledger: &[Entry],
    notes: &[ChainNote],
    challenges: &[Challenge],
    tip: u32,
    chain_visible: bool,
) -> Report {
    recount_with(rules, published_rules_id, ledger, notes, challenges, tip, chain_visible, &Extra::default())
}

#[allow(clippy::too_many_arguments)]
pub fn recount_with(
    rules: &Rules,
    published_rules_id: &str,
    ledger: &[Entry],
    notes: &[ChainNote],
    challenges: &[Challenge],
    tip: u32,
    chain_visible: bool,
    extra: &Extra,
) -> Report {
    if rules.is_sealed() {
        return crate::sealed_recount::recount_sealed(rules, published_rules_id, ledger, notes, challenges, tip, chain_visible, extra);
    }
    let rid = published_rules_id.to_lowercase();
    let mut results = vec![];
    let close = close_entry(ledger);

    // R1: the rules, and (auction) the revealed key, are the committed ones.
    let mut r1 = vec![];
    match rules.id() {
        Ok(id) if hex::encode(id) == rid => {}
        Ok(id) => r1.push(format!("rules hash {} != published {rid}", hex::encode(id))),
        Err(e) => r1.push(format!("cannot hash rules: {e}")),
    }
    if let Err(e) = rules.validate() {
        r1.push(e.to_string());
    }
    if rules.is_auction() {
        if let Some(c) = close {
            match &c.ufvk {
                Some(k) if Some(ufvk_hash(k)) == rules.ufvk_hash => {}
                Some(_) => r1.push("revealed viewing key does not match the committed hash".into()),
                None => r1.push("auction closed without revealing its viewing key".into()),
            }
        }
    }
    results.push(rule("R1", "rules (and revealed key) match what was committed", r1, vec![]));

    // R2: signatures, hash chain, one close after the deadline.
    let mut r2 = vec![];
    match verifying_key(&rules.ledger_pubkey) {
        Err(e) => r2.push(format!("bad ledger_pubkey: {e}")),
        Ok(pk) => {
            let mut prev = GENESIS_PREV.to_string();
            for (i, e) in ledger.iter().enumerate() {
                if e.seq != i as u64 {
                    r2.push(format!("entry {i}: seq {} (gap or reorder)", e.seq));
                }
                if e.prev != prev {
                    r2.push(format!("entry {}: prev hash does not match the previous entry", e.seq));
                }
                if e.rules_id != rid {
                    r2.push(format!("entry {}: belongs to another campaign", e.seq));
                }
                if let Err(err) = e.verify(&pk) {
                    r2.push(format!("entry {}: bad signature ({err})", e.seq));
                }
                prev = e.hash().unwrap_or_default();
            }
        }
    }
    if ledger.iter().filter(|e| e.kind == "close").count() > 1 {
        r2.push("more than one close entry".into());
    }
    if let Some(c) = close.filter(|c| c.outcome == "cancelled") {
        // a cancel (SPEC §4.4): only a fundraiser whose rules allow it, and only by the deadline
        if !rules.allows_cancel() {
            r2.push(format!("cancelled at block {}, but this campaign's rules do not allow cancelling", c.close_height));
        } else if c.close_height > rules.deadline_height {
            r2.push(format!("cancelled at block {}, after the deadline, block {}; a cancel must come by the deadline", c.close_height, rules.deadline_height));
        }
    } else if let Some(c) = close {
        if c.close_height <= rules.deadline_height {
            // early: only a fundraiser whose rules allow it, and only as "goal met" (R7 checks the goal really was met by then)
            if !rules.allows_early_close() {
                r2.push(format!("closed at block {} before the deadline, block {}", c.close_height, rules.deadline_height));
            } else if c.outcome != "goal_met" {
                r2.push(format!("closed early at block {} (before the deadline, block {}) with outcome {:?}; an early close is allowed only once the goal is met", c.close_height, rules.deadline_height, c.outcome));
            }
        }
    }
    let info2 = match close {
        Some(c) if cancel_of(rules, ledger).is_some() => vec![format!(
            "cancelled by the host at block {} ({} blocks before the deadline), which this campaign's rules allow: every contribution goes back by its own ticket, minus the network fee, and payments after block {} do not count",
            c.close_height, rules.deadline_height - c.close_height, c.close_height
        )],
        Some(c) if rules.allows_early_close() && c.close_height <= rules.deadline_height => vec![format!(
            "closed early at block {} ({} blocks before the deadline), which this campaign's rules allow once the goal is met; payments after block {} do not count",
            c.close_height, rules.deadline_height - c.close_height, c.close_height
        )],
        _ => vec![],
    };
    results.push(rule("R2", "ledger is signed, chained, with no gaps, closed at most once after the deadline", r2, info2));

    // a fundraiser closed early (allowed by its rules) is closed from its close height on; payments after it do not count
    let end = contribution_end(rules, ledger);
    let early_closed = rules.allows_early_close() && close.is_some_and(|c| c.close_height <= rules.deadline_height);
    let cancelled = cancel_of(rules, ledger).is_some();
    let closed = tip > rules.deadline_height || early_closed || cancelled;
    let phase = if closed { "closed" } else { "open" };
    if !chain_visible {
        for (id, title) in [
            ("R3", "every ledger entry is a real payment"),
            ("R4", "every contribution has a ticket once K blocks have passed"),
            ("R4b", "each ticket was issued within K blocks (host reported height)"),
            ("R5", "no contribution spent before the deadline except by its ticket"),
            ("R6", "contributions not kept leave only through their tickets"),
            ("R7", "the declared outcome is what the rules select"),
            ("R8", "every reject is justified"),
        ] {
            results.push(RuleResult { waiting: true, ..rule(id, title, vec![], vec!["waiting for the viewing key to be revealed".into()]) });
        }
        return Report { tip, phase, results, totals: Totals::default(), winners: None, goal_met: None, warnings: vec![], auction: None, did_not_finish: false, sealed: None };
    }

    let a = analyze(rules, &rid, ledger, notes, challenges);

    // An early close height is written by the host (docs/THREAT_MODEL.md threat 26). Payments that look like contributions and were mined
    // after it, up to the sweep of the kept contributions, are listed under R2 (information only: an honest early close can have them too).
    if let Some(c) = close.filter(|c| rules.allows_early_close() && c.close_height <= rules.deadline_height) {
        let swept = a.contributions.iter().filter(|n| n.nf.as_ref().is_some_and(|nf| a.keep.contains(nf))).filter_map(|n| n.spent_by.as_ref()?.height).min();
        let until = swept.unwrap_or(tip).min(rules.deadline_height);
        let after: Vec<String> = notes
            .iter()
            .filter(|n| !n.is_change && n.value_zat >= rules.min_contribution_zat && n.memo_text.as_deref().is_some_and(is_payload_shaped))
            .filter(|n| n.height.is_some_and(|h| h > c.close_height && h <= until))
            .map(|n| format!("{}:{} (block {})", n.txid, n.action, n.height.unwrap_or(0)))
            .collect();
        if let Some(r) = results.iter_mut().find(|r| r.id == "R2" && r.pass).filter(|_| !after.is_empty()) {
            r.details.push(format!(
                "{} payment(s) that look like contributions were mined after the close height and {}: {}. They are not counted. An honest early close can have such payments too, but a host could also write an early close height to leave out a payment whose ticket it held back; their senders can ask the host to return them",
                after.len(),
                if swept.is_some() { format!("before the kept contributions were swept (block {until})") } else { format!("up to block {until}") },
                after.join(", ")
            ));
        }
    }
    let by_nf: BTreeMap<&str, &ChainNote> =
        notes.iter().filter_map(|n| n.nf.as_deref().map(|nf| (nf, n))).collect();
    let contribution_nfs: BTreeSet<&str> = a.contributions.iter().filter_map(|n| n.nf.as_deref()).collect();
    let amount_key = close.and_then(|c| c.amount_key.as_deref()).and_then(|k| hex32(k).ok());

    // R3: entries point at real payments with matching details.
    let mut r3 = vec![];
    let ticketed: BTreeSet<&str> = ledger.iter().filter(|e| e.ticket.is_some()).filter_map(Entry::nf).collect();
    for e in ledger.iter().filter(|e| e.kind != "close" && e.kind != "settle") {
        let Some(c) = &e.contribution else {
            r3.push(format!("entry {}: {} without a contribution", e.seq, e.kind));
            continue;
        };
        let Some(n) = by_nf.get(c.nf.as_str()) else {
            r3.push(format!("entry {}: nullifier {} is not a payment to the campaign", e.seq, c.nf));
            continue;
        };
        if n.txid != c.txid || n.action != c.action || n.height != Some(c.height) {
            r3.push(format!("entry {}: payment details differ from the chain", e.seq));
        }
        match e.kind.as_str() {
            "reject" => {
                if !n.memo_text.as_deref().is_some_and(is_payload_shaped) {
                    r3.push(format!("entry {}: reject for a payment without an LL1 memo", e.seq));
                }
            }
            "issue" | "reissue" => {
                if e.ticket.is_none() {
                    r3.push(format!("entry {}: {} without a ticket", e.seq, e.kind));
                }
                if !contribution_nfs.contains(c.nf.as_str()) {
                    r3.push(format!("entry {}: ticket for a payment that is not a contribution", e.seq));
                }
                if rules.is_auction() {
                    match (&c.amount_commit, amount_key) {
                        (Some(commit), Some(k)) => {
                            if amount_commit(&k, &c.nf, n.value_zat).ok().as_ref() != Some(commit) {
                                r3.push(format!("entry {}: amount commitment does not match the bid", e.seq));
                            }
                        }
                        (None, _) => r3.push(format!("entry {}: auction entry without amount commitment", e.seq)),
                        (Some(_), None) => {}
                    }
                    if c.value_zat.is_some() {
                        r3.push(format!("entry {}: auction entry reveals the bid amount", e.seq));
                    }
                } else if c.value_zat != Some(n.value_zat) {
                    r3.push(format!("entry {}: amount differs from the chain", e.seq));
                }
            }
            // a cancelled fundraiser (SPEC §4.4): a payment the list never named, sent back by the host after the cancel
            "late_return" if !rules.is_sealed() => {
                if !cancelled {
                    r3.push(format!("entry {}: a payment sent back, but the campaign was not cancelled", e.seq));
                }
                if ticketed.contains(c.nf.as_str()) {
                    r3.push(format!("entry {}: sends back a payment that has a ticket (it is refunded by its ticket)", e.seq));
                }
                if let (Some(s), Some(back)) = (&n.spent_by, &e.refund) {
                    if &s.txid != back {
                        r3.push(format!("entry {}: the payment was spent by {}, not by the return the list names ({back})", e.seq, s.txid));
                    }
                }
            }
            other => r3.push(format!("entry {}: unknown kind {other}", e.seq)),
        }
    }
    results.push(rule("R3", "every ledger entry is a real payment", r3, vec![]));

    // R4 (completeness): every contribution has a ticket entry once K blocks have passed; inside the window it is pending.
    // R4b (timeliness): each ticket's issue height is at most the payment's height + K. That height is written by the host, so R4b
    // shows what the host reports and nothing more (docs/THREAT_MODEL.md threat 22). Together they are the former single R4: it
    // passed exactly when both pass.
    let mut r4 = vec![];
    let mut r4b = vec![];
    let mut pending = 0;
    for n in &a.contributions {
        let h = n.height.unwrap_or(0);
        let due = h + rules.ticket_k;
        match n.nf.as_deref().and_then(|nf| a.first_issue.get(nf)) {
            Some(issued) if *issued <= due => {}
            Some(issued) => r4b.push(format!("{}:{} ticketed in block {issued} (the block the host reports), due by block {due}", n.txid, n.action)),
            None if tip <= due => pending += 1,
            None => r4.push(format!("{}:{} (block {h}) has no ticket, due by block {due}", n.txid, n.action)),
        }
    }
    let info4 = if pending > 0 { vec![format!("{pending} contribution(s) still inside the K-block window")] } else { vec![] };
    results.push(rule("R4", "every contribution has a ticket once K blocks have passed", r4, info4));
    let info4b = if a.first_issue.is_empty() { vec![] } else { vec!["issue heights are reported by the host; the recount cannot check them".into()] };
    results.push(rule("R4b", "each ticket was issued within K blocks (host reported height)", r4b, info4b));

    // R5 and R6: spends.
    let mut totals = Totals { contributions: a.contributions.len(), ..Default::default() };
    let (mut r5, mut r6, mut awaiting) = (vec![], vec![], 0usize);
    for n in &a.contributions {
        totals.raised_zat += n.value_zat;
        let nf = n.nf.clone().unwrap_or_default();
        let Some((s, h)) = n.spent_by.as_ref().and_then(|s| s.height.map(|h| (s, h))) else {
            totals.pending_zat += n.value_zat;
            if closed && !a.keep.contains(&nf) {
                awaiting += 1;
            }
            continue;
        };
        let by_ticket = a.tickets.get(&nf).is_some_and(|t| t.contains(&s.txid));
        let evidence = format!("nullifier {nf} spent by {} in block {h}, not by its ticket", s.txid);
        match (h <= end, by_ticket) {
            (true, true) => totals.withdrawn_zat += n.value_zat,
            (true, false) => r5.push(evidence),
            (false, true) => totals.refunded_zat += n.value_zat,
            (false, false) if a.keep.contains(&nf) => totals.kept_zat += n.value_zat,
            (false, false) => r6.push(evidence),
        }
    }
    results.push(rule("R5", "no contribution spent before the deadline except by its ticket", r5, vec![]));
    let mut info6 = vec![];
    if !closed {
        info6.push("deadline not reached".into());
    } else if awaiting > 0 {
        let note = if tip > rules.self_refund_after() { "contributors may self-refund now" } else { "host is inside its close window" };
        info6.push(format!("{awaiting} contribution(s) awaiting refund; {note}"));
    }
    if !a.over_cap.is_empty() {
        let n = a.over_cap.len();
        info6.push(if closed {
            format!("{n} payment(s) over the cap, refunded by ticket")
        } else {
            format!("{n} payment(s) over the cap so far: each is refunded by its own ticket at the close, unless earlier contributions are taken back first")
        });
    }
    // a cancelled fundraiser: payments that reached it after the cancel and are not sent back yet (information: the recount cannot open their
    // messages, so it cannot tell whether one is for this campaign)
    if let Some(c) = cancel_of(rules, ledger) {
        let named: BTreeSet<&str> = ledger.iter().filter_map(Entry::nf).collect();
        let waiting: Vec<String> = notes
            .iter()
            .filter(|n| !n.is_change && n.spent_by.is_none() && n.memo_text.as_deref().is_some_and(is_payload_shaped))
            .filter(|n| n.height.is_some_and(|h| h > c.close_height) && n.nf.as_deref().is_some_and(|nf| !named.contains(nf)))
            .map(|n| format!("{}:{} (block {})", n.txid, n.action, n.height.unwrap_or(0)))
            .collect();
        if !waiting.is_empty() {
            info6.push(format!("{} payment(s) after the cancel not sent back yet: {}", waiting.len(), waiting.join(", ")));
        }
        let back = ledger.iter().filter(|e| e.kind == "late_return").count();
        if back > 0 {
            info6.push(format!("{back} payment(s) after the cancel sent back, minus the fee"));
        }
    }
    results.push(rule("R6", "contributions not kept leave only through their tickets", r6, info6));

    // R7: the declared outcome matches the recomputed one.
    let mut r7 = vec![];
    let mut info7 = vec![];
    match (close, closed) {
        (Some(c), _) => {
            if rules.is_auction() {
                if c.winners.as_ref() != a.winners.as_ref() {
                    r7.push(format!("declared winners {:?} differ from the recomputed {:?}", c.winners, a.winners));
                }
                if let Some(plan) = &a.plan {
                    if c.clearing_price_zat != Some(plan.price_zat) {
                        r7.push(format!("declared clearing price {} differs from the recomputed {} (reserve {}, {} winner(s))", c.clearing_price_zat.map_or("none".to_string(), |p| rules.amount(p)), rules.amount(plan.price_zat), rules.amount(plan.reserve_zat), plan.winners.len()));
                    }
                }
                if c.outcome != "auction" {
                    r7.push(format!("auction closed with outcome {:?}", c.outcome));
                }
            } else {
                let expect = if a.cancelled { "cancelled" } else if a.goal_met == Some(true) { "goal_met" } else { "goal_missed" };
                if c.outcome != expect {
                    r7.push(format!("declared {:?} but the contributions say {expect}", c.outcome));
                }
            }
        }
        (None, true) => info7.push("host has not closed".into()),
        (None, false) => info7.push("deadline not reached".into()),
    }
    results.push(rule("R7", "the declared outcome is what the rules select", r7, info7));

    // R8: rejects.
    let info8 = if a.upheld_rejects > 0 {
        vec![format!("{} reject(s) upheld; those payments are non-refundable donations", a.upheld_rejects)]
    } else {
        vec![]
    };
    results.push(rule("R8", "every reject is justified", a.false_rejects.clone(), info8));

    totals.donations = a.donations.len();
    totals.over_cap = a.over_cap.len();
    totals.over_cap_zat = a.over_cap.iter().map(|n| n.value_zat).sum();
    totals.donations_zat = a.donations.iter().map(|n| n.value_zat).sum();

    // Warn when the host moved a payment it rejected: that is its right if the reject was
    // just, but a contributor may still have a genuine claim (SPEC §4, challenges never expire).
    let warnings: Vec<String> = a
        .rejected_payments
        .iter()
        .filter_map(|n| {
            let s = n.spent_by.as_ref()?;
            Some(format!(
                "host swept a payment it rejected: {} ({}:{}), spent by {} in {}. If this was a genuine contribution, its contributor can still publish a challenge.",
                rules.amount(n.value_zat),
                n.txid,
                n.action,
                s.txid,
                s.height.map_or("a transaction not yet in a block".to_string(), |h| format!("block {h}"))
            ))
        })
        .collect();
    let mut warnings: Vec<String> = warnings;
    if !a.replayed.is_empty() {
        warnings.push(format!(
            "{} payment(s) repeated the sealed message of an earlier payment and were set aside as non-refundable donations (one payment code paid twice counts once): {}",
            a.replayed.len(),
            a.replayed.iter().map(|n| format!("{}:{} ({})", n.txid, n.action, rules.amount(n.value_zat))).collect::<Vec<_>>().join(", ")
        ));
    }
    let mut auction = None;
    if let Some(plan) = &a.plan {
        let (more, report, extra_warnings) = crate::auction::check_uniform(rules, &rid, ledger, &a, plan, notes, challenges, extra, tip);
        results.extend(more);
        warnings.extend(extra_warnings);
        // Uniform pricing: what the host kept is the price, not the whole bid.
        totals.kept_zat = report.treasury_total_zat;
        auction = Some(report);
    }
    Report { tip, phase, results, totals, winners: a.winners, goal_met: a.goal_met, warnings, auction, did_not_finish: false, sealed: None }
}

fn zec(zat: u64) -> String {
    crate::coin(zat)
}

/// The recount's text report. Shared by the command line and the browser so both print
/// exactly the same thing for the same inputs.
pub fn render(report: &Report, rules: &Rules) -> String {
    use std::fmt::Write;
    let mut o = String::new();
    let _ = writeln!(o, "Recount at block {} (campaign {}, deadline block {})", report.tip, report.phase, rules.deadline_height);
    let unit = if rules.network == "main" { "ZEC" } else { "TAZ" };
    for r in &report.results {
        let _ = writeln!(o, "  {} {}  {}", r.id, if r.waiting { "WAIT" } else if r.pass { "PASS" } else { "FAIL" }, r.title);
        for d in &r.details {
            let _ = writeln!(o, "       - {d}");
        }
    }
    let t = &report.totals;
    let visible = report.goal_met.is_some() || report.winners.is_some();
    if visible {
        let _ = writeln!(o, "  Totals: raised {} {unit} in {} contribution(s)", zec(t.raised_zat), t.contributions);
        let _ = writeln!(
            o,
            "          withdrawn early {}, refunded {}, kept {}, still pending {}",
            zec(t.withdrawn_zat),
            zec(t.refunded_zat),
            zec(t.kept_zat),
            zec(t.pending_zat)
        );
        match (rules.goal_zat, report.goal_met, &report.winners) {
            (Some(g), Some(met), _) => match rules.cap_zat {
                None => {
                    let _ = writeln!(o, "          goal {} ({})", zec(g), if met { "met" } else { "missed" });
                }
                Some(c) => {
                    let _ = writeln!(o, "          soft cap {} ({}), hard cap {}", zec(g), if met { "met" } else { "missed" }, zec(c));
                    let _ = writeln!(o, "          over the hard cap {} in {} payment(s), refunded by ticket at the close", zec(t.over_cap_zat), t.over_cap);
                }
            },
            (_, _, Some(w)) => {
                let _ = writeln!(o, "          winners (best first): {w:?}");
            }
            _ => {}
        }
        let _ = writeln!(
            o,
            "  Non-refundable donations (no valid memo or rejected): {} {unit} in {} payment(s)",
            zec(t.donations_zat),
            t.donations
        );
    }
    for w in &report.warnings {
        let _ = writeln!(o, "  WARNING: {w}");
    }
    let waiting: Vec<&str> = report.results.iter().filter(|r| r.waiting).map(|r| r.id).collect();
    if report.all_pass() && !waiting.is_empty() {
        let ran: Vec<&str> = report.results.iter().filter(|r| !r.waiting).map(|r| r.id).collect();
        let _ = writeln!(o, "RESULT: PASS for {} only; {} have not run (the viewing key is published at the close)", ran.join(", "), waiting.join(", "));
    } else {
        let _ = writeln!(o, "RESULT: {}", if report.all_pass() { "PASS" } else { "FAIL" });
    }
    o
}

#[cfg(test)]
mod tests;
