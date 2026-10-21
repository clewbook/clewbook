//! Sealed bid auctions on the host (SPEC §9): create one; take deposits and give each its early ticket (valid until the deadline) and a
//! refund signed at once; send the coins from the host's own coin wallet when the host chose to (at once, every N bids, every N minutes,
//! and at once near the coin cutoff); build each late ticket once its coin is sent. Every other campaign type is untouched by this file.

use std::collections::BTreeSet;

use super::*;

/// Prints a line and keeps it (as `note!` in main.rs, which is defined after this module).
macro_rules! note {
    ($log:expr, $($arg:tt)*) => {{
        let m = format!($($arg)*);
        println!("{m}");
        $log.push(m);
    }};
}
use ll_core::{
    bid::{self, BidMemo},
    payout,
    sealed::{self, COIN_CUTOFF_BLOCKS, COIN_RUSH_BLOCKS, COIN_ZAT, CoinSending, QUICKNET_CHAIN_HASH, Sealed, Timing},
};

/// The host's choices for a new sealed bid auction.
pub struct SealedArgs {
    pub items: u32,
    pub tranches_zat: Vec<u64>,
    pub pricing: String,
    pub reserve_zat: Option<u64>,
    pub treasury_address: String,
    pub treasury_ufvk: String,
    pub coin_sending: CoinSending,
    /// Standard, or the quick test timing (test network only).
    pub timing: Timing,
    pub coin_wallet: PathBuf,
    pub coin_identity: PathBuf,
    /// TEST ONLY (regtest builds, regtest network): a drand round and a late ticket wait chosen by the test, because regtest block times
    /// are not real times.
    pub test_round: Option<u64>,
    pub test_claim_after_in: Option<u32>,
}

/// "at-once", "every-bids:N" or "every-minutes:N" (there is no default: the host must choose, owner decision 4).
pub fn parse_coin_sending(s: &str) -> Result<CoinSending> {
    Ok(match s.split_once(':') {
        None if s == "at-once" => CoinSending::AtOnce,
        Some(("every-bids", n)) => CoinSending::EveryBids { n: n.parse().context("every-bids:N needs a number")? },
        Some(("every-minutes", n)) => CoinSending::EveryMinutes { n: n.parse().context("every-minutes:N needs a number")? },
        _ => bail!("--coin-sending must be at-once, every-bids:N or every-minutes:N"),
    })
}

/// Where a sealed auction keeps the host's coin wallet (names inside the campaign folder).
#[derive(Serialize, Deserialize)]
struct CoinWallet {
    wallet: PathBuf,
    identity: PathBuf,
}

fn coin_wallet_path(dir: &Path) -> PathBuf {
    dir.join("private").join("coin_wallet.json")
}

/// The coin wallet's folder, if this is a sealed bid auction with one.
pub fn coin_wallet_dir(run: &Run) -> Option<PathBuf> {
    let cw: CoinWallet = serde_json::from_slice(&fs::read(coin_wallet_path(&run.dir)).ok()?).ok()?;
    resolve_in_folder(&run.dir, &cw.wallet, "coin wallet").ok()
}

/// The wallet that pays the coins: the host's own funds, never the campaign's (owner decision 7).
pub fn coin_backend(run: &Run) -> Result<Box<dyn WalletBackend + Send>> {
    let cw: CoinWallet = serde_json::from_slice(&fs::read(coin_wallet_path(&run.dir))?)?;
    let wallet = resolve_in_folder(&run.dir, &cw.wallet, "coin wallet")?;
    let identity = resolve_in_folder(&run.dir, &cw.identity, "coin wallet key file")?;
    Ok(Box::new(libs::LibsBackend::new(wallet, identity)?))
}

#[allow(clippy::too_many_arguments)]
pub fn create_sealed(run: &Path, cfg: RunConfig, network: &str, deadline_in: u32, relays: &[String], ticket_k: u32, name: Option<String>, a: SealedArgs) -> Result<()> {
    // owner decision 10: testnet first; the main network comes after its NU7 update, with a build that allows it
    ensure!(network != "main", "blind bid auctions run on the test network only for now");
    ensure!(cfg.backend == "libs", "a blind bid auction needs the wallet library backend");
    ensure!(a.timing.is_standard() || network != "main", "the quick test timing is for the test network only");
    sealed::check_bid_window(deadline_in, ticket_k)?;
    if let Some(n) = &name {
        ll_core::rules::check_name(n)?;
    }
    if run.join("rules.json").exists() {
        bail!("{} already holds a campaign", run.display());
    }
    make_private_dir(run)?;
    let canon = run.canonicalize()?;
    let inside = |p: &Path, what: &str| -> Result<PathBuf> {
        let real = p.canonicalize().map_err(|_| anyhow!("the {what} {} does not exist", p.display()))?;
        real.strip_prefix(&canon).map(PathBuf::from).map_err(|_| anyhow!("the {what} {} must be inside the campaign folder {}", p.display(), run.display()))
    };
    let coin = CoinWallet { wallet: inside(&a.coin_wallet, "coin wallet")?, identity: inside(&a.coin_identity, "coin wallet key file")? };
    ensure!(coin.wallet != inside(&cfg.wallet, "wallet")?, "the coin wallet must be another wallet than the campaign's: coins are paid from the host's own funds");
    let cfg = RunConfig { wallet: inside(&cfg.wallet, "wallet")?, identity: inside(&cfg.identity, "wallet key file")?, ..cfg };
    fs::write(run.join("config.json"), serde_json::to_vec_pretty(&cfg)?)?;
    write_private(&coin_wallet_path(run), &serde_json::to_vec_pretty(&coin)?)?;
    // the coin wallet's address, for the host to fund it from its own money (shown on the dashboard; not secret)
    let coin_account = libs::LibsBackend::new(run.join(&coin.wallet), run.join(&coin.identity))?.account()?;
    fs::write(run.join("coin_address"), &coin_account.address)?;
    let mut backend = backend_for(run)?;
    backend.sync()?;
    let tip = backend.chain_tip()?;
    let tip_time = backend.tip_time()?;
    check_treasury(network, &a.treasury_address, &a.treasury_ufvk)?;
    let deadline = tip.height + deadline_in;
    let (round, claim_after) = match (a.test_round, a.test_claim_after_in) {
        (None, None) => sealed::plan(network, a.timing, tip.height, tip_time, deadline)?,
        #[cfg(feature = "regtest")]
        (Some(r), Some(c)) if network == "regtest" => {
            println!("TEST ONLY: the drand round and the late ticket wait were chosen by the test, not from the chain's times.");
            (r, deadline + c)
        }
        _ => bail!("the test round and wait are for regtest test builds only"),
    };
    let account = backend.account()?;
    let secrets = CampaignSecrets::generate();
    let fee = 10_000;
    let sealed = Sealed {
        tranches_zat: a.tranches_zat.clone(),
        pricing: a.pricing.clone(),
        drand_chain: QUICKNET_CHAIN_HASH.into(),
        drand_round: round,
        claim_after,
        coin_zat: COIN_ZAT,
        coin_cutoff: COIN_CUTOFF_BLOCKS,
        coin_sending: a.coin_sending.clone(),
        timing: a.timing,
        // SPEC 9.1, open_payouts: every payment to a person checkable by the page and the recount
        open_payouts: true,
        // the review, M4: a 16 byte binding tag made with the locked key
        long_tag: true,
        // the second review, C1: the early ticket made with its own outgoing key, so a take back is checked to pay the person
        early_key: true,
        // a payment whose small payment could not be mined by the cutoff is not a deposit: it goes back on its own (an honest host never fails S3)
        coin_margin: sealed::COIN_MARGIN_BLOCKS,
    };
    if a.test_round.is_none() {
        sealed.check_timing(network, deadline, tip.height, tip_time)?;
        sealed.check_not_too_late(network, tip.height + 1, deadline, tip_time)?;
    }
    let rules = Rules {
        v: 1,
        network: network.into(),
        mode: "sealed_auction".into(),
        goal_zat: None,
        items: Some(a.items),
        start_height: tip.height + 1,
        deadline_height: deadline,
        ticket_k,
        close_grace: 10,
        reissue_window: 20,
        refund_fee_zat: fee,
        min_contribution_zat: *a.tranches_zat.first().context("at least one tranche")?,
        campaign_ufvk: None,
        ufvk_hash: Some(ufvk_hash(&account.ufvk)),
        pay_to: Some(ll_core::receiver::to_standard(&account.address)?),
        pricing: None,
        settle_window: None,
        reserve_zat: a.reserve_zat,
        treasury_address: Some(ll_core::receiver::to_standard(&a.treasury_address)?),
        treasury_ufvk: Some(a.treasury_ufvk.clone()),
        name,
        early_close: None,
        cap_zat: None,
        sealed: Some(sealed),
        ledger_pubkey: secrets.ledger_pubkey_hex()?,
        payload_pubkey: secrets.payload_pubkey_hex()?,
    };
    rules.validate()?;
    let rules_id = hex::encode(rules.id()?);
    fs::write(run.join("rules.json"), serde_json::to_vec_pretty(&rules)?)?;
    fs::write(run.join("rules_id"), &rules_id)?;
    write_private(&run.join("secrets.json"), &serde_json::to_vec_pretty(&secrets)?)?;
    // the viewing key stays private until every winner is settled (owner decision 8)
    write_private(&run.join("private").join("ufvk"), account.ufvk.as_bytes())?;
    write_private(&run.join("private").join("coins_last"), now_unix().to_string().as_bytes())?;
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
    let s = rules.sealed.as_ref().expect("set above");
    println!("blind bid auction created");
    println!("  rules_id:  {rules_id}");
    println!("  address:   {}", account.address);
    println!("  heights:   start {} deadline {} coin cutoff {} late tickets after {}", rules.start_height, deadline, s.cutoff_height(deadline), claim_after);
    println!("  bids open: drand quicknet round {round}");
    Ok(())
}

/// What the host keeps about a deposit for its coin and late ticket (private).
#[derive(Serialize, Deserialize, Clone)]
struct Deposit {
    txid: String,
    action: u32,
    value_zat: u64,
    height: u32,
    to: String,
    page_key: String,
    enc_pubkey: String,
}

fn deposit_path(run: &Run, nf: &str) -> PathBuf {
    run.dir.join("private").join("deposits").join(format!("{nf}.json"))
}

pub fn signed_refund_path(run: &Run, nf: &str) -> PathBuf {
    run.dir.join("private").join("refunds").join(format!("{nf}.pczt"))
}

fn late_blob_path(run: &Run, nf: &str) -> PathBuf {
    run.dir.join("tickets").join(format!("{nf}.late.blob"))
}

/// The sealed file a relay serves for an entry's `blob_hash`: the early ticket of an issue entry, the late ticket of a coin entry.
pub fn blob_file(run: &Run, e: &Entry) -> Option<PathBuf> {
    match (&e.coin, e.nf()) {
        (Some(c), _) => Some(late_blob_path(run, &c.nf)),
        (None, Some(nf)) => Some(run.dir.join("tickets").join(format!("{nf}.blob"))),
        _ => None,
    }
}

fn seal_to(enc_pubkey: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>> {
    crypto_box::PublicKey::from(*enc_pubkey).seal(&mut OsRng, plain).map_err(|e| anyhow!("seal: {e}"))
}

/// One watcher pass for a sealed bid auction, in place of `issue_pending`: deposits, then coins.
pub fn pass(run: &Run, backend: &mut dyn WalletBackend, notes: &[WalletNote], entries: &[Entry], tip: &backend::ChainTip) -> Result<(usize, Vec<(String, String)>)> {
    let (mut new, skipped) = intake(run, backend, notes, entries, tip)?;
    let entries = run.ledger().load()?;
    match send_coins(run, backend, notes, &entries, tip) {
        Ok(n) => new += n,
        Err(e) => {
            println!("coins not sent this pass: {e:#}");
            // kept for the dashboard, which warns the host until coins go out again
            let _ = write_private(&coins_error_path(run), format!("{e:#}").as_bytes());
        }
    }
    if let Err(e) = refresh_coin_wallet(run, tip.height) {
        println!("coin wallet not synced this pass: {e:#}");
    }
    let entries = run.ledger().load()?;
    match return_late(run, backend, notes, &entries, tip) {
        Ok(n) => new += n,
        Err(e) => println!("late deposits not sent back this pass: {e:#}"),
    }
    Ok((new, skipped))
}

/// SPEC 9.1, open_payouts: the outgoing viewing key of the payment of `kind` to the person whose page key is `enc_pubkey`, for the payment or deposit `nf`.
fn payment_key(run: &Run, enc_pubkey: &[u8; 32], nf: &str, kind: &str) -> Result<[u8; 32]> {
    Ok(payout::payment_ovk(&payout::shared_secret(&hex32(&run.secrets.payload_sk)?, enc_pubkey), nf, kind))
}

/// "HH:MM" in UTC for a unix time (for the close log).
fn utc_hm(t: u64) -> String {
    format!("{:02}:{:02}", (t / 3600) % 24, (t / 60) % 60)
}

/// Payments that are not in the auction go back on their own, to the refund address in their memo, minus the network fee (the refund fee of
/// the rules), and the return is named on the public list (kind "late_return", no amount); the recount checks each one (S7):
/// - a payment mined in the last `LATE_MARGIN_BLOCKS` before the deadline or after it (its early ticket could not be built in time);
/// - a payment the host rejected, with open payouts (a false reject keeps nothing; a second payment with the same memo goes back too);
/// - the safety net: once the auction is closed, any deposit that never got its tickets (early ticket and signed refund), for whatever
///   reason, so that no edge case can keep someone's money.
/// A payment whose memo does not open with this auction's key has no refund address the host can read; it stays, and the recount names it.
fn return_late(run: &Run, backend: &mut dyn WalletBackend, notes: &[WalletNote], entries: &[Entry], tip: &backend::ChainTip) -> Result<usize> {
    let r = &run.rules;
    let fee = r.refund_fee_zat;
    let named = |kind: &str| -> BTreeSet<&str> { entries.iter().filter(|e| e.kind == kind).filter_map(Entry::nf).collect() };
    let (returned, ticketed, rejected) = (named("late_return"), named("issue"), named("reject"));
    let open = r.sealed.as_ref().is_some_and(|s| s.open_payouts);
    let closed = close_entry(entries).is_some();
    let ob = outbox::Outbox::load(&run.dir)?;
    let mut sent = 0;
    let mut log = vec![];
    for n in chain_notes(notes) {
        let Some(nf) = n.nf.clone() else { continue };
        let in_window = !n.is_change
            && n.height.is_some_and(|h| h >= r.start_height && h <= r.sealed.as_ref().map_or(sealed::last_deposit_height(r.deadline_height), |s| s.last_deposit(r.deadline_height)))
            && n.value_zat > fee
            && n.memo_text.as_deref().is_some_and(bid::is_bid_memo);
        // a late payment goes back even when it has tickets: a reorganised chain can move a deposit into the last blocks (the review, L6)
        let late = ll_core::sealed_recount::is_late_deposit(r, &n);
        let unticketed = closed && in_window && !ticketed.contains(nf.as_str()) && !rejected.contains(nf.as_str());
        // a rejected payment (a false reject, or a second payment with an accepted deposit's memo) goes back at once (the review, H3, M5)
        let refused = open && in_window && rejected.contains(nf.as_str());
        // TEST ONLY (`test-cheats` builds): `LL_TEST_KEEP_REJECTS=1` makes a cheating host that keeps the payments it rejected
        #[cfg(feature = "test-cheats")]
        let refused = refused && std::env::var_os("LL_TEST_KEEP_REJECTS").is_none();
        if !(late || unticketed || refused) || n.spent_by.is_some() || returned.contains(nf.as_str()) || ob.live_for(&nf).is_some() {
            continue;
        }
        let h = n.height.unwrap_or(0);
        if (tip.height + 1).saturating_sub(h) < run.min_confirmations {
            continue;
        }
        let memo_text = n.memo_text.clone().unwrap_or_default();
        let opened = BidMemo::parse(&memo_text).and_then(|m| Payload::open_sealed(&m.sealed, &run.secrets.payload_key()?).map_err(|e| anyhow!("{e}")));
        let p = match opened {
            Ok(p) if hex::encode(p.rules_id) == run.rules_id => p,
            Ok(_) => { println!("late payment {}:{} carries a memo for another auction; it stays", n.txid, n.action); continue; }
            Err(e) => { println!("late payment {}:{} has no refund address the host can read ({e}); it stays", n.txid, n.action); continue; }
        };
        let owner = format!("late:{nf}");
        // a ticket that was started but never built may have left its lock (the list names no ticket for this note)
        let _ = backend.unlock(&n.txid, n.action, &format!("ticket:{nf}"));
        backend.lock(&n.txid, n.action, &owner, LOCK_FOREVER)?;
        let (pay_receiver, to) = ticket_receiver(backend, &r.network, p.refund_receiver)?;
        let back = n.value_zat - fee;
        // SPEC 9.1, open_payouts: made with the key the payer's page works out on its own, so the page and the recount see who it pays
        let ovk = payment_key(run, &p.enc_pubkey, &nf, payout::RETURN)?;
        let unsigned = backend.build(&SpendRequest { to_address: to, value_zat: back, lock_owners: vec![owner], no_expiry: true, expiry_height: None, also_pay: vec![], ovk: Some(ovk) })?;
        let signed = backend.sign(&unsigned)?;
        ticket::check_and_extract(&signed, &Expect { spends: BTreeMap::from([(hex32(&nf)?, n.value_zat)]), receiver: &pay_receiver, value_zat: back, no_expiry: true, also: vec![] })?;
        let txid = send_tracked(run, backend, tip, "late_return", &format!("late deposit {} sent back", &nf[..8]), &signed, vec![nf.clone()], &mut log)?;
        let mut e = Entry::new(&run.rules_id, "late_return");
        e.contribution = Some(ledger::Contribution { txid: n.txid.clone(), action: n.action, nf: nf.clone(), height: h, value_zat: None, amount_commit: None });
        e.refund = Some(txid.clone());
        // the hash of the payment's memo: the page that made the payment finds its own return by it (the memo itself stays private)
        e.blob_hash = Some(ledger::blob_hash(memo_text.as_bytes()));
        run.append(e)?;
        let why = if late { format!("a payment too late to bid, the deadline is {}", r.deadline_height) } else if refused { "a payment the host rejected".to_string() } else { "a deposit that never got its tickets".to_string() };
        println!("payment {} (mined in block {h}: {why}) sent back, minus the {} fee: {txid}", &nf[..12], r.amount(fee));
        sent += 1;
    }
    Ok(sent)
}

fn coins_error_path(run: &Run) -> PathBuf {
    run.dir.join("private").join("coins_error")
}

/// Why the last small payments could not be sent, until a batch goes out again (for the dashboard's warning).
pub fn coins_problem(run: &Run) -> Option<String> {
    fs::read_to_string(coins_error_path(run)).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Until the late ticket block, syncs the coin wallet at most once a minute, so its balance on the dashboard is the real one (otherwise it
/// is read only when coins go out, and a wallet the host has just funded shows 0).
fn refresh_coin_wallet(run: &Run, tip: u32) -> Result<()> {
    if run.rules.sealed.as_ref().is_none_or(|s| tip > s.claim_after) || coin_wallet_dir(run).is_none() {
        return Ok(());
    }
    let last_path = run.dir.join("private").join("coin_sync_last");
    let last: u64 = fs::read_to_string(&last_path).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    if now_unix() < last + 60 {
        return Ok(());
    }
    coin_backend(run)?.sync()?;
    write_private(&last_path, now_unix().to_string().as_bytes())
}

/// Deposits: every payment in the bidding window with a version 3 memo gets its early ticket and signed refund, or a reject.
fn intake(run: &Run, backend: &mut dyn WalletBackend, notes: &[WalletNote], entries: &[Entry], tip: &backend::ChainTip) -> Result<(usize, Vec<(String, String)>)> {
    let r = &run.rules;
    let mut new = 0;
    let mut skipped = vec![];
    let mut ordered: Vec<&WalletNote> = notes.iter().collect();
    ordered.sort_by(|x, y| {
        let (a, b) = (&x.note, &y.note);
        a.height.cmp(&b.height).then(a.tx_index.cmp(&b.tx_index)).then(a.txid.cmp(&b.txid)).then(a.action.cmp(&b.action))
    });
    let mut accepted: BTreeSet<String> = entries
        .iter()
        .filter(|e| e.kind == "issue")
        .filter_map(|e| e.nf().and_then(|nf| notes.iter().find(|w| w.note.nf.as_deref() == Some(nf)).and_then(|w| w.note.memo_text.clone())))
        .collect();
    for note in ordered {
        let n = &note.note;
        let (Some(h), Some(nf)) = (n.height, &n.nf) else { continue };
        let candidate = !n.is_change
            && h >= r.start_height
            && h <= r.sealed.as_ref().map_or(sealed::last_deposit_height(r.deadline_height), |s| s.last_deposit(r.deadline_height)) // a later payment is late: it is sent back (return_late)
            && n.value_zat >= r.min_contribution_zat
            && n.spent_by.is_none()
            && n.memo_text.as_deref().is_some_and(bid::is_bid_memo);
        if !candidate || entries.iter().any(|e| e.nf() == Some(nf.as_str())) {
            continue;
        }
        let confirmations = (tip.height + 1).saturating_sub(h);
        if confirmations < run.min_confirmations {
            skipped.push((format!("{}:{}", n.txid, n.action), format!("waiting for {} confirmations (it has {confirmations})", run.min_confirmations)));
            continue;
        }
        let memo_text = n.memo_text.clone().unwrap_or_default();
        let opened = BidMemo::parse(&memo_text).and_then(|m| {
            let p = Payload::open_sealed(&m.sealed, &run.secrets.payload_key()?).map_err(|e| anyhow!("{e} [unreadable]"))?;
            if accepted.contains(&memo_text) {
                bail!("replayed memo: the same memo was already used by an earlier deposit");
            }
            ll_core::payload::check(&p, &run.rules_id, n.value_zat, r.refund_fee_zat).map_err(|e| anyhow!(e.reason(r)))?;
            Ok((m, p))
        });
        let result = match opened {
            Ok((m, p)) => {
                let res = issue_deposit(run, backend, n, &m, &p, tip);
                if res.is_err() {
                    // a ticket that could not be built leaves no lock behind (the note may still go back on its own)
                    let _ = backend.unlock(&n.txid, n.action, &format!("ticket:{}", n.nf.clone().unwrap_or_default()));
                }
                if res.is_ok() {
                    accepted.insert(memo_text);
                }
                res
            }
            Err(reason) => {
                let mut e = Entry::new(&run.rules_id, "reject");
                e.contribution = Some(contribution_of(run, n)?);
                e.reason = Some(reason.to_string());
                // the hash of the payment's memo: the page that made the payment finds the reject by it, shows it and can challenge it
                if r.sealed.as_ref().is_some_and(|s| s.open_payouts) {
                    e.blob_hash = Some(ledger::blob_hash(memo_text.as_bytes()));
                }
                run.append(e)
            }
        };
        match result {
            Ok(e) => {
                new += 1;
                match &e.ticket {
                    Some(t) => println!("deposit ticketed: entry {} for {}:{} -> early ticket {} (expires at {}), signed refund {}", e.seq, n.txid, n.action, t.txid, r.deadline_height, e.refund.as_deref().unwrap_or_default()),
                    None => println!("rejected: entry {} for {}:{} ({})", e.seq, n.txid, n.action, e.reason.unwrap_or_default()),
                }
            }
            Err(err) => {
                println!("skipped {}:{}: {err:#}", n.txid, n.action);
                skipped.push((format!("{}:{}", n.txid, n.action), format!("{err:#}")));
            }
        }
    }
    Ok((new, skipped))
}

/// The early ticket (expires at the deadline) and the refund signed now, for one deposit; the issue entry.
fn issue_deposit(run: &Run, backend: &mut dyn WalletBackend, n: &ChainNote, memo: &BidMemo, payload: &Payload, tip: &backend::ChainTip) -> Result<Entry> {
    let r = &run.rules;
    let nf = n.nf.clone().context("note without nullifier")?;
    let value = n.value_zat - r.refund_fee_zat;
    let owner = format!("ticket:{nf}");
    backend.lock(&n.txid, n.action, &owner, LOCK_FOREVER)?;
    let (pay_receiver, to) = ticket_receiver(backend, &r.network, payload.refund_receiver)?;
    let early_ovk = if r.sealed.as_ref().is_some_and(|s| s.early_key) { Some(payment_key(run, &payload.enc_pubkey, &nf, payout::EARLY)?) } else { None };
    let (early_receiver, early_to) = (pay_receiver, to.clone());
    // TEST ONLY (`test-cheats` builds): `LL_TEST_EARLY_TO=<address>` makes a cheating host whose early ticket pays that address, sealed in
    // the oldest format (no opening values, no signed refund), as in the second review's C1
    #[cfg(feature = "test-cheats")]
    let cheat_early = std::env::var("LL_TEST_EARLY_TO").ok();
    #[cfg(not(feature = "test-cheats"))]
    let cheat_early: Option<String> = None;
    let (early_receiver, early_to) = match &cheat_early {
        Some(a) => { eprintln!("FAKE CHEATING HOST (test-cheats build): the early ticket pays {a}, sealed without opening values"); ticket_receiver(backend, &r.network, orchard_receiver(a)?.1)? }
        None => (early_receiver, early_to),
    };
    let unsigned = backend.build(&SpendRequest { to_address: early_to, value_zat: value, lock_owners: vec![owner.clone()], no_expiry: false, expiry_height: Some(r.deadline_height), also_pay: vec![], ovk: early_ovk })?;
    let signed = backend.sign(&unsigned)?;
    let expiry = *pczt::Pczt::parse(&signed).map_err(|e| anyhow!("{e:?}"))?.global().expiry_height();
    ensure!(expiry == r.deadline_height, "the early ticket expires at {expiry}, not at the deadline {}", r.deadline_height);
    let checked = ticket::check_and_extract(
        &signed,
        &Expect { spends: BTreeMap::from([(hex32(&nf)?, n.value_zat)]), receiver: &early_receiver, value_zat: value, no_expiry: false, also: vec![] },
    )?;
    if !BRANCH_SIMULATED.load(std::sync::atomic::Ordering::Relaxed) {
        let now = backend.chain_tip()?;
        ensure!(checked.branch_id == now.branch_id, "the early ticket was built for branch {} but the network reports {}", checked.branch_id, now.branch_id);
    }
    // the refund signed with the deposit. With open payouts (SPEC 9.1, open_payouts) it is finished now, made with the key the page works out, and sealed
    // to the page with the early ticket, so the page checks before it says PROTECTED that it pays the person who bid (the review, C1)
    let open = r.sealed.as_ref().is_some_and(|s| s.open_payouts);
    let (refund, refund_txid, refund_opening) = if open {
        let ovk = payment_key(run, &payload.enc_pubkey, &nf, payout::REFUND)?;
        let (refund_receiver, refund_to) = (pay_receiver, to.clone());
        // TEST ONLY (`test-cheats` builds): `LL_TEST_REFUND_TO=<address>` makes a cheating host whose signed refund pays that address (C1)
        #[cfg(feature = "test-cheats")]
        let (refund_receiver, refund_to) = match std::env::var("LL_TEST_REFUND_TO") {
            Ok(a) => { eprintln!("FAKE CHEATING HOST (test-cheats build): the signed refund pays {a}"); ticket_receiver(backend, &r.network, orchard_receiver(&a)?.1)? }
            Err(_) => (refund_receiver, refund_to),
        };
        let u = backend.build(&SpendRequest { to_address: refund_to, value_zat: value, lock_owners: vec![owner.clone()], no_expiry: true, expiry_height: None, also_pay: vec![], ovk: Some(ovk) })?;
        let sg = backend.sign(&u)?;
        let rc = ticket::check_and_extract(&sg, &Expect { spends: BTreeMap::from([(hex32(&nf)?, n.value_zat)]), receiver: &refund_receiver, value_zat: value, no_expiry: true, also: vec![] })?;
        (rc.raw_tx.clone(), rc.txid.clone(), rc.opening)
    } else {
        let (refund, txid) = backend.signed_refund(&owner, &to, value)?;
        (refund, txid, None)
    };
    write_private(&run.signed_ticket_path(&nf), &signed)?;
    write_private(&signed_refund_path(run, &nf), &refund)?;
    let dep = Deposit {
        txid: n.txid.clone(),
        action: n.action,
        value_zat: n.value_zat,
        height: n.height.unwrap_or(0),
        to,
        page_key: hex::encode(memo.page_key),
        enc_pubkey: hex::encode(payload.enc_pubkey),
    };
    write_private(&deposit_path(run, &nf), &serde_json::to_vec_pretty(&dep)?)?;
    let plain = match (open, checked.opening, refund_opening) {
        _ if cheat_early.is_some() => ticket_plaintext(checked.raw_tx.clone(), None),
        (true, Some(early_opening), Some(refund_opening)) => ll_core::ticket_blob::encode_sealed(&ll_core::ticket_blob::SealedTickets {
            early: checked.raw_tx.clone(), early_opening, refund: refund.clone(), refund_opening,
        }),
        (true, _, _) => bail!("the early ticket or the refund has no opening values"),
        (false, _, _) => ticket_plaintext(checked.raw_tx.clone(), checked.opening),
    };
    let blob = seal_to(&payload.enc_pubkey, &plain)?;
    let tickets = run.dir.join("tickets");
    fs::create_dir_all(&tickets)?;
    fs::write(tickets.join(format!("{nf}.blob")), &blob)?;
    let mut entry = Entry::new(&run.rules_id, "issue");
    entry.contribution = Some(contribution_of(run, n)?);
    entry.ticket = Some(Ticket { txid: checked.txid, issue_height: tip.height, branch_id: checked.branch_id });
    entry.blob_hash = Some(ledger::blob_hash(&blob));
    entry.refund = Some(refund_txid);
    run.append(entry)
}

/// A batch of coins already paid: which deposit got which output (kept until every deposit in it has its coin entry).
#[derive(Serialize, Deserialize)]
struct Batch {
    txid: String,
    coins: Vec<(String, u32)>,
}

fn batches_dir(run: &Run) -> PathBuf {
    run.dir.join("private").join("coin_batches")
}

fn load_batches(run: &Run) -> Vec<Batch> {
    let Ok(rd) = fs::read_dir(batches_dir(run)) else { return vec![] };
    rd.filter_map(|f| fs::read(f.ok()?.path()).ok()).filter_map(|b| serde_json::from_slice(&b).ok()).collect()
}

/// Whether coins are due now, by the host's choice; near the coin cutoff they always are.
fn coins_due(s: &Sealed, waiting: usize, tip: u32, cutoff: u32, last: u64, now: u64) -> bool {
    if waiting == 0 || tip >= cutoff {
        return false;
    }
    if tip + COIN_RUSH_BLOCKS >= cutoff {
        return true;
    }
    match s.coin_sending {
        CoinSending::AtOnce => true,
        CoinSending::EveryBids { n } => waiting >= n as usize,
        CoinSending::EveryMinutes { n } => now >= last + u64::from(n) * 60,
    }
}

/// Sends the coins that are due from the coin wallet, then builds each late ticket and writes its coin entry. A batch that was paid but
/// whose entries were not all written (an interrupted pass) is finished first, so no deposit is paid twice.
fn send_coins(run: &Run, backend: &mut dyn WalletBackend, notes: &[WalletNote], entries: &[Entry], tip: &backend::ChainTip) -> Result<usize> {
    let s = run.rules.sealed.as_ref().context("not a blind bid auction")?;
    let cutoff = s.cutoff_height(run.rules.deadline_height);
    let has_coin: BTreeSet<String> = entries.iter().filter_map(|e| e.coin.as_ref().map(|c| c.nf.clone())).collect();
    let mut written = 0;
    let batches = load_batches(run);
    for b in &batches {
        for (nf, index) in &b.coins {
            if !has_coin.contains(nf) {
                write_coin_entry(run, backend, s, nf, &b.txid, *index)?;
                written += 1;
            }
        }
    }
    let in_batch: BTreeSet<&str> = batches.iter().flat_map(|b| b.coins.iter().map(|c| c.0.as_str())).collect();
    let unspent = |nf: &str| notes.iter().any(|w| w.note.nf.as_deref() == Some(nf) && w.note.spent_by.is_none());
    // deposits still in the auction that have no coin yet; a deposit mined after the cutoff cannot get one in time (it is refunded at the close)
    let waiting: Vec<String> = entries
        .iter()
        .filter(|e| e.kind == "issue")
        .filter(|e| e.contribution.as_ref().is_some_and(|c| c.height <= cutoff))
        .filter_map(|e| e.nf().map(str::to_string))
        .filter(|nf| !has_coin.contains(nf) && !in_batch.contains(nf.as_str()) && unspent(nf))
        .collect();
    let last: u64 = fs::read_to_string(run.dir.join("private").join("coins_last")).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    if !coins_due(s, waiting.len(), tip.height, cutoff, last, now_unix()) {
        if !waiting.is_empty() {
            println!("{} deposit(s) waiting for their coin (coin cutoff block {cutoff})", waiting.len());
        }
        return Ok(written);
    }
    let deps: Vec<(String, Deposit)> = waiting.iter().map(|nf| Ok((nf.clone(), serde_json::from_slice(&fs::read(deposit_path(run, nf))?)?))).collect::<Result<_>>()?;
    let outs: Vec<([u8; 33], u64)> = deps.iter().map(|(_, d)| Ok((hex::decode(&d.page_key)?.try_into().map_err(|_| anyhow!("page key"))?, s.coin_zat))).collect::<Result<_>>()?;
    let mut coin_wallet = coin_backend(run)?;
    coin_wallet.sync()?;
    let (txid, index) = coin_wallet.pay_coins(&outs)?;
    let batch = Batch { txid: txid.clone(), coins: deps.iter().map(|(nf, _)| nf.clone()).zip(index).collect() };
    write_private(&batches_dir(run).join(format!("{txid}.json")), &serde_json::to_vec_pretty(&batch)?)?;
    write_private(&run.dir.join("private").join("coins_last"), now_unix().to_string().as_bytes())?;
    let _ = fs::remove_file(coins_error_path(run));
    println!("coins sent: {} coin(s) of {} zatoshis in {txid}", batch.coins.len(), s.coin_zat);
    for (nf, i) in &batch.coins {
        write_coin_entry(run, backend, s, nf, &txid, *i)?;
        written += 1;
    }
    Ok(written)
}

/// The late ticket for one deposit and its coin, sealed for the bid page, and the coin entry.
fn write_coin_entry(run: &Run, backend: &mut dyn WalletBackend, s: &Sealed, nf: &str, coin_txid: &str, index: u32) -> Result<Entry> {
    let d: Deposit = serde_json::from_slice(&fs::read(deposit_path(run, nf))?)?;
    let page_key: [u8; 33] = hex::decode(&d.page_key)?.try_into().map_err(|_| anyhow!("page key"))?;
    let coin = libs::CoinInput { txid: coin_txid.into(), index, value_zat: s.coin_zat, page_key };
    let value = d.value_zat - run.rules.refund_fee_zat;
    let (raw, late_txid) = backend.late_ticket(&format!("ticket:{nf}"), &d.to, value, &coin, s.claim_after)?;
    let blob = seal_to(&hex32(&d.enc_pubkey)?, &raw)?;
    let path = late_blob_path(run, nf);
    fs::create_dir_all(path.parent().expect("tickets"))?;
    fs::write(&path, &blob)?;
    let mut e = Entry::new(&run.rules_id, "coin");
    e.coin = Some(ledger::Coin { nf: nf.into(), txid: coin_txid.into(), index, value_zat: s.coin_zat });
    e.late = Some(late_txid.clone());
    e.blob_hash = Some(ledger::blob_hash(&blob));
    let e = run.append(e)?;
    println!("coin entry {}: deposit {nf} has coin {coin_txid}:{index} and late ticket {late_txid} (valid after block {})", e.seq, s.claim_after);
    Ok(e)
}

/// The recount's report on the host's own view (its wallet sees every deposit and spend), with `extra_close` appended unsigned when given
/// (the close the host is about to write: the recount's own rules then say what the opened bids give, so host and recount agree).
/// The close log's line for the close entry; `price` is None when each winner pays their own bid.
fn close_entry_line(seq: impl std::fmt::Display, winners: usize, price: Option<String>) -> String {
    match (winners, price) {
        (0, _) => format!("close entry {seq}: no winners, every deposit goes back"),
        (n, Some(p)) => format!("close entry {seq}: {n} winner(s), price {p}"),
        (n, None) => format!("close entry {seq}: {n} winner(s), each pays their own bid"),
    }
}

fn host_view(run: &Run, backend: &mut dyn WalletBackend, tip: u32, extra_close: Option<Entry>, block_times: Vec<(u32, u64)>) -> Result<ll_core::recount::Report> {
    let mut entries = run.ledger().load()?;
    entries.extend(extra_close);
    let notes = chain_notes(&backend.notes()?);
    let extra = ll_core::recount::Extra { block_times, ..Default::default() };
    Ok(ll_core::recount::recount_with(&run.rules, &run.rules_id, &entries, &notes, &[], tip, true, &extra))
}

/// The close of a sealed bid auction (SPEC §9.6), as far as it can go now; run it again until it says it is finished (the watcher does).
/// 1. After the deadline: the void rule from the block times; round R's signature from drand (checked against the pinned key); the
///    outcome from the opened bids, by the recount's own rules; the close entry.
/// 2. Each winner's settlement (the price to the treasury, the rest back to the person who bid) and its entry; every other deposit's signed refund,
///    finished with today's anchor and proof, and sent.
/// 3. Once every settlement is mined: the viewing key (owner decision 8).
/// Returns whether the close is finished.
pub fn close_pass(run: &Run, backend: &mut dyn WalletBackend, log: &mut Vec<String>) -> Result<bool> {
    let r = &run.rules;
    let s = r.sealed.as_ref().context("not a blind bid auction")?;
    backend.sync()?;
    let tip = backend.chain_tip()?;
    let d = r.deadline_height;
    ensure!(tip.height > d, "deadline {d} not reached (tip {}); a blind bid auction cannot be closed early", tip.height);
    let entries = run.ledger().load()?;
    if close_entry(&entries).is_none() {
        let times = backend.block_times(d.saturating_sub(10), d)?;
        let mtp = ll_core::sealed_recount::median_time_after(&times, d).context("the block times before the deadline are not available")?;
        let void = sealed::round_time(s.drand_round) < mtp + sealed::gap_secs(s.timing);
        let sig = if void {
            note!(log, "VOID: round {} was published before the median time of the deadline's blocks plus {} s; every deposit goes back", s.drand_round, sealed::gap_secs(s.timing));
            None
        } else {
            let at = sealed::round_time(s.drand_round);
            if now_unix() < at {
                bail!("waiting for drand round {}, published at {} UTC, in about {} minute(s)", s.drand_round, utc_hm(at), (at - now_unix()).div_ceil(60));
            }
            let (sig, from) = drand::fetch_round(s.drand_round, &drand::urls())?;
            note!(log, "round {} signature from {from}, checked against drand quicknet's key", s.drand_round);
            Some(hex::encode(sig))
        };
        let mut close = Entry::new(&run.rules_id, "close");
        close.close = Some(ledger::Close {
            close_height: tip.height,
            outcome: if void { "void" } else { "sealed_auction" }.into(),
            winners: Some(vec![]),
            ufvk: None,
            amount_key: Some(hex::encode(run.amount_key()?)),
            clearing_price_zat: None,
            drand_signature: sig,
        });
        let rep = host_view(run, backend, tip.height, Some(close.clone()), times)?;
        let sr = rep.sealed.context("no sealed report")?;
        ensure!(sr.void == void, "the void rule disagrees with the recount");
        ensure!(void || sr.opened, "the bids did not open with round {}", s.drand_round);
        for o in &sr.deposits {
            let what = match (&o.bid_zat, &o.no_bid, o.withdrawn) {
                (_, _, true) => "taken back before the deadline".to_string(),
                (Some(b), None, _) => format!("bid {}", r.amount(*b)),
                (_, Some(why), _) => format!("no bid: {why}"),
                _ => "not opened".into(),
            };
            note!(log, "deposit {} ({}): {what}{}", &o.nf[..12], r.amount(o.value_zat), if o.winner { ", WINS" } else { "" });
        }
        if let Some(c) = close.close.as_mut() {
            c.winners = Some(sr.winners.clone());
            c.clearing_price_zat = sr.price_zat;
        }
        let e = run.append(close)?;
        note!(log, "{}", close_entry_line(e.seq, sr.winners.len(), sr.price_zat.map(|p| r.amount(p))));
    }
    // 2. settlements and refunds, from the report on the real list
    let rep = host_view(run, backend, tip.height, None, vec![])?;
    let sr = rep.sealed.context("no sealed report")?;
    let entries = run.ledger().load()?;
    let notes = backend.notes()?;
    let spent = |nf: &str| notes.iter().find(|w| w.note.nf.as_deref() == Some(nf)).and_then(|w| w.note.spent_by.clone());
    let treasury = r.treasury_address.clone().context("no treasury address")?;
    let (_, treasury_raw) = orchard_receiver(&treasury)?;
    let fee = r.refund_fee_zat;
    let mut ob = outbox::Outbox::load(&run.dir)?;
    for o in sr.deposits.iter().filter(|o| !o.withdrawn) {
        if spent(&o.nf).is_some() || ob.live_for(&o.nf).is_some() || entries.iter().any(|e| e.settle.as_ref().is_some_and(|x| x.nf == o.nf)) {
            continue;
        }
        // a deposit the host never ticketed has no signed refund: it is sent back on its own after the close (return_late), never here
        if !deposit_path(run, &o.nf).exists() {
            note!(log, "deposit {} has no tickets from the host: it is sent back on its own, minus the fee", &o.nf[..12]);
            continue;
        }
        let dep: Deposit = serde_json::from_slice(&fs::read(deposit_path(run, &o.nf))?)?;
        let owner = format!("ticket:{}", o.nf);
        if o.winner {
            let price = o.price_zat.context("a winner without a price")?;
            ensure!(o.value_zat >= price + fee, "winner {}: the deposit cannot cover the price and the fee", o.nf);
            let excess = o.value_zat - price - fee;
            let change_to = dep.to.clone();
            // TEST ONLY (`test-cheats` builds): `LL_TEST_CHANGE_TO=<address>` makes a cheating host that sends a winner's change there (H2)
            #[cfg(feature = "test-cheats")]
            let change_to = std::env::var("LL_TEST_CHANGE_TO").map(|a| { eprintln!("FAKE CHEATING HOST (test-cheats build): the change goes to {a}"); a }).unwrap_or(change_to);
            let (_, refund_raw) = orchard_receiver(&change_to)?;
            let also_pay = if excess > 0 { vec![(change_to.clone(), excess)] } else { vec![] };
            // SPEC 9.1, open_payouts: made with the key the winner's page works out, so the page and the recount see the change pays the winner (H2)
            let ovk = if r.sealed.as_ref().is_some_and(|s| s.open_payouts) { Some(payment_key(run, &hex32(&dep.enc_pubkey)?, &o.nf, payout::CHANGE)?) } else { None };
            let unsigned = backend.build(&SpendRequest { to_address: treasury.clone(), value_zat: price, lock_owners: vec![owner], no_expiry: true, expiry_height: None, also_pay, ovk })?;
            let signed = backend.sign(&unsigned)?;
            let also = if excess > 0 { vec![(refund_raw, excess)] } else { vec![] };
            ticket::check_and_extract(&signed, &Expect { spends: BTreeMap::from([(hex32(&o.nf)?, o.value_zat)]), receiver: &treasury_raw, value_zat: price, no_expiry: true, also })?;
            let txid = send_tracked(run, backend, &tip, "settle", &format!("settlement for winner {}", &o.nf[..8]), &signed, vec![o.nf.clone()], log)?;
            let mut e = Entry::new(&run.rules_id, "settle");
            e.settle = Some(ledger::Settle { nf: o.nf.clone(), txid: txid.clone(), price_zat: price, excess_zat: excess, fee_zat: fee });
            run.append(e)?;
            note!(log, "settled winner {}: {} to the treasury, {} back: {txid}", &o.nf[..12], r.amount(price), r.amount(excess));
        } else {
            let signed = fs::read(signed_refund_path(run, &o.nf))?;
            // with open payouts the refund was finished with the deposit (and checked by the page): it is sent as it is
            let raw = if r.sealed.as_ref().is_some_and(|s| s.open_payouts) { signed } else { backend.finish_refund(&signed, &owner, &dep.to, dep.value_zat - fee)? };
            let txid = zcash_primitives::transaction::Transaction::read(&raw[..], zcash_protocol::consensus::BranchId::Nu7)?.txid().to_string();
            let item = outbox::Sent { kind: "refund".into(), label: format!("signed refund for {}", &o.nf[..8]), txid: txid.clone(), raw_hex: hex::encode(&raw), nfs: vec![o.nf.clone()], branch: String::new(), first_height: 0, last_sent_height: 0, sends: 0, status: String::new(), mined_height: None, note: None };
            ob.send(backend, tip.height, &tip.branch_id, item, log)?;
            note!(log, "refunded {} with its signed refund: {txid}", &o.nf[..12]);
        }
    }
    // 3. the viewing key, once every winner's settlement is mined and every other deposit is on its way back
    let entries = run.ledger().load()?;
    if entries.iter().any(|e| e.kind == "reveal") {
        return Ok(true);
    }
    let notes = backend.notes()?;
    let mined = |nf: &str| notes.iter().any(|w| w.note.nf.as_deref() == Some(nf) && w.note.spent_by.as_ref().is_some_and(|sp| sp.height.is_some()));
    let waiting: Vec<&str> = sr.deposits.iter().filter(|o| o.winner && !mined(&o.nf)).map(|o| &o.nf[..12]).collect();
    if !waiting.is_empty() {
        note!(log, "waiting for {} settlement(s) to be mined before the viewing key is published", waiting.len());
        return Ok(false);
    }
    let mut e = Entry::new(&run.rules_id, "reveal");
    let payload_sk = r.sealed.as_ref().is_some_and(|s| s.open_payouts).then(|| run.secrets.payload_sk.clone());
    e.reveal = Some(ledger::Reveal { ufvk: fs::read_to_string(run.dir.join("private").join("ufvk"))?.trim().to_string(), height: tip.height, payload_sk });
    let e = run.append(e)?;
    note!(log, "viewing key published (entry {}) at block {}: every settlement is mined", e.seq, tip.height);
    Ok(true)
}

/// The recount of this auction from the host's own view of the chain (its wallet sees every deposit and spend), with the coins and the
/// block times around the deadline fetched from the server. What a bid's recount will say once the viewing key is public; the host
/// can run it any time. Returns whether nothing fails.
pub fn self_check(run: &Run, backend: &mut dyn WalletBackend, treasury: Vec<ChainNote>) -> Result<bool> {
    backend.sync()?;
    let r = report(run, backend, treasury)?;
    for x in &r.results {
        let state = if x.waiting { "WAIT" } else if x.pass { "PASS" } else { "FAIL" };
        println!("{} {state}: {}", x.id, x.title);
        for d in &x.details {
            println!("    {d}");
        }
    }
    for w in &r.warnings {
        println!("note: {w}");
    }
    if let Some(s) = &r.sealed {
        println!("deposits {}, opened {}, void {}, winners {:?}, price {:?}, did not finish {}", s.deposits.len(), s.opened, s.void, s.winners, s.price_zat, r.did_not_finish);
    }
    let ok = r.all_pass();
    println!("RESULT: {}", if ok { "PASS" } else { "FAIL" });
    Ok(ok)
}

/// The recount report from the host's view (the wallet already synced), with the coins and block times from the server and the given
/// treasury notes.
pub fn report(run: &Run, backend: &mut dyn WalletBackend, treasury: Vec<ChainNote>) -> Result<ll_core::recount::Report> {
    let tip = backend.chain_tip()?;
    let entries = run.ledger().load()?;
    let notes = chain_notes(&backend.notes()?);
    let coin_txids: BTreeSet<String> = entries.iter().filter_map(|e| e.coin.as_ref().map(|c| c.txid.clone())).collect();
    let coins = backend.coin_facts(&coin_txids.into_iter().collect::<Vec<_>>())?;
    let d = run.rules.deadline_height;
    let block_times = if tip.height >= d { backend.block_times(d.saturating_sub(10), d)? } else { vec![] };
    // SPEC 9.1, open_payouts: who each payment to a person pays, read from the chain with its key (after the reveal publishes the payload key)
    let keys = ll_core::sealed_recount::payout_keys(&run.rules, &entries, &notes);
    let payouts = if keys.is_empty() { vec![] } else { backend.payout_facts(&keys)? };
    let extra = ll_core::recount::Extra { treasury_notes: treasury, tx_facts: vec![], checks: vec![], coins, block_times, payouts };
    Ok(ll_core::recount::recount_with(&run.rules, &run.rules_id, &entries, &notes, &[], tip.height, true, &extra))
}

/// The treasury's received notes when the treasury wallet lives in the campaign folder (`treasury1`, as the dashboard makes it), synced
/// first once the auction is closed (before that nothing has been paid to it).
/// What one payment of a treasury holding notes of `values` sends, and its network fee (ZIP 317: one action per note, at least two).
pub fn treasury_payment(values: &[u64]) -> Result<(u64, u64)> {
    ensure!(!values.is_empty(), "The treasury holds nothing to send yet.");
    let total: u64 = values.iter().sum();
    let fee = 5_000 * (values.len() as u64).max(2);
    ensure!(total > fee, "The treasury holds {total} zatoshis, not more than the {fee} the network fee takes.");
    Ok((total - fee, fee))
}

/// The dashboard's "send to my wallet": everything in the auction's treasury wallet (the winners' prices), minus the network fee, in one
/// payment to the address the host gives. Returns the transaction id.
pub fn send_treasury(run: &Run, to: &str) -> Result<String> {
    let r = &run.rules;
    ensure!(r.is_sealed(), "Only a blind bid auction keeps its treasury wallet here.");
    ensure!(close_entry(&run.ledger().load()?).is_some(), "Close the auction first.");
    let to = to.trim();
    let main = r.network == "main";
    ensure!(if main { to.starts_with("u1") } else { to.starts_with("utest1") }, "Please paste a {} unified address from your wallet.", if main { "main network" } else { "test network" });
    let (_, receiver) = orchard_receiver(to).map_err(|_| anyhow!("That address could not be read."))?;
    let w = run.dir.join("treasury1");
    ensure!(w.join("data.sqlite").exists(), "This auction has no treasury wallet in its folder.");
    let mut b = libs::LibsBackend::new(w.clone(), run.dir.join("treasury1.age"))?;
    b.sync()?;
    let notes: Vec<ChainNote> = b.notes()?.into_iter().map(|n| n.note).filter(|n| n.spent_by.is_none() && n.height.is_some() && n.nf.is_some()).collect();
    let (value, _) = treasury_payment(&notes.iter().map(|n| n.value_zat).collect::<Vec<_>>())?;
    let owner = "treasury-send";
    for n in &notes {
        b.lock(&n.txid, n.action, owner, LOCK_FOREVER)?;
    }
    let sent = (|| -> Result<String> {
        let unsigned = b.build(&SpendRequest { to_address: to.into(), value_zat: value, lock_owners: vec![owner.into()], no_expiry: true, expiry_height: None, also_pay: vec![], ovk: None })?;
        let signed = b.sign(&unsigned)?;
        let spends = notes.iter().map(|n| Ok((hex32(n.nf.as_deref().unwrap_or_default())?, n.value_zat))).collect::<Result<_>>()?;
        ticket::check_and_extract(&signed, &Expect { spends, receiver: &receiver, value_zat: value, no_expiry: true, also: vec![] })?;
        b.broadcast(&signed)
    })();
    if sent.is_err() {
        for n in &notes {
            let _ = b.unlock(&n.txid, n.action, owner);
        }
    }
    sent
}

pub fn folder_treasury(run: &Run) -> Vec<ChainNote> {
    let w = run.dir.join("treasury1");
    if !w.join("data.sqlite").exists() || close_entry(&run.ledger().load().unwrap_or_default()).is_none() {
        return vec![];
    }
    if let Ok(mut b) = libs::LibsBackend::new(w.clone(), run.dir.join("treasury1.age")) {
        let _ = b.sync();
    }
    ll_core::walletdb::read_notes(&w.join("data.sqlite")).map(|n| chain_notes(&n)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(sending: CoinSending) -> Sealed {
        Sealed { tranches_zat: vec![10_000_000], pricing: "uniform".into(), drand_chain: QUICKNET_CHAIN_HASH.into(), drand_round: 1, claim_after: 500, coin_zat: COIN_ZAT, coin_cutoff: 10, coin_sending: sending, timing: Default::default(), open_payouts: false, long_tag: false, early_key: false, coin_margin: 0 }
    }

    #[test]
    fn coins_go_out_as_the_host_chose_and_always_near_the_cutoff() {
        let (cutoff, now) = (300, 10_000);
        // at once
        assert!(coins_due(&s(CoinSending::AtOnce), 1, 100, cutoff, now, now));
        // every 3 bids: not for 2, yes for 3
        assert!(!coins_due(&s(CoinSending::EveryBids { n: 3 }), 2, 100, cutoff, now, now));
        assert!(coins_due(&s(CoinSending::EveryBids { n: 3 }), 3, 100, cutoff, now, now));
        // every 10 minutes: not after 9, yes after 10
        assert!(!coins_due(&s(CoinSending::EveryMinutes { n: 10 }), 1, 100, cutoff, now - 540, now));
        assert!(coins_due(&s(CoinSending::EveryMinutes { n: 10 }), 1, 100, cutoff, now - 600, now));
        // within COIN_RUSH_BLOCKS of the cutoff: at once whatever the choice
        assert!(coins_due(&s(CoinSending::EveryBids { n: 100 }), 1, cutoff - COIN_RUSH_BLOCKS, cutoff, now, now));
        assert!(!coins_due(&s(CoinSending::EveryBids { n: 100 }), 1, cutoff - COIN_RUSH_BLOCKS - 1, cutoff, now, now));
        // at or after the cutoff a coin can no longer arrive in time; nothing waiting, nothing sent
        assert!(!coins_due(&s(CoinSending::AtOnce), 1, cutoff, cutoff, now, now));
        assert!(!coins_due(&s(CoinSending::AtOnce), 0, 100, cutoff, now, now));
    }

    #[test]
    fn the_close_log_says_no_winners_when_there_are_none() {
        assert_eq!(close_entry_line(6, 0, None), "close entry 6: no winners, every deposit goes back");
        assert_eq!(close_entry_line(6, 0, Some("0.1 TAZ".into())), "close entry 6: no winners, every deposit goes back");
        assert_eq!(close_entry_line(6, 2, Some("0.00012 TAZ".into())), "close entry 6: 2 winner(s), price 0.00012 TAZ");
        assert_eq!(close_entry_line(6, 2, None), "close entry 6: 2 winner(s), each pays their own bid");
    }

    #[test]
    fn send_to_my_wallet_sends_everything_minus_the_fee() {
        assert_eq!(treasury_payment(&[30_000]).unwrap(), (20_000, 10_000), "one note: two actions' fee");
        assert_eq!(treasury_payment(&[30_000, 30_000, 30_000]).unwrap(), (75_000, 15_000), "one action per note");
        assert!(treasury_payment(&[]).unwrap_err().to_string().contains("nothing to send"));
        assert!(treasury_payment(&[10_000]).unwrap_err().to_string().contains("network fee"));
    }

    #[test]
    fn the_coin_sending_choice_has_no_default() {
        assert_eq!(parse_coin_sending("at-once").unwrap(), CoinSending::AtOnce);
        assert_eq!(parse_coin_sending("every-bids:5").unwrap(), CoinSending::EveryBids { n: 5 });
        assert_eq!(parse_coin_sending("every-minutes:15").unwrap(), CoinSending::EveryMinutes { n: 15 });
        for bad in ["", "sometimes", "every-bids", "every-bids:x", "every-hours:2"] {
            assert!(parse_coin_sending(bad).is_err(), "{bad}");
        }
    }
}
