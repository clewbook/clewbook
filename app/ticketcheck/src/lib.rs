//! Checks a refund ticket the way the contributor's page does (SPEC §3.1), and says plainly which checks ran.
//!
//! Level 1 (this file): the ticket's signatures against its own transaction id (for a transaction without transparent
//! inputs the signature hash equals the transaction id, ZIP 244), the network version it was built for against the one the
//! network reports, no expiry, the fee, that it spends the contribution's coin, its shape (two Ironwood actions and nothing
//! else), and whether the coin is still unspent. Not checked here: that it pays the contributor (needs the opening values,
//! level 2), the zero-knowledge proof (level 3) and the anchor (level 4).

pub mod late;

use serde::{Deserialize, Serialize};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pass,
    Fail,
    NotChecked,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Check {
    pub id: String,
    pub status: Status,
    /// What this check is about, as a short phrase for the page's "Checked: … Not checked: …" line. It states only
    /// what was actually established when the status is `pass`.
    pub label: String,
    /// One plain sentence: what was found (or why it was not checked).
    pub detail: String,
}

/// A spend of the contribution's coin seen on chain.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Spent {
    pub txid: String,
    pub height: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Inputs {
    /// The ticket's raw transaction, hex.
    pub raw_hex: String,
    /// From the signed ledger entry.
    pub expected_txid: String,
    pub ticket_branch: String,
    /// Nullifier of the contribution's coin (transaction byte order, hex).
    pub contribution_nf: String,
    pub fee_zat: u64,
    /// The network version the server reports now (hex), if it could be asked.
    #[serde(default)]
    pub current_branch: Option<String>,
    /// Coin status: the highest block searched, and the spend found (if any).
    #[serde(default)]
    pub scanned_to: Option<u32>,
    #[serde(default)]
    pub spent: Option<Spent>,
    /// What the signed list shows as this contribution's amount (a fundraiser; absent for sealed-bid auctions).
    #[serde(default)]
    pub listed_contribution_zat: Option<u64>,
    /// What the contributor meant to pay (the amount typed on this page).
    #[serde(default)]
    pub intended_contribution_zat: Option<u64>,
    /// What this page saw the contributor's own payment pay on the network, when it has found it.
    #[serde(default)]
    pub paid_zat: Option<u64>,
    /// Level 2: the opening values sealed with the ticket (absent for tickets issued before format version 2).
    #[serde(default)]
    pub opening: Option<ll_core::ticket_blob::Opening>,
    /// Level 2: the 43-byte Orchard receiver (hex) of the refund address the contributor gave, if the page has it.
    #[serde(default)]
    pub refund_receiver_hex: Option<String>,
    /// Level 2: what the refund should be (contribution minus fee), when the contribution amount is public.
    #[serde(default)]
    pub expected_value_zat: Option<u64>,
    /// Transactions the signed ledger names for this coin (its tickets, a settlement): a spend by one of them is expected.
    #[serde(default)]
    pub known_txids: Vec<String>,
    /// Sealed bid auction, the early ticket (the independent review, H4): it must expire exactly at this block (the deadline), not never.
    #[serde(default)]
    pub expected_expiry: Option<u32>,
}

fn label_of(id: &str) -> &'static str {
    match id {
        "readable" => "it can be read",
        "matches_list" => "it matches the campaign's signed list",
        "shape" => "it has the expected shape (two Ironwood actions, nothing else)",
        "signatures" => "its signatures are valid",
        "network_version" => "it is for the network version in use now",
        "no_expiry" => "it never expires",
        "fee" => "the fee is what the rules say",
        "spends_your_coin" => "it spends your contribution",
        "your_amount" => "the list shows the amount you meant to pay",
        "coin_unspent" => "your contribution's coin is not used by anything else",
        "coin_used_by_list" => "your coin was used only by a transaction the campaign's list names",
        "pays_you" => "it pays you (its refund output pays the address you gave)",
        "proof" => "the proof",
        "anchor" => "its chain state (anchor)",
        _ => "this check",
    }
}

fn c(id: &str, status: Status, detail: impl Into<String>) -> Check {
    // an unchecked "pays you" must read "that it pays you", not claim a result
    let label = if id == "pays_you" && status == Status::NotChecked { "that it pays you" } else { label_of(id) };
    Check { id: id.into(), status, label: label.into(), detail: detail.into() }
}

pub fn branch_from_hex(h: &str) -> Option<BranchId> {
    u32::from_str_radix(h, 16).ok().and_then(|b| BranchId::try_from(b).ok())
}

/// Every check, in a fixed order, each `pass`, `fail` or `not_checked`.
pub fn check(i: &Inputs) -> Vec<Check> {
    use Status::*;
    let mut out = vec![];
    let Some(branch) = branch_from_hex(&i.ticket_branch) else {
        return vec![c("readable", Fail, "the ticket names a network version this page does not know")];
    };
    let tx = match hex::decode(&i.raw_hex).ok().and_then(|raw| Transaction::read(&raw[..], branch).ok()) {
        Some(t) => t,
        None => return vec![c("readable", Fail, "the ticket could not be read as a transaction")],
    };
    let txid = tx.txid().to_string();
    out.push(if txid == i.expected_txid {
        c("matches_list", Pass, "its transaction id is the one in the campaign's signed list")
    } else {
        c("matches_list", Fail, format!("its transaction id {txid} is not the one in the signed list ({})", i.expected_txid))
    });

    // shape: Ironwood only, two actions
    let bundle = tx.ironwood_bundle();
    let other_parts = tx.transparent_bundle().is_some() || tx.sapling_bundle().is_some() || tx.orchard_bundle().is_some();
    match bundle {
        Some(b) if !other_parts && b.actions().len() == 2 => out.push(c("shape", Pass, "two Ironwood actions and nothing else")),
        Some(b) => out.push(c("shape", Fail, format!("unexpected shape: {} Ironwood action(s){}", b.actions().len(), if other_parts { ", plus parts in other pools" } else { "" }))),
        None => {
            out.push(c("shape", Fail, "it has no Ironwood part"));
            return out;
        }
    }
    let b = bundle.expect("checked above");

    // signatures: with no transparent inputs, the signature hash is the transaction id (ZIP 244)
    if tx.transparent_bundle().is_some() {
        out.push(c("signatures", NotChecked, "it has transparent parts, which this page does not check"));
    } else {
        let sighash: [u8; 32] = *tx.txid().as_ref();
        let bad_spend = b.actions().iter().position(|a| a.rk().verify(&sighash, a.authorization()).is_err());
        let binding_ok = b.binding_validating_key().verify(&sighash, b.authorization().binding_signature()).is_ok();
        out.push(match (bad_spend, binding_ok) {
            (None, true) => c("signatures", Pass, "all its signatures are valid"),
            (Some(k), _) => c("signatures", Fail, format!("the spend signature of action {k} is not valid")),
            (None, false) => c("signatures", Fail, "its balance (binding) signature is not valid"),
        });
    }

    // network version
    let tx_branch = format!("{:08x}", u32::from(tx.consensus_branch_id()));
    out.push(match &i.current_branch {
        None => c("network_version", NotChecked, "the network could not be asked which version it runs"),
        Some(now) if now.eq_ignore_ascii_case(&tx_branch) => c("network_version", Pass, format!("built for the network version in use now ({tx_branch})")),
        Some(now) => c("network_version", Fail, format!("built for network version {tx_branch}, but the network now runs {now}: the campaign must re-issue it")),
    });

    // no expiry, or (a sealed bid auction's early ticket) exactly the deadline
    let expiry = u32::from(tx.expiry_height());
    out.push(match i.expected_expiry {
        Some(e) if expiry == e => c("expiry", Pass, format!("it expires at block {e}, the deadline, as an early ticket must")),
        Some(e) => c("expiry", Fail, format!("it expires at block {expiry}, not at the deadline (block {e})")),
        None if expiry == 0 => c("no_expiry", Pass, "it never expires"),
        None => c("no_expiry", Fail, format!("it expires at block {expiry}")),
    });

    // fee: the value leaving the Ironwood pool is the fee
    let fee = i64::from(*b.value_balance());
    out.push(if fee == i.fee_zat as i64 {
        c("fee", Pass, format!("the network fee is {fee} zatoshi, as the rules say"))
    } else {
        c("fee", Fail, format!("the network fee is {fee} zatoshi, the rules say {}", i.fee_zat))
    });

    // spends the contribution's coin
    let nfs: Vec<String> = b.actions().iter().map(|a| hex::encode(a.nullifier().to_bytes())).collect();
    out.push(if nfs.iter().any(|n| n.eq_ignore_ascii_case(&i.contribution_nf)) {
        c("spends_your_coin", Pass, "it spends the coin of your contribution")
    } else {
        c("spends_your_coin", Fail, "it does not spend the coin of your contribution")
    });

    // the coin is still unspent (or was used by a transaction the signed list names)
    out.push(match (&i.spent, i.scanned_to) {
        (Some(s), _) if i.known_txids.iter().any(|t| t.eq_ignore_ascii_case(&s.txid)) => {
            c("coin_used_by_list", Pass, format!("the coin was used in block {} by {}, a transaction the campaign's list names", s.height, s.txid))
        }
        (Some(s), _) => c("coin_unspent", Fail, format!("the coin was already spent in block {} by {}, which is not this ticket", s.height, s.txid)),
        (None, Some(h)) => c("coin_unspent", Pass, format!("the coin is not spent yet (looked up to block {h})")),
        (None, None) => c("coin_unspent", NotChecked, "the chain has not been searched yet"),
    });

    // Fails only if the list shows LESS than what was meant or paid. Paying more than the amount chosen is fine: the whole
    // payment counts as the contribution (and is refunded, minus the fee), so that is a pass with a plain note.
    out.push(match (i.listed_contribution_zat, i.intended_contribution_zat, i.paid_zat) {
        (Some(l), Some(m), _) if l < m => c("your_amount", Fail, format!("the list shows a contribution of {l} zatoshi for your message, but you meant to pay {m}: someone else's payment may have used your message before yours (SPEC §2)")),
        (Some(l), _, Some(p)) if l < p => c("your_amount", Fail, format!("the list shows a contribution of {l} zatoshi, but your payment was {p} zatoshi")),
        (Some(l), Some(m), _) if l == m => c("your_amount", Pass, format!("the list shows your contribution as {l} zatoshi, as you meant")),
        (Some(l), Some(m), _) => c("your_amount", Pass, format!("the list shows {l} zatoshi, more than the {m} you chose: the whole payment counts as your contribution, and the refund is the payment minus the fee")),
        (Some(l), None, Some(_)) => c("your_amount", Pass, format!("the list shows your contribution as {l} zatoshi, which is what you paid or more")),
        _ => c("your_amount", NotChecked, "the amount was not compared (it is hidden in a sealed-bid auction, or not known on this device)"),
    });
    out.push(pays_you(i, b));
    out.push(c("proof", NotChecked, "the zero-knowledge proof (press \"Check the proof too\" to run it)"));
    out.push(c("anchor", NotChecked, "that its chain state (anchor) is real"));
    out
}

/// Level 2: recompute the refund output's note commitment from the opening values and the refund address the contributor
/// gave, and compare it with the commitment inside the ticket's OWN transaction (never a value the host merely claims).
/// A match means that output pays exactly the opened amount to that address; only then does the page say "it pays you".
fn pays_you(i: &Inputs, b: &orchard::Bundle<orchard::bundle::Authorized, zcash_protocol::value::ZatBalance>) -> Check {
    use orchard::{note::{ExtractedNoteCommitment, Note, RandomSeed}, value::NoteValue};
    use Status::*;
    let Some(o) = &i.opening else {
        return c("pays_you", NotChecked, "this ticket was issued before tickets carried the values needed for this check, so it is not checked (it is not a failure)");
    };
    let Some(recv_hex) = &i.refund_receiver_hex else {
        return c("pays_you", NotChecked, "the refund address you gave is not available on this device, so it could not be compared");
    };
    let Some(receiver) = hex::decode(recv_hex).ok().and_then(|v| <[u8; 43]>::try_from(v).ok()).and_then(|r| Option::from(orchard::Address::from_raw_address_bytes(&r))) else {
        return c("pays_you", NotChecked, "the refund address you gave could not be read as a shielded address");
    };
    let Some(action) = b.actions().get(o.action as usize) else {
        return c("pays_you", Fail, "the ticket's opening points at an output that does not exist");
    };
    let rho = action.rho();
    let Some(rseed) = Option::from(RandomSeed::from_bytes(o.rseed, &rho)) else {
        return c("pays_you", Fail, "the ticket's opening carries an invalid random seed");
    };
    let note = Option::from(Note::from_parts(receiver, NoteValue::from_raw(o.value_zat), rho, rseed, b.bundle_version().note_version()));
    let Some(note): Option<Note> = note else {
        return c("pays_you", Fail, "the opening does not describe a valid note");
    };
    if ExtractedNoteCommitment::from(note.commitment()) != *action.cmx() {
        return c("pays_you", Fail, "the refund output of this ticket does not pay the address you gave the amount the campaign says");
    }
    // A sealed-bid auction's list hides the amount, so when the page passes no expected refund the library works it out itself from what
    // this device knows: the payment it saw (the refund is exactly that minus the fee), or else the amount the contributor meant to pay
    // (the refund is at least that minus the fee; a larger payment counts in full). A ticket that pays back less fails here, in the
    // library, not only on the page (the encrypted bids research, flaw 1).
    let auction = match (i.listed_contribution_zat, i.paid_zat, i.intended_contribution_zat) {
        (Some(_), _, _) => None,
        (None, Some(p), _) => Some((p.saturating_sub(i.fee_zat), true)),
        (None, None, Some(m)) => Some((m.saturating_sub(i.fee_zat), false)),
        (None, None, None) => None,
    };
    match (i.expected_value_zat, auction) {
        (Some(v), _) if v != o.value_zat => c("pays_you", Fail, format!("the ticket pays you {} zatoshi but your contribution minus the fee is {v}", o.value_zat)),
        (Some(_), _) => c("pays_you", Pass, format!("its refund output pays exactly {} zatoshi (your contribution minus the fee) to the address you gave", o.value_zat)),
        (None, Some((v, true))) if o.value_zat != v => c("pays_you", Fail, format!("the ticket pays you {} zatoshi but your payment minus the fee is {v}", o.value_zat)),
        (None, Some((v, false))) if o.value_zat < v => c("pays_you", Fail, format!("the ticket pays you {} zatoshi but your contribution minus the fee is {v}", o.value_zat)),
        (None, Some((v, true))) => c("pays_you", Pass, format!("its refund output pays exactly {v} zatoshi (your payment minus the fee) to the address you gave")),
        (None, Some((v, false))) => c("pays_you", Pass, format!("its refund output pays {} zatoshi to the address you gave, at least your bid minus the fee ({v})", o.value_zat)),
        (None, None) => c("pays_you", Pass, format!("its refund output pays exactly {} zatoshi to the address you gave", o.value_zat)),
    }
}

/// SPEC §9.1, open_payouts: the outputs of a payment the host signed to a person (a refund, a winner's change, a return), as its outgoing viewing key
/// opens them: (receiver, 43 bytes hex; value) for each output it opens. A version 6 transaction id covers every output, so what the key
/// opens is what was mined under that id.
pub fn recover_outputs(raw: &[u8], ovk: &[u8; 32]) -> Result<Vec<(String, u64)>, String> {
    let tx = Transaction::read(raw, BranchId::Nu7).map_err(|e| format!("the transaction could not be read ({e})"))?;
    let Some(b) = tx.ironwood_bundle() else { return Ok(vec![]) };
    Ok(b.recover_outputs_with_ovks(&[orchard::keys::OutgoingViewingKey::from(*ovk)])
        .into_iter()
        .map(|r| (hex::encode(r.3.to_raw_address_bytes()), r.2.value().inner()))
        .collect())
}

/// Overall: "fail" if any check failed, else "pass" (with the list of what was not checked).
pub fn verdict(checks: &[Check]) -> Status {
    if checks.iter().any(|x| x.status == Status::Fail) { Status::Fail } else { Status::Pass }
}

#[cfg(test)]
mod tests;
