//! Formats and rules shared by the host app, the contributor tool and the recount.
//! See `SPEC.md` at the repository root.

pub mod auction;
pub mod canon;
pub mod final_copy;
pub mod heartbeat;
pub mod keys;
pub mod ledger;
pub mod payload;
pub mod receiver;
pub mod recount;
pub mod rules;
pub mod ticket_blob;
#[cfg(feature = "walletdb")]
pub mod walletdb;

/// BLAKE2b-256 with a personalization string (at most 16 bytes).
pub fn hash(personal: &[u8], data: &[u8]) -> [u8; 32] {
    blake2b_simd::Params::new()
        .hash_length(32)
        .personal(personal)
        .hash(data)
        .as_bytes()
        .try_into()
        .expect("32 bytes")
}

/// Decodes a 32-byte value from lowercase or uppercase hex.
pub fn hex32(s: &str) -> anyhow::Result<[u8; 32]> {
    hex::decode(s)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("expected 32 bytes of hex"))
}

/// ZIP 302: a memo whose first byte is at most 0xF4 is UTF-8 text padded with zeros.
pub fn memo_text(memo: &[u8]) -> Option<String> {
    if memo.first().is_none_or(|b| *b > 0xF4) {
        return None;
    }
    let end = memo.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    String::from_utf8(memo[..end].to_vec()).ok()
}
