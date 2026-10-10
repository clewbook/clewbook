# Facts for the README and the threat model (draft)

Rule for this file: a fact is listed only if a test, a measurement or the specification backs it; the source is named. Anything not verified is under
**Unverified**. Numbers come from testnet runs on one laptop unless stated. Everything here comes from the testnet except the mainnet run in section 8 (2026-10-06, an earlier version; docs/EVIDENCE.md section 8).

## 1. What the system does (specification: `SPEC.md`)
- A contributor pays a campaign address with a sealed payment code in the memo; the host issues a **pre-signed refund ticket that never expires** (expiry height 0, checked) and writes a **signed, hash-chained public ledger** entry for it.
- Anyone can **recount** from the public ledger and the public chain: R1 to R8 for every campaign, R9 to R12 for a uniform-price auction (`SPEC.md` section 5 and 8). The recount runs in a browser (WebAssembly) and in a command-line tool; both read at least two relays and two chain servers.
- The ticket's transaction id covers everything except signatures and proof, so the contributor's page also runs its own checks on the ticket (section 4 below).

## 2. Tests, last full run (2026-10-08, testnet, real payments unless noted)
| Test | Result |
|---|---|
| Contribute page, end to end (`app/web/contribute-e2e.cjs`) | 35 of 35 |
| Restore from backup, relays down or disagreeing (`contribute-e2e2.cjs`) | 8 of 8 |
| Campaign and recount pages, relay and server failures (`pages-e2e.cjs`) | 28 of 28 |
| Challenge button and rejects (`app/web/challenge.sh`, `contribute-e2e-reject.cjs`) | 22 of 22 and 11 of 11 |
| Junk tickets from a cheating host, all modes (`app/web/junk-ticket.sh`) | 45 of 45 |
| Dashboard, create to close with a real payment (`app/web/dashboard.sh`) | 25 of 25 |
| Set-up page and dashboard view | 33 of 33 |
| Mainnet guards, no money (`app/web/mainnet-guard.sh`) | 15 of 15 |
| Report hash (`recount-hash-e2e.cjs`) | 9 of 9 |
| Auction recount and auction contribute page | 7 of 7 and 17 of 17 |
| Badge, capability card, start page | 13, 29 and 9 checks, all passed |
| Rust unit tests: core 52, ticket checks 14, mainnet guard 5 | all passed |
The test-only cheating host lives behind the compile-time feature `test-cheats` and is not in a normal build (`app/host/src/main.rs`).

## 3. Stress test (`app/stress-e2e.sh`, run 2026-10-08)
- 40 contributions of 0.001 TAZ from 5 payer wallets sending in parallel (8 each), one campaign, ticket window K = 30 blocks, testnet.
- **All 40 got a ticket. R1 to R8 all passed in the public recount over both relays (identical lists of 40 entries). R4 passed: ticket delay was 0 blocks** (the ticket's issue height equalled the contribution's height for all 40).
- Time from sending a payment to its ticket: fastest 50 s, median 111 s, **slowest 223 s** (mostly waiting for the payment to be mined). The host issued a ticket about **every 4 seconds** (median gap 3 to 4 s) while several were waiting; the largest gap, 194 s, was idle time between payment rounds.
- All payments were sent within 726 s; all 40 ledger entries existed 956 s after the first payment.
- **Limits:** the contributions arrived over 36 blocks, at most 5 per block; this is **not** a burst of 40 in one block. One run, one host machine, the public testnet server, no closing or refund phase, a rebuild of the host program during the run added a little CPU load. An earlier planning figure of 15 to 30 s per ticket was an assumption and was wrong for this setup.

## 4. Ticket checks, by level (`SPEC.md` section 3.1, `app/ticketcheck`)
- **Level 1 (automatic):** matches the signed list, expected shape (two Ironwood actions, nothing else), valid signatures, for the network version in use now, never expires, the stated fee, spends your contribution, the coin is unspent (or used only by a transaction the list names), the list shows at least the amount you meant to pay.
- **Level 2 (automatic, tickets issued in the current format):** "it pays you": the refund output is recomputed from the values sealed with the ticket and the refund address, and must equal the output inside the ticket's own transaction. Older tickets say "Not checked: that it pays you".
- **Level 3 (only when the contributor presses "Check the proof too"):** the zero-knowledge proof verifies, in a separate module downloaded only on request. Measured (headless Chromium, 16-core laptop, another test running at the same time; commit 6c1552d): module 3.58 MB (0.87 MB gzip, 0.66 MB brotli); verifying-key build 14.2 to 14.4 s, **about 60 s with the processor slowed 4 times (a stand-in for a phone, not a phone)**; each proof about 190 ms (760 to 810 ms slowed). A proof with flipped bytes is rejected (`junk-ticket.sh`, mode badproof).
- **Level 4 (not built):** whether a ticket's chain anchor is a real earlier state.
- Paying more than the amount chosen is a pass with a note (the whole payment is the contribution); the list showing less than meant or paid fails (`app/ticketcheck/src/tests.rs`).

## 5. What a recount checks and does not
- **Checks:** R1 rules match their id; R2 ledger signed, chained, gap-free, closed at most once after the deadline; R3 every entry is a real payment; R4 a ticket within K blocks; R5 no early spend; R6 refunds only by ticket; R7 the outcome; R8 every reject is justified; R9 to R12 (uniform auction): settlements, treasury total, nothing diverted, delivery proofs.
- **Does not check (the page says so):** the amount a payment message promised (needs the contributor's one-time secret, revealed only by a challenge); the proof inside each ticket (contributor's device, on request); ticket anchors (not built); ledger anchoring, i.e. the host's ledger fingerprint is not published anywhere public (not built).
- The recount reports "cannot conclude" (never a pass) when relays disagree or chain servers disagree; with one server or one relay the result is marked "limited".

## 6. The report hash (`SPEC.md` section 5, `app/web/www/canon.js`)
SHA-256 of canonical JSON of `{"v":1,"rules_id":…,"end_height":…,"report":…}`: keys sorted by UTF-16 code units, no whitespace, whole numbers plain, other numbers with exactly 8 decimals. Tested: key order does not matter; two recounts of one campaign at the same chain height give the same hash; a different campaign gives a different one. A different height gives a different hash by design.

## 7. Known limits and trust assumptions (for the threat model)
- **The host must be running** for tickets to be issued; a host that stops leaves paid contributions without tickets. The recount flags it (R4) but cannot recover the money. The ticket window K (10 to 1000 blocks, default 30) only sets how late a ticket may be and how long the host has after the deadline before contributors may claim their own refunds; it is a timing allowance, not a cryptographic assumption.
- **Underpaying** (below the amount sealed in the payment code) makes the payment a non-refundable donation. **Version 1 payment codes can be copied** by someone who sees them before they are mined; version 2 seals the amount in (`SPEC.md` section 2). The public recount alone cannot tell whether a "too small" reject was fair.
- **A challenge** that proves a wrongful reject publishes the refund address of that one payment permanently.
- **Relays** can withhold or lag; the recount compares relays and says "cannot conclude" if they differ. **No ledger anchoring:** nothing public yet stops a host from showing different ledgers to different readers; readers can compare report hashes.
- **The two default testnet chain servers run on the same hosting**, so they are not independent evidence of each other (the recount says so). Hosting is judged from the outside only.
- A ticket is valid for **one consensus branch**; across a network upgrade the host must re-issue (its watcher does, while running). Observed on testnet: a ticket signed before NU7 and sent after it was rejected ("transaction uses an incorrect consensus branch id"); the re-issued ticket was accepted and mined (testnet block 4,465,381).
- Sealed-bid auction amounts are hidden, so "your amount" cannot be compared there.
- The host dashboard listens on this computer only, refuses requests from other sites, and asks for confirmation before creating or closing a campaign on the real network.
- An optional host title is **not built**: it would have to be part of the signed rules (a change to the specification), because a title in a link could be forged.

## 8. Network and NU7 status
- Testnet: NU7 activated at block 4,465,026 (our own testnet run saw it on 2026-10-04); testnet consensus branch 77190ad9; observed testnet block time in our runs about 19 to 27 s.
- Mainnet run: on 2026-10-06 two wallets (one a phone wallet) paid 0.002 ZEC each to a main-network campaign (branch 37a5165b, the Ironwood pool, which is active on the main network since NU6.3); one ticket was sent early by its contributor, one by the host at close; the recount passed; 0.004 ZEC in, 0.0038 returned (docs/EVIDENCE.md section 8). That was before the current payment code, pages and guards.
- Mainnet: this build's libraries have **no mainnet NU7 height** (`Nu7 => None` in `zcash_protocol` 0.11.0-pre.0, verified in our tests), so it builds for the current mainnet branch 37a5165b and the host refuses a ticket whose branch differs from the one the server reports.
- The host refuses a mainnet campaign that could still be running when NU7 activates: with `--nu7-mainnet-height` it must end well before it; without it, it must be over a week before 2026-11-05 (so before 29 October). Tested in `app/host/src/mainnet.rs` and `mainnet-e2e.cjs`.

## 9. Unverified (do not state as fact)
- **The mainnet NU7 activation height, the 2026-11-05 target and the block time change from 75 s to 25 s:** from news reports only; the height is reported as due on 2026-10-20. Not read from an official specification by us.
- The current payment code (267-character memo, 562-character QR code) on the real network and on a phone: only the earlier version was run there (2026-10-06, one phone wallet, a QR code of the same size class); other wallets are untried. See `docs/PILOT_CHECKLIST.md`.
- Behaviour when NU7 activates while tickets are outstanding on mainnet (shown on testnet only, by hand and once).
- Phone timings for the proof check (only a processor slowed 4 times was measured).
- Stress behaviour with many more contributions, a same-block burst, or a real closing with many refunds.


## Mainnet smoke run 2026-10-06: ids removed from the public evidence file (internal only)

### Former section 8. Mainnet smoke run (live network, small amounts)

Campaign `[private list: ids]`, goal 0.005 ZEC, deadline block 3,507,807; contributions of 0.002 ZEC each from two separate wallets (one of them a phone wallet). Network version at the time: `37a5165b`.

| Claim | Evidence | How to verify |
|---|---|---|
| A contributor withdrew early with their own ticket. | contribution `[private list: ids]`, ticket `[private list: ids]`, mined at 3,507,784 | look up the ids on mainnet |
| The host refunded the other contribution at close (goal missed). | contribution `[private list: ids]`, ticket `[private list: ids]`, mined at 3,507,811 | look up the ids on mainnet |
| The recount, run in the browser against three public servers that appear to run on three separate hosting providers (hosting can only be judged from the outside), says all checks pass. | totals: raised 0.004, withdrawn early 0.002, refunded 0.002, kept 0 | the recount web page for this campaign (the campaign's public ledger was served from the host's own machine; reproducing it needs the ledger files from the repository's run, not just the chain) |
| Spent: 0.004 ZEC paid in, 0.0038 returned; ticket fees 0.0002 plus the payers' own network fees. | | |


Pilot 2026-10-08 (internal): campaign [private list: ids], issue+refund tx [private list: ids]…e7edf0 (payment at 3,510,919; refund mined 3,510,935), closed at 3,510,981, goal missed. Ids stay out of public files.

## Pilot recount against the relay that holds it (internal, 2026-10-09, with the stage B build)
- Browser recount page, relay 127.0.0.1:8790 only (the pilot was never published to 8789), the three public mainnet servers it selects by itself.
- Result: "All checks pass (limited check)": R1 to R8 all pass. Limited because one relay was asked and so the list was not cross-checked.
- Totals shown: raised 0.0002 ZEC, 1 contribution, taken back early 0.0002 ZEC, refunded 0, kept 0, pending 0, donations 0; "Goal 0.001 ZEC: missed".
- The close entry: R2 (list closed at most once, after the deadline) and R7 (declared outcome equals the recomputed one: goal missed) pass. The page has no separate "closed" line for a campaign closed this way; the close is visible through those two rows and the "goal missed" totals line. It does not print the close block.
