//! The sealed bid of a sealed bid auction (SPEC §9.3): the memo version 3, the binding tag, locking a bid to a drand round and opening it.
//!
//! The memo has two parts. The first is today's sealed payload (version 2, SPEC §2) with the tranche as its amount: only the host opens it.
//! The second can be read by anyone who can read the memo (the host now, everyone once the viewing key is published): the bid locked to the
//! drand round, and the public key of the bid page (the late ticket's coin goes to its address).

use anyhow::{Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use crate::sealed::QUICKNET_PUBLIC_KEY;

pub const PREFIX: &str = "LL3:";
/// A locked bid: U (96 bytes, quicknet's key is in G2) + V (16) + W (16).
pub const LOCK_LEN: usize = 128;
/// The page's transparent public key, compressed.
pub const PAGE_KEY_LEN: usize = 33;
/// The tag's length; with the 8 byte bid and a 1 byte marker it fills the 16 bytes a lock carries.
pub const TAG_LEN: usize = 7;
/// The last byte of every locked message, so a message never ends in a zero byte.
pub const MARKER: u8 = 0x01;
/// A memo holds at most 512 bytes; this text memo is well under it (the bound kind fills it exactly).
pub const MEMO_MAX: usize = 512;
/// The bound kind (auctions with `long_tag`, the review, M4): the lock holds a random key; the bid (6 bytes, a bid below 2^48 zatoshis)
/// and a 16 byte tag made with that key follow it in the clear part. Nobody knows the key before round R, so nobody can make a tag for
/// another memo: copying a lock is caught with odds of 2^128 to 1, and each try costs a deposit on the chain.
pub const BID_CT_LEN: usize = 6;
pub const LONG_TAG_LEN: usize = 16;
pub const BOUND_LEN: usize = BID_CT_LEN + LONG_TAG_LEN;
/// The largest bid the bound kind carries.
pub const BOUND_BID_MAX: u64 = (1 << 48) - 1;

/// A sealed bid auction memo, as the bid page writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidMemo {
    /// The sealed payload (SPEC §2, version 2): only the host's payload key opens it.
    pub sealed: Vec<u8>,
    /// The bid, locked to the auction's drand round.
    pub lock: [u8; LOCK_LEN],
    /// The bid page's transparent public key.
    pub page_key: [u8; PAGE_KEY_LEN],
    /// The bound kind: the encrypted bid and the long tag (none in the older kind).
    pub bound: Option<[u8; BOUND_LEN]>,
}

impl BidMemo {
    pub fn to_text(&self) -> String {
        let mut clear = self.lock.to_vec();
        if let Some(b) = &self.bound {
            clear.extend_from_slice(b);
        }
        clear.extend_from_slice(&self.page_key);
        format!("{PREFIX}{}.{}", URL_SAFE_NO_PAD.encode(&self.sealed), URL_SAFE_NO_PAD.encode(clear))
    }

    /// Reads a memo of the version 3 shape. Anything else (another version, a wrong length, a page key that is not a compressed public key)
    /// is not a sealed bid memo.
    pub fn parse(text: &str) -> Result<Self> {
        let body = text.trim_end().strip_prefix(PREFIX).ok_or_else(|| anyhow!("not a blind bid memo"))?;
        let (a, b) = body.split_once('.').ok_or_else(|| anyhow!("a blind bid memo has two parts"))?;
        let sealed = URL_SAFE_NO_PAD.decode(a).map_err(|_| anyhow!("unreadable sealed part"))?;
        let clear = URL_SAFE_NO_PAD.decode(b).map_err(|_| anyhow!("unreadable bid part"))?;
        if sealed.len() != crate::payload::SEALED_LEN_V2 {
            bail!("the sealed part has the wrong length");
        }
        let bound: Option<[u8; BOUND_LEN]> = match clear.len() {
            n if n == LOCK_LEN + PAGE_KEY_LEN => None,
            n if n == LOCK_LEN + BOUND_LEN + PAGE_KEY_LEN => Some(clear[LOCK_LEN..LOCK_LEN + BOUND_LEN].try_into()?),
            _ => bail!("the bid part has the wrong length"),
        };
        let page_key: [u8; PAGE_KEY_LEN] = clear[clear.len() - PAGE_KEY_LEN..].try_into()?;
        if page_key[0] != 0x02 && page_key[0] != 0x03 {
            bail!("the page key is not a compressed public key");
        }
        Ok(Self { sealed, lock: clear[..LOCK_LEN].try_into()?, page_key, bound })
    }
}

/// Whether a memo has the public shape of a sealed bid memo (the recount classifies payments by it, as it does for older payloads).
pub fn is_bid_memo(text: &str) -> bool {
    BidMemo::parse(text).is_ok()
}

/// The binding tag: the first 7 bytes of BLAKE2b-256 over the campaign, the memo's sealed part, the page key and the tranche. It is locked
/// inside the bid and checked after the bid opens, against what anyone can see in the memo and the deposit: a lock copied into another memo
/// opens with a tag that does not match that memo, so it counts as no bid (14, 4.3). A whole memo copied into another payment is a replay
/// (SPEC §2: only the earliest accepted one counts).
pub fn tag(rules_id: &[u8; 32], sealed: &[u8], page_key: &[u8; PAGE_KEY_LEN], tranche_zat: u64) -> [u8; TAG_LEN] {
    let mut input = Vec::with_capacity(32 + sealed.len() + PAGE_KEY_LEN + 8);
    input.extend_from_slice(rules_id);
    input.extend_from_slice(sealed);
    input.extend_from_slice(page_key);
    input.extend_from_slice(&tranche_zat.to_le_bytes());
    let h = crate::hash(b"ledgerlab_bidtag", &input);
    h[..TAG_LEN].try_into().expect("7 of 32 bytes")
}

/// Locks a bid to a drand quicknet round: 8 bytes of bid (little endian), the tag, the marker.
pub fn lock_bid(bid_zat: u64, tag: &[u8; TAG_LEN], round: u64) -> Result<[u8; LOCK_LEN]> {
    let mut m = [0u8; 16];
    m[..8].copy_from_slice(&bid_zat.to_le_bytes());
    m[8..15].copy_from_slice(tag);
    m[15] = MARKER;
    let pk = hex::decode(QUICKNET_PUBLIC_KEY)?;
    let mut out = vec![];
    tlock::encrypt(&mut out, m.as_slice(), &pk, round).map_err(|e| anyhow!("locking the bid failed: {e}"))?;
    out.try_into().map_err(|v: Vec<u8>| anyhow!("a lock of {} bytes, expected {LOCK_LEN}", v.len()))
}

/// The bound kind (M4): the lock holds `key` (15 random bytes and the marker); the bid is encrypted with it and the long tag is made with
/// it over the campaign, the sealed part, the page key, the tranche and the encrypted bid.
fn bound_parts(key: &[u8; 16], rules_id: &[u8; 32], sealed: &[u8], page_key: &[u8; PAGE_KEY_LEN], tranche_zat: u64, ct: &[u8; BID_CT_LEN]) -> ([u8; BID_CT_LEN], [u8; LONG_TAG_LEN]) {
    let pad = crate::hash(b"ledgerlab_bidpad", key);
    let mut input = key.to_vec();
    input.extend_from_slice(rules_id);
    input.extend_from_slice(sealed);
    input.extend_from_slice(page_key);
    input.extend_from_slice(&tranche_zat.to_le_bytes());
    input.extend_from_slice(ct);
    let t = crate::hash(b"ledgerlab_bidtg2", &input);
    (pad[..BID_CT_LEN].try_into().expect("6 of 32"), t[..LONG_TAG_LEN].try_into().expect("16 of 32"))
}

/// Makes the bound kind of locked bid (M4) for one memo: the lock (a fresh random key locked to the round) and the encrypted bid with its
/// long tag.
pub fn lock_bid_bound(bid_zat: u64, rules_id: &[u8; 32], sealed: &[u8], page_key: &[u8; PAGE_KEY_LEN], tranche_zat: u64, round: u64) -> Result<([u8; LOCK_LEN], [u8; BOUND_LEN])> {
    if bid_zat > BOUND_BID_MAX {
        bail!("the bid is too large");
    }
    let mut key = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut key[..15]);
    key[15] = MARKER;
    let pk = hex::decode(QUICKNET_PUBLIC_KEY)?;
    let mut out = vec![];
    tlock::encrypt(&mut out, key.as_slice(), &pk, round).map_err(|e| anyhow!("locking the bid failed: {e}"))?;
    let lock: [u8; LOCK_LEN] = out.try_into().map_err(|v: Vec<u8>| anyhow!("a lock of {} bytes, expected {LOCK_LEN}", v.len()))?;
    let (pad, _) = bound_parts(&key, rules_id, sealed, page_key, tranche_zat, &[0; BID_CT_LEN]);
    let mut ct = [0u8; BID_CT_LEN];
    for (i, b) in bid_zat.to_le_bytes()[..BID_CT_LEN].iter().enumerate() {
        ct[i] = b ^ pad[i];
    }
    let (_, t) = bound_parts(&key, rules_id, sealed, page_key, tranche_zat, &ct);
    let mut bound = [0u8; BOUND_LEN];
    bound[..BID_CT_LEN].copy_from_slice(&ct);
    bound[BID_CT_LEN..].copy_from_slice(&t);
    Ok((lock, bound))
}

/// A memo's bid once round R is out: the bid, and what the binding check needs.
pub struct Opened {
    pub bid_zat: u64,
    message: [u8; 16],
}

impl Opened {
    /// Whether the bid was made for this memo and `tranche_zat` (its tag matches). A lock copied into another memo does not match.
    pub fn binds(&self, memo: &BidMemo, rules_id: &[u8; 32], tranche_zat: u64) -> bool {
        match &memo.bound {
            None => self.message[8..15] == tag(rules_id, &memo.sealed, &memo.page_key, tranche_zat),
            Some(b) => {
                let ct: [u8; BID_CT_LEN] = b[..BID_CT_LEN].try_into().expect("6 bytes");
                bound_parts(&self.message, rules_id, &memo.sealed, &memo.page_key, tranche_zat, &ct).1 == b[BID_CT_LEN..]
            }
        }
    }
}

/// Opens a memo's bid with the round's signature, whichever kind it is. Never panics; checks the signature against the pinned key first.
pub fn open_memo(memo: &BidMemo, round: u64, signature: &[u8]) -> std::result::Result<Opened, NoBid> {
    if !round_signature_ok(round, signature) {
        return Err(NoBid::WrongRound);
    }
    let m = tlock::decrypt_exact(&memo.lock, signature).map_err(|_| NoBid::DoesNotOpen)?;
    if m[15] != MARKER {
        return Err(NoBid::NoMarker);
    }
    let bid_zat = match &memo.bound {
        None => u64::from_le_bytes(m[..8].try_into().expect("8 bytes")),
        Some(b) => {
            let pad = crate::hash(b"ledgerlab_bidpad", &m);
            let mut v = [0u8; 8];
            for i in 0..BID_CT_LEN {
                v[i] = b[i] ^ pad[i];
            }
            u64::from_le_bytes(v)
        }
    };
    Ok(Opened { bid_zat, message: m })
}

/// Whether `eph_sk` (a challenge's one time secret) opens the sealed part of this blind bid memo with the auction's payload key: what a
/// relay checks before it stores a challenge (the second review, H2).
pub fn challenge_opens(memo_text: &str, payload_pubkey: &[u8; 32], eph_sk: &[u8; 32]) -> bool {
    BidMemo::parse(memo_text).is_ok_and(|m| crate::payload::Payload::open_sealed_challenged(&m.sealed, payload_pubkey, &crypto_box::SecretKey::from(*eph_sk)).is_ok())
}

/// Why a locked bid did not open. Every reason counts as "no bid"; none of them stops the recount or the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoBid {
    /// The signature is not quicknet's signature for this auction's round.
    WrongRound,
    /// The lock does not open with the round's signature (altered, or locked to another round).
    DoesNotOpen,
    /// It opened, but the message lacks the marker.
    NoMarker,
}

/// Whether `signature` (hex or bytes) is drand quicknet's signature for `round`, checked against the pinned key.
pub fn round_signature_ok(round: u64, signature: &[u8]) -> bool {
    hex::decode(QUICKNET_PUBLIC_KEY).is_ok_and(|pk| tlock::verify_round(&pk, round, signature))
}

/// Opens a locked bid with the round's signature. Never panics; checks the signature against the pinned key first.
pub fn open_bid(lock: &[u8; LOCK_LEN], round: u64, signature: &[u8]) -> std::result::Result<(u64, [u8; TAG_LEN]), NoBid> {
    if !round_signature_ok(round, signature) {
        return Err(NoBid::WrongRound);
    }
    let m = tlock::decrypt_exact(lock, signature).map_err(|_| NoBid::DoesNotOpen)?;
    if m[15] != MARKER {
        return Err(NoBid::NoMarker);
    }
    Ok((u64::from_le_bytes(m[..8].try_into().expect("8 bytes")), m[8..15].try_into().expect("7 bytes")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real quicknet round and its published signature (fetched once on 18 Oct 2026, research note 16).
    const ROUND: u64 = 33_187_201;
    const SIG: &str = "943614203a936e3d4ac466aa2b475e9c1e614f4759fe45b7f4bedeb0316d172e6cacadb08a46b39c67c09555dc6db3a5";
    /// quicknet's round 1000, from the tlock crate's own test.
    const SIG_1000: &str = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";

    fn memo(bid: u64, tranche: u64) -> (BidMemo, [u8; 32]) {
        let rules_id = [7u8; 32];
        let sealed = vec![9u8; crate::payload::SEALED_LEN_V2];
        let mut page_key = [5u8; PAGE_KEY_LEN];
        page_key[0] = 0x02;
        let t = tag(&rules_id, &sealed, &page_key, tranche);
        (BidMemo { sealed, lock: lock_bid(bid, &t, ROUND).unwrap(), page_key, bound: None }, rules_id)
    }

    #[test]
    fn m4_the_bound_kind_fills_the_memo_and_a_copied_lock_never_binds() {
        let rules_id = [7u8; 32];
        let sealed = vec![9u8; crate::payload::SEALED_LEN_V2];
        let mut page_key = [5u8; PAGE_KEY_LEN];
        page_key[0] = 0x02;
        let (lock, bound) = lock_bid_bound(25_000_000, &rules_id, &sealed, &page_key, 30_000_000, ROUND).unwrap();
        let m = BidMemo { sealed: sealed.clone(), lock, page_key, bound: Some(bound) };
        let text = m.to_text();
        assert_eq!(text.len(), MEMO_MAX, "exactly the memo's size");
        assert_eq!(BidMemo::parse(&text).unwrap(), m);
        let sig = hex::decode(SIG).unwrap();
        let o = open_memo(&m, ROUND, &sig).unwrap();
        assert_eq!(o.bid_zat, 25_000_000);
        assert!(o.binds(&m, &rules_id, 30_000_000));
        assert!(!o.binds(&m, &rules_id, 10_000_000), "another tranche");
        assert!(!o.binds(&m, &[8u8; 32], 30_000_000), "another auction");
        // the lock and its tag copied into another person's memo (another sealed part and page key): no bid
        let mut other = m.clone();
        other.sealed[0] ^= 1;
        let oc = open_memo(&other, ROUND, &sig).unwrap();
        assert!(!oc.binds(&other, &rules_id, 30_000_000));
        other.sealed[0] ^= 1;
        other.page_key[5] ^= 1;
        assert!(!open_memo(&other, ROUND, &sig).unwrap().binds(&other, &rules_id, 30_000_000));
        // a changed encrypted bid does not bind either (the tag covers it)
        let mut changed = m.clone();
        changed.bound.as_mut().unwrap()[0] ^= 1;
        assert!(!open_memo(&changed, ROUND, &sig).unwrap().binds(&changed, &rules_id, 30_000_000));
        // the older kind still opens the same way
        let (old, rid) = memo(25_000_000, 30_000_000);
        let oo = open_memo(&old, ROUND, &sig).unwrap();
        assert_eq!(oo.bid_zat, 25_000_000);
        assert!(oo.binds(&old, &rid, 30_000_000) && !oo.binds(&old, &rid, 10_000_000));
        assert!(lock_bid_bound(BOUND_BID_MAX + 1, &rules_id, &sealed, &page_key, 30_000_000, ROUND).is_err());
    }

    #[test]
    fn a_bid_locked_to_a_real_round_opens_with_its_signature() {
        let (m, rules_id) = memo(25_000_000, 30_000_000);
        let (bid, t) = open_bid(&m.lock, ROUND, &hex::decode(SIG).unwrap()).unwrap();
        assert_eq!(bid, 25_000_000);
        assert_eq!(t, tag(&rules_id, &m.sealed, &m.page_key, 30_000_000));
        // the same bid locked twice gives two different locks (the scheme is randomized: no salt needed)
        assert_ne!(lock_bid(25_000_000, &t, ROUND).unwrap(), lock_bid(25_000_000, &t, ROUND).unwrap());
    }

    #[test]
    fn the_memo_fits_and_reads_back() {
        let (m, _) = memo(1, 10_000_000);
        let text = m.to_text();
        assert!(text.len() <= MEMO_MAX, "{} characters", text.len());
        assert_eq!(text.len(), 4 + 263 + 1 + 215);
        assert_eq!(BidMemo::parse(&text).unwrap(), m);
        assert!(is_bid_memo(&text));
        assert!(!is_bid_memo("LL1:abc"));
        assert!(!crate::payload::is_payload_shaped(&text), "an older reader does not take it for an LL1 payload");
        let mut bad_key = m.clone();
        bad_key.page_key[0] = 0x04;
        assert!(BidMemo::parse(&bad_key.to_text()).is_err());
    }

    #[test]
    fn the_signature_is_checked_against_the_pinned_key() {
        assert!(round_signature_ok(ROUND, &hex::decode(SIG).unwrap()));
        assert!(round_signature_ok(1000, &hex::decode(SIG_1000).unwrap()));
        assert!(!round_signature_ok(1001, &hex::decode(SIG_1000).unwrap()), "a real signature for another round");
        let mut bad = hex::decode(SIG).unwrap();
        bad[10] ^= 1;
        assert!(!round_signature_ok(ROUND, &bad));
        assert!(!round_signature_ok(ROUND, &[0u8; 48]));
        assert!(!round_signature_ok(ROUND, b"short"));
    }

    #[test]
    fn faults_are_no_bid_never_a_panic() {
        let (m, _) = memo(25_000_000, 30_000_000);
        let sig = hex::decode(SIG).unwrap();
        // the right signature for another round
        assert_eq!(open_bid(&m.lock, 1000, &hex::decode(SIG_1000).unwrap()), Err(NoBid::DoesNotOpen));
        // a signature that is not quicknet's for this round
        assert_eq!(open_bid(&m.lock, ROUND, &hex::decode(SIG_1000).unwrap()), Err(NoBid::WrongRound));
        // one changed byte in V or W (the case that made the original library panic)
        for i in [100, 127] {
            let mut altered = m.lock;
            altered[i] ^= 1;
            assert_eq!(open_bid(&altered, ROUND, &sig), Err(NoBid::DoesNotOpen), "byte {i}");
        }
        // garbage
        assert_eq!(open_bid(&[0x42; LOCK_LEN], ROUND, &sig), Err(NoBid::DoesNotOpen));
        // a lock without the marker (made without lock_bid)
        let mut msg = [0u8; 16];
        msg[0] = 7;
        let mut out = vec![];
        tlock::encrypt(&mut out, msg.as_slice(), &hex::decode(QUICKNET_PUBLIC_KEY).unwrap(), ROUND).unwrap();
        assert_eq!(open_bid(&out.try_into().unwrap(), ROUND, &sig), Err(NoBid::NoMarker));
    }

    #[test]
    fn the_tag_binds_the_bid_to_its_memo_and_tranche() {
        let (m, rules_id) = memo(31_000_000, 50_000_000);
        let (_, t) = open_bid(&m.lock, ROUND, &hex::decode(SIG).unwrap()).unwrap();
        // the lock copied into another memo (another sealed part, or another page key) does not match that memo
        let mut other_sealed = m.sealed.clone();
        other_sealed[0] ^= 1;
        assert_ne!(t, tag(&rules_id, &other_sealed, &m.page_key, 50_000_000));
        let mut other_key = m.page_key;
        other_key[5] ^= 1;
        assert_ne!(t, tag(&rules_id, &m.sealed, &other_key, 50_000_000));
        // moved to another tranche or another campaign
        assert_ne!(t, tag(&rules_id, &m.sealed, &m.page_key, 100_000_000));
        assert_ne!(t, tag(&[8u8; 32], &m.sealed, &m.page_key, 50_000_000));
    }
}
