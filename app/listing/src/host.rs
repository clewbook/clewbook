//! The host's side (PROTOTYPE): a long lived host key, made once, and a listing record for one campaign folder.
//!
//! The key file is `<runs dir>/host_key.json`, created with mode 600 and never overwritten; the secret is never printed or logged. Only the
//! public key and its fingerprint are ever shown. A record is signed by this key and by the campaign's own ledger key (from the campaign
//! folder's secrets), so only someone who holds both can ask for a campaign to be listed.

use crate::record::{ListingRecord, fingerprint};
use anyhow::{Context, Result, anyhow, bail, ensure};
use ed25519_dalek::SigningKey;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostKeyFile {
    v: u32,
    kind: String,
    sk: String,
}

pub fn key_path(runs_dir: &Path) -> PathBuf {
    runs_dir.join("host_key.json")
}

/// Makes the host key once. Refuses to overwrite an existing one. Returns the public key (hex).
pub fn init_key(runs_dir: &Path) -> Result<String> {
    let path = key_path(runs_dir);
    ensure!(!path.exists(), "a host key already exists at {} (it is never replaced)", path.display());
    fs::create_dir_all(runs_dir)?;
    let mut sk = [0u8; 32];
    OsRng.fill_bytes(&mut sk);
    let key = SigningKey::from_bytes(&sk);
    let body = serde_json::to_vec_pretty(&HostKeyFile { v: 1, kind: "clewbook-host-key".into(), sk: hex::encode(sk) })?;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    let mut f = opts.open(&path).with_context(|| format!("cannot create {}", path.display()))?;
    f.write_all(&body)?;
    f.sync_all()?;
    Ok(hex::encode(key.verifying_key().as_bytes()))
}

/// Loads the host key, refusing a file that others can read.
pub fn load_key(runs_dir: &Path) -> Result<SigningKey> {
    let path = key_path(runs_dir);
    let meta = fs::metadata(&path).with_context(|| format!("no host key at {}: run `cb-host host-key init` first", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        ensure!(mode & 0o077 == 0, "the host key file can be read by others (mode {mode:o}); it must be 600");
    }
    let f: HostKeyFile = serde_json::from_slice(&fs::read(&path)?).map_err(|_| anyhow!("the host key file is not readable"))?;
    ensure!(f.v == 1 && f.kind == "clewbook-host-key", "not a host key file");
    let sk: [u8; 32] = hex::decode(&f.sk).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| anyhow!("the host key file is damaged"))?;
    Ok(SigningKey::from_bytes(&sk))
}

/// What `host-key show` prints: the public key and its fingerprint, never the secret.
pub fn describe_key(runs_dir: &Path) -> Result<(String, String)> {
    let k = load_key(runs_dir)?;
    let pk = hex::encode(k.verifying_key().as_bytes());
    let fp = fingerprint(&pk);
    Ok((pk, fp))
}

/// A record for the campaign in `campaign_dir` (its rules.json, secrets.json and the relays in private/relays, unless `relays` is given).
pub fn record_for(runs_dir: &Path, campaign_dir: &Path, relays: Vec<String>, now: u64) -> Result<ListingRecord> {
    let host = load_key(runs_dir)?;
    let rules_text = fs::read_to_string(campaign_dir.join("rules.json")).context("the campaign folder has no rules.json")?;
    let rules: ll_core::rules::Rules = serde_json::from_str(&rules_text).map_err(|_| anyhow!("rules.json is not readable"))?;
    let id = hex::encode(rules.id()?);
    let secrets: ll_core::keys::CampaignSecrets = serde_json::from_slice(&fs::read(campaign_dir.join("secrets.json")).context("the campaign folder has no secrets.json")?)
        .map_err(|_| anyhow!("secrets.json is not readable"))?;
    let ledger = secrets.ledger_key()?;
    ensure!(secrets.ledger_pubkey_hex()? == rules.ledger_pubkey.to_lowercase(), "the campaign's secrets do not match its rules");
    let relays = if relays.is_empty() {
        fs::read_to_string(campaign_dir.join("private").join("relays")).unwrap_or_default().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
    } else {
        relays
    };
    if relays.is_empty() {
        bail!("no relays: give --relay, or list them in the campaign's private/relays");
    }
    ListingRecord::make(&id, &rules.network, relays, &host, &ledger, now)
}

/// Sends a record to a listing endpoint (`<url>/v1/records`) and returns its answer.
pub fn post(url: &str, record: &ListingRecord) -> Result<String> {
    let body = serde_json::to_vec(record)?;
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(20)).redirects(0).build();
    match agent.post(&format!("{}/v1/records", url.trim_end_matches('/'))).set("content-type", "application/json").send_bytes(&body) {
        Ok(r) => Ok(r.into_string().unwrap_or_default()),
        Err(ureq::Error::Status(code, r)) => bail!("the listing endpoint refused it (HTTP {code}): {}", r.into_string().unwrap_or_default()),
        Err(e) => bail!("the listing endpoint could not be reached: {e}"),
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
