//! Shared test values for other implementations (the web app uses libsodium.js).
//!
//! `ll-vectors generate`   writes vectors.json from fixed inputs.
//! `ll-vectors verify-js F` opens what libsodium.js produced in F (the other direction).

use std::{env, fs};

use anyhow::{Context, Result, bail, ensure};
use crypto_box::SecretKey;
use ll_core::{
    canon::to_canonical,
    hash, hex32,
    keys::{CampaignSecrets, ContributorKeys},
    ledger::{Contribution, Entry, Ticket, amount_commit, blob_hash},
    payload::{Payload, sealed_bytes},
    rules::{Rules, ufvk_hash},
};
use rand_core::OsRng;
use serde_json::{Value, json};

fn fixed() -> (ContributorKeys, CampaignSecrets, Rules) {
    let contributor = ContributorKeys { seed: core::array::from_fn(|i| i as u8) };
    let campaign = CampaignSecrets { ledger_sk: hex::encode([0x11u8; 32]), payload_sk: hex::encode([0x22u8; 32]), amount_key: None };
    let rules = Rules {
        v: 1, network: "test".into(), mode: "raise".into(), goal_zat: Some(5_000_000), items: None,
        start_height: 4_467_207, deadline_height: 4_467_266, ticket_k: 10, close_grace: 10, reissue_window: 20,
        refund_fee_zat: 10_000, min_contribution_zat: 20_000, campaign_ufvk: Some("uvftest1example".into()), ufvk_hash: None,
        pay_to: None, pricing: None, settle_window: None, reserve_zat: None, treasury_address: None, treasury_ufvk: None,
        name: None,
        ledger_pubkey: campaign.ledger_pubkey_hex().unwrap(), payload_pubkey: campaign.payload_pubkey_hex().unwrap(),
    };
    (contributor, campaign, rules)
}

fn generate() -> Result<Value> {
    let (c, k, rules) = fixed();
    let rules_id = rules.id()?;
    let payload = Payload {
        rules_id, sign_pubkey: c.signing_key().verifying_key().to_bytes(),
        enc_pubkey: *c.encryption_key().public_key().as_bytes(), refund_typecode: 3, refund_receiver: [0x33; 43], amount_zat: None,
    };
    let memo = payload.to_memo(&hex32(&rules.payload_pubkey)?, &c.memo_ephemeral_key())?;
    // payload version 2: the same payload with the intended amount sealed in (SPEC §2)
    let payload2 = Payload { amount_zat: Some(1_000_000), ..payload.clone() };
    let memo2 = payload2.to_memo(&hex32(&rules.payload_pubkey)?, &c.memo_ephemeral_key())?;

    let raw_tx: Vec<u8> = (0..200u32).map(|i| (i * 7 % 256) as u8).collect();
    let blob = crypto_box::PublicKey::from(payload.enc_pubkey).seal(&mut OsRng, &raw_tx).map_err(|e| anyhow::anyhow!("{e}"))?;

    // sealed ticket format version 2 (SPEC §3.1): raw transaction plus the refund output's opening values
    let opening = ll_core::ticket_blob::Opening { action: 1, value_zat: 990_000, rseed: [0x11; 32] };
    let v2_plain = ll_core::ticket_blob::encode_v2(&raw_tx, &opening);
    let v2_blob = crypto_box::PublicKey::from(payload.enc_pubkey).seal(&mut OsRng, &v2_plain).map_err(|e| anyhow::anyhow!("{e}"))?;

    let mut entry = Entry::new(&hex::encode(rules_id), "issue");
    entry.prev = ll_core::ledger::GENESIS_PREV.into();
    entry.contribution = Some(Contribution {
        txid: "9a1b522941a69000e841b636d838580db35e8b880d8d735801520a562cbb48f1".into(), action: 0,
        nf: "93a36f6ea688190a43f006843ba382b57519f7f7c9e92d0a660939392dd44a31".into(), height: 4_467_208,
        value_zat: Some(1_000_000), amount_commit: None,
    });
    entry.ticket = Some(Ticket { txid: "c5423510a2e208b8c89064313e4fdf86524d52ae6e5fe9e02b61e4fdf30925b3".into(), issue_height: 4_467_209, branch_id: "77190ad9".into() });
    entry.blob_hash = Some(blob_hash(&blob));
    let unsigned = to_canonical(&entry)?;
    entry.sign(&k.ledger_key()?)?;

    let amount_key = [0x44u8; 32];
    let nf = "93a36f6ea688190a43f006843ba382b57519f7f7c9e92d0a660939392dd44a31";
    Ok(json!({
        "ticket_v2": { "opening": { "action": opening.action, "value_zat": opening.value_zat, "rseed": hex::encode(opening.rseed) },
            "plaintext": hex::encode(&v2_plain), "blob": hex::encode(&v2_blob) },
        "about": "Shared test values; every other implementation must reproduce them exactly. See SPEC.md.",
        "blake2b_personal": "BLAKE2b-256, no key, salt 16 zero bytes, personalization = ASCII label zero-padded to 16 bytes",
        "contributor": {
            "seed": hex::encode(c.seed),
            "sign_seed": hex::encode(hash(b"ledgerlab_sign", &c.seed)),
            "sign_pk": hex::encode(payload.sign_pubkey),
            "enc_sk": hex::encode(c.encryption_key().to_bytes()),
            "enc_pk": hex::encode(payload.enc_pubkey),
            "eph_sk": hex::encode(c.memo_ephemeral_key().to_bytes()),
            "eph_pk": hex::encode(c.memo_ephemeral_key().public_key().as_bytes()),
        },
        "campaign": {
            "payload_sk": k.payload_sk, "payload_pk": rules.payload_pubkey,
            "ledger_seed": k.ledger_sk, "ledger_pk": rules.ledger_pubkey,
        },
        "rules": { "object": serde_json::to_value(&rules)?, "canonical": to_canonical(&rules)?, "rules_id": hex::encode(rules_id) },
        "payload": {
            "refund_typecode": 3, "refund_receiver": hex::encode([0x33u8; 43]),
            "sealed": hex::encode(sealed_bytes(&memo).context("memo")?), "memo": memo,
        },
        "payload_v2": { "amount_zat": 1_000_000, "sealed": hex::encode(sealed_bytes(&memo2).context("memo2")?), "memo": memo2 },
        "entry": { "canonical_unsigned": unsigned, "sig": entry.sig, "canonical_signed": to_canonical(&entry)?, "entry_hash": entry.hash()? },
        "ticket": { "raw_tx": hex::encode(&raw_tx), "blob": hex::encode(&blob), "blob_hash": blob_hash(&blob) },
        "hashes": {
            "amount_commit": { "amount_key": hex::encode(amount_key), "nf": nf, "value_zat": 1_000_000, "commit": amount_commit(&amount_key, nf, 1_000_000)? },
            "ufvk_hash": { "ufvk": "uvftest1example", "hash": ufvk_hash("uvftest1example") },
        },
    }))
}

fn verify_js(path: &str) -> Result<()> {
    let v: Value = serde_json::from_slice(&fs::read(path)?)?;
    let (c, k, rules) = fixed();
    let s = |key: &str| -> Result<Vec<u8>> { Ok(hex::decode(v[key].as_str().with_context(|| key.to_string())?)?) };

    // A memo sealed by libsodium's crypto_box_seal (random one-time key) opens on the host.
    let memo = v["js_memo"].as_str().context("js_memo")?;
    let p = Payload::open(memo, &k.payload_key()?)?;
    ensure!(p.rules_id == rules.id()? && p.enc_pubkey == *c.encryption_key().public_key().as_bytes(), "js memo payload differs");

    // A ticket sealed by libsodium opens with the contributor's encryption key.
    let raw = c.encryption_key().unseal(&s("js_ticket_blob")?).map_err(|_| anyhow::anyhow!("js ticket does not open"))?;
    ensure!(hex::encode(raw) == v["expected_raw_tx"].as_str().unwrap_or_default(), "js ticket contents differ");

    // A memo libsodium built with the contributor's derived one-time key opens via the challenge path.
    let esk = SecretKey::from(hex32(v["eph_sk"].as_str().context("eph_sk")?)?);
    let p2 = Payload::open_challenged(v["js_deterministic_memo"].as_str().context("memo")?, &hex32(&rules.payload_pubkey)?, &esk)?;
    ensure!(p2 == p, "challenge-opened payload differs");
    // A version 2 ticket sealed by libsodium: Rust opens it and reads the same transaction and opening values.
    let plain = c.encryption_key().unseal(&s("js_ticket_v2_blob")?).map_err(|_| anyhow::anyhow!("js v2 ticket does not open"))?;
    let (version, raw2, opening) = ll_core::ticket_blob::decode(&plain)?;
    ensure!(version == 2 && hex::encode(&raw2) == v["expected_raw_tx"].as_str().unwrap_or_default(), "js v2 ticket transaction differs");
    let o = opening.context("js v2 ticket has no opening")?;
    ensure!(o.action == 1 && o.value_zat == 990_000 && o.rseed == [0x11; 32], "js v2 ticket opening differs");
    // and a version 1 blob (raw transaction only) is still read as version 1
    let (v1, _, none) = ll_core::ticket_blob::decode(&hex::decode(v["expected_raw_tx"].as_str().unwrap_or_default())?)?;
    ensure!(v1 == 1 && none.is_none(), "version 1 ticket not recognised");
    // the version 2 memo libsodium built (with the amount sealed in) opens on the host and carries the amount
    let p3 = Payload::open(v["js_deterministic_memo_v2"].as_str().context("memo v2")?, &k.payload_key()?)?;
    ensure!(p3.amount_zat == Some(1_000_000) && p3.rules_id == rules.id()?, "js v2 memo payload differs");
    println!("Rust opened every box libsodium.js sealed: memo (random key), ticket, ticket version 2, memo (derived key), memo version 2 (amount)");
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("generate") => println!("{}", serde_json::to_string_pretty(&generate()?)?),
        Some("verify-js") => verify_js(args.get(2).context("file")?)?,
        _ => bail!("usage: ll-vectors generate | verify-js <file>"),
    }
    Ok(())
}
