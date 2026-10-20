//! Host app: creates a campaign, issues refund tickets automatically, closes it.
#![recursion_limit = "256"] // the dashboard status is one large json! object

mod backend;
mod dashboard;
mod devtool;
mod libs;
mod lock;
mod mainnet;
mod outbox;
mod ticket;

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use clap::{Parser, Subcommand};
use ll_core::{
    hex32,
    keys::CampaignSecrets,
    ledger::{self, Close, Contribution, Entry, LedgerDir, Ticket, amount_commit},
    payload::{Payload, is_payload_shaped},
    receiver::{encode_orchard, network_type, orchard_receiver},
    recount::{Analysis, ChainNote, analyze, close_entry, contribution_end},
    rules::{Rules, ufvk_hash},
    walletdb::WalletNote,
};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};

use crate::{
    backend::{SpendRequest, WalletBackend},
    devtool::DevtoolBackend,
    ticket::Expect,
};

#[derive(Parser)]
#[command(name = "cb-host", about = "Campaign host: issues refund tickets and keeps the ticket ledger")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a campaign in a new run directory
    Create {
        #[arg(long)]
        run: PathBuf,
        /// Campaign wallet directory (dedicated account)
        #[arg(long)]
        wallet: PathBuf,
        /// age identity file for the campaign wallet
        #[arg(long)]
        identity: PathBuf,
        #[arg(long, default_value = "target/release/zcash-devtool")]
        devtool: PathBuf,
        /// Wallet backend: "libs" (wallet libraries, default) or "devtool" (subprocess fallback)
        #[arg(long, default_value = "libs")]
        backend: String,
        #[arg(long, default_value = "test")]
        network: String,
        /// "raise" or "auction"
        #[arg(long, default_value = "raise")]
        mode: String,
        /// Raise: goal in zatoshis
        #[arg(long)]
        goal_zat: Option<u64>,
        /// Auction: number of items
        #[arg(long)]
        items: Option<u32>,
        /// Deadline, in blocks from now
        #[arg(long)]
        deadline_in: u32,
        /// Relay to publish the ledger and sealed tickets to (repeatable)
        #[arg(long)]
        relay: Vec<String>,
        /// Smallest accepted contribution in zatoshis (default: twice the refund fee)
        #[arg(long)]
        min_contribution_zat: Option<u64>,
        /// Uniform-price auction: the reserve price (net of the fee). Needs --treasury-address and --treasury-ufvk.
        #[arg(long)]
        reserve_zat: Option<u64>,
        /// Uniform-price auction: the treasury address and its PUBLIC viewing key (a dedicated account)
        #[arg(long)]
        treasury_address: Option<String>,
        #[arg(long)]
        treasury_ufvk: Option<String>,
        /// The ticket window K in blocks: a refund ticket must be issued within K blocks of a contribution, and after the deadline the host has K blocks to close before contributors may claim their own refunds
        #[arg(long, default_value_t = ll_core::rules::DEFAULT_TICKET_K)]
        ticket_k: u32,
        /// Confirmations a payment needs before its entry and ticket are written (default: 3 on the main network, 1 on the test network).
        /// Kept in the campaign's private config.json; it is not part of the rules
        #[arg(long)]
        min_confirmations: Option<u32>,
        /// Fundraiser only: allow closing before the deadline once the goal is met (part of the signed rules; contributors are told before they pay)
        #[arg(long)]
        early_close: bool,
        /// Fundraiser only: the hard cap in zatoshis, the most the campaign keeps (at least the goal). At the close, contributions are kept in
        /// chain order while they fit; a payment that does not fit is refunded whole by its own ticket. Part of the signed rules
        #[arg(long)]
        cap_zat: Option<u64>,
        /// Optional public name of the campaign (1 to 60 characters, plain text). It becomes part of the signed rules and is public: put nothing private in it.
        #[arg(long)]
        name: Option<String>,
        /// Mainnet only: confirm that this campaign handles real ZEC
        #[arg(long)]
        confirm_mainnet: bool,
        /// Mainnet only: the published NU7 activation height (a campaign that could still be running then is refused)
        #[arg(long)]
        nu7_mainnet_height: Option<u32>,
    },
    /// Run the host dashboard (local only): a web page to set up campaigns, watch them and close
    /// them. It also runs the watcher for every campaign in --runs-dir.
    Serve {
        /// Folder holding the campaigns this dashboard manages (new ones are created here)
        #[arg(long, default_value = "runs/dashboard")]
        runs_dir: PathBuf,
        /// Folder with dashboard.html, dashboard.js and dashboard.css
        #[arg(long, default_value = "app/web/www")]
        www: PathBuf,
        #[arg(long, default_value = "127.0.0.1:8780")]
        listen: String,
        #[arg(long, default_value = "test")]
        network: String,
        #[arg(long, default_value = "libs")]
        backend: String,
        #[arg(long, default_value = "target/release/zcash-devtool")]
        devtool: PathBuf,
        /// Default relays for new campaigns (repeatable)
        #[arg(long)]
        relay: Vec<String>,
        /// Where the contribute page is served (used to build the contributor link)
        #[arg(long, default_value = "http://127.0.0.1:8770")]
        page_base: String,
        /// Public network server for the contribute page
        #[arg(long, default_value = "https://zjs.zec.rocks/testnet")]
        server: String,
        /// Mainnet only: the published NU7 activation height (a campaign that could still be running then is refused)
        #[arg(long)]
        nu7_mainnet_height: Option<u32>,
        /// The listing server that the dashboard's "Submit for listing" sends to
        #[arg(long, default_value = "https://listing.clewbook.xyz")]
        listing_url: String,
    },
    /// Publish the whole ledger and sealed tickets to a relay (also remembers it, so `watch`
    /// keeps publishing there)
    Publish {
        #[arg(long)]
        run: PathBuf,
        #[arg(long)]
        relay: Vec<String>,
    },
    /// Watch the campaign wallet(s): issue a ticket for every new contribution, and re-issue
    /// every open campaign's tickets when the network upgrades (the consensus branch ID changes)
    Watch {
        /// Run directory of a campaign; repeat to watch several campaigns
        #[arg(long, required = true)]
        run: Vec<PathBuf>,
        /// Run one pass and exit
        #[arg(long)]
        once: bool,
        #[arg(long, default_value_t = 15)]
        interval: u64,
        /// TEST ONLY: pretend the server reports this consensus branch ID (hex), to exercise
        /// upgrade handling on a network that is not upgrading
        #[arg(long)]
        assume_branch_id: Option<String>,
    },
    /// After the deadline: record the outcome, sweep what the rules let the host keep,
    /// broadcast every other ticket
    Close {
        #[arg(long)]
        run: PathBuf,
        /// Where kept funds go (the project's treasury address)
        #[arg(long)]
        sweep_to: String,
    },
    /// TEST ONLY: write a FORKED public copy of a closed campaign to a file: the same list except that the close entry is replaced by a different one, signed
    /// with the campaign's own key (a host showing another history), keeping the real final record in the file. For the fingerprint tests.
    ForceFork {
        #[arg(long)]
        run: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    /// TEST ONLY: write a very large but well-signed public copy to a file: `entries` reject entries chained from the start, then the close entry. For the
    /// tests of copies and memory with a big list (the entries do not describe real payments, so the recount's chain checks do not apply to it).
    ForceBig {
        #[arg(long)]
        run: PathBuf,
        #[arg(long)]
        entries: u64,
        #[arg(long)]
        out: PathBuf,
    },
    /// TEST ONLY: write a reject entry for a genuine contribution, as a cheating host would,
    /// to exercise the challenge rule
    ForceReject {
        #[arg(long)]
        run: PathBuf,
        /// `<txid>:<action>`
        #[arg(long)]
        contribution: String,
    },
    /// Save the final public copy and sign its fingerprint, for a closed campaign (done by itself after a close; run it for a campaign closed by an
    /// older program). Safe to repeat; moves no money.
    Finalize {
        #[arg(long)]
        run: PathBuf,
    },
    /// Re-issue the ticket of every outstanding contribution (after a network upgrade)
    Reissue {
        #[arg(long)]
        run: PathBuf,
    },
    /// List the payments that reached the campaign wallet after the deadline. They are not contributions: no ticket, not counted, not refunded,
    /// and the money stays in the campaign wallet until it is returned by hand. Reads the wallet file only; no network, no lock, changes nothing.
    Late {
        #[arg(long)]
        run: PathBuf,
    },
    /// Write the campaign's PUBLIC copy to one file: the signed rules and the whole signed list. The recount page can load it when no relay answers.
    /// It holds no key, no wallet and nothing private (it is what a relay serves). Reads files only; it does not need the campaign to be stopped.
    Export {
        #[arg(long)]
        run: PathBuf,
        /// Where to write it (an existing file is not overwritten)
        #[arg(long)]
        out: PathBuf,
    },
    /// The host's long lived key for listing requests, kept in <runs dir>/host_key.json (mode 600, never printed)
    HostKey {
        #[command(subcommand)]
        action: HostKeyAction,
        /// The host's run directory
        #[arg(long, default_value = "runs", global = true)]
        runs_dir: PathBuf,
    },
    /// Write a listing request for one campaign, signed by the host key and by the campaign's ledger key (the dashboard's Submit for listing
    /// sends the same),
    /// and optionally send it to a listing endpoint
    ListingRecord {
        /// The campaign folder
        #[arg(long)]
        run: PathBuf,
        /// The host's run directory (where the host key is)
        #[arg(long, default_value = "runs")]
        runs_dir: PathBuf,
        /// Relays to name in the record (repeat); default: the campaign's private/relays
        #[arg(long = "relay")]
        relays: Vec<String>,
        /// Where to write the record (an existing file is not overwritten)
        #[arg(long)]
        out: PathBuf,
        /// Also send it to this listing endpoint (for example https://listing.example.org)
        #[arg(long)]
        post: Option<String>,
    },
}

#[derive(Subcommand)]
enum HostKeyAction {
    /// Make the host key (once; an existing key is never replaced)
    Init,
    /// Show the host key's public key and fingerprint (never the secret)
    Show,
}

/// Local, private configuration of a run (not published).
#[derive(Serialize, Deserialize, Debug)]
struct RunConfig {
    backend: String,
    devtool: PathBuf,
    wallet: PathBuf,
    identity: PathBuf,
    /// How many confirmations a payment needs before the host writes its entry and ticket (1 = mined). Absent in campaigns made
    /// before this setting existed: they keep 1, so nothing changes for them. Private to the host; not part of the rules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min_confirmations: Option<u32>,
}

/// Confirmations a new main network campaign waits for before ticketing, unless `--min-confirmations` says otherwise (a reorg that
/// removes a ticketed payment would leave a permanent R3 failure in the append only list). Test network campaigns keep 1.
const MAINNET_MIN_CONFIRMATIONS: u32 = 3;

struct Run {
    dir: PathBuf,
    ledger_dir: PathBuf,
    rules: Rules,
    rules_id: String,
    secrets: CampaignSecrets,
    /// From `config.json` (`min_confirmations`); 1 when it is not set.
    min_confirmations: u32,
}

impl Run {
    fn load(dir: &Path) -> Result<Self> {
        let rules: Rules = serde_json::from_slice(&fs::read(dir.join("rules.json"))?)?;
        let rules_id = fs::read_to_string(dir.join("rules_id"))?.trim().to_string();
        let secrets = serde_json::from_slice(&fs::read(dir.join("secrets.json"))?)?;
        let min_confirmations = fs::read(dir.join("config.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v["min_confirmations"].as_u64())
            .map_or(1, |n| n.max(1) as u32);
        Ok(Self { dir: dir.into(), ledger_dir: dir.join("ledger"), rules, rules_id, secrets, min_confirmations })
    }

    fn ledger(&self) -> LedgerDir<'_> {
        LedgerDir(&self.ledger_dir)
    }

    fn append(&self, entry: Entry) -> Result<Entry> {
        self.ledger().append(entry, &self.secrets.ledger_key()?)
    }

    /// Signed tickets are the host's private copies (contributors get theirs sealed).
    fn signed_ticket_path(&self, nf: &str) -> PathBuf {
        self.dir.join("private").join("tickets").join(format!("{nf}.pczt"))
    }

    /// Relays this campaign publishes to (one URL per line in `private/relays`).
    fn relays(&self) -> Vec<String> {
        fs::read_to_string(self.dir.join("private").join("relays"))
            .map(|t| t.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
            .unwrap_or_default()
    }

    fn add_relays(&self, urls: &[String]) -> Result<()> {
        let mut all = self.relays();
        for u in urls {
            let u = u.trim_end_matches('/').to_string();
            if !all.contains(&u) {
                all.push(u);
            }
        }
        write_private(&self.dir.join("private").join("relays"), all.join("\n").as_bytes())
    }

    fn amount_key(&self) -> Result<[u8; 32]> {
        hex32(self.secrets.amount_key.as_deref().context("campaign has no amount key")?)
    }
}

/// Where a path in `config.json` really is, and a check that it is inside the campaign folder. A campaign's wallet and its key file live in the
/// campaign's own folder; a path that points anywhere else (typically the old folder of a restored copy) must never be followed silently,
/// because the copy would then spend from, and sign with, the other campaign's wallet. The paths are stored as names inside the folder; paths
/// written by older versions (relative to the folder the program was started in) are still accepted when they lead inside this folder.
fn resolve_in_folder(dir: &Path, p: &Path, what: &str) -> Result<PathBuf> {
    let folder = dir.canonicalize().with_context(|| format!("campaign folder {} cannot be read", dir.display()))?;
    let own = dir.join(p);
    let found = if p.is_relative() && own.exists() { own } else { p.to_path_buf() };
    let real = found.canonicalize().map_err(|_| anyhow!("config.json in {} names the {what} {}, which does not exist. If this folder was restored from a backup, set \"wallet\" and \"identity\" in config.json to the names of the wallet folder and key file inside this folder.", dir.display(), p.display()))?;
    match real.strip_prefix(&folder) {
        Ok(rel) => Ok(dir.join(rel)),
        Err(_) => bail!(
            "config.json in {} names the {what} {}, which is outside this campaign folder. Refusing to start: a restored or copied folder must not use another campaign's wallet. Set \"wallet\" and \"identity\" in config.json to the names of the wallet folder and key file inside this folder (for example \"wallet1\" and \"wallet1.age\").",
            dir.display(),
            p.display()
        ),
    }
}

/// Reads `config.json` and checks that the wallet and its key file are inside the campaign folder (see `resolve_in_folder`).
fn load_config(dir: &Path) -> Result<RunConfig> {
    let mut cfg: RunConfig = serde_json::from_slice(&fs::read(dir.join("config.json"))?)?;
    cfg.wallet = resolve_in_folder(dir, &cfg.wallet, "wallet")?;
    cfg.identity = resolve_in_folder(dir, &cfg.identity, "wallet key file")?;
    Ok(cfg)
}

fn backend_for(dir: &Path) -> Result<Box<dyn WalletBackend + Send>> {
    let cfg = load_config(dir)?;
    match cfg.backend.as_str() {
        "devtool" => Ok(Box::new(DevtoolBackend {
            bin: cfg.devtool,
            wallet: cfg.wallet,
            identity: cfg.identity,
            work: dir.join("work"),
        })),
        "libs" => Ok(Box::new(libs::LibsBackend::new(cfg.wallet, cfg.identity)?)),
        other => bail!("unknown wallet backend {other}"),
    }
}

/// Creates a folder (and any missing parents) that only this user can open (700). The mode is given at creation, so the folder is never open
/// to others, even for a moment. A folder that already exists is left as it is.
pub(crate) fn make_private_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(path)?;
    Ok(())
}

/// Writes a file only this user can read (600), created with that mode from the start (never written first and restricted afterwards); its
/// folder is created private too. An existing file is tightened to 600 before it is written.
pub(crate) fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        make_private_dir(parent)?;
    }
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        opts.mode(0o600);
        if let Ok(meta) = fs::metadata(path) {
            if meta.permissions().mode() & 0o077 != 0 {
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))?; // made by an older version, before it is written again
            }
        }
    }
    let mut f = opts.open(path)?;
    std::io::Write::write_all(&mut f, data)?;
    Ok(())
}

/// What a mainnet campaign needs to be allowed (see mainnet.rs).
#[derive(Clone, Copy, Default)]
pub struct MainnetCheck {
    pub confirmed: bool,
    pub nu7_height: Option<u32>,
}

/// A payment the dashboard warns about once it has been skipped this many watch passes in a row.
pub(crate) const SKIP_WARN_PASSES: u64 = 10;

/// Keeps, in `private/skips.json`, how many watch passes in a row each payment was skipped (a valid payment whose ticket could not be built:
/// a failure on the host's side, never a reject) and the last reason. Payments that only wait for their confirmations are not counted, and a
/// payment that is no longer skipped is dropped. The dashboard warns from SKIP_WARN_PASSES on; nothing is rejected automatically.
fn record_skips(run: &Run, skipped: &[(String, String)]) {
    let path = run.dir.join("private").join("skips.json");
    let old: BTreeMap<String, serde_json::Value> = fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut now: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for (key, reason) in skipped.iter().filter(|(_, r)| !r.starts_with("waiting for ")) {
        let count = old.get(key).and_then(|v| v["count"].as_u64()).unwrap_or(0) + 1;
        let first = old.get(key).and_then(|v| v["first_unix"].as_u64()).unwrap_or_else(now_unix);
        now.insert(key.clone(), serde_json::json!({ "count": count, "reason": reason, "first_unix": first }));
    }
    if now.is_empty() && old.is_empty() {
        return;
    }
    let _ = write_private(&path, &serde_json::to_vec_pretty(&now).unwrap_or_default());
}

/// The payments skipped at least SKIP_WARN_PASSES passes in a row: (`txid:action`, passes, last reason).
pub(crate) fn long_skips(run: &Run) -> Vec<(String, u64, String)> {
    let skips: BTreeMap<String, serde_json::Value> =
        fs::read(run.dir.join("private").join("skips.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    skips
        .into_iter()
        .filter_map(|(k, v)| Some((k, v["count"].as_u64()?, v["reason"].as_str().unwrap_or_default().to_string())))
        .filter(|(_, c, _)| *c >= SKIP_WARN_PASSES)
        .collect()
}

fn now_unix() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
/// Uniform-price auction settings (SPEC §8).
pub struct Uniform {
    pub reserve_zat: u64,
    pub treasury_address: String,
    pub treasury_ufvk: String,
}

fn create(
    run: &Path,
    cfg: RunConfig,
    network: &str,
    mode: &str,
    goal_zat: Option<u64>,
    items: Option<u32>,
    deadline_in: u32,
    relays: &[String],
    min_contribution_zat: Option<u64>,
    uniform: Option<Uniform>,
    ticket_k: u32,
    mainnet: MainnetCheck,
    name: Option<String>,
    early_close: bool,
    cap_zat: Option<u64>,
) -> Result<()> {
    mainnet::require_confirmation(network, mainnet.confirmed)?;
    if let Some(n) = &name {
        ll_core::rules::check_name(n)?; // before anything is created
    }
    if let Some(cap) = cap_zat {
        // before anything is created (the full rules are checked again below)
        ensure!(mode == "raise", "only a fundraiser can have a hard cap; an auction has its number of items instead");
        ensure!(goal_zat.is_none_or(|g| cap >= g), "the hard cap must be at least the goal (the soft cap)");
    }
    if run.join("rules.json").exists() {
        bail!("{} already holds a campaign", run.display());
    }
    make_private_dir(run)?; // the campaign's key and wallet live in here: only this user may open it
    // the wallet and its key file must be inside the campaign folder; they are stored as names inside it, so a copy of the folder keeps working
    let canon = run.canonicalize()?;
    let inside = |p: &Path, what: &str| -> Result<PathBuf> {
        let real = p.canonicalize().map_err(|_| anyhow!("the {what} {} does not exist", p.display()))?;
        real.strip_prefix(&canon).map(PathBuf::from).map_err(|_| anyhow!("the {what} {} must be inside the campaign folder {}", p.display(), run.display()))
    };
    let min_confirmations = cfg.min_confirmations.or((network == "main").then_some(MAINNET_MIN_CONFIRMATIONS)).filter(|n| *n > 1);
    if let Some(n) = min_confirmations {
        ensure!(n <= 20, "--min-confirmations must be 20 or fewer, not {n}");
        ensure!(ticket_k >= n + 5, "the ticket window K ({ticket_k} blocks) must leave room after {n} confirmations: at least {} blocks", n + 5);
    }
    let cfg = RunConfig { wallet: inside(&cfg.wallet, "wallet")?, identity: inside(&cfg.identity, "wallet key file")?, min_confirmations, ..cfg };
    fs::write(run.join("config.json"), serde_json::to_vec_pretty(&cfg)?)?;
    let mut backend = backend_for(run)?;
    backend.sync()?;
    let tip = backend.chain_tip()?;
    mainnet::nu7_guard(network, Some(tip.height), mainnet::blocks_needed(deadline_in, ticket_k), now_unix(), mainnet.nu7_height)?;
    let account = backend.account()?;
    let secrets = CampaignSecrets::generate();
    let fee = 10_000;
    let auction = mode == "auction";
    if uniform.is_some() && !auction {
        bail!("a reserve and treasury only apply to an auction");
    }
    if let Some(u) = &uniform {
        check_treasury(network, &u.treasury_address, &u.treasury_ufvk)?;
        if u.reserve_zat == 0 {
            bail!("the reserve price must be above zero");
        }
    }
    let rules = Rules {
        v: 1,
        network: network.into(),
        mode: mode.into(),
        goal_zat: if auction { None } else { goal_zat },
        items: if auction { items } else { None },
        start_height: tip.height + 1,
        deadline_height: tip.height + deadline_in,
        ticket_k,
        close_grace: 10,
        reissue_window: 20,
        refund_fee_zat: fee,
        min_contribution_zat: min_contribution_zat.unwrap_or(2 * fee),
        campaign_ufvk: (!auction).then(|| account.ufvk.clone()),
        ufvk_hash: auction.then(|| ufvk_hash(&account.ufvk)),
        pay_to: Some(ll_core::receiver::to_standard(&account.address)?),
        pricing: uniform.as_ref().map(|_| "uniform".to_string()),
        settle_window: uniform.as_ref().map(|_| 40.max(ticket_k)),
        reserve_zat: uniform.as_ref().map(|u| u.reserve_zat),
        treasury_address: uniform.as_ref().map(|u| ll_core::receiver::to_standard(&u.treasury_address)).transpose()?,
        treasury_ufvk: uniform.as_ref().map(|u| u.treasury_ufvk.clone()),
        name,
        early_close: early_close.then_some(true),
        cap_zat: if auction { None } else { cap_zat },
        ledger_pubkey: secrets.ledger_pubkey_hex()?,
        payload_pubkey: secrets.payload_pubkey_hex()?,
    };
    rules.validate()?;
    if let Some(w) = rules.cap_warning() {
        println!("warning: {w}");
    }
    if rules.min_contribution_zat < 2 * fee {
        bail!("the smallest contribution must be at least {} zatoshis (twice the refund fee), or a refund would leave nothing", 2 * fee);
    }
    let rules_id = hex::encode(rules.id()?);
    fs::write(run.join("rules.json"), serde_json::to_vec_pretty(&rules)?)?;
    fs::write(run.join("rules_id"), &rules_id)?;
    write_private(&run.join("secrets.json"), &serde_json::to_vec_pretty(&secrets)?)?;
    if auction {
        // Kept private until close; only its hash is in the rules.
        write_private(&run.join("private").join("ufvk"), account.ufvk.as_bytes())?;
    }
    fs::write(run.join("address"), &account.address)?;
    if !relays.is_empty() {
        let published = Run::load(run)?;
        published.add_relays(relays)?;
        sync_relays(&published);
    }
    write_private(
        &run.join("private").join("branch"),
        &serde_json::to_vec_pretty(&BranchRecord { branch_id: tip.branch_id.clone(), height: tip.height })?,
    )?;
    println!("{mode} created (backend: {})", backend.name());
    println!("  rules_id:  {rules_id}");
    println!("  address:   {}", account.address);
    println!("  heights:   start {} deadline {}", rules.start_height, rules.deadline_height);
    match (rules.goal_zat, rules.items) {
        (Some(g), _) => println!("  goal:      {g} zat"),
        (_, Some(n)) => println!("  items:     {n} (viewing key sealed until close)"),
        _ => {}
    }
    Ok(())
}

/// Prints a line and keeps it, so a caller (the dashboard) can show what happened.
macro_rules! note {
    ($log:expr, $($arg:tt)*) => {{
        let m = format!($($arg)*);
        println!("{m}");
        $log.push(m);
    }};
}

/// The treasury address must belong to the (public) viewing key published with it, or nobody could see what the
/// treasury received.
fn check_treasury(network: &str, address: &str, ufvk: &str) -> Result<()> {
    let params = match network {
        "main" => zcash_protocol::consensus::Network::MainNetwork,
        _ => zcash_protocol::consensus::Network::TestNetwork,
    };
    let key = zcash_keys::keys::UnifiedFullViewingKey::decode(&params, ufvk).map_err(|e| anyhow::anyhow!("bad treasury viewing key: {e}"))?;
    let (_, raw) = orchard_receiver(address)?;
    let addr = Option::from(orchard::Address::from_raw_address_bytes(&raw)).context("bad treasury address")?;
    let fvk = key.orchard().context("the treasury viewing key has no Orchard/Ironwood part")?;
    if fvk.to_ivk(orchard::keys::Scope::External).diversifier_index(&addr).is_none() {
        bail!("the treasury address does not belong to the treasury viewing key");
    }
    Ok(())
}

/// Payments mined after the last height that counts: the deadline, or an early close (SPEC §4). They are not contributions.
pub(crate) fn late_payments(rules: &Rules, entries: &[Entry], notes: &[ChainNote]) -> Vec<ChainNote> {
    let end = contribution_end(rules, entries);
    notes.iter().filter(|n| !n.is_change && n.height.is_some_and(|h| h > end)).cloned().collect()
}

/// Whether the campaign may be closed now (SPEC §4): after the deadline, or before it for a fundraiser whose rules allow closing early,
/// once the goal is met net of the contributions taken back (computed as the recount computes it). Otherwise the plain reason.
/// The words "not reached" mark "wait for the deadline"; the scripts that close as soon as they may look for them.
pub(crate) fn may_close(rules: &Rules, a: &Analysis, tip: u32) -> std::result::Result<(), String> {
    if tip > rules.deadline_height {
        return Ok(());
    }
    if !rules.allows_early_close() {
        return Err(if rules.is_auction() {
            format!("deadline {} not reached (tip {tip}); an auction cannot be closed early", rules.deadline_height)
        } else {
            format!("deadline {} not reached (tip {tip}); this campaign's rules do not allow closing early", rules.deadline_height)
        });
    }
    if a.goal_met != Some(true) {
        let net: u64 = a.contributions.iter().filter(|n| n.nf.as_ref().is_some_and(|nf| !a.withdrawn.contains(nf))).map(|n| n.value_zat).sum();
        return Err(format!(
            "the goal is not met yet ({net} of {} zat, counting only contributions that were not taken back{}), so this campaign cannot close early; it can close as soon as the goal is met, or after the deadline (block {})",
            rules.goal_zat.unwrap_or(0),
            if rules.cap_zat.is_some() { "; with a hard cap, only what fits under it counts" } else { "" },
            rules.deadline_height
        ));
    }
    Ok(())
}

fn chain_notes(notes: &[WalletNote]) -> Vec<ChainNote> {
    notes.iter().map(|w| w.note.clone()).collect()
}

/// Wallet lock height meaning "until released".
const LOCK_FOREVER: u32 = u32::MAX;

/// Releases the wallet lock of every ticketed note whose spend (its own ticket, whoever
/// broadcast it, or the sweep) is confirmed on chain. A contributor broadcasting their own
/// ticket is detected here: the spend shows up in the wallet like any other.
fn release_confirmed_locks(backend: &mut dyn WalletBackend, notes: &[WalletNote]) -> usize {
    let mut released = 0;
    for w in notes {
        let n = &w.note;
        let (Some(nf), Some(spend)) = (&n.nf, &n.spent_by) else { continue };
        if w.lock_owner.is_none() || spend.height.is_none() {
            continue;
        }
        match backend.unlock(&n.txid, n.action, &format!("ticket:{nf}")) {
            Ok(true) => {
                released += 1;
                println!("lock released: {}:{} spent by {} (confirmed)", n.txid, n.action, spend.txid);
            }
            Ok(false) => {}
            Err(e) => println!("could not release lock on {}:{}: {e:#}", n.txid, n.action),
        }
    }
    released
}

/// The guard: the only spends allowed from ticketed notes are their own tickets and, after
/// the deadline, the sweep of the kept set. Reports any other spend it sees.
fn guard_messages(run: &Run, entries: &[Entry], notes: &[WalletNote]) -> Vec<String> {
    let a = analyze(&run.rules, &run.rules_id, entries, &chain_notes(notes), &[]);
    let mut alerts = vec![];
    for n in &a.contributions {
        let (Some(nf), Some(spend)) = (&n.nf, &n.spent_by) else { continue };
        let honest = a.tickets.get(nf).is_some_and(|t| t.contains(&spend.txid));
        let kept_after_deadline =
            a.keep.contains(nf) && spend.height.is_some_and(|h| h > run.rules.deadline_height);
        if !honest && !kept_after_deadline {
            alerts.push(format!("contribution {nf} was spent by {} (not its ticket)", spend.txid));
        }
    }
    alerts
}

fn guard_audit(run: &Run, entries: &[Entry], notes: &[WalletNote]) -> usize {
    let alerts = guard_messages(run, entries, notes);
    for m in &alerts {
        println!("GUARD ALERT: {m}");
    }
    alerts.len()
}

fn contribution_of(run: &Run, n: &ChainNote) -> Result<Contribution> {
    let nf = n.nf.clone().context("note without nullifier")?;
    let auction = run.rules.is_auction();
    Ok(Contribution {
        txid: n.txid.clone(),
        action: n.action,
        nf: nf.clone(),
        height: n.height.context("unmined note")?,
        value_zat: (!auction).then_some(n.value_zat),
        amount_commit: if auction { Some(amount_commit(&run.amount_key()?, &nf, n.value_zat)?) } else { None },
    })
}

/// Builds, checks and signs a ticket for one contribution, stores the host's signed copy and
/// the contributor's sealed copy, and appends the ledger entry.
fn issue_ticket(
    run: &Run,
    backend: &mut dyn WalletBackend,
    n: &ChainNote,
    payload: &Payload,
    tip: u32,
    kind: &str,
) -> Result<Entry> {
    let nf = n.nf.clone().context("note without nullifier")?;
    let refund_zat = n.value_zat - run.rules.refund_fee_zat;
    let owner = format!("ticket:{nf}");

    // Double lock: the wallet lock keeps ordinary wallet commands off the note, and also
    // lets the builder pick exactly this note.
    // The lock has no end height: it lasts until the note is spent (by its ticket or the
    // sweep) and that spend is confirmed; then `release_confirmed_locks` removes it.
    backend.lock(&n.txid, n.action, &owner, LOCK_FOREVER)?;
    let (pay_receiver, to) = ticket_receiver(backend, &run.rules.network, payload.refund_receiver)?;
    let unsigned = backend.build(&SpendRequest { to_address: to, value_zat: refund_zat, lock_owners: vec![owner], no_expiry: true, also_pay: vec![] })?;
    let signed = backend.sign(&unsigned)?;
    let checked = ticket::check_and_extract(
        &signed,
        &Expect { spends: BTreeMap::from([(hex32(&nf)?, n.value_zat)]), receiver: &pay_receiver, value_zat: refund_zat, no_expiry: true, also: vec![] },
    )?;

    // The ticket must be built for the branch the network itself reports for the next block. The
    // libraries derive it from built-in activation heights, which can lag the real network (for
    // example mainnet NU7 before the libraries know its height); a ticket for the wrong branch
    // would be rejected by every node when the contributor tries to use it.
    if !BRANCH_SIMULATED.load(std::sync::atomic::Ordering::Relaxed) {
        let now = backend.chain_tip()?;
        ensure!(
            checked.branch_id == now.branch_id,
            "the ticket was built for consensus branch {} but the network reports {}; not issuing it",
            checked.branch_id, now.branch_id
        );
    }

    write_private(&run.signed_ticket_path(&nf), &signed)?;
    // Sealed format version 2 carries the refund output's opening values (SPEC §3.1) so the contributor's page can check
    // that the ticket pays the address they gave.
    let sealed_raw = ticket_plaintext(checked.raw_tx.clone(), checked.opening);
    let blob = crypto_box::PublicKey::from(payload.enc_pubkey)
        .seal(&mut OsRng, &sealed_raw)
        .map_err(|e| anyhow::anyhow!("seal ticket: {e}"))?;
    let tickets = run.dir.join("tickets");
    fs::create_dir_all(&tickets)?;
    fs::write(tickets.join(format!("{nf}.blob")), &blob)?;

    // TEST ONLY (`test-cheats` builds): `LL_TEST_BACKDATE_ISSUE=<payment txid>` makes a lying host that writes the payment's own
    // height as the issue height of that payment's ticket, to show that the recount cannot tell (docs/THREAT_MODEL.md threat 22).
    #[cfg(feature = "test-cheats")]
    let tip = match (std::env::var("LL_TEST_BACKDATE_ISSUE"), n.height) {
        (Ok(t), Some(h)) if t == n.txid => {
            banner("this ticket's issue height is BACKDATED to its payment's height, on purpose.");
            h
        }
        _ => tip,
    };
    let mut entry = Entry::new(&run.rules_id, kind);
    entry.contribution = Some(contribution_of(run, n)?);
    entry.ticket = Some(Ticket { txid: checked.txid, issue_height: tip, branch_id: checked.branch_id });
    entry.blob_hash = Some(ledger::blob_hash(&blob));
    run.append(entry)
}

/// Publishes to one relay whatever it is missing: the rules, ledger entries in order, and the
/// sealed ticket of each entry. Returns how many items were sent.
fn sync_one_relay(run: &Run, url: &str) -> Result<usize> {
    let relay = ll_relay::client::Relay::new(url);
    relay.register(&run.rules)?;
    let have = relay.head_entries(&run.rules_id)? as usize;
    let entries = run.ledger().load()?;
    let mut sent = 0;
    for e in entries.iter().skip(have) {
        relay.put_entry(&run.rules_id, e)?;
        sent += 1;
    }
    for e in &entries {
        let (Some(hash), Some(nf)) = (&e.blob_hash, e.nf()) else { continue };
        let Ok(bytes) = fs::read(run.dir.join("tickets").join(format!("{nf}.blob"))) else { continue };
        if ledger::blob_hash(&bytes) == *hash && !relay.has_blob(&run.rules_id, hash)? {
            relay.put_blob(&run.rules_id, hash, &bytes)?;
            sent += 1;
        }
    }
    Ok(sent)
}

/// Publishes to every configured relay. A relay that is down is not an error for the host:
/// the ledger on disk is the source of truth, and the next pass sends what is missing.
fn sync_relays(run: &Run) -> Vec<(String, std::result::Result<usize, String>)> {
    let mut out = vec![];
    for url in run.relays() {
        let result = sync_one_relay(run, &url);
        match &result {
            Ok(0) => {}
            Ok(n) => println!("relay {url}: published {n} item(s)"),
            Err(e) => println!("relay {url}: {e:#} (the ledger is safe on disk; will retry next pass)"),
        }
        out.push((url, result.map_err(|e| format!("{e:#}"))));
    }
    out
}

/// The consensus branch the host last saw, kept privately so a restart cannot miss an upgrade.
#[derive(Serialize, Deserialize)]
struct BranchRecord {
    branch_id: String,
    height: u32,
}

fn branch_path(run: &Run) -> PathBuf {
    run.dir.join("private").join("branch")
}

fn record_branch(run: &Run, tip: &backend::ChainTip) -> Result<()> {
    let rec = BranchRecord { branch_id: tip.branch_id.clone(), height: tip.height };
    write_private(&branch_path(run), &serde_json::to_vec_pretty(&rec)?)
}

/// Detects a network upgrade by the chain's own signal (the consensus branch ID reported at
/// the current height, never by date) and re-issues the open campaign's stale tickets.
/// The new branch is recorded only after re-issue succeeds, so a failed attempt is retried.
fn check_upgrade(run: &Run, backend: &mut dyn WalletBackend, tip: &backend::ChainTip) -> Result<()> {
    let path = branch_path(run);
    let Ok(raw) = fs::read(&path) else {
        return record_branch(run, tip); // first pass for this run: remember where we are
    };
    let seen: BranchRecord = serde_json::from_slice(&raw)?;
    if seen.branch_id == tip.branch_id {
        return Ok(());
    }
    println!(
        "NETWORK UPGRADE detected at height {}: consensus branch {} -> {} (last seen at height {})",
        tip.height, seen.branch_id, tip.branch_id, seen.height
    );
    if close_entry(&run.ledger().load()?).is_some() {
        println!("  campaign already closed: nothing to re-issue");
        return record_branch(run, tip);
    }
    let count = reissue_inner(run, backend, Some(&tip.branch_id))?;
    println!("  re-issued {count} stale ticket(s); ledger updated, wallet locks unchanged");
    record_branch(run, tip)
}

/// What one watch pass saw, for the dashboard.
struct PassInfo {
    tip: u32,
    branch: String,
    relays: Vec<(String, std::result::Result<usize, String>)>,
}

/// Set only by the test-only `--assume-branch-id`, where the reported branch is deliberately not real.
static BRANCH_SIMULATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Writes the entry that every payment waiting for one needs: a refund ticket for a valid contribution, or a reject for a payment that is not one.
/// Used by every check of a running host, and by `close` for anything that was missed (a late ticket, as the watcher would issue it).
/// Returns how many entries were written and, for each payment that could not be dealt with, its `txid:action` and the reason.
fn issue_pending(run: &Run, backend: &mut dyn WalletBackend, notes: &[WalletNote], entries: &[Entry], tip: &backend::ChainTip) -> Result<(usize, Vec<(String, String)>)> {
    let r = &run.rules;
    let mut new = 0;
    let mut skipped: Vec<(String, String)> = vec![];
    // Chain order, so the earliest acceptable payment with a given sealed message is the contribution. A payment that is rejected (for
    // instance because it is smaller than the amount sealed in its message) does not use up the message; an accepted one does.
    let mut ordered: Vec<&WalletNote> = notes.iter().collect();
    ordered.sort_by(|x, y| {
        let (a, b) = (&x.note, &y.note);
        a.height.cmp(&b.height).then(a.tx_index.cmp(&b.tx_index)).then(a.txid.cmp(&b.txid)).then(a.action.cmp(&b.action))
    });
    let mut accepted: std::collections::BTreeSet<String> = entries
        .iter()
        .filter(|e| e.ticket.is_some())
        .filter_map(|e| e.nf().and_then(|nf| notes.iter().find(|w| w.note.nf.as_deref() == Some(nf)).and_then(|w| w.note.memo_text.clone())))
        .collect();
    let end = contribution_end(r, entries); // the deadline, or an early close
    for note in ordered {
        let n = &note.note;
        let (Some(h), Some(nf)) = (n.height, &n.nf) else { continue };
        let candidate = !n.is_change
            && h >= r.start_height
            && h <= end
            && n.value_zat >= r.min_contribution_zat
            && n.spent_by.is_none()
            && n.memo_text.as_deref().is_some_and(is_payload_shaped);
        if !candidate || entries.iter().any(|e| e.nf() == Some(nf.as_str())) {
            continue;
        }
        let confirmations = (tip.height + 1).saturating_sub(h);
        if confirmations < run.min_confirmations {
            skipped.push((format!("{}:{}", n.txid, n.action), format!("waiting for {} confirmations (it has {confirmations})", run.min_confirmations)));
            continue;
        }
        let opened = Payload::open(n.memo_text.as_deref().unwrap_or_default(), &run.secrets.payload_key()?)
            .map_err(|e| anyhow!("{e} [unreadable]"))
            .and_then(|p| {
                if n.memo_text.as_deref().is_some_and(|memo| accepted.contains(memo)) {
                    bail!("replayed payload: the same sealed message was already used by an earlier payment");
                }
                // the one validity rule (shared with the recount): a payload that fails it is rejected here, before any lock or build
                ll_core::payload::check(&p, &run.rules_id, n.value_zat, r.refund_fee_zat).map_err(|e| anyhow!(e.reason(r)))?;
                Ok(p)
            });
        let result = match opened {
            Ok(payload) => {
                let r = issue_ticket(run, backend, n, &payload, tip.height, "issue");
                if r.is_ok() {
                    if let Some(memo) = &n.memo_text {
                        accepted.insert(memo.clone());
                    }
                }
                r
            }
            Err(reason) => {
                let mut e = Entry::new(&run.rules_id, "reject");
                e.contribution = Some(contribution_of(run, n)?);
                e.reason = Some(reason.to_string());
                let written = run.append(e);
                // An older host may have locked this note while it kept failing to build a ticket for it: a rejected payment holds no lock.
                if written.is_ok() {
                    let _ = backend.unlock(&n.txid, n.action, &format!("ticket:{nf}"));
                }
                written
            }
        };
        match result {
            Ok(e) => {
                new += 1;
                match &e.ticket {
                    Some(t) => println!("ticket issued: entry {} for {}:{} -> ticket {} (branch {})", e.seq, n.txid, n.action, t.txid, t.branch_id),
                    None => println!("rejected: entry {} for {}:{} ({})", e.seq, n.txid, n.action, e.reason.unwrap_or_default()),
                }
            }
            Err(err) => { println!("skipped {}:{}: {err:#}", n.txid, n.action); skipped.push((format!("{}:{}", n.txid, n.action), format!("{err:#}"))); },
        }
    }
    Ok((new, skipped))
}

fn watch_once(run: &Run, backend: &mut dyn WalletBackend, assume_branch: Option<&str>) -> Result<PassInfo> {
    backend.sync()?;
    let mut tip = backend.chain_tip()?;
    if let Some(b) = assume_branch {
        BRANCH_SIMULATED.store(true, std::sync::atomic::Ordering::Relaxed);
        tip.branch_id = b.to_string();
    }
    check_upgrade(run, backend, &tip)?;
    let notes = backend.notes()?;
    let entries = run.ledger().load()?;

    let alerts = guard_audit(run, &entries, &notes);
    release_confirmed_locks(backend, &notes);
    // Transactions the host already sent (close refunds, sweeps, settlements): follow them, send again what a
    // server dropped, and rebuild only what is provably dead.
    let had_dead = outbox::Outbox::load(&run.dir).map(|o| o.items.iter().any(|s| s.status == "dead")).unwrap_or(false);
    process_outbox(run, backend, &tip, &notes);
    let dead_now = outbox::Outbox::load(&run.dir).map(|o| o.items.iter().any(|s| s.status == "dead")).unwrap_or(false);
    // the close is resumed while anything is left: a dead transaction to rebuild, or a step that did not finish
    let unfinished = !close_unfinished(run).is_empty();
    if (dead_now || had_dead || unfinished) && close_entry(&entries).is_some() {
        if let Ok(to) = fs::read_to_string(run.dir.join("private").join("sweep_to")) {
            if let Err(e) = close(run, backend, to.trim()) {
                println!("finishing the close failed: {e:#}");
            }
        }
    }
    let (new, skipped) = issue_pending(run, backend, &notes, &entries, &tip)?;
    record_skips(run, &skipped);
    println!("tip {} (branch {}): {} ledger entries, {new} new, {alerts} guard alerts", tip.height, tip.branch_id, entries.len() + new);
    let relays = sync_relays(run);
    publish_heartbeat(run, tip.height, &relays);
    finalize(run, &relays);
    Ok(PassInfo { tip: tip.height, branch: tip.branch_id.clone(), relays })
}

/// Tells the relays that the host is looking at the campaign right now (a small signed record, SPEC §6), so the contributor page can warn when it is not.
/// Best effort and separate from the list: a failure here never stops a pass, and only relays that just took the list are asked (a dead one would only
/// slow the pass down). Not sent once the campaign is closed.
fn publish_heartbeat(run: &Run, height: u32, relays: &[(String, std::result::Result<usize, String>)]) {
    let closed = run.ledger().load().map(|e| e.iter().any(|x| x.kind == "close")).unwrap_or(false);
    if closed {
        return;
    }
    let Ok(sk) = run.secrets.ledger_key() else { return };
    let mut hb = ll_core::heartbeat::Heartbeat::new(&run.rules_id, height, now_unix());
    if hb.sign(&sk).is_err() {
        return;
    }
    for (url, res) in relays {
        if res.is_ok() {
            match ll_relay::client::Relay::new(url).put_heartbeat(&run.rules_id, &hb) {
                Ok(()) => {}
                // a relay built before heartbeats existed has no such route: nothing to say about it on every pass
                Err(ll_relay::client::RelayError::Refused { status: 404 | 405, .. }) => {}
                Err(e) => println!("heartbeat to {url}: {e}"),
            }
        }
    }
}

/// The step that follows the close (not part of it, and it moves no money): once the close entry is in the list, the host signs a short record of the list
/// as it stands (how many entries, the hash of the last one), saves it with the final public copy of the list under `public/`, and gives it to the relays that
/// just took the list. Safe to run again: it only writes when the list has grown (settlement entries after the close). Returns the record.
pub(crate) fn finalize(run: &Run, relays: &[(String, std::result::Result<usize, String>)]) -> Option<ll_core::final_copy::FinalRecord> {
    use ll_core::final_copy::FinalRecord;
    let entries = run.ledger().load().ok()?;
    let fresh = FinalRecord::of(&run.rules_id, &entries).ok()?; // none before the close entry exists
    let dir = run.dir.join("public");
    let path = dir.join("final.json");
    let have: Option<FinalRecord> = fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let rec = match have {
        Some(r) if r.entries == fresh.entries && r.last_hash == fresh.last_hash => r,
        _ => {
            let mut r = fresh;
            r.sign(&run.secrets.ledger_key().ok()?).ok()?;
            fs::create_dir_all(&dir).ok()?;
            fs::write(&path, ll_core::canon::to_canonical(&r).ok()?).ok()?;
            if let Ok(copy) = public_copy(run) {
                let _ = fs::write(dir.join("final-ledger.json"), serde_json::to_vec_pretty(&copy).unwrap_or_default());
            }
            println!("final copy saved in {}: {}", dir.display(), r.line());
            r
        }
    };
    for (url, res) in relays {
        if res.is_ok() {
            match ll_relay::client::Relay::new(url).put_final(&run.rules_id, &rec) {
                Ok(()) => {}
                // an older relay has no such route; a relay that already holds this record or a later one says 409
                Err(ll_relay::client::RelayError::Refused { status: 404 | 405 | 409, .. }) => {}
                Err(e) => println!("final record to {url}: {e}"),
            }
        }
    }
    Some(rec)
}

/// ZIP 317 fee for an Ironwood-only transaction with `n` spends and one output.
fn sweep_fee(n: usize) -> u64 {
    5_000 * n.max(2) as u64
}

fn close(run: &Run, backend: &mut dyn WalletBackend, sweep_to: &str) -> Result<Vec<String>> {
    let mut log: Vec<String> = vec![];
    backend.sync()?;
    let tip = backend.chain_tip()?;
    // before the deadline only a fundraiser that allows an early close may close (the goal is checked below, once every ticket is issued);
    // a close that was already written is always finished
    // TEST ONLY (`test-cheats` builds): `LL_TEST_FORCE_EARLY_CLOSE=1` makes a cheating host that closes before the deadline whatever the rules
    // say, to show that the recount catches it (R2).
    #[cfg(feature = "test-cheats")]
    let forced = std::env::var("LL_TEST_FORCE_EARLY_CLOSE").is_ok();
    #[cfg(not(feature = "test-cheats"))]
    let forced = false;
    #[cfg(feature = "test-cheats")]
    if forced {
        banner("this host closes BEFORE the deadline although the rules may not allow it, on purpose.");
    }
    if !forced && tip.height <= run.rules.deadline_height && !run.rules.allows_early_close() && close_entry(&run.ledger().load()?).is_none() {
        bail!("{}", may_close(&run.rules, &Analysis::default(), tip.height).unwrap_err());
    }
    let mut wallet_notes = backend.notes()?;
    release_confirmed_locks(backend, &wallet_notes);
    let mut entries = run.ledger().load()?;

    // Before the close entry is written (nothing can be added to the list after it): every payment that still waits for its entry gets it now, late,
    // exactly as the watcher would have issued it. If a counted contribution still has no ticket after that, closing would leave its money in the
    // wallet with no way to refund it, so the close stops here, before anything is written or sent, and says which payments and what to do.
    // TEST ONLY (`test-cheats` builds): `LL_TEST_BACKDATE_CLOSE=<height>` makes a cheating host that writes an EARLIER close height than
    // the chain's, after skipping the tickets still pending, to see whether an early close can be backdated to leave a later payer out.
    #[cfg(feature = "test-cheats")]
    let backdate: Option<u32> = std::env::var("LL_TEST_BACKDATE_CLOSE").ok().and_then(|v| v.parse().ok());
    #[cfg(not(feature = "test-cheats"))]
    let backdate: Option<u32> = None;
    #[cfg(feature = "test-cheats")]
    if let Some(h) = backdate {
        banner(&format!("this host writes the close height {h} instead of the chain's {}, and skips pending tickets, on purpose.", tip.height));
    }
    if close_entry(&entries).is_none() && backdate.is_none() {
        let (issued, skipped) = issue_pending(run, backend, &wallet_notes, &entries, &tip)?;
        if issued > 0 {
            note!(log, "issued {issued} entr{} that the watcher had not written yet (late; the recount will show them as late)", if issued == 1 { "y" } else { "ies" });
            wallet_notes = backend.notes()?;
            entries = run.ledger().load()?;
        }
        let a0 = analyze(&run.rules, &run.rules_id, &entries, &chain_notes(&wallet_notes), &[]);
        let missing: Vec<&ChainNote> = a0.contributions.iter().filter(|n| n.nf.as_ref().is_some_and(|nf| !a0.first_issue.contains_key(nf))).collect();
        if !missing.is_empty() {
            let list: Vec<String> = missing
                .iter()
                .map(|n| {
                    let key = format!("{}:{}", n.txid, n.action);
                    let why = skipped.iter().find(|(k, _)| *k == key).map(|(_, e)| e.as_str()).unwrap_or("no reason was reported");
                    format!("  {key} ({} zat): {why}", n.value_zat)
                })
                .collect();
            bail!(
                "The campaign was NOT closed (nothing was written or sent). {} payment(s) count as contributions but have no refund ticket, and a ticket cannot be added after the close, so closing now would leave their money in the wallet:\n{}\nWhat to do: make sure this campaign's wallet can reach the network (the dashboard's \"last network check\" should be recent), wait for the next check or run `./app/target/release/cb-host watch --run {} --once` and read its \"skipped\" lines, then close again. If a payment cannot be ticketed, tell its contributor and return the money by hand before closing.",
                missing.len(),
                list.join("\n"),
                run.dir.display()
            );
        }
    }
    let notes = chain_notes(&wallet_notes);
    let a = analyze(&run.rules, &run.rules_id, &entries, &notes, &[]);

    if close_entry(&entries).is_none() {
        // an early close: only once the goal is met (nothing is written or sent otherwise)
        if !forced {
            may_close(&run.rules, &a, tip.height).map_err(|e| anyhow!("The campaign was NOT closed (nothing was written or sent): {e}."))?;
        }
        let mut e = Entry::new(&run.rules_id, "close");
        let auction = run.rules.is_auction();
        e.close = Some(Close {
            close_height: backdate.unwrap_or(tip.height),
            outcome: match a.goal_met {
                Some(true) => "goal_met".into(),
                Some(false) => "goal_missed".into(),
                None => "auction".into(),
            },
            winners: a.winners.clone(),
            ufvk: if auction { Some(fs::read_to_string(run.dir.join("private").join("ufvk"))?) } else { None },
            amount_key: if auction { run.secrets.amount_key.clone() } else { None },
            clearing_price_zat: a.plan.as_ref().map(|p| p.price_zat),
        });
        let e = run.append(e)?;
        note!(log, "close entry {}: {}", e.seq, e.close.as_ref().map(|c| c.outcome.as_str()).unwrap_or_default());
        if let Some(w) = &a.winners {
            note!(log, "  winners: {w:?}");
        }
    }

    // (the cheating host above: what it keeps is decided by its own, backdated close height)
    #[cfg(feature = "test-cheats")]
    let a = if backdate.is_some() { analyze(&run.rules, &run.rules_id, &run.ledger().load()?, &notes, &[]) } else { a };
    // TEST ONLY (`test-cheats` builds): `LL_TEST_KEEP_OVER_CAP=1` makes a cheating host that sweeps the payments over the hard cap too, instead of
    // refunding them, to see that the recount flags it (R6).
    #[cfg(feature = "test-cheats")]
    let a = if std::env::var("LL_TEST_KEEP_OVER_CAP").is_ok() {
        banner("this host keeps the payments over the hard cap instead of refunding them, on purpose.");
        let mut a = a;
        let over: Vec<String> = a.over_cap.iter().filter_map(|n| n.nf.clone()).collect();
        a.keep.extend(over);
        a
    } else {
        a
    };
    // From here on the close entry exists. Every later step is recorded: one that fails does not stop the others, what is left is written to
    // `private/close_state.json`, and running the close again (the dashboard's "Try again", or the watcher on its own) does only what is not done.
    // Nothing is sent twice: whatever was sent is in the outbox and is skipped, and a refund is always the same pre-signed transaction.
    let recorded = fs::read_to_string(run.dir.join("private").join("sweep_to")).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let sweep_to = match recorded {
        Some(r) if r != sweep_to => {
            note!(log, "finishing the close with the address recorded when it was first closed, not the one given now");
            r
        }
        _ => sweep_to.to_string(),
    };
    let sweep_to = sweep_to.as_str();
    write_private(&run.dir.join("private").join("sweep_to"), sweep_to.as_bytes())?;
    // until the steps below report, everything after the close entry counts as not done (a crash in the middle leaves this, so it is resumed)
    let mut done = close_done(run);
    write_close_state(run, &["the steps after the close entry".to_string()], &done)?;
    let mut unfinished: Vec<String> = vec![];

    if run.rules.is_uniform() {
        if let Err(e) = settle_winners(run, backend, &tip, &a, &mut log) {
            note!(log, "settlement did not finish: {e:#}");
            unfinished.push("the winners' settlement".into());
        }
    }

    // Sweep the kept set (exactly those notes, one output to the treasury). A uniform-price auction
    // settles each winner on its own above, so nothing is swept here.
    let ob_now = outbox::Outbox::load(&run.dir)?;
    if !run.rules.is_uniform() {
        if let Err(e) = sweep_kept(run, backend, &tip, &a, &ob_now, sweep_to, &mut log) {
            note!(log, "the sweep did not finish: {e:#}");
            unfinished.push("the sweep to your address".into());
        }
    }

    // Refund everything else that is still unspent.
    for n in a.contributions.iter().filter(|n| n.spent_by.is_none()) {
        let nf = n.nf.clone().unwrap_or_default();
        if a.keep.contains(&nf) {
            continue;
        }
        if ob_now.live_for(&nf).is_some() || done.contains(&format!("refund:{nf}")) {
            continue; // already sent: the outbox follows it (and the close records it, for a wallet tool that has no outbox)
        }
        match fs::read(run.signed_ticket_path(&nf)) {
            Ok(signed) => match send_tracked(run, backend, &tip, "refund", &format!("refund of {}:{}", &n.txid[..8], n.action), &signed, vec![nf.clone()], &mut log) {
                Ok(txid) => {
                    note!(log, "refund broadcast for {}:{}: {txid}", n.txid, n.action);
                    done.push(format!("refund:{nf}"));
                }
                Err(e) => {
                    note!(log, "refund for {}:{} failed: {e:#}", n.txid, n.action);
                    unfinished.push(format!("the refund of {}:{}", &n.txid[..8], n.action));
                }
            },
            Err(_) => {
                note!(log, "NO REFUND for {}:{}: it has no stored ticket, and none can be added after the close. Its money is still in the campaign wallet; return it by hand and tell the contributor.", n.txid, n.action);
                unfinished.push(format!("the refund of {}:{} (by hand: no stored ticket)", &n.txid[..8], n.action));
            }
        }
    }
    write_close_state(run, &unfinished, &done)?;
    log.extend(process_outbox(run, backend, &tip, &wallet_notes));
    sync_relays(run);
    if !unfinished.is_empty() {
        bail!("{}", unfinished_message(&unfinished));
    }
    Ok(log)
}

/// The sentence the host sees when the close entry is written but some later steps are not done yet.
pub(crate) fn unfinished_message(unfinished: &[String]) -> String {
    format!("The campaign is closed, but {} did not finish; Try again finishes it without sending anything twice.", unfinished.join(", "))
}

fn close_state_list(run: &Run, key: &str) -> Vec<String> {
    fs::read(run.dir.join("private").join("close_state.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v[key].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()))
        .unwrap_or_default()
}

/// The steps of a close that are not done yet (empty when the close finished, or was never started).
pub(crate) fn close_unfinished(run: &Run) -> Vec<String> {
    close_state_list(run, "unfinished")
}

/// The steps of a close already done (`refund:<nf>`), so a rerun never sends them again.
fn close_done(run: &Run) -> Vec<String> {
    close_state_list(run, "done")
}

fn write_close_state(run: &Run, unfinished: &[String], done: &[String]) -> Result<()> {
    let state = serde_json::json!({ "unfinished": unfinished, "done": done, "updated_unix": now_unix() });
    let path = run.dir.join("private").join("close_state.json");
    let tmp = path.with_extension("tmp");
    write_private(&tmp, &serde_json::to_vec_pretty(&state)?)?;
    fs::rename(&tmp, &path)?; // never half a file
    Ok(())
}

/// Sends the kept set to the host's address: exactly those notes, one output, checked before it is sent. Notes already being swept are skipped.
fn sweep_kept(run: &Run, backend: &mut dyn WalletBackend, tip: &backend::ChainTip, a: &ll_core::recount::Analysis, ob_now: &outbox::Outbox, sweep_to: &str, log: &mut Vec<String>) -> Result<()> {
    let keep: Vec<&ChainNote> = a
        .contributions
        .iter()
        .filter(|n| n.spent_by.is_none() && n.nf.as_ref().is_some_and(|nf| a.keep.contains(nf) && ob_now.live_for(nf).is_none()))
        .collect();
    if keep.is_empty() {
        return Ok(());
    }
    #[cfg(feature = "test-cheats")]
    if std::env::var("LL_TEST_FAIL_SWEEP").is_ok_and(|v| fs::metadata(&v).is_ok()) {
        bail!("test: the sweep fails on purpose while {} exists", std::env::var("LL_TEST_FAIL_SWEEP").unwrap_or_default());
    }
    let (_, receiver) = orchard_receiver(sweep_to)?;
    let total: u64 = keep.iter().map(|n| n.value_zat).sum();
    let value = total - sweep_fee(keep.len());
    let owners = keep.iter().map(|n| format!("ticket:{}", n.nf.as_deref().unwrap_or_default())).collect();
    let unsigned = backend.build(&SpendRequest { to_address: sweep_to.into(), value_zat: value, lock_owners: owners, no_expiry: true, also_pay: vec![] })?;
    let signed = backend.sign(&unsigned)?;
    let spends = keep.iter().map(|n| Ok((hex32(n.nf.as_deref().unwrap_or_default())?, n.value_zat))).collect::<Result<_>>()?;
    ticket::check_and_extract(&signed, &Expect { spends, receiver: &receiver, value_zat: value, no_expiry: true, also: vec![] })?;
    let nfs: Vec<String> = keep.iter().filter_map(|n| n.nf.clone()).collect();
    let txid = send_tracked(run, backend, tip, "sweep", "sweep to the treasury", &signed, nfs, log)?;
    note!(log, "swept {} contribution(s), {value} zat to the treasury: {txid}", keep.len());
    Ok(())
}

/// Sends a transaction through the outbox (libs backend): recorded first, followed until mined, sent again if a
/// server drops it. The devtool backend cannot send raw bytes, so it keeps the old single send.
#[allow(clippy::too_many_arguments)]
fn send_tracked(run: &Run, backend: &mut dyn WalletBackend, tip: &backend::ChainTip, kind: &str, label: &str, signed: &[u8], nfs: Vec<String>, log: &mut Vec<String>) -> Result<String> {
    if backend.name() == "devtool" {
        return backend.broadcast(signed);
    }
    let (raw, txid) = ticket::raw_from_signed(signed)?;
    let mut ob = outbox::Outbox::load(&run.dir)?;
    let item = outbox::Sent { kind: kind.into(), label: label.into(), txid: txid.clone(), raw_hex: hex::encode(raw), nfs, branch: String::new(), first_height: 0, last_sent_height: 0, sends: 0, status: String::new(), mined_height: None, note: None };
    ob.send(backend, tip.height, &tip.branch_id, item, log)
}

/// One outbox pass: mark what was mined, send again what a server dropped. A transaction that is dead (the network
/// changed version) is rebuilt by running the close steps again.
fn process_outbox(run: &Run, backend: &mut dyn WalletBackend, tip: &backend::ChainTip, notes: &[WalletNote]) -> Vec<String> {
    let mut log = vec![];
    if backend.name() == "devtool" {
        return log;
    }
    let mut ob = match outbox::Outbox::load(&run.dir) {
        Ok(o) => o,
        Err(e) => return vec![format!("could not read the outbox: {e:#}")],
    };
    if let Err(e) = ob.process(backend, tip, notes, &mut log) {
        log.push(format!("outbox pass failed: {e:#}"));
    }
    for l in &log {
        println!("outbox: {l}");
    }
    log
}

/// What is sealed to the contributor: format version 2 (raw transaction + opening values), or version 1 (raw transaction
/// only) when no opening could be read.
#[cfg(not(feature = "test-cheats"))]
fn ticket_plaintext(raw: Vec<u8>, opening: Option<ll_core::ticket_blob::Opening>) -> Vec<u8> {
    match opening {
        Some(o) => ll_core::ticket_blob::encode_v2(&raw, &o),
        None => raw,
    }
}

/// Receiver of the refund output and its address string: the contributor's refund address.
#[cfg(not(feature = "test-cheats"))]
fn ticket_receiver(_backend: &mut dyn WalletBackend, network: &str, receiver: [u8; 43]) -> Result<([u8; 43], String)> {
    Ok((receiver, encode_orchard(network_type(network)?, receiver)?))
}

/// TEST ONLY (`test-cheats` builds): a cheating host. `LL_TEST_JUNK_TICKET` = `badsig` (a broken spend signature; the id in the
/// signed list still matches because signatures are not part of the id), `mismatch` (an opening whose amount is wrong),
/// `oldformat` (a version 1 ticket, as before level 2), or `payshost` (the refund pays the host's own address; see `ticket_receiver`).
#[cfg(feature = "test-cheats")]
fn banner(what: &str) {
    eprintln!("\n################################################################");
    eprintln!("#  FAKE CHEATING HOST (test-cheats build): {what}");
    eprintln!("#  Never use for real.");
    eprintln!("################################################################\n");
}

#[cfg(feature = "test-cheats")]
fn ticket_plaintext(mut raw: Vec<u8>, mut opening: Option<ll_core::ticket_blob::Opening>) -> Vec<u8> {
    match std::env::var("LL_TEST_JUNK_TICKET").as_deref() {
        Ok("badsig") => {
            if let Ok(tx) = zcash_primitives::transaction::Transaction::read(&raw[..], zcash_protocol::consensus::BranchId::Nu7) {
                if let Some(b) = tx.ironwood_bundle() {
                    let sig: [u8; 64] = (&b.actions().first().authorization().clone()).into();
                    if let Some(at) = raw.windows(64).position(|w| w == sig) {
                        raw[at + 10] ^= 0x01;
                        banner("this ticket's spend signature is BROKEN on purpose.");
                    }
                }
            }
        }
        Ok("badproof") => {
            // proofs are not part of the transaction id and the signatures do not cover them: flip a byte inside the proof
            let at = raw.len().saturating_sub(1000);
            raw[at] ^= 0x01;
            banner("this ticket's PROOF is damaged on purpose (its id and signatures still check out).");
        }
        Ok("mismatch") => {
            if let Some(o) = opening.as_mut() {
                o.value_zat += 1;
                banner("this ticket's opening states the WRONG amount on purpose.");
            }
        }
        Ok("oldformat") => {
            banner("this ticket is sealed in the OLD format (no opening values) on purpose.");
            return raw;
        }
        _ => {}
    }
    match opening {
        Some(o) => ll_core::ticket_blob::encode_v2(&raw, &o),
        None => raw,
    }
}

#[cfg(feature = "test-cheats")]
fn ticket_receiver(backend: &mut dyn WalletBackend, network: &str, receiver: [u8; 43]) -> Result<([u8; 43], String)> {
    if std::env::var("LL_TEST_JUNK_TICKET").as_deref() == Ok("payshost") {
        let own = backend.account()?.address;
        banner("this ticket pays the HOST's own address instead of the contributor, on purpose.");
        return Ok((orchard_receiver(&own)?.1, own));
    }
    Ok((receiver, encode_orchard(network_type(network)?, receiver)?))
}

/// Uniform-price auction (SPEC §8): one transaction per winner, spending only that winner's note: the
/// clearing price to the treasury, the excess back to the winner's refund address, the fee out of the note,
/// no change, outgoing viewing key discarded. A signed `settle` entry follows each broadcast.
fn settle_winners(run: &Run, backend: &mut dyn WalletBackend, tip: &backend::ChainTip, a: &ll_core::recount::Analysis, log: &mut Vec<String>) -> Result<()> {
    let plan = a.plan.as_ref().context("not a uniform-price auction")?;
    let r = &run.rules;
    let fee = r.refund_fee_zat;
    // A settlement that was sent (or mined) but whose entry was never written (a crash or a failed write in between) gets its entry now, from
    // what the outbox recorded before sending; it is never skipped and never sent again.
    let values: BTreeMap<String, u64> = a.contributions.iter().filter_map(|n| n.nf.clone().map(|nf| (nf, n.value_zat))).collect();
    for line in settle_entries_from_outbox(run, plan, &values)? {
        note!(log, "{line}");
    }
    let entries = &run.ledger().load()?;
    let outbox_now = outbox::Outbox::load(&run.dir)?;
    let treasury = r.treasury_address.clone().context("rules have no treasury address")?;
    let (net, treasury_raw) = orchard_receiver(&treasury)?;
    let _ = net;
    for nf in &plan.winners {
        if plan.defaulted.contains(nf) {
            note!(log, "winner {nf} defaulted (took its refund before settlement); the item goes unsold");
            continue;
        }
        // Already sent and not dead (a re-run after a partial close or a restart), or a settlement from before the outbox existed.
        if outbox_now.live_for(nf).is_some() || (entries.iter().any(|e| e.settle.as_ref().is_some_and(|s| &s.nf == nf)) && !outbox_now.items.iter().any(|s| s.nfs.contains(nf))) {
            continue;
        }
        let Some(n) = a.contributions.iter().find(|n| n.nf.as_deref() == Some(nf.as_str())) else { continue };
        if n.spent_by.is_some() {
            continue;
        }
        let v = n.value_zat;
        let price = plan.price_zat;
        if v < price + fee {
            bail!("winner {nf}: the bid {v} cannot cover price {price} and fee {fee}");
        }
        let excess = v - price - fee;
        let payload = Payload::open(n.memo_text.as_deref().unwrap_or_default(), &run.secrets.payload_key()?)?;
        // TEST ONLY (a fake cheating host): compiled in only with `--features test-cheats`.
        let (excess_to_raw, winner_addr) = divert_excess(excess, payload.refund_receiver, network_type(&r.network)?)?;
        let owner = format!("ticket:{nf}");
        let also_pay = if excess > 0 { vec![(winner_addr, excess)] } else { vec![] };
        let unsigned = backend.build(&SpendRequest { to_address: treasury.clone(), value_zat: price, lock_owners: vec![owner], no_expiry: true, also_pay })?;
        let signed = backend.sign(&unsigned)?;
        let also = if excess > 0 { vec![(excess_to_raw, excess)] } else { vec![] };
        let checked = ticket::check_and_extract(
            &signed,
            &Expect { spends: BTreeMap::from([(hex32(nf)?, v)]), receiver: &treasury_raw, value_zat: price, no_expiry: true, also },
        )?;
        let txid = send_tracked(run, backend, tip, "settle", &format!("settlement for winner {}", &nf[..8]), &signed, vec![nf.clone()], log)?;
        debug_assert_eq!(txid, checked.txid);
        // TEST ONLY (`test-cheats` builds): stop dead between the broadcast and the entry, as a crash would
        #[cfg(feature = "test-cheats")]
        if std::env::var("LL_TEST_CRASH_AFTER_SETTLE_SEND").is_ok() {
            eprintln!("test: crashing on purpose after sending the settlement {txid} and before writing its entry");
            std::process::exit(3);
        }
        let mut e = Entry::new(&run.rules_id, "settle");
        e.settle = Some(ll_core::ledger::Settle { nf: nf.clone(), txid: txid.clone(), price_zat: price, excess_zat: excess, fee_zat: fee });
        run.append(e)?;
        note!(log, "settled winner {}:{}: price {price} to the treasury, excess {excess} back to the winner: {txid}", n.txid, n.action);
    }
    Ok(())
}

/// Writes the missing `settle` entry of every settlement the outbox recorded as sent or mined (not dead, not superseded) for a winner of this
/// plan. The amounts are the plan's: the price, the fee from the rules, and the excess the note's value leaves. Returns a line per entry written.
fn settle_entries_from_outbox(run: &Run, plan: &ll_core::recount::AuctionPlan, values: &BTreeMap<String, u64>) -> Result<Vec<String>> {
    let ob = outbox::Outbox::load(&run.dir)?;
    let fee = run.rules.refund_fee_zat;
    let mut out = vec![];
    for item in ob.items.iter().filter(|s| s.kind == "settle" && s.live()) {
        let Some(nf) = item.nfs.first() else { continue };
        let entries = run.ledger().load()?;
        if entries.iter().any(|e| e.settle.as_ref().is_some_and(|x| &x.nf == nf)) || !plan.winners.contains(nf) {
            continue;
        }
        let Some(&v) = values.get(nf) else { continue };
        let price = plan.price_zat;
        let excess = v.checked_sub(price + fee).context("a recorded settlement whose note cannot cover the price and the fee")?;
        let mut e = Entry::new(&run.rules_id, "settle");
        e.settle = Some(ll_core::ledger::Settle { nf: nf.clone(), txid: item.txid.clone(), price_zat: price, excess_zat: excess, fee_zat: fee });
        let e = run.append(e)?;
        out.push(format!("settle entry {} written from the outbox record for winner {} (it was sent before, its entry was missing): {}", e.seq, &nf[..8.min(nf.len())], item.txid));
    }
    Ok(out)
}

/// Where the excess goes: the winner's refund address. With the `test-cheats` feature and
/// `LL_TEST_DIVERT_EXCESS_TO` set, somewhere else (a fake cheating host, for tests of the recount), with a loud banner.
#[cfg(feature = "test-cheats")]
fn divert_excess(excess: u64, refund_receiver: [u8; 43], net: zcash_protocol::consensus::NetworkType) -> Result<([u8; 43], String)> {
    if let (Ok(other), true) = (std::env::var("LL_TEST_DIVERT_EXCESS_TO"), excess > 0) {
        eprintln!("\n################################################################");
        eprintln!("#  FAKE CHEATING HOST (test-cheats build): the excess of {excess} zat");
        eprintln!("#  is being sent to {other}, NOT to the winner. Never use for real.");
        eprintln!("################################################################\n");
        return Ok((orchard_receiver(&other)?.1, other));
    }
    Ok((refund_receiver, encode_orchard(net, refund_receiver)?))
}

#[cfg(not(feature = "test-cheats"))]
fn divert_excess(_excess: u64, refund_receiver: [u8; 43], net: zcash_protocol::consensus::NetworkType) -> Result<([u8; 43], String)> {
    if std::env::var("LL_TEST_DIVERT_EXCESS_TO").is_ok() {
        bail!("LL_TEST_DIVERT_EXCESS_TO is set, but this build has no cheating switch (build with --features test-cheats for tests)");
    }
    Ok((refund_receiver, encode_orchard(net, refund_receiver)?))
}

#[cfg(feature = "test-cheats")]
fn force_reject(run: &Run, backend: &mut dyn WalletBackend, contribution: &str) -> Result<()> {
    backend.sync()?;
    let (txid, action) = contribution.split_once(':').context("expected <txid>:<action>")?;
    let action: u32 = action.parse()?;
    let notes = backend.notes()?;
    let n = notes
        .iter()
        .map(|w| &w.note)
        .find(|n| n.txid == txid && n.action == action)
        .context("no such payment in the campaign wallet")?;
    let mut e = Entry::new(&run.rules_id, "reject");
    e.contribution = Some(contribution_of(run, n)?);
    e.reason = Some("test: wrongful reject of a genuine contribution".into());
    let e = run.append(e)?;
    println!("WRONGFUL reject written: entry {} for {txid}:{action}", e.seq);
    sync_relays(run);
    Ok(())
}

fn reissue(run: &Run, backend: &mut dyn WalletBackend) -> Result<()> {
    let count = reissue_inner(run, backend, None)?;
    println!("{count} ticket(s) re-issued");
    sync_relays(run);
    Ok(())
}

/// Re-issues the latest ticket of every unspent, ticketed contribution. With
/// `only_stale = Some(branch)`, tickets already issued under that branch are left alone.
/// The wallet lock is taken again under the same owner, so it carries over unchanged.
fn reissue_inner(run: &Run, backend: &mut dyn WalletBackend, only_stale: Option<&str>) -> Result<usize> {
    backend.sync()?;
    let tip = backend.chain_tip()?;
    let notes = chain_notes(&backend.notes()?);
    let entries = run.ledger().load()?;
    if close_entry(&entries).is_some() {
        bail!("campaign is closed");
    }
    let a = analyze(&run.rules, &run.rules_id, &entries, &notes, &[]);
    let mut count = 0;
    for n in a.contributions.iter().filter(|n| n.spent_by.is_none()) {
        let nf = n.nf.clone().unwrap_or_default();
        if !a.tickets.contains_key(&nf) {
            continue; // not ticketed yet: `watch` will issue it
        }
        let latest_branch = entries
            .iter()
            .filter(|e| e.nf() == Some(nf.as_str()))
            .filter_map(|e| e.ticket.as_ref())
            .next_back()
            .map(|t| t.branch_id.clone());
        if only_stale.is_some() && latest_branch.as_deref() == only_stale {
            continue; // already issued under the current branch
        }
        let payload = Payload::open(n.memo_text.as_deref().unwrap_or_default(), &run.secrets.payload_key()?)?;
        let e = issue_ticket(run, backend, n, &payload, tip.height, "reissue")?;
        let t = e.ticket.as_ref().expect("ticket");
        println!("re-issued: entry {} for {}:{} -> ticket {} (branch {})", e.seq, n.txid, n.action, t.txid, t.branch_id);
        count += 1;
    }
    println!("re-issue pass at height {} (branch {})", tip.height, tip.branch_id);
    Ok(count)
}

/// The campaign's public copy, as one JSON value: exactly what a relay serves (the rules, the signed list), nothing private. The recount page loads this
/// when no relay can give the list, and checks the signatures and the chain of entries the same way it does for a relay's copy.
pub(crate) fn public_copy(run: &Run) -> Result<serde_json::Value> {
    let rules: serde_json::Value = serde_json::from_slice(&fs::read(run.dir.join("rules.json"))?)?;
    let ledger = run.ledger().load()?;
    let final_record: Option<serde_json::Value> = fs::read(run.dir.join("public").join("final.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
    Ok(serde_json::json!({
        "kind": "ledger-export", "version": 1, "campaign": run.rules_id, "rules": rules, "ledger": ledger,
        "challenges": [], "final": final_record,
        "note": "The public copy of this campaign: the signed rules and the signed list. It holds no key and nothing private. Published challenges are kept by the relays, not by the host, so none are in this file.",
    }))
}

fn campaigns_label(runs: &[PathBuf]) -> bool {
    runs.len() > 1
}

fn main() -> Result<()> {
    // TLS to the lightwalletd server (libs backend): pick one crypto provider explicitly.
    let _ = rustls::crypto::ring::default_provider().install_default();
    match Cli::parse().command {
        Cmd::Create { run, wallet, identity, devtool, backend, network, mode, goal_zat, items, deadline_in, relay, min_contribution_zat, reserve_zat, treasury_address, treasury_ufvk, ticket_k, min_confirmations, early_close, cap_zat, name, confirm_mainnet, nu7_mainnet_height } => {
            let uniform = match (reserve_zat, treasury_address, treasury_ufvk) {
                (None, None, None) => None,
                (Some(r), Some(a), Some(k)) => Some(Uniform { reserve_zat: r, treasury_address: a, treasury_ufvk: k }),
                _ => bail!("a uniform-price auction needs --reserve-zat, --treasury-address and --treasury-ufvk together"),
            };
            create(&run, RunConfig { backend, devtool, wallet, identity, min_confirmations }, &network, &mode, goal_zat, items, deadline_in, &relay, min_contribution_zat, uniform, ticket_k, MainnetCheck { confirmed: confirm_mainnet, nu7_height: nu7_mainnet_height }, name, early_close, cap_zat)
        }
        Cmd::Serve { runs_dir, www, listen, network, backend, devtool, relay, page_base, server, nu7_mainnet_height, listing_url } => {
            dashboard::serve(dashboard::Config { runs_dir, www, listen, network, backend, devtool, relays: relay, page_base, server, nu7_mainnet_height, listing_url })
        }
        Cmd::Publish { run, relay } => {
            let r = Run::load(&run)?;
            r.add_relays(&relay)?;
            for url in &relay {
                let n = sync_one_relay(&r, url.trim_end_matches('/'))?;
                println!("relay {url}: published {n} item(s)");
            }
            Ok(())
        }
        Cmd::Watch { run, once, interval, assume_branch_id } => {
            let mut campaigns = vec![];
            let mut _locks = vec![];
            for dir in &run {
                _locks.push(lock::RunLock::acquire(dir, "watch")?);
                campaigns.push((dir.clone(), Run::load(dir)?, backend_for(dir)?));
            }
            loop {
                for (dir, r, backend) in &mut campaigns {
                    if campaigns_label(&run) {
                        println!("-- {}", dir.display());
                    }
                    if let Err(e) = watch_once(r, backend.as_mut(), assume_branch_id.as_deref()) {
                        println!("watch pass failed: {e:#}");
                    }
                }
                if once {
                    return Ok(());
                }
                thread::sleep(Duration::from_secs(interval));
            }
        }
        Cmd::Close { run, sweep_to } => {
            let _lock = lock::RunLock::acquire(&run, "close")?;
            let loaded = Run::load(&run)?;
            let log = close(&loaded, backend_for(&run)?.as_mut(), &sweep_to)?;
            let _ = log;
            // after the close, and separate from it: the final public copy and its fingerprint (moves no money)
            let relays: Vec<(String, std::result::Result<usize, String>)> = loaded.relays().into_iter().map(|u| (u, Ok(0))).collect();
            if let Some(rec) = finalize(&loaded, &relays) {
                println!("final fingerprint: {}", rec.line());
            }
            Ok(())
        }
        Cmd::ForceBig { run, entries, out } => {
            #[cfg(feature = "test-cheats")]
            {
                eprintln!("FAKE CHEATING HOST (test-cheats build): writing {entries} invented entries to {}. Never use for real.", out.display());
                let r = Run::load(&run)?;
                let mut copy = public_copy(&r)?;
                let sk = r.secrets.ledger_key()?;
                let mut list: Vec<Entry> = Vec::with_capacity(entries as usize + 1);
                for i in 0..=entries {
                    let mut e = Entry::new(&r.rules_id, if i == entries { "close" } else { "reject" });
                    e.seq = i;
                    e.prev = list.last().map(|p: &Entry| p.hash()).transpose()?.unwrap_or_else(|| ledger::GENESIS_PREV.to_string());
                    if i == entries {
                        e.close = Some(Close { close_height: r.rules.deadline_height + 1, outcome: "goal_missed".into(), winners: None, ufvk: None, amount_key: None, clearing_price_zat: None });
                    } else {
                        e.reason = Some(format!("invented entry {i}"));
                    }
                    e.sign(&sk)?;
                    list.push(e);
                }
                copy["ledger"] = serde_json::to_value(&list)?;
                copy["final"] = serde_json::Value::Null;
                fs::write(&out, serde_json::to_vec(&copy)?)?;
                Ok(())
            }
            #[cfg(not(feature = "test-cheats"))]
            {
                let _ = (run, entries, out);
                bail!("force-big is a test-only cheat and is not in this build")
            }
        }
        Cmd::ForceFork { run, out } => {
            #[cfg(feature = "test-cheats")]
            {
                eprintln!("FAKE CHEATING HOST (test-cheats build): writing a forked copy of the list to {}. Never use for real.", out.display());
                let r = Run::load(&run)?;
                let mut copy = public_copy(&r)?;
                let mut list = r.ledger().load()?;
                let Some(pos) = list.iter().position(|e| e.kind == "close") else { bail!("the campaign is not closed") };
                let sk = r.secrets.ledger_key()?;
                list.truncate(pos);
                let mut alt = Entry::new(&r.rules_id, "close");
                let old_close = r.ledger().load()?[pos].close.clone().context("close")?;
                alt.close = Some(Close { close_height: old_close.close_height + 7, ..old_close });
                alt.seq = pos as u64;
                alt.prev = list.last().map(|p| p.hash()).transpose()?.unwrap_or_else(|| ledger::GENESIS_PREV.to_string());
                alt.sign(&sk)?;
                list.push(alt);
                copy["ledger"] = serde_json::to_value(&list)?;
                fs::write(&out, serde_json::to_vec(&copy)?)?;
                Ok(())
            }
            #[cfg(not(feature = "test-cheats"))]
            {
                let _ = (run, out);
                bail!("force-fork is a test-only cheat and is not in this build (build with --features test-cheats for tests)")
            }
        }
        Cmd::ForceReject { run, contribution } => {
            #[cfg(feature = "test-cheats")]
            {
                eprintln!("\n################################################################");
                eprintln!("#  FAKE CHEATING HOST (test-cheats build): writing a WRONGFUL reject");
                eprintln!("#  for {contribution}. Never use for real.");
                eprintln!("################################################################\n");
                let _lock = lock::RunLock::acquire(&run, "force-reject")?;
                force_reject(&Run::load(&run)?, backend_for(&run)?.as_mut(), &contribution)
            }
            #[cfg(not(feature = "test-cheats"))]
            {
                let _ = (run, contribution);
                bail!("force-reject is a test-only cheat and is not in this build (build with --features test-cheats for tests)")
            }
        }
        Cmd::Finalize { run } => {
            let run = Run::load(&run)?;
            let relays: Vec<(String, std::result::Result<usize, String>)> = run.relays().into_iter().map(|u| (u, Ok(0))).collect();
            match finalize(&run, &relays) {
                Some(rec) => println!("{}\nfinal copy: {}", rec.line(), run.dir.join("public").join("final-ledger.json").display()),
                None => bail!("the campaign is not closed yet: there is nothing to fix"),
            }
            Ok(())
        }
        Cmd::Late { run } => {
            let r = Run::load(&run)?;
            let cfg = load_config(&run)?;
            let notes = ll_core::walletdb::read_notes(&cfg.wallet.join("data.sqlite"))?;
            let entries = r.ledger().load()?;
            let late = late_payments(&r.rules, &entries, &chain_notes(&notes));
            let end = contribution_end(&r.rules, &entries);
            if late.is_empty() {
                if end < r.rules.deadline_height {
                    println!("no payment reached this campaign after its early close (block {end}), as far as the wallet file has seen");
                } else {
                    println!("no payment reached this campaign after its deadline (block {}), as far as the wallet file has seen", r.rules.deadline_height);
                }
            }
            for n in &late {
                println!("{}:{}  {} zat  mined in block {}  {}", n.txid, n.action, n.value_zat, n.height.unwrap_or(0), if n.spent_by.is_some() { "(already spent)" } else { "(still in the wallet)" });
            }
            if !late.is_empty() {
                let after = if end < r.rules.deadline_height { "the early close" } else { "the deadline" };
                println!("{} payment(s) after {after}: not counted, not ticketed, not refunded. Return them by hand if their senders ask.", late.len());
            }
            Ok(())
        }
        Cmd::HostKey { action: HostKeyAction::Init, runs_dir } => {
            let pk = ll_listing::host::init_key(&runs_dir)?;
            println!("host key made in {} (mode 600)", ll_listing::host::key_path(&runs_dir).display());
            println!("public key:  {pk}");
            println!("fingerprint: {}", ll_listing::record::fingerprint(&pk));
            Ok(())
        }
        Cmd::HostKey { action: HostKeyAction::Show, runs_dir } => {
            let (pk, fp) = ll_listing::host::describe_key(&runs_dir)?;
            println!("public key:  {pk}");
            println!("fingerprint: {fp}");
            Ok(())
        }
        Cmd::ListingRecord { run, runs_dir, relays, out, post } => {
            if out.exists() {
                bail!("{} already exists; choose another file name", out.display());
            }
            let rec = ll_listing::host::record_for(&runs_dir, &run, relays, ll_listing::host::now_secs())?;
            fs::write(&out, serde_json::to_vec_pretty(&rec)?)?;
            println!("listing record for campaign {}… written to {} (host {})", &rec.campaign[..8], out.display(), rec.host_fingerprint());
            if let Some(url) = post {
                println!("{}", ll_listing::host::post(&url, &rec)?);
            }
            Ok(())
        }
        Cmd::Export { run, out } => {
            let copy = public_copy(&Run::load(&run)?)?;
            if out.exists() {
                bail!("{} already exists; choose another file name", out.display());
            }
            fs::write(&out, serde_json::to_vec_pretty(&copy)?)?;
            println!("wrote {} ({} entries). It is the public copy: it holds no key and nothing private.", out.display(), copy["ledger"].as_array().map_or(0, |a| a.len()));
            Ok(())
        }
        Cmd::Reissue { run } => {
            let _lock = lock::RunLock::acquire(&run, "reissue")?;
            reissue(&Run::load(&run)?, backend_for(&run)?.as_mut())
        }
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;

    /// A scratch folder that is removed afterwards.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let d = std::env::temp_dir().join(format!("ll-paths-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(&d).unwrap();
            Scratch(d)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn folder_with_wallet(root: &Path, name: &str) -> PathBuf {
        let d = root.join(name);
        fs::create_dir_all(d.join("wallet1")).unwrap();
        fs::write(d.join("wallet1.age"), b"key").unwrap();
        d
    }

    #[test]
    fn a_name_inside_the_folder_is_accepted() {
        let s = Scratch::new("name");
        let d = folder_with_wallet(&s.0, "c");
        let p = resolve_in_folder(&d, Path::new("wallet1"), "wallet").unwrap();
        assert_eq!(p.canonicalize().unwrap(), d.join("wallet1").canonicalize().unwrap());
    }

    #[test]
    fn an_older_path_written_from_the_start_folder_is_accepted_when_it_leads_inside() {
        let s = Scratch::new("legacy");
        let d = folder_with_wallet(&s.0, "c");
        // older versions wrote the path as the program saw it, from wherever it was started: here an absolute one
        let p = resolve_in_folder(&d, &d.join("wallet1"), "wallet").unwrap();
        assert!(p.ends_with("wallet1"));
    }

    #[test]
    fn a_path_to_another_folder_is_refused_with_a_clear_message() {
        let s = Scratch::new("outside");
        let old = folder_with_wallet(&s.0, "old");
        let copy = folder_with_wallet(&s.0, "copy");
        let e = resolve_in_folder(&copy, &old.join("wallet1"), "wallet").unwrap_err().to_string();
        assert!(e.contains("outside this campaign folder") && e.contains("Refusing to start") && e.contains("wallet1"), "{e}");
        // a path that climbs out with .. is the same thing
        let e = resolve_in_folder(&copy, Path::new("../old/wallet1"), "wallet").unwrap_err().to_string();
        assert!(e.contains("outside this campaign folder"), "{e}");
    }

    #[test]
    fn a_path_that_does_not_exist_is_said_plainly() {
        let s = Scratch::new("missing");
        let d = folder_with_wallet(&s.0, "c");
        let e = resolve_in_folder(&d, Path::new("gone/wallet9"), "wallet").unwrap_err().to_string();
        assert!(e.contains("does not exist") && e.contains("restored from a backup"), "{e}");
    }

    #[test]
    fn a_link_inside_the_folder_that_leads_outside_is_refused() {
        let s = Scratch::new("link");
        let old = folder_with_wallet(&s.0, "old");
        let copy = folder_with_wallet(&s.0, "copy");
        std::os::unix::fs::symlink(old.join("wallet1"), copy.join("sneaky")).unwrap();
        assert!(resolve_in_folder(&copy, Path::new("sneaky"), "wallet").is_err());
    }

    #[test]
    fn load_config_checks_both_paths() {
        let s = Scratch::new("cfg");
        let old = folder_with_wallet(&s.0, "old");
        let copy = folder_with_wallet(&s.0, "copy");
        let write = |wallet: &Path, identity: &Path| {
            fs::write(copy.join("config.json"), serde_json::to_vec(&serde_json::json!({ "backend": "libs", "devtool": "x", "wallet": wallet, "identity": identity })).unwrap()).unwrap();
        };
        write(Path::new("wallet1"), Path::new("wallet1.age"));
        load_config(&copy).unwrap();
        write(&old.join("wallet1"), Path::new("wallet1.age")); // a restored copy that still names the old wallet
        assert!(load_config(&copy).unwrap_err().to_string().contains("outside this campaign folder"));
        write(Path::new("wallet1"), &old.join("wallet1.age")); // or the old key file
        assert!(load_config(&copy).unwrap_err().to_string().contains("outside this campaign folder"));
    }
}

#[cfg(test)]
mod settle_resume_tests {
    use super::*;

    fn uniform_run(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ll-settle-resume-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let secrets = CampaignSecrets { ledger_sk: hex::encode([3u8; 32]), payload_sk: hex::encode([4u8; 32]), amount_key: Some(hex::encode([5u8; 32])) };
        let rules = Rules {
            v: 1, network: "test".into(), mode: "auction".into(), goal_zat: None, items: Some(1),
            start_height: 100, deadline_height: 200, ticket_k: 10, close_grace: 10, reissue_window: 20,
            refund_fee_zat: 10_000, min_contribution_zat: 20_000, campaign_ufvk: None, ufvk_hash: Some("00".repeat(32)),
            pay_to: None, early_close: None, cap_zat: None, pricing: Some("uniform".into()), settle_window: Some(40), reserve_zat: Some(50_000), treasury_address: None, treasury_ufvk: None,
            name: None,
            ledger_pubkey: secrets.ledger_pubkey_hex().unwrap(), payload_pubkey: secrets.payload_pubkey_hex().unwrap(),
        };
        fs::write(d.join("rules.json"), serde_json::to_vec(&rules).unwrap()).unwrap();
        fs::write(d.join("rules_id"), hex::encode(rules.id().unwrap())).unwrap();
        fs::write(d.join("secrets.json"), serde_json::to_vec(&secrets).unwrap()).unwrap();
        d
    }

    /// The state a crash between the broadcast of a settlement and the write of its entry leaves: the outbox records the settlement (it is
    /// recorded before it is sent), the ledger has no `settle` entry for it.
    fn crash_after_send(run: &Run, nf: &str, status: &str) {
        let mut close = Entry::new(&run.rules_id, "close");
        close.close = Some(Close { close_height: 205, outcome: "auction".into(), winners: Some(vec![nf.into()]), ufvk: None, amount_key: None, clearing_price_zat: Some(60_000) });
        run.append(close).unwrap();
        let item = outbox::Sent {
            kind: "settle".into(), label: "settlement".into(), txid: "cd".repeat(32), raw_hex: String::new(), nfs: vec![nf.into()], branch: "77190ad9".into(),
            first_height: 206, last_sent_height: 206, sends: 1, status: status.into(), mined_height: None, note: None,
        };
        fs::create_dir_all(run.dir.join("private")).unwrap();
        fs::write(run.dir.join("private/outbox.json"), serde_json::to_vec(&vec![item]).unwrap()).unwrap();
    }

    #[test]
    fn a_settlement_sent_before_a_crash_gets_its_entry_on_the_rerun_exactly_once() {
        let d = uniform_run("sent");
        let run = Run::load(&d).unwrap();
        let nf = "ef".repeat(32);
        crash_after_send(&run, &nf, "sent");
        let plan = ll_core::recount::AuctionPlan { winners: vec![nf.clone()], price_zat: 60_000, reserve_zat: 50_000, defaulted: vec![] };
        let values = BTreeMap::from([(nf.clone(), 100_000u64)]);

        let written = settle_entries_from_outbox(&run, &plan, &values).unwrap();
        assert_eq!(written.len(), 1, "{written:?}");
        let entries = run.ledger().load().unwrap();
        let s = entries.last().unwrap().settle.clone().expect("a settle entry");
        assert_eq!((s.nf.as_str(), s.txid.as_str(), s.price_zat, s.excess_zat, s.fee_zat), (nf.as_str(), "cd".repeat(32).as_str(), 60_000, 30_000, 10_000));
        let pk = ll_core::ledger::verifying_key(&run.rules.ledger_pubkey).unwrap();
        assert!(ll_core::ledger::check_chain(&entries, &pk, &run.rules_id).is_empty(), "the list stays one signed chain");

        // a second rerun writes nothing more
        assert!(settle_entries_from_outbox(&run, &plan, &values).unwrap().is_empty());
        assert_eq!(run.ledger().load().unwrap().len(), entries.len());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_dead_or_superseded_settlement_gets_no_entry() {
        for status in ["dead", "superseded"] {
            let d = uniform_run(status);
            let run = Run::load(&d).unwrap();
            let nf = "ef".repeat(32);
            crash_after_send(&run, &nf, status);
            let plan = ll_core::recount::AuctionPlan { winners: vec![nf.clone()], price_zat: 60_000, reserve_zat: 50_000, defaulted: vec![] };
            let values = BTreeMap::from([(nf.clone(), 100_000u64)]);
            assert!(settle_entries_from_outbox(&run, &plan, &values).unwrap().is_empty(), "{status}: rebuilt or not ours, so no entry from this record");
            let _ = fs::remove_dir_all(&d);
        }
    }
}

#[cfg(test)]
mod close_resume_tests {
    use super::*;
    use crate::backend::AccountInfo;
    use ll_core::walletdb::WalletNote;

    /// A wallet tool stand-in: the chain is past the deadline, two contributions sit in the wallet, and the first `fail` broadcasts fail.
    struct Wallet { notes: Vec<WalletNote>, fail: u32, sent: Vec<Vec<u8>>, unlocked: Vec<String> }
    impl WalletBackend for Wallet {
        fn name(&self) -> &'static str { "devtool" } // sends the stored ticket bytes as they are
        fn sync(&mut self) -> Result<()> { Ok(()) }
        fn chain_tip(&mut self) -> Result<backend::ChainTip> { Ok(backend::ChainTip { height: 260, branch_id: "77190ad9".into() }) }
        fn account(&mut self) -> Result<AccountInfo> { unimplemented!() }
        fn notes(&mut self) -> Result<Vec<WalletNote>> { Ok(self.notes.clone()) }
        fn lock(&mut self, _: &str, _: u32, _: &str, _: u32) -> Result<()> { Ok(()) }
        fn unlock(&mut self, txid: &str, _: u32, _: &str) -> Result<bool> { self.unlocked.push(txid.into()); Ok(true) }
        fn build(&mut self, _: &SpendRequest) -> Result<Vec<u8>> { bail!("not used: a fundraiser that missed its goal sweeps nothing") }
        fn sign(&mut self, p: &[u8]) -> Result<Vec<u8>> { Ok(p.to_vec()) }
        fn broadcast(&mut self, signed: &[u8]) -> Result<String> {
            if self.fail > 0 {
                self.fail -= 1;
                bail!("the server stalled");
            }
            self.sent.push(signed.to_vec());
            Ok(format!("txid-{}", self.sent.len()))
        }
        fn broadcast_raw(&mut self, _: &[u8]) -> Result<String> { unimplemented!() }
        fn tx_known(&mut self, _: &str) -> Result<bool> { Ok(false) }
    }

    fn raise_missed(tag: &str) -> (PathBuf, Vec<WalletNote>) {
        let d = std::env::temp_dir().join(format!("ll-close-resume-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let secrets = CampaignSecrets { ledger_sk: hex::encode([1u8; 32]), payload_sk: hex::encode([2u8; 32]), amount_key: None };
        let rules = Rules {
            v: 1, network: "test".into(), mode: "raise".into(), goal_zat: Some(10_000_000), items: None,
            start_height: 100, deadline_height: 200, ticket_k: 10, close_grace: 10, reissue_window: 20,
            refund_fee_zat: 10_000, min_contribution_zat: 20_000, campaign_ufvk: Some("uvftest1x".into()), ufvk_hash: None,
            pay_to: None, early_close: None, cap_zat: None, pricing: None, settle_window: None, reserve_zat: None, treasury_address: None, treasury_ufvk: None, name: None,
            ledger_pubkey: secrets.ledger_pubkey_hex().unwrap(), payload_pubkey: secrets.payload_pubkey_hex().unwrap(),
        };
        let rules_id = hex::encode(rules.id().unwrap());
        fs::write(d.join("rules.json"), serde_json::to_vec(&rules).unwrap()).unwrap();
        fs::write(d.join("rules_id"), &rules_id).unwrap();
        fs::write(d.join("secrets.json"), serde_json::to_vec(&secrets).unwrap()).unwrap();
        let run = Run::load(&d).unwrap();
        let payload_pk = secrets.payload_pubkey_hex().unwrap();
        let mut notes = vec![];
        for i in 0..2u8 {
            let p = Payload { rules_id: hex32(&rules_id).unwrap(), sign_pubkey: [i; 32], enc_pubkey: [i; 32], refund_typecode: 3, refund_receiver: [9; 43], amount_zat: Some(50_000) };
            let memo = p.to_memo(&hex32(&payload_pk).unwrap(), &crypto_box::SecretKey::from([20 + i; 32])).unwrap();
            let nf = format!("{:02x}", 0xa0 + i).repeat(32);
            let n = ChainNote { txid: format!("{:02x}", 0x10 + i).repeat(32), action: 0, value_zat: 50_000, nf: Some(nf.clone()), height: Some(150 + i as u32), tx_index: None, memo_text: Some(memo), is_change: false, spent_by: None };
            let mut e = Entry::new(&rules_id, "issue");
            e.contribution = Some(Contribution { txid: n.txid.clone(), action: 0, nf: nf.clone(), height: 150 + i as u32, value_zat: Some(50_000), amount_commit: None });
            e.ticket = Some(Ticket { txid: format!("{:02x}", 0x30 + i).repeat(32), issue_height: 151 + i as u32, branch_id: "77190ad9".into() });
            e.blob_hash = Some("00".repeat(32));
            run.append(e).unwrap();
            write_private(&run.signed_ticket_path(&nf), format!("signed refund {i}").as_bytes()).unwrap();
            notes.push(WalletNote { note: n, memo_raw: None, lock_owner: Some(format!("ticket:{nf}")), lock_expiry: None });
        }
        (d, notes)
    }

    #[test]
    fn a_failed_refund_after_the_close_entry_is_recorded_and_try_again_sends_only_what_is_left() {
        let (d, notes) = raise_missed("refund");
        let run = Run::load(&d).unwrap();
        let mut w = Wallet { notes, fail: 1, sent: vec![], unlocked: vec![] };

        let e = close(&run, &mut w, "utest1x").err().expect("one refund failed, so the close is not finished");
        assert!(e.to_string().contains("The campaign is closed, but the refund of") && e.to_string().contains("without sending anything twice"), "{e}");
        assert!(close_entry(&run.ledger().load().unwrap()).is_some(), "the close entry was written");
        let left = close_unfinished(&run);
        assert_eq!(left.len(), 1, "{left:?}");
        assert_eq!(w.sent.len(), 1, "the other refund went out");

        // "Try again": only the refund that failed is sent; the one already sent is not sent again
        let log = close(&run, &mut w, "utest1x").expect("finished");
        assert_eq!(w.sent.len(), 2, "{log:?}");
        assert_ne!(w.sent[0], w.sent[1], "two different refunds, none twice");
        assert!(close_unfinished(&run).is_empty());
        assert_eq!(run.ledger().load().unwrap().iter().filter(|e| e.kind == "close").count(), 1, "one close entry");

        // a third run has nothing left to send
        close(&run, &mut w, "utest1x").unwrap();
        assert_eq!(w.sent.len(), 2);
        let _ = fs::remove_dir_all(&d);
    }

    /// A new payment (valid message) at `height`, for the confirmation tests.
    /// A valid Orchard/Ironwood refund receiver.
    fn valid_receiver() -> [u8; 43] {
        let sk: orchard::keys::SpendingKey = Option::from(orchard::keys::SpendingKey::from_bytes([7; 32])).unwrap();
        orchard::keys::FullViewingKey::from(&sk).address_at(0u32, orchard::keys::Scope::External).to_raw_address_bytes()
    }

    fn new_payment(run: &Run, height: u32) -> WalletNote {
        new_payment_to(run, height, 3, valid_receiver())
    }

    /// A new payment whose sealed message names the refund receiver given (hand made when it is not a valid Orchard one).
    fn new_payment_to(run: &Run, height: u32, typecode: u8, receiver: [u8; 43]) -> WalletNote {
        let p = Payload { rules_id: hex32(&run.rules_id).unwrap(), sign_pubkey: [7; 32], enc_pubkey: [7; 32], refund_typecode: typecode, refund_receiver: receiver, amount_zat: Some(50_000) };
        let memo = p.to_memo(&hex32(&run.rules.payload_pubkey).unwrap(), &crypto_box::SecretKey::from([77; 32])).unwrap();
        let n = ChainNote { txid: "77".repeat(32), action: 0, value_zat: 50_000, nf: Some("e7".repeat(32)), height: Some(height), tx_index: None, memo_text: Some(memo), is_change: false, spent_by: None };
        WalletNote { note: n, memo_raw: None, lock_owner: None, lock_expiry: None }
    }

    #[test]
    fn a_payment_waits_for_the_campaigns_confirmations_before_it_is_ticketed() {
        let (d, mut notes) = raise_missed("confirmations");
        let mut rules = Run::load(&d).unwrap().rules;
        rules.deadline_height = 300; // still open at tip 260
        let entries = Run::load(&d).unwrap().ledger().load().unwrap();
        let tip = backend::ChainTip { height: 260, branch_id: "77190ad9".into() };
        let reason = |run: &Run, notes: &[WalletNote]| {
            let mut w = Wallet { notes: notes.to_vec(), fail: 0, sent: vec![], unlocked: vec![] };
            let (_, skipped) = issue_pending(run, &mut w, notes, &entries, &tip).unwrap();
            skipped.iter().find(|(k, _)| k.starts_with(&"77".repeat(32))).map(|(_, r)| r.clone()).unwrap_or_default()
        };
        // no setting (every campaign made before it): a payment mined in the tip block is ticketed at once (here the stand-in wallet
        // refuses to build, which shows the host went on to build the ticket)
        let run = Run { rules: rules.clone(), ..Run::load(&d).unwrap() };
        assert_eq!(run.min_confirmations, 1);
        notes.push(new_payment(&run, 260));
        assert!(reason(&run, &notes).contains("not used"), "{}", reason(&run, &notes));
        // with 3: two confirmations wait, three go ahead
        fs::write(d.join("config.json"), r#"{"backend":"libs","devtool":"x","wallet":"w","identity":"w.age","min_confirmations":3}"#).unwrap();
        let run = Run { rules, ..Run::load(&d).unwrap() };
        assert_eq!(run.min_confirmations, 3);
        notes.pop();
        notes.push(new_payment(&run, 259));
        assert_eq!(reason(&run, &notes), "waiting for 3 confirmations (it has 2)");
        notes.pop();
        notes.push(new_payment(&run, 258));
        assert!(reason(&run, &notes).contains("not used"), "{}", reason(&run, &notes));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_payment_whose_refund_cannot_be_paid_is_rejected_at_once_and_never_stops_the_close() {
        // docs/THREAT_MODEL.md threat 25: a hand made payment message whose refund receiver cannot be paid. Before the fix, invalid
        // receiver bytes were locked, failed to build on every pass, never got an entry, and the close refused.
        for (tag, typecode, receiver, code) in [("bytes", 3u8, [0xff; 43], "[receiver_bytes]"), ("type", 2u8, valid_receiver(), "[receiver_type]")] {
            let (d, mut notes) = raise_missed(&format!("poison-{tag}"));
            let run = Run::load(&d).unwrap();
            notes.push(new_payment_to(&run, 160, typecode, receiver));
            let mut w = Wallet { notes, fail: 0, sent: vec![], unlocked: vec![] };
            let log = close(&run, &mut w, "utest1x").expect("the close goes ahead");
            let entries = run.ledger().load().unwrap();
            let reject = entries.iter().find(|e| e.kind == "reject").expect("a signed reject entry");
            assert!(reject.reason.as_deref().unwrap_or_default().ends_with(code), "{:?}", reject.reason);
            assert!(reject.ticket.is_none());
            assert_eq!(w.unlocked, vec!["77".repeat(32)], "any lock an older host left on it is released");
            assert_eq!(w.sent.len(), 2, "the two real contributions are refunded: {log:?}");
            assert!(close_entry(&entries).is_some());
            let _ = fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn a_failure_on_the_hosts_side_is_not_a_reject_and_still_stops_the_close() {
        // a valid payment whose ticket cannot be built because of the host's own wallet (here the stand-in refuses every build)
        let (d, mut notes) = raise_missed("hostside");
        let run = Run::load(&d).unwrap();
        notes.push(new_payment(&run, 160));
        let mut w = Wallet { notes, fail: 0, sent: vec![], unlocked: vec![] };
        let e = close(&run, &mut w, "utest1x").err().expect("the close refuses");
        assert!(e.to_string().contains("The campaign was NOT closed"), "{e}");
        assert!(run.ledger().load().unwrap().iter().all(|e| e.kind != "reject" && e.kind != "close"), "no reject and no close written");
        assert!(w.sent.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    /// The `raise_missed` campaign (two contributions of 50,000 at 150 and 151; the stand-in chain is at 260) with a later deadline, so
    /// the chain is BEFORE it, and the given goal and early close setting.
    fn before_deadline(d: &Path, goal: u64, early: bool) -> Run {
        let mut rules = Run::load(d).unwrap().rules;
        rules.deadline_height = 300;
        rules.goal_zat = Some(goal);
        rules.early_close = early.then_some(true);
        Run { rules, ..Run::load(d).unwrap() }
    }

    #[test]
    fn a_capped_close_keeps_what_fits_and_refunds_the_payment_over_the_cap_by_its_ticket() {
        // two contributions of 50,000 (at 150 and 151); goal 50,000 and a hard cap of 60,000: the first is kept, the second does not fit
        let (d, notes) = raise_missed("cap");
        let mut rules = Run::load(&d).unwrap().rules;
        rules.goal_zat = Some(50_000);
        rules.cap_zat = Some(60_000);
        let run = Run { rules, ..Run::load(&d).unwrap() };
        let mut w = Wallet { notes: notes.clone(), fail: 0, sent: vec![], unlocked: vec![] };
        let _ = close(&run, &mut w, "utest1x"); // the stand-in wallet cannot build the sweep, so the close reports that step as unfinished
        let c = close_entry(&run.ledger().load().unwrap()).cloned().expect("closed");
        assert_eq!(c.outcome, "goal_met");
        assert_eq!(w.sent, vec![b"signed refund 1".to_vec()], "exactly one refund, the stored ticket of the payment over the cap");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_early_close_needs_the_rules_to_allow_it_and_the_goal_to_be_met() {
        // no early close in the rules: refused before anything is written, with the deadline in the reason
        let (d, notes) = raise_missed("early-nofield");
        let run = before_deadline(&d, 100_000, false);
        let mut w = Wallet { notes: notes.clone(), fail: 0, sent: vec![], unlocked: vec![] };
        let e = close(&run, &mut w, "utest1x").err().unwrap().to_string();
        assert!(e.contains("not reached") && e.contains("do not allow closing early"), "{e}");
        assert!(close_entry(&run.ledger().load().unwrap()).is_none());
        // allowed, but the goal (150,000) is not met by the 100,000 contributed: refused, nothing written
        let run = before_deadline(&d, 150_000, true);
        let e = close(&run, &mut w, "utest1x").err().unwrap().to_string();
        assert!(e.contains("NOT closed") && e.contains("goal is not met yet (100000 of 150000 zat"), "{e}");
        assert!(close_entry(&run.ledger().load().unwrap()).is_none());
        // allowed and met (goal 100,000): the close entry is written at the chain height, before the deadline, as "goal met"
        let run = before_deadline(&d, 100_000, true);
        let _ = close(&run, &mut w, "utest1x"); // the stand-in wallet cannot build the sweep, so the close reports that step as unfinished
        let c = close_entry(&run.ledger().load().unwrap()).cloned().expect("closed early");
        assert_eq!((c.close_height, c.outcome.as_str()), (260, "goal_met"));
        assert!(w.sent.is_empty(), "nothing is refunded: the contributions are kept");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_payment_skipped_ten_checks_in_a_row_is_reported_and_waiting_ones_are_not() {
        let (d, _) = raise_missed("skips");
        let run = Run::load(&d).unwrap();
        let pass = |s: &[(&str, &str)]| record_skips(&run, &s.iter().map(|(k, r)| (k.to_string(), r.to_string())).collect::<Vec<_>>());
        let both = [("aa:0", "proposal failed: something on the host's side"), ("bb:1", "waiting for 3 confirmations (it has 1)")];
        for _ in 0..9 {
            pass(&both);
        }
        assert!(long_skips(&run).is_empty(), "nine passes are not yet enough");
        pass(&both);
        assert_eq!(long_skips(&run), vec![("aa:0".to_string(), 10, "proposal failed: something on the host's side".to_string())], "waiting for confirmations is never counted");
        pass(&[]);
        assert!(long_skips(&run).is_empty(), "a payment that is no longer skipped starts again from zero");
        let text = crate::dashboard::skip_warning("aa:0", Some(1_500_000), 10, "proposal failed: X", &run.rules);
        assert!(text.contains(&format!("aa:0, {}", run.rules.amount(1_500_000))) && text.contains(if run.rules.network == "main" { "0.015 ZEC" } else { "0.015 TAZ" }) && text.contains("10 checks in a row") && text.contains("proposal failed: X") && text.contains("Do not move this payment"), "{text}");
        assert!(!text.split_whitespace().any(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).contains('-')) && !text.contains('—'), "no hyphens or dashes: {text}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_auction_can_never_close_early() {
        let mut rules: Rules = serde_json::from_value(serde_json::json!({
            "v": 1, "network": "test", "mode": "auction", "items": 1, "ufvk_hash": "00", "start_height": 100, "deadline_height": 300, "ticket_k": 10,
            "close_grace": 10, "reissue_window": 20, "refund_fee_zat": 10000, "min_contribution_zat": 20000, "ledger_pubkey": "00", "payload_pubkey": "00"
        })).unwrap();
        rules.early_close = Some(true); // even if the field were there (validate refuses it), an auction is never allowed
        let e = may_close(&rules, &Analysis::default(), 260).unwrap_err();
        assert!(e.contains("an auction cannot be closed early"), "{e}");
        assert!(may_close(&rules, &Analysis::default(), 301).is_ok(), "after the deadline as always");
    }

    #[test]
    fn a_close_that_stops_before_its_entry_writes_nothing_and_records_nothing() {
        let (d, notes) = raise_missed("before");
        let run = Run::load(&d).unwrap();
        let mut w = Wallet { notes, fail: 0, sent: vec![], unlocked: vec![] };
        // the chain is not past the deadline yet
        let mut rules = run.rules.clone();
        rules.deadline_height = 300; // tip 260 is before it
        let early = Run { rules, ..Run::load(&d).unwrap() };
        assert!(close(&early, &mut w, "utest1x").is_err());
        assert!(close_entry(&run.ledger().load().unwrap()).is_none() && close_unfinished(&run).is_empty() && w.sent.is_empty());
        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod late_tests {
    use super::*;

    #[test]
    fn only_payments_mined_after_the_deadline_are_listed_and_change_is_not() {
        let mut rules: Rules = serde_json::from_value(serde_json::json!({
            "v": 1, "network": "test", "mode": "raise", "goal_zat": 1, "start_height": 100, "deadline_height": 200, "ticket_k": 10, "close_grace": 10,
            "reissue_window": 20, "refund_fee_zat": 10000, "min_contribution_zat": 20000, "ledger_pubkey": "00", "payload_pubkey": "00"
        })).unwrap();
        rules.deadline_height = 200;
        let n = |h: Option<u32>, change: bool| ChainNote { txid: "t".into(), action: 0, value_zat: 30_000, nf: None, height: h, tx_index: None, memo_text: None, is_change: change, spent_by: None };
        let notes = vec![n(Some(199), false), n(Some(200), false), n(Some(201), false), n(Some(250), true), n(None, false)];
        let late = late_payments(&rules, &[], &notes);
        assert_eq!(late.iter().map(|x| x.height).collect::<Vec<_>>(), vec![Some(201)]);
    }
}

#[cfg(all(test, unix))]
mod permission_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn private_files_and_folders_are_closed_from_the_start() {
        let d = std::env::temp_dir().join(format!("ll-perm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        // a file written privately in folders that do not exist yet: every new folder is 700, the file 600
        let f = d.join("campaign").join("private").join("tickets").join("x.pczt");
        write_private(&f, b"signed").unwrap();
        assert_eq!(mode(&f), 0o600);
        for p in [d.join("campaign"), d.join("campaign/private"), d.join("campaign/private/tickets")] {
            assert_eq!(mode(&p), 0o700, "{}", p.display());
        }
        // a file left by an older version, readable by others, is closed before it is written again
        let old = d.join("campaign/secrets.json");
        fs::write(&old, b"{}").unwrap();
        fs::set_permissions(&old, fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&old, b"{}").unwrap();
        assert_eq!(mode(&old), 0o600);
        // the lock file
        let l = lock::RunLock::acquire(&d.join("campaign"), "test").unwrap();
        assert_eq!(mode(&d.join("campaign/private/host.lock")), 0o600);
        drop(l);
        let _ = fs::remove_dir_all(&d);
    }
}
