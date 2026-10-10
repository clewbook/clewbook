use wasm_bindgen::prelude::*;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

#[wasm_bindgen]
pub struct Checker {
    vk: orchard::circuit::VerifyingKey,
}

#[wasm_bindgen]
impl Checker {
    /// Builds the verifying key (the one-time cost per page load).
    #[wasm_bindgen(constructor)]
    pub fn new() -> Checker {
        Checker { vk: orchard::circuit::VerifyingKey::build(orchard::circuit::OrchardCircuitVersion::PostNu6_3) }
    }

    /// Verifies the Ironwood proof of a raw transaction (hex). Returns true if it verifies.
    pub fn verify(&self, raw_hex: &str) -> Result<bool, JsError> {
        let raw = hex::decode(raw_hex).map_err(|e| JsError::new(&e.to_string()))?;
        let tx = Transaction::read(&raw[..], BranchId::Nu7).map_err(|e| JsError::new(&e.to_string()))?;
        let b = tx.ironwood_bundle().ok_or_else(|| JsError::new("no Ironwood bundle"))?;
        Ok(b.verify_proof(&self.vk).is_ok())
    }
}
