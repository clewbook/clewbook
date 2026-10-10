//! The guard's check on a built transaction, independent of the wallet backend: it must
//! spend exactly the expected notes, pay exactly one output to the expected receiver, touch
//! no other pool, and (tickets) never expire. Then the raw transaction is extracted.

use std::collections::BTreeMap;

use anyhow::{Result, anyhow, bail, ensure};
use pczt::{
    Pczt,
    roles::{spend_finalizer::SpendFinalizer, tx_extractor::TransactionExtractor, verifier::Verifier},
};
use rand::{rand_core::UnwrapErr, rngs::SysRng};

pub struct Checked {
    pub txid: String,
    pub raw_tx: Vec<u8>,
    pub branch_id: String,
    /// The opening values of the value-carrying output (SPEC §3.1, level 2): which action, how much, the note's random seed.
    pub opening: Option<ll_core::ticket_blob::Opening>,
}

pub struct Expect<'a> {
    /// Nullifier (transaction byte order) -> note value, for every note that must be spent.
    pub spends: BTreeMap<[u8; 32], u64>,
    pub receiver: &'a [u8; 43],
    pub value_zat: u64,
    pub no_expiry: bool,
    /// Further outputs that must be present exactly (receiver, value), and nothing else.
    pub also: Vec<([u8; 43], u64)>,
}

pub fn check_and_extract(signed: &[u8], expect: &Expect<'_>) -> Result<Checked> {
    let pczt = Pczt::parse(signed).map_err(|e| anyhow!("unreadable PCZT: {e:?}"))?;
    if expect.no_expiry {
        ensure!(*pczt.global().expiry_height() == 0, "ticket expiry is not 0");
    }
    let branch_id = format!("{:08x}", pczt.global().consensus_branch_id());
    ensure!(
        pczt.transparent().inputs().is_empty() && pczt.transparent().outputs().is_empty(),
        "transaction has transparent parts"
    );
    ensure!(
        pczt.sapling().spends().is_empty() && pczt.sapling().outputs().is_empty(),
        "transaction has Sapling parts"
    );
    ensure!(pczt.orchard().actions().is_empty(), "transaction has Orchard actions");

    let mut spends = BTreeMap::new();
    let mut outputs = vec![];
    let mut openings: Vec<(u8, u64, Option<[u8; 32]>)> = vec![];
    let pczt = Verifier::new(pczt)
        .with_ironwood::<(), _>(|bundle| {
            for (index, action) in bundle.actions().iter().enumerate() {
                let spent = action.spend().value().map_or(0, |v| v.inner());
                if spent > 0 {
                    spends.insert(action.spend().nullifier().to_bytes(), spent);
                }
                let paid = action.output().value().map_or(0, |v| v.inner());
                if paid > 0 {
                    openings.push((index as u8, paid, action.output().rseed().as_ref().map(|r| *r.as_bytes())));
                    outputs.push((action.output().recipient().map(|a| a.to_raw_address_bytes()), paid));
                }
            }
            Ok(())
        })
        .map_err(|e| anyhow!("cannot read Ironwood bundle: {e:?}"))?
        .finish();

    if spends != expect.spends {
        bail!(
            "transaction spends {:?}, expected exactly {:?}; refusing",
            spends.keys().map(hex::encode).collect::<Vec<_>>(),
            expect.spends.keys().map(hex::encode).collect::<Vec<_>>()
        );
    }
    let mut want: Vec<([u8; 43], u64)> = std::iter::once((*expect.receiver, expect.value_zat)).chain(expect.also.iter().cloned()).collect();
    want.sort();
    let mut got: Vec<([u8; 43], u64)> = outputs.iter().filter_map(|(to, v)| to.map(|t| (t, *v))).collect();
    got.sort();
    if got.len() != outputs.len() || got != want {
        bail!("outputs are not exactly the expected receivers and amounts ({} output(s) expected)", want.len());
    }

    let finalized = SpendFinalizer::new(pczt)
        .finalize_spends()
        .map_err(|e| anyhow!("finalize spends: {e:?}"))?;
    let tx = TransactionExtractor::new(finalized)
        .extract(UnwrapErr(SysRng))
        .map_err(|e| anyhow!("extract transaction: {e:?}"))?;
    let mut raw_tx = vec![];
    tx.write(&mut raw_tx)?;
    let opening = match openings.as_slice() {
        [(action, value_zat, Some(rseed))] => Some(ll_core::ticket_blob::Opening { action: *action, value_zat: *value_zat, rseed: *rseed }),
        _ => None,
    };
    Ok(Checked { txid: tx.txid().to_string(), raw_tx, branch_id, opening })
}

/// Final transaction bytes from a signed PCZT (no checks: the guard's `check_and_extract` ran when it was made).
pub fn raw_from_signed(signed: &[u8]) -> Result<(Vec<u8>, String)> {
    let pczt = Pczt::parse(signed).map_err(|e| anyhow!("unreadable PCZT: {e:?}"))?;
    let finalized = SpendFinalizer::new(pczt).finalize_spends().map_err(|e| anyhow!("finalize spends: {e:?}"))?;
    let tx = TransactionExtractor::new(finalized).extract(UnwrapErr(SysRng)).map_err(|e| anyhow!("extract transaction: {e:?}"))?;
    let mut raw = vec![];
    tx.write(&mut raw)?;
    Ok((raw, tx.txid().to_string()))
}
