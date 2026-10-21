//! Reading a stranger's relay (PROTOTYPE). The addresses come from records anyone can submit, so every request:
//! - goes only to https (plain http only for loopback, and only with the test flag);
//! - resolves the host itself and refuses it if ANY address is loopback, private, link local, unspecified, multicast, documentation, carrier
//!   grade NAT or otherwise not public (the test flag allows loopback, nothing else); the connection uses only the addresses checked;
//! - follows no redirect; has a connect timeout and a total timeout; reads at most a fixed number of bytes;
//! - refuses addresses with a user name or password in them.

use anyhow::{Result, anyhow, bail, ensure};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct FetchPolicy {
    /// TEST ONLY: allow http to loopback (127.0.0.0/8, ::1). Never on in production.
    pub test_allow_loopback: bool,
    pub connect_timeout: Duration,
    pub total_timeout: Duration,
    pub max_bytes: usize,
}

impl Default for FetchPolicy {
    fn default() -> Self {
        FetchPolicy { test_allow_loopback: false, connect_timeout: Duration::from_secs(5), total_timeout: Duration::from_secs(10), max_bytes: 64 * 1024 }
    }
}

/// Whether an address is one the job must never reach on a stranger's behalf.
pub fn is_forbidden(ip: IpAddr, allow_loopback: bool) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            if v.is_loopback() {
                return !allow_loopback;
            }
            v.is_private() || v.is_link_local() || v.is_unspecified() || v.is_broadcast() || v.is_multicast() || v.is_documentation()
                || o[0] == 0 || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // benchmarking
                || o[0] >= 240
        }
        IpAddr::V6(v) => {
            if v.is_loopback() {
                return !allow_loopback;
            }
            if let Some(v4) = v.to_ipv4_mapped() {
                return is_forbidden(IpAddr::V4(v4), allow_loopback);
            }
            let s = v.segments();
            v.is_unspecified() || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || (s[0] & 0xffc0) == 0xfec0 // site local (old)
                || s[0] == 0x2001 && s[1] == 0x0db8 // documentation
                || s[0] == 0x0064 && s[1] == 0xff9b // NAT64
                || s[0] == 0 // other reserved forms (compat, mapped handled above)
        }
    }
}

/// The scheme, host and port of an address, refused if it is not plain https (or http to loopback with the test flag).
pub fn check_url(url: &str, policy: &FetchPolicy) -> Result<(String, u16)> {
    let (scheme, rest) = url.split_once("://").ok_or_else(|| anyhow!("not an address"))?;
    let https = match scheme {
        "https" => true,
        "http" if policy.test_allow_loopback => false,
        _ => bail!("only https relays can be listed"),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    ensure!(!authority.contains('@'), "a relay address may not carry a user name or password");
    ensure!(!authority.is_empty(), "the relay address has no host");
    let (host, port) = if let Some(h) = authority.strip_prefix('[') {
        let (h, after) = h.split_once(']').ok_or_else(|| anyhow!("bad address"))?;
        let port = after.strip_prefix(':').map(|p| p.parse::<u16>()).transpose().map_err(|_| anyhow!("bad port"))?;
        (h.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p.parse::<u16>().map_err(|_| anyhow!("bad port"))?)),
            None => (authority.to_string(), None),
        }
    };
    let port = port.unwrap_or(if https { 443 } else { 80 });
    if !https {
        // plain http only to loopback, and only in tests
        let ok = host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
        ensure!(ok, "only https relays can be listed");
    }
    Ok((host.to_ascii_lowercase(), port))
}

/// Resolves a host and refuses it if any of its addresses is forbidden (so a name that resolves to both a public and a private address,
/// a common rebinding trick, is refused outright).
pub fn resolve_checked(host: &str, port: u16, policy: &FetchPolicy) -> std::io::Result<Vec<SocketAddr>> {
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs()?.collect();
    if addrs.is_empty() {
        return Err(std::io::Error::other("the relay's host has no address"));
    }
    if let Some(bad) = addrs.iter().find(|a| is_forbidden(a.ip(), policy.test_allow_loopback)) {
        return Err(std::io::Error::other(format!("the relay's host resolves to a private or reserved address ({})", bad.ip())));
    }
    Ok(addrs)
}

/// GETs one address under the policy and returns the body as text.
pub fn get_text(url: &str, policy: &FetchPolicy) -> Result<String> {
    let (host, port) = check_url(url, policy)?;
    // checked before any connection, so a forbidden address never sees a request
    resolve_checked(&host, port, policy).map_err(|e| anyhow!("{e}"))?;
    let p = policy.clone();
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(policy.connect_timeout)
        .timeout(policy.total_timeout)
        .redirects(0)
        .user_agent("clewbook-listing/0 (prototype)")
        // every connection resolves again through the same check (a name that changes its answer between the two lookups is still checked)
        .resolver(move |addr: &str| {
            let (h, port) = addr.rsplit_once(':').ok_or_else(|| std::io::Error::other("bad address"))?;
            let port: u16 = port.parse().map_err(|_| std::io::Error::other("bad port"))?;
            resolve_checked(h.trim_start_matches('[').trim_end_matches(']'), port, &p)
        })
        .build();
    let resp = match agent.get(url).call() {
        Ok(r) => r,
        // a server error (a relay restarting behind its proxy answers 502 to 504) or no connection at all: the relay could not be reached
        // this time, which says nothing about the campaign
        Err(ureq::Error::Status(code, _)) if code >= 500 => return Err(anyhow::Error::new(Unreachable(format!("the relay answered HTTP {code}")))),
        Err(ureq::Error::Status(code, _)) => bail!("the relay answered HTTP {code}"),
        Err(e) => return Err(anyhow::Error::new(Unreachable(format!("the relay could not be read: {}", short(&e.to_string()))))),
    };
    let status = resp.status();
    ensure!(status == 200, "the relay answered HTTP {status}{}", if (300..400).contains(&status) { " (redirects are not followed)" } else { "" });
    if let Some(len) = resp.header("content-length").and_then(|l| l.parse::<usize>().ok()) {
        ensure!(len <= policy.max_bytes, "the relay's answer is too large ({len} bytes)");
    }
    let mut buf = Vec::new();
    resp.into_reader().take(policy.max_bytes as u64 + 1).read_to_end(&mut buf).map_err(|e| anyhow!("the relay's answer could not be read: {}", short(&e.to_string())))?;
    ensure!(buf.len() <= policy.max_bytes, "the relay's answer is too large (over {} bytes)", policy.max_bytes);
    String::from_utf8(buf).map_err(|_| anyhow!("the relay's answer is not text"))
}

/// A read that failed because the other side could not be reached this time (no connection, a timeout, a server error), never because of
/// what it served. The listing keeps a listed campaign through such a miss for a while (`job::KEEP_WHEN_UNREACHABLE_SECS`).
#[derive(Debug)]
pub struct Unreachable(pub String);
impl std::fmt::Display for Unreachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Unreachable {}

fn short(s: &str) -> String {
    s.chars().take(160).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_loopback_and_reserved_addresses_are_forbidden() {
        for a in ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.1.1", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"] {
            assert!(is_forbidden(a.parse().unwrap(), false), "{a}");
        }
        assert!(!is_forbidden("1.1.1.1".parse().unwrap(), false));
        assert!(!is_forbidden("2606:4700::1111".parse().unwrap(), false));
        // the test flag allows loopback only
        assert!(!is_forbidden("127.0.0.1".parse().unwrap(), true));
        assert!(is_forbidden("10.0.0.1".parse().unwrap(), true));
    }

    #[test]
    fn only_https_and_no_credentials() {
        let p = FetchPolicy::default();
        assert!(check_url("http://relay.example.org", &p).is_err());
        assert!(check_url("ftp://relay.example.org", &p).is_err());
        assert!(check_url("https://user:pw@relay.example.org", &p).is_err());
        assert_eq!(check_url("https://Relay.Example.org:8443/x", &p).unwrap(), ("relay.example.org".into(), 8443));
        let t = FetchPolicy { test_allow_loopback: true, ..FetchPolicy::default() };
        assert!(check_url("http://127.0.0.1:9000", &t).is_ok());
        assert!(check_url("http://10.0.0.1:9000", &t).is_err());
    }
}
