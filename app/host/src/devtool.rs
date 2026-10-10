//! Option A: wallet operations through the patched `zcash-devtool` binary, plus direct
//! read-only access to its wallet database.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, anyhow, bail};
use ll_core::walletdb::{self, WalletNote};

use crate::backend::{AccountInfo, ChainTip, SpendRequest, WalletBackend};

pub struct DevtoolBackend {
    pub bin: PathBuf,
    pub wallet: PathBuf,
    pub identity: PathBuf,
    /// Scratch directory for intermediate PCZT files.
    pub work: PathBuf,
}

impl DevtoolBackend {
    fn run(&self, args: &[&str]) -> Result<String> {
        let out = Command::new(&self.bin)
            .args(args)
            .output()
            .with_context(|| format!("running {}", self.bin.display()))?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let err: Vec<&str> = stderr.lines().filter(|l| !l.contains(" INFO ")).collect();
            bail!("zcash-devtool {} failed: {}{}", args.join(" "), stdout.trim(), err.join("\n"));
        }
        Ok(stdout)
    }

    fn w(&self) -> &str {
        self.wallet.to_str().expect("utf-8 path")
    }

    fn id(&self) -> &str {
        self.identity.to_str().expect("utf-8 path")
    }

    fn scratch(&self, name: &str) -> Result<PathBuf> {
        crate::make_private_dir(&self.work)?;
        Ok(self.work.join(name))
    }

    fn db(&self) -> PathBuf {
        self.wallet.join("data.sqlite")
    }
}

fn path_str(p: &Path) -> &str {
    p.to_str().expect("utf-8 path")
}

impl WalletBackend for DevtoolBackend {
    fn name(&self) -> &'static str {
        "devtool"
    }

    fn sync(&mut self) -> Result<()> {
        self.run(&["wallet", "-w", self.w(), "sync"])?;
        self.run(&["wallet", "-w", self.w(), "enhance"])?;
        Ok(())
    }

    fn chain_tip(&mut self) -> Result<ChainTip> {
        let info: serde_json::Value =
            serde_json::from_str(self.run(&["wallet", "-w", self.w(), "get-info"])?.trim())?;
        Ok(ChainTip {
            height: info["chain_tip_height"].as_u64().context("no chain_tip_height")? as u32,
            branch_id: info["consensus_branch_id"].as_str().context("no consensus_branch_id")?.into(),
        })
    }

    fn account(&mut self) -> Result<AccountInfo> {
        let ufvk = walletdb::account_ufvk(&self.db())?.context("wallet has no account")?;
        let list = self.run(&["wallet", "-w", self.w(), "list-addresses"])?;
        let address = list
            .lines()
            .find_map(|l| l.trim().strip_prefix("Default Address: "))
            .ok_or_else(|| anyhow!("no default address"))?
            .trim()
            .to_string();
        Ok(AccountInfo { ufvk, address })
    }

    fn notes(&mut self) -> Result<Vec<WalletNote>> {
        walletdb::read_notes(&self.db())
    }

    fn lock(&mut self, txid: &str, action: u32, owner: &str, until: u32) -> Result<()> {
        let note = format!("{txid}:{action}");
        let until = until.to_string();
        self.run(&[
            "wallet", "-w", self.w(), "lock-note", "--note", &note, "--owner", owner, "--until", &until,
        ])?;
        Ok(())
    }

    fn unlock(&mut self, txid: &str, action: u32, owner: &str) -> Result<bool> {
        let note = format!("{txid}:{action}");
        let out = self.run(&[
            "wallet", "-w", self.w(), "lock-note", "--note", &note, "--owner", owner, "--until", "0", "--unlock",
        ])?;
        Ok(out.trim() == "unlocked")
    }

    fn build(&mut self, req: &SpendRequest) -> Result<Vec<u8>> {
        if !req.also_pay.is_empty() {
            bail!("the devtool backend cannot build transactions with two outputs; use the libs backend");
        }
        let created = self.scratch("ticket.pczt")?;
        let proven = self.scratch("ticket.proven")?;
        let value = req.value_zat.to_string();
        let mut args = vec![
            "pczt", "-w", self.w(), "create",
            "--address", &req.to_address,
            "--value", &value,
            "--discard-ovk",
            "--min-confirmations", "1",
            "--output", path_str(&created),
        ];
        if req.no_expiry {
            args.extend(["--expiry-height", "0"]);
        }
        for owner in &req.lock_owners {
            args.extend(["--spend-locked-by", owner.as_str()]);
        }
        self.run(&args)?;
        self.run(&[
            "pczt", "-w", self.w(), "prove", "-i", self.id(), path_str(&created), "--output", path_str(&proven),
        ])?;
        Ok(fs::read(&proven)?)
    }

    fn sign(&mut self, pczt: &[u8]) -> Result<Vec<u8>> {
        let input = self.scratch("ticket.unsigned")?;
        let signed = self.scratch("ticket.signed")?;
        fs::write(&input, pczt)?;
        self.run(&[
            "pczt", "-w", self.w(), "sign", "-i", self.id(), path_str(&input), "--output", path_str(&signed),
        ])?;
        Ok(fs::read(&signed)?)
    }

    fn broadcast_raw(&mut self, _raw: &[u8]) -> Result<String> {
        bail!("the devtool backend cannot send raw transactions; use the libs backend")
    }

    fn tx_known(&mut self, _txid: &str) -> Result<bool> {
        bail!("the devtool backend cannot ask the server about a transaction; use the libs backend")
    }

    fn broadcast(&mut self, signed: &[u8]) -> Result<String> {
        let input = self.scratch("broadcast.signed")?;
        fs::write(&input, signed)?;
        let out = self.run(&["pczt", "-w", self.w(), "send-without-storing", path_str(&input)])?;
        out.lines()
            .map(str::trim)
            .find(|l| l.len() == 64 && l.chars().all(|c| c.is_ascii_hexdigit()))
            .map(String::from)
            .ok_or_else(|| anyhow!("broadcast printed no txid: {out}"))
    }
}
