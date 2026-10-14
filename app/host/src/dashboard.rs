//! Host dashboard backend (`cb-host serve`). Local only: it listens on 127.0.0.1, refuses requests
//! that do not come from its own page, runs a watcher for every campaign it manages, and answers
//! the dashboard page with a small JSON API. All messages are written for the person running the
//! campaign, in plain words.

use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Result, anyhow};
use ll_core::{
    receiver::{network_type, orchard_receiver},
    recount::{close_entry, recount},
    walletdb,
};
use serde_json::{Value, json};

use super::*;

const WATCH_EVERY: Duration = Duration::from_secs(15);
/// The smallest contribution a campaign may ask for: twice the refund fee.
const MIN_FLOOR_ZAT: u64 = 20_000;

pub struct Config {
    pub runs_dir: PathBuf,
    pub www: PathBuf,
    pub listen: String,
    pub network: String,
    pub backend: String,
    pub devtool: PathBuf,
    pub relays: Vec<String>,
    pub page_base: String,
    pub server: String,
    pub nu7_mainnet_height: Option<u32>,
}

#[derive(Default, Clone)]
struct Pass {
    at: Option<u64>,
    ok: bool,
    error: Option<String>,
    tip: Option<u32>,
    branch: Option<String>,
    relays: Vec<(String, std::result::Result<usize, String>)>,
}

struct Campaign {
    id: String,
    run: Run,
    cfg: RunConfig,
    backend: Mutex<Box<dyn WalletBackend + Send>>,
    pass: Mutex<Pass>,
    last_close: Mutex<Vec<String>>,
    closing: AtomicBool,
    /// One host process per campaign folder (the dashboard holds it while it runs).
    _lock: crate::lock::RunLock,
}

struct State {
    cfg: Config,
    campaigns: Mutex<Vec<Arc<Campaign>>>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Turns a technical error into a sentence a campaign host can act on.
fn plain_error(e: &anyhow::Error) -> String {
    let text = format!("{e:#}");
    let lower = text.to_lowercase();
    if ["connect", "unreachable", "timed out", "timeout", "transport", "dns", "tls"].iter().any(|k| lower.contains(k)) {
        "the program could not reach the network server".to_string()
    } else {
        text.lines().next().unwrap_or("something went wrong").chars().take(240).collect()
    }
}

// ---------- campaigns ----------

fn load_campaign(dir: &Path) -> Result<Arc<Campaign>> {
    let run_lock = crate::lock::RunLock::acquire(dir, "dashboard")?;
    let run = Run::load(dir)?;
    let cfg = crate::load_config(dir)?;
    let c = Arc::new(Campaign {
        id: run.rules_id.clone(),
        backend: Mutex::new(backend_for(dir)?),
        run,
        cfg,
        pass: Mutex::new(Pass::default()),
        last_close: Mutex::new(vec![]),
        closing: AtomicBool::new(false),
        _lock: run_lock,
    });
    let w = c.clone();
    thread::spawn(move || loop {
        let res = {
            let mut b = lock(&w.backend);
            watch_once(&w.run, b.as_mut(), None)
        };
        {
            let mut p = lock(&w.pass);
            p.at = Some(now());
            match res {
                Ok(info) => {
                    p.ok = true;
                    p.error = None;
                    p.tip = Some(info.tip);
                    p.branch = Some(info.branch);
                    p.relays = info.relays;
                }
                Err(e) => {
                    p.ok = false;
                    p.error = Some(plain_error(&e));
                }
            }
        }
        thread::sleep(WATCH_EVERY);
    });
    Ok(c)
}

fn find(st: &State, id: &str) -> Option<Arc<Campaign>> {
    lock(&st.campaigns).iter().find(|c| c.id == id).cloned()
}

fn run_with_timeout(mut cmd: Command, secs: u64) -> bool {
    let Ok(mut child) = cmd.stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null()).spawn() else { return false };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return s.success(),
            Ok(None) if start.elapsed() > Duration::from_secs(secs) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => thread::sleep(Duration::from_millis(300)),
            Err(_) => return false,
        }
    }
}

/// Makes the campaign's own wallet (a new account used for this campaign only). The public test
/// server stalls now and then, so each attempt gets a fresh folder and a time limit.
fn init_wallet(devtool: &Path, run_dir: &Path, network: &str) -> Result<PathBuf> {
    init_named_wallet(devtool, run_dir, network, "wallet", "campaign")
}

/// A new wallet `<folder><n>` (with its key file `<folder><n>.age`) inside the campaign folder, named `name` inside the wallet tool.
fn init_named_wallet(devtool: &Path, run_dir: &Path, network: &str, folder: &str, name: &str) -> Result<PathBuf> {
    for n in 1..=4 {
        let w = run_dir.join(format!("{folder}{n}"));
        let mut cmd = Command::new(devtool);
        cmd.args(["wallet", "-w"]).arg(&w).args(["init", "--name", name, "-i"]).arg(run_dir.join(format!("{folder}{n}.age"))).args(["-n", if network == "main" { "main" } else { "test" }]);
        if run_with_timeout(cmd, 45) && w.join("data.sqlite").exists() {
            return Ok(w);
        }
    }
    Err(anyhow!("The network server did not answer, so the campaign's wallet could not be created. Please try again in a minute."))
}

fn parse_create(st: &State, body: &Value) -> Result<(String, Option<u64>, Option<u32>, u32, u64, Vec<String>, u32)> {
    let mode = body["mode"].as_str().unwrap_or("");
    let uint = |k: &str| body[k].as_u64();
    let (goal, items) = match mode {
        "raise" => match uint("goal_zat") {
            Some(g) if g >= 1 => (Some(g), None),
            _ => bail!("Please enter a goal above zero."),
        },
        "auction" => match uint("items") {
            Some(n) if (1..=1000).contains(&n) => (None, Some(n as u32)),
            _ => bail!("Please enter how many items are for sale (1 to 1000)."),
        },
        _ => bail!("Please choose a fundraiser or an auction."),
    };
    let deadline_in = match uint("deadline_in") {
        Some(d) if (20..=2_000_000).contains(&d) => d as u32,
        _ => bail!("The deadline must be at least 20 blocks from now."),
    };
    let min = match uint("min_contribution_zat") {
        Some(m) if m >= MIN_FLOOR_ZAT => m,
        _ => bail!("The smallest contribution must be at least 0.0002 (twice the refund fee), or a refund would leave nothing."),
    };
    let ticket_k = match body.get("ticket_k") {
        None | Some(Value::Null) => ll_core::rules::DEFAULT_TICKET_K,
        Some(v) => match v.as_u64() {
            Some(k) if (ll_core::rules::MIN_TICKET_K as u64..=ll_core::rules::MAX_TICKET_K as u64).contains(&k) => k as u32,
            _ => bail!("The ticket window must be a whole number of blocks from {} to {}.", ll_core::rules::MIN_TICKET_K, ll_core::rules::MAX_TICKET_K),
        },
    };
    let mut relays: Vec<String> = body["relays"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    if relays.is_empty() {
        relays = st.cfg.relays.clone();
    }
    if relays.iter().any(|r| !(r.starts_with("http://") || r.starts_with("https://"))) {
        bail!("Each relay address must start with http:// or https://.");
    }
    Ok((mode.to_string(), goal, items, deadline_in, min, relays, ticket_k))
}

/// The optional public name from the set-up form: blank means none. Checked before anything is created.
fn parse_name(body: &Value) -> Result<Option<String>> {
    let name = match body.get("name") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) => s.trim(),
        Some(_) => bail!("The campaign name must be text."),
    };
    if name.is_empty() {
        return Ok(None);
    }
    ll_core::rules::check_name(name).map_err(|e| anyhow!("The campaign name cannot be used: {e}."))?;
    Ok(Some(name.to_string()))
}

fn create_campaign(st: &State, body: &Value) -> Result<Value> {
    let (mode, goal, items, deadline_in, min, relays, ticket_k) = parse_create(st, body)?;
    let name = parse_name(body)?;
    // the real network: the host must have confirmed it, and the campaign must be over well before the NU7 upgrade (checked again with the chain height inside create)
    let confirmed = body["confirm_mainnet"].as_bool() == Some(true);
    crate::mainnet::require_confirmation(&st.cfg.network, confirmed)?;
    crate::mainnet::nu7_guard(&st.cfg.network, None, crate::mainnet::blocks_needed(deadline_in, ticket_k), now(), st.cfg.nu7_mainnet_height)?;
    let dir = st.cfg.runs_dir.join(format!("campaign-{}", now()));
    crate::make_private_dir(&dir)?; // created closed (700) before the wallet tool writes the wallet and its key file into it
    let wallet = init_wallet(&st.cfg.devtool, &dir, &st.cfg.network)?;
    let identity = PathBuf::from(format!("{}.age", wallet.display()));
    let cfg = RunConfig { backend: st.cfg.backend.clone(), devtool: st.cfg.devtool.clone(), wallet, identity, min_confirmations: None };
    // fundraisers only: the host may close before the deadline once the goal is met (an auction never can)
    let early_close = mode == "raise" && body["early_close"].as_bool() == Some(true);
    // fundraisers only: an optional hard cap, at least the goal (checked before anything is created; a cap below twice the goal is allowed, with a warning)
    let cap_zat = match (mode.as_str(), body.get("cap_zat")) {
        (_, None | Some(Value::Null)) => None,
        ("raise", Some(v)) => match v.as_u64() {
            Some(c) if goal.is_none_or(|g| c >= g) => Some(c),
            _ => bail!("The hard cap must be a whole amount at least as large as the soft cap (the goal)."),
        },
        _ => bail!("Only a fundraiser can have a hard cap."),
    };
    // an auction: "uniform" (every winner pays the lowest winning bid, the rest goes back) when the request says so, which the set-up
    // page does by default; a request without it makes a pay-your-bid auction, as before. The winners' payments go to a treasury: a
    // wallet of its own made here, inside the campaign folder, because its viewing key is published for the recount (R9 to R11).
    let uniform = match (mode.as_str(), body["pricing"].as_str()) {
        ("auction", Some("uniform")) => {
            let reserve_zat = body["reserve_zat"].as_u64().filter(|r| *r > 0).ok_or_else(|| anyhow!("Please enter a reserve price above zero for a uniform price auction."))?;
            let tw = init_named_wallet(&st.cfg.devtool, &dir, &st.cfg.network, "treasury", "treasury")?;
            let ti = PathBuf::from(format!("{}.age", tw.display()));
            let account = crate::libs::LibsBackend::new(tw, ti)?.account()?;
            Some(crate::Uniform { reserve_zat, treasury_address: account.address, treasury_ufvk: account.ufvk })
        }
        ("auction", None | Some("pay_your_bid")) => None,
        ("auction", Some(other)) => bail!("Unknown auction pricing {other:?}."),
        _ => None,
    };
    create(&dir, cfg, &st.cfg.network, &mode, goal, items, deadline_in, &relays, Some(min), uniform, ticket_k, crate::MainnetCheck { confirmed, nu7_height: st.cfg.nu7_mainnet_height }, name, early_close, cap_zat)
        .map_err(|e| anyhow!("The campaign could not be created: {}", plain_error(&e)))?;
    let c = load_campaign(&dir)?;
    let id = c.id.clone();
    let warning = c.run.rules.cap_warning();
    lock(&st.campaigns).push(c);
    Ok(json!({ "ok": true, "id": id, "warning": warning }))
}

/// The exact command that points a campaign folder at the relay address the dashboard runs with (no restart is needed: the host reads the file on every check).
fn relay_fix_hint(current: Option<&str>, folder: &Path) -> String {
    match current {
        Some(addr) => format!("To publish to {addr} instead, run in the project folder: `./run.sh set-relay {addr} {} --yes`. No restart is needed for this campaign; the next check publishes there.", shell_word(&folder.display().to_string())),
        None => format!("The dashboard was started without a relay address, so there is nothing to point at: start it with --relay <address>, or run `./run.sh set-relay <address that answers> {} --yes`.", shell_word(&folder.display().to_string())),
    }
}

/// The note about payments that have no refund ticket yet, before the campaign is closed: none, a quiet "waiting" note (normal for a minute), or a
/// warning when the allowed window has passed. `late`: payments more than `k` blocks old without a ticket; `waiting`: newer ones.
/// The warning for a payment the program has failed to ticket many checks in a row (a failure on the host's side).
pub(crate) fn skip_warning(key: &str, value_zat: Option<u64>, passes: u64, reason: &str) -> String {
    let amount = value_zat.map(|v| format!(", {}.{:08}", v / 100_000_000, v % 100_000_000)).unwrap_or_default();
    format!(
        "The payment {key}{amount} has had no refund ticket for the last {passes} checks in a row. The reason each time: {reason}. \
         What you can do: check that this computer can reach the network (the last network check above should be recent); stopping and \
         starting this program is safe. If the same reason keeps coming back, this program cannot build a ticket for that payment: do not \
         close yet (the close would stop anyway), keep the program running, and send the reason to the Clewbook project. Do not move this \
         payment out of the wallet by hand."
    )
}

fn ticket_note(late: usize, waiting: usize, k: u64, closed: bool) -> Option<(&'static str, String)> {
    if closed {
        return None;
    }
    if late > 0 {
        return Some(("bad", format!("{late} payment(s) have no refund ticket, although more than {k} blocks have passed. The public check will flag them (R4: no ticket). Check that this program is running and its \"last network check\" is recent. When you close the campaign it first tries to issue these tickets (late) and then refunds or sweeps as usual; if it cannot, it stops before writing anything and lists the payments, so nothing is left in the wallet without a way to refund it. Do not close from another program meanwhile.")));
    }
    if waiting > 0 {
        return Some(("info", format!("{waiting} payment(s) are waiting for their refund ticket; the program issues them on its next check (normally within a minute). Wait for this note to go before closing.")));
    }
    None
}

/// Quotes one word for a shell command line only when it needs it.
fn shell_word(a: &str) -> String {
    if !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c)) { a.to_string() } else { format!("'{}'", a.replace('\'', "'\\''")) }
}

/// What to do when this program stops looking at the network: the exact command it was started with, and the helper script.
fn restart_hint(args: &[String], pid: u32, campaign: &Path) -> String {
    let cmd = args.iter().map(|a| shell_word(a)).collect::<Vec<_>>().join(" ");
    format!(
        "To restart it (this program also watches the campaign folder {}): if you started it with the project's helper, run `./run.sh restart dashboard` in the project folder; otherwise stop it (`kill {pid}`) and start it again with exactly this command: {cmd}. Then reload this page: \"Last network check\" should say a few seconds ago and this warning should be gone.",
        campaign.display()
    )
}

// ---------- status ----------

fn warn(level: &str, text: impl Into<String>) -> Value {
    json!({ "level": level, "text": text.into() })
}

fn status(st: &State, c: &Campaign) -> Value {
    let rules = &c.run.rules;
    let entries = c.run.ledger().load().unwrap_or_default();
    let wnotes = walletdb::read_notes(&c.cfg.wallet.join("data.sqlite")).unwrap_or_default();
    let notes = chain_notes(&wnotes);
    let pass = lock(&c.pass).clone();
    let tip = pass.tip.or_else(|| walletdb::scanned_height(&c.cfg.wallet.join("data.sqlite")).ok().flatten());
    let a = analyze(rules, &c.run.rules_id, &entries, &notes, &[]);
    let closed = close_entry(&entries).cloned();
    let k = rules.ticket_k as u64;
    let deadline = rules.deadline_height as u64;

    // locks: every unspent, ticketed contribution should be locked in the wallet
    let unspent: Vec<_> = a.contributions.iter().filter(|n| n.spent_by.is_none() && n.nf.as_ref().is_some_and(|nf| a.tickets.contains_key(nf))).collect();
    let held = unspent
        .iter()
        .filter(|n| wnotes.iter().any(|w| w.note.txid == n.txid && w.note.action == n.action && w.lock_owner.is_some()))
        .count();
    let raised: u64 = a.contributions.iter().map(|n| n.value_zat).sum();
    let rejects = entries.iter().filter(|e| e.kind == "reject").count();
    let reissues = entries.iter().filter(|e| e.kind == "reissue").count();
    let phase = match (tip, &closed) {
        (_, Some(_)) => "closed",
        (None, None) => "unknown",
        (Some(t), None) if (t as u64) <= deadline => "open",
        _ => "deadline_passed",
    };
    let blocks_left = tip.map(|t| deadline.saturating_sub(t as u64));

    // the public self-check, run on the host's own data
    let check = tip.map(|t| recount(rules, &c.run.rules_id, &entries, &notes, &[], t, true));
    let failing: Vec<&str> = check.as_ref().map(|r| r.results.iter().filter(|x| !x.pass).map(|x| x.id).collect()).unwrap_or_default();

    // ---- warnings, most serious first ----
    let mut w: Vec<Value> = vec![];
    for m in guard_messages(&c.run, &entries, &wnotes) {
        w.push(warn("bad", format!("A contribution was spent by something that is not its refund ticket or the final sweep ({m}). The public check will show this as misconduct. Stop using this campaign's wallet for anything else.")));
    }
    let age = pass.at.map(|t| now().saturating_sub(t));
    match (&pass.at, pass.ok) {
        (None, _) => w.push(warn("info", "Starting up: the first check of the network is still running.")),
        (Some(_), false) => w.push(warn("warn", format!("The last check failed: {}. New payments will not get tickets until the program can reach the network again; it keeps trying.", pass.error.clone().unwrap_or_default()))),
        _ => {}
    }
    if age.is_some_and(|s| s > 180) {
        let args: Vec<String> = std::env::args().collect();
        w.push(warn("bad", format!("The program has not checked the network for {} minutes. Contributions are not getting tickets while it is stopped. {}", age.unwrap_or(0) / 60, restart_hint(&args, std::process::id(), &c.run.dir))));
    }
    if let Some(t) = tip {
        let unticketed: Vec<&ChainNote> = a.contributions.iter().filter(|n| n.nf.as_ref().is_some_and(|nf| !a.first_issue.contains_key(nf))).collect();
        let late = unticketed.iter().filter(|n| n.height.is_some_and(|h| (t as u64) > h as u64 + k)).count();
        let waiting = unticketed.len() - late;
        if let Some((level, text)) = ticket_note(late, waiting, k, closed.is_some()) {
            w.push(warn(level, text));
        }
    }
    if closed.is_none() {
        for (key, passes, reason) in crate::long_skips(&c.run) {
            let value = notes.iter().find(|n| format!("{}:{}", n.txid, n.action) == key).map(|n| n.value_zat);
            w.push(warn("bad", skip_warning(&key, value, passes, &reason)));
        }
    }
    if held < unspent.len() {
        w.push(warn("bad", format!("{} ticketed contribution(s) are not protected by the wallet lock. An ordinary payment from this wallet could spend them. Do not use this wallet for other payments.", unspent.len() - held)));
    }
    if pass.relays.is_empty() && lock(&c.pass).at.is_some() {
        w.push(warn("warn", "No relay is set for this campaign, so contributors cannot fetch their tickets or see the list."));
    }
    let norm = |u: &str| u.trim().trim_end_matches('/').to_string();
    let running_with: Vec<String> = st.cfg.relays.iter().map(|u| norm(u)).collect();
    let stored: Vec<String> = c.run.relays().iter().map(|u| norm(u)).collect();
    let fix = relay_fix_hint(running_with.first().map(String::as_str), &c.run.dir);
    for (url, res) in &pass.relays {
        if let Err(e) = res {
            w.push(warn("bad", format!("The relay {url} is not reachable ({e}). Your list is safe on this computer and will be sent again when it is back, but until then contributors cannot read the list or fetch their tickets. {fix}")));
        }
    }
    if !running_with.is_empty() && !stored.is_empty() && !stored.iter().any(|u| running_with.contains(u)) {
        w.push(warn("bad", format!("This campaign publishes to {} but the dashboard is running with the relay address {}. The links handed out here carry the stored address, so they open only while that address works. {fix}", stored.join(", "), running_with.join(", "))));
    }
    if let Some(t) = tip {
        let t = t as u64;
        if closed.is_none() && t > deadline {
            if t > deadline + k {
                w.push(warn("bad", "The deadline has passed and the campaign is not closed. Contributors can now claim their own refunds. Close the campaign to refund or sweep in an orderly way."));
            } else {
                w.push(warn("warn", format!("The deadline has passed. Close the campaign within {} blocks, or contributors will be able to claim their own refunds.", (deadline + k + 1).saturating_sub(t))));
            }
        }
    }
    if !failing.is_empty() {
        w.push(warn("bad", format!("The public self-check fails on {}. Someone verifying your campaign would see this.", failing.join(", "))));
    }
    let late = crate::late_payments(rules, &entries, &notes).len();
    if late > 0 {
        let after = if ll_core::recount::contribution_end(rules, &entries) < rules.deadline_height { "the early close" } else { "the deadline" };
        w.push(warn("warn", format!("{late} payment(s) arrived after {after}; they are not counted and stay in the wallet (cb-host late lists them).")));
    }
    if rejects > 0 {
        w.push(warn("warn", format!("{rejects} payment(s) were set aside because their message could not be opened. They count as donations; their senders can still prove they were valid.")));
    }
    if rules.network != "main" {
        w.push(warn("info", "This is the test network. No real money is involved."));
    }
    w.push(warn("info", "Keep this program and this computer running while the campaign is open: tickets are only issued while it runs."));

    let relay_status: Vec<Value> = if pass.relays.is_empty() {
        run_relays(&c.run).into_iter().map(|u| json!({ "url": u, "status": "not checked yet" })).collect()
    } else {
        pass.relays.iter().map(|(u, r)| json!({ "url": u, "status": match r { Ok(_) => "up to date".to_string(), Err(e) => format!("not reachable: {e}") } })).collect()
    };
    let relays_q: String = c.run.relays().iter().map(|r| format!("&relay={r}")).collect();
    json!({
        "ok": true, "id": c.id, "short": &c.id[..8], "name": rules.name, "mode": rules.mode, "network": rules.network,
        "ticker": if rules.network == "main" { "ZEC" } else { "TAZ" },
        "goal_zat": rules.goal_zat, "items": rules.items, "min_zat": rules.min_contribution_zat, "fee_zat": rules.refund_fee_zat,
        "start_height": rules.start_height, "deadline_height": rules.deadline_height, "ticket_k": rules.ticket_k,
        "pay_to": rules.pay_to, "tip": tip, "blocks_left": blocks_left,
        "phase": phase, "outcome": closed.as_ref().map(|c| c.outcome.clone()),
        "early_close": rules.allows_early_close(),
        "cap_zat": rules.cap_zat, "over_cap": a.over_cap.len(), "over_cap_zat": a.over_cap.iter().map(|n| n.value_zat).sum::<u64>(),
        "pricing": rules.pricing.clone().unwrap_or_else(|| if rules.is_auction() { "pay_your_bid".into() } else { String::new() }),
        "closed_early": closed.as_ref().is_some_and(|c| c.close_height <= rules.deadline_height),
        "can_close_early": rules.allows_early_close() && closed.is_none() && tip.is_some_and(|t| t <= rules.deadline_height && crate::may_close(rules, &a, t).is_ok()),
        "close_early_reason": tip.filter(|t| rules.allows_early_close() && closed.is_none() && *t <= rules.deadline_height).and_then(|t| crate::may_close(rules, &a, t).err()),
        "contribute_link": format!("{}/contribute.html#c={}{}&server={}", st.cfg.page_base, c.id, relays_q, st.cfg.server),
        "counts": {
            "contributions": a.contributions.len(), "raised_zat": raised, "tickets_issued": a.tickets.len(), "reissues": reissues,
            "rejects": rejects, "donations": a.donations.len(), "withdrawn": a.withdrawn.len(),
            "locks_held": held, "locks_expected": unspent.len(), "ledger_entries": entries.len(),
        },
        "relays": relay_status,
        "final": std::fs::read(c.run.dir.join("public").join("final.json")).ok().and_then(|b| serde_json::from_slice::<ll_core::final_copy::FinalRecord>(&b).ok())
            .map(|r| json!({ "line": r.line(), "entries": r.entries, "last_hash": r.last_hash, "close_height": r.close_height })),
        "last_check": { "seconds_ago": age, "ok": pass.ok, "error": pass.error },
        "self_check": check.as_ref().map(|r| json!({
            "all_pass": r.all_pass(),
            "results": r.results.iter().map(|x| json!({ "id": x.id, "pass": x.pass, "title": x.title, "details": x.details })).collect::<Vec<_>>(),
            "warnings": r.warnings,
        })),
        "warnings": w,
        // what the host has sent to the network: sent and waiting, confirmed in block N, sent again, dead (rebuilt)
        "broadcasts": crate::outbox::Outbox::load(&c.run.dir).map(|o| o.items.iter().map(|b| json!({
            "label": b.label, "kind": b.kind, "txid": b.txid, "status": b.status, "mined_height": b.mined_height,
            "sends": b.sends, "note": b.note,
        })).collect::<Vec<_>>()).unwrap_or_default(),
        "closing": c.closing.load(Ordering::SeqCst),
        "close_unfinished": crate::close_unfinished(&c.run),
        "close_log": *lock(&c.last_close),
    })
}

fn run_relays(run: &Run) -> Vec<String> {
    run.relays()
}

fn close_campaign(c: &Campaign, body: &Value) -> Result<Value> {
    let (tip, closed) = {
        let tip = lock(&c.pass).tip;
        let entries = c.run.ledger().load().unwrap_or_default();
        (tip, close_entry(&entries).is_some())
    };
    // After the close entry exists, "Try again" finishes what is left, with the address recorded at the first close (the real-money
    // confirmation was given then; finishing moves nothing that was not already decided).
    let sweep_to = if closed {
        if crate::close_unfinished(&c.run).is_empty() {
            bail!("This campaign is already closed and nothing is left to do.");
        }
        fs::read_to_string(c.run.dir.join("private").join("sweep_to")).map(|t| t.trim().to_string()).unwrap_or_default()
    } else {
        crate::mainnet::require_confirmation(&c.run.rules.network, body["confirm_mainnet"].as_bool() == Some(true))?;
        let mut sweep_to = body["sweep_to"].as_str().unwrap_or("").trim().to_string();
        if c.run.rules.is_uniform() {
            // a uniform price auction pays each winner's price into its treasury; nothing is swept, so the treasury address stands in
            sweep_to = c.run.rules.treasury_address.clone().unwrap_or_default();
        }
        if sweep_to.is_empty() {
            bail!("Please enter the address that should receive the money the campaign keeps.");
        }
        let (net, _) = orchard_receiver(&sweep_to).map_err(|_| anyhow!("That doesn't look like a valid address that can receive shielded money. Please copy it again from your wallet."))?;
        if net != network_type(&c.run.rules.network)? {
            bail!("That address is for a different network than this campaign.");
        }
        let deadline = c.run.rules.deadline_height as u64;
        match tip {
            None => bail!("The program has not yet seen the network. Please wait a moment and try again."),
            Some(t) if (t as u64) <= deadline && !c.run.rules.allows_early_close() => bail!("The deadline has not passed yet. You can close after block {deadline} (in {} blocks).", deadline + 1 - t as u64),
            _ => {} // a fundraiser that allows an early close: the close itself checks that the goal is met, before it writes anything
        }
        sweep_to
    };
    if c.closing.swap(true, Ordering::SeqCst) {
        bail!("Closing is already in progress.");
    }
    let result = {
        let mut b = lock(&c.backend);
        close(&c.run, b.as_mut(), &sweep_to)
    };
    c.closing.store(false, Ordering::SeqCst);
    match result {
        Ok(log) => {
            *lock(&c.last_close) = log.clone();
            Ok(json!({ "ok": true, "log": log }))
        }
        Err(e) => {
            // "Nothing was lost" is said only when it is true: nothing was written or sent because the close entry does not exist.
            let closed_now = close_entry(&c.run.ledger().load().unwrap_or_default()).is_some();
            let unfinished = crate::close_unfinished(&c.run);
            if !closed_now {
                bail!("Not closed: {}. Nothing was written or sent, so nothing was lost; you can try again.", plain_error(&e))
            } else if !unfinished.is_empty() {
                bail!("{}", crate::unfinished_message(&unfinished))
            } else {
                bail!("The campaign is closed, but finishing it stopped ({}); Try again finishes it without sending anything twice.", plain_error(&e))
            }
        }
    }
}

// ---------- HTTP ----------

type Resp = tiny_http::Response<std::io::Cursor<Vec<u8>>>;

fn header(k: &str, v: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("static header")
}

fn respond(code: u16, ctype: &str, body: Vec<u8>) -> Resp {
    tiny_http::Response::from_data(body)
        .with_status_code(code)
        .with_header(header("Content-Type", ctype))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
}

fn json_response(code: u16, v: Value) -> Resp {
    respond(code, "application/json", v.to_string().into_bytes())
}

const NOT_FOUND: &str = "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Not here</title><link rel=\"stylesheet\" href=\"/dashboard.css\"><main><h1>That page isn't here</h1><p><a href=\"/\">Go to the dashboard</a></p></main>";

fn static_file(st: &State, path: &str) -> Resp {
    // Only these files are ever served: the dashboard's pages, the shared look, and the self-hosted fonts.
    let (name, ctype): (String, &str) = match path {
        "/" | "/dashboard.html" => ("dashboard.html".into(), "text/html; charset=utf-8"),
        "/setup.html" => ("setup.html".into(), "text/html; charset=utf-8"),
        "/dashboard.js" | "/setup.js" | "/ui.js" | "/brand.js" | "/blocktime.js" => (path[1..].to_string(), "text/javascript; charset=utf-8"),
        "/dashboard.css" | "/setup.css" | "/ui.css" => (path[1..].to_string(), "text/css; charset=utf-8"),
        "/favicon.ico" => return respond(204, "text/plain", vec![]),
        // the logo and icons: a flat file name of letters, digits and dashes with one of three known endings
        p if p.starts_with("/img/") && !p[5..].contains("..") && !p[5..].contains('/') && p[5..].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.') && (p.ends_with(".svg") || p.ends_with(".png") || p.ends_with(".ico")) => {
            let ct = if p.ends_with(".svg") { "image/svg+xml" } else if p.ends_with(".png") { "image/png" } else { "image/x-icon" };
            (p[1..].to_string(), ct)
        }
        p if p.starts_with("/fonts/") && p.ends_with(".woff2") && p[7..].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.') && !p[7..].contains("..") => (p[1..].to_string(), "font/woff2"),
        _ => return respond(404, "text/html; charset=utf-8", NOT_FOUND.as_bytes().to_vec()),
    };
    match fs::read(st.cfg.www.join(&name)) {
        Ok(b) => respond(200, ctype, b),
        Err(_) => respond(404, "text/html; charset=utf-8", NOT_FOUND.as_bytes().to_vec()),
    }
}

fn header_value(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string())
}

/// Only this computer's own page may talk to the dashboard: a web page on another site (or a
/// rebinding trick) must not be able to close a campaign.
fn allowed(req: &tiny_http::Request, port: u16) -> bool {
    let own = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if !header_value(req, "host").is_some_and(|h| own.contains(&h)) {
        return false;
    }
    if req.method() == &tiny_http::Method::Post {
        if header_value(req, "x-dashboard").as_deref() != Some("1") {
            return false;
        }
        if let Some(o) = header_value(req, "origin") {
            if !own.iter().any(|h| o == format!("http://{h}")) {
                return false;
            }
        }
    }
    true
}

fn handle(st: &State, port: u16, mut req: tiny_http::Request) {
    let method = req.method().clone();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();
    let resp = if !allowed(&req, port) {
        json_response(403, json!({ "ok": false, "error": "This request did not come from the dashboard page on this computer." }))
    } else if let Some(rest) = path.strip_prefix("/api/") {
        let mut body = vec![];
        let _ = req.as_reader().take(65_536).read_to_end(&mut body);
        let body: Value = if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).unwrap_or(Value::Null) };
        let parts: Vec<&str> = rest.trim_matches('/').split('/').collect();
        let fail = |code: u16, e: anyhow::Error| json_response(code, json!({ "ok": false, "error": e.to_string() }));
        match (method, parts.as_slice()) {
            (tiny_http::Method::Get, ["config"]) => json_response(200, json!({
                "ok": true, "network": st.cfg.network, "ticker": if st.cfg.network == "main" { "ZEC" } else { "TAZ" },
                "relays": st.cfg.relays, "nu7_mainnet_height": st.cfg.nu7_mainnet_height, "min_floor_zat": MIN_FLOOR_ZAT, "fee_zat": 10_000, "hard_cap": true,
            })),
            (tiny_http::Method::Get, ["campaigns"]) => {
                let list: Vec<Value> = lock(&st.campaigns).iter().rev().map(|c| {
                    let s = status(st, c);
                    json!({ "id": c.id, "short": &c.id[..8], "name": s["name"], "mode": s["mode"], "phase": s["phase"], "deadline_height": s["deadline_height"], "tip": s["tip"] })
                }).collect();
                json_response(200, json!({ "ok": true, "campaigns": list }))
            }
            (tiny_http::Method::Post, ["campaigns"]) => match create_campaign(st, &body) {
                Ok(v) => json_response(200, v),
                Err(e) => fail(400, e),
            },
            (tiny_http::Method::Get, ["campaigns", id]) => match find(st, id) {
                Some(c) => json_response(200, status(st, &c)),
                None => fail(404, anyhow!("No such campaign.")),
            },
            (tiny_http::Method::Get, ["campaigns", id, "export"]) => match find(st, id) {
                Some(c) => match crate::public_copy(&c.run) {
                    Ok(v) => json_response(200, v),
                    Err(e) => fail(500, e),
                },
                None => fail(404, anyhow!("No such campaign.")),
            },
            (tiny_http::Method::Post, ["campaigns", id, "close"]) => match find(st, id) {
                Some(c) => match close_campaign(&c, &body) {
                    Ok(v) => json_response(200, v),
                    Err(e) => fail(400, e),
                },
                None => fail(404, anyhow!("No such campaign.")),
            },
            _ => fail(404, anyhow!("No such request.")),
        }
    } else if method == tiny_http::Method::Get {
        static_file(st, &path)
    } else {
        respond(404, "text/html; charset=utf-8", NOT_FOUND.as_bytes().to_vec())
    };
    let _ = req.respond(resp);
}

pub fn serve(cfg: Config) -> Result<()> {
    fs::create_dir_all(&cfg.runs_dir)?;
    let port: u16 = cfg.listen.rsplit(':').next().and_then(|p| p.parse().ok()).ok_or_else(|| anyhow!("--listen must look like 127.0.0.1:8780"))?;
    if !cfg.listen.starts_with("127.0.0.1:") && !cfg.listen.starts_with("localhost:") {
        bail!("The dashboard only listens on this computer (127.0.0.1); it can close campaigns and must not be reachable from other devices.");
    }
    let mut campaigns = vec![];
    for e in fs::read_dir(&cfg.runs_dir)? {
        let dir = e?.path();
        if dir.join("rules.json").exists() && dir.join("secrets.json").exists() {
            match load_campaign(&dir) {
                Ok(c) => campaigns.push(c),
                Err(e) => println!("skipping {}: {e:#}", dir.display()),
            }
        }
    }
    println!("dashboard on http://{} ({} campaign(s) loaded, watching every {} s)", cfg.listen, campaigns.len(), WATCH_EVERY.as_secs());
    let server = tiny_http::Server::http(&cfg.listen).map_err(|e| anyhow!("cannot listen on {}: {e}", cfg.listen))?;
    let st = Arc::new(State { cfg, campaigns: Mutex::new(campaigns) });
    for req in server.incoming_requests() {
        let st = st.clone();
        thread::spawn(move || handle(&st, port, req));
    }
    Ok(())
}

#[cfg(test)]
mod restart_hint_tests {
    use super::*;

    #[test]
    fn the_ticket_note_is_quiet_when_all_is_ticketed_and_loud_only_when_late() {
        assert!(ticket_note(0, 0, 30, false).is_none());
        assert!(ticket_note(3, 2, 30, true).is_none(), "after the close the note is not needed");
        let (lvl, t) = ticket_note(0, 2, 30, false).unwrap();
        assert_eq!(lvl, "info");
        assert!(t.contains("2 payment(s) are waiting") && t.contains("Wait for this note to go before closing"), "{t}");
        let (lvl, t) = ticket_note(1, 5, 30, false).unwrap();
        assert_eq!(lvl, "bad");
        assert!(t.contains("1 payment(s) have no refund ticket") && t.contains("more than 30 blocks") && t.contains("first tries to issue these tickets") && t.contains("stops before writing anything") && t.contains("last network check"), "{t}");
    }


    #[test]
    fn the_relay_hint_has_the_exact_command() {
        let h = relay_fix_hint(Some("https://relay.example.org"), Path::new("runs/dash/campaign-1"));
        assert!(h.contains("./run.sh set-relay https://relay.example.org runs/dash/campaign-1 --yes") && h.contains("No restart is needed"), "{h}");
        let n = relay_fix_hint(None, Path::new("runs/my dash/c"));
        assert!(n.contains("--relay <address>") && n.contains("'runs/my dash/c'"), "{n}");
    }


    #[test]
    fn the_hint_carries_the_exact_command_and_the_process_number() {
        let args: Vec<String> = ["./app/target/release/cb-host", "serve", "--network", "main", "--runs-dir", "runs/my dash", "--listen", "127.0.0.1:8780"].iter().map(|s| s.to_string()).collect();
        let h = restart_hint(&args, 4242, Path::new("runs/dash/campaign-1"));
        assert!(h.contains("./app/target/release/cb-host serve --network main --runs-dir 'runs/my dash' --listen 127.0.0.1:8780") || h.contains("--runs-dir 'runs/my dash'"), "{h}");
        assert!(h.contains("kill 4242") && h.contains("./run.sh restart dashboard") && h.contains("runs/dash/campaign-1") && h.contains("Last network check"), "{h}");
    }

    #[test]
    fn quoting_keeps_odd_words_in_one_piece() {
        assert_eq!(shell_word("plain-word_1.2/x"), "plain-word_1.2/x");
        assert_eq!(shell_word("a b"), "'a b'");
        assert_eq!(shell_word("it's"), "'it'\\''s'");
        assert_eq!(shell_word(""), "''");
    }
}
