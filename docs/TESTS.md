# Tests

Moved here from the README on 14 October 2026, unchanged.

## Tested behaviour

Every claim below has a test in the repository. Not every test was rerun on the same day, so here is what ran when.

**Run on 14 October 2026, all passing:**
- the unit tests: 179 (`cd app && cargo test`, no network);
- the saved campaign regression: 151 of 151 finished test campaigns recounted with identical text, line for line, before and after the hard cap change;
- the hard cap on the test network: `app/cap-e2e.sh`, 15 of 15;
- the browser suites after the rollout that day:
  - `cap-pages-e2e.cjs` 23;
  - `static-e2e.cjs` against the live demo 35;
  - `card-e2e.cjs` 31;
  - `pages-e2e.cjs` 33;
  - `polish-b.sh` 74;
  - `heartbeat.sh` 19 (its old relay sub check was skipped: no old relay was running);
  - `back-e2e.cjs` 33;
  - `polish-a-e2e.cjs` 39;
  - `check-vercel.sh` 34.

**Last run earlier, and not rerun since the latest page changes:** the suites that make real test network payments, among them:
- `contribute-e2e.cjs`, last run early on 14 October in a clean copy of the repository, before that day's page changes;
- `contribute-e2e2.cjs`, `contribute-e2e-reject.cjs`, `challenge.sh`, `junk-ticket.sh`, `dashboard.sh`;
- the `app/e2e-*.sh` and `app/auction-e2e.sh` scenarios, and `app/stress-e2e.sh`.

Also last run earlier: `host-pages.sh`, `recount-auction-e2e.cjs`, `auction-page-e2e.cjs`, `recount-hash-e2e.cjs`, `badge-e2e.cjs`, `mainnet-guard.sh`, `loadguard-e2e.cjs`, `saved-copy.sh`, `final-copy.sh`, `copies.sh`, `stage-h-e2e.cjs`, `close-resume.sh`, `claim-refund.sh`, `restore-paths-test.sh` and `serve-test.py`. Each passed when it last ran, between 8 and 14 October 2026.

The browser and scenario tests run against the test network, most of them with real payments; the mainnet guard test uses no wallet and no money; the unit tests need no network.

| Claim | Test |
|---|---|
| Contributing end to end, including real payments and a refund | `app/web/contribute-e2e.cjs`, 35 checks |
| Restore from a backup; relays down or disagreeing | `contribute-e2e2.cjs`, 8 checks |
| A cheating host that wrongly rejects a valid payment is caught by the recount (R8) once the contributor publishes proof | `contribute-e2e-reject.cjs`, 11 checks |
| The "Publish proof" button: nothing is published without the press; underpaid, replayed and wrongful rejects; overpayment | `app/web/challenge.sh` with `challenge-e2e.cjs`, 22 checks |
| Junk and malformed tickets show a red notice and are never shown as received and checked | `app/web/junk-ticket.sh`, 45 checks |
| The ticket check fails a ticket that pays back less than the amount paid minus the fee, on auctions as well as fundraisers | `app/web/ticket-amount-e2e.cjs`, 8 checks |
| Campaign and recount pages, relay and server failures | `pages-e2e.cjs` |
| Uniform-price auction recount and contributor page | `recount-auction-e2e.cjs` (7), `auction-page-e2e.cjs` (17) |
| Host set-up page and dashboard, from creating a campaign to closing it | `setup-e2e.cjs` and `dashboard-view-e2e.cjs` (33, via `host-pages.sh`), `app/web/dashboard.sh` (25) |
| The report hash is canonical and repeatable | `recount-hash-e2e.cjs`, 9 checks |
| Hard cap: kept in chain order while it fits, a payment over it refunded whole by its own ticket, the soft cap counted on what is kept; a host that keeps a payment over the cap fails R6 | unit tests in `app/core/src/recount/tests.rs` (9), `app/host/src/main.rs` (1) and `app/relay/tests/api.rs` (1); on the test network `app/cap-e2e.sh`, 15 checks: below the soft cap, between the caps, a payment that crosses the cap, a large payment then smaller ones, a withdrawal after the cap was reached, an early close, a cheating host (only R6 fails), and an older relay refusing a capped campaign |
| Hard cap on the pages (soft cap and hard cap, room left, an amount that does not fit refused, the note before payment, the set up field only on a host that knows the cap) and the recount page for an auction that has not closed (R1 and R2 PASS, the rest WAIT) | `app/web/cap-pages-e2e.cjs`, 23 checks |
| Mainnet guards (banner, confirmation, NU7 cut-off); no money, no wallet | `mainnet-guard.sh`, 15 checks; unit tests in `app/host/src/mainnet.rs` |
| Badge and capability card | `badge-e2e.cjs` (13), `card-e2e.cjs` (29) |
| Contributor page: status badge, heading by type, the one-line pre-payment note, start over / earlier codes, late-ticket notice (stand-in chain server, no money) | `app/web/polish-a-e2e.cjs`, 39 checks |
| Contributor page, payment step at phone width: "Edit amount" button, phone back gesture, payment already seen, replaced code, blocked storage, fundraiser and auction (stand-in chain server, no money) | `app/web/back.sh` / `app/web/back-e2e.cjs`, 33 checks |
| Campaign names: refused when too long, with markup or invisible characters (command line and dashboard form), shown as plain text on every page, never a forged name, old campaigns unchanged | `app/web/polish-b.sh` with `polish-b-e2e.cjs`, 74 checks; `cargo test -p ll-core name_tests` |
| A restored copy of a campaign folder never silently uses another folder's wallet | `app/restore-paths-test.sh` (8 checks), `cargo test -p ll-host path_tests` (6 tests) |
| The static demo recounts the five example campaigns from plain files, shows the deadline and the close block, and makes no request except to the folder and the public test-network servers; the same checks can run against a deployed copy (`BASE_URL=…`) | `app/web/static-e2e.cjs`, 26 checks |
| The folder to upload to a static host holds no name, id, key, wallet or local path, no tracking, loads nothing from other sites, and its `vercel.json` headers (wasm content type, security policy) work | `app/web/check-vercel.sh`, 13 checks; `app/audit.sh --folder` |
| A page whose scripts fail to load, or that waits on silent servers, says so after 20 seconds and offers Reload; it stays quiet when all is well | `app/web/loadguard-e2e.cjs`, 19 checks |
| The recount page, when no relay answers, names the addresses it tried and recounts from a saved copy of the public list (the host's export, by command or from the dashboard); a copy with a changed entry, a missing or repeated entry, changed rules or another campaign's number is refused; the result says it comes from a file | `app/web/saved-copy.sh` with `saved-copy-e2e.cjs`, 24 checks |
| The host publishes a signed "last seen" record; relays keep only a newer one and refuse forged, foreign and replayed ones; the contributor page shows fresh, stale and missing, and never a forged one as fresh | `app/web/heartbeat.sh` with `heartbeat-e2e.cjs`, 20 checks; `cargo test -p ll-core heartbeat` (5), `cargo test -p ll-relay` (2 heartbeat tests) |
| Closing a campaign when a payment has no refund ticket (the host was not running when it arrived): the missing ticket is issued first, then the payment is refunded (goal missed), swept (goal met) or settled/refunded (uniform auction); nothing is left behind | `app/e2e-unticketed.sh` (testnet, three scenarios, with the program as it was before for comparison), `cargo test -p ll-host restart_hint` (the dashboard note) |
| The host saves the final public copy at close and signs its fingerprint (number of entries and hash of the last one); relays keep it; the recount page compares any list with it: a full copy matches, a copy with its end cut off or a different history signed with the same key is shown as not matching, a copy stripped of its record is said to have no fingerprint | `app/web/final-copy.sh` with `final-fp-e2e.cjs` (26 checks), `cargo test -p ll-core final_copy` (6), `cargo test -p ll-relay` (3 final-record tests) |
| A person can save a copy of the full list from the recount and contributor pages; the browser remembers each campaign's entry count and last-entry hash and warns, in plain words, when a later list is shorter or has a different entry in that place (a cut-off list, a different history signed with the same key, an empty list); it still works, and says so, when the browser blocks storage; "Compare with my saved copy" lists entries missing, extra or changed; a 20,000-entry list is handled | `app/web/copies.sh` with `copies-e2e.cjs` (39 checks, saved ledgers only) |
| One host program per campaign folder, whatever name it was started under (`cb-host`, `ll-host`): a second one refuses; a crashed one's lock is replaced; two started at the same moment give exactly one winner; two writers can never both write the same ledger entry | `cargo test -p ll-host --test lock` (3 tests), `cargo test -p ll-host lock::tests` (5 tests), `cargo test -p ll-core append_tests` (1 test) |
| After the close entry, a step that fails (sweep, settlement, a refund) is recorded; "Try again" (or the next check) does only what is left and never sends a refund twice; a close that stops before its entry writes nothing; a settlement sent just before a crash gets its entry on the rerun, once | `cargo test -p ll-host close_resume_tests` (2 tests), `cargo test -p ll-host settle_resume_tests` (2 tests) |
| Payments mined after the deadline are listed by `cb-host late` (and only those) | `cargo test -p ll-host late_tests` (1 test) |
| The page server reachable through the tunnel serves only the public pages and what they load, with the same security headers as the hosted copy; it refuses a POST body over 64 KiB and never runs more than 32 requests at once | `python3 app/web/serve-test.py` (33 checks) |
| The relay's limits: campaigns per relay, entries per campaign, request size, requests at once, requests per minute per source (behind the tunnel, the client address the tunnel passes on); a program on the same computer is not limited | `cargo test -p ll-relay --test limits` (6 tests) |
| Private files of the host (keys, signed tickets, the outbox, the lock) are created readable by this user only, in folders only this user can open | `cargo test -p ll-host permission_tests` (1 test) |
| The contributor page at phone width: on the payment step one caution line is always visible, and every caution is one plain grey sentence of at most 20 words (normally, near the deadline, with blocked storage, after the amount was changed); no new payment code in the last 10 blocks before the deadline; every ticket is fetched, in random order, so a relay cannot tell which is the visitor's | `app/web/stage-h-e2e.cjs` (27 checks, stand-in chain server, no money) |
| A close whose sweep fails (test-only switch) is closed but unfinished; the dashboard says so in one sentence, "Try again" while it still fails sends nothing, and once it can, "Try again" sends exactly one sweep; the recount then passes (testnet, real browser, 2026-10-10) | `app/web/close-resume.sh` with `close-resume-e2e.cjs` (12 checks) |
| The host's refund at the close never reaches the network (test-only dropping server) and the host is not run again: after the ticket window the contributor page offers "Claim my refund", and the refund it sends is the same pre-signed transaction and is mined (testnet, real browser at 390 px, 2026-10-10) | `app/web/claim-refund.sh` with `claim-refund-e2e.cjs` (10 checks) |
| A uniform-price auction whose close stops dead after the first settlement is sent: the rerun writes that settlement's entry from the outbox record and settles the rest, one entry and one transaction per winner; a bid withdrawn before the deadline drops out and the clearing price comes from the bids left (R1 to R12 pass) (testnet, 2026-10-10) | `CRASH=1 app/auction-e2e.sh`, `WITHDRAW=B app/auction-e2e.sh` |
| Five payments of which three arrived while no host program ran: the close writes their ticket entries first and then refunds all five (goal missed) or sweeps all five (goal met) (testnet, 2026-10-10) | `app/e2e-unticketed.sh many-missed`, `app/e2e-unticketed.sh many-met` |
| Rules and recount logic against fake cheating hosts | `cargo test -p ll-core` (63 tests, `app/core/src/recount/tests.rs`) |
| 40 contributions from 5 payer wallets over 36 blocks, ticket window 30 blocks: every contribution got a ticket, R1 to R8 all pass, ticket delay 0 blocks | `app/stress-e2e.sh` (a script with a printed timeline, not a fixed number of checks) |

The stress test was not a same-block burst: at most 5 contributions arrived per block. The host issued tickets about 4 seconds apart when several were waiting (median gap), so 40 tickets would take about 160 seconds if they all waited at once; that is arithmetic from the measured gap, not a measured burst. The run used one host machine and the public testnet server, and had no closing or refund phase.

**The funded test run of 2026-10-10.** Several of these tests ran at the same time and overloaded the public testnet server, which then reset connections. As a result the close scenarios were completed in two parts: the first run passed A to D, but in it B's early withdrawal went out after the deadline (so it counted as a refund) and two of D's bids were mined after the deadline (late payments, so D had no losing bid to refund); in the rerun of B and D a test-script fault stopped the run before the close, and B and D were then closed by hand with `cb-host close`, after which their recounts were run (B passes R1 to R8; D passes all but R4, which correctly names the three tickets the close had to issue late because D's host program had hung on the stalled server). Early withdrawal before the deadline is covered by the auction withdrawal test (`WITHDRAW=B app/auction-e2e.sh`), not by close scenario B.

## Running the tests

```
cd app && cargo test                    # unit tests (179 in the last run, 14 October 2026, no network; the host's tests run under both of its program names): rules, recount logic against fake cheating hosts, ticket checks, relay, host guards
cd app/vectors/js && npm ci && npx playwright install chromium   # the browser tests' dependencies and their browser; on Ubuntu also: sudo npx playwright install-deps chromium
```

The browser tests in `app/web/*.cjs` take their campaign from the environment (`LINK=http://127.0.0.1:8770/contribute.html#c=<id>&relay=…&relay=…`, and `LINK_AUCTION` for the capability card test). Without a wallet you can run `card-e2e.cjs`, `recount-hash-e2e.cjs`, `recount-auction-e2e.cjs` and `badge-e2e.cjs` against the examples above (for `recount-auction-e2e.cjs` use the auction's recount address as `LINK`, and for `badge-e2e.cjs` a `contribute.html` address). `app/audit.sh` (run before every push) and `app/privacy-test.sh` search for words kept in an untracked local file, `.local/forbidden-names.txt` (one `category: regex` per line; the categories are in the comment at the top of `app/audit.sh`), and stop with a message if it is missing. The scenarios that make real payments (`app/web/contribute-e2e.cjs`, `challenge.sh`, `dashboard.sh`, `app/stress-e2e.sh`, the `app/e2e-*.sh` scripts) need the wallet tool built, a testnet wallet named `bidder` with coins, and the relays and page server above running.
