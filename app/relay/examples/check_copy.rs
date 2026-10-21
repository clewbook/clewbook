//! Checks a copy of a relay's data with this build of the relay: for every campaign folder, the stored rules still parse, validate and hash
//! to the folder's id; the relay serves them and the whole signed list (intact chain, signatures), and its challenges. Read only.
//! Usage: cargo run --example check_copy -- <relay url> <relay data folder>
use ll_core::rules::Rules;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (url, dir) = (&args[1], std::path::Path::new(&args[2]));
    let r = ll_relay::client::Relay::new(url);
    let mut bad = 0;
    let mut ids: Vec<String> = std::fs::read_dir(dir.join("campaigns"))?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
    ids.sort();
    for id in &ids {
        let disk: Rules = serde_json::from_slice(&std::fs::read(dir.join("campaigns").join(id).join("rules.json"))?)?;
        let mut problems = vec![];
        if let Err(e) = disk.validate() {
            problems.push(format!("rules do not validate: {e}"));
        }
        if hex::encode(disk.id()?) != *id {
            problems.push("rules do not hash to the folder's id".into());
        }
        match r.rules(id) {
            Ok(served) if served == disk => {}
            Ok(_) => problems.push("served rules differ from the stored ones".into()),
            Err(e) => problems.push(format!("rules not served: {e}")),
        }
        let entries = match r.ledger(id, 0) {
            Ok(l) => l,
            Err(e) => {
                problems.push(format!("list not served: {e}"));
                vec![]
            }
        };
        let on_disk = std::fs::read_dir(dir.join("campaigns").join(id).join("ledger")).map(|d| d.count()).unwrap_or(0);
        if entries.len() != on_disk {
            problems.push(format!("served {} entries, {on_disk} on disk", entries.len()));
        }
        let pk = ll_core::ledger::verifying_key(&disk.ledger_pubkey)?;
        let chain = ll_core::ledger::check_chain(&entries, &pk, id);
        if !chain.is_empty() {
            problems.push(format!("list does not check out: {}", chain.join("; ")));
        }
        if let Err(e) = r.challenges(id) {
            problems.push(format!("challenges not served: {e}"));
        }
        let kind = if disk.is_sealed() { "blind bid" } else { disk.mode.as_str() };
        println!("{} {} {} {} entries {}", if problems.is_empty() { "OK  " } else { "FAIL" }, &id[..16], disk.network, kind, entries.len());
        for p in &problems {
            println!("     {p}");
        }
        bad += usize::from(!problems.is_empty());
    }
    println!("{} campaigns, {bad} with problems", ids.len());
    std::process::exit(i32::from(bad > 0))
}
