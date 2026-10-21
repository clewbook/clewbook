# Patches, forks and departures from stock Zcash tooling

This page lists every piece of outside code we carry in modified form, and every place where Clewbook does something stock Zcash tooling does
not. Clewbook's own code (in `app/`) is not listed: it is ours, under the project licence.

## 1. The one fork: zcash-devtool

| | |
|---|---|
| **What** | zcash-devtool, the command line wallet tool by the Electric Coin Company (https://github.com/zcash/zcash-devtool). Our modified copy is the folder `src/` and the root `Cargo.toml` and `Cargo.lock`. |
| **Upstream base** | commit `5a26ee8`, "Merge pull request #239 from zcash/librustzcash-releases", 28 August 2026 (https://github.com/zcash/zcash-devtool/commit/5a26ee8). This repository's history starts later, so the base commit is not in it. |
| **Licence** | Upstream's: MIT OR Apache-2.0. The copyright line of the Electric Coin Company stays in `LICENSE-MIT`; upstream file headers are unchanged. Upstream's own warning applies: it is for prototyping, not production. |
| **Why** | Refund tickets are transactions signed in advance that never expire. The tool at that revision could not sign a spend from the Ironwood shielded pool, and had no way to build a transaction without an expiry height, to discard the sender's outgoing viewing key, or to keep one coin reserved for its ticket. |
| **Size** | 49 files changed: 1342 lines added and 1117 removed, most of them in the lock file. Every file is listed, with what changed, in [CHANGES.md](../CHANGES.md). |

**The four changes that add behaviour.**
1. **`pczt sign` signs Ironwood spends with the Orchard spending key.** Before this fix, extracting the transaction failed with
   `MissingSpendAuthSig`. More on how we found it: [FINDINGS.md](FINDINGS.md), section 1.
2. **`pczt create` gained four options:**
   - `--expiry-height` (0 builds a transaction that never expires);
   - `--discard-ovk` (the sender discards the key that would let it read the recipient later);
   - `--min-confirmations`;
   - `--spend-locked-by` (spend one chosen coin that is reserved for this purpose).
3. **`wallet lock-note` is a new command.** It reserves a coin so the wallet does not spend it for anything else, which keeps a refund
   ticket spendable. It uses the wallet library's own locking interface (`OutputLockStore`, `LockOwner` in `zcash_client_backend`).
4. **`pczt inspect` and `wallet get-info` show the expiry height and the consensus branch id.**

Everything else in the fork is adaptation to the NU7 prerelease libraries and to the newer random number interface (rand 0.10), with no
change in what the commands do.

**How to reproduce the diff.** In a clone that also has the upstream history:

```
git remote add upstream https://github.com/zcash/zcash-devtool
git fetch upstream
git diff 5a26ee8 HEAD -- src Cargo.toml Cargo.lock
```

**Where it is used.** The dashboard uses it to create a campaign's wallet. Some test scenarios use it to make real test network payments.
The host's default wallet backend uses the Zcash libraries directly (`app/host/src/libs.rs`); the tool is the fallback backend.

## 1b. A modified copy of the tlock library (blind bid auctions only)

| | |
|---|---|
| **What** | tlock 0.0.10, the Rust library for drand timelock encryption by Thibault Meunier (https://github.com/thibmeu/tlock-rs, crates.io `tlock` 0.0.10). Our copy is `app/vendor/tlock`. It is used only by blind bid auctions (SPEC §9). |
| **Licence** | Upstream's: MIT. Upstream's own note applies: "This software has not been audited." |
| **Changes** | (1) `ibe::decrypt` returns an error instead of panicking when a ciphertext has the wrong length or fails its check (upstream panics; a panic inside the browser module stops the whole page, and a person who bids could cause it with a bad lock). (2) The helper `xor` no longer panics (its callers check lengths first). (3) Added `decrypt_exact`, which opens exactly 16 bytes and keeps trailing zero bytes (upstream's `decrypt` drops them, which would lose about one bid in 256 without the marker byte). (4) Added `verify_round` and `ibe::verify_signature`, which check a drand round's signature against the network's public key. Nothing else is changed. |
| **Tests** | Upstream's tests pass on the copy; `app/core/src/bid.rs` tests open a bid locked to a real quicknet round with its published signature and check that altered, garbage and wrong round inputs are "no bid", never a panic. |

## 2. Library versions: published prereleases, no patched crates except the tlock copy (1b)

- Every library comes from crates.io. There is **no `[patch]` section and no git or local path dependency** in either workspace
  (`Cargo.toml`, `app/Cargo.toml`). A build from an empty cache downloads everything from crates.io (checked on 14 October 2026).
- The Zcash libraries are the **NU7 prerelease versions**, pinned exactly (for example `zcash_primitives = "=0.31.0-pre.0"`,
  `zcash_client_backend = "=0.25.0-pre.0"`, `pczt = "=0.10.0-pre.0"`), because NU7 and its Ironwood pool are only in those versions. A few
  of them are used with their `unstable` feature, which turns on interfaces their authors may still change (for example the coin locking
  above).
- These versions know the test network's NU7 activation (height 4,465,026). They do not know a main network activation height yet, so
  before the main network's NU7 they need an update. [MAINNET.md](MAINNET.md) explains what the host program does until then.

## 3. Where Clewbook departs from stock Zcash tooling

| What | Stock tooling | What Clewbook does, and why | Where |
|---|---|---|---|
| Refund tickets | A wallet signs a transaction when it sends it, with an expiry height | The host signs, at contribution time, a spend of the contribution back to the contributor, with **no expiry height**, the outgoing viewing key discarded, and the coin reserved; it seals it to the contributor. It is valid for one consensus branch only | `app/host/src/ticket.rs`, `app/core/src/ticket_blob.rs`, SPEC §3 |
| The memo | Free text, or a ZIP 321 message | A sealed note: a libsodium style sealed box to the campaign's key, holding the contributor's refund receiver, a key the ticket is sealed to, and the amount they intend to pay, so a copied memo cannot take a contribution for less | `app/core/src/payload.rs`, SPEC §2 |
| The public list | None | A chained list signed with Ed25519, published to simple HTTP relays, recounted against the chain | `app/core/src/ledger.rs`, `app/relay`, SPEC §4 to §6 |
| Chain data in the browser | Wallets talk gRPC to lightwalletd | The pages talk gRPC web to public lightwalletd servers, and compare two independent servers before passing. For servers that do not allow browser requests, the page server forwards a small allow list of requests | `app/web/www/recount.js`, `app/web/serve.py` (`/grpc` route) |
| The browser module | Not a stock target | The Zcash libraries compiled to WebAssembly. The one C library they need, `secp256k1-sys`, is compiled with Zig's bundled clang, and `getrandom` uses the browser's random source. Builder folder names are removed from the module | `app/web/build.sh`, `app/web/tools/wasm-cc`, `app/.cargo/config.toml` |
| Talking to lightwalletd from the host | No time limit by default | A 20 second connect limit and keepalive pings, so a stalled server cannot hang the host | `app/host/src/libs.rs` |
| A host's own locks | | One host program per campaign folder (a system lock), so two programs never write the same list | `app/host/src/lock.rs` |

## 4. Not patched

- **No Zcash protocol rule is changed.** Tickets and payments are ordinary shielded transactions, valid under the network's own consensus
  rules.
- **No change to `orchard`, `zcash_primitives` or any other library's source.**
- The fonts are the published font files, under the SIL Open Font License (`app/web/www/fonts/`).
