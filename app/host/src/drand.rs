//! Round R's signature from drand quicknet (owner decision 1): the four public addresses in turn, and every answer checked against the
//! pinned public key, so a wrong or forged answer from any of them is never used.

use anyhow::{Result, anyhow, bail};
use ll_core::{bid, sealed::{DRAND_URLS, QUICKNET_CHAIN_HASH}};

/// The addresses to ask: the four public ones; in regtest test builds, `CB_DRAND_URLS` (comma separated) instead, so tests stay offline.
pub fn urls() -> Vec<String> {
    #[cfg(feature = "regtest")]
    if let Ok(v) = std::env::var("CB_DRAND_URLS") {
        return v.split(',').map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).collect();
    }
    DRAND_URLS.iter().map(|s| s.to_string()).collect()
}

fn get(base: &str, round: u64) -> Result<Vec<u8>> {
    let url = format!("{base}/{QUICKNET_CHAIN_HASH}/public/{round}");
    let body = ureq::get(&url).timeout(std::time::Duration::from_secs(15)).call().map_err(|e| anyhow!("{e}"))?.into_string()?;
    let v: serde_json::Value = serde_json::from_str(&body)?;
    if v["round"].as_u64() != Some(round) {
        bail!("answered for another round");
    }
    Ok(hex::decode(v["signature"].as_str().ok_or_else(|| anyhow!("no signature"))?)?)
}

/// Round `round`'s signature, from the first address that gives one that checks against the pinned key. Returns it and the address.
pub fn fetch_round(round: u64, urls: &[String]) -> Result<(Vec<u8>, String)> {
    let mut why = vec![];
    for base in urls {
        match get(base, round) {
            Ok(sig) if bid::round_signature_ok(round, &sig) => return Ok((sig, base.clone())),
            Ok(_) => why.push(format!("{base}: the signature does not check against drand quicknet's key, not used")),
            Err(e) => why.push(format!("{base}: {e}")),
        }
    }
    bail!("round {round} is not available yet or no address answered correctly: {}", why.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUND: u64 = 33_187_201;
    const SIG: &str = "943614203a936e3d4ac466aa2b475e9c1e614f4759fe45b7f4bedeb0316d172e6cacadb08a46b39c67c09555dc6db3a5";
    const SIG_1000: &str = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";

    /// A local server that answers every request with `body` (offline: 127.0.0.1 only).
    fn serve(body: String) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr().to_ip().unwrap());
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let _ = req.respond(tiny_http::Response::from_string(body.clone()));
            }
        });
        url
    }

    #[test]
    fn the_first_address_with_a_correct_signature_is_used() {
        let dead = "http://127.0.0.1:1".to_string();
        let forged = serve(format!(r#"{{"round":{ROUND},"signature":"{SIG_1000}"}}"#));
        let wrong_round = serve(format!(r#"{{"round":1000,"signature":"{SIG_1000}"}}"#));
        let good = serve(format!(r#"{{"round":{ROUND},"signature":"{SIG}"}}"#));
        let (sig, from) = fetch_round(ROUND, &[dead.clone(), forged.clone(), wrong_round.clone(), good.clone()]).unwrap();
        assert_eq!((hex::encode(sig), from), (SIG.to_string(), good));
        // nobody answers correctly: no signature, and every reason is given
        let err = fetch_round(ROUND, &[dead, forged, wrong_round]).unwrap_err().to_string();
        assert!(err.contains("does not check against") && err.contains("another round"), "{err}");
    }

    #[test]
    fn the_real_addresses_are_the_four_of_owner_decision_1() {
        if std::env::var("CB_DRAND_URLS").is_err() {
            assert_eq!(urls(), ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"]);
        }
    }
}
