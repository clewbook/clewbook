//! TEST TOOL, for the test network only: prints a payment message (memo) for a campaign with any field chosen by hand, the way a payer
//! with their own software could make one. Used by app/review-e2e.sh (scenarios odd, badreceiver, fuzz) to show what the host and the
//! recount do with such payments (docs/THREAT_MODEL.md threat 25). The contribute page and cb-contrib never make these.
//! Usage: craft_memo <rules.json> <seed file> <typecode, 3 = Orchard> <receiver: 86 hex characters> [amount zat]
//! Optional environment: CRAFT_RULES_ID (64 hex), CRAFT_VERSION (a byte), CRAFT_ENC (64 hex encryption key), CRAFT_DROP (bytes cut
//! from the end of the plaintext), CRAFT_GARBAGE=1 (seal random bytes of the right length instead of a payload).
use ll_core::{hex32, keys::ContributorKeys, payload, rules::Rules};

fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let env = |k: &str| std::env::var(k).ok();
    let rules: Rules = serde_json::from_slice(&std::fs::read(&a[1])?)?;
    let keys = ContributorKeys::from_hex(&std::fs::read_to_string(&a[2])?)?;
    let receiver: [u8; 43] = hex::decode(&a[4])?.try_into().map_err(|_| anyhow::anyhow!("the receiver must be 43 bytes"))?;
    let amount: Option<u64> = a.get(5).map(|s| s.parse()).transpose()?;
    let rules_id = match env("CRAFT_RULES_ID") { Some(h) => hex32(&h)?, None => rules.id()? };
    let enc = match env("CRAFT_ENC") { Some(h) => hex32(&h)?, None => keys.encryption_key().public_key().to_bytes() };
    let mut p = vec![env("CRAFT_VERSION").map(|v| v.parse()).transpose()?.unwrap_or(if amount.is_some() { payload::VERSION_V2 } else { payload::VERSION })];
    p.extend_from_slice(&rules_id);
    p.extend_from_slice(&keys.signing_key().verifying_key().to_bytes());
    p.extend_from_slice(&enc);
    p.push(a[3].parse()?);
    p.extend_from_slice(&receiver);
    if let Some(v) = amount {
        p.extend_from_slice(&v.to_le_bytes());
    }
    if env("CRAFT_GARBAGE").is_some() {
        p = (0..p.len()).map(|i| (i * 7 + 3) as u8).collect();
    }
    let drop: usize = env("CRAFT_DROP").map(|v| v.parse()).transpose()?.unwrap_or(0);
    p.truncate(p.len() - drop);
    let sealed = payload::seal_with_ephemeral(&p, &crypto_box::PublicKey::from(hex32(&rules.payload_pubkey)?), &keys.memo_ephemeral_key())?;
    use base64::Engine;
    println!("{}{}", payload::PREFIX, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sealed));
    Ok(())
}
