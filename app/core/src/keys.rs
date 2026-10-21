//! Contributor keys (SPEC §2) and campaign keys (SPEC §1).

use anyhow::Result;
use rand_core::OsRng;
use ed25519_dalek::SigningKey;
use rand_core::RngCore;
use serde::{Deserialize, Serialize};

use crate::{hash, hex32};

/// One random seed per contribution; the signing and encryption keys are derived from it
/// independently, so neither key is ever used for both jobs.
pub struct ContributorKeys {
    pub seed: [u8; 32],
}

impl ContributorKeys {
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        Self { seed }
    }

    pub fn from_hex(s: &str) -> Result<Self> {
        Ok(Self { seed: hex32(s.trim())? })
    }

    pub fn signing_key(&self) -> SigningKey {
        SigningKey::from_bytes(&hash(b"ledgerlab_sign", &self.seed))
    }

    pub fn encryption_key(&self) -> crypto_box::SecretKey {
        crypto_box::SecretKey::from(hash(b"ledgerlab_enc", &self.seed))
    }

    /// The one-time key that seals this contribution's memo. Derived from the seed (not
    /// random) so the contributor can always recover it to challenge a false reject.
    pub fn memo_ephemeral_key(&self) -> crypto_box::SecretKey {
        crypto_box::SecretKey::from(hash(b"ledgerlab_eph", &self.seed))
    }

    /// Sealed bid auctions: the 32 bytes of the page's transparent secret key (secp256k1), derived from the seed so the backup holds it.
    /// The host's coin pays this key's address, and only this key can sign the coin into the late ticket.
    pub fn page_secret(&self) -> [u8; 32] {
        hash(b"ledgerlab_page", &self.seed)
    }
}

/// The campaign's secret keys: one signs ledger entries, the other opens memo payloads.
#[derive(Serialize, Deserialize)]
pub struct CampaignSecrets {
    pub ledger_sk: String,
    pub payload_sk: String,
    /// Auction: opens every amount commitment; revealed in the close entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_key: Option<String>,
}

impl CampaignSecrets {
    pub fn generate() -> Self {
        let mut ledger = [0u8; 32];
        let mut payload = [0u8; 32];
        let mut amount = [0u8; 32];
        OsRng.fill_bytes(&mut ledger);
        OsRng.fill_bytes(&mut payload);
        OsRng.fill_bytes(&mut amount);
        Self {
            ledger_sk: hex::encode(ledger),
            payload_sk: hex::encode(payload),
            amount_key: Some(hex::encode(amount)),
        }
    }

    pub fn ledger_key(&self) -> Result<SigningKey> {
        Ok(SigningKey::from_bytes(&hex32(&self.ledger_sk)?))
    }

    pub fn payload_key(&self) -> Result<crypto_box::SecretKey> {
        Ok(crypto_box::SecretKey::from(hex32(&self.payload_sk)?))
    }

    pub fn ledger_pubkey_hex(&self) -> Result<String> {
        Ok(hex::encode(self.ledger_key()?.verifying_key().as_bytes()))
    }

    pub fn payload_pubkey_hex(&self) -> Result<String> {
        Ok(hex::encode(self.payload_key()?.public_key().as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_independent_and_deterministic() {
        let k = ContributorKeys { seed: [7; 32] };
        let sign = k.signing_key().verifying_key().to_bytes();
        let enc = *k.encryption_key().public_key().as_bytes();
        assert_ne!(sign, enc);
        assert_eq!(sign, ContributorKeys { seed: [7; 32] }.signing_key().verifying_key().to_bytes());
    }
}
