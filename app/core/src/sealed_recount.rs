//! The recount of a sealed bid auction (SPEC §9.7): R1 and R2 as for every campaign, then S1 to S8 from the deposits the viewing key finds,
//! the list, round R's signature, the coins and the treasury. The same outcome rules (`plan_outcome`) are used by the host when it closes.

use std::collections::{BTreeMap, BTreeSet};

use crate::{
    bid::{self, BidMemo, NoBid},
    hex32,
    ledger::{Entry, GENESIS_PREV, amount_commit, verifying_key},
    payload::{self, Payload},
    payout,
    recount::{ChainNote, Challenge, Extra, Report, RuleResult, Totals, close_entry},
    rules::{Rules, ufvk_hash},
    sealed,
};

/// SPEC §9.1, open_payouts: once the reveal publishes the payload key, the transaction of every payment the host signed to a person (a refund, a winner's
/// change, a return) and the outgoing viewing key that opens it, for whoever reads the chain (the browser module, the host's self check):
/// `(txid, ovk hex)`. Empty for an auction without `open_payouts` or before its reveal.
pub fn payout_keys(rules: &Rules, ledger: &[Entry], notes: &[ChainNote]) -> Vec<(String, String)> {
    let Some(s) = rules.sealed.as_ref() else { return vec![] };
    let Some(sk) = ledger.iter().find_map(|e| e.reveal.as_ref()?.payload_sk.as_deref()).and_then(|k| hex32(k).ok()) else { return vec![] };
    if !s.open_payouts {
        return vec![];
    }
    let refunds: BTreeMap<&str, &str> = ledger.iter().filter(|e| e.kind == "issue").filter_map(|e| Some((e.nf()?, e.refund.as_deref()?))).collect();
    let settles: BTreeMap<&str, &str> = ledger.iter().filter_map(|e| e.settle.as_ref()).map(|x| (x.nf.as_str(), x.txid.as_str())).collect();
    let returns: BTreeMap<&str, &str> = ledger.iter().filter(|e| e.kind == "late_return").filter_map(|e| Some((e.nf()?, e.refund.as_deref()?))).collect();
    let earlies: BTreeMap<&str, &str> = ledger.iter().filter(|e| e.kind == "issue").filter_map(|e| Some((e.nf()?, e.ticket.as_ref()?.txid.as_str()))).collect();
    let mut out = vec![];
    for n in notes {
        let (Some(nf), Some(sp)) = (n.nf.as_deref(), n.spent_by.as_ref()) else { continue };
        let kind = if s.early_key && earlies.get(nf) == Some(&sp.txid.as_str()) {
            payout::EARLY
        } else if refunds.get(nf) == Some(&sp.txid.as_str()) {
            payout::REFUND
        } else if settles.get(nf) == Some(&sp.txid.as_str()) {
            payout::CHANGE
        } else if returns.get(nf) == Some(&sp.txid.as_str()) {
            payout::RETURN
        } else {
            continue;
        };
        let Some(p) = n.memo_text.as_deref().and_then(|m| BidMemo::parse(m).ok()).and_then(|m| Payload::open_sealed(&m.sealed, &crypto_box::SecretKey::from(sk)).ok()) else { continue };
        let shared = payout::shared_secret(&sk, &p.enc_pubkey);
        out.push((sp.txid.clone(), hex::encode(payout::payment_ovk(&shared, nf, kind))));
    }
    out
}

/// A payment the host must send back on its own: mined in the last `LATE_MARGIN_BLOCKS` before the deadline or after it, with a sealed bid
/// memo, worth more than the network fee (SPEC 9.5). The host's return and the recount use this same test.
pub fn is_late_deposit(rules: &Rules, n: &ChainNote) -> bool {
    let last = rules.sealed.as_ref().map_or(sealed::last_deposit_height(rules.deadline_height), |s| s.last_deposit(rules.deadline_height));
    !n.is_change && n.height.is_some_and(|h| h > last) && n.value_zat > rules.refund_fee_zat && n.memo_text.as_deref().is_some_and(bid::is_bid_memo)
}

/// One deposit after round R: its opened bid, or why it is no bid, and whether it won.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct OpenedBid {
    pub nf: String,
    pub txid: String,
    pub action: u32,
    pub height: u32,
    pub value_zat: u64,
    pub tranche_zat: u64,
    pub bid_zat: Option<u64>,
    /// Why it is not a bid (plain words), when it is not.
    pub no_bid: Option<String>,
    pub winner: bool,
    /// What this winner pays the treasury.
    pub price_zat: Option<u64>,
    /// Taken back with its early ticket before the deadline.
    pub withdrawn: bool,
}

/// The sealed bid part of a recount report.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct SealedReport {
    pub pricing: String,
    pub items: u32,
    pub round: u64,
    pub claim_after: u32,
    pub cutoff: u32,
    /// Whether the bids were opened (round R's signature was on the list and checked).
    pub opened: bool,
    /// The auction was void: round R came too early (SPEC §9.7); every deposit goes back.
    pub void: bool,
    pub deposits: Vec<OpenedBid>,
    /// Winning deposits (nullifiers), best first.
    pub winners: Vec<String>,
    /// The one price every winner pays (uniform and second price).
    pub price_zat: Option<u64>,
    /// Why the recount cannot conclude (the review, L2: the block times around the deadline were not available, so whether the auction is
    /// void cannot be checked). Never a pass and never a failure of the host.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cannot_conclude: Option<String>,
}

/// The winners and what each pays, from the valid bids in chain order (`(nf, bid)`). Ties go to the earlier deposit. With fewer valid bids
/// than needed to set a price, the price is the reserve if there is one, else the lowest winning bid (the item is never given away free).
pub fn plan_outcome(pricing: &str, items: u32, reserve: Option<u64>, bids: &[(String, u64)]) -> Vec<(String, u64)> {
    let mut order: Vec<usize> = (0..bids.len()).collect();
    order.sort_by(|&a, &b| bids[b].1.cmp(&bids[a].1).then(a.cmp(&b)));
    let k = items as usize;
    let winners: Vec<usize> = order.iter().take(k).copied().collect();
    let Some(&lowest) = winners.last() else { return vec![] };
    let fallback = reserve.unwrap_or(bids[lowest].1);
    let common = match pricing {
        "uniform" if winners.len() == k => Some(bids[lowest].1),
        "uniform" => Some(fallback),
        "second" => Some(order.get(k).map_or(fallback, |&i| bids[i].1)),
        _ => None,
    };
    winners.iter().map(|&i| (bids[i].0.clone(), common.unwrap_or(bids[i].1))).collect()
}

/// The median time past at the block after `h`: the median of the times of blocks h-10 to h, if all 11 are known.
pub fn median_time_after(times: &[(u32, u64)], h: u32) -> Option<u64> {
    let map: BTreeMap<u32, u64> = times.iter().copied().collect();
    let mut v: Vec<u64> = (h.checked_sub(10)?..=h).map(|x| map.get(&x).copied()).collect::<Option<_>>()?;
    v.sort_unstable();
    Some(v[5])
}

/// The script of a payment to the transparent address of a compressed public key (P2PKH), hex.
pub fn p2pkh_script_hex(page_key: &[u8; bid::PAGE_KEY_LEN]) -> String {
    use ripemd::Digest as _;
    let sha = <sha2::Sha256 as sha2::Digest>::digest(page_key);
    let h160 = ripemd::Ripemd160::digest(sha);
    format!("76a914{}88ac", hex::encode(h160))
}

fn rule(id: &'static str, title: &'static str, fails: Vec<String>, info: Vec<String>) -> RuleResult {
    let pass = fails.is_empty();
    RuleResult { id, title, pass, details: if pass { info } else { fails }, waiting: false }
}
fn wait(id: &'static str, title: &'static str, why: &str) -> RuleResult {
    RuleResult { id, title, pass: true, details: vec![why.into()], waiting: true }
}

const S_TITLES: [(&str, &str); 8] = [
    ("S1", "every list entry is a real deposit"),
    ("S2", "every deposit got its tickets within K blocks (host reported block)"),
    ("S3", "every deposit got its coin in time, from outside the campaign's funds"),
    ("S4", "no deposit left before the deadline except by its early ticket"),
    ("S5", "the bids open with round R, and the outcome is what they give"),
    ("S6", "every winner was settled before the late tickets became valid"),
    ("S7", "every other deposit went back to the person who paid it"),
    ("S8", "the viewing key was published only after every settlement was mined"),
];

struct Deposit<'a> {
    note: &'a ChainNote,
    memo: BidMemo,
    tranche: u64,
    nf: String,
}

#[allow(clippy::too_many_arguments)]
pub fn recount_sealed(rules: &Rules, published_rules_id: &str, ledger: &[Entry], notes: &[ChainNote], challenges: &[Challenge], tip: u32, chain_visible: bool, extra: &Extra) -> Report {
    let rid = published_rules_id.to_lowercase();
    let s = rules.sealed.as_ref().expect("checked by is_sealed");
    let fee = rules.refund_fee_zat;
    let end = rules.deadline_height;
    let cutoff = s.cutoff_height(end);
    let close = close_entry(ledger);
    let reveal = ledger.iter().find(|e| e.kind == "reveal").and_then(|e| e.reveal.as_ref());
    let mut results = vec![];
    let mut did_not_finish = false;
    let mut warnings = vec![];

    // R1: the rules, and the revealed viewing key, are the committed ones.
    let mut r1 = vec![];
    match rules.id() {
        Ok(id) if hex::encode(id) == rid => {}
        Ok(id) => r1.push(format!("rules hash {} != published {rid}", hex::encode(id))),
        Err(e) => r1.push(format!("cannot hash rules: {e}")),
    }
    if let Err(e) = rules.validate() {
        r1.push(e.to_string());
    }
    if let Some(r) = reveal {
        if Some(ufvk_hash(&r.ufvk)) != rules.ufvk_hash {
            r1.push("revealed viewing key does not match the committed hash".into());
        }
    }
    results.push(rule("R1", "rules (and revealed key) match what was committed", r1, vec![]));

    // R2: signed, chained, no gaps; one close, after the deadline; one reveal, after the close.
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
    let closes = ledger.iter().filter(|e| e.kind == "close").count();
    if closes > 1 {
        r2.push("more than one close entry".into());
    }
    if let Some(c) = close {
        if c.close_height <= end {
            r2.push(format!("closed at block {} before the deadline, block {end}", c.close_height));
        }
    }
    let close_pos = ledger.iter().position(|e| e.kind == "close");
    let reveal_pos: Vec<usize> = ledger.iter().enumerate().filter(|(_, e)| e.kind == "reveal").map(|(i, _)| i).collect();
    if reveal_pos.len() > 1 || reveal_pos.first().is_some_and(|&r| close_pos.is_none_or(|c| r < c)) {
        r2.push("the viewing key must be revealed once, after the close".into());
    }
    results.push(rule("R2", "ledger is signed, chained, with no gaps, closed at most once after the deadline", r2, vec![]));

    let phase = if tip > end { "closed" } else { "open" };
    // a host that has not closed when the late tickets become valid, or not published the viewing key K blocks after that, did not finish
    if tip > s.claim_after && close.is_none() {
        did_not_finish = true;
        warnings.push(format!("the host did not close before the late tickets became valid (after block {}): everyone can take their deposit back with their late ticket", s.claim_after));
    }
    if tip > s.claim_after + rules.ticket_k && close.is_some() && reveal.is_none() {
        did_not_finish = true;
        warnings.push("the host closed but did not publish the viewing key, so the settlements and refunds cannot be checked".into());
    }
    if !chain_visible {
        for (id, title) in S_TITLES {
            results.push(wait(id, title, "waiting for the viewing key to be revealed (after every winner is settled)"));
        }
        let sealed = SealedReport { pricing: s.pricing.clone(), items: rules.items.unwrap_or(0), round: s.drand_round, claim_after: s.claim_after, cutoff, ..Default::default() };
        return Report { tip, phase, results, totals: Totals::default(), winners: None, goal_met: None, warnings, auction: None, did_not_finish, sealed: Some(sealed) };
    }

    // ---------- the deposits: payments in the bidding window with a bid memo, at least the smallest tranche, not a replay ----------
    let rejected: BTreeSet<&str> = ledger.iter().filter(|e| e.kind == "reject").filter_map(Entry::nf).collect();
    let mut order: Vec<&ChainNote> = notes
        .iter()
        .filter(|n| !n.is_change && n.height.is_some_and(|h| h >= rules.start_height && h <= s.last_deposit(end)))
        .collect();
    order.sort_by(|x, y| x.height.cmp(&y.height).then(x.tx_index.cmp(&y.tx_index)).then(x.txid.cmp(&y.txid)).then(x.action.cmp(&y.action)));
    let mut seen_memo: BTreeSet<&str> = BTreeSet::new();
    let mut deposits: Vec<Deposit> = vec![];
    // payments that repeat an accepted deposit's memo, and rejected payments whose memo was not used before them
    let mut replays: Vec<(&ChainNote, u64)> = vec![];
    let mut rejected_first: Vec<(&ChainNote, BidMemo, u64)> = vec![];
    // with open payouts, every rejected or repeated payment goes back (the review, H3 and M5); checked in S7
    let mut refused: Vec<(&ChainNote, BidMemo)> = vec![];
    let mut totals = Totals::default();
    for n in order {
        let nf = n.nf.clone().unwrap_or_default();
        let memo_text = n.memo_text.as_deref().unwrap_or_default();
        let parsed = BidMemo::parse(memo_text).ok();
        let tranche = s.tranche_of(n.value_zat);
        if let Some(m) = &parsed {
            if rejected.contains(nf.as_str()) || seen_memo.contains(memo_text) {
                refused.push((n, m.clone()));
            }
        }
        let (Some(memo), Some(tranche)) = (parsed, tranche) else {
            totals.donations += 1;
            totals.donations_zat += n.value_zat;
            continue;
        };
        let is_rejected = rejected.contains(nf.as_str());
        if seen_memo.contains(memo_text) || is_rejected {
            if is_rejected && !seen_memo.contains(memo_text) {
                rejected_first.push((n, memo.clone(), tranche));
            }
            if seen_memo.contains(memo_text) {
                replays.push((n, tranche));
                warnings.push(format!("{}:{} ({}) repeated the memo of an earlier deposit and is not a deposit", n.txid, n.action, rules.amount(n.value_zat)));
            }
            totals.donations += 1;
            totals.donations_zat += n.value_zat;
            continue;
        }
        seen_memo.insert(memo_text);
        deposits.push(Deposit { note: n, memo, tranche, nf });
    }
    let by_nf: BTreeMap<&str, &Deposit> = deposits.iter().map(|d| (d.nf.as_str(), d)).collect();
    let issue: BTreeMap<&str, &Entry> = ledger.iter().filter(|e| e.kind == "issue").filter_map(|e| e.nf().map(|nf| (nf, e))).collect();
    let coins: BTreeMap<&str, &crate::ledger::Coin> = ledger.iter().filter_map(|e| e.coin.as_ref()).map(|c| (c.nf.as_str(), c)).collect();
    // each deposit's late ticket, named with its coin (the late ticket spends the coin, so it is built once the coin is sent)
    let lates: BTreeMap<&str, &str> = ledger.iter().filter_map(|e| Some((e.coin.as_ref()?.nf.as_str(), e.late.as_deref()?))).collect();
    let campaign_spends: BTreeSet<&str> = notes.iter().filter_map(|n| n.spent_by.as_ref().map(|s| s.txid.as_str())).collect();
    // SPEC §9.1, open_payouts: with open payouts, each payment the host signed to a person must pay the refund address in that person's memo (opened with
    // the payload key the reveal publishes) the right amount; `extra.payouts` holds each payment's outputs as the chain shows them
    let revealed_sk = reveal.and_then(|r| r.payload_sk.as_deref()).and_then(|k| hex32(k).ok());
    let refund_receiver = |memo: &BidMemo| -> Option<[u8; 43]> { Payload::open_sealed(&memo.sealed, &crypto_box::SecretKey::from(revealed_sk?)).ok().map(|p| p.refund_receiver) };
    let pays = |txid: &str, memo: &BidMemo, value: u64, what: &str| -> Option<String> {
        if !s.open_payouts {
            return None;
        }
        let Some(recv) = refund_receiver(memo) else { return Some(format!("{what} {txid}: the memo does not open with the published payload key")) };
        let Some(f) = extra.payouts.iter().find(|f| f.txid == txid) else {
            return Some(format!("{what} {txid}: the transaction was not read from the chain, so who it pays was not checked"));
        };
        if let Some(e) = &f.error {
            return Some(format!("{what} {txid}: {e}"));
        }
        let want = hex::encode(recv);
        if f.outputs.iter().any(|o| o.receiver_hex == want && o.value_zat == value) {
            return None;
        }
        let paid: Vec<String> = f.outputs.iter().map(|o| format!("{} to {}", rules.amount(o.value_zat), &o.receiver_hex[..o.receiver_hex.len().min(16)])).collect();
        Some(format!("{what} {txid} does not pay {} to the refund address in the memo (it pays {})", rules.amount(value), if paid.is_empty() { "nothing its key opens".to_string() } else { paid.join(", ") }))
    };
    // the payload of a memo, opened with the published payload key, when it is for this auction: the host could read its refund address
    let opens_here = |memo: &BidMemo| -> bool {
        revealed_sk.and_then(|sk| Payload::open_sealed(&memo.sealed, &crypto_box::SecretKey::from(sk)).ok()).is_some_and(|p| hex::encode(p.rules_id) == rid)
    };
    totals.contributions = deposits.len();
    totals.raised_zat = deposits.iter().map(|d| d.note.value_zat).sum();

    // S1: every issue entry names a real deposit; amounts stay hidden until the close, then open with the amount key.
    let (mut s1, mut s1_info) = (vec![], vec![format!("{} deposit(s)", deposits.len())]);
    let amount_key = close.and_then(|c| c.amount_key.as_deref()).and_then(|k| hex32(k).ok());
    for e in ledger.iter().filter(|e| e.kind == "issue") {
        let Some(c) = &e.contribution else { continue };
        match by_nf.get(c.nf.as_str()) {
            // L6: a reorganised chain moved the payment into the last blocks before the deadline; it is sent back as a late payment (S7)
            None if notes.iter().any(|n| n.nf.as_deref() == Some(c.nf.as_str()) && is_late_deposit(rules, n)) => {
                s1_info.push(format!("entry {}: the deposit is now in a block too late to bid (the chain was reorganised); it must be sent back", e.seq))
            }
            None => s1.push(format!("entry {}: names no deposit to the campaign", e.seq)),
            Some(d) => {
                if c.txid != d.note.txid || c.action != d.note.action || Some(c.height) != d.note.height {
                    s1.push(format!("entry {}: payment details differ from the chain", e.seq));
                }
                if c.value_zat.is_some() {
                    s1.push(format!("entry {}: shows the deposit's amount before the close", e.seq));
                }
                if let (Some(k), Some(commit)) = (&amount_key, &c.amount_commit) {
                    if amount_commit(k, &c.nf, d.note.value_zat).ok().as_deref() != Some(commit.as_str()) {
                        s1.push(format!("entry {}: amount commitment does not match the deposit", e.seq));
                    }
                }
            }
        }
    }
    for e in ledger.iter().filter(|e| e.kind == "reject") {
        let Some(n) = e.nf().and_then(|nf| notes.iter().find(|n| n.nf.as_deref() == Some(nf))) else {
            s1.push(format!("entry {}: a reject for a payment that is not to the campaign", e.seq));
            continue;
        };
        // with open payouts a reject carries the hash of the payment's memo, so the page that made the payment finds it and can challenge it
        if s.open_payouts && e.blob_hash.as_deref() != Some(crate::ledger::blob_hash(n.memo_text.as_deref().unwrap_or_default().as_bytes()).as_str()) {
            s1.push(format!("entry {}: the reject does not carry the hash of the payment's memo, so the person's page cannot find it", e.seq));
        }
    }
    // a reject is false when the person who bid publishes the memo's one-time secret and the payment meets the one validity rule (`payload::check`)
    for (n, memo, _) in &rejected_first {
        let proven = challenges.iter().filter(|c| c.txid == n.txid && c.action == n.action).find_map(|c| {
            let esk = crypto_box::SecretKey::from(hex32(&c.eph_sk).ok()?);
            let p = Payload::open_sealed_challenged(&memo.sealed, &hex32(&rules.payload_pubkey).ok()?, &esk).ok()?;
            payload::check(&p, &rid, n.value_zat, fee).ok().map(|_| p)
        });
        if proven.is_some() {
            s1.push(format!("{}:{} ({}) was rejected, but the person who paid it showed that its memo is valid", n.txid, n.action, rules.amount(n.value_zat)));
        }
    }
    results.push(rule("S1", S_TITLES[0].1, s1, s1_info));

    // S2: tickets within K blocks of the deposit (the block the host reports).
    let (mut s2, mut s2_info) = (vec![], vec![]);
    for d in &deposits {
        let h = d.note.height.unwrap_or(0);
        let due = h + rules.ticket_k;
        match issue.get(d.nf.as_str()).and_then(|e| e.ticket.as_ref()) {
            Some(t) if t.issue_height <= due => {}
            Some(t) => s2.push(format!("{}:{} ticketed in block {} (the block the host reports), due by block {due}", d.note.txid, d.note.action, t.issue_height)),
            None if tip <= due => s2_info.push(format!("{}:{} waiting for its tickets (due by block {due})", d.note.txid, d.note.action)),
            None => s2.push(format!("{}:{} (block {h}) has no tickets, due by block {due}", d.note.txid, d.note.action)),
        }
    }
    // H1: the list in the order of the payments on the chain. An entry for a payment that comes after entries for payments mined more than
    // the ticket window later was added late (after the bids could be read): the relays refuse such entries near round R, and this shows any
    // that got in. A small reordering (a ticket the host had to try again) stays within the ticket window.
    let height_of: BTreeMap<&str, u32> = notes.iter().filter_map(|n| Some((n.nf.as_deref()?, n.height?))).collect();
    let mut latest: Option<(u64, u32)> = None;
    for e in ledger.iter().filter(|e| e.kind == "issue" || e.kind == "reject") {
        let Some(h) = e.nf().and_then(|nf| height_of.get(nf).copied()) else { continue };
        match latest {
            Some((seq, lh)) if h + rules.ticket_k < lh => s2.push(format!("entry {} lists a payment from block {h} after entry {seq} listed one from block {lh}: it was added to the list late", e.seq)),
            Some((_, lh)) if lh >= h => {}
            _ => latest = Some((e.seq, h)),
        }
    }
    results.push(rule("S2", S_TITLES[1].1, s2, s2_info));

    // S4 first (S3 needs to know who left early): a spend at or before the deadline must be the deposit's early ticket.
    let mut s4 = vec![];
    let mut withdrawn: BTreeSet<&str> = BTreeSet::new();
    for d in &deposits {
        let Some(sp) = &d.note.spent_by else { continue };
        if !sp.height.is_some_and(|h| h <= end) {
            continue;
        }
        let early = issue.get(d.nf.as_str()).and_then(|e| e.ticket.as_ref()).map(|t| t.txid.as_str());
        if early == Some(sp.txid.as_str()) {
            withdrawn.insert(d.nf.as_str());
            // the second review, C1: the early ticket pays the refund address in the memo, the deposit minus the fee
            if s.early_key {
                if let Some(p) = pays(&sp.txid, &d.memo, d.note.value_zat.saturating_sub(fee), &format!("deposit {}: the early ticket", d.nf)) {
                    s4.push(p);
                }
            }
        } else {
            s4.push(format!("deposit {} spent by {} in block {}, not by its early ticket", d.nf, sp.txid, sp.height.unwrap_or(0)));
        }
    }

    // S3: the coin, to the address of the page key in the memo, mined by the cutoff, paid from outside the campaign's funds.
    let (mut s3, mut s3_info) = (vec![], vec![]);
    // a deposit mined after the cutoff cannot get its coin in time: it owes no coin, and its bid does not count (S5)
    for d in deposits.iter().filter(|d| issue.contains_key(d.nf.as_str()) && d.note.height.is_some_and(|h| h <= cutoff)) {
        let left_early = withdrawn.contains(d.nf.as_str()) && d.note.spent_by.as_ref().and_then(|s| s.height).is_some_and(|h| h <= cutoff);
        match coins.get(d.nf.as_str()) {
            None if left_early => {}
            None if tip <= cutoff => s3_info.push(format!("deposit {} waiting for its coin (cutoff block {cutoff})", d.nf)),
            None => s3.push(format!("deposit {} never got its coin (cutoff block {cutoff})", d.nf)),
            Some(c) => match extra.coins.iter().find(|f| f.txid == c.txid && f.index == c.index) {
                None => s3.push(format!("deposit {}: the chain does not show the coin {}:{}", d.nf, c.txid, c.index)),
                Some(f) => {
                    if f.value_zat < s.coin_zat || c.value_zat != f.value_zat {
                        s3.push(format!("deposit {}: the coin is {}, the rules need at least {}", d.nf, rules.amount(f.value_zat), rules.amount(s.coin_zat)));
                    }
                    if f.script_hex != p2pkh_script_hex(&d.memo.page_key) {
                        s3.push(format!("deposit {}: the coin was not paid to the address of the bid's page", d.nf));
                    }
                    match f.height {
                        Some(h) if h <= cutoff => {}
                        Some(h) => s3.push(format!("deposit {}: the coin was mined in block {h}, after the cutoff, block {cutoff}", d.nf)),
                        None => s3.push(format!("deposit {}: the coin is not mined", d.nf)),
                    }
                    if campaign_spends.contains(c.txid.as_str()) {
                        s3.push(format!("deposit {}: the coin was paid from the campaign's funds (transaction {})", d.nf, c.txid));
                    }
                }
            },
        }
    }
    results.push(rule("S3", S_TITLES[2].1, s3, s3_info));
    results.push(rule("S4", S_TITLES[3].1, s4, vec![format!("{} deposit(s) taken back before the deadline", withdrawn.len())]));
    totals.withdrawn_zat = deposits.iter().filter(|d| withdrawn.contains(d.nf.as_str())).map(|d| d.note.value_zat).sum();

    // S5: the void rule, the bids, the outcome.
    let live: Vec<&Deposit> = deposits.iter().filter(|d| !withdrawn.contains(d.nf.as_str())).collect();
    let mut report = SealedReport { pricing: s.pricing.clone(), items: rules.items.unwrap_or(0), round: s.drand_round, claim_after: s.claim_after, cutoff, ..Default::default() };
    report.deposits = deposits
        .iter()
        .map(|d| OpenedBid { nf: d.nf.clone(), txid: d.note.txid.clone(), action: d.note.action, height: d.note.height.unwrap_or(0), value_zat: d.note.value_zat, tranche_zat: d.tranche, withdrawn: withdrawn.contains(d.nf.as_str()), ..Default::default() })
        .collect();
    let mut winners_plan: Vec<(String, u64)> = vec![];
    let mut s5 = vec![];
    let mut s5_info = vec![];
    let mut s5_wait = None;
    match close {
        _ if tip <= end => s5_wait = Some("bidding is open"),
        None if tip <= s.claim_after => s5_wait = Some("waiting for the host to open the bids and close"),
        None => s5.push(format!("the host did not close before block {}", s.claim_after)),
        Some(c) => {
            let mtp = median_time_after(&extra.block_times, end);
            let void_expected = mtp.map(|t| sealed::round_time(s.drand_round) < t + sealed::gap_secs(s.timing));
            match (void_expected, c.outcome.as_str()) {
                // L2: without the block times nobody can tell whether round R came too early: "cannot conclude", never "void"
                (None, _) => report.cannot_conclude = Some("the block times around the deadline are not available, so whether the auction is void cannot be checked".into()),
                (Some(true), "void") => {
                    report.void = true;
                    s5_info.push("void: round R came too early for this deadline, so every deposit goes back".into());
                }
                (Some(true), o) => s5.push(format!("round R came too early (the median block time at the deadline was {}), so the auction is void, but the host declared {o:?}", mtp.unwrap_or(0))),
                (Some(false), "void") => s5.push("the host declared the auction void, but round R came after bidding closed".into()),
                (_, "sealed_auction") => {}
                (_, o) => s5.push(format!("unknown outcome {o:?}")),
            }
            if !report.void && c.outcome != "void" {
                let sig = c.drand_signature.as_deref().and_then(|h| hex::decode(h).ok()).unwrap_or_default();
                if !bid::round_signature_ok(s.drand_round, &sig) {
                    s5.push(format!("the close does not carry drand quicknet's signature for round {}", s.drand_round));
                } else {
                    report.opened = true;
                    let rid_bytes = hex32(&rid).unwrap_or([0; 32]);
                    let mut valid: Vec<(String, u64)> = vec![];
                    for d in &live {
                        let entry = report.deposits.iter_mut().find(|o| o.nf == d.nf).expect("every deposit is listed");
                        let opened = bid::open_memo(&d.memo, s.drand_round, &sig);
                        let after_cutoff = d.note.height.is_some_and(|h| h > cutoff);
                        let ticketed = issue.contains_key(d.nf.as_str());
                        let why = match opened {
                            // the host never gave this deposit its tickets: it does not bid, and goes back on its own (the safety net)
                            _ if !ticketed => Some("no tickets from the host: it does not bid and is sent back, minus the fee".to_string()),
                            _ if after_cutoff => Some("paid after the coin cutoff, too late to bid (refunded)".to_string()),
                            Err(NoBid::WrongRound) => Some("the signature is not round R's".to_string()),
                            Err(NoBid::DoesNotOpen) => Some("the lock does not open with round R".into()),
                            Err(NoBid::NoMarker) => Some("the lock opened to something that is not a bid".into()),
                            // M4: an auction with the long tag takes only the bound kind of memo, and an older auction only the older kind
                            Ok(_) if s.long_tag != d.memo.bound.is_some() => Some("the memo is not of the kind this auction takes".into()),
                            Ok(o) => {
                                let b = o.bid_zat;
                                entry.bid_zat = Some(b);
                                let binds = |tranche: u64| o.binds(&d.memo, &rid_bytes, tranche);
                                if !binds(d.tranche) {
                                    // the memo was written for another tranche: if a later payment with the same memo pays it, that payment is
                                    // the person's real deposit, and the host accepted a copy and set the real one aside (16, H3)
                                    let memo_text = d.note.memo_text.as_deref();
                                    if let Some((real, _)) = replays.iter().find(|(r, rt)| r.memo_text.as_deref() == memo_text && binds(*rt)) {
                                        s5.push(format!("{}:{} copies the memo of {}:{}, which pays the tranche the bid was made for: the host accepted the copy and kept the real deposit", d.note.txid, d.note.action, real.txid, real.action));
                                    }
                                    Some("the bid belongs to another memo or tranche (its tag does not match)".into())
                                } else if b > d.tranche.saturating_sub(fee) {
                                    Some(format!("the bid is more than its tranche ({}) minus the fee", rules.amount(d.tranche)))
                                } else if rules.reserve_zat.is_some_and(|r| b < r) {
                                    Some("the bid is below the reserve".into())
                                } else {
                                    valid.push((d.nf.clone(), b));
                                    None
                                }
                            }
                        };
                        entry.no_bid = why;
                    }
                    winners_plan = plan_outcome(&s.pricing, rules.items.unwrap_or(0), rules.reserve_zat, &valid);
                    let declared = c.winners.clone().unwrap_or_default();
                    let expected: Vec<String> = winners_plan.iter().map(|w| w.0.clone()).collect();
                    if declared != expected {
                        s5.push(format!("declared winners {declared:?} differ from the opened bids' {expected:?}"));
                    }
                    let common = (s.pricing != "pay_your_bid").then(|| winners_plan.first().map(|w| w.1)).flatten();
                    if s.pricing != "pay_your_bid" && c.clearing_price_zat != common {
                        s5.push(format!("declared price {} differs from the opened bids' {}", c.clearing_price_zat.map_or("none".into(), |p| rules.amount(p)), common.map_or("none".into(), |p| rules.amount(p))));
                    }
                    report.price_zat = common;
                    s5_info.push(format!("{} deposit(s) opened, {} valid bid(s), {} winner(s)", live.len(), valid.len(), winners_plan.len()));
                }
            }
        }
    }
    for (nf, price) in &winners_plan {
        if let Some(o) = report.deposits.iter_mut().find(|o| &o.nf == nf) {
            o.winner = true;
            o.price_zat = Some(*price);
        }
    }
    report.winners = winners_plan.iter().map(|w| w.0.clone()).collect();
    match (s5_wait, &report.cannot_conclude) {
        (Some(why), _) => results.push(wait("S5", S_TITLES[4].1, why)),
        // cannot conclude: shown as waiting, and never counted as a pass
        (None, Some(why)) if s5.is_empty() => results.push(RuleResult { id: "S5", title: S_TITLES[4].1, pass: false, details: vec![format!("cannot conclude: {why}")], waiting: true }),
        (None, _) => results.push(rule("S5", S_TITLES[4].1, s5, s5_info)),
    }

    // S6: each winner settled by its settle entry, mined after the deadline and by H_s, paying exactly its price to the treasury.
    let settles: BTreeMap<&str, &crate::ledger::Settle> = ledger.iter().filter_map(|e| e.settle.as_ref()).map(|x| (x.nf.as_str(), x)).collect();
    let (mut s6, mut s6_info) = (vec![], vec![]);
    let mut settle_heights: Vec<(String, u32)> = vec![];
    for nf in settles.keys() {
        if !winners_plan.iter().any(|w| w.0 == *nf) {
            s6.push(format!("a settlement entry for {nf}, which did not win"));
        }
    }
    let mut kept = 0u64;
    for (nf, price) in &winners_plan {
        let d = by_nf[nf.as_str()];
        let late = lates.get(nf.as_str()).copied();
        match &d.note.spent_by {
            None if tip <= s.claim_after => s6_info.push(format!("winner {nf} waiting to be settled (by block {})", s.claim_after)),
            None => {
                did_not_finish = true;
                s6.push(format!("winner {nf} was not settled before block {}", s.claim_after));
            }
            Some(sp) if Some(sp.txid.as_str()) == late => {
                did_not_finish = true;
                s6.push(format!("winner {nf} took the deposit back with the late ticket: the host did not settle in time"));
            }
            Some(sp) => match settles.get(nf.as_str()) {
                None => s6.push(format!("winner {nf} was spent by {} with no settlement entry", sp.txid)),
                Some(st) => {
                    if st.txid != sp.txid {
                        s6.push(format!("winner {nf}: the settlement entry names {} but the deposit was spent by {}", st.txid, sp.txid));
                    }
                    match sp.height {
                        Some(h) if h > end && h <= s.claim_after => settle_heights.push((sp.txid.clone(), h)),
                        Some(h) => s6.push(format!("winner {nf} was settled in block {h}, outside the settlement window (blocks {} to {})", end + 1, s.claim_after)),
                        None => s6_info.push(format!("winner {nf}: settlement {} not mined yet", sp.txid)),
                    }
                    let excess = d.note.value_zat.saturating_sub(price + fee);
                    // the winner's change goes back to the refund address in the winner's memo (the independent review, H2)
                    if excess > 0 && sp.height.is_some() {
                        if let Some(p) = pays(&sp.txid, &d.memo, excess, &format!("winner {nf}: the change in")) {
                            s6.push(p);
                        }
                    }
                    if st.price_zat != *price || st.fee_zat != fee || st.excess_zat != excess {
                        s6.push(format!("winner {nf}: the entry says price {}, fee {}, back {}; the opened bids give price {}, fee {}, back {}", rules.amount(st.price_zat), rules.amount(st.fee_zat), rules.amount(st.excess_zat), rules.amount(*price), rules.amount(fee), rules.amount(excess)));
                    }
                    let got: u64 = extra.treasury_notes.iter().filter(|t| t.txid == sp.txid).map(|t| t.value_zat).sum();
                    if got != *price {
                        s6.push(format!("winner {nf}: the treasury received {} in {}, the price is {}", rules.amount(got), sp.txid, rules.amount(*price)));
                    }
                    if let Some(f) = extra.tx_facts.iter().find(|f| f.txid == sp.txid) {
                        if f.fee_zat != fee as i64 {
                            s6.push(format!("winner {nf}: the settlement pays a fee of {} zatoshis, expected {fee}", f.fee_zat));
                        }
                    }
                    kept += got;
                }
            },
        }
    }
    totals.kept_zat = kept;
    if report.opened || report.void {
        results.push(rule("S6", S_TITLES[5].1, s6, s6_info));
    } else {
        results.push(wait("S6", S_TITLES[5].1, "waiting for the bids to open"));
    }

    // S7: every live deposit that did not win went back: by its signed refund, or by its late ticket after H_s, or (one the host never
    // ticketed) by the return the list names after the close. Nothing else may spend it.
    let (mut s7, mut s7_info) = (vec![], vec![]);
    let late_returns: BTreeMap<&str, &str> = ledger.iter().filter(|e| e.kind == "late_return").filter_map(|e| Some((e.nf()?, e.refund.as_deref()?))).collect();
    let closed_at = close.map(|c| c.close_height);
    let mut refunded = 0u64;
    for d in live.iter().filter(|d| !winners_plan.iter().any(|w| w.0 == d.nf)) {
        let e = issue.get(d.nf.as_str());
        let (refund, late) = (e.and_then(|e| e.refund.as_deref()), lates.get(d.nf.as_str()).copied());
        match &d.note.spent_by {
            Some(sp) if Some(sp.txid.as_str()) == refund => {
                refunded += d.note.value_zat;
                // the refund pays the refund address in the memo, the deposit minus the fee (the independent review, C1)
                if let Some(p) = pays(&sp.txid, &d.memo, d.note.value_zat.saturating_sub(fee), &format!("deposit {}: the refund", d.nf)) {
                    s7.push(p);
                }
            }
            Some(sp) if Some(sp.txid.as_str()) == late && sp.height.is_some_and(|h| h > s.claim_after) => refunded += d.note.value_zat,
            Some(sp) if e.is_none() && late_returns.get(d.nf.as_str()) == Some(&sp.txid.as_str()) => {
                refunded += d.note.value_zat;
                s7_info.push(format!("deposit {} had no tickets from the host and was sent back by {}", d.nf, sp.txid));
                if let Some(p) = pays(&sp.txid, &d.memo, d.note.value_zat.saturating_sub(fee), &format!("deposit {}: the return", d.nf)) {
                    s7.push(p);
                }
            }
            None if e.is_none() && closed_at.is_some_and(|c| tip > c + rules.ticket_k) => {
                s7.push(format!("deposit {} had no tickets from the host and was not sent back within {} blocks of the close", d.nf, rules.ticket_k))
            }
            Some(sp) => s7.push(format!("deposit {} was spent by {}, which is not its refund or its late ticket", d.nf, sp.txid)),
            None if (report.opened || report.void) && tip > s.claim_after => {
                did_not_finish = true;
                s7_info.push(format!("deposit {} was not refunded by the host; the person who paid it can take it back with the late ticket", d.nf));
            }
            None => {}
        }
    }
    // payments mined in the last LATE_MARGIN_BLOCKS before the deadline or after it are not in the auction: each goes back to the person who
    // paid it, by the return the host names on the list (a "late_return" entry), within the ticket window of blocks; the amount stays
    // private, the return is on the chain
    for n in notes.iter().filter(|n| is_late_deposit(rules, n)) {
        let (nf, h) = (n.nf.as_deref().unwrap_or_default(), n.height.unwrap_or(0));
        let memo = n.memo_text.as_deref().and_then(|m| BidMemo::parse(m).ok());
        // L6: a deposit with tickets that a reorganised chain moved into these blocks may also go back by its early ticket or signed refund
        let own_ticket = issue.get(nf).is_some_and(|e| n.spent_by.as_ref().is_some_and(|sp| e.ticket.as_ref().is_some_and(|t| t.txid == sp.txid) || e.refund.as_deref() == Some(sp.txid.as_str())));
        if s.open_payouts && !memo.as_ref().is_some_and(|m| opens_here(m)) && late_returns.get(nf).is_none() {
            s7_info.push(format!("payment {nf} came too late to bid, and its memo gives no refund address for this auction: it stays"));
            continue;
        }
        match (&n.spent_by, late_returns.get(nf)) {
            (Some(sp), _) if own_ticket => s7_info.push(format!("payment {nf} (block {h}, a deposit the chain moved past the last block to bid) went back by its own ticket {}", sp.txid)),
            (Some(sp), Some(t)) if sp.txid == *t => {
                s7_info.push(format!("payment {nf} came too late to bid (block {h}, deadline {}) and was sent back by {t}", rules.deadline_height));
                match memo {
                    Some(memo) => {
                        if let Some(p) = pays(t, &memo, n.value_zat.saturating_sub(fee), &format!("payment {nf}: the return")) {
                            s7.push(p);
                        }
                    }
                    None if s.open_payouts => s7.push(format!("payment {nf}: its memo could not be read, so who the return {t} pays was not checked")),
                    None => {}
                }
            }
            (Some(sp), _) => s7.push(format!("payment {nf} came too late to bid (block {h}, deadline {}) and was spent by {}, which is not its return on the list", rules.deadline_height, sp.txid)),
            (None, _) if tip > h + rules.ticket_k => s7.push(format!("payment {nf} came too late to bid (block {h}, deadline {}) and was not sent back within {} blocks", rules.deadline_height, rules.ticket_k)),
            (None, _) => s7_info.push(format!("payment {nf} came too late to bid (block {h}, deadline {}) and is waiting to be sent back", rules.deadline_height)),
        }
    }
    // H3 and M5: with open payouts, a payment the host rejected, or a second payment with a deposit's memo, goes back to the refund address
    // in its memo, minus the fee, by the return the list names, within the ticket window of blocks
    for (n, memo) in refused.iter().filter(|(n, m)| s.open_payouts && n.value_zat > fee && opens_here(m)) {
        let (nf, h) = (n.nf.as_deref().unwrap_or_default(), n.height.unwrap_or(0));
        match (&n.spent_by, late_returns.get(nf)) {
            (Some(sp), Some(t)) if sp.txid == *t => {
                s7_info.push(format!("payment {nf} was rejected or repeated a deposit's memo, and was sent back by {t}"));
                if let Some(p) = pays(t, memo, n.value_zat - fee, &format!("payment {nf}: the return")) {
                    s7.push(p);
                }
            }
            (Some(sp), _) => s7.push(format!("payment {nf} was rejected or repeated a deposit's memo, and was spent by {}, which is not its return on the list", sp.txid)),
            (None, _) if tip > h + rules.ticket_k => s7.push(format!("payment {nf} (block {h}) was rejected or repeated a deposit's memo, and was not sent back within {} blocks", rules.ticket_k)),
            (None, _) => s7_info.push(format!("payment {nf} was rejected or repeated a deposit's memo, and is waiting to be sent back")),
        }
    }
    totals.refunded_zat = refunded;
    if report.opened || report.void || !s7.is_empty() {
        results.push(rule("S7", S_TITLES[6].1, s7, s7_info));
    } else {
        results.push(wait("S7", S_TITLES[6].1, "waiting for the bids to open"));
    }

    // S8: the viewing key was published after every settlement was mined.
    let mut s8 = vec![];
    match reveal {
        Some(r) => {
            for (txid, h) in &settle_heights {
                if *h > r.height {
                    s8.push(format!("the viewing key was published at block {} but settlement {txid} was mined later, in block {h}", r.height));
                }
            }
            // SPEC §9.1, open_payouts: an auction whose rules promise open payouts publishes its payload key with the viewing key
            if s.open_payouts {
                match r.payload_sk.as_deref().map(|k| hex32(k).map(|b| crypto_box::SecretKey::from(b).public_key())) {
                    None => s8.push("the reveal does not publish the payload key, so who the host's payments pay cannot be checked".into()),
                    Some(Ok(pk)) if hex32(&rules.payload_pubkey).is_ok_and(|want| *pk.as_bytes() == want) => {}
                    Some(_) => s8.push("the payload key the reveal publishes is not the one in the rules".into()),
                }
            }
        }
        None if tip > s.claim_after + rules.ticket_k => s8.push("the viewing key was not published by a reveal entry".into()),
        None => {}
    }
    if reveal.is_none() && s8.is_empty() {
        results.push(wait("S8", S_TITLES[7].1, "waiting for the viewing key (after every winner is settled)"));
    } else {
        results.push(rule("S8", S_TITLES[7].1, s8, vec![]));
    }

    Report { tip, phase, results, totals, winners: Some(report.winners.clone()), goal_met: None, warnings, auction: None, did_not_finish, sealed: Some(report) }
}

#[cfg(test)]
mod tests;
