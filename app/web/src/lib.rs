//! Recount in the browser (spike S4). JavaScript fetches compact blocks and full
//! transactions over gRPC-web; this module trial-decrypts them with the campaign's viewing
//! key, tracks spends by nullifier, and runs the same `ll-core` recount as the command line.

use std::collections::HashMap;

use prost::Message;
use wasm_bindgen::prelude::*;
use zcash_client_backend::{
    proto::{
        compact_formats::CompactBlock,
        service::{BlockId, BlockRange, RawTransaction, TxFilter},
    },
    scanning::{ScanningKeys, SpendIdentifiers, scan_block},
};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

use ll_core::{
    keys::ContributorKeys,
    ledger::{Entry, blob_hash, check_chain, verifying_key},
    payload::Payload,
    receiver::{TYPECODE_ORCHARD, network_type, orchard_receiver},
    recount::{ChainNote, Challenge, DisclosureCheck, Extra, Spend, TxFacts, recount, recount_with, render},
    rules::Rules,
};

mod contribute;

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Builds a GetBlockRange request (inclusive range).
#[wasm_bindgen]
pub fn block_range_request(start: u32, end: u32) -> Vec<u8> {
    BlockRange {
        start: Some(BlockId { height: start.into(), hash: vec![] }),
        end: Some(BlockId { height: end.into(), hash: vec![] }),
        ..Default::default()
    }
    .encode_to_vec()
}

/// Builds a GetTransaction request for a txid in display order.
#[wasm_bindgen]
pub fn tx_filter_request(txid: &str) -> Result<Vec<u8>, JsError> {
    let mut hash = hex::decode(txid).map_err(js_err)?;
    hash.reverse();
    Ok(TxFilter { hash, ..Default::default() }.encode_to_vec())
}

/// Watches compact blocks for the spending of given coins by their nullifiers. Needs no viewing key: compact blocks
/// carry every action's nullifier. Used by the contribute page to see whether (and by which transaction, in which
/// block) a contributor's coin was spent.
#[wasm_bindgen]
pub struct SpendWatch {
    targets: std::collections::HashSet<String>,
    found: HashMap<String, (String, u32)>,
    last_height: u32,
}

#[wasm_bindgen]
impl SpendWatch {
    /// `nfs_json`: a JSON array of nullifiers in transaction byte order (lowercase hex).
    #[wasm_bindgen(constructor)]
    pub fn new(nfs_json: &str) -> Result<SpendWatch, JsError> {
        let v: Vec<String> = serde_json::from_str(nfs_json).map_err(js_err)?;
        Ok(SpendWatch { targets: v.into_iter().map(|x| x.to_lowercase()).collect(), found: HashMap::new(), last_height: 0 })
    }

    pub fn scan_block(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let block = CompactBlock::decode(bytes).map_err(js_err)?;
        let height = block.height as u32;
        for tx in &block.vtx {
            let mut txid = tx.txid.clone();
            txid.reverse();
            let txid = hex::encode(txid);
            for a in tx.ironwood_actions.iter() {
                let nf = hex::encode(&a.nullifier);
                if self.targets.contains(&nf) && !self.found.contains_key(&nf) {
                    self.found.insert(nf, (txid.clone(), height));
                }
            }
        }
        self.last_height = height;
        Ok(())
    }

    /// `{"txid": ..., "height": ...}` if this nullifier was seen spent, else an empty string.
    pub fn spent(&self, nf: &str) -> String {
        self.found.get(&nf.to_lowercase()).map(|(t, h)| serde_json::json!({ "txid": t, "height": h }).to_string()).unwrap_or_default()
    }

    pub fn last_height(&self) -> u32 {
        self.last_height
    }
}

#[wasm_bindgen]
pub struct Recount {
    params: Network,
    ufvk: UnifiedFullViewingKey,
    keys: ScanningKeys<u32, (u32, zip32::Scope)>,
    spend_ids: SpendIdentifiers<u32>,
    notes: Vec<ChainNote>,
    by_nf: HashMap<String, usize>,
    /// Full transactions seen so far (raw bytes by txid) and what they showed.
    raw_txs: HashMap<String, Vec<u8>>,
    facts: Vec<TxFacts>,
    last_height: u32,
    blocks: u32,
    actions: u64,
}

#[wasm_bindgen]
impl Recount {
    /// `network`: "test" or "main"; `ufvk`: the campaign's viewing key (any encoding).
    #[wasm_bindgen(constructor)]
    pub fn new(network: &str, ufvk: &str) -> Result<Recount, JsError> {
        let params = match network {
            "test" => Network::TestNetwork,
            "main" => Network::MainNetwork,
            n => return Err(js_err(format!("unsupported network {n}"))),
        };
        let ufvk = UnifiedFullViewingKey::decode(&params, ufvk).map_err(js_err)?;
        let keys = ScanningKeys::from_account_ufvks([(0u32, ufvk.clone())]);
        Ok(Recount {
            params,
            ufvk,
            keys,
            spend_ids: SpendIdentifiers::empty(),
            notes: vec![],
            by_nf: HashMap::new(),
            raw_txs: HashMap::new(),
            facts: vec![],
            last_height: 0,
            blocks: 0,
            actions: 0,
        })
    }

    /// Scans one CompactBlock (protobuf bytes). Blocks must be given in height order.
    pub fn scan_block(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        let block = CompactBlock::decode(bytes).map_err(js_err)?;
        self.actions += block.vtx.iter().map(|t| (t.ironwood_actions.len() + t.actions.len()) as u64).sum::<u64>();
        let scanned = scan_block::<_, _, _, std::convert::Infallible>(&self.params, block, &self.keys, &self.spend_ids, None)
            .map_err(|e| js_err(format!("{e:?}")))?;
        let height = u32::from(scanned.height());
        let mut found = 0;
        for tx in scanned.transactions() {
            let txid = tx.txid().to_string();
            for out in tx.ironwood_outputs() {
                let nf = out.nf().map(|n| hex::encode(n.to_bytes()));
                if let Some(nf) = &nf {
                    self.by_nf.insert(nf.clone(), self.notes.len());
                }
                self.notes.push(ChainNote {
                    txid: txid.clone(),
                    action: out.index() as u32,
                    value_zat: out.note().0.value().inner(),
                    nf,
                    height: Some(height),
                    tx_index: Some(u32::from(tx.block_index())),
                    memo_text: None,
                    is_change: out.is_change(),
                    spent_by: None,
                });
                found += 1;
            }
            for spend in tx.ironwood_spends() {
                let nf = hex::encode(spend.nf().to_bytes());
                if let Some(&i) = self.by_nf.get(&nf) {
                    self.notes[i].spent_by = Some(Spend { txid: txid.clone(), height: Some(height) });
                }
            }
        }
        self.spend_ids.update_with(&scanned);
        self.last_height = height;
        self.blocks += 1;
        Ok(found)
    }

    /// Txids whose full transaction is needed (received, non-change notes: their memos).
    pub fn txids_needing_memos(&self) -> Vec<String> {
        let mut t: Vec<String> = self
            .notes
            .iter()
            .filter(|n| !n.is_change && n.memo_text.is_none())
            .map(|n| n.txid.clone())
            .collect();
        t.dedup();
        t
    }

    /// Txids of transactions that spent one of our notes (settlements and tickets): their full data
    /// shows the fee, the number of outputs and what a winner's key can open.
    pub fn txids_spending_notes(&self) -> Vec<String> {
        let mut t: Vec<String> = self.notes.iter().filter_map(|n| n.spent_by.as_ref().map(|s| s.txid.clone())).collect();
        t.sort();
        t.dedup();
        t
    }

    /// The notes found, as JSON (the treasury's notes are passed to `report_json` this way).
    pub fn notes_for_report(&self) -> String {
        serde_json::to_string(&self.notes).unwrap_or_default()
    }

    /// Decrypts a full transaction (RawTransaction protobuf) and records memos of our notes.
    pub fn add_raw_transaction(&mut self, bytes: &[u8]) -> Result<u32, JsError> {
        let raw = RawTransaction::decode(bytes).map_err(js_err)?;
        let height = BlockHeight::from_u32(raw.height as u32);
        let tx = Transaction::read(&raw.data[..], BranchId::for_height(&self.params, height)).map_err(js_err)?;
        let txid = tx.txid().to_string();
        if !self.raw_txs.contains_key(&txid) {
            let money = |z: zcash_protocol::value::ZatBalance| i64::from(z);
            let fee_zat = money(tx.sapling_value_balance())
                + tx.orchard_bundle().map_or(0, |b| money(*b.value_balance()))
                + tx.ironwood_bundle().map_or(0, |b| money(*b.value_balance()));
            self.facts.push(TxFacts {
                txid: txid.clone(),
                fee_zat,
                ironwood_actions: tx.ironwood_bundle().map_or(0, |b| b.actions().len()),
                has_orchard: tx.orchard_bundle().is_some(),
                has_sapling: tx.sapling_bundle().is_some(),
                has_transparent: tx.transparent_bundle().is_some(),
            });
            self.raw_txs.insert(txid.clone(), raw.data.clone());
        }
        let ufvks = HashMap::from([(0u32, self.ufvk.clone())]);
        let dec = zcash_client_backend::decrypt_transaction(&self.params, Some(height), None, &tx, &ufvks);
        let mut matched = 0;
        for out in dec.ironwood_outputs() {
            if let Some(n) = self.notes.iter_mut().find(|n| n.txid == txid && n.action as usize == out.index()) {
                n.memo_text = ll_core::memo_text(out.memo().as_slice());
                matched += 1;
            }
        }
        Ok(matched)
    }

    /// Runs the recount and returns the same text as `ll-recount`.
    pub fn report(&self, rules_json: &str, rules_id: &str, ledger_json: &str, challenges_json: &str) -> Result<String, JsError> {
        let rules: Rules = serde_json::from_str(rules_json).map_err(js_err)?;
        let ledger: Vec<Entry> = serde_json::from_str(ledger_json).map_err(js_err)?;
        let challenges: Vec<Challenge> = serde_json::from_str(challenges_json).map_err(js_err)?;
        let r = recount(&rules, rules_id, &ledger, &self.notes, &challenges, self.last_height, true);
        Ok(render(&r, &rules))
    }


    /// The recount as structured JSON for the recount page: each rule with PASS/FAIL and its evidence,
    /// the totals, warnings, and a fingerprint of everything the scan found (so two servers can be compared).
    pub fn report_json(&self, rules_json: &str, rules_id: &str, ledger_json: &str, challenges_json: &str, treasury_notes_json: &str) -> Result<String, JsError> {
        let rules: Rules = serde_json::from_str(rules_json).map_err(js_err)?;
        let ledger: Vec<Entry> = serde_json::from_str(ledger_json).map_err(js_err)?;
        let challenges: Vec<Challenge> = serde_json::from_str(challenges_json).map_err(js_err)?;
        let treasury_notes: Vec<ChainNote> = if treasury_notes_json.is_empty() { vec![] } else { serde_json::from_str(treasury_notes_json).map_err(js_err)? };
        let extra = Extra {
            checks: self.disclosure_checks(&rules, rules_id, &challenges),
            treasury_notes,
            tx_facts: self.facts.clone(),
        };
        let r = recount_with(&rules, rules_id, &ledger, &self.notes, &challenges, self.last_height, true, &extra);
        let t = &r.totals;
        let auction = r.auction.as_ref().map(|a| serde_json::json!({
            "price_zat": a.price_zat, "reserve_zat": a.reserve_zat, "winners": a.winners, "settled": a.settled, "awaiting": a.awaiting,
            "defaulted": a.defaulted, "settle_by": rules.settle_by(), "settle_window": rules.settle_by() - rules.deadline_height, "treasury_total_zat": a.treasury_total_zat, "excess_zat": a.excess_zat,
            "proofs_ok": a.proofs_ok, "complaints": a.complaints,
        }));
        let mut fp_lines: Vec<String> = extra.treasury_notes.iter().map(|n| format!("T {}:{}|{}|{:?}", n.txid, n.action, n.value_zat, n.height)).collect();
        fp_lines.extend(self.facts.iter().map(|f| format!("F {}|{}|{}|{}{}{}", f.txid, f.fee_zat, f.ironwood_actions, f.has_orchard, f.has_sapling, f.has_transparent)));
        fp_lines.sort();
        let fingerprint = hex::encode(ll_core::hash(b"LL fingerprint2", format!("{}\n{}", self.fingerprint(), fp_lines.join("\n")).as_bytes()));
        Ok(serde_json::json!({
            "tip": r.tip, "phase": r.phase, "all_pass": r.all_pass(),
            "rules": r.results.iter().map(|x| serde_json::json!({"id": x.id, "title": x.title, "pass": x.pass, "details": x.details})).collect::<Vec<_>>(),
            "totals": {
                "raised_zat": t.raised_zat, "contributions": t.contributions, "withdrawn_zat": t.withdrawn_zat,
                "refunded_zat": t.refunded_zat, "kept_zat": t.kept_zat, "pending_zat": t.pending_zat,
                "donations_zat": t.donations_zat, "donations": t.donations,
            },
            "totals_visible": r.goal_met.is_some() || r.winners.is_some(),
            "goal_zat": rules.goal_zat, "goal_met": r.goal_met, "winners": r.winners, "warnings": r.warnings,
            "auction": auction,
            "fingerprint": fingerprint,
        })
        .to_string())
    }

    /// For each uniform-auction winner who published a viewing key (SPEC §8.5): does it derive the refund
    /// address inside the winner's own payload, and which outputs of the settlement transaction does it open?
    fn disclosure_checks(&self, rules: &Rules, rules_id: &str, challenges: &[Challenge]) -> Vec<DisclosureCheck> {
        use orchard::keys::{IncomingViewingKey, Scope};
        let Ok(payload_pk) = ll_core::hex32(&rules.payload_pubkey) else { return vec![] };
        let mut out = vec![];
        for c in challenges.iter().filter(|c| c.uivk.is_some()) {
            let mut chk = DisclosureCheck { txid: c.txid.clone(), action: c.action, key_matches_refund: false, delivered: vec![], error: None };
            let result = (|| -> Result<(), String> {
                let n = self.notes.iter().find(|n| n.txid == c.txid && n.action == c.action).ok_or("no such payment")?;
                let memo = n.memo_text.as_deref().ok_or("the payment's message was not read")?;
                let esk = crypto_box::SecretKey::from(ll_core::hex32(&c.eph_sk).map_err(|e| e.to_string())?);
                let p = Payload::open_challenged(memo, &payload_pk, &esk).map_err(|_| "the secret does not open the payload".to_string())?;
                if hex::encode(p.rules_id) != rules_id {
                    return Err("the payload belongs to another campaign".into());
                }
                // the key: an incoming viewing key (uivk...) or a full viewing key (uview.../uvf...)
                let text = c.uivk.as_deref().unwrap_or_default();
                let ivk: IncomingViewingKey = match zcash_keys::keys::UnifiedIncomingViewingKey::decode(&self.params, text) {
                    Ok(u) => u.orchard().clone().ok_or("the viewing key has no Orchard/Ironwood part")?,
                    Err(_) => {
                        let f = UnifiedFullViewingKey::decode(&self.params, text).map_err(|_| "not a viewing key".to_string())?;
                        f.orchard().ok_or("the viewing key has no Orchard/Ironwood part")?.to_ivk(Scope::External)
                    }
                };
                let addr = Option::from(orchard::Address::from_raw_address_bytes(&p.refund_receiver)).ok_or("bad refund address in the payload")?;
                chk.key_matches_refund = ivk.diversifier_index(&addr).is_some();
                if !chk.key_matches_refund {
                    return Ok(());
                }
                let settle_txid = n.spent_by.as_ref().map(|s| s.txid.clone()).ok_or("the note has not been spent yet")?;
                let raw = self.raw_txs.get(&settle_txid).ok_or("the settlement transaction was not fetched")?;
                let height = BlockHeight::from_u32(0);
                let tx = Transaction::read(&raw[..], BranchId::for_height(&self.params, height)).map_err(|e| e.to_string())?;
                if let Some(b) = tx.ironwood_bundle() {
                    for i in 0..b.actions().len() {
                        if let Some((note, _, _)) = b.decrypt_output_with_key(i, &ivk) {
                            chk.delivered.push(note.value().inner());
                        }
                    }
                }
                Ok(())
            })();
            if let Err(e) = result {
                chk.error = Some(e);
            }
            out.push(chk);
        }
        out
    }

    /// A hash of every payment found (position, amount, nullifier, memo, who spent it): equal on two
    /// servers exactly when both showed the same chain data for the scanned range.
    pub fn fingerprint(&self) -> String {
        let mut lines: Vec<String> = self
            .notes
            .iter()
            .map(|n| format!("{}:{}|{}|{:?}|{:?}|{}|{:?}|{:?}", n.txid, n.action, n.value_zat, n.nf, n.height, n.is_change, n.memo_text, n.spent_by.as_ref().map(|s| (&s.txid, s.height))))
            .collect();
        lines.sort();
        hex::encode(ll_core::hash(b"LL fingerprint ", lines.join("\n").as_bytes()))
    }

    /// The payment (`txid:action`) whose memo is exactly `memo`, if it has been seen (needs the
    /// memos fetched with `add_raw_transaction`). Lets a contributor find their own payment.
    pub fn find_payment(&self, memo: &str) -> Option<String> {
        self.notes
            .iter()
            .find(|n| !n.is_change && n.memo_text.as_deref() == Some(memo))
            .map(|n| format!("{}:{}", n.txid, n.action))
    }

    /// The amount (zatoshis) of the payment whose memo is exactly `memo`, if it has been seen (see `find_payment`).
    pub fn find_payment_value(&self, memo: &str) -> Option<f64> {
        self.notes.iter().find(|n| !n.is_change && n.memo_text.as_deref() == Some(memo)).map(|n| n.value_zat as f64)
    }

    /// Diagnostics: notes found so far, as JSON.
    pub fn notes_json(&self) -> String {
        serde_json::to_string(
            &self
                .notes
                .iter()
                .map(|n| {
                    serde_json::json!({
                        "txid": n.txid, "action": n.action, "value": n.value_zat, "nf": n.nf,
                        "height": n.height, "change": n.is_change, "memo": n.memo_text.as_deref().map(|m| m.chars().take(12).collect::<String>()),
                        "spent_by": n.spent_by.as_ref().map(|s| s.txid.clone()),
                    })
                })
                .collect::<Vec<_>>(),
        )
        .unwrap_or_default()
    }

    pub fn last_height(&self) -> u32 {
        self.last_height
    }
    pub fn blocks_scanned(&self) -> u32 {
        self.blocks
    }
    pub fn actions_seen(&self) -> f64 {
        self.actions as f64
    }
}
