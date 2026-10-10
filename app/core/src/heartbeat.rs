//! The host's "last seen" signal (SPEC §6): a small record signed with the campaign's ledger key, saying "at chain height H, at time T, the host was
//! looking at the campaign". Relays keep the newest one; the contributor page reads it and warns when it is old. It is not part of the ledger and it
//! proves only that the key holder was running at that moment: a relay can withhold it or serve an old one (which looks old), but cannot make a new one.

use anyhow::{Result, bail};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::canon::to_canonical;

/// A heartbeat is this small; a relay refuses anything bigger.
pub const MAX_BYTES: usize = 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Heartbeat {
    pub v: u32,
    pub rules_id: String,
    /// The chain height the host saw when it made this.
    pub height: u32,
    /// Unix time on the host's clock, seconds.
    pub time: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

impl Heartbeat {
    pub fn new(rules_id: &str, height: u32, time: u64) -> Self {
        Heartbeat { v: 1, rules_id: rules_id.to_string(), height, time, sig: None }
    }

    fn signing_bytes(&self) -> Result<Vec<u8>> {
        let mut unsigned = self.clone();
        unsigned.sig = None;
        let mut bytes = b"ledgerlab_heartbeat\n".to_vec(); // never confusable with a ledger entry, which is signed over its own canonical form
        bytes.extend(to_canonical(&unsigned)?.as_bytes());
        Ok(bytes)
    }

    pub fn sign(&mut self, sk: &SigningKey) -> Result<()> {
        self.sig = Some(hex::encode(sk.sign(&self.signing_bytes()?).to_bytes()));
        Ok(())
    }

    /// Checks the version, that it is for this campaign, and the signature.
    pub fn verify(&self, pk: &VerifyingKey, rules_id: &str) -> Result<()> {
        if self.v != 1 {
            bail!("unknown heartbeat version {}", self.v);
        }
        if self.rules_id != rules_id {
            bail!("this heartbeat is for another campaign");
        }
        let Some(sig) = self.sig.as_deref() else { bail!("unsigned heartbeat") };
        let sig = Signature::from_slice(&hex::decode(sig)?)?;
        pk.verify(&self.signing_bytes()?, &sig).map_err(|_| anyhow::anyhow!("the heartbeat's signature is not the campaign's"))?;
        Ok(())
    }

    /// Whether this one is later than `other` (by height, then time).
    pub fn is_newer_than(&self, other: &Heartbeat) -> bool {
        (self.height, self.time) > (other.height, other.time)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }
    const ID: &str = "ab00000000000000000000000000000000000000000000000000000000000001";

    #[test]
    fn a_signed_heartbeat_verifies_and_a_changed_one_does_not() {
        let sk = key(1);
        let mut h = Heartbeat::new(ID, 4_000_000, 1_790_000_000);
        h.sign(&sk).unwrap();
        h.verify(&sk.verifying_key(), ID).unwrap();
        let mut later = h.clone();
        later.height += 1;
        assert!(later.verify(&sk.verifying_key(), ID).is_err(), "a changed height breaks the signature");
        let mut other_time = h.clone();
        other_time.time += 1;
        assert!(other_time.verify(&sk.verifying_key(), ID).is_err());
        let mut elsewhere = h.clone();
        elsewhere.rules_id = "cd".repeat(32);
        assert!(elsewhere.verify(&sk.verifying_key(), &"cd".repeat(32)).is_err(), "moving it to another campaign breaks it");
    }

    #[test]
    fn the_wrong_key_the_wrong_campaign_and_no_signature_are_refused() {
        let mut h = Heartbeat::new(ID, 10, 20);
        assert!(h.verify(&key(1).verifying_key(), ID).is_err(), "unsigned");
        h.sign(&key(1)).unwrap();
        assert!(h.verify(&key(2).verifying_key(), ID).is_err(), "another key");
        assert!(h.verify(&key(1).verifying_key(), &"00".repeat(32)).is_err(), "another campaign");
    }

    #[test]
    fn a_ledger_signature_cannot_pass_as_a_heartbeat() {
        // the heartbeat is signed over its own prefix + canonical form: a signature made for any other canonical JSON of the same fields fails
        let sk = key(1);
        let mut h = Heartbeat::new(ID, 10, 20);
        let plain = to_canonical(&h).unwrap();
        h.sig = Some(hex::encode(sk.sign(plain.as_bytes()).to_bytes()));
        assert!(h.verify(&sk.verifying_key(), ID).is_err());
    }

    #[test]
    fn newer_means_higher_then_later() {
        let a = Heartbeat::new(ID, 10, 100);
        assert!(Heartbeat::new(ID, 11, 1).is_newer_than(&a));
        assert!(Heartbeat::new(ID, 10, 101).is_newer_than(&a));
        assert!(!Heartbeat::new(ID, 10, 100).is_newer_than(&a));
        assert!(!Heartbeat::new(ID, 9, 999).is_newer_than(&a));
    }

    #[test]
    fn the_wire_form_is_small() {
        let mut h = Heartbeat::new(ID, 4_000_000, 1_790_000_000);
        h.sign(&key(1)).unwrap();
        assert!(to_canonical(&h).unwrap().len() < 300 && MAX_BYTES >= 600);
    }
}
