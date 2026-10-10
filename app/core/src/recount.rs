//! Recount (SPEC §5): checks R1 to R8 from the rules, the ledger, published challenges and
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
    let in_range = |n: &ChainNote| n.height.is_some_and(|h| h >= rules.start_height && h <= rules.deadline_height);
    let mut keys = BTreeSet::new();
    let mut order: Vec<&ChainNote> = notes.iter().filter(|n| !n.is_change && in_range(n) && n.memo_text.as_deref().is_some_and(is_payload_shaped)).collect();
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

pub fn analyze(rules: &Rules, rules_id: &str, ledger: &[Entry], notes: &[ChainNote], challenges: &[Challenge]) -> Analysis {
    let mut a = Analysis::default();
    let in_range = |n: &ChainNote| {
        n.height.is_some_and(|h| h >= rules.start_height && h <= rules.deadline_height)
    };

    let rejected: BTreeSet<&str> =
        ledger.iter().filter(|e| e.kind == "reject").filter_map(Entry::nf).collect();
    let rejected_nfs: BTreeSet<String> = rejected.iter().map(|x| x.to_string()).collect();
    let replay_keys = replayed_keys(rules, notes, &rejected_nfs);
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
            (hex::encode(p.rules_id) == rules_id && p.amount_zat.is_none_or(|amt| n.value_zat >= amt)).then_some(p)
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
                        "{}:{} was accepted as a contribution, but the published secret opens a message promising at least {amt} zat and only {} zat were paid",
                        n.txid, n.action, n.value_zat
                    ));
                }
            }
        }
    }

    for n in &a.contributions {
        let (Some(nf), Some(s)) = (&n.nf, &n.spent_by) else { continue };
        let by_ticket = a.tickets.get(nf).is_some_and(|t| t.contains(&s.txid));
        if by_ticket && s.height.is_some_and(|h| h <= rules.deadline_height) {
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
    } else {
        let net: u64 = active.iter().map(|n| n.value_zat).sum();
        let met = net >= rules.goal_zat.unwrap_or(u64::MAX);
        a.goal_met = Some(met);
        if met {
            a.keep = active.iter().filter_map(|n| n.nf.clone()).collect();
        }
    }
    a
}

#[derive(Debug)]
pub struct RuleResult {
    pub id: &'static str,
    pub title: &'static str,
    pub pass: bool,
    pub details: Vec<String>,
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

/// Extra chain data for a uniform auction.
#[derive(Clone, Debug, Default)]
pub struct Extra {
    /// Notes received by the treasury (scanned with its public viewing key).
    pub treasury_notes: Vec<ChainNote>,
    pub tx_facts: Vec<TxFacts>,
    pub checks: Vec<DisclosureCheck>,
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
}

impl Report {
    pub fn all_pass(&self) -> bool {
        self.results.iter().all(|r| r.pass)
    }
}

fn rule(id: &'static str, title: &'static str, fails: Vec<String>, info: Vec<String>) -> RuleResult {
    let pass = fails.is_empty();
    RuleResult { id, title, pass, details: if pass { info } else { fails } }
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
    if let Some(c) = close {
        if c.close_height <= rules.deadline_height {
            r2.push(format!("closed at {} before the deadline {}", c.close_height, rules.deadline_height));
        }
    }
    results.push(rule("R2", "ledger is signed, chained, gap-free, closed at most once after the deadline", r2, vec![]));

    let closed = tip > rules.deadline_height;
    let phase = if closed { "closed" } else { "open" };
    if !chain_visible {
        for (id, title) in [
            ("R3", "every ledger entry is a real payment"),
            ("R4", "every contribution has a ticket within K blocks"),
            ("R5", "no contribution spent before the deadline except by its ticket"),
            ("R6", "contributions not kept leave only through their tickets"),
            ("R7", "the declared outcome is what the rules select"),
            ("R8", "every reject is justified"),
        ] {
            results.push(rule(id, title, vec![], vec!["waiting for the viewing key to be revealed".into()]));
        }
        return Report { tip, phase, results, totals: Totals::default(), winners: None, goal_met: None, warnings: vec![], auction: None };
    }

    let a = analyze(rules, &rid, ledger, notes, challenges);
    let by_nf: BTreeMap<&str, &ChainNote> =
        notes.iter().filter_map(|n| n.nf.as_deref().map(|nf| (nf, n))).collect();
    let contribution_nfs: BTreeSet<&str> = a.contributions.iter().filter_map(|n| n.nf.as_deref()).collect();
    let amount_key = close.and_then(|c| c.amount_key.as_deref()).and_then(|k| hex32(k).ok());

    // R3: entries point at real payments with matching details.
    let mut r3 = vec![];
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
            other => r3.push(format!("entry {}: unknown kind {other}", e.seq)),
        }
    }
    results.push(rule("R3", "every ledger entry is a real payment", r3, vec![]));

    // R4: tickets within K blocks.
    let mut r4 = vec![];
    let mut pending = 0;
    for n in &a.contributions {
        let h = n.height.unwrap_or(0);
        let due = h + rules.ticket_k;
        match n.nf.as_deref().and_then(|nf| a.first_issue.get(nf)) {
            Some(issued) if *issued <= due => {}
            Some(issued) => r4.push(format!("{}:{} ticketed at {issued}, due by {due}", n.txid, n.action)),
            None if tip <= due => pending += 1,
            None => r4.push(format!("{}:{} (height {h}) has no ticket, due by {due}", n.txid, n.action)),
        }
    }
    let info4 = if pending > 0 { vec![format!("{pending} contribution(s) still inside the K-block window")] } else { vec![] };
    results.push(rule("R4", "every contribution has a ticket within K blocks", r4, info4));

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
        let evidence = format!("nullifier {nf} spent by {} at height {h}, not by its ticket", s.txid);
        match (h <= rules.deadline_height, by_ticket) {
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
                        r7.push(format!("declared clearing price {:?} differs from the recomputed {} (reserve {}, {} winner(s))", c.clearing_price_zat, plan.price_zat, plan.reserve_zat, plan.winners.len()));
                    }
                }
                if c.outcome != "auction" {
                    r7.push(format!("auction closed with outcome {:?}", c.outcome));
                }
            } else {
                let expect = if a.goal_met == Some(true) { "goal_met" } else { "goal_missed" };
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
    totals.donations_zat = a.donations.iter().map(|n| n.value_zat).sum();

    // Warn when the host moved a payment it rejected: that is its right if the reject was
    // just, but a contributor may still have a genuine claim (SPEC §4, challenges never expire).
    let warnings: Vec<String> = a
        .rejected_payments
        .iter()
        .filter_map(|n| {
            let s = n.spent_by.as_ref()?;
            Some(format!(
                "host swept a payment it rejected: {} zat ({}:{}), spent by {} at height {}. If this was a genuine contribution, its contributor can still publish a challenge.",
                n.value_zat,
                n.txid,
                n.action,
                s.txid,
                s.height.map_or("unconfirmed".to_string(), |h| h.to_string())
            ))
        })
        .collect();
    let mut warnings: Vec<String> = warnings;
    if !a.replayed.is_empty() {
        warnings.push(format!(
            "{} payment(s) repeated the sealed message of an earlier payment and were set aside as non-refundable donations (one payment code paid twice counts once): {}",
            a.replayed.len(),
            a.replayed.iter().map(|n| format!("{}:{} ({} zat)", n.txid, n.action, n.value_zat)).collect::<Vec<_>>().join(", ")
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
    Report { tip, phase, results, totals, winners: a.winners, goal_met: a.goal_met, warnings, auction }
}

fn zec(zat: u64) -> String {
    format!("{}.{:08}", zat / 100_000_000, zat % 100_000_000)
}

/// The recount's text report. Shared by the command line and the browser so both print
/// exactly the same thing for the same inputs.
pub fn render(report: &Report, rules: &Rules) -> String {
    use std::fmt::Write;
    let mut o = String::new();
    let _ = writeln!(o, "Recount at height {} (campaign {}, deadline {})", report.tip, report.phase, rules.deadline_height);
    for r in &report.results {
        let _ = writeln!(o, "  {} {}  {}", r.id, if r.pass { "PASS" } else { "FAIL" }, r.title);
        for d in &r.details {
            let _ = writeln!(o, "       - {d}");
        }
    }
    let t = &report.totals;
    let visible = report.goal_met.is_some() || report.winners.is_some();
    if visible {
        let _ = writeln!(o, "  Totals: raised {} ZEC in {} contribution(s)", zec(t.raised_zat), t.contributions);
        let _ = writeln!(
            o,
            "          withdrawn early {}, refunded {}, kept {}, still pending {}",
            zec(t.withdrawn_zat),
            zec(t.refunded_zat),
            zec(t.kept_zat),
            zec(t.pending_zat)
        );
        match (rules.goal_zat, report.goal_met, &report.winners) {
            (Some(g), Some(met), _) => {
                let _ = writeln!(o, "          goal {} ({})", zec(g), if met { "met" } else { "missed" });
            }
            (_, _, Some(w)) => {
                let _ = writeln!(o, "          winners (best first): {w:?}");
            }
            _ => {}
        }
        let _ = writeln!(
            o,
            "  Non-refundable donations (no valid memo or rejected): {} ZEC in {} payment(s)",
            zec(t.donations_zat),
            t.donations
        );
    }
    for w in &report.warnings {
        let _ = writeln!(o, "  WARNING: {w}");
    }
    let _ = writeln!(o, "RESULT: {}", if report.all_pass() { "PASS" } else { "FAIL" });
    o
}

#[cfg(test)]
mod tests;
