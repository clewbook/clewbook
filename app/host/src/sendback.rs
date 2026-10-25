//! The dashboard's "Send it back" for a Blind bid auction. A payment into the auction address that is not in the auction (no memo, a memo
//! that is not a bid memo, or less than the smallest deposit: `ll_core::sealed_recount::not_in_auction`) has no refund address the host can
//! read, so it stays in the auction wallet. The host can send it back by hand to an address the payer gives, minus the refund fee, after
//! weighing what the payer shows: the bid backup file, a wallet key, and the host's own notes. Every piece is optional and none of it
//! proves who paid. The return spends that one note and pays that one address, nothing else (checked before it is sent). It is not named
//! on the public list (the relay takes no entries after the close); the dashboard gives a line for docs/EVIDENCE.md instead, and keeps a
//! copy in the campaign folder (`sendback-evidence.txt`). The wallet key is used for the check and dropped; it is never written anywhere.

use super::*;

use std::io::Write;

use serde_json::{Value, json};

use ll_core::{
    bid::{self, BidMemo},
    receiver::{network_type, orchard_receiver, to_standard, valid_orchard_receiver},
    sealed_recount::NotInAuction,
};
use zcash_address::unified::{self, Container, Encoding};

/// The payments of a sealed bid auction that are not in it, without those the host still lists or rejects on its next pass (a blind bid
/// memo on a payment of at least the smallest size, not spent).
pub fn not_in_auction(rules: &Rules, entries: &[Entry], notes: &[ChainNote]) -> Vec<NotInAuction> {
    let pending = |n: &ChainNote| n.spent_by.is_none() && n.value_zat >= rules.min_contribution_zat && n.memo_text.as_deref().is_some_and(bid::is_bid_memo);
    let left: Vec<ChainNote> = notes.iter().filter(|n| !pending(n)).cloned().collect();
    ll_core::sealed_recount::not_in_auction(rules, entries, &left)
}

/// The form of a standard unified address on this network (`u1`, `utest1`, `uregtest1`).
fn prefix(network: &str) -> &'static str {
    match network {
        "main" => "u1",
        "test" => "utest1",
        _ => "uregtest1",
    }
}

/// The payer's address: a standard unified address of the auction's network with a receiver the wallet can pay. The wallet's own form
/// (zu1…) is refused, as the owner asked: it is the form common wallets do not show.
pub fn payer_receiver(network: &str, address: &str) -> Result<[u8; 43]> {
    let a = address.trim();
    let p = prefix(network);
    ensure!(!a.is_empty(), "Paste the payer's {p} address.");
    let (net, raw) = orchard_receiver(a).map_err(|_| anyhow!("Paste the payer's {p} address."))?;
    ensure!(net == network_type(network)?, "That address is for another network.");
    ensure!(a.starts_with(p) && to_standard(a)? == a, "Paste the {p} form of the address. The z{p} form is refused.");
    ensure!(valid_orchard_receiver(&raw), "That address cannot receive a payment.");
    Ok(raw)
}

/// The outgoing viewing keys a wallet key gives: a unified full viewing key (both of its Orchard/Ironwood outgoing keys), or a raw 32 byte
/// outgoing viewing key in hex. Returns the keys and whether it was a full viewing key (which also shows every payment received).
fn outgoing_keys(key: &str) -> Result<(Vec<[u8; 32]>, bool)> {
    let k = key.trim();
    if k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok((vec![ll_core::hex32(k)?], false));
    }
    let (_, _, ufvk) = unified::Ufvk::decode(k).map_err(|_| anyhow!("That wallet key cannot be read. Give a full viewing key (uview…) or a 64 character outgoing viewing key."))?;
    let fvk = ufvk
        .items()
        .into_iter()
        .find_map(|i| match i {
            unified::Fvk::Orchard(raw) => orchard::keys::FullViewingKey::from_bytes(&raw),
            _ => None,
        })
        .ok_or_else(|| anyhow!("That wallet key has no part for shielded payments of this kind."))?;
    let ovks = [orchard::keys::Scope::External, orchard::keys::Scope::Internal].map(|s| *fvk.to_ovk(s).as_ref());
    Ok((ovks.to_vec(), true))
}

/// One line of what the form shows: `tone` is "ok", "warn" or "bad".
fn line(tone: &str, text: impl Into<String>) -> Value {
    json!({ "tone": tone, "text": text.into() })
}

/// One line, safe for a Markdown table and a log: no line breaks, no table bars, at most 300 characters.
fn one_line(s: &str) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ").replace('|', "/");
    t.chars().take(300).collect()
}

/// What the form gives: the payment, the payer's address and the optional evidence. `backup` holds only what the dashboard takes from the
/// bid backup file (never its seed): campaign, memo, tranche, refund, startHeight.
struct Ask {
    txid: String,
    action: u32,
    address: String,
    backup: Option<Value>,
    wallet_key: Option<String>,
    notes: Option<String>,
}

fn ask(body: &Value) -> Result<Ask> {
    let txt = |k: &str| body[k].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    Ok(Ask {
        txid: txt("txid").filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(|| anyhow!("Which payment? The transaction id is missing."))?,
        action: body["action"].as_u64().unwrap_or(0) as u32,
        address: txt("address").unwrap_or_default(),
        backup: Some(body["backup"].clone()).filter(Value::is_object),
        wallet_key: txt("wallet_key"),
        notes: txt("notes").map(|n| one_line(&n)),
    })
}

/// The payment the form names, if it is one of the auction's payments not in the auction and still in the wallet.
fn payment(run: &Run, notes: &[ChainNote], entries: &[Entry], a: &Ask) -> Result<(ChainNote, NotInAuction)> {
    let p = not_in_auction(&run.rules, entries, notes)
        .into_iter()
        .find(|p| p.txid == a.txid && p.action == a.action)
        .ok_or_else(|| anyhow!("That payment is not one of this auction's payments not in the auction."))?;
    let n = notes.iter().find(|n| n.txid == a.txid && n.action == a.action && !n.is_change).cloned().ok_or_else(|| anyhow!("That payment is not in the wallet."))?;
    ensure!(n.spent_by.is_none(), "That payment was already spent, in transaction {}.", n.spent_by.as_ref().map_or("", |s| s.txid.as_str()));
    ensure!(n.value_zat > run.rules.refund_fee_zat, "That payment is not more than the network fee.");
    Ok((n, p))
}

/// The evidence as the form shows it, and the summary that goes into the evidence line.
struct Weighed {
    lines: Vec<Value>,
    summary: Vec<String>,
    none_given: bool,
}

fn weigh(run: &Run, backend: &mut dyn WalletBackend, n: &ChainNote, a: &Ask, receiver: &[u8; 43]) -> Result<Weighed> {
    let r = &run.rules;
    let (mut lines, mut summary) = (vec![], vec![]);
    // the bid backup file: what the file says, and what its message says once opened with this auction's key
    match &a.backup {
        None => {
            lines.push(line("warn", "Backup file: not given."));
            summary.push("backup file: not given".to_string());
        }
        Some(b) => {
            let mut s = vec!["given".to_string()];
            if b["campaign"].as_str() != Some(run.rules_id.as_str()) {
                lines.push(line("bad", "The backup file is for another auction."));
                s.push("for another auction".into());
            }
            let memo = b["memo"].as_str().unwrap_or_default();
            let opened = BidMemo::parse(memo).and_then(|m| Payload::open_sealed(&m.sealed, &run.secrets.payload_key()?).map_err(|e| anyhow!("{e}")));
            match opened {
                Ok(p) if hex::encode(p.rules_id) == run.rules_id => {
                    lines.push(line("ok", "Made for this auction: its message opens with this auction's key."));
                    s.push("made for this auction".into());
                    if let Some(t) = p.amount_zat {
                        let same = t == n.value_zat;
                        lines.push(line(if same { "ok" } else { "warn" }, format!("Deposit size in the file: {}. This payment: {}.", r.amount(t), r.amount(n.value_zat))));
                        s.push(format!("deposit {}{}", r.amount(t), if same { "" } else { ", not this payment's size" }));
                    }
                    let refund = encode_orchard(network_type(&r.network)?, p.refund_receiver).unwrap_or_default();
                    if &p.refund_receiver == receiver {
                        lines.push(line("ok", "Its refund address is the address above."));
                        s.push("refund address matches".into());
                    } else {
                        lines.push(line("bad", format!("Warning: the address above is not the refund address in the file ({refund}).")));
                        s.push("refund address does NOT match".into());
                    }
                }
                Ok(_) => {
                    lines.push(line("bad", "The file's message was made for another auction."));
                    s.push("message for another auction".into());
                }
                Err(_) => {
                    lines.push(line("bad", "The file's message does not open with this auction's key."));
                    s.push("message does not open".into());
                }
            }
            if let Some(h) = b["startHeight"].as_u64() {
                let after = h > u64::from(n.height.unwrap_or(0));
                lines.push(line(if after { "bad" } else { "ok" }, format!("The file says it was made at block {h}; the payment came at block {}.", n.height.unwrap_or(0))));
                s.push(format!("made at block {h}"));
            }
            lines.push(line("warn", "This is evidence, not proof of who paid."));
            summary.push(format!("backup file: {}", s.join(", ")));
        }
    }
    // the wallet key: does it open this payment's output to the auction (outgoing viewing key)? Used here and dropped.
    match &a.wallet_key {
        None => {
            lines.push(line("warn", "Wallet key: not given."));
            summary.push("wallet key: not given".to_string());
        }
        Some(k) => {
            let (ovks, full) = outgoing_keys(k)?;
            // the address people pay (the rules name it; else the wallet's own)
            let pay_to = match &r.pay_to { Some(a) => a.clone(), None => backend.account()?.address };
            let (_, auction) = orchard_receiver(&pay_to)?;
            let mut shows = false;
            for ovk in ovks {
                let facts = backend.payout_facts(&[(n.txid.clone(), Some(hex::encode(ovk)))])?;
                if facts.iter().any(|f| f.outputs.iter().any(|o| o.receiver_hex == hex::encode(auction) && o.value_zat == n.value_zat)) {
                    shows = true;
                    break;
                }
            }
            lines.push(line(if shows { "ok" } else { "bad" }, if shows { "Wallet key: this key shows the transaction." } else { "Wallet key: does not match." }));
            if full {
                lines.push(line("warn", "A full viewing key also shows every payment that account received."));
            }
            summary.push(format!("wallet key: given, {}", if shows { "shows the transaction" } else { "does not match" }));
        }
    }
    match &a.notes {
        None => {
            lines.push(line("warn", "Notes: not given."));
            summary.push("notes: not given".to_string());
        }
        Some(t) => summary.push(format!("notes: \"{t}\"")),
    }
    let none_given = a.backup.is_none() && a.wallet_key.is_none() && a.notes.is_none();
    if none_given {
        lines.push(line("bad", "Nothing here shows who paid. Anyone can see this transaction id."));
    }
    Ok(Weighed { lines, summary, none_given })
}

/// The form's Check: the payment, the address and the evidence, nothing sent.
pub fn check(run: &Run, backend: &mut dyn WalletBackend, body: &Value) -> Result<Value> {
    ensure!(run.rules.is_sealed(), "Only a blind bid auction has payments not in the auction.");
    let a = ask(body)?;
    let receiver = payer_receiver(&run.rules.network, &a.address)?;
    let notes = chain_notes(&backend.notes()?);
    let (n, p) = payment(run, &notes, &run.ledger().load()?, &a)?;
    let w = weigh(run, backend, &n, &a, &receiver)?;
    let fee = run.rules.refund_fee_zat;
    Ok(json!({
        "ok": true, "txid": n.txid, "action": n.action, "height": n.height, "value_zat": n.value_zat, "reason": p.reason,
        "fee_zat": fee, "back_zat": n.value_zat - fee, "address": a.address.trim(),
        "lines": w.lines, "none_given": w.none_given,
    }))
}

/// The form's Send: the same checks, the first 8 characters of the payment's transaction id typed by the host, then one payment that spends
/// only this note and pays only this address, minus the refund fee. Returns the new transaction id and the evidence line.
pub fn send(run: &Run, backend: &mut dyn WalletBackend, body: &Value) -> Result<Value> {
    ensure!(run.rules.is_sealed(), "Only a blind bid auction has payments not in the auction.");
    let a = ask(body)?;
    let typed = body["confirm"].as_str().unwrap_or_default().trim().to_ascii_lowercase();
    ensure!(typed == a.txid[..8], "Type the first 8 characters of the transaction id to send.");
    let receiver = payer_receiver(&run.rules.network, &a.address)?;
    let tip = backend.chain_tip()?;
    let notes = chain_notes(&backend.notes()?);
    let entries = run.ledger().load()?;
    let (n, p) = payment(run, &notes, &entries, &a)?;
    let h = n.height.unwrap_or(0);
    ensure!((tip.height + 1).saturating_sub(h) >= run.min_confirmations, "Wait until the payment has {} confirmation(s).", run.min_confirmations);
    let nf = n.nf.clone().ok_or_else(|| anyhow!("That payment has no nullifier."))?;
    ensure!(outbox::Outbox::load(&run.dir)?.live_for(&nf).is_none(), "That payment is already being sent back.");
    let w = weigh(run, backend, &n, &a, &receiver)?;
    let r = &run.rules;
    let back = n.value_zat - r.refund_fee_zat;
    let owner = format!("sendback:{nf}");
    backend.lock(&n.txid, n.action, &owner, LOCK_FOREVER)?;
    let to = encode_orchard(network_type(&r.network)?, receiver)?;
    let built = (|| {
        let unsigned = backend.build(&SpendRequest { to_address: to, value_zat: back, lock_owners: vec![owner.clone()], no_expiry: true, expiry_height: None, also_pay: vec![], ovk: None })?;
        let signed = backend.sign(&unsigned)?;
        // exactly this note spent, exactly this address paid: anything else is refused before it is sent
        ticket::check_and_extract(&signed, &ticket::Expect { spends: BTreeMap::from([(hex32(&nf)?, n.value_zat)]), receiver: &receiver, value_zat: back, no_expiry: true, also: vec![] })?;
        Ok::<_, anyhow::Error>(signed)
    })();
    let signed = match built {
        Ok(s) => s,
        Err(e) => {
            let _ = backend.unlock(&n.txid, n.action, &owner);
            return Err(e);
        }
    };
    let mut log = vec![];
    let txid = send_tracked(run, backend, &tip, "sendback", &format!("payment {} sent back by hand", &n.txid[..8]), &signed, vec![nf], &mut log)?;
    let date = utc_date(now_unix());
    let name = r.name.clone().unwrap_or_else(|| run.rules_id[..8].to_string());
    let evidence = format!(
        "Sent back by hand on {date} UTC ({name}, campaign {}): payment {} (block {h}, {}, {}) to {}, {} after the {} fee, in transaction {txid}. Proofs: {}.",
        &run.rules_id[..8], n.txid, r.amount(n.value_zat), p.reason, a.address.trim(), r.amount(back), r.amount(r.refund_fee_zat), w.summary.join("; ")
    );
    let mut f = fs::OpenOptions::new().create(true).append(true).open(run.dir.join("sendback-evidence.txt"))?;
    writeln!(f, "{evidence}")?;
    println!("payment {}:{} (not in the auction) sent back by hand: {txid}", n.txid, n.action);
    Ok(json!({ "ok": true, "txid": txid, "evidence": evidence }))
}

/// `YYYY-MM-DD` of a Unix time (UTC), by the civil from days algorithm.
fn utc_date(secs: u64) -> String {
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{m:02}-{d:02}", yoe + era * 400 + i64::from(m <= 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_payers_address_must_be_the_standard_form_of_this_network() {
        let raw = {
            let sk = orchard::keys::SpendingKey::from_bytes([3u8; 32]).unwrap();
            orchard::keys::FullViewingKey::from(&sk).address_at(0u32, orchard::keys::Scope::External).to_raw_address_bytes()
        };
        let r0 = encode_orchard(zcash_protocol::consensus::NetworkType::Test, raw).unwrap();
        let r2 = unified::Address::try_from_items(unified::Revision::R2, vec![unified::Uitem::Data(unified::Receiver::Orchard(raw))]).unwrap().encode(&zcash_protocol::consensus::NetworkType::Test);
        assert!(r0.starts_with("utest1") && r2.starts_with("zutest1"));
        assert_eq!(payer_receiver("test", &format!(" {r0}\n")).unwrap(), raw);
        assert!(payer_receiver("test", &r2).unwrap_err().to_string().contains("The zutest1 form is refused"));
        assert!(payer_receiver("main", &r0).unwrap_err().to_string().contains("another network"));
        assert!(payer_receiver("test", "").unwrap_err().to_string().contains("Paste the payer's utest1 address"));
        assert!(payer_receiver("test", &encode_orchard(zcash_protocol::consensus::NetworkType::Test, [0xff; 43]).unwrap()).is_err());
    }

    #[test]
    fn a_wallet_key_gives_both_outgoing_keys_of_a_full_viewing_key_or_one_raw_key() {
        let sk = orchard::keys::SpendingKey::from_bytes([5u8; 32]).unwrap();
        let fvk = orchard::keys::FullViewingKey::from(&sk);
        let ufvk = unified::Ufvk::try_from_items(unified::Revision::R0, vec![unified::Uitem::Data(unified::Fvk::Orchard(fvk.to_bytes()))]).unwrap().encode(&zcash_protocol::consensus::NetworkType::Test);
        let (keys, full) = outgoing_keys(&ufvk).unwrap();
        assert!(full);
        assert_eq!(keys, vec![*fvk.to_ovk(orchard::keys::Scope::External).as_ref(), *fvk.to_ovk(orchard::keys::Scope::Internal).as_ref()]);
        let (one, full) = outgoing_keys(&"ab".repeat(32)).unwrap();
        assert_eq!((one, full), (vec![[0xab; 32]], false));
        assert!(outgoing_keys("not a key").is_err());
    }

    #[test]
    fn notes_become_one_safe_line_and_dates_are_utc() {
        assert_eq!(one_line("checked by\nphone | twice  "), "checked by phone / twice");
        assert_eq!(one_line(&"x".repeat(400)).len(), 300);
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(1_792_886_400), "2026-10-25");
        assert_eq!(utc_date(951_782_400), "2000-02-29");
    }
}
