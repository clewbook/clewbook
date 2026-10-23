//! The chain, for the recount (PROTOTYPE): compact blocks and full transactions from a lightwalletd server the operator chooses (never an
//! address from a record), over gRPC-web, exactly the calls the recount page makes (app/web/www/recount.js: GetBlockRange in batches of 100,
//! then GetTransaction for every payment's message and every transaction that spent a campaign note).
//!
//! The scanning and the recount itself are NOT done here: the blocks go into `ll_web::Recount`, the browser's own module (app/web/src/lib.rs,
//! unchanged), which trial-decrypts them with the campaign's viewing key and runs the same `ll_core::recount` as cb-recount and the page.

use anyhow::{Result, anyhow, bail, ensure};
use std::io::Read;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::{Duration, Instant};

/// What one full recount asks of the chain.
#[derive(Clone, Debug)]
pub struct FullRequest {
    pub network: String,
    pub ufvk: String,
    /// Uniform-price auction: the treasury's public viewing key, scanned over the same blocks.
    pub treasury_ufvk: Option<String>,
    pub start: u32,
    pub end: u32,
    pub rules_json: String,
    pub rules_id: String,
    pub ledger_json: String,
    pub challenges_json: String,
}

/// What a scan cost.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ScanStats {
    pub blocks: u32,
    pub actions: u64,
    pub full_txs: u32,
    /// Bytes downloaded from the chain server (compact blocks and full transactions, as sent).
    pub bytes: u64,
}

/// The chain as the job sees it. `GrpcChain` is the real one; tests give their own.
pub trait Chain: Send + Sync {
    /// The current height of `network` ("test" or "main").
    fn tip(&self, network: &str) -> Result<u32>;
    /// The full recount (the viewing key is known): scans `req.start..=req.end` and returns the recount page's report (`report_json`).
    /// Stops with an error once `deadline` has passed.
    fn full_report(&self, req: &FullRequest, deadline: Instant) -> Result<(serde_json::Value, ScanStats)>;
}

/// ll-web is built for the browser: its errors are JavaScript errors, which cannot be made outside a browser (making one panics). So every
/// call is guarded and a panic becomes a plain error.
fn guarded<T>(what: &str, f: impl FnOnce() -> T) -> Result<T> {
    catch_unwind(AssertUnwindSafe(f)).map_err(|_| anyhow!("{what} failed"))
}

pub struct GrpcChain {
    pub test_server: String,
    pub main_server: String,
    /// Seconds one request may take.
    pub request_timeout: Duration,
    /// Largest answer read for one request (100 compact blocks, or one transaction).
    pub max_answer: usize,
}

impl GrpcChain {
    pub fn new(test_server: &str, main_server: &str) -> Self {
        GrpcChain { test_server: test_server.trim_end_matches('/').into(), main_server: main_server.trim_end_matches('/').into(), request_timeout: Duration::from_secs(30), max_answer: 32 << 20 }
    }

    fn server(&self, network: &str) -> Result<&str> {
        match network {
            "test" => Ok(&self.test_server),
            "main" => Ok(&self.main_server),
            n => bail!("unknown network {n:?}"),
        }
    }

    /// One gRPC-web call, tried a second time if the first fails (a public server can be slow for a moment; the recount page also tries
    /// again, on another server). Returns the messages of the answer (one for a plain call, several for a stream) and the bytes read.
    fn call(&self, network: &str, method: &str, request: &[u8]) -> Result<(Vec<Vec<u8>>, u64)> {
        self.call_once(network, method, request).or_else(|_| self.call_once(network, method, request))
    }

    fn call_once(&self, network: &str, method: &str, request: &[u8]) -> Result<(Vec<Vec<u8>>, u64)> {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout(self.request_timeout).redirects(0).build();
        let mut body = vec![0u8];
        body.extend_from_slice(&(request.len() as u32).to_be_bytes());
        body.extend_from_slice(request);
        let resp = agent
            .post(&format!("{}/cash.z.wallet.sdk.rpc.CompactTxStreamer/{method}", self.server(network)?))
            .set("content-type", "application/grpc-web+proto")
            .set("x-grpc-web", "1")
            .send_bytes(&body)
            .map_err(|e| anyhow!("the chain server could not be read ({method}): {e}"))?;
        if let Some(s) = resp.header("grpc-status").filter(|s| *s != "0") {
            bail!("the chain server refused {method} (grpc-status {s}: {})", resp.header("grpc-message").unwrap_or(""));
        }
        let mut buf = vec![];
        resp.into_reader().take(self.max_answer as u64 + 1).read_to_end(&mut buf)?;
        ensure!(buf.len() <= self.max_answer, "the chain server's answer to {method} is larger than {} bytes", self.max_answer);
        let (mut out, mut i) = (vec![], 0);
        while i + 5 <= buf.len() {
            let flag = buf[i];
            let len = u32::from_be_bytes([buf[i + 1], buf[i + 2], buf[i + 3], buf[i + 4]]) as usize;
            let frame = buf.get(i + 5..i + 5 + len).ok_or_else(|| anyhow!("the chain server's answer to {method} is cut short"))?;
            if flag & 0x80 != 0 {
                let t = String::from_utf8_lossy(frame);
                if let Some(s) = t.lines().find_map(|l| l.trim().strip_prefix("grpc-status:")).map(str::trim).filter(|s| *s != "0") {
                    bail!("the chain server refused {method} (grpc-status {s})");
                }
            } else {
                out.push(frame.to_vec());
            }
            i += 5 + len;
        }
        Ok((out, buf.len() as u64))
    }
}

impl Chain for GrpcChain {
    fn tip(&self, network: &str) -> Result<u32> {
        crate::tip::latest_height(self.server(network)?)
    }

    fn full_report(&self, req: &FullRequest, deadline: Instant) -> Result<(serde_json::Value, ScanStats)> {
        let mut rc = guarded("reading the viewing key", || ll_web::Recount::new(&req.network, &req.ufvk))?.map_err(|_| anyhow!("the viewing key could not be read"))?;
        let mut trc = match &req.treasury_ufvk {
            Some(k) => Some(guarded("reading the treasury key", || ll_web::Recount::new(&req.network, k))?.map_err(|_| anyhow!("the treasury key could not be read"))?),
            None => None,
        };
        let mut stats = ScanStats::default();
        let batch = 100u32;
        let mut h = req.start;
        while h <= req.end {
            ensure!(Instant::now() < deadline, "the recount took longer than its time limit (scanned up to block {})", h.saturating_sub(1));
            let to = (h + batch - 1).min(req.end);
            let (blocks, bytes) = self.call(&req.network, "GetBlockRange", &ll_web::block_range_request(h, to))?;
            stats.bytes += bytes;
            ensure!(blocks.len() as u32 == to - h + 1, "the chain server sent {} blocks for {h}..{to}", blocks.len());
            for b in &blocks {
                guarded("scanning a block", || rc.scan_block(b))?.map_err(|_| anyhow!("a block from the chain server could not be scanned"))?;
                if let Some(t) = trc.as_mut() {
                    guarded("scanning a block", || t.scan_block(b))?.map_err(|_| anyhow!("a block from the chain server could not be scanned"))?;
                }
            }
            h = to + 1;
        }
        // the messages of the payments, then the transactions that spent campaign notes (tickets and settlements), as the page does
        let memos = rc.txids_needing_memos();
        let mut txids = memos.clone();
        txids.extend(rc.txids_spending_notes().into_iter().filter(|t| !memos.contains(t)));
        for txid in txids {
            ensure!(Instant::now() < deadline, "the recount took longer than its time limit (reading transactions)");
            let filter = guarded("making a transaction request", || ll_web::tx_filter_request(&txid))?.map_err(|_| anyhow!("bad txid"))?;
            let (raw, bytes) = self.call(&req.network, "GetTransaction", &filter)?;
            stats.bytes += bytes;
            let raw = raw.first().ok_or_else(|| anyhow!("the chain server sent no transaction {txid}"))?;
            guarded("reading a transaction", || rc.add_raw_transaction(raw))?.map_err(|_| anyhow!("transaction {txid} could not be read"))?;
            stats.full_txs += 1;
        }
        // a Blind bid auction: the coins the host sent to the bid pages, for check S3 (set 2, M2; as the recount page does)
        let coins = guarded("listing the coins", || rc.coin_txids(&req.ledger_json))?.map_err(|_| anyhow!("the coin entries could not be read"))?;
        for txid in coins {
            ensure!(Instant::now() < deadline, "the recount took longer than its time limit (reading the coins)");
            let filter = guarded("making a transaction request", || ll_web::tx_filter_request(&txid))?.map_err(|_| anyhow!("bad txid"))?;
            let (raw, bytes) = self.call(&req.network, "GetTransaction", &filter)?;
            stats.bytes += bytes;
            let raw = raw.first().ok_or_else(|| anyhow!("the chain server sent no coin transaction {txid}"))?;
            guarded("reading a coin transaction", || rc.add_coin_transaction(raw))?.map_err(|_| anyhow!("coin transaction {txid} could not be read"))?;
            stats.full_txs += 1;
        }
        stats.blocks = rc.blocks_scanned();
        stats.actions = rc.actions_seen() as u64;
        let treasury = trc.as_ref().map(|t| t.notes_for_report()).unwrap_or_default();
        let report = guarded("the recount", || rc.report_json(&req.rules_json, &req.rules_id, &req.ledger_json, &req.challenges_json, &treasury))?
            .map_err(|_| anyhow!("the recount could not read the campaign's rules or ledger"))?;
        Ok((serde_json::from_str(&report)?, stats))
    }
}
