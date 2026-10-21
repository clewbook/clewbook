//! A small blocking client for a relay (SPEC §6). Everything it returns is untrusted: callers
//! re-check hashes and signatures themselves.

use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use ll_core::{
    canon::to_canonical,
    ledger::Entry,
    rules::Rules,
};

/// Why a relay call failed: it could not be reached at all, or it answered with an error.
#[derive(Debug)]
pub enum RelayError {
    Unreachable(String),
    Refused { status: u16, message: String },
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelayError::Unreachable(m) => write!(f, "relay unreachable: {m}"),
            RelayError::Refused { status, message } => write!(f, "relay answered {status}: {message}"),
        }
    }
}

impl std::error::Error for RelayError {}

pub struct Relay {
    base: String,
    agent: ureq::Agent,
}

impl Relay {
    pub fn new(base: &str) -> Self {
        Relay {
            base: base.trim_end_matches('/').to_string(),
            agent: ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout(Duration::from_secs(20)).build(),
        }
    }

    pub fn url(&self) -> &str {
        &self.base
    }

    fn map(e: ureq::Error) -> RelayError {
        match e {
            ureq::Error::Status(status, resp) => {
                let text = resp.into_string().unwrap_or_default();
                let message = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v["error"].as_str().map(String::from))
                    .unwrap_or(text);
                RelayError::Refused { status, message }
            }
            ureq::Error::Transport(t) => RelayError::Unreachable(t.to_string()),
        }
    }

    fn get(&self, path: &str) -> Result<Vec<u8>, RelayError> {
        let resp = self.agent.get(&format!("{}/v1/{path}", self.base)).call().map_err(Self::map)?;
        let mut body = vec![];
        std::io::Read::read_to_end(&mut resp.into_reader().take(8 * 1024 * 1024), &mut body).map_err(|e| RelayError::Unreachable(e.to_string()))?;
        Ok(body)
    }

    fn put(&self, path: &str, body: &[u8]) -> Result<(), RelayError> {
        self.agent.put(&format!("{}/v1/{path}", self.base)).send_bytes(body).map(|_| ()).map_err(Self::map)
    }

    pub fn register(&self, rules: &Rules) -> Result<(), RelayError> {
        let id = hex::encode(rules.id().map_err(|e| RelayError::Refused { status: 0, message: e.to_string() })?);
        let body = to_canonical(rules).map_err(|e| RelayError::Refused { status: 0, message: e.to_string() })?;
        self.put(&format!("campaigns/{id}"), body.as_bytes())
    }

    /// Fetches the rules and checks they hash to `rules_id` (so a relay cannot swap them).
    pub fn rules(&self, rules_id: &str) -> Result<Rules> {
        let raw = self.get(&format!("campaigns/{rules_id}"))?;
        let rules: Rules = serde_json::from_slice(&raw).map_err(|e| anyhow!("relay sent unreadable rules: {e}"))?;
        if hex::encode(rules.id()?) != rules_id {
            bail!("the relay's rules do not hash to the campaign id {rules_id}");
        }
        Ok(rules)
    }

    pub fn head_entries(&self, rules_id: &str) -> Result<u64, RelayError> {
        let raw = self.get(&format!("campaigns/{rules_id}/head"))?;
        let v: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| RelayError::Unreachable(e.to_string()))?;
        Ok(v["entries"].as_u64().unwrap_or(0))
    }

    pub fn ledger(&self, rules_id: &str, from: u64) -> Result<Vec<Entry>> {
        let raw = self.get(&format!("campaigns/{rules_id}/ledger?from={from}"))?;
        Ok(serde_json::from_slice(&raw).map_err(|e| anyhow!("relay sent an unreadable ledger: {e}"))?)
    }

    pub fn put_entry(&self, rules_id: &str, entry: &Entry) -> Result<(), RelayError> {
        let body = to_canonical(entry).map_err(|e| RelayError::Refused { status: 0, message: e.to_string() })?;
        self.put(&format!("campaigns/{rules_id}/ledger/{}", entry.seq), body.as_bytes())
    }

    /// Publishes the host's final fingerprint of a closed campaign (the relay keeps the first, or a later one that covers more).
    pub fn put_final(&self, rules_id: &str, rec: &ll_core::final_copy::FinalRecord) -> Result<(), RelayError> {
        let body = to_canonical(rec).map_err(|e| RelayError::Refused { status: 0, message: e.to_string() })?;
        self.put(&format!("campaigns/{rules_id}/final"), body.as_bytes())
    }

    /// Publishes the host's "last seen" signal (the relay keeps only the newest).
    pub fn put_heartbeat(&self, rules_id: &str, hb: &ll_core::heartbeat::Heartbeat) -> Result<(), RelayError> {
        let body = to_canonical(hb).map_err(|e| RelayError::Refused { status: 0, message: e.to_string() })?;
        self.put(&format!("campaigns/{rules_id}/heartbeat"), body.as_bytes())
    }

    pub fn put_blob(&self, rules_id: &str, hash: &str, bytes: &[u8]) -> Result<(), RelayError> {
        self.put(&format!("campaigns/{rules_id}/blobs/{hash}"), bytes)
    }

    pub fn has_blob(&self, rules_id: &str, hash: &str) -> Result<bool, RelayError> {
        match self.get(&format!("campaigns/{rules_id}/blobs/{hash}")) {
            Ok(_) => Ok(true),
            Err(RelayError::Refused { status: 404, .. }) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub fn put_challenge(&self, rules_id: &str, c: &ll_core::recount::Challenge) -> Result<(), RelayError> {
        let body = to_canonical(c).map_err(|e| RelayError::Refused { status: 0, message: e.to_string() })?;
        self.put(&format!("campaigns/{rules_id}/challenges"), body.as_bytes())
    }

    pub fn challenges(&self, rules_id: &str) -> Result<Vec<ll_core::recount::Challenge>> {
        let raw = self.get(&format!("campaigns/{rules_id}/challenges"))?;
        Ok(serde_json::from_slice(&raw).map_err(|e| anyhow!("relay sent unreadable challenges: {e}"))?)
    }

    /// A sealed blob by its hash (a sealed bid auction's late ticket is fetched this way, from its coin entry's `blob_hash`).
    pub fn blob(&self, rules_id: &str, hash: &str) -> Result<Vec<u8>, RelayError> {
        self.get(&format!("campaigns/{rules_id}/blobs/{hash}"))
    }

    pub fn ticket(&self, rules_id: &str, nf: &str) -> Result<Vec<u8>, RelayError> {
        self.get(&format!("campaigns/{rules_id}/tickets/{nf}"))
    }
}

use std::io::Read as _;
