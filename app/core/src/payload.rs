//! Contribution memo payload (SPEC §2).

use anyhow::{Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use crypto_box::{
    Nonce, PublicKey, SalsaBox, SecretKey,
    aead::Aead,
};

pub const PREFIX: &str = "LL1:";
/// Payload version 1: no amount (older memos: any amount counts; such a memo can be copied, SPEC §2).
pub const VERSION: u8 = 0x01;
/// Payload version 2: carries the intended amount; a payment smaller than it is not a contribution.
pub const VERSION_V2: u8 = 0x02;
pub const PLAINTEXT_LEN: usize = 1 + 32 + 32 + 32 + 1 + 43;
pub const PLAINTEXT_LEN_V2: usize = PLAINTEXT_LEN + 8;
/// A libsodium sealed box adds an ephemeral public key (32) and a MAC (16).
pub const SEALED_LEN: usize = PLAINTEXT_LEN + 48;
pub const SEALED_LEN_V2: usize = PLAINTEXT_LEN_V2 + 48;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payload {
    pub rules_id: [u8; 32],
    pub sign_pubkey: [u8; 32],
    pub enc_pubkey: [u8; 32],
    pub refund_typecode: u8,
    pub refund_receiver: [u8; 43],
    /// Version 2: the amount (zatoshis) the contributor intends to pay. A payment of at least this much counts; less is a donation.
    pub amount_zat: Option<u64>,
}

/// libsodium's sealed-box nonce: BLAKE2b-192(ephemeral_pk || recipient_pk), unkeyed.
fn seal_nonce(epk: &PublicKey, pk: &PublicKey) -> Nonce {
    let mut input = [0u8; 64];
    input[..32].copy_from_slice(epk.as_bytes());
    input[32..].copy_from_slice(pk.as_bytes());
    let h = blake2b_simd::Params::new().hash_length(24).hash(&input);
    *Nonce::from_slice(h.as_bytes())
}

/// A libsodium-compatible sealed box (`crypto_box_seal`) whose ephemeral key is chosen by
/// the caller instead of drawn at random. The output opens with `crypto_box_seal_open`.
pub fn seal_with_ephemeral(plaintext: &[u8], recipient: &PublicKey, esk: &SecretKey) -> Result<Vec<u8>> {
    let epk = esk.public_key();
    let ct = SalsaBox::new(recipient, esk)
        .encrypt(&seal_nonce(&epk, recipient), plaintext)
        .map_err(|e| anyhow!("seal failed: {e}"))?;
    let mut out = epk.as_bytes().to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Opens a sealed box with the published one-time secret instead of the recipient's key.
pub fn open_with_ephemeral(sealed: &[u8], recipient: &PublicKey, esk: &SecretKey) -> Result<Vec<u8>> {
    if sealed.len() <= 32 || sealed[..32] != esk.public_key().as_bytes()[..] {
        bail!("the published secret is not the one that sealed this memo");
    }
    let epk = esk.public_key();
    SalsaBox::new(recipient, esk)
        .decrypt(&seal_nonce(&epk, recipient), &sealed[32..])
        .map_err(|_| anyhow!("the sealed memo does not open with the campaign key"))
}

impl Payload {
    fn plaintext(&self) -> Vec<u8> {
        let mut p = Vec::with_capacity(PLAINTEXT_LEN_V2);
        p.push(if self.amount_zat.is_some() { VERSION_V2 } else { VERSION });
        p.extend_from_slice(&self.rules_id);
        p.extend_from_slice(&self.sign_pubkey);
        p.extend_from_slice(&self.enc_pubkey);
        p.push(self.refund_typecode);
        p.extend_from_slice(&self.refund_receiver);
        if let Some(a) = self.amount_zat {
            p.extend_from_slice(&a.to_le_bytes());
        }
        p
    }

    fn parse(p: &[u8]) -> Result<Self> {
        let amount_zat = match (p.first(), p.len()) {
            (Some(&VERSION), PLAINTEXT_LEN) => None,
            (Some(&VERSION_V2), PLAINTEXT_LEN_V2) => Some(u64::from_le_bytes(p[141..149].try_into()?)),
            _ => bail!("unsupported payload version or length"),
        };
        Ok(Self {
            rules_id: p[1..33].try_into()?,
            sign_pubkey: p[33..65].try_into()?,
            enc_pubkey: p[65..97].try_into()?,
            refund_typecode: p[97],
            refund_receiver: p[98..141].try_into()?,
            amount_zat,
        })
    }

    /// Seals the payload to the campaign's payload key with the contribution's one-time key
    /// and returns the memo text.
    pub fn to_memo(&self, payload_pubkey: &[u8; 32], esk: &SecretKey) -> Result<String> {
        let sealed = seal_with_ephemeral(&self.plaintext(), &PublicKey::from(*payload_pubkey), esk)?;
        Ok(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(sealed)))
    }

    /// Opens a memo with the campaign's payload secret key (host side).
    pub fn open(memo: &str, payload_sk: &SecretKey) -> Result<Self> {
        let sealed = sealed_bytes(memo).ok_or_else(|| anyhow!("not an LL1 payload"))?;
        let p = payload_sk
            .unseal(&sealed)
            .map_err(|_| anyhow!("payload does not open with this campaign's key"))?;
        Self::parse(&p)
    }

    /// Opens a memo with a published one-time secret (challenge, anyone).
    pub fn open_challenged(memo: &str, payload_pubkey: &[u8; 32], esk: &SecretKey) -> Result<Self> {
        let sealed = sealed_bytes(memo).ok_or_else(|| anyhow!("not an LL1 payload"))?;
        Self::parse(&open_with_ephemeral(&sealed, &PublicKey::from(*payload_pubkey), esk)?)
    }
}

pub fn sealed_bytes(memo: &str) -> Option<Vec<u8>> {
    let body = memo.strip_prefix(PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(body.trim_end()).ok()?;
    (bytes.len() == SEALED_LEN || bytes.len() == SEALED_LEN_V2).then_some(bytes)
}

/// Whether a memo has the public shape of a payload. The recount cannot open payloads, so
/// it classifies candidate contributions by this shape (SPEC §5).
pub fn is_payload_shaped(memo: &str) -> bool {
    sealed_bytes(memo).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Payload {
        Payload {
            rules_id: [1; 32],
            sign_pubkey: [2; 32],
            enc_pubkey: [3; 32],
            refund_typecode: 3,
            refund_receiver: [4; 43],
            amount_zat: None,
        }
    }

    #[test]
    fn round_trip_size_and_challenge() {
        let sk = SecretKey::from([9u8; 32]);
        let esk = SecretKey::from([7u8; 32]);
        let memo = sample().to_memo(sk.public_key().as_bytes(), &esk).unwrap();
        assert_eq!(memo.len(), 256);
        assert!(is_payload_shaped(&memo));
        assert_eq!(Payload::open(&memo, &sk).unwrap(), sample());
        assert!(Payload::open(&memo, &SecretKey::from([8u8; 32])).is_err());
        // Anyone holding the one-time secret can open it with only the campaign's public key.
        assert_eq!(Payload::open_challenged(&memo, sk.public_key().as_bytes(), &esk).unwrap(), sample());
        assert!(Payload::open_challenged(&memo, sk.public_key().as_bytes(), &SecretKey::from([6u8; 32])).is_err());
    }

    #[test]
    fn version_2_carries_the_amount_and_version_1_still_opens() {
        let sk = SecretKey::from([9u8; 32]);
        let esk = SecretKey::from([7u8; 32]);
        let v2 = Payload { amount_zat: Some(1_000_000), ..sample() };
        let memo = v2.to_memo(sk.public_key().as_bytes(), &esk).unwrap();
        assert_eq!(memo.len(), 267, "four more bytes of prefix plus eleven more characters");
        assert!(is_payload_shaped(&memo));
        assert_eq!(Payload::open(&memo, &sk).unwrap(), v2);
        assert_eq!(Payload::open_challenged(&memo, sk.public_key().as_bytes(), &esk).unwrap().amount_zat, Some(1_000_000));
        // an old memo (version 1, no amount) is still recognised and opens
        let v1 = sample().to_memo(sk.public_key().as_bytes(), &esk).unwrap();
        assert_eq!(v1.len(), 256);
        assert_eq!(Payload::open(&v1, &sk).unwrap().amount_zat, None);
    }

    #[test]
    fn manual_seal_opens_with_the_library_unseal() {
        let sk = SecretKey::from([9u8; 32]);
        let sealed = seal_with_ephemeral(b"hello", &sk.public_key(), &SecretKey::from([5u8; 32])).unwrap();
        assert_eq!(sk.unseal(&sealed).unwrap(), b"hello");
    }
}
