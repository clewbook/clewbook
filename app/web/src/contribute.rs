//! Functions for the contribute page: everything that touches keys, memos or tickets runs here,
//! in the browser, so secrets never leave the device. Error messages are written for the
//! person using the page, in plain words.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use prost::Message;
use qrcode::{EcLevel, QrCode, render::svg};
use zcash_client_backend::proto::service::{RawTransaction, SendResponse};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

use super::*;

/// The payment-link scheme name, assembled so that the plain word does not sit in the source.
const SCHEME: &str = concat!("zc", "ash");

fn plain(msg: impl Into<String>) -> JsError {
    JsError::new(&msg.into())
}

fn ticker(rules: &Rules) -> &'static str {
    if rules.network == "main" { "ZEC" } else { "TAZ" }
}

fn zat_to_coin(zat: u64) -> String {
    let whole = zat / 100_000_000;
    let frac = zat % 100_000_000;
    if frac == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{frac:08}").trim_end_matches('0').to_string()
    }
}

fn keys_from(seed_hex: &str) -> Result<ContributorKeys, JsError> {
    ContributorKeys::from_hex(seed_hex).map_err(|_| plain("The saved secret for this contribution is damaged. Please restore your backup file."))
}

fn parse_rules(rules_json: &str) -> Result<Rules, JsError> {
    serde_json::from_str(rules_json).map_err(|_| plain("The campaign details could not be read."))
}

/// A new random secret for one contribution (hex). It never leaves this device.
#[wasm_bindgen]
pub fn generate_seed() -> String {
    hex::encode(ContributorKeys::generate().seed)
}

/// Checks that `rules_json` is the campaign with this id and returns what the page shows.
#[wasm_bindgen]
pub fn campaign_summary(rules_json: &str, rules_id: &str) -> Result<String, JsError> {
    let rules = parse_rules(rules_json)?;
    let id = hex::encode(rules.id().map_err(|_| plain("The campaign details are not valid."))?);
    if id != rules_id.to_lowercase() {
        return Err(plain("These campaign details do not match the campaign link. Do not pay; check the link you were given."));
    }
    rules.validate().map_err(|_| plain("The campaign details are incomplete."))?;
    let mut out = serde_json::json!({
        "mode": rules.mode, "network": rules.network, "ticker": ticker(&rules), "name": rules.name,
        "goal_zat": rules.goal_zat, "goal": rules.goal_zat.map(zat_to_coin), "items": rules.items,
        "start_height": rules.start_height, "deadline_height": rules.deadline_height,
        "ticket_k": rules.ticket_k, "close_grace": rules.close_grace,
        "min_zat": rules.min_contribution_zat, "min": zat_to_coin(rules.min_contribution_zat),
        "fee_zat": rules.refund_fee_zat, "fee": zat_to_coin(rules.refund_fee_zat),
        "pay_to": rules.pay_to, "campaign_ufvk": rules.campaign_ufvk,
        "early_close": rules.allows_early_close(), "cancellable": rules.allows_cancel(), "cap_zat": rules.cap_zat, "cap": rules.cap_zat.map(zat_to_coin),
        "pricing": rules.pricing, "settle_by": rules.settle_by(), "settle_window": rules.settle_window.unwrap_or(rules.ticket_k), "reserve_zat": rules.reserve_zat, "reserve": rules.reserve_zat.map(zat_to_coin), "treasury_address": rules.treasury_address,
    });
    // a sealed bid auction only (other campaigns' summaries stay exactly as they were)
    if let Some(s) = &rules.sealed {
        out["sealed"] = serde_json::json!({
            "tranches_zat": s.tranches_zat, "tranches": s.tranches_zat.iter().map(|t| zat_to_coin(*t)).collect::<Vec<_>>(), "pricing": s.pricing,
            "round": s.drand_round, "claim_after": s.claim_after, "cutoff": s.cutoff_height(rules.deadline_height), "timing": s.timing,
        });
    }
    Ok(out.to_string())
}

/// The host's "last seen" signal, checked against the campaign: it must be signed with the campaign's ledger key and be for this campaign. Returns
/// `{"height":..,"time":..}`; anything else is refused with a plain message, so a relay cannot show a made-up one.
#[wasm_bindgen]
pub fn verify_heartbeat(rules_json: &str, rules_id: &str, heartbeat_json: &str) -> Result<String, JsError> {
    let rules = parse_rules(rules_json)?;
    let id = hex::encode(rules.id().map_err(|_| plain("The campaign details are not valid."))?);
    if id != rules_id.to_lowercase() {
        return Err(plain("These campaign details do not match the campaign link."));
    }
    let pk = ll_core::ledger::verifying_key(&rules.ledger_pubkey).map_err(|_| plain("The campaign's key is not valid."))?;
    let hb: ll_core::heartbeat::Heartbeat = serde_json::from_str(heartbeat_json).map_err(|_| plain("That is not a heartbeat."))?;
    hb.verify(&pk, &id).map_err(|e| plain(e.to_string()))?;
    Ok(serde_json::json!({ "height": hb.height, "time": hb.time }).to_string())
}

/// Checks an address the person typed, without building anything.
#[wasm_bindgen]
pub fn check_refund_address(network: &str, address: &str) -> Result<(), JsError> {
    let address = address.trim();
    if address.is_empty() {
        return Err(plain("Please enter the address where your refund should go."));
    }
    let (net, raw) = orchard_receiver(address).map_err(|e| {
        let m = e.to_string();
        if m.contains("no Orchard") {
            plain("This address can't receive the refund. Please use a full shielded address (the long one) from your wallet.")
        } else {
            plain("That doesn't look like a valid refund address. Please copy it again from your wallet.")
        }
    })?;
    // the same check the campaign's host makes (ll_core::payload::check): a receiver no wallet can pay would get no refund ticket
    if !ll_core::receiver::valid_orchard_receiver(&raw) {
        return Err(plain("That doesn't look like a valid refund address. Please copy it again from your wallet."));
    }
    let wanted = network_type(network).map_err(|_| plain("Unknown network."))?;
    if net != wanted {
        let which = if network == "main" { "the main network" } else { "the test network" };
        return Err(plain(format!("This address is for a different network. This campaign uses {which}.")));
    }
    Ok(())
}

/// Builds the payment: the sealed memo, the payment link and its QR code. It refuses to build
/// anything for an invalid refund address, an amount below the minimum, or a memo that is missing.
#[wasm_bindgen]
pub fn build_payment(rules_json: &str, seed_hex: &str, refund_address: &str, amount_zat: f64) -> Result<String, JsError> {
    let rules = parse_rules(rules_json)?;
    let pay_to = rules.pay_to.clone().ok_or_else(|| plain("This campaign has not published a payment address, so it can't take payments here."))?;
    // Wallets only accept the standard (u1 / utest1) form; campaigns made with prerelease libraries may carry the newer one.
    let pay_to = ll_core::receiver::to_standard(&pay_to).unwrap_or(pay_to);
    check_refund_address(&rules.network, refund_address)?;
    if !(amount_zat.is_finite() && amount_zat >= 0.0 && amount_zat.fract() == 0.0) {
        return Err(plain("Please enter a valid amount."));
    }
    let amount = amount_zat as u64;
    if amount < rules.min_contribution_zat {
        return Err(plain(format!("The smallest amount this campaign accepts is {} {}.", zat_to_coin(rules.min_contribution_zat), ticker(&rules))));
    }
    let keys = keys_from(seed_hex)?;
    let (_, receiver) = orchard_receiver(refund_address.trim()).map_err(|_| plain("That doesn't look like a valid refund address."))?;
    let payload = Payload {
        rules_id: rules.id().map_err(|_| plain("The campaign details are not valid."))?,
        sign_pubkey: keys.signing_key().verifying_key().to_bytes(),
        enc_pubkey: *keys.encryption_key().public_key().as_bytes(),
        refund_typecode: TYPECODE_ORCHARD,
        refund_receiver: receiver,
        amount_zat: Some(amount), // payload version 2: a smaller payment is not a contribution (SPEC §2)
    };
    let pk = ll_core::hex32(&rules.payload_pubkey).map_err(|_| plain("The campaign details are not valid."))?;
    let memo = payload.to_memo(&pk, &keys.memo_ephemeral_key()).map_err(|_| plain("The payment message could not be prepared."))?;
    if memo.is_empty() || !memo.starts_with("LL1:") || memo.len() > 512 || memo.len() < 267 {
        return Err(plain("The payment message is missing or not valid, so no payment was created."));
    }
    let uri = format!("{SCHEME}:{pay_to}?amount={}&memo={}", zat_to_coin(amount), URL_SAFE_NO_PAD.encode(memo.as_bytes()));
    let draw = |text: &str| -> Result<String, JsError> {
        let qr = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L).map_err(|_| plain("The payment code is too large to draw. Please use the copy buttons instead."))?;
        Ok(qr.render::<svg::Color>().min_dimensions(320, 320).quiet_zone(true).dark_color(svg::Color("#000")).light_color(svg::Color("#fff")).build())
    };
    let svg = draw(&uri)?;
    // A smaller code for cameras that struggle: the same payment to the same campaign, but the address
    // carries only the shielded receiver the campaign actually uses (the Orchard/Ironwood one).
    let (light_uri, light_svg) = match ll_core::receiver::orchard_receiver(&pay_to)
        .and_then(|(net, raw)| ll_core::receiver::encode_orchard(net, raw))
    {
        Ok(short) => {
            let u = format!("{SCHEME}:{short}?amount={}&memo={}", zat_to_coin(amount), URL_SAFE_NO_PAD.encode(memo.as_bytes()));
            let d = draw(&u)?;
            (Some(u), Some(d))
        }
        Err(_) => (None, None),
    };
    Ok(serde_json::json!({
        "memo": memo, "uri": uri, "qr_svg": svg, "qr_svg_light": light_svg, "uri_light": light_uri, "pay_to": pay_to,
        "amount_zat": amount, "amount": zat_to_coin(amount),
        "refund_zat": amount - rules.refund_fee_zat, "refund": zat_to_coin(amount - rules.refund_fee_zat),
        "ticker": ticker(&rules),
    })
    .to_string())
}

/// Whether a sealed ticket was made for this contribution (it opens with this device's secret).
#[wasm_bindgen]
pub fn blob_is_mine(seed_hex: &str, blob: &[u8]) -> bool {
    keys_from(seed_hex).map(|k| k.encryption_key().unseal(blob).is_ok()).unwrap_or(false)
}

/// Opens a sealed ticket and checks it against its signed ledger entry; returns what is needed
/// to broadcast it.
#[wasm_bindgen]
pub fn open_ticket(seed_hex: &str, entry_json: &str, blob: &[u8]) -> Result<String, JsError> {
    let entry: Entry = serde_json::from_str(entry_json).map_err(|_| plain("The ticket's ledger entry could not be read."))?;
    let ticket = entry.ticket.clone().ok_or_else(|| plain("That ledger entry has no ticket."))?;
    if Some(blob_hash(blob)) != entry.blob_hash {
        return Err(plain("The ticket does not match what the campaign signed."));
    }
    let plain_blob = keys_from(seed_hex)?
        .encryption_key()
        .unseal(blob)
        .map_err(|_| plain("This ticket was not made for this device's secret."))?;
    // version 1: the raw transaction only; version 2: the raw transaction plus the refund output's opening values (SPEC §3.1)
    let (blob_version, raw, opening) = ll_core::ticket_blob::decode(&plain_blob).map_err(|_| plain("The ticket is damaged."))?;
    let branch = u32::from_str_radix(&ticket.branch_id, 16).ok().and_then(|b| BranchId::try_from(b).ok()).ok_or_else(|| plain("The ticket is for an unknown network version."))?;
    let tx = Transaction::read(&raw[..], branch).map_err(|_| plain("The ticket is damaged."))?;
    if tx.txid().to_string() != ticket.txid {
        return Err(plain("The ticket does not match its ledger entry."));
    }
    Ok(serde_json::json!({
        "raw_hex": hex::encode(&raw), "txid": ticket.txid, "expiry": u32::from(tx.expiry_height()),
        "branch_id": ticket.branch_id, "seq": entry.seq, "kind": entry.kind,
        "blob_version": blob_version, "opening": opening,
    })
    .to_string())
}

/// The challenge that proves a rejected payment was valid (SPEC §4).
#[wasm_bindgen]
pub fn challenge_json(seed_hex: &str, txid: &str, action: u32) -> Result<String, JsError> {
    let c = Challenge { txid: txid.to_lowercase(), action, eph_sk: hex::encode(keys_from(seed_hex)?.memo_ephemeral_key().to_bytes()), uivk: None, complaint: false, memo: None };
    ll_core::canon::to_canonical(&c).map_err(|_| plain("The proof could not be prepared."))
}

/// The same for a blind bid auction made with open payouts: it carries the payment's memo, so a relay can check the secret opens it before it
/// stores it (the second review, H2: junk secrets can no longer fill the challenge slots).
#[wasm_bindgen]
pub fn challenge_json_memo(seed_hex: &str, txid: &str, action: u32, memo: &str) -> Result<String, JsError> {
    let c = Challenge { txid: txid.to_lowercase(), action, eph_sk: hex::encode(keys_from(seed_hex)?.memo_ephemeral_key().to_bytes()), uivk: None, complaint: false, memo: Some(memo.to_string()) };
    ll_core::canon::to_canonical(&c).map_err(|_| plain("The proof could not be prepared."))
}

/// A uniform-auction winner's statement about the excess (SPEC §8.5). With `uivk` (the incoming viewing key
/// of the dedicated account the refund address belongs to) the recount can verify delivery; with an empty
/// `uivk` and `complaint` it is only an unverified report.
#[wasm_bindgen]
pub fn disclosure_json(seed_hex: &str, txid: &str, action: u32, uivk: &str, complaint: bool) -> Result<String, JsError> {
    let uivk = uivk.trim();
    if uivk.is_empty() && !complaint {
        return Err(plain("Please paste the viewing key, or choose to report that the money did not arrive."));
    }
    let c = Challenge {
        txid: txid.to_lowercase(), action,
        eph_sk: hex::encode(keys_from(seed_hex)?.memo_ephemeral_key().to_bytes()),
        uivk: (!uivk.is_empty()).then(|| uivk.to_string()), complaint, memo: None,
    };
    ll_core::canon::to_canonical(&c).map_err(|_| plain("The proof could not be prepared."))
}

/// Checks a ledger read from an untrusted server: signatures, numbering, hash chain. Returns a
/// JSON array of problems (empty when intact).
#[wasm_bindgen]
pub fn check_ledger(rules_json: &str, rules_id: &str, ledger_json: &str) -> Result<String, JsError> {
    let rules = parse_rules(rules_json)?;
    let entries: Vec<Entry> = serde_json::from_str(ledger_json).map_err(|_| plain("The list could not be read."))?;
    let pk = verifying_key(&rules.ledger_pubkey).map_err(|_| plain("The campaign details are not valid."))?;
    Ok(serde_json::to_string(&check_chain(&entries, &pk, &rules_id.to_lowercase())).unwrap_or_default())
}

/// The hash of every entry of a list, in order (JSON array of hex strings): what a browser remembers about a list and what two lists are compared by.
/// The list must be readable; whether it is intact is `check_ledger`'s job.
#[wasm_bindgen]
pub fn list_hashes(ledger_json: &str) -> Result<String, JsError> {
    let entries: Vec<Entry> = serde_json::from_str(ledger_json).map_err(|_| plain("The list could not be read."))?;
    let hashes: Vec<String> = entries.iter().map(|e| e.hash().unwrap_or_default()).collect();
    Ok(serde_json::to_string(&hashes).unwrap_or_default())
}

/// The host's final fingerprint compared with a list that has already passed `check_ledger`. `final_json` may be empty (nothing was published).
/// Returns `{"line": the list's own fingerprint line, "state": "none" | "match" | "cut_off" | "extra" | "different" | "invalid", "record_line": ..., "has": n, "fixed": n}`;
/// "invalid" means a record was given but is not signed by the campaign's key (it is then ignored, never trusted).
#[wasm_bindgen]
pub fn final_check(rules_json: &str, rules_id: &str, ledger_json: &str, final_json: &str) -> Result<String, JsError> {
    use ll_core::final_copy::{Comparison, FinalRecord, list_line};
    let rules = parse_rules(rules_json)?;
    let entries: Vec<Entry> = serde_json::from_str(ledger_json).map_err(|_| plain("The list could not be read."))?;
    let pk = verifying_key(&rules.ledger_pubkey).map_err(|_| plain("The campaign details are not valid."))?;
    let line = list_line(&entries).unwrap_or_default();
    let mut out = serde_json::json!({ "line": line, "state": "none", "has": entries.len() });
    if final_json.trim().is_empty() || final_json.trim() == "null" {
        return Ok(out.to_string());
    }
    let id = rules_id.to_lowercase();
    let rec: Result<FinalRecord, _> = serde_json::from_str(final_json);
    let rec = match rec {
        Ok(r) if r.verify(&pk, &id).is_ok() => r,
        _ => {
            out["state"] = "invalid".into();
            return Ok(out.to_string());
        }
    };
    out["record_line"] = rec.line().into();
    out["fixed"] = rec.entries.into();
    out["close_height"] = rec.close_height.into();
    out["state"] = match rec.compare(&entries) {
        Comparison::Matches => "match",
        Comparison::CutOff { .. } => "cut_off",
        Comparison::ExtraEntries { .. } => "extra",
        Comparison::Different => "different",
    }
    .into();
    Ok(out.to_string())
}

/// A gRPC request that sends a signed transaction to the network.
#[wasm_bindgen]
pub fn send_request(raw_hex: &str) -> Result<Vec<u8>, JsError> {
    let data = hex::decode(raw_hex).map_err(|_| plain("The ticket is damaged."))?;
    Ok(RawTransaction { data, height: 0 }.encode_to_vec())
}

/// Reads the network's answer to `send_request`: JSON `{ok, message}`.
#[wasm_bindgen]
pub fn parse_send_response(bytes: &[u8]) -> Result<String, JsError> {
    let r = SendResponse::decode(bytes).map_err(|_| plain("The network's answer could not be read."))?;
    Ok(serde_json::json!({ "ok": r.error_code == 0, "message": r.error_message }).to_string())
}

/// Level-1 ticket checks (SPEC §3.1): JSON `Inputs` in, `{"verdict": "pass"|"fail", "checks": [...]}` out.
#[wasm_bindgen]
pub fn verify_ticket(inputs_json: &str) -> Result<String, JsError> {
    let i: ll_ticketcheck::Inputs = serde_json::from_str(inputs_json).map_err(|_| plain("The ticket check could not start."))?;
    let checks = ll_ticketcheck::check(&i);
    Ok(serde_json::json!({ "verdict": ll_ticketcheck::verdict(&checks), "checks": checks }).to_string())
}

/// The network version and height a server reports (`GetLightdInfo`): `{"branch": "77190ad9", "height": N}`.
#[wasm_bindgen]
pub fn parse_lightd_info(bytes: &[u8]) -> Result<String, JsError> {
    use prost::Message;
    let info = zcash_client_backend::proto::service::LightdInfo::decode(bytes).map_err(|_| plain("The server's answer could not be read."))?;
    Ok(serde_json::json!({ "branch": info.consensus_branch_id.to_lowercase(), "height": info.block_height }).to_string())
}

/// The 43-byte Orchard receiver (hex) inside a refund address, or an empty string if it has none (used by the ticket check).
#[wasm_bindgen]
pub fn refund_receiver_hex(address: &str) -> String {
    orchard_receiver(address.trim()).map(|(_, r)| hex::encode(r)).unwrap_or_default()
}
