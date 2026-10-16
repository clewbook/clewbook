//! The listing record (PROTOTYPE): a host asks for one campaign to be shown on a home page.
//!
//! It names the campaign (its id), the relays that hold it, its network, the host's long lived public key, the campaign's ledger key and the
//! time it was made. It is signed twice over the same bytes: by the host key (who asks) and by the campaign's ledger key (proof that whoever asks
//! controls the campaign). The signed bytes are a domain tag followed by the canonical JSON of the record without its two signatures, so neither
//! signature can be taken for a ledger entry, a heartbeat, a final record or anything else these keys sign (those sign other bytes).

use anyhow::{Result, anyhow, bail, ensure};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// The domain tag in front of the signed bytes. Never valid JSON, so never the canonical form of anything else.
pub const DOMAIN: &[u8] = b"clewbook_listing_record_v1\n";
pub const VERSION: u32 = 1;
pub const KIND: &str = "clewbook-listing";
/// A record is small; anything larger is refused before it is parsed.
pub const MAX_RECORD_BYTES: usize = 4096;
pub const MAX_RELAYS: usize = 4;
pub const MAX_RELAY_URL: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ListingRecord {
    pub v: u32,
    pub kind: String,
    /// The campaign id (64 hex): the hash of its rules.
    pub campaign: String,
    /// "test" or "main", as in the campaign's rules.
    pub network: String,
    /// Where the campaign can be read (https in production).
    pub relays: Vec<String>,
    /// The host's long lived public key (64 hex).
    pub host_pubkey: String,
    /// The campaign's ledger key (64 hex); must equal `ledger_pubkey` in the campaign's rules.
    pub ledger_pubkey: String,
    /// Unix seconds when the record was made.
    pub created: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_sig: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ledger_sig: Option<String>,
}

fn hex32(s: &str, what: &str) -> Result<[u8; 32]> {
    let v = hex::decode(s).map_err(|_| anyhow!("{what} is not hex"))?;
    v.try_into().map_err(|_| anyhow!("{what} must be 32 bytes"))
}
fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A short, readable name for a host key: BLAKE2b of the key under its own tag, first 10 bytes, in groups of four hex digits.
pub fn fingerprint(host_pubkey_hex: &str) -> String {
    let h = blake2b_simd::Params::new().hash_length(32).personal(b"clewbook_hostfp\0").hash(host_pubkey_hex.as_bytes());
    let hx = hex::encode(&h.as_bytes()[..10]);
    hx.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join(" ")
}

impl ListingRecord {
    /// The bytes both keys sign: the domain tag, then the canonical JSON of the record without its signatures.
    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        let mut unsigned = self.clone();
        unsigned.host_sig = None;
        unsigned.ledger_sig = None;
        let mut out = DOMAIN.to_vec();
        out.extend_from_slice(ll_core::canon::to_canonical(&unsigned)?.as_bytes());
        Ok(out)
    }

    /// Makes and signs a record. `ledger_key` is the campaign's own key (from its secrets), `host_key` the host's long lived key.
    pub fn make(campaign: &str, network: &str, relays: Vec<String>, host_key: &SigningKey, ledger_key: &SigningKey, created: u64) -> Result<Self> {
        let mut r = ListingRecord {
            v: VERSION,
            kind: KIND.into(),
            campaign: campaign.to_lowercase(),
            network: network.into(),
            relays: relays.into_iter().map(|u| u.trim_end_matches('/').to_string()).collect(),
            host_pubkey: hex::encode(host_key.verifying_key().as_bytes()),
            ledger_pubkey: hex::encode(ledger_key.verifying_key().as_bytes()),
            created,
            host_sig: None,
            ledger_sig: None,
        };
        r.check_shape()?;
        let msg = r.signing_bytes()?;
        r.host_sig = Some(hex::encode(host_key.sign(&msg).to_bytes()));
        r.ledger_sig = Some(hex::encode(ledger_key.sign(&msg).to_bytes()));
        Ok(r)
    }

    /// The fields alone, without any network: version, kind, id, network, relay addresses (well formed, few, short), keys.
    pub fn check_shape(&self) -> Result<()> {
        ensure!(self.v == VERSION, "unknown record version {}", self.v);
        ensure!(self.kind == KIND, "not a listing record");
        ensure!(is_lower_hex(&self.campaign, 64), "the campaign id must be 64 lowercase hex characters");
        ensure!(self.network == "test" || self.network == "main", "the network must be \"test\" or \"main\"");
        ensure!(!self.relays.is_empty() && self.relays.len() <= MAX_RELAYS, "a record names 1 to {MAX_RELAYS} relays");
        for u in &self.relays {
            ensure!(u.len() <= MAX_RELAY_URL && u.is_ascii() && !u.chars().any(|c| c.is_ascii_control() || c == ' '), "a relay address is too long or not plain");
            ensure!(u.starts_with("https://") || u.starts_with("http://"), "a relay address must start with https://");
        }
        ensure!(is_lower_hex(&self.host_pubkey, 64), "the host key must be 64 lowercase hex characters");
        ensure!(is_lower_hex(&self.ledger_pubkey, 64), "the ledger key must be 64 lowercase hex characters");
        Ok(())
    }

    /// Both signatures over the same bytes (the record's own keys; that the ledger key is the campaign's is checked against its rules later).
    pub fn verify_signatures(&self) -> Result<()> {
        self.check_shape()?;
        let msg = self.signing_bytes()?;
        let check = |pk: &str, sig: &Option<String>, who: &str| -> Result<()> {
            let pk = VerifyingKey::from_bytes(&hex32(pk, who)?).map_err(|_| anyhow!("the {who} is not a valid key"))?;
            let sig = sig.as_deref().ok_or_else(|| anyhow!("the {who} signature is missing"))?;
            let bytes: [u8; 64] = hex::decode(sig).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| anyhow!("the {who} signature is malformed"))?;
            pk.verify(&msg, &Signature::from_bytes(&bytes)).map_err(|_| anyhow!("the {who} signature does not verify"))
        };
        check(&self.host_pubkey, &self.host_sig, "host key")?;
        check(&self.ledger_pubkey, &self.ledger_sig, "ledger key")?;
        Ok(())
    }

    /// Parses a submitted record: size first, then JSON (unknown fields refused), then shape and both signatures.
    pub fn parse_and_verify(bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() <= MAX_RECORD_BYTES, "a listing record is at most {MAX_RECORD_BYTES} bytes");
        let r: ListingRecord = serde_json::from_slice(bytes).map_err(|e| anyhow!("not a listing record: {e}"))?;
        r.verify_signatures()?;
        Ok(r)
    }

    /// Checks the record against the campaign's rules as a relay served them: the rules must hash to the record's campaign id, carry the
    /// same ledger key and network, and the network must be allowed here. With `require_open` (a campaign never listed before) the deadline
    /// must also still be ahead of the chain height `tip`; a campaign already listed stays listed after its deadline (history and proof).
    pub fn check_against_rules(&self, rules_json: &str, tip: u32, allowed_networks: &[String], require_open: bool) -> Result<ll_core::rules::Rules> {
        let rules: ll_core::rules::Rules = serde_json::from_str(rules_json).map_err(|_| anyhow!("the relay did not return valid campaign rules"))?;
        rules.validate().map_err(|e| anyhow!("the campaign rules are not valid: {e}"))?;
        let id = hex::encode(rules.id()?);
        ensure!(id == self.campaign, "the rules the relay returned are for another campaign ({}…)", &id[..8]);
        ensure!(rules.ledger_pubkey.to_lowercase() == self.ledger_pubkey, "the ledger key in the campaign's rules is not the key that signed this record");
        ensure!(rules.network == self.network, "the record says network {:?} but the campaign's rules say {:?}", self.network, rules.network);
        if !allowed_networks.iter().any(|n| n == &rules.network) {
            bail!("network {:?} is not listed here", rules.network);
        }
        ensure!(!require_open || rules.deadline_height > tip, "the deadline (block {}) is not ahead of the chain (block {tip})", rules.deadline_height);
        Ok(rules)
    }

    pub fn host_fingerprint(&self) -> String {
        fingerprint(&self.host_pubkey)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ll_core::keys::CampaignSecrets;
    use rand_core::{OsRng, RngCore};

    fn key() -> SigningKey { let mut b = [0u8; 32]; OsRng.fill_bytes(&mut b); SigningKey::from_bytes(&b) }

    fn rules_for(secrets: &CampaignSecrets, network: &str, deadline: u32) -> String {
        serde_json::json!({"v":1,"network":network,"mode":"raise","goal_zat":5000000,"start_height":100,"deadline_height":deadline,"ticket_k":30,
            "close_grace":10,"reissue_window":20,"refund_fee_zat":10000,"min_contribution_zat":20000,"campaign_ufvk":"uvftest1x",
            "ledger_pubkey":secrets.ledger_pubkey_hex().unwrap(),"payload_pubkey":secrets.payload_pubkey_hex().unwrap(),"name":"Garden fund"}).to_string()
    }
    fn id_of(rules: &str) -> String {
        let r: ll_core::rules::Rules = serde_json::from_str(rules).unwrap();
        hex::encode(r.id().unwrap())
    }
    fn setup(network: &str, deadline: u32) -> (CampaignSecrets, SigningKey, String, ListingRecord) {
        let s = CampaignSecrets::generate();
        let host = key();
        let rules = rules_for(&s, network, deadline);
        let rec = ListingRecord::make(&id_of(&rules), network, vec!["https://relay.example.org".into()], &host, &s.ledger_key().unwrap(), 1_760_000_000).unwrap();
        (s, host, rules, rec)
    }
    const TEST: &[&str] = &["test"];
    fn nets() -> Vec<String> { TEST.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn a_valid_record_verifies_and_matches_its_rules() {
        let (_, _, rules, rec) = setup("test", 5_000_000);
        let bytes = serde_json::to_vec(&rec).unwrap();
        let back = ListingRecord::parse_and_verify(&bytes).unwrap();
        assert_eq!(back, rec);
        back.check_against_rules(&rules, 4_000_000, &nets(), true).unwrap();
    }

    #[test]
    fn a_wrong_host_signature_is_refused() {
        let (_, _, _, mut rec) = setup("test", 5_000_000);
        let other = key();
        rec.host_sig = Some(hex::encode(other.sign(&rec.signing_bytes().unwrap()).to_bytes()));
        assert!(rec.verify_signatures().unwrap_err().to_string().contains("host key signature does not verify"));
    }

    #[test]
    fn a_wrong_ledger_signature_is_refused() {
        let (_, _, _, mut rec) = setup("test", 5_000_000);
        let other = key();
        rec.ledger_sig = Some(hex::encode(other.sign(&rec.signing_bytes().unwrap()).to_bytes()));
        assert!(rec.verify_signatures().unwrap_err().to_string().contains("ledger key signature does not verify"));
    }

    #[test]
    fn a_changed_relay_list_breaks_both_signatures() {
        let (_, _, _, mut rec) = setup("test", 5_000_000);
        rec.relays = vec!["https://evil.example.net".into()];
        assert!(rec.verify_signatures().is_err());
    }

    #[test]
    fn a_record_for_another_campaign_is_refused() {
        // signed correctly, but the campaign id is another campaign's, so the rules the relay serves for it do not match
        let (s, host, rules_a, _) = setup("test", 5_000_000);
        let other = CampaignSecrets::generate();
        let rules_b = rules_for(&other, "test", 5_000_000);
        let rec = ListingRecord::make(&id_of(&rules_b), "test", vec!["https://relay.example.org".into()], &host, &s.ledger_key().unwrap(), 1).unwrap();
        rec.verify_signatures().unwrap();
        assert!(rec.check_against_rules(&rules_a, 1, &nets(), true).unwrap_err().to_string().contains("another campaign"));
        assert!(rec.check_against_rules(&rules_b, 1, &nets(), true).unwrap_err().to_string().contains("not the key that signed"));
    }

    #[test]
    fn a_wrong_or_unlisted_network_is_refused() {
        let (s0, host, rules, _) = setup("test", 5_000_000);
        // the record claims main for a testnet campaign (signed by the campaign's own ledger key)
        let rec = ListingRecord::make(&id_of(&rules), "main", vec!["https://r.example".into()], &host, &s0.ledger_key().unwrap(), 1).unwrap();
        assert!(rec.check_against_rules(&rules, 1, &["test".into(), "main".into()], true).unwrap_err().to_string().contains("rules say"));
        // a mainnet campaign is refused while only testnet is listed
        let (_, _, main_rules, main_rec) = setup("main", 5_000_000);
        assert!(main_rec.check_against_rules(&main_rules, 1, &nets(), true).unwrap_err().to_string().contains("not listed here"));
    }

    #[test]
    fn a_past_deadline_is_refused() {
        let (_, _, rules, rec) = setup("test", 1_000);
        assert!(rec.check_against_rules(&rules, 1_000, &nets(), true).unwrap_err().to_string().contains("not ahead of the chain"));
        rec.check_against_rules(&rules, 999, &nets(), true).unwrap();
        // a campaign already listed is not refused for its deadline
        rec.check_against_rules(&rules, 5_000, &nets(), false).unwrap();
    }

    #[test]
    fn oversize_unknown_fields_and_bad_shapes_are_refused() {
        let (_, _, _, rec) = setup("test", 5_000_000);
        let mut v = serde_json::to_value(&rec).unwrap();
        v["extra"] = serde_json::json!("x");
        assert!(ListingRecord::parse_and_verify(&serde_json::to_vec(&v).unwrap()).is_err());
        assert!(ListingRecord::parse_and_verify(&vec![b' '; MAX_RECORD_BYTES + 1]).is_err());
        let mut many = rec.clone();
        many.relays = (0..5).map(|i| format!("https://r{i}.example")).collect();
        assert!(many.check_shape().is_err());
    }

    #[test]
    fn the_signed_bytes_carry_the_domain_tag_and_never_look_like_json() {
        let (_, _, _, rec) = setup("test", 5_000_000);
        let b = rec.signing_bytes().unwrap();
        assert!(b.starts_with(DOMAIN) && b[0] != b'{');
    }
}
