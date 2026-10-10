//! Verifies the Halo 2 proof of a refund ticket (SPEC §3.1, level 3). Built for the browser only and loaded on request.
use wasm_bindgen::prelude::*;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

#[wasm_bindgen]
pub struct Checker {
    vk: orchard::circuit::VerifyingKey,
}

#[wasm_bindgen]
impl Checker {
    /// Builds the verifying key. This is the slow part (seconds on a computer, about a minute on a slow phone) and happens once per load.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Checker {
        Checker { vk: orchard::circuit::VerifyingKey::build(orchard::circuit::OrchardCircuitVersion::PostNu6_3) }
    }

    /// Whether the Ironwood proof of the raw transaction (hex) verifies. `branch` is the consensus branch id the ticket was built for (hex).
    pub fn verify(&self, raw_hex: &str, branch: &str) -> Result<bool, JsError> {
        let raw = hex::decode(raw_hex).map_err(|e| JsError::new(&e.to_string()))?;
        let branch = u32::from_str_radix(branch, 16).ok().and_then(|b| BranchId::try_from(b).ok()).ok_or_else(|| JsError::new("unknown network version"))?;
        let tx = Transaction::read(&raw[..], branch).map_err(|e| JsError::new(&e.to_string()))?;
        let b = tx.ironwood_bundle().ok_or_else(|| JsError::new("the ticket has no Ironwood part"))?;
        Ok(b.verify_proof(&self.vk).is_ok())
    }
}
