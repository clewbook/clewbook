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
    /// Sealed bid auction: print the memo of a bid (version 3): the refund details sealed for the host, with the tranche; the bid
    /// locked to the auction's drand round; and this page's public key (derived from the seed), which the host's coin will pay
    BidMemo {
        #[arg(long)]
        rules: PathBuf,
        #[arg(long)]
        seed: PathBuf,
        /// Unified Address that refunds go to
        #[arg(long)]
        refund_address: String,
        /// The tranche you will pay, in zatoshis (one of the auction's tranches)
        #[arg(long)]
        tranche_zat: u64,
        /// Your bid in zatoshis: at most the tranche minus the refund fee
        #[arg(long)]
        bid_zat: u64,
        /// TEST ONLY: lock a bid above the tranche minus the fee, which the rules do not allow, to check that it does not count
        #[arg(long, hide = true)]
        test_over_tranche: bool,
    },
    /// Sealed bid auction: fetch your late ticket from a relay once the host has sent your page's coin, check it completely against the
    /// chain (your coin, the anchor, the refund output, the signatures, the proof), sign your coin input, and write the finished
    /// transaction. Keep it: from the block after the late ticket block, anyone can send it to give you your deposit back
    LateTicket {
        #[arg(long)]
        seed: PathBuf,
        #[arg(long)]
        relay: String,
        #[arg(long)]
        campaign: String,
        /// Your deposit, `<txid>:<action>`
        #[arg(long)]
        contribution: String,
        /// What you paid, in zatoshis
        #[arg(long)]
        paid_zat: u64,
        /// The refund address you gave
        #[arg(long)]
        refund_address: String,
        /// A light wallet server, to check your coin and the ticket's anchor on the chain (http:// only for this machine)
        #[arg(long, default_value = "https://testnet.zec.rocks:443")]
        server: String,
        #[arg(long)]
        out: PathBuf,
    },
    /// Print a transaction of the chain in readable form (read only): version, network version, lock and expiry, transparent outputs with
    /// their addresses and values, the shielded parts and the fee when it has no transparent inputs
    TxReadable {
        #[arg(long)]
        txid: String,
        #[arg(long, default_value = "https://testnet.zec.rocks:443")]
        server: String,
        /// "test" or "main", for the address encoding
        #[arg(long, default_value = "test")]
        network: String,
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
        /// Blind bid auction with open payouts: the rejected payment's memo, which the relays check the secret opens
        #[arg(long)]
        memo: Option<String>,
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

/// A light wallet server connection: TLS, except plain http to this machine (a private test chain).
async fn connect(server: &str) -> Result<CompactTxStreamerClient<Channel>> {
    let mut endpoint = Channel::from_shared(server.to_string())?;
    let local = ["http://127.0.0.1:", "http://localhost:"].iter().any(|p| server.starts_with(p));
    if !local {
        let host = server.trim_start_matches("https://").split(':').next().unwrap_or_default().to_string();
        endpoint = endpoint.tls_config(ClientTlsConfig::new().domain_name(host).assume_http2(true).with_webpki_roots())?;
    }
    Ok(CompactTxStreamerClient::new(endpoint.connect().await?))
}

#[allow(clippy::too_many_arguments)]
fn late_ticket(seed: &PathBuf, relay: &str, campaign: &str, contribution: &str, paid_zat: u64, refund_address: &str, server: &str, out: &PathBuf) -> Result<()> {
    use zcash_client_backend::proto::service::{BlockId, TxFilter};
    let k = keys(seed)?;
    let (txid, action) = parse_contribution(contribution)?;
    let r = ll_relay::client::Relay::new(relay);
    let rules = r.rules(campaign)?;
    anyhow::ensure!(hex::encode(rules.id()?) == campaign.to_lowercase(), "the relay's rules are not this campaign's");
    let s = rules.sealed.clone().context("not a blind bid auction")?;
    let entries = r.ledger(campaign, 0)?;
    let broken = ll_core::ledger::check_chain(&entries, &ll_core::ledger::verifying_key(&rules.ledger_pubkey)?, campaign);
    anyhow::ensure!(broken.is_empty(), "the relay's list is not intact: {}", broken.join("; "));
    let issue = entries.iter().find(|e| e.kind == "issue" && e.contribution.as_ref().is_some_and(|c| c.txid == txid && c.action == action)).context("your deposit has no issue entry")?;
    let nf = issue.nf().context("nf")?.to_string();
    let coin_entry = entries.iter().find(|e| e.coin.as_ref().is_some_and(|c| c.nf == nf)).context("the host has not sent your page's coin yet")?;
    let coin = coin_entry.coin.clone().context("coin")?;
    let late_id = coin_entry.late.clone().context("the coin entry names no late ticket")?;
    let blob = r.blob(campaign, coin_entry.blob_hash.as_deref().context("no blob")?).map_err(|e| anyhow!("{e}"))?;
    anyhow::ensure!(blob_hash(&blob) == *coin_entry.blob_hash.as_ref().unwrap(), "the relay's blob does not match the entry");
    let plain = k.encryption_key().unseal(&blob).map_err(|_| anyhow!("the late ticket does not open with your key"))?;
    let part = ll_core::ticket_blob::LatePart::decode(&plain)?;
    let sk = secp256k1::SecretKey::from_secret_bytes(k.page_secret()).map_err(|_| anyhow!("bad page key"))?;
    let page_key = secp256k1::PublicKey::from_secret_key(&sk).serialize();
    let (_, receiver) = orchard_receiver(refund_address)?;
    let e = ll_ticketcheck::late::LateExpect {
        deposit_nf: hex32(&nf)?,
        coin_txid: coin.txid.clone(),
        coin_index: coin.index,
        coin_value_zat: coin.value_zat,
        page_key,
        lock_time: s.claim_after,
        refund_receiver: receiver,
        refund_zat: paid_zat - rules.refund_fee_zat,
        deposit_zat: paid_zat,
        current_branch: None, // asked below, from the same server
    };
    // the chain: the coin pays this page's address enough, mined by the cutoff; the anchor is the note tree root at the stated height
    let rt = tokio::runtime::Runtime::new()?;
    let coin_tx = rt.block_on(async {
        let mut c = connect(server).await?;
        let mut h = hex32(&coin.txid)?.to_vec();
        h.reverse();
        let raw = c.get_transaction(TxFilter { hash: h, ..Default::default() }).await?.into_inner();
        let ts = c.get_tree_state(BlockId { height: u64::from(part.anchor_height), hash: vec![] }).await?.into_inner();
        let root = ts.ironwood_tree()?.root().to_bytes();
        let info = c.get_lightd_info(zcash_client_backend::proto::service::Empty {}).await?.into_inner();
        Ok::<_, anyhow::Error>((raw, root, u32::from_str_radix(&info.consensus_branch_id, 16).ok()))
    })?;
    let (coin_tx, root, branch_now) = (coin_tx.0, coin_tx.1, coin_tx.2);
    let e = ll_ticketcheck::late::LateExpect { current_branch: branch_now, ..e };
    let ctx = Transaction::read(&coin_tx.data[..], BranchId::Nu7).or_else(|_| Transaction::read(&coin_tx.data[..], BranchId::Nu6_3))?;
    let script = hex::decode(ll_core::sealed_recount::p2pkh_script_hex(&page_key))?;
    let out_ok = ctx.transparent_bundle().and_then(|b| b.vout.get(coin.index as usize)).is_some_and(|o| {
        let mut w = vec![];
        o.write(&mut w).is_ok() && w.get(9..) == Some(&script[..]) && o.value().into_u64() == coin.value_zat
    });
    anyhow::ensure!(out_ok, "the coin output does not pay this page's address the stated amount");
    let cutoff = s.cutoff_height(rules.deadline_height);
    anyhow::ensure!(coin_tx.height > 0 && coin_tx.height <= u64::from(cutoff), "the coin is not mined by the cutoff (block {cutoff}); take your deposit back with your early ticket");
    let branch = BranchId::Nu7;
    let (id, anchor) = ll_ticketcheck::late::check(&part.raw, branch, &part.ovk, &e).map_err(|m| anyhow!("{m}"))?;
    anyhow::ensure!(id == late_id, "the late ticket is not the one the list names ({id} against {late_id})");
    anyhow::ensure!(anchor == root, "the late ticket's anchor is not the chain's note tree root at block {}", part.anchor_height);
    let version = zcash_primitives::transaction::components::orchard::bundle_version_for_branch(branch, orchard::ValuePool::Orchard).context("circuit version")?;
    let vk = orchard::circuit::VerifyingKey::build(version.circuit_version());
    ll_ticketcheck::late::verify_proof(&part.raw, branch, &vk).map_err(|m| anyhow!("{m}"))?;
    let signed = ll_ticketcheck::late::sign(&part.raw, branch, &e, &k.page_secret()).map_err(|m| anyhow!("{m}"))?;
    fs::write(out, hex::encode(&signed))?;
    println!("late ticket OK: {id} spends your deposit and your coin, pays back {}, valid after block {}; signed and written to {}", e.refund_zat, s.claim_after, out.display());
    Ok(())
}

fn tx_readable(txid: &str, server: &str, network: &str) -> Result<()> {
    use zcash_address::{ToAddress, ZcashAddress};
    use zcash_client_backend::proto::service::TxFilter;
    let net = ll_core::receiver::network_type(network)?;
    let mut h = hex32(txid)?.to_vec();
    h.reverse();
    let rt = tokio::runtime::Runtime::new()?;
    let raw = rt.block_on(async { Ok::<_, anyhow::Error>(connect(server).await?.get_transaction(TxFilter { hash: h, ..Default::default() }).await?.into_inner()) })?;
    let tx = Transaction::read(&raw.data[..], BranchId::Nu7).or_else(|_| Transaction::read(&raw.data[..], BranchId::Nu6_3))?;
    println!("transaction   {}", tx.txid());
    println!("mined in      {}", if raw.height > 0 && raw.height < u64::from(u32::MAX) { format!("block {}", raw.height) } else { "not mined yet".into() });
    println!("size          {} bytes", raw.data.len());
    println!("version       {:?}, network version (consensus branch id) {:08x}", tx.version(), u32::from(tx.consensus_branch_id()));
    println!("lock time     {}, expiry height {}", tx.lock_time(), u32::from(tx.expiry_height()));
    let (mut t_out, t_in) = (0u64, tx.transparent_bundle().map_or(0, |b| b.vin.len()));
    println!("transparent   {t_in} input(s)");
    for (i, o) in tx.transparent_bundle().map(|b| b.vout.clone()).unwrap_or_default().iter().enumerate() {
        let mut w = vec![];
        o.write(&mut w)?;
        let script = w.get(9..).unwrap_or_default();
        let addr = if script.len() == 25 && script[..3] == [0x76, 0xa9, 0x14] && script[23..] == [0x88, 0xac] {
            ZcashAddress::from_transparent_p2pkh(net, script[3..23].try_into()?).encode()
        } else {
            format!("script {}", hex::encode(script))
        };
        t_out += o.value().into_u64();
        println!("  output {i}    {} zatoshis to {addr}", o.value().into_u64());
    }
    let iw = tx.ironwood_bundle().map(|b| (b.actions().len(), i64::from(*b.value_balance())));
    println!("Ironwood      {}", iw.map_or("none".into(), |(n, v)| format!("{n} action(s), amounts hidden, value leaving the pool {v} zatoshis")));
    println!("Orchard       {}", if tx.orchard_bundle().is_some() { "present" } else { "none" });
    println!("Sapling       {}", if tx.sapling_bundle().is_some() { "present" } else { "none" });
    if t_in == 0 {
        if let Some((_, v)) = iw {
            println!("fee           {} zatoshis", v - t_out as i64);
        }
    }
    Ok(())
}

fn broadcast(raw: &PathBuf, server: &str) -> Result<()> {
    let data = hex::decode(fs::read_to_string(raw)?.trim())?;
    let rt = tokio::runtime::Runtime::new()?;
    let resp = rt.block_on(async {
        let resp = connect(server)
            .await?
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
        Cmd::BidMemo { rules, seed, refund_address, tranche_zat, bid_zat, test_over_tranche } => {
            let rules: Rules = serde_json::from_slice(&fs::read(rules)?)?;
            let s = rules.sealed.as_ref().context("these rules are not a blind bid auction")?;
            anyhow::ensure!(s.tranches_zat.contains(&tranche_zat), "the tranche must be one of {:?}", s.tranches_zat);
            anyhow::ensure!(test_over_tranche || bid_zat + rules.refund_fee_zat <= tranche_zat, "the bid must be at most the tranche minus the refund fee");
            if test_over_tranche {
                eprintln!("TEST ONLY: this bid may be above its tranche minus the fee; it will not count.");
            }
            let k = keys(&seed)?;
            let (_, receiver) = orchard_receiver(&refund_address)?;
            let rid = rules.id()?;
            let payload = Payload {
                rules_id: rid,
                sign_pubkey: k.signing_key().verifying_key().to_bytes(),
                enc_pubkey: *k.encryption_key().public_key().as_bytes(),
                refund_typecode: TYPECODE_ORCHARD,
                refund_receiver: receiver,
                amount_zat: Some(tranche_zat),
            };
            let sealed = ll_core::payload::sealed_bytes(&payload.to_memo(&hex32(&rules.payload_pubkey)?, &k.memo_ephemeral_key())?).context("sealed part")?;
            let sk = secp256k1::SecretKey::from_secret_bytes(k.page_secret()).map_err(|_| anyhow::anyhow!("this seed gives no page key; make a new seed"))?;
            let page_key = secp256k1::PublicKey::from_secret_key(&sk).serialize();
            let memo = if s.long_tag {
                let (lock, bound) = ll_core::bid::lock_bid_bound(bid_zat, &rid, &sealed, &page_key, tranche_zat, s.drand_round)?;
                ll_core::bid::BidMemo { sealed, lock, page_key, bound: Some(bound) }
            } else {
                let tag = ll_core::bid::tag(&rid, &sealed, &page_key, tranche_zat);
                ll_core::bid::BidMemo { sealed, lock: ll_core::bid::lock_bid(bid_zat, &tag, s.drand_round)?, page_key, bound: None }
            };
            println!("{}", memo.to_text());
        }
        Cmd::OpenTicket { seed, ledger, tickets, relay, campaign, cache, contribution, out } => {
            open_ticket(&seed, ledger.as_ref(), tickets.as_ref(), &relay, campaign.as_deref(), cache.as_ref(), &contribution, &out)?
        }
        Cmd::TxReadable { txid, server, network } => tx_readable(&txid, &server, &network)?,
        Cmd::Broadcast { raw, server } => broadcast(&raw, &server)?,
        Cmd::LateTicket { seed, relay, campaign, contribution, paid_zat, refund_address, server, out } => {
            late_ticket(&seed, &relay, &campaign, &contribution, paid_zat, &refund_address, &server, &out)?
        }
        Cmd::Challenge { uivk, complaint, memo, seed, contribution, out, relay, campaign } => {
            let (txid, action) = parse_contribution(&contribution)?;
            let c = Challenge { txid, action, eph_sk: hex::encode(keys(&seed)?.memo_ephemeral_key().to_bytes()), uivk, complaint, memo };
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
