//! Recount: checks R1 to R8 (plus R9 to R12 for a uniform-price auction) using only public data (rules, ledger) and a view-only wallet
//! that scanned the chain with the campaign's full viewing key.

use std::{fs, path::PathBuf, process::ExitCode};

use anyhow::{Context, Result, bail};
use clap::Parser;
use ll_relay::multi;
use ll_core::{
    ledger::LedgerDir,
    receiver::same_ufvk,
    recount::{Challenge, close_entry, recount, render},
    rules::Rules,
    walletdb,
};

#[derive(Parser)]
#[command(name = "cb-recount", about = "Recount a campaign: R1 to R8, plus R9 to R12 for a uniform-price auction; PASS or FAIL")]
struct Cli {
    /// Rules JSON file; with --relay it can be omitted (fetched, and checked against --rules-id)
    #[arg(long)]
    rules: Option<PathBuf>,
    /// The rules_id published at creation
    #[arg(long)]
    rules_id: String,
    #[arg(long)]
    ledger: Option<PathBuf>,
    /// Read the rules, ledger and challenges from this relay instead of local files. Repeat
    /// to read several relays: if they do not show the same ledger there is no verdict.
    #[arg(long)]
    relay: Vec<String>,
    /// View-only wallet directory, synced and enhanced (full transactions). For an auction it
    /// is created from the UFVK revealed at close; before that, omit it.
    #[arg(long)]
    wallet: Option<PathBuf>,
    /// Directory of published challenges (`*.json`)
    #[arg(long)]
    challenges: Option<PathBuf>,
}


enum Outcome {
    Verdict(bool),
    CannotConclude,
}

fn run(cli: Cli) -> Result<Outcome> {
    let mut single_relay_note: Option<String> = None;
    let mut relay_challenges: Vec<Challenge> = vec![];
    let (rules, ledger): (Rules, _) = if cli.relay.is_empty() {
        (
            serde_json::from_slice(&fs::read(cli.rules.as_ref().context("--rules or --relay is needed")?)?)?,
            LedgerDir(cli.ledger.as_ref().context("--ledger or --relay is needed")?).load()?,
        )
    } else {
        // A relay can be down, behind or dishonest; that says nothing about the host. So an
        // unreadable, damaged or disagreeing set of relays gives NO verdict, never a "guilty".
        let id = cli.rules_id.to_lowercase();
        let reads = multi::read_all(&cli.relay, &id);
        relay_challenges = multi::merged_challenges(&reads);
        for n in multi::excluded_notes(&reads) {
            println!("note: relay {n}");
        }
        match multi::judge(&reads) {
            multi::Judgement::Agree(r) => {
                println!("ledger read from {} relays, identical: {} entries", reads.iter().filter(|r| r.state == multi::State::Ok).count(), r.entries.len());
                (r.rules.clone().context("relay sent no rules")?, r.entries.clone())
            }
            multi::Judgement::Single(r) => {
                println!("ledger read from relay {}: {} entries", r.url, r.entries.len());
                single_relay_note = Some(if cli.relay.len() > 1 {
                    "only one of the relays gave a usable ledger".to_string()
                } else {
                    "only one relay was asked".to_string()
                });
                (r.rules.clone().context("relay sent no rules")?, r.entries.clone())
            }
            multi::Judgement::Disagree(lines) => {
                println!("RELAYS DISAGREE: the relays do not show the same ledger.");
                for l in lines {
                    println!("  - {l}");
                }
                println!("This says nothing about the host: a relay can be behind, down or dishonest.");
                println!("Ask the host for its own copy, or try other relays, and run this again.");
                println!("RESULT: CANNOT CONCLUDE");
                return Ok(Outcome::CannotConclude);
            }
            multi::Judgement::NoUsableLedger(lines) => {
                println!("NO USABLE LEDGER: no relay could give an intact, signed ledger.");
                for l in lines {
                    println!("  - {l}");
                }
                println!("A relay that drops or damages entries can make anyone look guilty, so no verdict is given.");
                println!("RESULT: CANNOT CONCLUDE");
                return Ok(Outcome::CannotConclude);
            }
        }
    };
    let mut challenges: Vec<Challenge> = relay_challenges;
    if let Some(dir) = &cli.challenges {
        for p in fs::read_dir(dir)?.filter_map(|e| e.ok().map(|e| e.path())) {
            if p.extension().is_some_and(|x| x == "json") {
                challenges.push(serde_json::from_slice(&fs::read(&p)?).with_context(|| p.display().to_string())?);
            }
        }
    }
    // The key the wallet must hold: raise, from the rules; auction, the one revealed at close.
    let expected_key = if rules.is_auction() {
        close_entry(&ledger).and_then(|c| c.ufvk.clone())
    } else {
        rules.campaign_ufvk.clone()
    };
    let (notes, tip, visible) = match (&cli.wallet, &expected_key) {
        (Some(w), Some(key)) => {
            let db = w.join("data.sqlite");
            let ufvk = walletdb::account_ufvk(&db)?.context("wallet has no account")?;
            if !same_ufvk(&ufvk, key)? {
                bail!("the wallet does not hold the campaign's viewing key; it would see the wrong notes");
            }
            let tip = walletdb::scanned_height(&db)?.context("wallet has not scanned")?;
            (walletdb::read_notes(&db)?.into_iter().map(|w| w.note).collect(), tip, true)
        }
        (None, None) => (vec![], 0, false),
        (None, Some(_)) => bail!("the viewing key is available: pass --wallet with a view-only wallet for it"),
        (Some(_), None) => bail!("the auction has not revealed its viewing key yet; omit --wallet"),
    };
    let report = recount(&rules, &cli.rules_id, &ledger, &notes, &challenges, tip, visible);

    let _ = visible;
    print!("{}", render(&report, &rules));
    if !report.all_pass() {
        if let Some(note) = &single_relay_note {
            println!("NOTE: this FAIL comes from a ledger read from a single relay ({note}). A relay that drops entries can");
            println!("cause failures like this one; it does not show that the host did anything wrong. Check another relay.");
        }
    }
    Ok(Outcome::Verdict(report.all_pass()))
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(Outcome::Verdict(true)) => ExitCode::SUCCESS,
        Ok(Outcome::Verdict(false)) => ExitCode::from(1),
        Ok(Outcome::CannotConclude) => ExitCode::from(4),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}
