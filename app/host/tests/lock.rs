//! Two host processes cannot work on one campaign folder at the same time, whatever name the program was started under.

use std::{fs, process::Command, thread, time::Duration};

use ll_core::{keys::CampaignSecrets, rules::Rules};

fn campaign_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("ll-lock-test-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    let secrets = CampaignSecrets { ledger_sk: hex::encode([1u8; 32]), payload_sk: hex::encode([2u8; 32]), amount_key: None };
    let rules = Rules {
        v: 1, network: "test".into(), mode: "raise".into(), goal_zat: Some(1_000_000), items: None,
        start_height: 100, deadline_height: 200, ticket_k: 10, close_grace: 10, reissue_window: 20,
        refund_fee_zat: 10_000, min_contribution_zat: 20_000, campaign_ufvk: Some("uvftest1x".into()), ufvk_hash: None,
        pay_to: None, early_close: None, cap_zat: None, sealed: None, pricing: None, settle_window: None, reserve_zat: None, treasury_address: None, treasury_ufvk: None,
        name: None,
        ledger_pubkey: secrets.ledger_pubkey_hex().unwrap(), payload_pubkey: secrets.payload_pubkey_hex().unwrap(),
    };
    fs::write(d.join("rules.json"), serde_json::to_vec(&rules).unwrap()).unwrap();
    fs::write(d.join("rules_id"), hex::encode(rules.id().unwrap())).unwrap();
    fs::write(d.join("secrets.json"), serde_json::to_vec(&secrets).unwrap()).unwrap();
    // a backend that cannot reach anything: the watcher keeps running (and keeps the lock), each pass just fails
    fs::write(d.join("config.json"), r#"{"backend":"devtool","devtool":"/nonexistent/zcash-devtool","wallet":"w","identity":"w.age"}"#).unwrap();
    // the wallet and its key file must exist inside the campaign folder (a path outside it is refused before anything starts)
    fs::create_dir_all(d.join("w")).unwrap();
    fs::write(d.join("w.age"), b"key").unwrap();
    d
}

fn wait_for_lock(dir: &std::path::Path) {
    for _ in 0..80 {
        if fs::read_to_string(dir.join("private/host.lock")).is_ok_and(|t| !t.is_empty()) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!("the first program never took the lock");
}

/// The first program holds the folder under `holder`'s name; every other command, under either name, refuses; once the first is killed
/// (no clean-up), the next one replaces its lock.
fn held_lock_is_respected(holder: &str, tag: &str) {
    let dir = campaign_dir(tag);
    let mut first = Command::new(holder).args(["watch", "--run", dir.to_str().unwrap(), "--interval", "60"]).spawn().unwrap();
    wait_for_lock(&dir);

    for bin in [env!("CARGO_BIN_EXE_ll-host"), env!("CARGO_BIN_EXE_cb-host")] {
        for args in [vec!["watch", "--once"], vec!["close", "--sweep-to", "utest1x"], vec!["reissue"]] {
            let mut a: Vec<&str> = vec![args[0], "--run", dir.to_str().unwrap()];
            a.extend(&args[1..]);
            let out = Command::new(bin).args(&a).output().unwrap();
            let err = String::from_utf8_lossy(&out.stderr);
            assert!(!out.status.success(), "{bin} {:?} must refuse while {holder} holds the folder", args);
            assert!(err.contains("already working on this campaign folder"), "{:?}: {err}", args);
        }
    }

    // the first one is killed without cleaning up: the system released its lock, so the next instance replaces the record
    first.kill().unwrap();
    first.wait().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_cb-host")).args(["watch", "--once", "--run", dir.to_str().unwrap()]).output().unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("replacing a stale lock"), "{err}");
    assert!(!err.contains("already working"), "{err}");
    assert_eq!(fs::read_to_string(dir.join("private/host.lock")).unwrap(), "", "released cleanly when the process ends");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_lock_held_by_ll_host_is_respected_and_a_stale_lock_is_replaced() {
    held_lock_is_respected(env!("CARGO_BIN_EXE_ll-host"), "ll");
}

#[test]
fn a_lock_held_by_cb_host_is_respected_and_a_stale_lock_is_replaced() {
    held_lock_is_respected(env!("CARGO_BIN_EXE_cb-host"), "cb");
}

#[test]
fn two_programs_started_at_the_same_moment_give_exactly_one_winner() {
    let dir = campaign_dir("race");
    for _ in 0..5 {
        let a = Command::new(env!("CARGO_BIN_EXE_cb-host")).args(["watch", "--run", dir.to_str().unwrap(), "--interval", "60"]).stderr(std::process::Stdio::piped()).spawn().unwrap();
        let b = Command::new(env!("CARGO_BIN_EXE_ll-host")).args(["watch", "--run", dir.to_str().unwrap(), "--interval", "60"]).stderr(std::process::Stdio::piped()).spawn().unwrap();
        thread::sleep(Duration::from_millis(1500));
        let mut running = 0;
        for mut c in [a, b] {
            match c.try_wait().unwrap() {
                None => {
                    running += 1;
                    c.kill().unwrap();
                    c.wait().unwrap();
                }
                Some(status) => {
                    let mut err = String::new();
                    std::io::Read::read_to_string(c.stderr.as_mut().unwrap(), &mut err).unwrap();
                    assert!(!status.success() && err.contains("already working"), "the loser refuses: {err}");
                }
            }
        }
        assert_eq!(running, 1, "exactly one of two simultaneous programs keeps the folder");
    }
    let _ = fs::remove_dir_all(&dir);
}
