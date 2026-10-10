//! What is sealed to the contributor in a ticket blob (SPEC §3).
//!
//! * Version 1 (tickets issued before 2026-10-06): the raw transaction bytes, nothing else.
//! * Version 2: `"LLT2" || u32le(len(raw)) || raw || u8 action || u64le value || rseed[32]`: the raw transaction plus the
//!   opening values of the refund output (which action, how much, and the note's random seed), so the contributor's
//!   page can recompute that output's note commitment with the refund address they gave and see that it pays them.
//!
//! A raw transaction starts with its version header (`0x05` or `0x06`, then `0x00 0x00 0x80`), never with `LLT2`, so the
//! two versions cannot be confused. Old tickets keep working: they simply carry no opening.

use anyhow::{Result, bail};

pub const MAGIC_V2: &[u8; 4] = b"LLT2";

/// The refund output's opening values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Opening {
    /// Index of the action (in the Ironwood bundle) that holds the refund output.
    pub action: u8,
    pub value_zat: u64,
    #[serde(with = "hex_bytes")]
    pub rseed: [u8; 32],
}

mod hex_bytes {
    pub fn serialize<S: serde::Serializer>(b: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(b))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let s: String = serde::Deserialize::deserialize(d)?;
        hex::decode(&s).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| serde::de::Error::custom("expected 32 bytes of hex"))
    }
}

pub fn encode_v2(raw_tx: &[u8], opening: &Opening) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 4 + raw_tx.len() + 1 + 8 + 32);
    out.extend_from_slice(MAGIC_V2);
    out.extend_from_slice(&(raw_tx.len() as u32).to_le_bytes());
    out.extend_from_slice(raw_tx);
    out.push(opening.action);
    out.extend_from_slice(&opening.value_zat.to_le_bytes());
    out.extend_from_slice(&opening.rseed);
    out
}

/// The format version, the raw transaction, and (version 2) the opening.
pub fn decode(plain: &[u8]) -> Result<(u8, Vec<u8>, Option<Opening>)> {
    if !plain.starts_with(MAGIC_V2) {
        return Ok((1, plain.to_vec(), None));
    }
    if plain.len() < 8 {
        bail!("ticket blob too short");
    }
    let n = u32::from_le_bytes(plain[4..8].try_into()?) as usize;
    let rest = &plain[8..];
    if rest.len() != n + 1 + 8 + 32 {
        bail!("ticket blob has the wrong length for version 2");
    }
    let raw = rest[..n].to_vec();
    let o = &rest[n..];
    let opening = Opening { action: o[0], value_zat: u64::from_le_bytes(o[1..9].try_into()?), rseed: o[9..41].try_into()? };
    Ok((2, raw, Some(opening)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_2_round_trips_and_version_1_is_recognised() {
        let raw = [0x06, 0, 0, 0x80, 1, 2, 3];
        let o = Opening { action: 1, value_zat: 990_000, rseed: [7; 32] };
        let blob = encode_v2(&raw, &o);
        assert_eq!(decode(&blob).unwrap(), (2, raw.to_vec(), Some(o)));
        assert_eq!(decode(&raw).unwrap(), (1, raw.to_vec(), None));
        assert!(decode(&blob[..blob.len() - 1]).is_err());
    }
}
