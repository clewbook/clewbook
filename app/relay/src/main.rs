//! `ll-relay serve`: run a relay locally with one command.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "cb-relay", about = "Relay: stores and serves the signed ledger and the sealed tickets")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Start the relay (stop it with Ctrl-C)
    Serve {
        /// Where entries and sealed tickets are stored
        #[arg(long, default_value = "relay-data")]
        dir: PathBuf,
        #[arg(long, default_value = "127.0.0.1:8787")]
        listen: String,
        /// How many campaigns may be registered on this relay
        #[arg(long, default_value_t = ll_relay::Limits::default().max_campaigns)]
        max_campaigns: usize,
        /// How many entries one campaign's list may hold
        #[arg(long, default_value_t = ll_relay::Limits::default().max_entries)]
        max_entries: u64,
        /// The largest request body, in bytes
        #[arg(long, default_value_t = ll_relay::Limits::default().max_body)]
        max_body: usize,
        /// Take rules for a private regtest chain (test harnesses only; a public relay never needs this)
        #[arg(long)]
        allow_regtest: bool,
        /// The bytes one campaign may store
        #[arg(long, default_value_t = ll_relay::Limits::default().max_campaign_bytes)]
        max_campaign_bytes: u64,
        /// The bytes this relay stores in all
        #[arg(long, default_value_t = ll_relay::Limits::default().max_total_bytes)]
        max_total_bytes: u64,
        /// How many requests are handled at the same time (more get "busy")
        #[arg(long, default_value_t = ll_relay::Limits::default().max_concurrent)]
        max_concurrent: usize,
        /// Requests per minute from one source address (0 = no limit)
        #[arg(long, default_value_t = ll_relay::Limits::default().per_source_per_minute)]
        per_source_per_minute: u32,
    },
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Cmd::Serve { dir, listen, max_campaigns, max_entries, max_body, max_concurrent, per_source_per_minute, allow_regtest, max_campaign_bytes, max_total_bytes } => {
            let limits = ll_relay::Limits { max_campaigns, max_entries, max_body, max_concurrent, per_source_per_minute, test_now: None, allow_regtest, max_campaign_bytes, max_total_bytes };
            let (_server, url) = ll_relay::spawn_with(&dir, &listen, limits.clone())?;
            println!("limits: {} campaigns, {} entries each, bodies up to {} bytes, {} requests at once, {} per minute per source, {} MB per campaign, {} MB in all{}", limits.max_campaigns, limits.max_entries, limits.max_body, limits.max_concurrent, limits.per_source_per_minute, limits.max_campaign_bytes / (1024 * 1024), limits.max_total_bytes / (1024 * 1024), if limits.allow_regtest { ", regtest rules taken" } else { "" });
            println!("relay listening on {url} (data in {})", dir.display());
            println!("read: anyone; write: only entries signed by the campaign. Ctrl-C to stop.");
            loop {
                std::thread::park();
            }
        }
    }
}
