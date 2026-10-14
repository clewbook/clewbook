<p><img src="app/web/www/img/clewbook-lockup-colour.svg" alt="Clewbook" width="320"></p>

**Private Markets. Public Accounting.**

Clewbook runs fundraisers and auctions on Zcash. Contributions go to a shielded address, so who paid and where a refund goes stay off the public record. The campaign's books are public: the host publishes a signed list of every contribution, and anyone can recount the campaign against the Zcash chain in their own browser, check by check, with no account and nothing to install. Every contributor also holds a refund ticket that can return their money without the host.

- **Private contributions.** Who paid and where a refund goes stay off the public record (the host still sees what it receives).
- **Public books anyone can recount.** Checks R1 to R12 run in the browser against the chain itself, and say pass or fail with the evidence.
- **Refund tickets.** Each contributor holds a refund transaction signed in advance, which works without the host while the contribution is unspent.

## Live

- **The app:** https://app.clewbook.xyz (live campaigns on the main network and the test network).
- **The demo:** https://clewbook.xyz/demo/ (test network campaigns, no wallet needed).
- **The proofs:** https://clewbook.xyz/demo/proofs/ (13 finished test campaigns, including dishonest hosts that the recount catches; each recount runs in your browser).

## How it works

```
                      pays to a shielded address,
                      with a sealed note in the memo
   Contributor  ─────────────────────────────────────▶  Zcash chain  ◀──────────────────┐
        ▲                                                  ▲                            │ reads the blocks
        │ refund ticket, signed in advance                 │ watches the campaign       │
        │                                                  │ wallet                     │
        └─────────────────────────────  Host program  ─────┘                            │
                                        (cb-host)                                       │
                                            │ signs and publishes the list              │
                                            ▼ and the sealed tickets                    │
                                         Relays  ────── the signed list ──────▶  Recount, in anyone's browser
                                                                                 (pages from the page server)
```

1. **The host** creates a campaign: its rules (type, goal, deadline, ticket window and so on) are fixed by the campaign id, a hash of the rules.
2. **A contributor** makes a payment code on the contribute page and pays from their own wallet. The memo carries a note sealed to the host, with the contributor's refund address.
3. **The host program** sees the payment, writes a signed entry to the campaign's public list, and issues a **refund ticket**: a transaction signed in advance that pays the contributor back, sealed so that only they can open it. Both go to the **relays**, small services that store and serve the list.
4. **Anyone** can open the Recount page. It reads the list from the relays and the blocks from public Zcash servers, and checks one against the other in the browser (WebAssembly). The same recount is a command line tool, `cb-recount`.
5. **At the close** the host keeps what the rules say it keeps and refunds everything else with the stored tickets. If the host never closes, contributors can send their own tickets.

Details of what is public and what is not: [docs/PRIVACY.md](docs/PRIVACY.md). The formats and rules: [SPEC.md](SPEC.md).

## The checks

| Check | One line |
|---|---|
| R1 | The rules (and an auction's revealed key) match what the campaign committed to. |
| R2 | The list is signed, chained, has no gaps, and was closed at most once, after the deadline (or early, only where the rules allow it). |
| R3 | Every entry on the list is a real payment to the campaign. |
| R4 | Every contribution has a refund ticket once the ticket window has passed. |
| R4b | Each ticket was issued within the window, going by the issue height the host writes (the host's own report). |
| R5 | No contribution was spent before the deadline, except by its own ticket. |
| R6 | Contributions that are not kept left the campaign only through their own tickets. |
| R7 | The declared outcome (goal met or missed; an auction's winners and price) is what the rules select. |
| R8 | No published proof shows that a payment the host set aside was in fact valid. |
| R9 | Uniform price auction: each winner paid exactly the clearing price into the treasury, with the exact fee. |
| R10 | Uniform price auction: the treasury received exactly the sum of the clearing prices. |
| R11 | Uniform price auction: settlements returned no value to the campaign and have no other outputs. |
| R12 | Uniform price auction: the proofs winners published that their excess came back hold. |

What each check needs, and what it does not show: [docs/CLAIMS.md](docs/CLAIMS.md) and [docs/CHECKS.md](docs/CHECKS.md).

## Campaign types

- **Fundraiser:** a goal and a deadline. If the goal is not met, everyone is refunded. Options chosen at creation, part of the signed rules:
  - **early close:** the host may close as soon as the goal is met;
  - **hard cap:** the most the campaign keeps. The goal then becomes the soft cap. At the close, payments are kept in chain order while they fit; one that does not fit is refunded whole by its own ticket.
- **Auction:** a number of items; the highest bids win, everyone else is refunded. Bid amounts stay off the public record until the close (the host sees them as they arrive). Two ways to pay:
  - **uniform price:** every winner pays the same price (the lowest winning bid, or the reserve when there are fewer bids than items) and gets the rest back;
  - **pay your bid:** each winner pays their whole bid.

An auction can never close early.

## Built on

Clewbook is built on the Zcash libraries by the Electric Coin Company and the Zcash community, all under **MIT OR Apache-2.0**:

- `orchard` (the shielded protocol behind our payments, tickets and refund addresses; the Ironwood pool of the NU7 upgrade uses its addresses), `sapling-crypto`, `halo2_proofs`;
- `zcash_primitives`, `zcash_protocol`, `zcash_address`, `zcash_keys`, `zcash_note_encryption`, `zcash_proofs`;
- `zcash_client_backend` and `zcash_client_sqlite` (the wallet), `pczt` (transactions built in steps, which is how a ticket is signed in advance), `zip32`, `zip321`, `incrementalmerkletree`;
- the **zcash-devtool** wallet tool (patched, see below).

Other libraries:
- `ed25519-dalek` (BSD-3-Clause), which signs the list;
- `crypto_box` (MIT OR Apache-2.0), which seals the memo note and the tickets;
- `blake2b_simd` (MIT), for hashes and the campaign id;
- `age` (MIT OR Apache-2.0), which locks the wallet key file;
- `tonic` (MIT), which talks to lightwalletd servers;
- `rusqlite` (MIT);
- `wasm-bindgen` (MIT OR Apache-2.0), for the browser module.

Fonts are under the SIL Open Font License; the browser tests use Playwright, jsQR and pngjs.

Every library and its licence: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What we patched, and why

- **zcash-devtool**, the command line wallet tool by the Electric Coin Company, forked at upstream commit **`5a26ee8`** (28 August 2026). It lives in `src/`.
- **Why:** refund tickets are transactions signed in advance that never expire, and the tool at that revision could not sign a spend from the Ironwood pool.
- **Four changes add behaviour:**
  - `pczt sign` signs Ironwood spends (a fix);
  - `pczt create` gained a no expiry option, a way to discard the sender's outgoing key, a confirmations setting, and a way to spend one chosen coin;
  - a new `wallet lock-note` command reserves a coin for its ticket;
  - `pczt inspect` and `wallet get-info` show the expiry height and the network version.
- **Everything else** is adaptation to the NU7 prerelease libraries.

Every patch and every place we depart from stock Zcash tooling: [docs/PATCHES.md](docs/PATCHES.md). Every changed file: [CHANGES.md](CHANGES.md).

## Evidence

- **Unit tests:** 179, no network needed (`cd app && cargo test`, last run 14 October 2026). They include fake cheating hosts that the recount must catch.
- **Browser and test network suites:** contribute, recount, auction, dashboard, capability card, badge, names, heartbeat, saved copies, hard cap and more, each with its count. The full table is in [docs/TESTS.md](docs/TESTS.md).
- **Saved campaign regression:** after each change to the core, every finished test network campaign saved locally is recounted again. At the last change (the hard cap), all 151 gave text identical line for line.
- **Hard cap on the test network:** 15 of 15 checks, including a cheating host that keeps a payment over the cap and is caught by R6, and an older relay refusing a capped campaign (`app/cap-e2e.sh`).
- **Demo proofs:** 13 finished test campaigns, at https://clewbook.xyz/demo/proofs/. They include dishonest hosts the recount catches: a host spending contributions (R5, R6), closing early against its rules (R2), settling late (R9), and keeping a payment over the cap (R6). The demo suite passed 35 of 35 against the live demo on 14 October 2026.
- **A real late ticket, on the main network:** the Clewbook Pre-seed Raise (campaign `65d68e70…`) received a contribution while its host was down on 11 October 2026. The ticket came 80 blocks late, and the public recount shows it: R4b fails, naming the payment, the height the host reports and the height it was due by.
- **Main network runs:** [docs/EVIDENCE.md](docs/EVIDENCE.md), section 8.

## Honest limits

- **The host holds the campaign's keys, on one machine.** It can spend a contribution that has a ticket. The recount shows it afterwards (R5, R6), but nothing prevents it. The keys are plain files in the campaign folder.
- **No outside review.** The code and the design have not been reviewed by anyone outside the project. The tests and evidence here are ours.
- **Some heights are the host's own statement:** when a ticket was issued (R4b) and when an early close happened.
- **The host sees every bid** in an auction as it arrives, and could bid itself from another wallet.
- **A ticket is valid for one network version.** Tickets signed before a network upgrade must be issued again after it. The main network's next upgrade (NU7) is announced for 5 November 2026. Until this build's libraries are updated for it, the host program accepts only main network campaigns that end at least a week before that date.
- **Network addresses are not hidden:** relays and public chain servers see who contacts them.

All limits: [docs/LIMITS.md](docs/LIMITS.md). Who can do what, and what stops them: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Mainnet and the upgrade: [docs/MAINNET.md](docs/MAINNET.md).

## Run it yourself

**What you need:**
- Rust (stable, 1.88 or newer, with `rustup`), Python 3, and Node 22 (for the browser tests);
- for the browser module: `rustup target add wasm32-unknown-unknown`, `cargo install wasm-bindgen-cli --version 0.2.129`, and Zig 0.14 (https://ziglang.org/download/).

Tested on Ubuntu under WSL 2. A first build takes about 20 minutes.

```
cd app && cargo build --release        # cb-host, cb-contrib, cb-recount, cb-relay in app/target/release
cd .. && cargo build --release         # the patched wallet tool, target/release/zcash-devtool
ZIG=/path/to/zig app/web/build.sh      # the browser module, into app/web/www/pkg and app/web/www/proof
```

A local trial on the test network, from the repository root:

```
python3 app/web/serve.py 8770                                                     # the pages, http://127.0.0.1:8770/
./app/target/release/cb-relay serve --dir runs/relay1 --listen 127.0.0.1:8787    # a relay (a second one on 8788 with runs/relay2)
./app/target/release/cb-host serve --relay http://127.0.0.1:8787 --relay http://127.0.0.1:8788   # set up page and dashboard, http://127.0.0.1:8780
```

To pay a test campaign you need test network coins: [docs/HOSTING.md](docs/HOSTING.md), section 3, names the public faucet we used (not run by us) and shows how to make a wallet. To recount the example campaigns with no wallet at all, see [docs/DEMO.md](docs/DEMO.md). Hosting a campaign, a relay and the pages: [docs/HOSTING.md](docs/HOSTING.md). Running the tests: [docs/TESTS.md](docs/TESTS.md).

## More

- **Roadmap:** [docs/ROADMAP.md](docs/ROADMAP.md).
- **All documents:** [docs/README.md](docs/README.md).
- **The story of how it was built:** [docs/HOW_IT_WAS_BUILT.md](docs/HOW_IT_WAS_BUILT.md).

## Licence

Licensed under either of the Apache License, Version 2.0 (`LICENSE-APACHE`) or the MIT licence (`LICENSE-MIT`), at your option: **MIT OR Apache-2.0**. Copyright 2026 the Clewbook contributors (see `NOTICE`). The patched copy of zcash-devtool in `src/` keeps its upstream copyright line (The Electric Coin Company) in `LICENSE-MIT` and is covered by the same two licences. The outside libraries and their licences are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Unless you say otherwise, a contribution you submit for inclusion is licensed as above, with no extra terms.
