//! The relay: stores and serves ledger entries and sealed tickets (SPEC §6).
//!
//! It holds no secret and cannot create entries; it only accepts entries that verify under
//! the campaign's own ledger key, in order, with the exact canonical bytes. Clients re-check
//! everything they read.

pub mod client;
pub mod multi;

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};

use ll_core::{
    canon::to_canonical,
    ledger::{Entry, GENESIS_PREV, blob_hash, verifying_key},
    rules::Rules,
};

pub const MAX_RULES_BYTES: usize = 16 * 1024;
pub const MAX_ENTRY_BYTES: usize = 16 * 1024;
pub const MAX_BLOB_BYTES: usize = 64 * 1024;
/// The most entries any campaign may have, whatever the relay is configured with.
pub const MAX_ENTRIES: u64 = 100_000;

/// What a relay accepts, so a relay reachable by anyone cannot be filled up or swamped (SPEC §6). All configurable (`cb-relay serve --help`).
#[derive(Clone, Debug)]
pub struct Limits {
    /// Campaigns that may be registered on this relay (a campaign already registered can always be read and written).
    pub max_campaigns: usize,
    /// Entries one campaign's list may hold.
    pub max_entries: u64,
    /// Largest request body (a sealed ticket is the largest thing anyone sends, a few kilobytes).
    pub max_body: usize,
    /// Requests handled at the same time; more are answered "busy" (503) at once.
    pub max_concurrent: usize,
    /// Requests per minute from one source (0 = no limit). Behind a tunnel every request comes from this computer, so the source is the client
    /// address the tunnel passes on (`CF-Connecting-IP`), trusted only from this computer.
    pub per_source_per_minute: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_campaigns: 200, max_entries: 5_000, max_body: MAX_BLOB_BYTES, max_concurrent: 64, per_source_per_minute: 600 }
    }
}
/// At most this many different challenge secrets are kept per payment (anyone may post one).
pub const MAX_CHALLENGES_PER_PAYMENT: usize = 8;

#[derive(Debug)]
pub enum StoreError {
    BadRequest(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
    TooLarge(String),
    TooMany(String),
    Busy(String),
}

impl StoreError {
    fn status(&self) -> u16 {
        match self {
            StoreError::BadRequest(_) => 400,
            StoreError::NotFound(_) => 404,
            StoreError::Conflict(_) => 409,
            StoreError::Internal(_) => 500,
            StoreError::TooLarge(_) => 413,
            StoreError::TooMany(_) => 429,
            StoreError::Busy(_) => 503,
        }
    }

    fn message(&self) -> &str {
        match self {
            StoreError::BadRequest(m) | StoreError::NotFound(m) | StoreError::Conflict(m) | StoreError::Internal(m) | StoreError::TooLarge(m) | StoreError::TooMany(m) | StoreError::Busy(m) => m,
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Internal(e.to_string())
    }
}

type R<T> = Result<T, StoreError>;

fn bad<T>(m: impl Into<String>) -> R<T> {
    Err(StoreError::BadRequest(m.into()))
}

fn is_hex32(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Files on disk: `campaigns/<rules_id>/{rules.json, ledger/NNNNNN.json, blobs/<hash>}`.
pub struct Store {
    root: PathBuf,
    limits: Limits,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Put {
    Created,
    AlreadyStored,
}

impl Store {
    pub fn open(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("campaigns"))?;
        Ok(Self { root, limits: Limits::default() })
    }

    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    fn dir(&self, id: &str) -> R<PathBuf> {
        if !is_hex32(id) {
            return bad("campaign id must be 64 lowercase hex characters");
        }
        Ok(self.root.join("campaigns").join(id))
    }

    fn rules(&self, id: &str) -> R<Rules> {
        let raw = fs::read(self.dir(id)?.join("rules.json"))
            .map_err(|_| StoreError::NotFound("campaign not registered".into()))?;
        serde_json::from_slice(&raw).map_err(|e| StoreError::Internal(e.to_string()))
    }

    /// Keeps the newest heartbeat of a campaign (SPEC §6): signed with the campaign's ledger key, for this campaign, and later than the one stored.
    pub fn put_heartbeat(&self, id: &str, body: &[u8]) -> R<Put> {
        if body.len() > ll_core::heartbeat::MAX_BYTES {
            return bad("heartbeat too large");
        }
        let rules: Rules = serde_json::from_slice(&self.rules_raw(id)?).map_err(|e| StoreError::Internal(e.to_string()))?;
        let pk = verifying_key(&rules.ledger_pubkey).or_else(|e| bad(e.to_string()))?;
        let hb: ll_core::heartbeat::Heartbeat = serde_json::from_slice(body).or_else(|e| bad(format!("not a heartbeat: {e}")))?;
        hb.verify(&pk, id).or_else(|e| bad(e.to_string()))?;
        let path = self.dir(id)?.join("heartbeat.json");
        if let Ok(old) = fs::read(&path) {
            if let Ok(old) = serde_json::from_slice::<ll_core::heartbeat::Heartbeat>(&old) {
                if old == hb {
                    return Ok(Put::AlreadyStored);
                }
                if !hb.is_newer_than(&old) {
                    return Err(StoreError::Conflict("a later heartbeat is already stored".into()));
                }
            }
        }
        fs::write(&path, to_canonical(&hb).map_err(|e| StoreError::Internal(e.to_string()))?)?;
        Ok(Put::Created)
    }

    /// Keeps the host's final fingerprint of a closed campaign (SPEC §6): signed with the campaign's ledger key, for this campaign, and describing a list
    /// this relay really holds (the same number of entries up to its last one, a close entry among them). A later record replaces an earlier one only if it
    /// covers more (settlement entries that followed the close).
    pub fn put_final(&self, id: &str, body: &[u8]) -> R<Put> {
        use ll_core::final_copy::FinalRecord;
        if body.len() > 2048 {
            return bad("final record too large");
        }
        let rules: Rules = serde_json::from_slice(&self.rules_raw(id)?).map_err(|e| StoreError::Internal(e.to_string()))?;
        let pk = verifying_key(&rules.ledger_pubkey).or_else(|e| bad(e.to_string()))?;
        let rec: FinalRecord = serde_json::from_slice(body).or_else(|e| bad(format!("not a final record: {e}")))?;
        rec.verify(&pk, id).or_else(|e| bad(e.to_string()))?;
        let entries = self.entries(id)?;
        if rec.entries == 0 || rec.entries as usize > entries.len() {
            return Err(StoreError::Conflict("this relay does not hold all the entries the record covers yet; publish the list first".into()));
        }
        let covered = &entries[..rec.entries as usize];
        let last = covered.last().and_then(|e| e.hash().ok()).unwrap_or_default();
        if last != rec.last_hash || !covered.iter().any(|e| e.kind == "close") {
            return bad("the record does not describe the list this relay holds");
        }
        let path = self.dir(id)?.join("final.json");
        if let Ok(old) = fs::read(&path) {
            if let Ok(old) = serde_json::from_slice::<FinalRecord>(&old) {
                if old == rec {
                    return Ok(Put::AlreadyStored);
                }
                if !old.is_extended_by(&rec) {
                    return Err(StoreError::Conflict("a final record is already stored".into()));
                }
            }
        }
        fs::write(&path, to_canonical(&rec).map_err(|e| StoreError::Internal(e.to_string()))?)?;
        Ok(Put::Created)
    }

    pub fn final_raw(&self, id: &str) -> R<Vec<u8>> {
        self.rules_raw(id)?;
        fs::read(self.dir(id)?.join("final.json")).map_err(|_| StoreError::NotFound("no final record yet".into()))
    }

    pub fn heartbeat_raw(&self, id: &str) -> R<Vec<u8>> {
        self.rules_raw(id)?;
        fs::read(self.dir(id)?.join("heartbeat.json")).map_err(|_| StoreError::NotFound("no heartbeat yet".into()))
    }

    pub fn rules_raw(&self, id: &str) -> R<Vec<u8>> {
        fs::read(self.dir(id)?.join("rules.json")).map_err(|_| StoreError::NotFound("campaign not registered".into()))
    }

    /// Registers a campaign's rules; the id must be the hash of the rules.
    pub fn register(&self, id: &str, body: &[u8]) -> R<Put> {
        let dir = self.dir(id)?;
        if body.len() > MAX_RULES_BYTES {
            return bad("rules too large");
        }
        let rules: Rules = serde_json::from_slice(body).or_else(|e| bad(format!("not valid rules: {e}")))?;
        rules.validate().or_else(|e| bad(e.to_string()))?;
        let computed = rules.id().map(hex::encode).or_else(|e| bad(e.to_string()))?;
        if computed != id {
            return bad(format!("the rules hash to {computed}, not {id}"));
        }
        // The campaign's ledger key must be a real key, or nothing could ever be accepted.
        verifying_key(&rules.ledger_pubkey).or_else(|e| bad(format!("bad ledger_pubkey: {e}")))?;
        if dir.join("rules.json").exists() {
            return Ok(Put::AlreadyStored);
        }
        let registered = fs::read_dir(self.root.join("campaigns"))?.filter_map(|e| e.ok()).filter(|e| e.path().join("rules.json").exists()).count();
        if registered >= self.limits.max_campaigns {
            return Err(StoreError::Conflict(format!("this relay is full: it takes at most {} campaigns", self.limits.max_campaigns)));
        }
        fs::create_dir_all(dir.join("ledger"))?;
        fs::create_dir_all(dir.join("blobs"))?;
        fs::write(dir.join("rules.json"), to_canonical(&rules).map_err(|e| StoreError::Internal(e.to_string()))?)?;
        Ok(Put::Created)
    }

    fn raw_entries(&self, id: &str) -> R<Vec<Vec<u8>>> {
        let ledger = self.dir(id)?.join("ledger");
        let mut names: Vec<_> = match fs::read_dir(&ledger) {
            Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "json")).collect(),
            Err(_) => vec![],
        };
        names.sort();
        names.iter().map(|p| fs::read(p).map_err(StoreError::from)).collect()
    }

    fn entries(&self, id: &str) -> R<Vec<Entry>> {
        self.raw_entries(id)?
            .iter()
            .map(|b| serde_json::from_slice(b).map_err(|e| StoreError::Internal(format!("stored entry unreadable: {e}"))))
            .collect()
    }

    /// Stores entry number `seq`. Accepts only the exact next entry, signed by the campaign.
    pub fn put_entry(&self, id: &str, seq: u64, body: &[u8]) -> R<Put> {
        let rules = self.rules(id)?;
        if body.len() > MAX_ENTRY_BYTES {
            return bad("entry too large");
        }
        let entry: Entry = serde_json::from_slice(body).or_else(|e| bad(format!("not a ledger entry: {e}")))?;
        let canonical = to_canonical(&entry).or_else(|e| bad(e.to_string()))?;
        if canonical.as_bytes() != body {
            return bad("the entry must be sent as canonical JSON (sorted keys, no whitespace)");
        }
        if entry.seq != seq {
            return bad("seq in the path and in the entry differ");
        }
        if entry.rules_id != id {
            return bad("the entry belongs to another campaign");
        }
        let pk = verifying_key(&rules.ledger_pubkey).or_else(|e| bad(e.to_string()))?;
        entry.verify(&pk).or_else(|_| bad("signature does not verify under the campaign's ledger key"))?;
        match entry.kind.as_str() {
            "issue" | "reissue" => {
                if entry.contribution.is_none() || entry.ticket.is_none() || entry.blob_hash.is_none() {
                    return bad("issue/reissue entries need contribution, ticket and blob_hash");
                }
            }
            "reject" => {
                if entry.contribution.is_none() {
                    return bad("reject entries need a contribution");
                }
            }
            "close" => {
                if entry.close.is_none() {
                    return bad("close entries need a close object");
                }
            }
            "settle" => {
                if entry.settle.is_none() {
                    return bad("settle entries need a settle object");
                }
            }
            k => return bad(format!("unknown entry kind {k}")),
        }

        let existing = self.raw_entries(id)?;
        let n = existing.len() as u64;
        if seq < n {
            return if existing[seq as usize] == body {
                Ok(Put::AlreadyStored)
            } else {
                Err(StoreError::Conflict(format!("a different entry is already stored for seq {seq}")))
            };
        }
        if seq > n {
            return bad(format!("gap: the next entry must be seq {n}"));
        }
        if n >= self.limits.max_entries.min(MAX_ENTRIES) {
            return Err(StoreError::Conflict(format!("ledger full: this relay keeps at most {} entries per campaign", self.limits.max_entries.min(MAX_ENTRIES))));
        }
        let prev: Option<Entry> = existing.last().map(|b| serde_json::from_slice(b)).transpose().map_err(|e| StoreError::Internal(e.to_string()))?;
        if entry.kind != "settle" && self.entries(id)?.iter().any(|p| p.kind == "close") {
            return Err(StoreError::Conflict("the campaign is closed; only settlement entries may follow".into()));
        }
        let expected_prev = match &prev {
            Some(p) => p.hash().map_err(|e| StoreError::Internal(e.to_string()))?,
            None => GENESIS_PREV.to_string(),
        };
        if entry.prev != expected_prev {
            return bad("prev does not match the hash of the previous entry");
        }
        fs::write(self.dir(id)?.join("ledger").join(format!("{seq:06}.json")), body)?;
        Ok(Put::Created)
    }

    /// The raw ledger as a JSON array of the stored entries with `seq >= from`.
    pub fn ledger_json(&self, id: &str, from: u64) -> R<Vec<u8>> {
        self.rules(id)?;
        let parts: Vec<Vec<u8>> = self.raw_entries(id)?.into_iter().skip(from as usize).collect();
        Ok([b"[".to_vec(), parts.join(&b","[..]), b"]".to_vec()].concat())
    }

    pub fn head(&self, id: &str) -> R<String> {
        self.rules(id)?;
        let entries = self.entries(id)?;
        let last = match entries.last() {
            Some(e) => e.hash().map_err(|e| StoreError::Internal(e.to_string()))?,
            None => GENESIS_PREV.to_string(),
        };
        Ok(format!("{{\"entries\":{},\"last_hash\":\"{}\"}}", entries.len(), last))
    }

    pub fn put_blob(&self, id: &str, hash: &str, bytes: &[u8]) -> R<Put> {
        self.rules(id)?;
        if !is_hex32(hash) {
            return bad("blob hash must be 64 lowercase hex characters");
        }
        if bytes.len() > MAX_BLOB_BYTES {
            return bad("blob too large");
        }
        if blob_hash(bytes) != hash {
            return bad("the bytes do not hash to the given blob hash");
        }
        if !self.entries(id)?.iter().any(|e| e.blob_hash.as_deref() == Some(hash)) {
            return bad("no stored ledger entry refers to this blob; publish the entry first");
        }
        let path = self.dir(id)?.join("blobs").join(hash);
        if path.exists() {
            return Ok(Put::AlreadyStored);
        }
        fs::write(path, bytes)?;
        Ok(Put::Created)
    }

    /// Files a challenge (SPEC §4): `{txid, action, eph_sk}`. It is neither signed nor sealed, the
    /// secret itself is the proof (anyone can open the memo with it), and it is meant to be public.
    /// The relay only accepts it against a payment that a stored `reject` entry names.
    pub fn put_challenge(&self, id: &str, body: &[u8]) -> R<Put> {
        self.rules(id)?;
        if body.len() > 2048 {
            return bad("challenge too large");
        }
        let c: ll_core::recount::Challenge = serde_json::from_slice(body).or_else(|e| bad(format!("not a challenge: {e}")))?;
        if !is_hex32(&c.txid) || !is_hex32(&c.eph_sk) {
            return bad("txid and eph_sk must be 64 lowercase hex characters");
        }
        let entries = self.entries(id)?;
        let names_payment = |e: &ll_core::ledger::Entry| e.contribution.as_ref().is_some_and(|k| k.txid == c.txid && k.action == c.action);
        let rejected = entries.iter().any(|e| e.kind == "reject" && names_payment(e));
        // A uniform-auction winner's statement about their excess (SPEC §8.5) is accepted against a
        // payment whose nullifier has a `settle` entry.
        let settled = entries
            .iter()
            .filter(|e| names_payment(e))
            .filter_map(|e| e.nf())
            .any(|nf| entries.iter().any(|s| s.settle.as_ref().is_some_and(|x| x.nf == nf)));
        if !rejected && !settled {
            return bad("no reject or settlement entry in this ledger names that payment, so there is nothing to challenge");
        }
        if (c.uivk.is_some() || c.complaint) && !settled {
            return bad("a viewing key or a complaint only applies to a settled auction winner");
        }
        let dir = self.dir(id)?.join("challenges");
        fs::create_dir_all(&dir)?;
        let tag = hex::encode(&ll_core::hash(b"ledgerlab_chal", format!("{}|{:?}|{}", c.eph_sk, c.uivk, c.complaint).as_bytes())[..8]);
        let path = dir.join(format!("{}-{}-{tag}.json", c.txid, c.action));
        if path.exists() {
            return Ok(Put::AlreadyStored);
        }
        let same_payment = fs::read_dir(&dir)?.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with(&format!("{}-{}-", c.txid, c.action))).count();
        if same_payment >= MAX_CHALLENGES_PER_PAYMENT {
            return Err(StoreError::Conflict("too many different challenges for this payment".into()));
        }
        fs::write(path, to_canonical(&c).map_err(|e| StoreError::Internal(e.to_string()))?)?;
        Ok(Put::Created)
    }

    pub fn challenges_json(&self, id: &str) -> R<Vec<u8>> {
        self.rules(id)?;
        let dir = self.dir(id)?.join("challenges");
        let mut files: Vec<_> = match fs::read_dir(&dir) {
            Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
            Err(_) => vec![],
        };
        files.sort();
        let parts: Vec<Vec<u8>> = files.iter().map(|p| fs::read(p).map_err(StoreError::from)).collect::<R<_>>()?;
        Ok([b"[".to_vec(), parts.join(&b","[..]), b"]".to_vec()].concat())
    }

    pub fn blob(&self, id: &str, hash: &str) -> R<Vec<u8>> {
        if !is_hex32(hash) {
            return bad("blob hash must be 64 lowercase hex characters");
        }
        fs::read(self.dir(id)?.join("blobs").join(hash)).map_err(|_| StoreError::NotFound("no such ticket blob".into()))
    }

    /// The sealed ticket of the latest issue/reissue entry for a nullifier.
    pub fn ticket(&self, id: &str, nf: &str) -> R<Vec<u8>> {
        self.rules(id)?;
        let entries = self.entries(id)?;
        let hash = entries
            .iter()
            .rev()
            .find(|e| e.nf() == Some(nf) && e.blob_hash.is_some())
            .and_then(|e| e.blob_hash.clone())
            .ok_or_else(|| StoreError::NotFound("no ticket for this nullifier in the ledger".into()))?;
        self.blob(id, &hash)
    }
}

// ---- HTTP ----

type Resp = tiny_http::Response<std::io::Cursor<Vec<u8>>>;

fn header(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("static header")
}

fn respond(status: u16, content_type: &str, body: Vec<u8>) -> Resp {
    tiny_http::Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Access-Control-Allow-Origin", "*"))
        .with_header(header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS"))
        .with_header(header("Access-Control-Allow-Headers", "content-type"))
        .with_header(header("Cache-Control", "no-store"))
}

fn err_response(e: StoreError) -> Resp {
    let body = format!("{{\"error\":{}}}", serde_json::Value::String(e.message().to_string()));
    respond(e.status(), "application/json", body.into_bytes())
}

fn ok_put(p: Put) -> Resp {
    match p {
        Put::Created => respond(201, "application/json", b"{\"stored\":true}".to_vec()),
        Put::AlreadyStored => respond(200, "application/json", b"{\"stored\":false,\"already\":true}".to_vec()),
    }
}

/// Handles one request; pure over `Store`, so it is easy to test.
pub fn handle(store: &Store, method: &str, url: &str, body: &[u8]) -> Resp {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let result: R<Resp> = (|| match (method, parts.as_slice()) {
        ("OPTIONS", _) => Ok(respond(204, "text/plain", vec![])),
        ("GET", ["v1", "health"]) => Ok(respond(200, "application/json", b"{\"ok\":true}".to_vec())),
        ("PUT", ["v1", "campaigns", id]) => store.register(id, body).map(ok_put),
        ("GET", ["v1", "campaigns", id]) => Ok(respond(200, "application/json", store.rules_raw(id)?)),
        ("PUT", ["v1", "campaigns", id, "ledger", seq]) => {
            let seq: u64 = seq.parse().or_else(|_| bad("seq must be a number"))?;
            store.put_entry(id, seq, body).map(ok_put)
        }
        ("GET", ["v1", "campaigns", id, "ledger"]) => {
            let from = query.split('&').find_map(|kv| kv.strip_prefix("from=")).map_or(Ok(0), str::parse::<u64>).or_else(|_| bad("from must be a number"))?;
            Ok(respond(200, "application/json", store.ledger_json(id, from)?))
        }
        ("PUT", ["v1", "campaigns", id, "challenges"]) => store.put_challenge(id, body).map(ok_put),
        ("GET", ["v1", "campaigns", id, "challenges"]) => Ok(respond(200, "application/json", store.challenges_json(id)?)),
        ("PUT", ["v1", "campaigns", id, "final"]) => store.put_final(id, body).map(ok_put),
        ("GET", ["v1", "campaigns", id, "final"]) => Ok(respond(200, "application/json", store.final_raw(id)?)),
        ("PUT", ["v1", "campaigns", id, "heartbeat"]) => store.put_heartbeat(id, body).map(ok_put),
        ("GET", ["v1", "campaigns", id, "heartbeat"]) => Ok(respond(200, "application/json", store.heartbeat_raw(id)?)),
        ("GET", ["v1", "campaigns", id, "head"]) => Ok(respond(200, "application/json", store.head(id)?.into_bytes())),
        ("PUT", ["v1", "campaigns", id, "blobs", hash]) => store.put_blob(id, hash, body).map(ok_put),
        ("GET", ["v1", "campaigns", id, "blobs", hash]) => Ok(respond(200, "application/octet-stream", store.blob(id, hash)?)),
        ("GET", ["v1", "campaigns", id, "tickets", nf]) => Ok(respond(200, "application/octet-stream", store.ticket(id, nf)?)),
        _ => Err(StoreError::NotFound("no such endpoint".into())),
    })();
    result.unwrap_or_else(err_response)
}

/// Requests per minute per source: a token bucket for each source address, refilled continuously.
struct RateLimit {
    per_minute: u32,
    buckets: std::collections::HashMap<String, (f64, std::time::Instant)>,
}

impl RateLimit {
    fn allow(&mut self, source: &str) -> bool {
        if self.per_minute == 0 {
            return true;
        }
        let now = std::time::Instant::now();
        let cap = self.per_minute as f64;
        if self.buckets.len() > 10_000 {
            self.buckets.retain(|_, (_, at)| now.duration_since(*at).as_secs() < 120); // forget sources that went quiet
        }
        let (tokens, at) = self.buckets.entry(source.to_string()).or_insert((cap, now));
        *tokens = (*tokens + now.duration_since(*at).as_secs_f64() * cap / 60.0).min(cap);
        *at = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Where a request comes from: the peer's address, or, when the peer is this computer (a tunnel), the client address the tunnel passes on.
/// `None` for a program on this computer talking to the relay directly (the host publishing, tests): it is not rate-limited.
fn source_of(req: &tiny_http::Request) -> Option<String> {
    let peer = req.remote_addr().map(|a| a.ip());
    if peer.is_none_or(|ip| ip.is_loopback()) {
        return req.headers().iter().find(|h| h.field.equiv("CF-Connecting-IP")).map(|h| h.value.as_str().trim().to_string());
    }
    peer.map(|ip| ip.to_string())
}

/// Serves requests until the server is dropped. One thread per request, at most `max_concurrent` at once; writes take a lock.
pub fn serve(server: Arc<tiny_http::Server>, store: Store) {
    let limits = store.limits.clone();
    let store = Arc::new(Mutex::new(store));
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let rate = Arc::new(Mutex::new(RateLimit { per_minute: limits.per_source_per_minute, buckets: Default::default() }));
    for mut req in server.incoming_requests() {
        use std::sync::atomic::Ordering::SeqCst;
        if source_of(&req).is_some_and(|src| !rate.lock().unwrap_or_else(|p| p.into_inner()).allow(&src)) {
            let _ = req.respond(err_response(StoreError::TooMany("too many requests from this address; wait a minute".into())));
            continue;
        }
        if active.fetch_add(1, SeqCst) >= limits.max_concurrent {
            active.fetch_sub(1, SeqCst);
            let _ = req.respond(err_response(StoreError::Busy("the relay is busy; try again in a moment".into())));
            continue;
        }
        let (store, active, max_body) = (store.clone(), active.clone(), limits.max_body);
        thread::spawn(move || {
            let limit = (max_body + 1) as u64;
            let declared = req.body_length().unwrap_or(0) as u64;
            let mut body = vec![];
            let too_big = declared >= limit || req.as_reader().take(limit).read_to_end(&mut body).map(|n| n as u64 >= limit).unwrap_or(true);
            let method = req.method().as_str().to_string();
            let url = req.url().to_string();
            let resp = if too_big {
                err_response(StoreError::TooLarge("request body too large".into()))
            } else {
                let guard = store.lock().unwrap_or_else(|p| p.into_inner());
                handle(&guard, &method, &url, &body)
            };
            let _ = req.respond(resp);
            active.fetch_sub(1, SeqCst);
        });
    }
}

/// Starts a relay on `listen` (e.g. `127.0.0.1:8787`, or `127.0.0.1:0` for a free port) in a
/// background thread and returns the server handle and its base URL.
pub fn spawn(dir: &Path, listen: &str) -> anyhow::Result<(Arc<tiny_http::Server>, String)> {
    spawn_with(dir, listen, Limits::default())
}

/// `spawn` with the given limits.
pub fn spawn_with(dir: &Path, listen: &str, limits: Limits) -> anyhow::Result<(Arc<tiny_http::Server>, String)> {
    let store = Store::open(dir)?.with_limits(limits);
    let server = Arc::new(tiny_http::Server::http(listen).map_err(|e| anyhow::anyhow!("cannot listen on {listen}: {e}"))?);
    let addr = server.server_addr().to_ip().ok_or_else(|| anyhow::anyhow!("no address"))?;
    let s = server.clone();
    thread::spawn(move || serve(s, store));
    Ok((server, format!("http://{addr}")))
}
