//! The bid page for a sealed bid auction (SPEC §9): the bid's payment (memo version 3 with the bid locked to drand round R), the
//! page's transparent key, and the late ticket: open it, check it completely, sign the coin input. The anchor and the coin are checked
//! against the chain by the page with the helpers at the end; the proof is checked by the separate proof module.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use prost::Message;
use qrcode::{EcLevel, QrCode, render::svg};
use serde::Deserialize;
use zcash_client_backend::proto::service::{BlockId, RawTransaction, TreeState};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

use super::*;
use ll_core::{bid, keys::ContributorKeys, payload::Payload, receiver::{TYPECODE_ORCHARD, orchard_receiver}};
use ll_ticketcheck::late::{self, LateExpect};

fn plain(msg: impl Into<String>) -> JsError {
    JsError::new(&msg.into())
}

fn keys_from(seed_hex: &str) -> Result<ContributorKeys, JsError> {
    ContributorKeys::from_hex(seed_hex).map_err(|_| plain("This device's secret could not be read."))
}

fn sealed_rules(rules_json: &str) -> Result<(Rules, ll_core::sealed::Sealed), JsError> {
    let rules: Rules = serde_json::from_str(rules_json).map_err(|_| plain("The auction details could not be read."))?;
    let s = rules.sealed.clone().ok_or_else(|| plain("This is not a blind bid auction."))?;
    Ok((rules, s))
}

fn coin(zat: u64) -> String {
    ll_core::coin(zat)
}

/// This page's public key (hex), derived from the device's secret: the host's coin pays its address.
#[wasm_bindgen]
pub fn page_key_hex(seed_hex: &str) -> Result<String, JsError> {
    let k = keys_from(seed_hex)?;
    late::page_public_key(&k.page_secret()).map(hex::encode).ok_or_else(|| plain("This secret gives no page key. Please start again with a new secret."))
}

/// Whether the page may take a bid now (chain tip and its block time): before `deadline - ticket_k` (a deposit later than that could
/// get its tickets too late), before the coin cutoff, and while round R and the late ticket block are still safe for the deadline (SPEC
/// §9.2). JSON `{ok, reason}`.
#[wasm_bindgen]
pub fn sealed_bid_window(rules_json: &str, tip: u32, tip_time: f64) -> Result<String, JsError> {
    let (rules, s) = sealed_rules(rules_json)?;
    let last = rules.deadline_height.saturating_sub(rules.ticket_k).min(s.cutoff_height(rules.deadline_height)).min(s.last_deposit(rules.deadline_height));
    let reason = if tip >= last {
        Some(format!("Bidding has closed for new deposits: the last block for one was {last}."))
    } else if rules.network == "regtest" {
        None // a private test chain: its block times are not real times, so the round's timing cannot be judged from them
    } else {
        s.check_timing(&rules.network, rules.deadline_height, tip, tip_time as u64).err().map(|e| format!("This auction's timing is not safe any more ({e}). Do not bid."))
    };
    Ok(serde_json::json!({ "ok": reason.is_none(), "reason": reason, "last_block": last }).to_string())
}

/// The review, M1: whether the round and the late ticket block are no later than the plan gives for this deadline, from the time of the
/// block before the start (the chain as the host saw it). JSON `{ok, reason}`; on a private test chain the test chooses them, so it is ok.
#[wasm_bindgen]
pub fn sealed_plan_check(rules_json: &str, plan_time: f64) -> Result<String, JsError> {
    let (rules, s) = sealed_rules(rules_json)?;
    let reason = if rules.network == "regtest" {
        None
    } else {
        s.check_not_too_late(&rules.network, rules.start_height, rules.deadline_height, plan_time as u64).err().map(|e| format!("This auction's timing is not what its deadline needs ({e})."))
    };
    Ok(serde_json::json!({ "ok": reason.is_none(), "reason": reason }).to_string())
}

/// The payment for one bid: the tranche to pay, and a memo with the refund details sealed for the host and the bid locked to round R.
#[wasm_bindgen]
pub fn sealed_bid_payment(rules_json: &str, seed_hex: &str, refund_address: &str, tranche_zat: f64, bid_zat: f64) -> Result<String, JsError> {
    let (rules, s) = sealed_rules(rules_json)?;
    let whole = |v: f64| v.is_finite() && v >= 0.0 && v.fract() == 0.0;
    if !whole(tranche_zat) || !whole(bid_zat) {
        return Err(plain("Please enter a valid amount."));
    }
    let (tranche, bid_zat) = (tranche_zat as u64, bid_zat as u64);
    if !s.tranches_zat.contains(&tranche) {
        return Err(plain("Please choose one of the auction's deposit sizes."));
    }
    let fee = rules.refund_fee_zat;
    if bid_zat + fee > tranche {
        return Err(plain(format!("With this deposit the highest bid is {} (the deposit minus the {} refund fee). Choose a larger deposit.", coin(tranche - fee), coin(fee))));
    }
    if rules.reserve_zat.is_some_and(|r| bid_zat < r) {
        return Err(plain(format!("The lowest bid that counts is {}.", coin(rules.reserve_zat.unwrap_or(0)))));
    }
    let pay_to = rules.pay_to.clone().ok_or_else(|| plain("This auction has not published a payment address."))?;
    let pay_to = ll_core::receiver::to_standard(&pay_to).unwrap_or(pay_to);
    let k = keys_from(seed_hex)?;
    // the owner's report of 21 Oct 2026: an address for the other network is refused, never paid to
    if let Some(m) = ll_core::receiver::network_mismatch(&rules.network, refund_address) {
        return Err(plain(m));
    }
    let (_, receiver) = orchard_receiver(refund_address.trim()).map_err(|_| plain("That doesn't look like a valid refund address."))?;
    if !ll_core::receiver::valid_orchard_receiver(&receiver) {
        return Err(plain("That doesn't look like a valid refund address."));
    }
    let rid = rules.id().map_err(|_| plain("The auction details are not valid."))?;
    let payload = Payload {
        rules_id: rid,
        sign_pubkey: k.signing_key().verifying_key().to_bytes(),
        enc_pubkey: *k.encryption_key().public_key().as_bytes(),
        refund_typecode: TYPECODE_ORCHARD,
        refund_receiver: receiver,
        amount_zat: Some(tranche),
    };
    let pk = ll_core::hex32(&rules.payload_pubkey).map_err(|_| plain("The auction details are not valid."))?;
    let sealed = ll_core::payload::sealed_bytes(&payload.to_memo(&pk, &k.memo_ephemeral_key()).map_err(|_| plain("The payment message could not be prepared."))?)
        .ok_or_else(|| plain("The payment message could not be prepared."))?;
    let page_key = late::page_public_key(&k.page_secret()).ok_or_else(|| plain("This secret gives no page key. Please start again with a new secret."))?;
    // the review, M4: an auction with the long tag takes the bound kind of memo (a 16 byte tag made with the locked key)
    let memo = if s.long_tag {
        let (lock, bound) = bid::lock_bid_bound(bid_zat, &rid, &sealed, &page_key, tranche, s.drand_round).map_err(|_| plain("The bid could not be locked."))?;
        bid::BidMemo { sealed, lock, page_key, bound: Some(bound) }.to_text()
    } else {
        let tag = bid::tag(&rid, &sealed, &page_key, tranche);
        let lock = bid::lock_bid(bid_zat, &tag, s.drand_round).map_err(|_| plain("The bid could not be locked."))?;
        bid::BidMemo { sealed, lock, page_key, bound: None }.to_text()
    };
    if !bid::is_bid_memo(&memo) || memo.len() > bid::MEMO_MAX {
        return Err(plain("The payment message is not valid, so no payment was created."));
    }
    let uri = format!("zcash:{pay_to}?amount={}&memo={}", coin(tranche), URL_SAFE_NO_PAD.encode(memo.as_bytes()));
    let qr = QrCode::with_error_correction_level(uri.as_bytes(), EcLevel::L).map_err(|_| plain("The payment code is too large to draw. Please use the copy buttons instead."))?;
    let svg = qr.render::<svg::Color>().min_dimensions(320, 320).quiet_zone(true).dark_color(svg::Color("#000")).light_color(svg::Color("#fff")).build();
    Ok(serde_json::json!({
        "memo": memo, "uri": uri, "qr_svg": svg, "pay_to": pay_to, "page_key": hex::encode(page_key),
        "amount_zat": tranche, "amount": coin(tranche), "bid_zat": bid_zat, "refund_zat": tranche - fee, "refund": coin(tranche - fee),
        "round": s.drand_round, "cutoff": s.cutoff_height(rules.deadline_height), "claim_after": s.claim_after,
    })
    .to_string())
}

/// The bid page's live check of the refund address box: "" when it can take a refund on this network, else one short line (another network,
/// or not a shielded address of this network). An empty box gives "" too: the page shows its hint.
#[wasm_bindgen]
pub fn sealed_refund_problem(network: &str, address: &str) -> String {
    let a = address.trim();
    if a.is_empty() {
        return String::new();
    }
    if let Some(m) = ll_core::receiver::network_mismatch(network, a) {
        return m.into();
    }
    let prefix = match network { "main" => "u1", "test" => "utest1", _ => "uregtest1" };
    match orchard_receiver(a) {
        Ok((_, raw)) if ll_core::receiver::valid_orchard_receiver(&raw) => String::new(),
        _ => format!("This must be a shielded address starting with {prefix}."),
    }
}

/// What the page expects of its late ticket (JSON from the page).
#[derive(Deserialize)]
struct Expect {
    deposit_nf: String,
    coin_txid: String,
    coin_index: u32,
    coin_value_zat: u64,
    lock_time: u32,
    refund_address: String,
    refund_zat: u64,
    /// The deposit's amount (L1 of the second review).
    deposit_zat: u64,
    /// The network version the chain server reports now (hex), H5.
    #[serde(default)]
    current_branch: Option<String>,
}

fn expect(seed_hex: &str, expect_json: &str) -> Result<LateExpect, JsError> {
    let e: Expect = serde_json::from_str(expect_json).map_err(|_| plain("The late ticket check could not start."))?;
    let k = keys_from(seed_hex)?;
    let (_, refund_receiver) = orchard_receiver(e.refund_address.trim()).map_err(|_| plain("The refund address is not valid."))?;
    Ok(LateExpect {
        deposit_nf: ll_core::hex32(&e.deposit_nf).map_err(|_| plain("bad deposit"))?,
        coin_txid: e.coin_txid,
        coin_index: e.coin_index,
        coin_value_zat: e.coin_value_zat,
        page_key: late::page_public_key(&k.page_secret()).ok_or_else(|| plain("This secret gives no page key."))?,
        lock_time: e.lock_time,
        refund_receiver,
        refund_zat: e.refund_zat,
        deposit_zat: e.deposit_zat,
        current_branch: e.current_branch.as_deref().and_then(|b| u32::from_str_radix(b, 16).ok()),
    })
}

/// Opens the late ticket sealed in a coin entry's blob: JSON `{raw_hex, ovk_hex, anchor_height, txid}`. It must be the ticket the
/// signed list names.
#[wasm_bindgen]
pub fn open_late(seed_hex: &str, entry_json: &str, blob: &[u8]) -> Result<String, JsError> {
    let entry: Entry = serde_json::from_str(entry_json).map_err(|_| plain("The coin's list entry could not be read."))?;
    if entry.coin.is_none() || Some(ll_core::ledger::blob_hash(blob)) != entry.blob_hash {
        return Err(plain("The late ticket does not match what the auction signed."));
    }
    let opened = keys_from(seed_hex)?.encryption_key().unseal(blob).map_err(|_| plain("This late ticket was not made for this device's secret."))?;
    let part = ll_core::ticket_blob::LatePart::decode(&opened).map_err(|_| plain("The late ticket is damaged."))?;
    let tx = Transaction::read(&part.raw[..], BranchId::Nu7).map_err(|_| plain("The late ticket is damaged."))?;
    let txid = tx.txid().to_string();
    if entry.late.as_deref() != Some(txid.as_str()) {
        return Err(plain("The late ticket is not the one the auction's list names."));
    }
    Ok(serde_json::json!({ "raw_hex": hex::encode(&part.raw), "ovk_hex": hex::encode(part.ovk), "anchor_height": part.anchor_height, "txid": txid }).to_string())
}

/// Checks the host's part of the late ticket (all but the proof and the anchor's place in the chain): JSON `{txid, anchor_hex}`, or a
/// plain reason not to sign.
#[wasm_bindgen]
pub fn check_late(seed_hex: &str, raw_hex: &str, ovk_hex: &str, expect_json: &str) -> Result<String, JsError> {
    let raw = hex::decode(raw_hex).map_err(|_| plain("The late ticket is damaged."))?;
    let ovk = ll_core::hex32(ovk_hex).map_err(|_| plain("The late ticket is damaged."))?;
    let (txid, anchor) = late::check(&raw, BranchId::Nu7, &ovk, &expect(seed_hex, expect_json)?).map_err(|m| plain(format!("The late ticket is not right: {m}. Do not rely on it; take your money back with your early ticket before the deadline.")))?;
    Ok(serde_json::json!({ "txid": txid, "anchor_hex": hex::encode(anchor) }).to_string())
}

/// Signs the coin input of a checked late ticket: the finished transaction (hex), to keep and to send after the late ticket block.
#[wasm_bindgen]
pub fn sign_late(seed_hex: &str, raw_hex: &str, expect_json: &str) -> Result<String, JsError> {
    let raw = hex::decode(raw_hex).map_err(|_| plain("The late ticket is damaged."))?;
    let k = keys_from(seed_hex)?;
    late::sign(&raw, BranchId::Nu7, &expect(seed_hex, expect_json)?, &k.page_secret()).map(hex::encode).map_err(|m| plain(format!("The late ticket could not be signed: {m}")))
}

/// A `GetTreeState` request for a height (protobuf bytes).
#[wasm_bindgen]
pub fn tree_state_request(height: u32) -> Vec<u8> {
    BlockId { height: u64::from(height), hash: vec![] }.encode_to_vec()
}

/// The Ironwood note tree root (hex) of a `GetTreeState` answer: the late ticket's anchor must equal it at the height the host stated.
#[wasm_bindgen]
pub fn ironwood_root(tree_state: &[u8]) -> Result<String, JsError> {
    let ts = TreeState::decode(tree_state).map_err(|_| plain("The server's answer could not be read."))?;
    ironwood_root_hex(&ts.ironwood_tree)
}

/// The root (hex) of an Ironwood note tree given as hex, as servers and nodes print it.
#[wasm_bindgen]
pub fn ironwood_root_hex(tree_hex: &str) -> Result<String, JsError> {
    let ts = TreeState { ironwood_tree: tree_hex.into(), ..Default::default() };
    let tree = ts.ironwood_tree().map_err(|_| plain("The note tree could not be read."))?;
    Ok(hex::encode(tree.root().to_bytes()))
}

/// SPEC §9.1, open_payouts: the refund the host signed with the deposit, sealed to this page with the early ticket (a version 3 blob): `{raw_hex, txid,
/// opening}` for the page to check like a ticket, or `null` for an auction made before open payouts. Refused when it is not the refund the
/// list names (its id).
#[wasm_bindgen]
pub fn open_signed_refund(seed_hex: &str, entry_json: &str, blob: &[u8]) -> Result<String, JsError> {
    let entry: ll_core::ledger::Entry = serde_json::from_str(entry_json).map_err(|_| plain("The deposit's list entry could not be read."))?;
    if Some(ll_core::ledger::blob_hash(blob)) != entry.blob_hash {
        return Err(plain("The tickets do not match what the auction signed."));
    }
    let plain_blob = keys_from(seed_hex)?.encryption_key().unseal(blob).map_err(|_| plain("These tickets were not made for this page."))?;
    let Some(t) = ll_core::ticket_blob::decode_sealed(&plain_blob).map_err(|_| plain("The tickets are damaged."))? else { return Ok("null".into()) };
    let tx = Transaction::read(&t.refund[..], BranchId::Nu7).map_err(|_| plain("The signed refund could not be read."))?;
    let txid = tx.txid().to_string();
    if Some(txid.as_str()) != entry.refund.as_deref() {
        return Err(plain("The signed refund is not the one the list names."));
    }
    Ok(serde_json::json!({ "raw_hex": hex::encode(&t.refund), "txid": txid, "opening": t.refund_opening, "branch_id": format!("{:08x}", u32::from(tx.consensus_branch_id())) }).to_string())
}

/// SPEC §9.1, open_payouts: the outgoing viewing key of the host's payment of `kind` ("refund", "change", "return") to this page's person for the payment or
/// deposit `nf`, worked out from this page's own secret and the auction's payload key.
#[wasm_bindgen]
pub fn payout_ovk(seed_hex: &str, payload_pubkey_hex: &str, nf: &str, kind: &str) -> Result<String, JsError> {
    let sk = keys_from(seed_hex)?.encryption_key().to_bytes();
    let pk = ll_core::hex32(payload_pubkey_hex).map_err(|_| plain("The auction's payload key could not be read."))?;
    Ok(hex::encode(ll_core::payout::payment_ovk(&ll_core::payout::shared_secret(&sk, &pk), nf, kind)))
}

/// SPEC §9.1, open_payouts: the outputs a payment's outgoing viewing key opens, from a `GetTransaction` answer: `{height, outputs: [{receiver_hex,
/// value_zat}]}`.
#[wasm_bindgen]
pub fn payout_outputs(raw_tx: &[u8], ovk_hex: &str) -> Result<String, JsError> {
    let raw = RawTransaction::decode(raw_tx).map_err(|_| plain("The server's answer could not be read."))?;
    let ovk = ll_core::hex32(ovk_hex).map_err(|_| plain("bad key"))?;
    let outputs = ll_ticketcheck::recover_outputs(&raw.data, &ovk).map_err(plain)?;
    let height = (raw.height > 0 && raw.height < u64::from(u32::MAX)).then_some(raw.height);
    Ok(serde_json::json!({ "height": height, "outputs": outputs.into_iter().map(|(r, v)| serde_json::json!({ "receiver_hex": r, "value_zat": v })).collect::<Vec<_>>() }).to_string())
}

/// The block a transaction was mined in, from a `GetTransaction` answer (protobuf bytes), or `null` while it is not mined.
#[wasm_bindgen]
pub fn tx_mined_height(raw_tx: &[u8]) -> Result<String, JsError> {
    let raw = RawTransaction::decode(raw_tx).map_err(|_| plain("The server's answer could not be read."))?;
    let height = (raw.height > 0 && raw.height < u64::from(u32::MAX)).then_some(raw.height);
    Ok(serde_json::json!(height).to_string())
}

/// The hash of a payment's memo as the host writes it on a `late_return` entry (`blob_hash`), so that the page that made the payment can find
/// its own return on the list.
#[wasm_bindgen]
pub fn memo_hash(memo: &str) -> String {
    ll_core::ledger::blob_hash(memo.as_bytes())
}

/// The page's coin in a coin transaction (`GetTransaction` answer, protobuf bytes): JSON `{index, value_zat, height}`, or `null` when it
/// does not pay this page's address.
#[wasm_bindgen]
pub fn find_coin(raw_tx: &[u8], page_key_hex: &str) -> Result<String, JsError> {
    let raw = RawTransaction::decode(raw_tx).map_err(|_| plain("The server's answer could not be read."))?;
    let tx = Transaction::read(&raw.data[..], BranchId::Nu7).map_err(|_| plain("The coin's transaction could not be read."))?;
    let key: [u8; 33] = hex::decode(page_key_hex).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| plain("bad page key"))?;
    let want = hex::decode(ll_core::sealed_recount::p2pkh_script_hex(&key)).map_err(|_| plain("bad page key"))?;
    let found = tx.transparent_bundle().and_then(|b| {
        b.vout.iter().enumerate().find_map(|(i, o)| {
            let mut w = vec![];
            o.write(&mut w).ok()?;
            (w.get(9..) == Some(&want[..])).then(|| (i, o.value().into_u64()))
        })
    });
    let height = (raw.height > 0 && raw.height < u64::from(u32::MAX)).then_some(raw.height);
    Ok(match found {
        Some((i, v)) => serde_json::json!({ "index": i, "value_zat": v, "height": height }),
        None => serde_json::Value::Null,
    }
    .to_string())
}
