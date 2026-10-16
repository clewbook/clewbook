//! cb-listing (PROTOTYPE, testnet only): the listing job and its operator commands. See src/job.rs for the data folder.

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};
use ll_listing::fetch::FetchPolicy;
use ll_listing::job::{self, JobConfig};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Parser)]
#[command(name = "cb-listing", about = "PROTOTYPE: list campaigns of approved hosts (testnet only by default)")]
struct Cli {
    /// The listing data folder.
    #[arg(long, global = true, default_value = "runs/listing")]
    dir: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(clap::Args, Clone)]
struct PassArgs {
    /// Networks that may be listed (repeat). Default: test only.
    #[arg(long = "network", default_value = "test")]
    networks: Vec<String>,
    /// The testnet chain server, for the height and the recount (an address you choose, never one from a record).
    #[arg(long, default_value = ll_listing::tip::DEFAULT_TESTNET)]
    chain_server: String,
    /// The mainnet chain server (read only: the recount of a fixed mainnet entry, or of mainnet records when mainnet is allowed).
    #[arg(long, default_value = ll_listing::tip::DEFAULT_MAINNET)]
    chain_server_main: String,
    /// Required with --network main: says that campaigns handling real money may be listed.
    #[arg(long)]
    confirm_mainnet_listing: bool,
    /// Mainnet: the published NU7 activation height; a new mainnet campaign must close before it.
    #[arg(long)]
    nu7_mainnet_height: Option<u32>,
    /// Longest one recount may take, in seconds.
    #[arg(long, default_value_t = 600)]
    recount_seconds: u64,
    /// Largest block range one recount scans.
    #[arg(long, default_value_t = 20_000)]
    recount_max_blocks: u32,
    /// At most this many recounts per pass (new records first), one at a time.
    #[arg(long, default_value_t = 2)]
    recounts_per_pass: usize,
    /// A listed campaign is recounted again after this many hours even if nothing moved.
    #[arg(long, default_value_t = 6)]
    recheck_hours: u64,
    /// The same for the entries of the hand kept list (shown for information only).
    #[arg(long, default_value_t = 24)]
    recheck_fixed_hours: u64,
    /// TEST ONLY: use this chain height instead of asking a chain server.
    #[arg(long)]
    test_tip: Option<u32>,
    /// TEST ONLY: allow plain http relays on this computer (127.0.0.1, ::1, localhost). Never on a server.
    #[arg(long)]
    test_allow_loopback: bool,
    /// Seconds to wait for a relay to connect, and for its whole answer.
    #[arg(long, default_value_t = 5)]
    connect_timeout: u64,
    #[arg(long, default_value_t = 10)]
    total_timeout: u64,
    /// Largest relay answer read, in bytes.
    #[arg(long, default_value_t = 65536)]
    max_bytes: usize,
    /// The operator's hand kept list ({"campaigns":[{"id","relays"}]}), read only: its entries come first in out/campaigns.json, exactly as
    /// written. Without it the combined list holds only the campaigns listed here.
    #[arg(long)]
    hand_list: Option<PathBuf>,
    /// Days a record from a host that is never approved stays in the queue before it is removed.
    #[arg(long, default_value_t = 7)]
    queue_days: u64,
}

#[derive(Subcommand)]
enum Cmd {
    /// One pass: check every record and write out/campaigns.json, out/status.json and out/queue.json.
    Run(PassArgs),
    /// The submission endpoint (POST /v1/records), with a pass every --interval seconds.
    Serve {
        #[command(flatten)]
        pass: PassArgs,
        #[arg(long, default_value = "127.0.0.1:8795")]
        listen: String,
        #[arg(long, default_value_t = 600)]
        interval: u64,
        #[arg(long, default_value_t = 10)]
        per_minute: u32,
    },
    /// Add a record from a file (the same checks as the endpoint).
    Submit { file: PathBuf },
    /// Show the queue of hosts that are not approved yet (from the last pass).
    Queue,
    /// Approve a host key (full key or fingerprint) with the display label shown for its campaigns.
    Approve { key: String, #[arg(long)] label: String },
    /// Change the display label of an approved host key.
    Label { key: String, label: String },
    /// Revoke a host key: its campaigns disappear on the next pass; nothing is deleted from any relay.
    Revoke { key: String },
    /// Hide a campaign id, or every campaign of a host key.
    Hide { what: String },
    /// Undo a hide.
    Unhide { what: String },
    /// Show why each record was listed, queued, hidden, revoked or refused (from the last pass).
    Status,
    /// Recount one campaign now, read only (nothing is written): its relays' ledger and the public chain. Prints the result as JSON.
    Recount {
        /// The campaign id (64 hex).
        id: String,
        /// Its relays (repeat).
        #[arg(long = "relay", required = true)]
        relays: Vec<String>,
        /// "test" or "main".
        #[arg(long)]
        network: String,
        #[arg(long, default_value = ll_listing::tip::DEFAULT_TESTNET)]
        chain_server: String,
        #[arg(long, default_value = ll_listing::tip::DEFAULT_MAINNET)]
        chain_server_main: String,
        #[arg(long, default_value_t = 600)]
        recount_seconds: u64,
        #[arg(long, default_value_t = 20_000)]
        recount_max_blocks: u32,
    },
}

fn config(dir: PathBuf, p: &PassArgs) -> Result<JobConfig> {
    if p.networks.iter().any(|n| n == "main") && !p.confirm_mainnet_listing {
        bail!("--network main lists campaigns that handle real money: add --confirm-mainnet-listing to say so");
    }
    if p.networks.iter().any(|n| n == "main") && p.nu7_mainnet_height.is_none() {
        bail!("--network main needs --nu7-mainnet-height (the published NU7 activation height): a new mainnet campaign must close before it");
    }
    if let Some(n) = p.networks.iter().find(|n| *n != "test" && *n != "main") {
        bail!("unknown network {n:?}");
    }
    let mut cfg = JobConfig::new(dir);
    cfg.allowed_networks = p.networks.clone();
    cfg.hand_list = p.hand_list.clone();
    cfg.queue_ttl = p.queue_days * 24 * 3600;
    cfg.nu7_mainnet_height = p.nu7_mainnet_height;
    let chain: Arc<dyn ll_listing::chain::Chain> = Arc::new(ll_listing::chain::GrpcChain::new(&p.chain_server, &p.chain_server_main));
    cfg.recount = Some(ll_listing::recount::Setup {
        chain,
        limits: ll_listing::recount::Limits {
            wall: Duration::from_secs(p.recount_seconds), max_blocks: p.recount_max_blocks, per_pass: p.recounts_per_pass,
            recheck: Duration::from_secs(p.recheck_hours * 3600), recheck_fixed: Duration::from_secs(p.recheck_fixed_hours * 3600), ..Default::default()
        },
    });
    cfg.fetch = FetchPolicy {
        test_allow_loopback: p.test_allow_loopback,
        connect_timeout: Duration::from_secs(p.connect_timeout),
        total_timeout: Duration::from_secs(p.total_timeout),
        max_bytes: p.max_bytes,
    };
    Ok(cfg)
}

fn tip_source(p: &PassArgs) -> Arc<dyn Fn(&str) -> Result<u32> + Send + Sync> {
    match p.test_tip {
        Some(t) => Arc::new(move |_: &str| Ok(t)),
        None => {
            let (test, main) = (p.chain_server.clone(), p.chain_server_main.clone());
            Arc::new(move |n: &str| ll_listing::tip::latest_height(if n == "main" { &main } else { &test }))
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let plain = JobConfig::new(cli.dir.clone());
    match cli.cmd {
        Cmd::Run(p) => {
            if p.networks.iter().any(|n| n == "main") {
                eprintln!("note: the main network is allowed for this pass");
            }
            let cfg = config(cli.dir, &p)?;
            let source = tip_source(&p);
            let tips = ll_listing::serve::pass_tips(&cfg, source.as_ref())?;
            let heights: Vec<String> = cfg.allowed_networks.iter().map(|n| format!("{n} {}", tips(n).unwrap_or(0))).collect();
            let status = job::run_pass_with(&cfg, &tips, ll_listing::host::now_secs())?;
            println!("pass at block {}: {}", heights.join(", "), if status.is_empty() { "no records".into() } else { job::describe(&status) });
            for s in &status {
                println!("  {:?} {}… host {}: {}", s.state, &s.campaign[..8], s.host, s.reason);
            }
        }
        Cmd::Serve { pass, listen, interval, per_minute } => {
            let cfg = config(cli.dir, &pass)?;
            ll_listing::serve::serve(cfg, &listen, per_minute, Duration::from_secs(interval), tip_source(&pass))?;
        }
        Cmd::Submit { file } => {
            let bytes = std::fs::read(&file)?;
            println!("{}", job::submit(&plain, &bytes)?);
        }
        Cmd::Queue => {
            let q = job::read_queue(&plain)?;
            if q.is_empty() {
                println!("the queue is empty");
            }
            let now = ll_listing::host::now_secs();
            for item in q {
                if item["kind"] == "attention" {
                    println!("ATTENTION {}  host {}  name {}  {}", item["campaign"].as_str().unwrap_or("").get(..8).unwrap_or(""), item["fingerprint"].as_str().unwrap_or(""),
                        item["name"].as_str().map(|n| format!("{n:?}")).unwrap_or_else(|| "(none)".into()), item["note"].as_str().unwrap_or(""));
                    continue;
                }
                let left = item["expires_at"].as_u64().map(|t| t.saturating_sub(now)).unwrap_or(0);
                println!("{}  host {}  name {}  {}; {}", item["campaign"].as_str().unwrap_or("").get(..8).unwrap_or(""), item["fingerprint"].as_str().unwrap_or(""),
                    item["name"].as_str().map(|n| format!("{n:?}")).unwrap_or_else(|| "(none)".into()), item["note"].as_str().unwrap_or(""),
                    if left == 0 { "removed on the next pass unless the host key is approved".to_string() } else { format!("removed in {} unless the host key is approved", job::plain_duration(left)) });
            }
        }
        Cmd::Approve { key, label } => println!("{}", job::approve(&plain, &key, &label)?),
        Cmd::Label { key, label } => println!("{}", job::set_label(&plain, &key, &label)?),
        Cmd::Revoke { key } => println!("{}", job::revoke(&plain, &key)?),
        Cmd::Hide { what } => println!("{}", job::hide(&plain, &what, true)?),
        Cmd::Unhide { what } => println!("{}", job::hide(&plain, &what, false)?),
        Cmd::Recount { id, relays, network, chain_server, chain_server_main, recount_seconds, recount_max_blocks } => {
            let chain: Arc<dyn ll_listing::chain::Chain> = Arc::new(ll_listing::chain::GrpcChain::new(&chain_server, &chain_server_main));
            let tip = chain.tip(&network)?;
            let limits = ll_listing::recount::Limits { wall: Duration::from_secs(recount_seconds), max_blocks: recount_max_blocks, ..Default::default() };
            let relays: Vec<String> = relays.iter().map(|r| r.trim_end_matches('/').to_string()).collect();
            let o = ll_listing::recount::recount_campaign(&chain, &relays, &id.to_lowercase(), &network, tip, &limits, &FetchPolicy::default());
            println!("{}", serde_json::to_string_pretty(&o)?);
            eprintln!("{}", o.summary());
        }
        Cmd::Status => {
            let t = std::fs::read_to_string(plain.dir.join("out/status.json")).map_err(|_| anyhow::anyhow!("no status yet: run a pass first"))?;
            let v: Vec<serde_json::Value> = serde_json::from_str(&t)?;
            if v.is_empty() {
                bail!("no records yet");
            }
            for s in v {
                println!("{} {}… host {}: {}", s["state"].as_str().unwrap_or(""), s["campaign"].as_str().unwrap_or("").get(..8).unwrap_or(""), s["host"].as_str().unwrap_or(""), s["reason"].as_str().unwrap_or(""));
            }
        }
    }
    Ok(())
}
