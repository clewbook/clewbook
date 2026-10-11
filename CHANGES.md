# Changes to zcash-devtool

The folder `src/` and the root `Cargo.toml` and `Cargo.lock` are a modified copy of zcash-devtool (https://github.com/zcash/zcash-devtool), a command line wallet tool by the Electric Coin Company, used under its licences (MIT or Apache-2.0, see LICENSE-MIT, LICENSE-APACHE and NOTICE). This file lists every change we made to it.

- **Base:** upstream commit `5a26ee8`, "Merge pull request #239 from zcash/librustzcash-releases", dated 28 August 2026. That commit exists in the upstream repository. This repository starts its own history later, so the base is not in it.
- **Size:** 49 files changed, 1342 lines added and 1117 removed, most of them in the lock file, made in 13 of our commits on 4 and 5 October 2026 (the table counts lines per file).
- **Why:** the project needs refund tickets, which are transactions signed in advance that never expire. The upstream tool at that revision could not sign a spend from the Ironwood shielded pool and had no way to build a no expiry transaction, discard the sender's recipient key, or reserve a coin. The tool also had to move to the NU7 prerelease libraries, because the Zcash test network activated that network upgrade early.
- **Not changed:** upstream source file headers and licence texts. We have not checked whether upstream has since fixed or changed any of the points below.
- **How to see the exact changes:** in a clone that also has the upstream history, run `git diff 5a26ee8 HEAD -- src Cargo.toml Cargo.lock`.

## The changes that add behaviour

1. `pczt sign` signs Ironwood spends with the Orchard spending key (a fix).
2. `pczt create` gained `--expiry-height`, `--discard-ovk`, `--min-confirmations` and `--spend-locked-by`.
3. `wallet lock-note` is a new command that reserves a coin.
4. `pczt inspect` and `wallet get-info` show the expiry height and the consensus branch ID.

Everything else is adaptation to the prerelease libraries and the new random number interface, with no change in what the commands do.

## Every changed file

| File | Lines | What changed |
|---|---|---|
| Cargo.lock | +1014 / -1001 | Regenerated for the library versions above. |
| Cargo.toml | +26 / -25 | Library versions moved to the NU7 prerelease Zcash crates (zcash_primitives, zcash_client_backend, zcash_client_sqlite, zcash_keys, zcash_address, zcash_protocol, zcash_proofs, zip321, pczt and related), plus rand 0.10, secp256k1 0.33, jubjub 0.11, group 0.14 and incrementalmerkletree 0.9. |
| src/commands/inspect.rs | +2 / -2 | Adapted to the prerelease address and key APIs. |
| src/commands/inspect/address.rs | +4 / -3 | Adapted to the prerelease address and key APIs. |
| src/commands/inspect/keys.rs | +14 / -7 | Further adaptation so it builds against the NU7 prerelease libraries; adapted to the prerelease address and key APIs; passes the clock and random source the prerelease transaction builders now need. |
| src/commands/inspect/keys/view.rs | +16 / -4 | Further adaptation so it builds against the NU7 prerelease libraries; adapted to the prerelease address and key APIs; passes the clock and random source the prerelease transaction builders now need. |
| src/commands/inspect/transaction.rs | +7 / -5 | Further adaptation so it builds against the NU7 prerelease libraries; adapted to the prerelease address and key APIs. |
| src/commands/keystone.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/migration/advance.rs | +2 / -2 | Further adaptation so it builds against the NU7 prerelease libraries; uses the operating system random source through the rand 0.10 interface. |
| src/commands/migration/commit.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/migration/plan.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/migration/status.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/pczt/create.rs | +47 / -7 | New options `--expiry-height` (a transaction that never expires), `--discard-ovk` (the sender discards the key that would let anyone read the recipient), `--min-confirmations`, and `--spend-locked-by` (spend one chosen reserved coin); also adapted to the prerelease APIs. |
| src/commands/pczt/create_manual.rs | +2 / -2 | Adapted to the prerelease PCZT and cryptography library APIs; uses the operating system random source through the rand 0.10 interface. |
| src/commands/pczt/create_max.rs | +3 / -1 | Adapted to the prerelease address and key APIs; passes the clock and random source the prerelease transaction builders now need; uses the operating system random source through the rand 0.10 interface. |
| src/commands/pczt/extract.rs | +3 / -1 | Adapted to the prerelease PCZT and cryptography library APIs. |
| src/commands/pczt/inspect.rs | +6 / -0 | `pczt inspect` now also shows the expiry height and the consensus branch ID. |
| src/commands/pczt/pay_manual.rs | +2 / -2 | Adapted to the prerelease PCZT and cryptography library APIs; uses the operating system random source through the rand 0.10 interface. |
| src/commands/pczt/prove.rs | +17 / -16 | Further adaptation so it builds against the NU7 prerelease libraries; adapted to the prerelease PCZT and cryptography library APIs. |
| src/commands/pczt/qr.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/pczt/send.rs | +3 / -1 | Adapted to the prerelease PCZT and cryptography library APIs; uses the operating system random source through the rand 0.10 interface. |
| src/commands/pczt/send_without_storing.rs | +2 / -2 | Adapted to the prerelease PCZT and cryptography library APIs. |
| src/commands/pczt/shield.rs | +3 / -1 | Passes the clock and random source the prerelease transaction builders now need; uses the operating system random source through the rand 0.10 interface. |
| src/commands/pczt/sign.rs | +39 / -2 | Fix: signs Ironwood spends with the Orchard spending key (before, extraction failed with MissingSpendAuthSig); also adapted to the prerelease APIs. See docs/FINDINGS.md section 1. |
| src/commands/pczt/update_with_signature.rs | +0 / -1 | Adapted to the prerelease address and key APIs. |
| src/commands/wallet.rs | +4 / -0 | Registers the new `lock-note` command. |
| src/commands/wallet/balance.rs | +2 / -2 | Further adaptation so it builds against the NU7 prerelease libraries; adapted to the prerelease address and key APIs. |
| src/commands/wallet/delete_account.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/derive_path.rs | +4 / -3 | Further adaptation so it builds against the NU7 prerelease libraries. |
| src/commands/wallet/enhance.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/fan_out.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/gen_account.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/gen_addr.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/get_info.rs | +1 / -0 | `wallet get-info` now also reports the server's consensus branch ID. |
| src/commands/wallet/import_ufvk.rs | +2 / -2 | Adapted to the prerelease address and key APIs; uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/init_fvk.rs | +1 / -1 | Adapted to the prerelease address and key APIs. |
| src/commands/wallet/list_addresses.rs | +1 / -1 | Further adaptation so it builds against the NU7 prerelease libraries. |
| src/commands/wallet/lock_note.rs | +78 / -0 | New command `wallet lock-note`: marks one coin as reserved so the wallet will not spend it for anything else (used to keep a refund ticket spendable). |
| src/commands/wallet/propose.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/reset.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/send.rs | +3 / -1 | Passes the clock and random source the prerelease transaction builders now need; uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/shield.rs | +3 / -1 | Passes the clock and random source the prerelease transaction builders now need; uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/sync.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/tree/fix.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/commands/wallet/upgrade.rs | +1 / -1 | Uses the operating system random source through the rand 0.10 interface. |
| src/data.rs | +1 / -5 | Passes the clock and random source the prerelease transaction builders now need; uses the operating system random source through the rand 0.10 interface. |
| src/helpers/pczt/create_manual.rs | +1 / -1 | Further adaptation so it builds against the NU7 prerelease libraries. |
| src/main.rs | +2 / -0 | Registers the new command and the random source shim. |
| src/rng.rs | +12 / -0 | New file: a small shim that hands the operating system random source to code written for the older random number interface. |
