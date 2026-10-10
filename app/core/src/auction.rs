//! Uniform-price auction recount rules R9 to R12 (SPEC §8). Pure checks over public data: the
//! campaign's notes, the treasury's notes (its viewing key is public), facts about the settlement
//! transactions, and the optional proofs winners publish.

use std::collections::{BTreeMap, BTreeSet};

use crate::{
    hex32,
    ledger::Entry,
    payload::Payload,
    recount::{Analysis, AuctionPlan, AuctionReport, Challenge, ChainNote, Extra, RuleResult, TxFacts},
    rules::Rules,
};

fn rule(id: &'static str, title: &'static str, fails: Vec<String>, info: Vec<String>) -> RuleResult {
    let pass = fails.is_empty();
    RuleResult { id, title, pass, details: if pass { info } else { fails } }
}

#[allow(clippy::too_many_arguments)]
pub fn check_uniform(
    rules: &Rules,
    rules_id: &str,
    ledger: &[Entry],
    a: &Analysis,
    plan: &AuctionPlan,
    notes: &[ChainNote],
    challenges: &[Challenge],
    extra: &Extra,
    tip: u32,
) -> (Vec<RuleResult>, AuctionReport, Vec<String>) {
    let fee = rules.refund_fee_zat;
    let price = plan.price_zat;
    let settle_by = rules.settle_by();
    let closed = tip > rules.deadline_height;
    let by_nf: BTreeMap<&str, &ChainNote> = notes.iter().filter_map(|n| n.nf.as_deref().map(|nf| (nf, n))).collect();
    let facts: BTreeMap<&str, &TxFacts> = extra.tx_facts.iter().map(|f| (f.txid.as_str(), f)).collect();
    let settles: BTreeMap<&str, Vec<&crate::ledger::Settle>> = {
        let mut m: BTreeMap<&str, Vec<&crate::ledger::Settle>> = BTreeMap::new();
        for e in ledger.iter().filter(|e| e.kind == "settle") {
            if let Some(s) = &e.settle {
                m.entry(s.nf.as_str()).or_default().push(s);
            }
        }
        m
    };
    let mut report = AuctionReport {
        price_zat: price,
        reserve_zat: plan.reserve_zat,
        winners: plan.winners.len(),
        defaulted: plan.defaulted.clone(),
        ..Default::default()
    };
    let mut warnings = vec![];
    let (mut r9, mut r10, mut r11, mut r12) = (vec![], vec![], vec![], vec![]);
    let (mut i9, mut i11, mut i12) = (vec![], vec![], vec![]);
    let defaulted: BTreeSet<&str> = plan.defaulted.iter().map(String::as_str).collect();

    // settle entries must belong to winners
    for (nf, _list) in &settles {
        if !plan.winners.iter().any(|w| w == nf) || defaulted.contains(nf) {
            r9.push(format!("settlement entry for {nf}, who is not a settled winner"));
        }
        // More than one entry for a winner means the host rebuilt a settlement that could no longer be mined (the
        // network changed version). The latest entry counts; the chain decides whether it is true.
    }

    // (winner note value, settlement txid) for every winner whose note was spent by a settlement
    let mut settlements: Vec<(String, u64, String)> = vec![];
    for nf in plan.winners.iter().filter(|w| !defaulted.contains(w.as_str())) {
        let Some(n) = by_nf.get(nf.as_str()) else {
            r9.push(format!("winner {nf} is not a note of the campaign account"));
            continue;
        };
        let v = n.value_zat;
        let Some(sp) = &n.spent_by else {
            if tip > settle_by {
                let announced = settles.get(nf.as_str()).and_then(|l| l.last()).map(|s| format!(" (a settlement {} was announced but never reached the chain)", s.txid)).unwrap_or_default();
                r9.push(format!("winner {nf} was not settled on chain by block {settle_by}{announced}; the winner may now claim their own refund"));
            } else if closed {
                report.awaiting += 1;
            }
            continue;
        };
        let by_ticket = a.tickets.get(nf).is_some_and(|t| t.contains(&sp.txid));
        let Some(h) = sp.height else {
            report.awaiting += 1;
            continue;
        };
        if h <= rules.deadline_height {
            continue; // a withdrawal (or an early spend, which R5 reports)
        }
        if by_ticket {
            // after settle_by (inside the window it is a default, handled above)
            r9.push(format!("winner {nf} left by its own refund ticket at block {h}, after the settlement deadline {settle_by}: the host did not settle in time"));
            continue;
        }
        if h > settle_by {
            r9.push(format!("winner {nf} was settled at block {h}, after the settlement deadline {settle_by}"));
        }
        let txid = sp.txid.clone();
        settlements.push((nf.clone(), v, txid.clone()));
        report.settled += 1;
        let excess = v.saturating_sub(price + fee);
        report.excess_zat += excess;

        // the host's signed statement
        match settles.get(nf.as_str()).and_then(|l| l.last()) {
            None => r9.push(format!("no settlement entry for winner {nf} (settled by {txid})")),
            Some(s) => {
                if s.txid != txid {
                    r9.push(format!("settlement entry for {nf} names {} but the note was spent by {txid}", s.txid));
                }
                if s.price_zat != price || s.fee_zat != fee || s.excess_zat != excess {
                    r9.push(format!(
                        "settlement entry for {nf} says price {} fee {} excess {}, the rules give price {price} fee {fee} excess {excess}",
                        s.price_zat, s.fee_zat, s.excess_zat
                    ));
                }
            }
        }
        // the transaction itself
        match facts.get(txid.as_str()) {
            None => r9.push(format!("settlement transaction {txid} could not be inspected")),
            Some(f) => {
                if f.fee_zat != fee as i64 {
                    r9.push(format!("settlement {txid} pays a fee of {} zat, expected exactly {fee}", f.fee_zat));
                }
                if f.has_transparent || f.has_sapling || f.has_orchard {
                    r11.push(format!("settlement {txid} has parts outside the Ironwood pool"));
                }
                if f.ironwood_actions != 2 {
                    r11.push(format!("settlement {txid} has {} Ironwood actions; exactly 2 are allowed (the treasury payment and the winner's excess)", f.ironwood_actions));
                }
            }
        }
        // the treasury receipt
        let got: Vec<u64> = extra.treasury_notes.iter().filter(|t| t.txid == txid).map(|t| t.value_zat).collect();
        match got.as_slice() {
            [x] if *x == price => {}
            [] => r9.push(format!("settlement {txid}: the treasury received nothing, expected {price} zat")),
            [x] if *x < price => r9.push(format!("settlement {txid}: the treasury received {x} zat, short of the price {price}")),
            [x] => r9.push(format!("settlement {txid}: the treasury received {x} zat, more than the price {price}")),
            many => r9.push(format!("settlement {txid}: the treasury received {} notes ({many:?}), expected one of {price} zat", many.len())),
        }
        // nothing back to the campaign account
        // A note of 0 zat is only the shape of the transaction (the wallet pads with a zero-valued change
        // note); it carries no value and is allowed.
        for c in notes.iter().filter(|c| c.txid == txid && c.value_zat > 0) {
            r11.push(format!("settlement {txid} created a note of {} zat for the campaign account (value returned to its own address)", c.value_zat));
        }
    }
    if report.settled > 0 || !plan.defaulted.is_empty() {
        i9.push(format!("{} winner(s) settled at price {price} zat (reserve {}), fee {fee} each; the host had until block {settle_by} ({} blocks after the deadline)", report.settled, plan.reserve_zat, settle_by - rules.deadline_height));
    }
    if report.awaiting > 0 {
        i9.push(format!("{} winner(s) still waiting to be settled (the host has until block {settle_by})", report.awaiting));
    }
    for nf in &plan.defaulted {
        warnings.push(format!("winner {nf} took its refund before settlement and defaulted; the item goes unsold (no promotion)"));
    }

    // R10: the treasury received exactly the expected total from settlements
    let settle_txids: BTreeSet<&str> = settlements.iter().map(|(_, _, t)| t.as_str()).collect();
    let actual: u64 = extra.treasury_notes.iter().filter(|t| settle_txids.contains(t.txid.as_str())).map(|t| t.value_zat).sum();
    let expected = report.settled as u64 * price;
    report.treasury_total_zat = actual;
    if actual != expected {
        r10.push(format!("the treasury received {actual} zat from the settlements; {} settled winner(s) x price {price} = {expected} zat", report.settled));
    }
    let i10 = vec![format!("treasury received {actual} zat from {} settlement(s)", report.settled)];

    // R12: winners' opt-in proofs of delivery (SPEC §8.5)
    let payload_pk = hex32(&rules.payload_pubkey).ok();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for c in challenges {
        let Some(n) = notes.iter().find(|n| n.txid == c.txid && n.action == c.action) else { continue };
        let Some(nf) = n.nf.clone() else { continue };
        if !plan.winners.contains(&nf) || defaulted.contains(nf.as_str()) || !seen.insert(nf.clone()) {
            continue;
        }
        // only the contribution's owner can open its payload with this secret
        let owns = (|| {
            let esk = crypto_box::SecretKey::from(hex32(&c.eph_sk).ok()?);
            let p = Payload::open_challenged(n.memo_text.as_deref()?, &payload_pk?, &esk).ok()?;
            (hex::encode(p.rules_id) == rules_id).then_some(())
        })()
        .is_some();
        if !owns {
            continue;
        }
        let Some((_, v, txid)) = settlements.iter().find(|(w, _, _)| *w == nf) else {
            warnings.push(format!("winner {nf} published a statement, but its settlement has not been seen yet"));
            continue;
        };
        let excess = v.saturating_sub(price + fee);
        if c.uivk.is_some() {
            match extra.checks.iter().find(|k| k.txid == c.txid && k.action == c.action) {
                None => warnings.push(format!("winner {nf}'s viewing key could not be used to check settlement {txid}")),
                Some(k) if k.error.is_some() => warnings.push(format!("winner {nf}'s proof was not usable: {}", k.error.clone().unwrap_or_default())),
                Some(k) if !k.key_matches_refund => warnings.push(format!("winner {nf}'s viewing key does not belong to the refund address in the winner's own payload; it is ignored")),
                Some(_) if excess == 0 => {
                    report.proofs_ok += 1;
                    i12.push(format!("winner {nf}: nothing was owed beyond the price (the excess is 0)"));
                }
                Some(k) if k.delivered.contains(&excess) => {
                    report.proofs_ok += 1;
                    i12.push(format!("winner {nf}: excess delivered ({excess} zat in settlement {txid}), shown with the winner's own viewing key"));
                }
                Some(k) => r12.push(format!(
                    "excess not delivered to winner {nf}: settlement {txid} should pay {excess} zat to the refund address; the winner's viewing key opens outputs of {:?} zat",
                    k.delivered
                )),
            }
        } else if c.complaint {
            report.complaints += 1;
            warnings.push(format!("winner {nf} says the excess of {excess} zat from settlement {txid} did not arrive; this cannot be verified unless the winner publishes their viewing key (SPEC §8.5)"));
        }
    }
    if report.proofs_ok == 0 && r12.is_empty() && report.settled > 0 {
        i12.push("no winner has published a delivery proof: where each excess went cannot be seen from the chain".into());
    }
    let unproven = report.settled.saturating_sub(report.proofs_ok);
    if report.settled > 0 && unproven > 0 && !r12.is_empty() {
        i12.push(format!("{unproven} winner(s) unproven"));
    }

    let results = vec![
        rule("R9", "each winner paid exactly the clearing price into the treasury, with the exact fee", r9, i9),
        rule("R10", "the treasury received exactly the sum of the clearing prices", r10, i10),
        rule("R11", "settlements returned no value to the campaign account and have no other outputs", r11, i11.drain(..).collect()),
        rule("R12", "winners' proofs of delivery hold", r12, i12),
    ];
    (results, report, warnings)
}
