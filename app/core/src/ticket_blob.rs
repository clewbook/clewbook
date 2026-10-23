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

/// Sealed bid auctions with open payouts (SPEC §9.1, open_payouts): what is sealed to the person who bid in an issue entry's blob. `"LLS1" ||
/// u32le(len(early)) || early || opening(41) || u32le(len(refund)) || refund || opening(41)`: the early ticket and the refund the host
/// signed with the deposit, both finished transactions, each with the opening values of its output, so the page checks before it says
/// PROTECTED that the refund pays the person who bid, as it does for the early ticket (set 1, C1).
pub const MAGIC_SEALED: &[u8; 4] = b"LLS1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedTickets {
    pub early: Vec<u8>,
    pub early_opening: Opening,
    pub refund: Vec<u8>,
    pub refund_opening: Opening,
}

fn put_tx(out: &mut Vec<u8>, raw: &[u8], o: &Opening) {
    out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
    out.extend_from_slice(raw);
    out.push(o.action);
    out.extend_from_slice(&o.value_zat.to_le_bytes());
    out.extend_from_slice(&o.rseed);
}

fn take_tx(rest: &[u8]) -> Result<(Vec<u8>, Opening, &[u8])> {
    if rest.len() < 4 {
        bail!("sealed ticket blob too short");
    }
    let n = u32::from_le_bytes(rest[..4].try_into()?) as usize;
    let rest = &rest[4..];
    if rest.len() < n + 41 {
        bail!("sealed ticket blob too short");
    }
    let o = &rest[n..n + 41];
    let opening = Opening { action: o[0], value_zat: u64::from_le_bytes(o[1..9].try_into()?), rseed: o[9..41].try_into()? };
    Ok((rest[..n].to_vec(), opening, &rest[n + 41..]))
}

pub fn encode_sealed(t: &SealedTickets) -> Vec<u8> {
    let mut out = MAGIC_SEALED.to_vec();
    put_tx(&mut out, &t.early, &t.early_opening);
    put_tx(&mut out, &t.refund, &t.refund_opening);
    out
}

/// The early ticket and the signed refund of a version 3 ("LLS1") blob; `None` for any other format.
pub fn decode_sealed(plain: &[u8]) -> Result<Option<SealedTickets>> {
    let Some(rest) = plain.strip_prefix(MAGIC_SEALED.as_slice()) else { return Ok(None) };
    let (early, early_opening, rest) = take_tx(rest)?;
    let (refund, refund_opening, rest) = take_tx(rest)?;
    if !rest.is_empty() {
        bail!("sealed ticket blob has bytes left over");
    }
    Ok(Some(SealedTickets { early, early_opening, refund, refund_opening }))
}

/// The format version, the raw transaction, and (version 2) the opening. A version 3 ("LLS1") blob gives its early ticket.
pub fn decode(plain: &[u8]) -> Result<(u8, Vec<u8>, Option<Opening>)> {
    if let Some(t) = decode_sealed(plain)? {
        return Ok((3, t.early, Some(t.early_opening)));
    }
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

/// Sealed bid auctions (SPEC §9.4): what is sealed to the person who bid in a coin entry's blob. `"LLL1" || ovk[32] || u32le anchor height || raw`:
/// the host's part of the late ticket (the coin input's signature left empty), the outgoing viewing key its refund output was made with
/// (fresh for this ticket, so the page can open that output and see it pays the person who bid), and the height whose note tree root is the
/// ticket's anchor (so the page can check the anchor against the chain).
pub const MAGIC_LATE: &[u8; 4] = b"LLL1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LatePart {
    pub ovk: [u8; 32],
    pub anchor_height: u32,
    pub raw: Vec<u8>,
}

impl LatePart {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(40 + self.raw.len());
        out.extend_from_slice(MAGIC_LATE);
        out.extend_from_slice(&self.ovk);
        out.extend_from_slice(&self.anchor_height.to_le_bytes());
        out.extend_from_slice(&self.raw);
        out
    }

    pub fn decode(plain: &[u8]) -> Result<Self> {
        if !plain.starts_with(MAGIC_LATE) || plain.len() < 41 {
            bail!("not a late ticket");
        }
        Ok(Self { ovk: plain[4..36].try_into()?, anchor_height: u32::from_le_bytes(plain[36..40].try_into()?), raw: plain[40..].to_vec() })
    }
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

#[cfg(test)]
mod sealed_tests {
    use super::*;

    #[test]
    fn a_sealed_blob_carries_the_early_ticket_and_the_refund_and_reads_back() {
        let o = |a: u8| Opening { action: a, value_zat: 290_000 + a as u64, rseed: [a; 32] };
        let t = SealedTickets { early: vec![6, 0, 0, 0x80, 1, 2], early_opening: o(1), refund: vec![6, 0, 0, 0x80, 9], refund_opening: o(0) };
        let b = encode_sealed(&t);
        assert_eq!(decode_sealed(&b).unwrap(), Some(t.clone()));
        // the early ticket reads as before, so every page that opens an early ticket keeps working
        assert_eq!(decode(&b).unwrap(), (3, t.early.clone(), Some(t.early_opening)));
        // not this format: none; damaged: an error, never a crash
        assert_eq!(decode_sealed(&encode_v2(&t.early, &t.early_opening)).unwrap(), None);
        for cut in [5, 12, b.len() - 1] {
            assert!(decode_sealed(&b[..cut]).is_err(), "cut at {cut}");
        }
        let mut longer = b.clone();
        longer.push(0);
        assert!(decode_sealed(&longer).is_err());
    }
}
