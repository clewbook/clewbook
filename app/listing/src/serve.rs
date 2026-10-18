//! The submission endpoint: POST /v1/records with one listing record; GET /v1/records/<campaign id> (the request's state and a plain reason
//! from the last pass, nothing else); GET /v1/health (200 with the time and block of the last good pass, 503 when there was none in the
//! last three intervals). Every request counts toward the same per source limit.
//!
//! It only accepts and stores: the size (at most 4 KB, read no further), the shape and both signatures are checked, and the caps applied. It never
//! fetches anything because of a request: the relays named in records are read by the periodic pass, at most once per record per pass, so the
//! endpoint cannot be used to make this server send requests to other addresses on demand. One request at a time; per source address at most
//! `per_minute` requests (the address the tunnel passes on is trusted only when the peer is this computer, as in the relay; a request from this
//! computer without it counts as the one source "local").

use crate::job::{JobConfig, run_pass_with, submit};
use crate::record::MAX_RECORD_BYTES;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn source_of(req: &tiny_http::Request) -> Option<String> {
    let peer = req.remote_addr().map(|a| a.ip());
    if peer.is_none_or(|ip| ip.is_loopback()) {
        let passed_on = req.headers().iter().find(|h| h.field.equiv("CF-Connecting-IP")).map(|h| h.value.as_str().trim().chars().take(64).collect::<String>());
        return Some(passed_on.filter(|a| !a.is_empty()).unwrap_or_else(|| "local".into()));
    }
    peer.map(|ip| ip.to_string())
}

fn json(code: u16, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    json_value(code, serde_json::json!({ "message": body }))
}

fn json_value(code: u16, v: serde_json::Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let v = v.to_string();
    tiny_http::Response::from_data(v.into_bytes())
        .with_status_code(code)
        .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
        .with_header(tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap())
}

/// The chain heights for one pass: every allowed network is read first (a pass is skipped if one cannot be), any other network (a fixed
/// entry's, for its recount) only when it is needed, and each at most once per pass.
pub fn pass_tips(cfg: &JobConfig, tip: &(dyn Fn(&str) -> anyhow::Result<u32> + Send + Sync)) -> anyhow::Result<impl Fn(&str) -> Option<u32>> {
    let mut known = HashMap::new();
    for n in &cfg.allowed_networks {
        known.insert(n.clone(), Some(tip(n).map_err(|e| anyhow::anyhow!("the chain height of network {n:?} could not be read ({e:#})"))?));
    }
    let known = Mutex::new(known);
    Ok(move |n: &str| {
        let mut k = known.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(t) = k.get(n) {
            return *t;
        }
        let t = tip(n).ok();
        k.insert(n.to_string(), t);
        t
    })
}

/// Serves submissions until the process stops, and runs a pass every `interval` in a thread of its own (`tip` gives a network's height).
pub fn serve(cfg: JobConfig, listen: &str, per_minute: u32, interval: Duration, tip: Arc<dyn Fn(&str) -> anyhow::Result<u32> + Send + Sync>) -> anyhow::Result<()> {
    let server = tiny_http::Server::http(listen).map_err(|e| anyhow::anyhow!("cannot listen on {listen}: {e}"))?;
    println!("listing endpoint on http://{}", server.server_addr());
    // submissions are handled one at a time. A pass does not wait for them, nor they for a pass (its recounts can take minutes): a submission
    // only adds a file under records/, which a pass reads at its start; a pass writes only state/ and out/
    let lock = Arc::new(Mutex::new(()));
    // the last good pass: when (unix seconds), at which block, and its summary
    let last: Arc<Mutex<Option<(u64, u32, String)>>> = Arc::new(Mutex::new(None));
    {
        let (cfg, tip, last) = (cfg.clone(), tip.clone(), last.clone());
        std::thread::spawn(move || loop {
            match pass_tips(&cfg, tip.as_ref()) {
                Ok(tips) => {
                    let t = cfg.allowed_networks.first().and_then(|n| tips(n)).unwrap_or(0);
                    match run_pass_with(&cfg, &tips, crate::host::now_secs()) {
                        Ok(s) => {
                            let summary = crate::job::describe(&s);
                            println!("pass at block {t}: {summary}");
                            *last.lock().unwrap_or_else(|p| p.into_inner()) = Some((crate::host::now_secs(), t, summary));
                        }
                        Err(e) => println!("pass failed: {e:#}"),
                    }
                }
                Err(e) => println!("pass skipped: {e:#}"),
            }
            std::thread::sleep(interval);
        });
    }
    let mut buckets: HashMap<String, (Instant, u32)> = HashMap::new();
    for mut req in server.incoming_requests() {
        if let Some(src) = source_of(&req) {
            let now = Instant::now();
            buckets.retain(|_, (t, _)| now.duration_since(*t) < Duration::from_secs(60));
            let e = buckets.entry(src).or_insert((now, 0));
            e.1 += 1;
            if e.1 > per_minute {
                let _ = req.respond(json(429, "too many requests from this address; wait a minute"));
                continue;
            }
        }
        let resp = match (req.method().as_str(), req.url()) {
            ("GET", "/v1/health") => {
                let now = crate::host::now_secs();
                match last.lock().unwrap_or_else(|p| p.into_inner()).clone() {
                    Some((at, t, summary)) if now.saturating_sub(at) <= 3 * interval.as_secs() + 60 =>
                        json_value(200, serde_json::json!({ "message": "ok", "last_pass": at, "block": t, "summary": summary })),
                    Some((at, t, _)) => json_value(503, serde_json::json!({ "message": "no good pass recently", "last_pass": at, "block": t })),
                    None => json(503, "no good pass yet"),
                }
            }
            ("POST", "/v1/records") => {
                let declared = req.body_length().unwrap_or(0);
                let mut body = vec![];
                let too_big = declared > MAX_RECORD_BYTES
                    || req.as_reader().take(MAX_RECORD_BYTES as u64 + 1).read_to_end(&mut body).map(|n| n > MAX_RECORD_BYTES).unwrap_or(true);
                if too_big {
                    json(413, "a listing record is at most 4096 bytes")
                } else {
                    let _g = lock.lock().unwrap_or_else(|p| p.into_inner());
                    match submit(&cfg, &body) {
                        Ok(msg) => json(202, &format!("{msg}; it is checked on the next pass")),
                        Err(e) => json(400, &e.to_string()),
                    }
                }
            }
            ("GET", url) if url.starts_with("/v1/records/") => match crate::job::record_status(&cfg, &url["/v1/records/".len()..]) {
                Some((state, reason)) => json_value(200, serde_json::json!({ "state": state, "reason": reason })),
                None => json_value(404, serde_json::json!({ "state": "Not found", "reason": "the listing server has no request for this campaign" })),
            },
            _ => json(404, "no such endpoint"),
        };
        let _ = req.respond(resp);
    }
    Ok(())
}
