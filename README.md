# Clewbook

Clewbook: fundraisers and auctions on Zcash with books anyone can check.

Contributions to a shielded raise or auction that keep **who paid and where a refund goes** off the public record, with books that anyone can recount in their browser.

Contributors pay a shielded address. The host publishes a signed ledger of what came in, and a recount page lets any visitor check that ledger against the chain without trusting the host. Every contributor also holds a refund ticket, signed in advance, that lets them take their money back without the host's help: before the deadline, or after it if the host has not closed within the campaign's ticket window.

The whole system was proven end to end on the Zcash testnet with NU7 active.
The main network has no NU7 yet, so the host program refuses campaigns that could still be open when it activates.

Not everything about a contribution is hidden. What is public and what is not (tested: see "Privacy" below):

| Public | Hidden |
|---|---|
| The campaign's rules: type, goal or number of items, deadline, smallest contribution, fee, ticket window, the address that receives payments, the host's public keys (and, in a uniform-price auction, the reserve, the treasury address and its viewing key). | **Who paid:** the paying wallet and its address, **when the payment comes from the payer's own shielded balance** (see "How to pay" below). |
| Each contribution's transaction id, output number, nullifier and block height, so when it arrived, and when it was spent or refunded. | **Where a refund goes:** the refund address, sealed inside the payment's memo. It is revealed for one payment only if that contributor chooses to "Publish proof" for it. |
| **Fundraiser:** each contribution's amount, and the campaign's viewing key, so anyone can see each payment's amount and its sealed memo. | **The contributor's secret** (the backup file): it stays on their device. |
| **Auction:** only a commitment per bid until the close. At the close the host reveals the viewing key and the amount key, so **every bid amount, including every losing bid, becomes public**, with the clearing price, the winners' nullifiers and each settlement's price, fee and excess. This is deliberate, and a consequence of how the recount works: it has to see all the bids to check that the right bids won and that the price is the one the rules give (R7 and R9 to R12), and anyone must be able to repeat that check. Who made each bid stays hidden. | The contents of the refund tickets (sealed to their owners; only an unreadable blob is public). |
| The sealed memo's length (it shows the payment code format) and the sealed ticket blobs. | Names: none are collected, asked for or published. |

Amounts and timing can still help someone who already knows a person's payment to find it in the ledger, and in a fundraiser every amount is public. Contributors' network addresses are not hidden by this project: the relays and the public chain servers see the address of whoever contacts them (see docs/THREAT_MODEL.md, threat 18). When the pages and the relay are reached through Cloudflare (the tunnel, or a site hosted behind it), Cloudflare also sees visitors' network addresses.

### How to pay, and why

The ledger names each payment's transaction, so whatever that transaction shows on the chain is linked to the campaign:

- **Pay from your own wallet's shielded balance.** A payment funded from transparent money (an exchange withdrawal, or a transparent address) shows the paying address and amount on the chain, so the ledger then links who paid to the contribution; in an auction it also shows the bid amount before the close.
- **Not from an exchange.** Besides the point above, an exchange may not be able to attach the payment's message (memo), and without it the campaign cannot track or ticket the contribution.
- **From the same pool as the campaign's address where you can.** Moving money between shielded pools (for example from Sapling, or from Orchard into Ironwood) shows the amount that crosses, which in an auction is close to the bid.

The contribute page says this in one line on the payment step; the reasons are here. The project does not detect how a payment was funded: the host could read a payment's transparent and cross-pool parts from the chain and flag them, but it cannot stop them, and a flag would come after the information is already public.

### When the host is not seen

The contribute page shows when the host was last seen. If it has not been seen lately, a payment made now is ticketed when the host comes back; if that takes longer than the ticket window, the ticket is late (R4 flags it) and, until it arrives, the refund depends on the host closing the campaign.

### Late payments

New payment codes stop 10 blocks before the deadline (a wallet may need a few minutes to sync and send, and a payment can wait a block or two to be mined). A payment mined after the deadline is not a contribution: it gets no ticket, it is not counted, it is not refunded by the close, and it stays in the campaign wallet. The host can list such payments with `./app/target/release/cb-host late --run <campaign folder>` (it reads the wallet file only) and return them by hand; the dashboard shows a line when there are any.

Built for the Zcash network. It runs today on the testnet that has activated NU7 (consensus branch 0x77190ad9), using the Ironwood shielded pool. Two small runs on the main network are recorded in docs/EVIDENCE.md section 8: one on 2026-10-06 with an earlier version of the payment code and pages, and a pilot on 2026-10-08 with the current version (one phone-wallet contribution, taken back with its ticket; one relay only, so the recount was marked limited). What was not tested there is listed in section 8 and in "Mainnet and NU7".

## Known limitations

- **Payments that arrive after the deadline are not counted and not refunded.** A payment mined after the deadline gets no ticket and no ledger entry, the close neither refunds nor sweeps it, and it stays in the campaign wallet. The host can list such payments with `cb-host late --run <campaign folder>` (tested on the testnet on 2026-10-10: it listed exactly the two bids of one test campaign that were mined after its deadline). Returning them is a manual step for the host today, with the ordinary wallet tools; a "return late payments" command is a future feature. What the payer sees has not been tested with a real late payment; from the page's code, a fundraiser payer whose page saw the payment is told after the ticket window that their refund ticket has not arrived and to keep the backup file and ask whoever runs the campaign, and an auction bidder's page, which cannot see bids before the close, keeps waiting for the payment.
- **A host that loses its connection to the chain server.** The host's connection now has a time limit: connecting must finish within 20 seconds, and a connection that goes silent later is detected by keepalive pings (every 30 seconds, 20 seconds to answer). A check that hits a stalled server therefore ends with an error and the next check, 15 seconds later on the dashboard, tries again (tested with a stand-in server that accepts the connection and never answers: the check gave up after 20 seconds; the same code without the limit was still waiting after 90 seconds). The dashboard then says that the last check failed and that new payments get no tickets until it can reach the server. Before this change a stalled check could hang for good, and the dashboard warned only once 3 minutes had passed without a finished check; that warning still exists for a program that stops checking altogether. Not covered: a server that completes the connection and keeps answering the keepalive pings but never answers a request (that would need a time limit per request). The dashboard's wording in this case was not re-tested with a stalled server.

## What problem this solves

A shielded raise hides who paid, so a host's total has to be taken on trust unless there is a way to check it. This project keeps who paid and where refunds go hidden and adds checks anyone can run.

## What you get

- **Private contributing.** A contributor pays from a wallet that can pay the campaign's shielded address (on the main network, phone wallets paid a campaign on 2026-10-06 and 2026-10-08, the second time with the current payment code and QR code; other wallets have not been tried). A sealed note in the memo ties the payment to the contributor's refund ticket.
- **A recountable book.** The host publishes a signed, chained ledger. The recount page reads public gRPC-web chain servers and runs checks R1 to R8 for every campaign. A uniform-price auction adds R9 to R12.
- **Refund tickets.** Each contributor receives a pre-signed refund transaction that pays back to them only and never expires. The contributor's page checks it (see "Ticket validation levels").
- **Three kinds of campaign.** A fundraiser (goal and deadline); an older pay-your-bid auction (items, the highest bids win); and a uniform-price auction (items, a reserve price, one clearing price for every winner).
- **A host set-up page and dashboard.** Set up a campaign (fundraiser or pay-your-bid auction; uniform-price auctions come from the command line), watch its state, see what the host still has to do, and close it.
- **A capability card.** A page generated from the campaign's committed rules, listing what is checked and what is not.
- **An embeddable badge.** It never claims "verified". It names the campaign, says "Not yet recounted" (it checks nothing itself) and links to the live recount.

## Checks

The recount runs in the browser as WebAssembly (and as a command-line tool, `cb-recount`). Each check has a name and a hover or tap explanation on the page.

| Check | What it covers |
|---|---|
| R1 | The published rules (and, for an auction, the revealed key) match what the campaign committed to. |
| R2 | The public list is signed, chained, gap-free, and closed at most once, after the deadline. |
| R3 | Every entry in the public list is a real payment to the campaign. |
| R4 | Every contribution has a refund ticket within the allowed number of blocks (the ticket window). |
| R5 | No contribution was spent before the deadline except by its own ticket. |
| R6 | Contributions that are not kept left the campaign only through their tickets. |
| R7 | The declared outcome (in an auction, the winners and the price) is what the rules select. |
| R8 | No published challenge opens a valid payment for a payment the campaign set aside. |
| R9 to R12 (uniform-price auctions only) | Each winner paid exactly the clearing price into the treasury with the exact fee; the treasury received exactly the sum of the clearing prices; settlements returned no value to the campaign account and have no other outputs; the proofs winners published that their excess arrived hold. |

A recount does not check that each ticket itself is valid: that is done on each contributor's device (next section).

Every recount produces a report. The report hash is SHA-256 of the report as canonical JSON (sorted keys, no whitespace, whole numbers plain, other numbers with exactly 8 decimals), together with the campaign id and the chain height it read up to. Two recounts of the same campaign at the same chain height give the same hash. The definition is in SPEC section 5.

### Ticket validation levels

| Level | What it checks | How |
|---|---|---|
| L1 | the ticket is the one the signed list names, has the expected shape, valid signatures, is for the network version in use, never expires, pays the stated fee, spends the contribution, and the coin is unspent; the list shows at least the amount chosen | automatic |
| L2 | the refund output pays the address the contributor gave (recomputed from values sealed with the ticket) | automatic, for tickets in the current format |
| L3 | the zero-knowledge proof inside the ticket | only when the contributor presses "Check the proof too" |
| L4 | the ticket's chain anchor is still valid | not built |

The proof module is downloaded only on request: 3.58 MB (0.87 MB gzipped). Measured in headless Chromium on a 16-core laptop while another test was running: building the verifying key took about 14 s, and about 60 s with the processor slowed four times (a stand-in for a slow phone, not measured on a phone); each proof then took about 0.19 s (about 0.8 s slowed).

## What is not checked

Stated on the recount page and, for the first four, on the capability card:

- The amount a contributor promised. It cannot be judged without the contributor's one-time secret, which is revealed only when they publish proof for a rejected payment.
- The proof inside each ticket, unless the contributor presses "Check the proof too".
- Each ticket's chain anchor (L4, not built).
- Ledger anchoring: the host signs a final fingerprint of the list at the close and relays serve it, but the fingerprint is not anchored on a public ledger.
- On the recount page, when it applies: agreement between servers (only one chain server answered) and between relays (only one gave a usable list). The result is then marked "limited", and when relays or servers disagree it says "cannot conclude" instead of passing.

## Privacy

`app/privacy-test.sh` is a leak test. For three finished testnet campaigns (a uniform-price auction, a fundraiser closed with a refund, and a 40-contribution fundraiser with five different refund addresses) it collects everything public: the relays' rules, ledger, challenges and sealed tickets; every request and response, and the final text, of the five pages (campaign, recount, capability card, badge, contribute); every file the page server hands out; and what each campaign's public viewing key decrypts on the chain. It fails if any of it contains a contributor's refund address or payer address (in any of its forms, as text or as raw bytes), a contributor's secret, or a personal or machine name. It also checks that its scanner can see the data (every contribution's transaction id is found) and that it catches a planted address. Result: 18 of 18 checks pass.

What the public data reveals, as measured: the rules; per contribution a transaction id, output number, nullifier, block height and ticket issue height; in a fundraiser each amount (and, with the public viewing key, each payment's amount and sealed memo); in an auction after the close all three bids' amounts, the clearing price, the winners and each settlement; the memo length (which shows the payment code format). What it does not reveal in any of those: the payer, the refund address, the contributor's secret, or any name.

The first run of the test found one real leak, which is fixed: the built browser module (served to every visitor) contained the builder's home-folder path inside its error messages; `app/web/build.sh` now removes it. What the test cannot show: network addresses seen by relays and chain servers, or correlation by amounts and timing.

## Copied memos and underpayment

Someone who sees a sealed memo before it is mined could copy it into a payment of their own. The sealed payload binds the intended amount, and a payment counts only if it pays at least that amount. A copier who pays at least that amount takes the contributor's place, but their money is then refunded to the contributor's address, and the contributor's own later payment is set aside as a donation: the contributor's loss is about one network fee (SPEC section 2). An underpayment is a non-refundable donation. An overpayment counts in full and is refunded as the payment minus the fee. Old-format memos are labelled "copyable" on the page.

## Tested behaviour

Every claim below has a test in the repository, and each passed in the last full run (2026-10-08). The browser and scenario tests ran against the testnet, most of them with real payments; the mainnet guard test uses no wallet and no money; the unit tests need no network.

| Claim | Test |
|---|---|
| Contributing end to end, including real payments and a refund | `app/web/contribute-e2e.cjs`, 35 checks |
| Restore from a backup; relays down or disagreeing | `contribute-e2e2.cjs`, 8 checks |
| A cheating host that wrongly rejects a valid payment is caught by the recount (R8) once the contributor publishes proof | `contribute-e2e-reject.cjs`, 11 checks |
| The "Publish proof" button: nothing is published without the press; underpaid, replayed and wrongful rejects; overpayment | `app/web/challenge.sh` with `challenge-e2e.cjs`, 22 checks |
| Junk and malformed tickets show a red notice and are never shown as received and checked | `app/web/junk-ticket.sh`, 45 checks |
| Campaign and recount pages, relay and server failures | `pages-e2e.cjs` |
| Uniform-price auction recount and contributor page | `recount-auction-e2e.cjs` (7), `auction-page-e2e.cjs` (17) |
| Host set-up page and dashboard, from creating a campaign to closing it | `setup-e2e.cjs` and `dashboard-view-e2e.cjs` (33, via `host-pages.sh`), `app/web/dashboard.sh` (25) |
| The report hash is canonical and repeatable | `recount-hash-e2e.cjs`, 9 checks |
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

## Mainnet and NU7

- The testnet activated NU7 at height 4,465,026 (branch id 0x77190ad9). A ticket is valid under one consensus branch only (observed: a ticket signed before NU7 and sent after it was rejected), so tickets signed before an upgrade must be re-issued after it. This project does not build tickets valid under two branches. This build's libraries have no mainnet NU7 height yet, so before mainnet activation they have to be updated; that has not been done.
- Creating a campaign on the main network (command line or dashboard) and closing one from the dashboard need an explicit "real money" confirmation. A campaign that could still be running when NU7 activates is refused: with `--nu7-mainnet-height` it must end well before that height; without it, it must be over a week before 5 November 2026 (the rule and its unit tests are in `app/host/src/mainnet.rs`).
- A first run on the main network, with two wallets (one a phone wallet) and 0.002 ZEC each, was made on 2026-10-06 on the network version before NU7 (branch 37a5165b): one contribution was taken back early with its own ticket, the other refunded by the host at close, and the recount passed (docs/EVIDENCE.md section 8). On 2026-10-08 a pilot with the current version followed (branch 37a5165b): a phone wallet paid 0.0002 ZEC into a fundraiser, the ticket was issued and passed the checks, the contributor took the contribution back with it, the campaign closed as goal missed, and the recount agreed; it ran on a single relay, so the recount was marked limited. Not tested on the main network with the current version: the host refunding at close, ticket re-issue across a real network upgrade, the ticket proof and anchor checks, an auction, and a multi-relay recount (docs/EVIDENCE.md section 8).
- The mainnet NU7 activation height and date: **unverified** (reports only, not read from an official specification by us). State them here only once confirmed.

## Running it

You need: Rust (stable, 1.88 or newer, with `rustup`), Python 3, Node 22 (for the browser tests), and a few gigabytes of disk for build output. For the browser module you also need the wasm target (`rustup target add wasm32-unknown-unknown`), `cargo install wasm-bindgen-cli --version 0.2.129`, and Zig 0.14 (download it from https://ziglang.org/download/ and point `ZIG` at the `zig` program; it compiles the one C dependency). **Tested on Ubuntu 26.04 under WSL 2 only** (16 cores, 10 GB of memory); other systems have not been tried. Expect about 20 minutes for the first build from an empty clone on a machine like that (measured: the native tools 5 minutes, the wallet tool 13 minutes, the browser module 2 minutes), and longer on a smaller one.

```
cd app && cargo build --release        # cb-host, cb-contrib, cb-recount, cb-relay, ll-vectors in app/target/release
cd .. && cargo build --release         # the patched wallet tool, target/release/zcash-devtool (only for the scenarios that make real payments)
ZIG=/path/to/zig app/web/build.sh      # the browser module, into app/web/www/pkg and app/web/www/proof (the pages do not work without it)
```

A local trial on the testnet, from the repository root (three terminals, or put `&` after each):

```
python3 app/web/serve.py 8770                                           # the pages, at http://127.0.0.1:8770/
./app/target/release/cb-relay serve --dir runs/relay1 --listen 127.0.0.1:8787   # a relay (a second one on 8788 with --dir runs/relay2)
./app/target/release/cb-host serve --relay http://127.0.0.1:8787 --relay http://127.0.0.1:8788   # host set-up page and dashboard, http://127.0.0.1:8780
```

`cb-host serve` creates a campaign's own wallet through the wallet tool (it needs the testnet server and no money). To get a contributor's payment to a campaign you need testnet coins in a wallet of your own; this repository does not provide any. `app/web/demo.sh` starts the pieces and a demo campaign in one command, but it expects a testnet wallet folder named `bidder` in the repository root (made with `./target/release/zcash-devtool wallet -w bidder init --name bidder -i bidder.age -n test`). `cb-host create` makes a campaign from the command line (see its `--help`; `--ticket-k` sets the ticket window, 10 to 1000 blocks, default 30). Fonts are self-hosted, so the pages make no request to a font service; they do contact public chain servers.

Three things to know before hosting:

- Tickets are issued only while the host's watcher (`cb-host watch`, or the dashboard) is running and can reach the network. Run it on an always-on machine that does not sleep, with a stable connection, from before the first contribution until the campaign is closed and refunds are confirmed. A host that is offline leaves new contributions without tickets (the recount flags this as R4, but cannot recover the money).
- A campaign's wallet and key are created on the host's own computer. There is no key import. The campaign folder is the key, so back it up before taking any money.
- A campaign can have an optional public name (`cb-host create --name "…"`, or the Name field on the set-up page): 1 to 60 characters of plain text, part of the signed rules, shown instead of the short number. It is public, so put nothing private in it. A relay, recount tool or browser module built before names existed cannot reproduce the campaign id of a named campaign: the relay in the test refused it ("the rules hash to … not …"), so upgrade relays before using names (`app/web/polish-b.sh`).
- The set-up page makes fundraisers and pay-your-bid auctions; a uniform-price auction needs `cb-host create --mode auction --items N --reserve-zat … --treasury-address … --treasury-ufvk …`.

## Try it (no wallet, no money)

The repository carries the public data of five finished testnet campaigns in `examples/relay` (exactly what a relay serves: rules, ledger, sealed tickets). With the tools and the browser module built, serve them and recount them; the recount reads the public testnet chain servers, so it needs the internet.

```
python3 app/web/serve.py 8770 &
./app/target/release/cb-relay serve --dir examples/relay --listen 127.0.0.1:8787 &
mkdir -p runs && cp -r examples/relay runs/example-relay-b && ./app/target/release/cb-relay serve --dir runs/example-relay-b --listen 127.0.0.1:8788 &
```

Then open `http://127.0.0.1:8770/recount.html#c=<campaign id>&relay=http://127.0.0.1:8787&relay=http://127.0.0.1:8788` with an id from this table (replace `recount.html` with `campaign.html` or `card.html` for the campaign page or the capability card). Each recount takes up to a minute.

| What it is | Campaign id | What the recount shows (checked 2026-10-08) |
|---|---|---|
| Uniform-price auction, finished: 3 bids, 2 items, one price of 0.0019 TAZ for both winners | `5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb` | All checks pass: 12 of 12 (R1 to R12) |
| Fundraiser, finished: closed, goal missed, the contribution refunded | `48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f` | All checks pass: 8 of 8 |
| Fundraiser with 40 contributions from 5 wallets (the stress test; not closed) | `47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da` | All checks pass: 8 of 8 |
| Fundraiser with a name chosen by its host ("Community radio mast (demo)"), finished: closed, goal missed, both contributions refunded | `f6737fbc462e75508d424f0612a1ce5ea3df24c5cc1b550074821ccdea5e237a` | All checks pass: 8 of 8 |
| Failing fixture: an auction whose winners were settled after the settlement deadline (a real result, kept on purpose) | `32ea71afc470d77909a1b7b4a1fdaba36f0612df3a973df0ce1410c5ca16467a` | Some checks FAIL: 11 pass, R9 fails with its evidence |

If a public chain server is slow or does not answer, the recount shows "limited" rather than a pass (it needs two servers to cross-check); wait and press "Run it again". Leave out the second `relay=` part and the result is marked "limited": one relay cannot be cross-checked. The second relay above is a copy of the first, which is enough to see the page work but is not independent evidence. The fixture's data has had one published viewing key removed (a contributor's), which does not change the failing check.

## Running the tests

```
cd app && cargo test                    # unit tests (94 in the last run, no network): rules, recount logic against fake cheating hosts, ticket checks, relay, host guards
cd app/vectors/js && npm install        # the browser tests' dependencies (Playwright, libsodium); Linux also needs Chromium's system libraries
```

The browser tests in `app/web/*.cjs` take their campaign from the environment (`LINK=http://127.0.0.1:8770/contribute.html#c=<id>&relay=…&relay=…`, and `LINK_AUCTION` for the capability card test). Without a wallet you can run `card-e2e.cjs`, `recount-hash-e2e.cjs`, `recount-auction-e2e.cjs` and `badge-e2e.cjs` against the examples above (for `recount-auction-e2e.cjs` use the auction's recount address as `LINK`, and for `badge-e2e.cjs` a `contribute.html` address). `app/audit.sh` (run before every push) and `app/privacy-test.sh` search for words kept in an untracked local file, `.local/forbidden-names.txt` (one `category: regex` per line; the categories are in the comment at the top of `app/audit.sh`), and stop with a message if it is missing. The scenarios that make real payments (`app/web/contribute-e2e.cjs`, `challenge.sh`, `dashboard.sh`, `app/stress-e2e.sh`, the `app/e2e-*.sh` scripts) need the wallet tool built, a testnet wallet named `bidder` with coins, and the relays and page server above running.

## Wallet backend

The host's default wallet backend uses the Zcash libraries directly. zcash-devtool is a fallback used by tests.

## Repository layout

- `SPEC.md`: the formats and rules.
- `app/core`: rules, ledger, payload, ticket and the recount logic. `app/host`: the host program (`cb-host`: create, watch, close, set-up page and dashboard server). `app/relay`: the relay. `app/contrib`: the contributor's command-line tool. `app/recount`: the command-line recount. `app/ticketcheck`: the ticket checks. `app/proofcheck`, `app/proofmeasure`: the opt-in proof check and its measurement. `app/vectors`: shared test values.
- `app/web`: the browser pages (`www/`), the WebAssembly crate (`src/`), and the browser tests (`*.cjs`, with the scripts that run them).
- `app/*.sh`: end-to-end scenarios on the testnet. `app/audit.sh`: the check run before every push.
- `src/`, `Cargo.toml` at the root: a patched copy of the zcash-devtool wallet command-line tool (upstream: https://github.com/zcash/zcash-devtool; its own warning applies: for prototyping, not production). It keeps the upstream licences (see Licence). `doc/` and `CONTEXT.md` are upstream's documentation. docs/FINDINGS.md section 1 says what we changed.
- `examples/relay`: the public data of five finished testnet campaigns (see "Try it"). `docs/`: the documents below. `spikes/`: early experiment scripts.

## Documents

- SPEC.md: the formats and rules.
- docs/THREAT_MODEL.md: who can do what, and what stops them.
- docs/EVIDENCE.md and docs/FINDINGS.md: test evidence and findings.
- docs/DEMO_SCRIPT.md: a 3 to 4 minute demonstration script.

## Licence

Licensed under either of the Apache License, Version 2.0 (`LICENSE-APACHE`) or the MIT licence (`LICENSE-MIT`), at your option: **MIT OR Apache-2.0**. Copyright 2026 the Clewbook contributors (see `NOTICE`). The patched copy of zcash-devtool in `src/` keeps its upstream copyright line (The Electric Coin Company) in `LICENSE-MIT` and is covered by the same two licences. The project name is a placeholder and will change before publishing.

Unless you say otherwise, a contribution you submit for inclusion is licensed as above, with no extra terms.
