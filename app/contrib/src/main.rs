//! Contributor tool for testing: makes the per-contribution seed and memo payload, opens a
//! delivered ticket, broadcasts it (self-refund), and publishes a challenge to a reject.

use std::{fs, path::PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand};
use ll_core::{
    hex32,
    keys::ContributorKeys,
    ledger::{Entry, LedgerDir, blob_hash},
    payload::Payload,
    receiver::{TYPECODE_ORCHARD, orchard_receiver},
    recount::Challenge,
    rules::Rules,
};
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::{RawTransaction, compact_tx_streamer_client::CompactTxStreamerClient};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

#[derive(Parser)]
#[command(name = "cb-contrib", about = "Contributor tool: keys, memo payload, ticket, self-refund, challenge")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show the receivers inside a Unified Address and its standard (u1/utest1) form.
    AddressInfo { address: String },
    /// Make a new random seed for one contribution (keep it secret; it is the backup)
    Keygen {
        #[arg(long)]
        out: PathBuf,
    },
    /// Print the memo to send with the contribution
    Memo {
        #[arg(long)]
        rules: PathBuf,
        #[arg(long)]
        seed: PathBuf,
        /// Unified Address that refunds go to
        #[arg(long)]
        refund_address: String,
        /// The amount (zatoshis) you intend to pay: sealed into the message (format version 2); a smaller payment is not a
        /// contribution. Leave out for an old-format message (any amount counts; such a message can be copied).
        #[arg(long)]
        amount_zat: Option<u64>,
    },
    /// Decrypt your ticket (latest ledger entry for it) and check it against the ledger. Reads
    /// the ledger and sealed tickets from a relay (`--relay` and `--campaign`) or from local
    /// directories (`--ledger` and `--tickets`)
    OpenTicket {
        #[arg(long)]
        seed: PathBuf,
        #[arg(long)]
        ledger: Option<PathBuf>,
        /// Directory of sealed tickets (`<nullifier>.blob`)
        #[arg(long)]
        tickets: Option<PathBuf>,
        /// Relay base URL; repeat to read several relays
        #[arg(long)]
        relay: Vec<String>,
        /// Campaign id (`rules_id`, from the campaign link)
        #[arg(long)]
        campaign: Option<String>,
        /// Where this device keeps a copy of your entry and ticket, used when the relay is
        /// down or no longer shows your ticket
        #[arg(long)]
        cache: Option<PathBuf>,
        /// Your contribution, `<txid>:<action>`
        #[arg(long)]
        contribution: String,
        /// Where to write the raw transaction (hex)
        #[arg(long)]
        out: PathBuf,
    },
    /// Broadcast a ticket yourself (withdraw before the deadline, or self-refund after it)
    Broadcast {
        /// Raw transaction hex from `open-ticket`
        #[arg(long)]
        raw: PathBuf,
        #[arg(long, default_value = "https://testnet.zec.rocks:443")]
        server: String,
    },
    /// Dispute a reject: publish the one-time secret that sealed your memo
    Challenge {
        /// Uniform-price auction winner: also publish the incoming viewing key of the dedicated refund account, so the
        /// recount can verify the excess arrived (reveals that account's incoming activity)
        #[arg(long)]
        uivk: Option<String>,
        /// Uniform-price auction winner: report that the excess did not arrive (unverified without --uivk)
        #[arg(long)]
        complaint: bool,
        #[arg(long)]
        seed: PathBuf,
        /// Your contribution, `<txid>:<action>`
        #[arg(long)]
        contribution: String,
        #[arg(long)]
        out: PathBuf,
        /// Also publish it to these relays (needs --campaign)
        #[arg(long)]
        relay: Vec<String>,
        #[arg(long)]
        campaign: Option<String>,
    },
}

fn keys(seed: &PathBuf) -> Result<ContributorKeys> {
    ContributorKeys::from_hex(&fs::read_to_string(seed)?)
}

fn parse_contribution(s: &str) -> Result<(String, u32)> {
    let (txid, action) = s.split_once(':').context("expected <txid>:<action>")?;
    Ok((txid.to_lowercase(), action.parse()?))
}

/// What the contributor's device keeps after a successful fetch.
#[derive(serde::Serialize, serde::Deserialize)]
struct Saved {
    entry: Entry,
    blob_hex: String,
    saved_at: u64,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Where the ticket for a contribution can be found, with what the contributor should be told.
enum Found {
    Fresh(Entry, Vec<u8>),
    /// The relay could not help; this device's saved copy is used.
    Saved(Entry, Vec<u8>, u64),
}

/// Reads every relay. A ticket that matches a signed entry in an intact ledger is genuine even
/// when relays disagree; what a disagreement forbids is any conclusion about the host.
fn from_relays(urls: &[String], campaign: &str, txid: &str, action: u32) -> Result<(Entry, Vec<u8>), Failure> {
    use ll_relay::multi::{self, Judgement, State};
    let reads = multi::read_all(urls, campaign);
    for n in multi::excluded_notes(&reads) {
        println!("note: relay {n}");
    }
    match multi::judge(&reads) {
        Judgement::Disagree(lines) => {
            println!("RELAYS DISAGREE, CANNOT CONCLUDE why. This is not a sign that anyone did anything wrong:");
            for l in lines {
                println!("  - {l}");
            }
        }
        Judgement::Agree(_) => println!("{} relays show the same ledger", reads.iter().filter(|r| r.state == State::Ok).count()),
        _ => {}
    }
    let usable: Vec<&multi::RelayRead> = reads.iter().filter(|r| r.state == State::Ok).collect();
    if usable.is_empty() {
        if reads.iter().all(|r| matches!(r.state, State::Unreachable(_))) {
            return Err(Failure::RelayDown(reads.iter().filter_map(|r| if let State::Unreachable(m) = &r.state { Some(m.clone()) } else { None }).collect::<Vec<_>>().join("; ")));
        }
        return Err(Failure::Broken(multi::excluded_notes(&reads).join("; ")));
    }
    let mut total = 0;
    for r in &usable {
        total = total.max(r.entries.len());
        let Some(entry) = r
            .entries
            .iter()
            .rev()
            .find(|e| e.ticket.is_some() && e.contribution.as_ref().is_some_and(|c| c.txid == txid && c.action == action))
        else {
            continue;
        };
        let nf = entry.nf().unwrap_or_default().to_string();
        // The blob may be on this relay or another one; any copy that matches the signed hash will do.
        for u in urls {
            if let Ok(blob) = ll_relay::client::Relay::new(u).ticket(campaign, &nf) {
                if Some(blob_hash(&blob)) == entry.blob_hash {
                    return Ok((entry.clone(), blob));
                }
            }
        }
        return Err(Failure::NotInLedger("the ledger lists your ticket but no relay has the sealed ticket".to_string()));
    }
    Err(Failure::NotInLedger(format!("the relays' ledgers ({total} entries at most, signed and intact) have no ticket for {txid}:{action}")))
}

enum Failure {
    RelayDown(String),
    NotInLedger(String),
    Broken(String),
}

fn open_ticket(
    seed: &PathBuf,
    ledger: Option<&PathBuf>,
    tickets: Option<&PathBuf>,
    relay: &[String],
    campaign: Option<&str>,
    cache: Option<&PathBuf>,
    contribution: &str,
    out: &PathBuf,
) -> Result<()> {
    let (txid, action) = parse_contribution(contribution)?;
    let cache_file = cache.map(|c| c.join(format!("{txid}-{action}.json")));

    let found = match (relay.is_empty(), ledger) {
        (false, _) => {
            let campaign = campaign.context("--campaign (the campaign id from the link) is needed with --relay")?;
            match from_relays(relay, campaign, &txid, action) {
                Ok((entry, blob)) => {
                    println!("ticket found in a signed, intact ledger");
                    if let Some(f) = &cache_file {
                        fs::create_dir_all(f.parent().unwrap())?;
                        fs::write(f, serde_json::to_vec_pretty(&Saved { entry: entry.clone(), blob_hex: hex::encode(&blob), saved_at: now() })?)?;
                        println!("saved a copy on this device: {}", f.display());
                    }
                    Found::Fresh(entry, blob)
                }
                Err(fail) => {
                    let (headline, advice, code) = match &fail {
                        Failure::RelayDown(m) => (
                            format!("RELAY UNREACHABLE: {m}"),
                            "Your ticket is not affected: it stays valid on chain whatever any relay does.",
                            4,
                        ),
                        Failure::NotInLedger(m) => (
                            format!("TICKET NOT SHOWN BY THE RELAY: {m}"),
                            "The relay may have dropped it (or the host has not published it yet). The recount will flag a contribution with no ticket once K blocks have passed. Compare with another relay; your saved copy, if you have one, still works.",
                            3,
                        ),
                        Failure::Broken(m) => (
                            format!("LEDGER NOT TRUSTWORTHY: {m}"),
                            "Do not rely on this relay. Try another one; your saved copy, if you have one, still works.",
                            5,
                        ),
                    };
                    println!("{headline}");
                    println!("{advice}");
                    match cache_file.as_ref().filter(|f| f.exists()) {
                        Some(f) => {
                            let saved: Saved = serde_json::from_slice(&fs::read(f)?)?;
                            Found::Saved(saved.entry, hex::decode(&saved.blob_hex)?, saved.saved_at)
                        }
                        None => {
                            println!("No saved copy of this ticket on this device either.");
                            std::process::exit(code);
                        }
                    }
                }
            }
        }
        (true, Some(ledger)) => {
            let tickets = tickets.context("--tickets is needed with --ledger")?;
            let entries = LedgerDir(ledger).load()?;
            let entry = entries
                .iter()
                .rev()
                .find(|e| e.ticket.is_some() && e.contribution.as_ref().is_some_and(|c| c.txid == txid && c.action == action))
                .context("no ticket for this contribution in the ledger")?
                .clone();
            let blob = fs::read(tickets.join(format!("{}.blob", entry.nf().unwrap_or_default())))?;
            Found::Fresh(entry, blob)
        }
        (true, None) => bail!("give --relay and --campaign, or --ledger and --tickets"),
    };

    let (entry, blob, note) = match found {
        Found::Fresh(e, b) => (e, b, None),
        Found::Saved(e, b, at) => (e, b, Some(at)),
    };
    let ticket = entry.ticket.as_ref().expect("ticket");
    if Some(blob_hash(&blob)) != entry.blob_hash {
        bail!("ticket blob does not match the ledger entry's blob_hash");
    }
    let plain = keys(seed)?.encryption_key().unseal(&blob).map_err(|_| anyhow!("ticket does not open with this seed"))?;
    // sealed format version 1 (the transaction only) or 2 (the transaction plus the refund output's opening values, SPEC §3)
    let (version, raw, _opening) = ll_core::ticket_blob::decode(&plain).context("the ticket is damaged")?;
    let branch = BranchId::try_from(u32::from_str_radix(&ticket.branch_id, 16)?).map_err(|e| anyhow!("{e}"))?;
    let tx = Transaction::read(&raw[..], branch).context("not a transaction")?;
    if tx.txid().to_string() != ticket.txid {
        bail!("ticket txid {} differs from the ledger's {}", tx.txid(), ticket.txid);
    }
    fs::write(out, hex::encode(&raw))?;
    if let Some(at) = note {
        println!("USING THE COPY SAVED ON THIS DEVICE (saved {} s ago); it still opens and matches its signed ledger entry", now().saturating_sub(at));
    }
    println!("ticket OK: txid {} matches ledger entry {} ({}), expiry {}, sealed format version {version}", ticket.txid, entry.seq, entry.kind, tx.expiry_height());
    println!("raw transaction written to {}", out.display());
    Ok(())
}

fn broadcast(raw: &PathBuf, server: &str) -> Result<()> {
    let data = hex::decode(fs::read_to_string(raw)?.trim())?;
    let host = server.trim_start_matches("https://").split(':').next().unwrap_or_default().to_string();
    let rt = tokio::runtime::Runtime::new()?;
    let resp = rt.block_on(async {
        let channel = Channel::from_shared(server.to_string())?
            .tls_config(ClientTlsConfig::new().domain_name(host).assume_http2(true).with_webpki_roots())?
            .connect()
            .await?;
        let resp = CompactTxStreamerClient::new(channel)
            .send_transaction(RawTransaction { data, height: 0 })
            .await?
            .into_inner();
        Ok::<_, anyhow::Error>(resp)
    })?;
    if resp.error_code != 0 {
        bail!("rejected ({}): {}", resp.error_code, resp.error_message);
    }
    println!("broadcast accepted: {}", resp.error_message.trim_matches('"'));
    Ok(())
}

fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    match Cli::parse().command {
        Cmd::AddressInfo { address } => {
            for line in ll_core::receiver::describe(&address)? { println!("{line}"); }
            println!("standard form: {}", ll_core::receiver::to_standard(&address)?);
            let (net, raw) = ll_core::receiver::orchard_receiver(&address)?;
            println!("orchard-only standard form: {}", ll_core::receiver::encode_orchard(net, raw)?);
        }
        Cmd::Keygen { out } => {
            if out.exists() {
                bail!("{} exists; not overwriting a seed", out.display());
            }
            fs::write(&out, hex::encode(ContributorKeys::generate().seed))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&out, fs::Permissions::from_mode(0o600))?;
            }
            println!("seed written to {}", out.display());
        }
        Cmd::Memo { rules, seed, refund_address, amount_zat } => {
            let rules: Rules = serde_json::from_slice(&fs::read(rules)?)?;
            let k = keys(&seed)?;
            let (_, receiver) = orchard_receiver(&refund_address)?;
            let payload = Payload {
                rules_id: rules.id()?,
                sign_pubkey: k.signing_key().verifying_key().to_bytes(),
                enc_pubkey: *k.encryption_key().public_key().as_bytes(),
                refund_typecode: TYPECODE_ORCHARD,
                refund_receiver: receiver,
                amount_zat,
            };
            println!("{}", payload.to_memo(&hex32(&rules.payload_pubkey)?, &k.memo_ephemeral_key())?);
        }
        Cmd::OpenTicket { seed, ledger, tickets, relay, campaign, cache, contribution, out } => {
            open_ticket(&seed, ledger.as_ref(), tickets.as_ref(), &relay, campaign.as_deref(), cache.as_ref(), &contribution, &out)?
        }
        Cmd::Broadcast { raw, server } => broadcast(&raw, &server)?,
        Cmd::Challenge { uivk, complaint, seed, contribution, out, relay, campaign } => {
            let (txid, action) = parse_contribution(&contribution)?;
            let c = Challenge { txid, action, eph_sk: hex::encode(keys(&seed)?.memo_ephemeral_key().to_bytes()), uivk, complaint };
            fs::write(&out, serde_json::to_vec_pretty(&c)?)?;
            println!("challenge written to {} (publishing it reveals this contribution's refund address)", out.display());
            for url in &relay {
                let id = campaign.as_deref().context("--campaign is needed with --relay")?;
                match ll_relay::client::Relay::new(url).put_challenge(id, &c) {
                    Ok(()) => println!("published to {url}"),
                    Err(e) => println!("could not publish to {url}: {e}"),
                }
            }
        }
    }
    Ok(())
}
