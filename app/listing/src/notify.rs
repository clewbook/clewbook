//! Telegram notices for the operator (optional). After a pass, the requests that entered the queue since the last notice (testnet ones
//! waiting for approval, and mainnet ones waiting for mainnet listing) go out in one message; and one message says so when the pass has
//! failed three times in a row.
//!
//! The bot token and the chat id are read from a file on the server only (default /etc/clewbook-listing/telegram.conf, mode 600):
//!
//!   token=<bot token>
//!   chat_id=<chat id>
//!
//! (`api=<address>` is for tests: a stand in server on this computer.) Without the file the notices are off. The file is read again for
//! every notice, so a change needs no restart. The token is never logged or printed: an error names only an HTTP status, or says that
//! Telegram could not be reached.
//!
//! At most one message per new request: a request is marked once a message naming it was delivered (or after three failed tries). Several
//! new requests in one pass share one message, and at most `per_hour` messages go out in any hour; requests over that wait for the next
//! message. Sending never holds up a pass: the caller sends from a thread of its own.

use crate::job::{JobConfig, read_list, read_queue, write_atomic};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DEFAULT_CONF: &str = "/etc/clewbook-listing/telegram.conf";
/// A request whose notice failed this many times is not tried again.
const MAX_TRIES: u32 = 3;
/// At most this many requests are spelled out in one message; the rest are counted.
const MAX_LISTED: usize = 10;

#[derive(Clone, Debug)]
pub struct NotifyConfig {
    pub conf: PathBuf,
    pub per_hour: usize,
}

/// A configured bot. Deliberately not `Debug`: it holds the token.
pub struct Telegram {
    api: String,
    token: String,
    chat_id: String,
}

pub enum Conf {
    /// No file: notices are off.
    Off,
    /// A file that cannot be used, and why (never its content).
    Invalid(&'static str),
    On(Telegram),
}

fn token_ok(t: &str) -> bool {
    let Some((id, secret)) = t.split_once(':') else { return false };
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && secret.len() >= 20 && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn chat_ok(c: &str) -> bool {
    let d = c.strip_prefix('-').unwrap_or(c);
    !d.is_empty() && d.len() <= 20 && d.bytes().all(|b| b.is_ascii_digit())
}

/// Reads the conf file: off without it; refused when others can read it or when a line is not as expected.
pub fn load(path: &Path) -> Conf {
    let Ok(meta) = fs::metadata(path) else { return Conf::Off };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Conf::Invalid("the conf file can be read by others; it must be mode 600");
        }
    }
    #[cfg(not(unix))]
    let _ = meta;
    let Ok(text) = fs::read_to_string(path) else { return Conf::Invalid("the conf file cannot be read") };
    let (mut token, mut chat, mut api) = (None, None, "https://api.telegram.org".to_string());
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        match line.split_once('=').map(|(k, v)| (k.trim(), v.trim())) {
            Some(("token", v)) if token_ok(v) => token = Some(v.to_string()),
            Some(("chat_id", v)) if chat_ok(v) => chat = Some(v.to_string()),
            Some(("api", v)) if v.starts_with("https://") || v.starts_with("http://127.0.0.1:") => api = v.trim_end_matches('/').to_string(),
            _ => return Conf::Invalid("a line of the conf file is not token=..., chat_id=... or api=..."),
        }
    }
    match (token, chat) {
        (Some(token), Some(chat_id)) => Conf::On(Telegram { api, token, chat_id }),
        _ => Conf::Invalid("the conf file needs both token= and chat_id="),
    }
}

impl Telegram {
    /// Sends one plain text message. The error says what happened without the address (which holds the token).
    pub fn send(&self, text: &str) -> Result<(), String> {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).redirects(0).build();
        let body = serde_json::json!({ "chat_id": self.chat_id, "text": text, "disable_web_page_preview": true }).to_string();
        match agent.post(&format!("{}/bot{}/sendMessage", self.api, self.token)).set("content-type", "application/json").send_string(&body) {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(code, _)) => Err(format!("Telegram answered HTTP {code}")),
            Err(_) => Err("Telegram could not be reached".into()),
        }
    }
}

/// What the notices remember between passes (state/notify.json): requests already named in a delivered message, failed tries, and when
/// the messages of the last hour went out.
#[derive(Serialize, Deserialize, Default)]
struct State {
    #[serde(default)]
    done: BTreeMap<String, u64>,
    #[serde(default)]
    tries: BTreeMap<String, u32>,
    #[serde(default)]
    sent_at: Vec<u64>,
}

fn state_path(cfg: &JobConfig) -> PathBuf {
    cfg.dir.join("state").join("notify.json")
}

fn read_state(cfg: &JobConfig) -> State {
    fs::read(state_path(cfg)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_state(cfg: &JobConfig, st: &State) -> Vec<String> {
    match serde_json::to_vec_pretty(st).map_err(anyhow::Error::from).and_then(|b| write_atomic(&state_path(cfg), &b)) {
        Ok(()) => vec![],
        Err(e) => vec![format!("telegram: the notice state could not be saved ({e})")],
    }
}

/// The message for new requests (plain text). The approve command is the one the operator runs from the laptop.
pub fn message(items: &[&serde_json::Value], approved: &[String]) -> String {
    let n = items.len();
    let mut out = format!("Clewbook listing: {n} new request{}\n", if n == 1 { "" } else { "s" });
    for (i, q) in items.iter().take(MAX_LISTED).enumerate() {
        let main = q["network"] == "main";
        let fp = q["fingerprint"].as_str().unwrap_or("");
        let key = q["host_pubkey"].as_str().unwrap_or("");
        let is_approved = approved.iter().any(|a| a == key);
        let name: String = q["name"].as_str().map(|s| s.chars().take(60).collect()).unwrap_or_else(|| "(no name)".into());
        out.push_str(&format!("\n{}. {}\nName: {name}\nCampaign: {}\nHost: {fp}\nHost approved: {}\n", i + 1,
            if main { "Mainnet (listed once mainnet listing opens)" } else { "Testnet" },
            q["campaign"].as_str().unwrap_or("").get(..8).unwrap_or(""), if is_approved { "yes" } else { "no" }));
        if is_approved {
            out.push_str("Nothing to do: it waits for mainnet listing to open.\n");
        } else {
            out.push_str(&format!("Approve with:\nssh clewbook-vps \"sudo -u clewbook-listing /opt/clewbook-listing/cb-listing --dir /var/lib/clewbook-listing approve {} --label 'Their label'\"\n",
                fp.replace(' ', "")));
        }
    }
    if n > MAX_LISTED {
        out.push_str(&format!("\nAnd {} more: see the queue on the server.\n", n - MAX_LISTED));
    }
    out
}

/// After a pass: one message for the requests that entered the queue since the last notice, within the hourly cap. Returns the lines to
/// log (never the token).
pub fn after_pass(cfg: &JobConfig, n: &NotifyConfig, now: u64) -> Vec<String> {
    let tg = match load(&n.conf) {
        Conf::Off => return vec![],
        Conf::Invalid(why) => return vec![format!("telegram notices are off: {why}")],
        Conf::On(t) => t,
    };
    let mut st = read_state(cfg);
    let queue = read_queue(cfg).unwrap_or_default();
    let waiting: Vec<&serde_json::Value> = queue.iter().filter(|q| q["kind"] == "approval" || q["kind"] == "mainnet").collect();
    // a request that left the queue (listed, expired, removed) is forgotten: if it comes back, it is new again
    let present: HashSet<String> = waiting.iter().filter_map(|q| q["campaign"].as_str().map(str::to_string)).collect();
    st.done.retain(|id, _| present.contains(id));
    st.tries.retain(|id, _| present.contains(id));
    let new: Vec<&serde_json::Value> = waiting.into_iter().filter(|q| q["campaign"].as_str().is_some_and(|id| !st.done.contains_key(id))).collect();
    let mut log = vec![];
    if !new.is_empty() {
        st.sent_at.retain(|t| now.saturating_sub(*t) < 3600);
        if st.sent_at.len() >= n.per_hour {
            log.push(format!("telegram: {} messages in the last hour already; {} new request(s) wait for the next message", st.sent_at.len(), new.len()));
        } else {
            let approved = read_list(&cfg.dir.join("approved_hosts.txt"));
            let ids: Vec<String> = new.iter().filter_map(|q| q["campaign"].as_str().map(str::to_string)).collect();
            match tg.send(&message(&new, &approved)) {
                Ok(()) => {
                    for id in &ids {
                        st.done.insert(id.clone(), now);
                        st.tries.remove(id);
                    }
                    st.sent_at.push(now);
                    log.push(format!("telegram: sent a notice for {} new request(s)", ids.len()));
                }
                Err(e) => {
                    let mut gave_up = 0;
                    for id in &ids {
                        let t = st.tries.entry(id.clone()).or_default();
                        *t += 1;
                        if *t >= MAX_TRIES {
                            st.done.insert(id.clone(), now);
                            gave_up += 1;
                        }
                    }
                    log.push(format!("telegram: {e}; {} request(s) are tried again on the next pass{}", ids.len() - gave_up,
                        if gave_up > 0 { format!(", {gave_up} given up after {MAX_TRIES} tries") } else { String::new() }));
                }
            }
        }
    }
    log.extend(save_state(cfg, &st));
    log
}

/// One message about the listing itself (the pass failing again and again), within the same hourly cap.
pub fn alert(cfg: &JobConfig, n: &NotifyConfig, now: u64, text: &str) -> Vec<String> {
    let tg = match load(&n.conf) {
        Conf::Off => return vec![],
        Conf::Invalid(why) => return vec![format!("telegram notices are off: {why}")],
        Conf::On(t) => t,
    };
    let mut st = read_state(cfg);
    st.sent_at.retain(|t| now.saturating_sub(*t) < 3600);
    if st.sent_at.len() >= n.per_hour {
        return vec!["telegram: hourly limit reached; the alert was not sent".into()];
    }
    let mut log = match tg.send(text) {
        Ok(()) => {
            st.sent_at.push(now);
            vec!["telegram: sent an alert".to_string()]
        }
        Err(e) => vec![format!("telegram: {e}; the alert was not sent")],
    };
    log.extend(save_state(cfg, &st));
    log
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const TOKEN: &str = "123456789:TESTtokenTESTtokenTESTtoken_abc";

    /// A stand in for the Telegram API on this computer: records each request (path and body) and answers with `status`.
    fn stand_in(status: u16) -> (String, Arc<Mutex<Vec<(String, String)>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", server.server_addr());
        let seen = Arc::new(Mutex::new(vec![]));
        let s = seen.clone();
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                s.lock().unwrap().push((req.url().to_string(), body));
                let _ = req.respond(tiny_http::Response::from_string("{\"ok\":true}").with_status_code(status));
            }
        });
        (addr, seen)
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ll-notify-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("out")).unwrap();
        d
    }

    fn conf(dir: &Path, api: &str, mode: u32) -> NotifyConfig {
        let p = dir.join("telegram.conf");
        fs::write(&p, format!("# test\ntoken={TOKEN}\nchat_id=4242\napi={api}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
        }
        NotifyConfig { conf: p, per_hour: 20 }
    }

    fn item(id_char: char, network: &str, name: &str, key_char: char) -> serde_json::Value {
        let key: String = std::iter::repeat_n(key_char, 64).collect();
        serde_json::json!({ "kind": if network == "main" { "mainnet" } else { "approval" }, "campaign": std::iter::repeat_n(id_char, 64).collect::<String>(),
            "network": network, "name": name, "host_pubkey": key, "fingerprint": crate::record::fingerprint(&key) })
    }

    fn set_queue(dir: &Path, items: &[serde_json::Value]) {
        fs::write(dir.join("out/queue.json"), serde_json::to_vec(items).unwrap()).unwrap();
    }

    fn no_token(log: &[String]) -> bool {
        log.iter().all(|l| !l.contains(TOKEN) && !l.contains("TESTtoken"))
    }

    #[test]
    fn no_file_means_off_and_a_loose_or_odd_file_is_refused() {
        let d = scratch("off");
        let cfg = JobConfig::new(&d);
        set_queue(&d, &[item('a', "test", "Garden Fund", '1')]);
        assert!(after_pass(&cfg, &NotifyConfig { conf: d.join("missing.conf"), per_hour: 20 }, 1000).is_empty());
        let (api, seen) = stand_in(200);
        let loose = conf(&d, &api, 0o644);
        let log = after_pass(&cfg, &loose, 1000);
        assert!(log[0].contains("must be mode 600") && no_token(&log), "{log:?}");
        fs::write(&loose.conf, "token=not-a-token\nchat_id=1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&loose.conf, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let log = after_pass(&cfg, &loose, 1000);
        assert!(log[0].contains("is not token=") && !log[0].contains("not-a-token"), "{log:?}");
        assert!(seen.lock().unwrap().is_empty(), "nothing was sent");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn new_requests_go_out_in_one_message_once_each() {
        let d = scratch("batch");
        let cfg = JobConfig::new(&d);
        let (api, seen) = stand_in(200);
        let n = conf(&d, &api, 0o600);
        let main_key: String = std::iter::repeat_n('2', 64).collect();
        fs::write(d.join("approved_hosts.txt"), format!("{main_key} Harbour Collective\n")).unwrap();
        set_queue(&d, &[item('a', "test", "Garden Fund", '1'), item('b', "main", "Harbour Fund", '2'),
                        serde_json::json!({ "kind": "attention", "campaign": "c".repeat(64), "network": "test" })]);
        let log = after_pass(&cfg, &n, 1000);
        assert_eq!(log, vec!["telegram: sent a notice for 2 new request(s)".to_string()]);
        let msgs = seen.lock().unwrap().clone();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].0, format!("/bot{TOKEN}/sendMessage"));
        let body: serde_json::Value = serde_json::from_str(&msgs[0].1).unwrap();
        assert_eq!(body["chat_id"], "4242");
        let text = body["text"].as_str().unwrap();
        let fp1 = crate::record::fingerprint(&"1".repeat(64));
        for want in ["Clewbook listing: 2 new requests", "1. Testnet", "Name: Garden Fund", "Campaign: aaaaaaaa", &format!("Host: {fp1}"), "Host approved: no",
                     &format!("approve {} --label 'Their label'", fp1.replace(' ', "")), "2. Mainnet (listed once mainnet listing opens)", "Name: Harbour Fund",
                     "Host approved: yes", "Nothing to do: it waits for mainnet listing to open."] {
            assert!(text.contains(want), "{want:?} in {text}");
        }
        assert!(!text.contains("cccccccc"), "an attention item is not a new request");
        // plain text: no em or en dash, and no hyphen outside the command to copy
        assert!(!text.contains('—') && !text.contains('–'));
        assert!(text.lines().filter(|l| !l.starts_with("ssh ")).all(|l| !l.contains('-')), "{text}");
        // the next pass: nothing new, nothing sent; a third request: one message naming only it
        assert!(after_pass(&cfg, &n, 1100).is_empty());
        set_queue(&d, &[item('a', "test", "Garden Fund", '1'), item('b', "main", "Harbour Fund", '2'), item('e', "test", "Orchard Fund", '3')]);
        after_pass(&cfg, &n, 1200);
        let msgs = seen.lock().unwrap().clone();
        assert_eq!(msgs.len(), 2);
        let t2: serde_json::Value = serde_json::from_str(&msgs[1].1).unwrap();
        let t2 = t2["text"].as_str().unwrap();
        assert!(t2.contains("1 new request\n") && t2.contains("Orchard Fund") && !t2.contains("Garden Fund"), "{t2}");
        // a request that left the queue and comes back is new again
        set_queue(&d, &[]);
        after_pass(&cfg, &n, 1300);
        set_queue(&d, &[item('a', "test", "Garden Fund", '1')]);
        after_pass(&cfg, &n, 1400);
        assert_eq!(seen.lock().unwrap().len(), 3);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_hourly_cap_holds_back_and_a_flood_is_counted_not_spelled_out() {
        let d = scratch("cap");
        let cfg = JobConfig::new(&d);
        let (api, seen) = stand_in(200);
        let mut n = conf(&d, &api, 0o600);
        n.per_hour = 1;
        set_queue(&d, &[item('a', "test", "One", '1')]);
        after_pass(&cfg, &n, 10_000);
        let flood: Vec<serde_json::Value> = "bcdef0123456".chars().enumerate().map(|(i, c)| item(c, "test", &format!("Flood {i}"), '9')).collect();
        let mut all = vec![item('a', "test", "One", '1')];
        all.extend(flood);
        set_queue(&d, &all);
        let log = after_pass(&cfg, &n, 10_100);
        assert!(log[0].contains("1 messages in the last hour already; 12 new request(s) wait"), "{log:?}");
        assert_eq!(seen.lock().unwrap().len(), 1);
        // an hour later the waiting requests go out in one message: ten spelled out, the rest counted
        after_pass(&cfg, &n, 10_000 + 3600);
        let msgs = seen.lock().unwrap().clone();
        assert_eq!(msgs.len(), 2);
        let t: serde_json::Value = serde_json::from_str(&msgs[1].1).unwrap();
        let t = t["text"].as_str().unwrap();
        assert!(t.starts_with("Clewbook listing: 12 new requests") && t.contains("10. Testnet") && !t.contains("11. ") && t.contains("And 2 more"), "{t}");
        assert!(t.chars().count() < 4096, "within Telegram's message size");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn telegram_down_is_logged_without_the_token_retried_then_given_up() {
        let d = scratch("down");
        let cfg = JobConfig::new(&d);
        let (api, seen) = stand_in(500);
        let n = conf(&d, &api, 0o600);
        set_queue(&d, &[item('a', "test", "Garden Fund", '1')]);
        for (i, t) in [1000u64, 1100, 1200].iter().enumerate() {
            let log = after_pass(&cfg, &n, *t);
            assert!(log[0].starts_with("telegram: Telegram answered HTTP 500") && no_token(&log), "{log:?}");
            if i == 2 {
                assert!(log[0].contains("given up after 3 tries"), "{log:?}");
            }
        }
        assert_eq!(seen.lock().unwrap().len(), 3);
        assert!(after_pass(&cfg, &n, 1300).is_empty(), "given up: not tried a fourth time");
        assert_eq!(seen.lock().unwrap().len(), 3);
        // nothing listens: logged, without the token, and quickly
        let gone = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
        let n2 = conf(&d, &format!("http://127.0.0.1:{gone}"), 0o600);
        set_queue(&d, &[item('b', "test", "Other Fund", '2')]);
        let start = std::time::Instant::now();
        let log = after_pass(&cfg, &n2, 2000);
        assert!(log[0].starts_with("telegram: Telegram could not be reached") && no_token(&log), "{log:?}");
        assert!(start.elapsed() < Duration::from_secs(12));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_alert_goes_out_within_the_same_cap() {
        let d = scratch("alert");
        let cfg = JobConfig::new(&d);
        let (api, seen) = stand_in(200);
        let mut n = conf(&d, &api, 0o600);
        n.per_hour = 1;
        assert_eq!(alert(&cfg, &n, 5000, "Clewbook listing: the pass failed 3 times in a row"), vec!["telegram: sent an alert".to_string()]);
        assert!(alert(&cfg, &n, 5001, "again")[0].contains("hourly limit"));
        assert_eq!(seen.lock().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&d);
    }
}
