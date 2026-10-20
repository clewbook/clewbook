//! Fake junk tickets made from a real one: each must fail exactly the right check, never pass overall.

use super::*;

struct Fx { raw: Vec<u8>, txid: String, branch: String, nf: String }

fn fx() -> Fx {
    let v: serde_json::Value = serde_json::from_str(include_str!("testdata/ticket-v1.json")).unwrap();
    let s = |k: &str| v[k].as_str().unwrap().to_string();
    Fx { raw: hex::decode(s("raw_hex")).unwrap(), txid: s("txid"), branch: s("branch"), nf: s("nf") }
}

fn inputs(f: &Fx, raw: &[u8]) -> Inputs {
    Inputs {
        raw_hex: hex::encode(raw), expected_txid: f.txid.clone(), ticket_branch: f.branch.clone(), contribution_nf: f.nf.clone(),
        fee_zat: 10_000, current_branch: Some("77190ad9".into()), scanned_to: Some(4_471_000), spent: None, known_txids: vec![f.txid.clone()],
        opening: None, refund_receiver_hex: None, expected_value_zat: None, listed_contribution_zat: None, intended_contribution_zat: None, paid_zat: None,
    }
}

fn status(ch: &[Check], id: &str) -> Status {
    ch.iter().find(|x| x.id == id).unwrap_or_else(|| panic!("no check {id}")).status
}

fn failing(ch: &[Check]) -> Vec<String> {
    ch.iter().filter(|x| x.status == Status::Fail).map(|x| x.id.clone()).collect()
}

#[test]
fn a_real_ticket_passes_level_1_and_says_what_was_not_checked() {
    let f = fx();
    let ch = check(&inputs(&f, &f.raw));
    assert!(failing(&ch).is_empty(), "{ch:?}");
    for id in ["matches_list", "shape", "signatures", "network_version", "no_expiry", "fee", "spends_your_coin", "coin_unspent"] {
        assert_eq!(status(&ch, id), Status::Pass, "{id}");
    }
    for id in ["pays_you", "proof", "anchor"] {
        assert_eq!(status(&ch, id), Status::NotChecked, "{id}");
    }
    assert_eq!(verdict(&ch), Status::Pass);
}

/// Flips one bit inside the first spend authorization signature. Signatures are not part of the transaction id, so the
/// id still matches the signed list: exactly the junk a host could publish.
fn with_bad_signature(f: &Fx) -> Vec<u8> {
    let tx = Transaction::read(&f.raw[..], branch_from_hex(&f.branch).unwrap()).unwrap();
    let sig: [u8; 64] = (&tx.ironwood_bundle().unwrap().actions().first().authorization().clone()).into();
    let at = f.raw.windows(64).position(|w| w == sig).expect("signature bytes found in the raw transaction");
    let mut raw = f.raw.clone();
    raw[at + 10] ^= 0x01;
    raw
}

#[test]
fn a_bad_signature_with_the_right_id_fails_signatures_only() {
    let f = fx();
    let raw = with_bad_signature(&f);
    let ch = check(&inputs(&f, &raw));
    assert_eq!(status(&ch, "matches_list"), Status::Pass, "the id still matches: the id does not cover signatures");
    assert_eq!(failing(&ch), vec!["signatures"]);
    assert_eq!(verdict(&ch), Status::Fail);
}

#[test]
fn a_ticket_for_another_network_version_fails() {
    let f = fx();
    let mut i = inputs(&f, &f.raw);
    i.current_branch = Some("deadbeef".into());
    let ch = check(&i);
    assert_eq!(failing(&ch), vec!["network_version"]);
    assert!(ch.iter().any(|x| x.detail.contains("must re-issue")));
}

#[test]
fn a_ticket_that_spends_a_different_coin_fails() {
    let f = fx();
    let mut i = inputs(&f, &f.raw);
    i.contribution_nf = hex::encode([0x42u8; 32]); // the list says one coin, the ticket spends another
    assert_eq!(failing(&check(&i)), vec!["spends_your_coin"]);
}

#[test]
fn a_coin_already_spent_by_something_else_fails_but_its_own_refund_does_not() {
    let f = fx();
    let mut i = inputs(&f, &f.raw);
    i.spent = Some(Spent { txid: "ab".repeat(32), height: 4_470_999 });
    let ch = check(&i);
    assert_eq!(failing(&ch), vec!["coin_unspent"]);
    // spent by the ticket itself (the refund happened): not a failure, and the line says so instead of claiming "unspent"
    i.spent = Some(Spent { txid: f.txid.clone(), height: 4_471_005 });
    let ch = check(&i);
    assert!(failing(&ch).is_empty());
    assert_eq!(status(&ch, "coin_used_by_list"), Status::Pass);
    assert!(ch.iter().all(|x| x.id != "coin_unspent"));
    // not searched yet: not checked, never a pass
    i.spent = None;
    i.scanned_to = None;
    assert_eq!(status(&check(&i), "coin_unspent"), Status::NotChecked);
}

#[test]
fn a_wrong_fee_an_expiring_ticket_or_a_different_id_fails() {
    let f = fx();
    let mut i = inputs(&f, &f.raw);
    i.fee_zat = 15_000;
    assert_eq!(failing(&check(&i)), vec!["fee"]);
    let mut i = inputs(&f, &f.raw);
    i.expected_txid = "00".repeat(32);
    assert_eq!(failing(&check(&i)), vec!["matches_list"]);
}

#[test]
fn an_unknown_network_version_or_garbage_is_a_failure_not_a_crash() {
    let f = fx();
    let mut i = inputs(&f, &f.raw);
    i.ticket_branch = "12345678".into();
    assert_eq!(verdict(&check(&i)), Status::Fail);
    let i = inputs(&f, &[1, 2, 3]);
    assert_eq!(verdict(&check(&i)), Status::Fail);
}

// ---- level 2: does the ticket pay the address the contributor gave? ----

struct V2 { raw: Vec<u8>, txid: String, branch: String, nf: String, opening: ll_core::ticket_blob::Opening, receiver: String }

fn v2() -> V2 {
    let v: serde_json::Value = serde_json::from_str(include_str!("testdata/ticket-v2.json")).unwrap();
    let s = |k: &str| v[k].as_str().unwrap().to_string();
    V2 {
        raw: hex::decode(s("raw_hex")).unwrap(), txid: s("txid"), branch: s("branch"), nf: s("nf"), receiver: s("receiver_hex"),
        opening: ll_core::ticket_blob::Opening { action: v["action"].as_u64().unwrap() as u8, value_zat: v["value_zat"].as_u64().unwrap(), rseed: hex::decode(s("rseed")).unwrap().try_into().unwrap() },
    }
}

fn inputs2(f: &V2) -> Inputs {
    Inputs {
        raw_hex: hex::encode(&f.raw), expected_txid: f.txid.clone(), ticket_branch: f.branch.clone(), contribution_nf: f.nf.clone(), fee_zat: 10_000,
        current_branch: Some("77190ad9".into()), scanned_to: Some(4_471_000), spent: None, known_txids: vec![f.txid.clone()],
        opening: Some(f.opening), refund_receiver_hex: Some(f.receiver.clone()), expected_value_zat: Some(f.opening.value_zat), listed_contribution_zat: None, intended_contribution_zat: None, paid_zat: None,
    }
}

#[test]
fn a_version_2_ticket_pays_you_only_when_the_commitment_matches() {
    let f = v2();
    let ch = check(&inputs2(&f));
    assert!(failing(&ch).is_empty(), "{ch:?}");
    assert_eq!(status(&ch, "pays_you"), Status::Pass);
    let pays = ch.iter().find(|x| x.id == "pays_you").unwrap();
    assert!(pays.label.starts_with("it pays you") && pays.detail.contains("exactly"), "{pays:?}");
}

#[test]
fn a_ticket_that_pays_someone_else_fails_pays_you() {
    // The transaction pays one address; the contributor's own address is a different, valid one (here: the host's, as in a
    // cheating host that sends the refund to itself). The commitment recomputed with the contributor's address cannot match.
    let f = v2();
    let mut i = inputs2(&f);
    let sk = orchard::keys::SpendingKey::from_bytes([7u8; 32]).unwrap();
    let host = orchard::keys::FullViewingKey::from(&sk).address_at(0u32, orchard::keys::Scope::External);
    assert_ne!(host.to_raw_address_bytes().to_vec(), hex::decode(&f.receiver).unwrap());
    i.refund_receiver_hex = Some(hex::encode(host.to_raw_address_bytes()));
    let ch = check(&i);
    assert_eq!(failing(&ch), vec!["pays_you"], "{ch:?}");
    assert_eq!(verdict(&ch), Status::Fail);
}

#[test]
fn a_mismatched_opening_fails() {
    let f = v2();
    let mut i = inputs2(&f);
    i.opening = Some(ll_core::ticket_blob::Opening { value_zat: f.opening.value_zat + 1, ..f.opening });
    i.expected_value_zat = None;
    assert_eq!(failing(&check(&i)), vec!["pays_you"], "a wrong amount in the opening");
    let mut i = inputs2(&f);
    i.opening = Some(ll_core::ticket_blob::Opening { rseed: [9; 32], ..f.opening });
    assert_eq!(failing(&check(&i)), vec!["pays_you"], "a wrong random seed");
    let mut i = inputs2(&f);
    i.opening = Some(ll_core::ticket_blob::Opening { action: 0, ..f.opening });
    assert!(failing(&check(&i)).contains(&"pays_you".to_string()), "the wrong action");
    let mut i = inputs2(&f);
    i.opening = Some(ll_core::ticket_blob::Opening { action: 7, ..f.opening });
    assert_eq!(failing(&check(&i)), vec!["pays_you"], "an action that does not exist");
}

#[test]
fn a_valid_commitment_for_the_wrong_amount_is_caught_by_the_expected_refund() {
    let f = v2();
    let mut i = inputs2(&f);
    i.expected_value_zat = Some(f.opening.value_zat + 5_000); // the contribution minus the fee should be more than the ticket pays
    let ch = check(&i);
    assert_eq!(failing(&ch), vec!["pays_you"]);
    assert!(ch.iter().any(|x| x.detail.contains("your contribution minus the fee")));
}

#[test]
fn an_old_format_ticket_or_a_missing_address_is_not_checked_never_a_failure() {
    let f = v2();
    let mut old = inputs2(&f);
    old.opening = None; // a version 1 ticket carries no opening
    let ch = check(&old);
    assert!(failing(&ch).is_empty());
    assert_eq!(status(&ch, "pays_you"), Status::NotChecked);
    assert_eq!(ch.iter().find(|x| x.id == "pays_you").unwrap().label, "that it pays you");
    assert_eq!(verdict(&ch), Status::Pass);
    let mut no_addr = inputs2(&f);
    no_addr.refund_receiver_hex = None;
    assert_eq!(status(&check(&no_addr), "pays_you"), Status::NotChecked);
}

#[test]
fn a_copied_message_shows_up_as_a_ticket_for_a_different_amount() {
    // someone's earlier payment used this contributor's sealed message: the ticket the contributor's page finds belongs to THAT payment
    let f = v2();
    let mut i = inputs2(&f);
    i.listed_contribution_zat = Some(f.opening.value_zat + 10_000);
    i.intended_contribution_zat = Some(5_000_000);
    let ch = check(&i);
    assert_eq!(failing(&ch), vec!["your_amount"], "{ch:?}");
    assert!(ch.iter().any(|x| x.detail.contains("may have used your message before yours")));
    // the amount they meant: passes
    i.listed_contribution_zat = Some(5_000_000);
    assert_eq!(status(&check(&i), "your_amount"), Status::Pass);
    // sealed-bid auction: amounts are hidden, so it says it did not compare, never a pass
    i.listed_contribution_zat = None;
    assert_eq!(status(&check(&i), "your_amount"), Status::NotChecked);
}

#[test]
fn your_amount_exact_under_over() {
    let f = v2();
    let mut i = inputs2(&f);
    let l = f.opening.value_zat;
    // exact
    i.listed_contribution_zat = Some(l); i.intended_contribution_zat = Some(l); i.paid_zat = Some(l);
    assert_eq!(status(&check(&i), "your_amount"), Status::Pass);
    // under: the list shows less than they meant to pay, or less than they paid
    i.intended_contribution_zat = Some(l + 1);
    assert_eq!(status(&check(&i), "your_amount"), Status::Fail);
    i.intended_contribution_zat = Some(l); i.paid_zat = Some(l + 1);
    assert_eq!(status(&check(&i), "your_amount"), Status::Fail);
    // over: they paid more than they chose; the list shows what they paid. Not a failure; the detail says so plainly.
    i.intended_contribution_zat = Some(l - 1_000); i.paid_zat = Some(l);
    let ch = check(&i);
    assert_eq!(status(&ch, "your_amount"), Status::Pass);
    assert!(failing(&ch).is_empty(), "{ch:?}");
    assert!(ch.iter().any(|x| x.id == "your_amount" && x.detail.contains("more than the") && x.detail.contains("the whole payment counts")));
}

#[test]
fn an_auction_ticket_that_pays_back_less_fails_in_the_library_without_help_from_the_page() {
    // flaw 1 (encrypted bids research): the list of a sealed-bid auction hides the amount, and before this fix a page that passed no expected
    // refund got a pass for any value. The sample ticket refunds 990 000 of 1 000 000 with a fee of 10 000.
    let f = v2();
    let mut i = inputs2(&f);
    i.expected_value_zat = None;
    i.listed_contribution_zat = None;
    // the amount the bidder meant to pay is known: at least that minus the fee
    i.intended_contribution_zat = Some(1_000_000);
    assert_eq!(status(&check(&i), "pays_you"), Status::Pass);
    i.intended_contribution_zat = Some(1_500_000);
    let ch = check(&i);
    assert_eq!(failing(&ch), vec!["pays_you"], "{ch:?}");
    assert!(ch.iter().any(|x| x.detail == "the ticket pays you 990000 zatoshi but your contribution minus the fee is 1490000"), "{ch:?}");
    i.intended_contribution_zat = Some(1_000_001);
    assert_eq!(failing(&check(&i)), vec!["pays_you"]);
    // the bidder paid more than they meant: the whole payment counts, so a larger refund is right
    i.intended_contribution_zat = Some(900_000);
    assert_eq!(status(&check(&i), "pays_you"), Status::Pass);
    // the payment itself is known: the refund must be exactly the payment minus the fee
    i.paid_zat = Some(1_000_000);
    assert_eq!(status(&check(&i), "pays_you"), Status::Pass);
    i.paid_zat = Some(1_200_000);
    let ch = check(&i);
    assert_eq!(failing(&ch), vec!["pays_you"], "{ch:?}");
    assert!(ch.iter().any(|x| x.detail == "the ticket pays you 990000 zatoshi but your payment minus the fee is 1190000"), "{ch:?}");
    // nothing known on this device: not compared, as before (the address is still checked)
    i.paid_zat = None;
    i.intended_contribution_zat = None;
    assert_eq!(status(&check(&i), "pays_you"), Status::Pass);
    // a fundraiser is unchanged: the list's amount decides through the expected refund the page passes
    i.listed_contribution_zat = Some(1_000_000);
    i.expected_value_zat = Some(990_000);
    assert_eq!(status(&check(&i), "pays_you"), Status::Pass);
}
