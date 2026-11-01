//! The main network upgrade NU7 (block 3,543,405, ZIP 259) as the pages' WebAssembly sees it, with the libraries it is built with.
//! 1. The network version the page reads a transaction under, by height (lib.rs: `BranchId::for_height(&self.params, ..)`), on both
//!    networks, either side of the upgrade.
//! 2. A refund ticket signed for NU7 passes the page's ticket check once the network runs NU7, and one signed for the version before
//!    (NU6.3) is reported only as built for an older network version: it reads, matches its id, has the right shape and valid
//!    signatures, so it is not taken for a fake. The two tickets are real ones, built and signed here with throw away keys, the way the
//!    host builds a ticket for the next block's height.
//! With NU7_TICKETS_OUT=<file> the two tickets are also written there, for the same check in the built module (app/web/nu7-wasm-check.mjs).

use super::Params;
use orchard::{
    ValuePool,
    builder::{Builder, BundleType},
    circuit::ProvingKey,
    keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey},
    note::{ExtractedNoteCommitment, Note, NoteVersion, RandomSeed, Rho},
    tree::{MerkleHashOrchard, MerklePath},
    value::NoteValue,
};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use zcash_primitives::transaction::{
    TransactionData,
    components::orchard::bundle_version_for_branch,
    sighash::{PrecomputedSighashData, SignableInput},
};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, Network, NetworkUpgrade, Parameters},
    value::ZatBalance,
};

const NU6_3: &str = "37a5165b";
const NU7: &str = "77190ad9";
const MAIN_NU7: u32 = 3_543_405;
const TEST_NU7: u32 = 4_465_026;

/// The network version the page uses for a transaction at block `h`.
fn version_at(net: Network, h: u32) -> String {
    format!("{:08x}", u32::from(BranchId::for_height(&Params::Net(net), BlockHeight::from_u32(h))))
}

#[test]
fn mainnet_reads_under_nu7_from_block_3543405() {
    assert_eq!(MAIN_NU7, ll_core::sealed::NU7_MAIN_HEIGHT, "the core's height and the libraries' agree");
    assert_eq!(Params::Net(Network::MainNetwork).activation_height(NetworkUpgrade::Nu7), Some(BlockHeight::from_u32(MAIN_NU7)));
    assert_eq!(version_at(Network::MainNetwork, MAIN_NU7 - 1), NU6_3, "block 3,543,404: still NU6.3");
    assert_eq!(version_at(Network::MainNetwork, MAIN_NU7), NU7, "block 3,543,405: NU7");
    assert_eq!(version_at(Network::MainNetwork, MAIN_NU7 + 1), NU7);
    assert_eq!(version_at(Network::MainNetwork, 3_900_000), NU7);
}

#[test]
fn testnet_reads_under_nu7_from_block_4465026() {
    assert_eq!(Params::Net(Network::TestNetwork).activation_height(NetworkUpgrade::Nu7), Some(BlockHeight::from_u32(TEST_NU7)));
    assert_eq!(version_at(Network::TestNetwork, TEST_NU7 - 1), NU6_3);
    assert_eq!(version_at(Network::TestNetwork, TEST_NU7), NU7);
    assert_eq!(version_at(Network::TestNetwork, TEST_NU7 + 1), NU7);
}

struct Ticket {
    raw_hex: String,
    txid: String,
    branch: String,
    nf: String,
}

/// A refund ticket as the host makes one for main network block `h`: one Ironwood spend of a 50,000 zatoshi coin, 40,000 back, a
/// 10,000 fee, no expiry, signed and proved for the network version of that block.
fn ticket_for_block(h: u32) -> Ticket {
    let branch = BranchId::for_height(&Params::Net(Network::MainNetwork), BlockHeight::from_u32(h));
    let sk = SpendingKey::from_bytes([7; 32]).unwrap();
    let fvk = FullViewingKey::from(&sk);
    let addr = fvk.address_at(0u32, Scope::External);
    let rho = Rho::from_bytes(&[1; 32]).unwrap();
    let rseed = (0u8..=255).find_map(|b| RandomSeed::from_bytes([b; 32], &rho).into_option()).unwrap();
    let note = Note::from_parts(addr, NoteValue::from_raw(50_000), rho, rseed, NoteVersion::V3).unwrap();
    let path = MerklePath::from_parts(0, [MerkleHashOrchard::from_bytes(&[0; 32]).unwrap(); 32]);
    let anchor = path.root(ExtractedNoteCommitment::from(note.commitment()));
    let version = bundle_version_for_branch(branch, ValuePool::Ironwood).expect("an Ironwood bundle version for this network version");
    let mut b = Builder::new(BundleType::DEFAULT, version, version.default_flags(), anchor).unwrap();
    b.add_spend(fvk.clone(), note, path).unwrap();
    b.add_output(None, addr, NoteValue::from_raw(40_000), [0u8; 512]).unwrap();
    let mut r = UnwrapErr(SysRng);
    let iw = b.build::<ZatBalance>(&mut r).unwrap().unwrap().0;
    let unsigned: TransactionData<zcash_primitives::transaction::Unauthorized> = TransactionData::from_parts_v6(branch, 0, BlockHeight::from_u32(0), None, None, None, Some(iw.clone()));
    let sighash = PrecomputedSighashData::new_zip244(unsigned).unwrap().signature_hash(&SignableInput::Shielded);
    let pk = ProvingKey::build(version.circuit_version());
    let iw = iw.create_proof(&pk, &mut r).unwrap().apply_signatures(&mut r, *sighash.as_ref(), &[SpendAuthorizingKey::from(&sk)]).unwrap();
    let tx = TransactionData::from_parts_v6(branch, 0, BlockHeight::from_u32(0), None, None, None, Some(iw)).freeze().unwrap();
    let mut raw = vec![];
    tx.write(&mut raw).unwrap();
    Ticket { raw_hex: hex::encode(raw), txid: tx.txid().to_string(), branch: format!("{:08x}", u32::from(branch)), nf: hex::encode(note.nullifier(&fvk).to_bytes()) }
}

/// The page's own call (contribute.js: `W.verify_ticket`), with what the page knows about this ticket and what the network runs now.
fn page_check(t: &Ticket, network_now: &str) -> serde_json::Value {
    let inputs = serde_json::json!({
        "raw_hex": t.raw_hex, "expected_txid": t.txid, "ticket_branch": t.branch, "contribution_nf": t.nf, "fee_zat": 10_000,
        "current_branch": network_now, "scanned_to": MAIN_NU7 + 10, "spent": null, "known_txids": [t.txid],
    });
    serde_json::from_str(&crate::contribute::verify_ticket(&inputs.to_string()).unwrap()).unwrap()
}

fn status<'a>(v: &'a serde_json::Value, id: &str) -> &'a str {
    v["checks"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("no check {id}"))["status"].as_str().unwrap()
}

fn failing(v: &serde_json::Value) -> Vec<String> {
    v["checks"].as_array().unwrap().iter().filter(|c| c["status"] == "fail").map(|c| c["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn after_nu7_a_nu7_ticket_passes_and_an_older_one_is_reported_as_an_older_version() {
    let old = ticket_for_block(MAIN_NU7 - 1);
    let new = ticket_for_block(MAIN_NU7);
    assert_eq!(old.branch, NU6_3, "a ticket for block 3,543,404 is signed for NU6.3");
    assert_eq!(new.branch, NU7, "a ticket for block 3,543,405 is signed for NU7");

    // the network runs NU7: the NU7 ticket passes every level 1 check
    let v = page_check(&new, NU7);
    assert_eq!(v["verdict"], "pass", "{v}");
    for id in ["matches_list", "shape", "signatures", "network_version", "no_expiry", "fee", "spends_your_coin", "coin_unspent"] {
        assert_eq!(status(&v, id), "pass", "{id}: {v}");
    }

    // the network runs NU7: the NU6.3 ticket fails only the network version, with the words the page shows, and nothing that says fake
    let v = page_check(&old, NU7);
    assert_eq!(v["verdict"], "fail");
    assert_eq!(failing(&v), vec!["network_version"], "{v}");
    for id in ["matches_list", "shape", "signatures", "no_expiry", "fee", "spends_your_coin"] {
        assert_eq!(status(&v, id), "pass", "{id}: {v}");
    }
    let detail = v["checks"].as_array().unwrap().iter().find(|c| c["id"] == "network_version").unwrap()["detail"].as_str().unwrap().to_string();
    assert_eq!(detail, "built for network version 37a5165b, but the network now runs 77190ad9: the campaign must re-issue it");

    // before the upgrade (the network runs NU6.3) it is the other way round
    assert_eq!(page_check(&old, NU6_3)["verdict"], "pass");
    assert_eq!(failing(&page_check(&new, NU6_3)), vec!["network_version"]);

    if let Ok(out) = std::env::var("NU7_TICKETS_OUT") {
        let j = |t: &Ticket| serde_json::json!({ "raw_hex": t.raw_hex, "txid": t.txid, "branch": t.branch, "nf": t.nf });
        std::fs::write(out, serde_json::json!({ "nu6_3": j(&old), "nu7": j(&new) }).to_string()).unwrap();
    }
}
