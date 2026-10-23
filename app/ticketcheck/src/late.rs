//! Sealed bid auctions (SPEC §9): the bid page checks the host's part of its late ticket completely, then signs its coin input.
//! An honest close never uses the late ticket, so a broken one would show only after the late ticket block, too late (14, section B,
//! finding 3): the page checks the lock, the inputs, the refund output, both kinds of signature and (with a verifying key) the proof,
//! and gives back the anchor for the caller to compare with the chain's note tree at the stated height.

use orchard::{bundle::Authorized as IwAuthorized, keys::OutgoingViewingKey};
use zcash_primitives::transaction::{
    Authorization, Authorized, Transaction, TransactionData,
    sighash::{SignableInput, signature_hash},
    txid::TxIdDigester,
};
use zcash_protocol::{consensus::BranchId, value::Zatoshis};
use zcash_transparent::{
    address::{Script, TransparentAddress},
    builder::{SpendInfo, TransparentBuilder, TransparentInputInfo, TransparentSigningSet},
    bundle::{self as tb, OutPoint, TxOut},
    sighash::TransparentAuthorizingContext,
};

/// What the page knows and expects of its late ticket.
pub struct LateExpect {
    /// The deposit's nullifier (as the ledger shows it).
    pub deposit_nf: [u8; 32],
    /// The coin: transaction (display order), output index, value.
    pub coin_txid: String,
    pub coin_index: u32,
    pub coin_value_zat: u64,
    /// The page's public key, which the coin pays.
    pub page_key: [u8; 33],
    /// The late ticket block H_s (the ticket is valid in blocks after it).
    pub lock_time: u32,
    /// The refund address's Ironwood receiver and what it must receive.
    pub refund_receiver: [u8; 43],
    pub refund_zat: u64,
    /// The deposit's amount (what the person paid): set 2, L1, only the deposit minus the refund may leave the shielded pool.
    pub deposit_zat: u64,
    /// Set 1, H5: the network version (consensus branch id) the network reports now; the ticket must be built for it.
    /// `None` when it could not be asked (then the ticket is refused: an unknown version is not checked).
    pub current_branch: Option<u32>,
}

/// L3: the least network fee a transaction with `actions` Ironwood actions and one transparent input (the coin) needs to be relayed
/// (ZIP 317: 5000 zatoshis per logical action, at least two).
pub fn least_fee(actions: usize) -> u64 {
    5_000 * (actions as u64 + 1).max(2)
}

/// The coin's amount and script, which the transparent and shielded signatures commit to (ZIP 244).
#[derive(Debug)]
struct CoinContext {
    value: Zatoshis,
    script: Script,
}

impl tb::Authorization for CoinContext {
    type ScriptSig = ();
}

impl TransparentAuthorizingContext for CoinContext {
    fn input_amounts(&self) -> Vec<Zatoshis> {
        vec![self.value]
    }
    fn input_scriptpubkeys(&self) -> Vec<Script> {
        vec![self.script.clone()]
    }
}

struct WithCoin(CoinContext);

impl tb::MapAuth<tb::Authorized, CoinContext> for WithCoin {
    fn map_script_sig(&self, _: Script) {}
    fn map_authorization(&self, _: tb::Authorized) -> CoinContext {
        CoinContext { value: self.0.value, script: self.0.script.clone() }
    }
}

/// The transaction with the coin's amount and script attached, so its signature hashes can be computed.
struct Sighashing;

impl Authorization for Sighashing {
    type TransparentAuth = CoinContext;
    type SaplingAuth = sapling::bundle::Authorized;
    type OrchardAuth = IwAuthorized;
}

fn coin_script(page_key: &[u8; 33]) -> Result<Script, String> {
    let pk = secp256k1::PublicKey::from_slice(page_key).map_err(|_| "the page key is not a public key".to_string())?;
    Ok(TransparentAddress::from_pubkey(&pk).script().into())
}

fn outpoint(txid: &str, index: u32) -> Result<OutPoint, String> {
    let mut b: [u8; 32] = hex::decode(txid).ok().and_then(|v| v.try_into().ok()).ok_or("bad coin txid")?;
    b.reverse();
    Ok(OutPoint::new(b, index))
}

/// Checks the host's part of a late ticket, all but its proof (`verify_proof`, or the browser's proof module). Returns the ticket's id and
/// its anchor (to compare with the chain's note tree root at the height the host stated).
pub fn check(raw: &[u8], branch: BranchId, ovk: &[u8; 32], e: &LateExpect) -> Result<(String, [u8; 32]), String> {
    let tx = Transaction::read(raw, branch).map_err(|err| format!("unreadable transaction: {err}"))?;
    let txid = tx.txid().to_string();
    if u32::from(tx.expiry_height()) != 0 || tx.lock_time() != e.lock_time {
        return Err(format!("lock {} and expiry {}, expected lock {} and no expiry", tx.lock_time(), u32::from(tx.expiry_height()), e.lock_time));
    }
    if tx.sapling_bundle().is_some() || tx.orchard_bundle().is_some() {
        return Err("the late ticket has parts it should not have".into());
    }
    let t = tx.transparent_bundle().ok_or("no coin input")?;
    #[allow(deprecated)]
    let one_coin = t.vin.len() == 1 && t.vin[0].prevout() == &outpoint(&e.coin_txid, e.coin_index)? && t.vin[0].sequence() != u32::MAX && t.vout.is_empty();
    if !one_coin {
        return Err("the transparent part is not exactly this page's coin with a non final sequence number".into());
    }
    // H5: built for the network version in use now (a ticket for another version is never accepted)
    let built = u32::from(tx.consensus_branch_id());
    match e.current_branch {
        Some(now) if now == built => {}
        Some(now) => return Err(format!("it is built for network version {built:08x}, but the network runs {now:08x} now")),
        None => return Err("the network could not be asked which version it runs, so the ticket's version was not checked".into()),
    }
    let iw = tx.ironwood_bundle().ok_or("no Ironwood part")?;
    if !iw.actions().iter().any(|a| a.nullifier().to_bytes() == e.deposit_nf) {
        return Err("it does not spend this deposit".into());
    }
    // set 2, L1: two actions (the deposit spent, the refund paid; the library pads to two) and nothing else leaving the pool.
    // An extra spend of another note of the host's, balanced by an equal extra output, still cannot be seen from here (BLIND_BIDS.md, 3)
    if iw.actions().len() != 2 {
        return Err(format!("it has {} shielded actions; a late ticket has two (the deposit and the refund)", iw.actions().len()));
    }
    let leaves = i64::from(*iw.value_balance());
    if leaves != e.deposit_zat as i64 - e.refund_zat as i64 {
        return Err(format!("it takes {leaves} zatoshis out of the shielded pool; only the deposit minus the refund ({}) may leave", e.deposit_zat as i64 - e.refund_zat as i64));
    }
    // L3: a fee the network relays (the coin plus what leaves the Ironwood pool, as no transparent output takes any)
    let fee = e.coin_value_zat as i64 + i64::from(*iw.value_balance());
    let least = least_fee(iw.actions().len()) as i64;
    if fee < least {
        return Err(format!("its network fee is {fee} zatoshis, less than the {least} the network needs to relay it"));
    }
    let recovered = iw.recover_outputs_with_ovks(&[OutgoingViewingKey::from(*ovk)]);
    let back: u64 = recovered.iter().filter(|r| r.3.to_raw_address_bytes() == e.refund_receiver).map(|r| r.2.value().inner()).sum();
    if back != e.refund_zat || recovered.len() != 1 {
        return Err(format!("pays back {back} to the refund address, expected {}", e.refund_zat));
    }
    // the shielded signature hash, with the coin's amount and script (they are not in the transaction itself)
    let ctx = CoinContext { value: Zatoshis::from_u64(e.coin_value_zat).map_err(|_| "coin value")?, script: coin_script(&e.page_key)? };
    let data: TransactionData<Sighashing> = tx.clone().into_data().map_bundles(|t| t.map(|b| b.map_authorization(WithCoin(ctx))), |s| s, |o| o);
    let parts = data.digest(TxIdDigester);
    let sighash: [u8; 32] = *signature_hash(&data, &SignableInput::Shielded, &parts).as_ref();
    for a in iw.actions() {
        a.rk().verify(&sighash, a.authorization()).map_err(|_| "a spend signature does not verify")?;
    }
    iw.binding_validating_key().verify(&sighash, iw.authorization().binding_signature()).map_err(|_| "the binding signature does not verify")?;
    Ok((txid, iw.anchor().to_bytes()))
}

/// Verifies the late ticket's Ironwood proof.
#[cfg(feature = "proof")]
pub fn verify_proof(raw: &[u8], branch: BranchId, vk: &orchard::circuit::VerifyingKey) -> Result<(), String> {
    let tx = Transaction::read(raw, branch).map_err(|err| format!("unreadable transaction: {err}"))?;
    tx.ironwood_bundle().ok_or("no Ironwood part")?.verify_proof(vk).map_err(|err| format!("the proof does not verify: {err:?}"))
}

/// The page's public key (compressed, 33 bytes) for its secret, or none for the rare secret that is not a valid key.
pub fn page_public_key(page_secret: &[u8; 32]) -> Option<[u8; 33]> {
    let sk = secp256k1::SecretKey::from_secret_bytes(*page_secret).ok()?;
    Some(secp256k1::PublicKey::from_secret_key(&sk).serialize())
}

/// Signs the page's coin input of a checked late ticket and returns the finished transaction (to keep, and send after H_s).
pub fn sign(raw: &[u8], branch: BranchId, e: &LateExpect, page_secret: &[u8; 32]) -> Result<Vec<u8>, String> {
    let tx = Transaction::read(raw, branch).map_err(|err| format!("unreadable transaction: {err}"))?;
    let sk = secp256k1::SecretKey::from_secret_bytes(*page_secret).map_err(|_| "bad page key")?;
    let pk = secp256k1::PublicKey::from_secret_key(&sk);
    if pk.serialize() != e.page_key {
        return Err("this page key is not the one the coin pays".into());
    }
    let value = Zatoshis::from_u64(e.coin_value_zat).map_err(|_| "coin value")?;
    let script = coin_script(&e.page_key)?;
    #[allow(deprecated)]
    let sequence = tx.transparent_bundle().and_then(|t| t.vin.first()).map(|i| i.sequence()).ok_or("no coin input")?;
    let mut builder = TransparentBuilder::empty();
    builder.add_input(
        TransparentInputInfo::from_parts(outpoint(&e.coin_txid, e.coin_index)?, TxOut::new(value, script.clone()), SpendInfo::P2pkh { pubkey: pk })
            .map_err(|err| format!("{err:?}"))?,
    );
    let mut unsigned = builder.build().ok_or("no coin input")?;
    #[allow(deprecated)]
    {
        unsigned.vin[0].sequence = sequence;
    }
    let data: TransactionData<Sighashing> = tx.clone().into_data().map_bundles(|t| t.map(|b| b.map_authorization(WithCoin(CoinContext { value, script }))), |s| s, |o| o);
    let parts = data.digest(TxIdDigester);
    // the host's signatures commit to the coin's script: if they do not verify, this is not the coin of this page's key
    let shielded: [u8; 32] = *signature_hash(&data, &SignableInput::Shielded, &parts).as_ref();
    let iw = tx.ironwood_bundle().ok_or("no Ironwood part")?;
    iw.binding_validating_key().verify(&shielded, iw.authorization().binding_signature()).map_err(|_| "this late ticket is not for this page's coin".to_string())?;
    let mut keys = TransparentSigningSet::new();
    keys.add_key(sk);
    let signed = unsigned
        .apply_signatures(|input| *signature_hash(&data, &SignableInput::Transparent(input), &parts).as_ref(), &keys)
        .map_err(|err| format!("signing: {err:?}"))?;
    let done: TransactionData<Authorized> = tx.into_data().map_bundles(|_| Some(signed), |s| s, |o| o);
    let tx = done.freeze().map_err(|err| err.to_string())?;
    let mut out = vec![];
    tx.write(&mut out).map_err(|err| err.to_string())?;
    Ok(out)
}
