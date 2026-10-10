# Design notes (internal, never published; nothing here is built)

Written 2026-10-09 for the feature freeze (14 to 16 October). Hours are my estimates for building and testing, on testnet, by one person who already knows this code; they are guesses, not measurements. "Unverified" means I did not check it.

## 0. What the outage diagnosis found (it shapes parts 3 and 4)

* The free tunnels died and the program kept running. The campaign folders store the **public relay address** (`private/relays`) and the host publishes through that address, even though the relay is on the same machine. Restarting a tunnel changes the address, but each existing campaign keeps the old one: the dashboard then hands out a link with the new page address and the old relay address, and every publish fails ("relay unreachable"). A fix is small in idea (publish to the local relay, keep the public address only for links) but touches the host's publish path.
* A page whose own scripts fail to load shows "Working…" forever, with no message.

## 1. Ledger anchoring

**What exists:** every entry is signed with the host's ledger key and chained to the one before. Two relays that show different lists are detected only by someone who reads both. Nothing outside the host fixes the list at a point in time. The README already says anchoring is not built.

| Option | What is published, where | Effort | Risk |
|---|---|---|---|
| A. At close, on the Zcash chain | one memo, `rules_id` + number of entries + hash of the last entry, in a small payment from the campaign wallet to itself; mined once | 14 to 20 h: host close step 6 to 10, a recount rule that reads it 4 to 6, tests on testnet 4 | touches the close path, which moves money; needs a little unlocked money in the wallet (the contribution notes are locked), so the host tops up about 0.0001; zero-value output with a memo through our wallet code: unverified |
| B. Periodic on-chain | the same, every N blocks | 30 to 40 h: A plus a funded float, a scheduler, failure handling, partial-match logic in the recount; a fee each time | most code on the money path; more can go wrong during the one week that matters |
| C. A witness countersigns | an independent party (a relay operator) signs the ledger head hash whenever it sees a new head and publishes the signature next to the ledger | 8 to 12 h plus finding a witness | needs a second party who stays up; proves only that a second key saw it |
| D. Outside timestamp | an OpenTimestamps proof of the final ledger hash, published next to the ledger | 4 to 6 h; no money path touched | a third party and Bitcoin; the browser cannot check it, only a command-line step can |

**What an anchor would prove:** that by block H the host had committed to a list whose head had this hash, so it cannot later show a different history that disagrees with it. **What it does not prove:** that the list was complete (a payment the host left out is still caught only by the existing check R4, from the chain), that the host key was not shared, or anything about entries after the anchor (with A, everything before close is covered, nothing after). The recount could check A: the campaign's viewing key opens the memo (public for a fundraiser from the start, for an auction after close).

**Would claim publicly (A):** "At close the host publishes a fingerprint of the final public list on the Zcash chain; the recount checks that the list it reads matches it." Not: "tamper-proof", not "trustless".

**Recommendation:** roadmap. Option A is the right first step, but it sits on the close path and I would not change that path in the last week. If there is spare time, D is the only version that cannot hurt the working build. Keep saying plainly in the docs that anchoring is not built.

## 2. Host key custody, escrow, co-signers

**Today, honestly:** one host holds (a) the wallet's spending key, (b) the ledger signing key, (c) the key that opens payment messages. Refund tickets are signed in advance with (a), so a contributor can take their money back without the host, **as long as the host has not spent that note first**. The lock on the note is software (the wallet's output lock and the host's own checks), not cryptography: the host can still spend the note elsewhere. What the design gives is detection, not prevention: any spend that is not the contributor's ticket (or the final sweep) shows up in the recount as a failed check (R5 and R6) with the transaction as evidence. The money would already be gone. We cannot honestly say "the host cannot take your money"; we can say "a host that does is caught, publicly, with proof". The threat model says this.

| Option | What it is | Effort | How it meets pre-signed tickets |
|---|---|---|---|
| A. Roadmap only | document the limit, name the options | 1 to 2 h | no change |
| B. Escrow as custodian | a named escrow holds the money and signs the tickets | 20 to 30 h and a real escrow | moves the single key to another person; tickets unchanged |
| C. Threshold keys (FROST, 2-of-3 for the spend authority) | the wallet's spend key is shared, no one party can spend alone | 80 to 200 h; unverified that our wallet libraries can spend with a threshold signature at all | every ticket must be signed by t parties **before** it is needed, so the co-signers must be online during the ticket window; this makes availability worse, not better |
| D. Witness for the ledger only | see 1C | 8 to 12 h | does not protect money, only the record |

**Recommendation:** roadmap (A now). Do not start B or C before the freeze: C is a research project, B is a different product. Claim only what is true: single key, theft is detectable and provable but not preventable, here is the evidence.

## 3. Outages

**A. A stable public address instead of free quick tunnels** (prices are from memory, unverified):

| Option | Cost | Effort | Notes |
|---|---|---|---|
| Free quick tunnels (now) | free | 0 | random address, no promise to stay up; it died within a day |
| Cloudflare named tunnel | a domain, about 10 to 15 a year; the tunnel itself free | 2 to 3 h | stable name, same program; still needs this computer on |
| Tailscale Funnel | free personal tier | 1 to 2 h | stable name `<machine>.<tailnet>.ts.net`, HTTPS; limits on bandwidth and ports; still needs this computer on |
| ngrok with a static domain | free tier has one static domain; paid about 8 to 10 a month | 1 to 2 h | the free tier may show a warning page to browsers (unverified) |
| Small always-on server (VPS) + a domain, behind Caddy | about 4 to 7 a month + domain | 6 to 10 h with backups and hardening | solves "this computer must stay on" too; the host key and wallet then live on a rented machine |
| Home router port forward + dynamic DNS | free | 2 h | exposes the home address; often blocked by the provider; not recommended |

**Recommendation:** for the demo and the week of the freeze: a Cloudflare named tunnel if you own a domain, otherwise Tailscale Funnel (either 2 h, no code change). For real use: the VPS, with the hosting guide already on the list.

**B. Static pages on Vercel or Render, relay and host on an always-on server.** Pages are plain files: Vercel (prepared, `docs/DEPLOY_VERCEL.md`) or Render's static sites both work. The relay and the host program need a machine that stays up: Render's free web services sleep after idle time (unverified), so a paid instance with a disk, or a VPS. Vercel's free Hobby plan is meant for non-commercial use: whether a real fundraiser would breach its terms is unverified. **Recommendation:** put the static *demo* (no live host) on Vercel; for a live campaign serve the pages from the same small server as the relay (one address, no cross-site setup), and say so. Pages hosted by a third party are code that handles the contributor's secret, so the page host is part of the trust.

**C. "Host last seen" heartbeat.** The host publishes, every pass, a small signed record `{campaign id, its chain height, time}` next to the ledger (a new file on the relay, signed with the ledger key). The contributor page checks the signature, compares the height with the current chain height, and shows "Host last seen N minutes ago" and, past a limit (say half the ticket window), a boxed warning before the payment step: "Tickets cannot be issued right now. If you pay now, your refund ticket may arrive late or not at all; wait." A relay can withhold or replay an old record, which shows as "old", so it fails safe; it cannot fake a fresh one. Effort 10 to 14 h (host 4 to 6, relay route 2, page and tests 4 to 6). Risk: medium, no money path. It warns; it does not guarantee.

**What happens to a payment made during an outage:** it is mined and sits in the campaign wallet; nothing in the public list shows it. When the host comes back it scans from where it stopped and issues the ticket (the code has no cut-off at K), so the contribution is refunded or kept normally, but the entry is late: the recount fails R4 for it, permanently, because R4 cannot tell an honest outage from a late host (the evidence line states the blocks). The contributor page already shows "Your refund ticket has not arrived. Do not rely on this payment until it does." once the ticket window has passed.

**D. Recount from a saved ledger file when the relay is down.** The page works on rules + ledger entries it reads from relays; the recount itself needs nothing else from the relay. Add a "recount a saved file" input (drop the rules and ledger JSON, or one bundle file) and a one-click "save the public copy" on the campaign page and in the dashboard. Effort 4 to 6 h, page only, low risk. The result must say what it is: "from a file you supplied: consistent with itself and with the chain, but not shown to be what the host published to others" (same limit as asking one relay). The old test bundles in `app/web/www/bundles` are fixtures, not a feature.

**E. A contributor who pays while the host is down longer than the ticket window.** They have no ticket, and without one they have no cryptographic way back: the note belongs to the host's address and nobody else can sign for it. Until the host returns they depend on it. If the host returns before the deadline plus K, it issues the ticket (late, R4 fails) and everything proceeds. If the outage covers the deadline and the close, the self-refund path (after deadline + K with no close) needs a ticket the contributor does not have. Whether the host's close pass issues missing tickets before refunding: unverified; I read only that the refund loop uses stored tickets and logs "no stored ticket" otherwise. Only the heartbeat (C) and the page warning reduce this risk; nothing removes it.

## 4. Recommendation for the freeze (14 to 16 October), ranked

Judging lens: privacy, usefulness, execution, originality. "Risk" is to the working build.

| # | Item | Hours | Value to judges | Risk | When |
|---|---|---|---|---|---|
| 1 | A stable address (3A: named tunnel or Funnel) and a one-line tunnel check in `./run.sh status` | 2 to 4 | execution, usefulness: a link that opens during judging | none to the code | before |
| 2 | The relay-address fix: a helper that rewrites a campaign's `private/relays` when an address changes (no host code), and a visible message when a page's scripts fail to load | 3 to 5 | execution | low | before |
| 3 | 3D: recount from a saved file, plus "save the public copy" | 4 to 6 | usefulness (works when the relay is down), execution | low | before |
| 4 | 3C: heartbeat and the warning on the contributor page | 10 to 14 | usefulness, execution, honest handling of outages | medium | before only if 1 to 3 are done by 13 Oct; otherwise roadmap |
| 5 | The proper fix: host publishes to the local relay, public address only in links | 4 to 6 | execution | medium (publish path) | roadmap, after the freeze |
| 6 | 1A: anchor at close | 14 to 20 | originality, privacy of the claim | medium to high (close path) | roadmap, designed here; 1D only if time is spare |
| 7 | 2B, 2C: escrow, threshold keys | 20 to 200 | originality | high | roadmap; document the single-key limit (2A) now |
| 8 | 3B: static demo on Vercel | 1 for [private list: names] + checks | usefulness: judges can try it without us | none | before, after items 1 to 3 |

Nothing in 1 to 3 or 8 changes how money moves. 4 adds a signed file and some page code. 5 to 7 touch the publish path, the close path or the keys, which is where a mistake costs money; they wait.

## 5. Read-only check, 2026-10-09: what close does with payments that have no ticket (from the code; not run)

Source: `close()` in `app/host/src/main.rs`, `analyze()` in `app/core/src/recount.rs`, `settle_winners()`, `watch_once()`. No test covers a close with an unticketed payment: the closing scenarios (`app/e2e-one.sh`, `app/e2e-close.sh`) always run a watch pass first.

* **Close does not issue missing tickets.** It syncs the wallet, writes the close entry, then sweeps or refunds. Issuing a ticket happens only in the watch pass; nothing in `close()` calls it. In the dashboard the watcher runs beside the close button, so a ticket is normally issued within about 15 seconds of the host starting up, before anyone presses Close; closing in those first seconds can beat it.
* **Who counts as a contribution does not depend on tickets.** `analyze()` builds the contributions from the chain notes (in range, at least the minimum, a well-formed message, not rejected). So an unticketed payment is counted in the total, in "goal met or missed", and among the auction's bids, exactly like a ticketed one. The recount shows it as a missing ticket (R4) but counts the money.
* **Refund (goal missed; the losers of a pay-your-bid auction): not done for an unticketed payment.** The refund loop sends the stored signed ticket of each unspent note; with none it only writes "no stored ticket for ..." in the log (`close()`, the `Err(_)` arm). The money stays unspent in the campaign wallet and the recount lists it as "still pending". A ticket cannot be added afterwards: the relay refuses new entries after the close entry (409) and the SPEC makes an entry after a close a failure. So the contributor is not refunded by the program; only a manual action by the host would return it. **This is the real gap.**
* **Sweep (goal met; the winners of a pay-your-bid auction): probably works, not verified.** The sweep spends the notes of the kept set, named by lock owner `ticket:<nf>`; an unticketed note has no such lock. The builder is told to prefer locked inputs (`PreferLocked`), and the host then checks that the transaction spends exactly the expected notes; whether an unlocked note is picked, or the check refuses and close stops with an error after the close entry is written, I did not establish.
* **Uniform-price auction: the winners' settlement does not need a stored ticket** (it opens the sealed message), but uses the same lock owner, with the same unknown. A loser without a ticket is in the same position as in the refund case above.
* **Outage longer than the ticket window, by outcome, if the host returns before closing:** the watch pass issues the late ticket (there is no cut-off at K); the recount fails R4 for it permanently; the close then refunds, sweeps or settles it like any other. **If the host closes before it returns to normal (or never issues the ticket):** goal met: swept, probably (unverified); goal missed: not refunded (above); auction winner: settled (unverified), loser: not refunded.
* **What a contributor can do meanwhile:** nothing with the chain. With no ticket they have nothing to broadcast. The new "host last seen" note and the stage A late-ticket notice tell them; neither fixes it.

What a fix would take (not built, no change made): in `close()`, run one ticket-issuing pass first and refuse to close (or say so loudly) when a counted contribution still has no ticket, 2 to 4 hours with the closing scenarios re-run; plus a test that pays while the watcher is stopped, 3 to 4 hours more on testnet. Recommended before the freeze, because it is the only place the gap loses money.

### Update, stage E: the gap in section 5 is closed

**What `close` does now:** before it writes the close entry it issues every ticket that is still missing (late, exactly as the watcher would), then refunds, sweeps or settles as usual. If a counted contribution still has no ticket afterwards, it stops before writing or sending anything and lists the payments with the reason and what to do. Why this approach and not "issue the ticket after the close": a ticket entry cannot follow the close entry (the relay refuses it, the SPEC forbids it), so the only place to fix it is before. Why stop instead of closing around the problem: once the close entry is written the outcome is public and final, and a payment left without a ticket cannot be refunded by anyone but the host by hand.

**Tests on the testnet** (`app/e2e-unticketed.sh`; no watcher runs before the close; "before" is the program as it was):

| Scenario | Before (old close) | Now |
|---|---|---|
| Goal missed, one unticketed payment | close exits 0, "no stored ticket", the 0.01 stays in the wallet, recount "still pending" | late ticket issued, refund broadcast and mined, recount "refunded 0.01"; R4 fails, honestly, because the ticket was late |
| Goal met, one unticketed payment | the sweep works (broadcast accepted, mined later); R4 fails (no ticket at all) | ticket issued first, then swept; recount "kept 0.015" |
| Uniform auction, unticketed winner and loser | **the settlement failed**: the host's own check refused it ("transaction spends [winner, loser], expected exactly [winner]") because without a ticket lock the builder also took the loser's note; the close entry was already written; nothing settled or refunded | both tickets issued, winner settled (price 0.0029 to the treasury), loser refunded 0.001; the recount in the browser passes 12 of 12 |

So the sweep for a single unticketed note worked even before; the winner settlement did not; the refund never could. Not tested: a sweep or settlement with several unticketed notes at once, or a mix of ticketed and unticketed notes.

## 6. Recount completeness (read-only answers, 2026-10-10)

**R1 to R12 in one line each.** R1: the rules published are the ones the campaign number commits to (auction: the revealed key matches its committed hash). R2: the list is signed by the campaign's key, chained, without gaps, closed at most once and only after the deadline. R3: every entry points at a real payment on the chain with matching details. R4: every contribution on the chain has a ticket entry within K blocks. R5: no contribution was spent up to the deadline except by its own listed ticket. R6: after the deadline, contributions outside the kept set left only through their tickets. R7: the close entry's outcome (goal met or missed, or the auction's winners) is what the rules and the chain give. R8: no published challenge proves a reject was wrong. R9 (uniform auction): each winner's note was spent by exactly one announced settlement, in time, at the exact fee, and the treasury got exactly the price. R10: the treasury got exactly winners times price. R11: no settlement sent value back to the campaign or had extra outputs. R12: a winner's delivery proof, when published, holds.

**A recount from a saved file (tested on the committed examples and the closed pilot, by cutting entries).**
* **Runs fully:** R1, R2 (on what the file contains), R3, R5, R6, R7, and R9 to R11 for an auction: they compare the file's entries with the chain, read from the public servers.
* **Limited, and why:** (1) it has one source for the list, so there is no agreement check between sources (the page says so); (2) R8 can only see the challenges in the file, and the host export holds none (challenges live on relays), so R8 passes only vacuously; (3) R12 only has proofs that are in the file's challenges, none; (4) the chain side is limited when only one public server answers.
* **What a file cannot show:** that it is the whole list. A copy cut off at the end still verifies, because every prefix of a valid chain is valid. What the chain gives away: cutting the last 5 entries of the 40-contribution example gave R4 FAIL (payments with no ticket); an empty list gave R4 and R6 FAIL; removing an auction's last settle entry gave R9 FAIL. **What stays invisible:** the close entry alone. A closed fundraiser with its close entry cut off passed all 8 checks with only a note that it "has not been closed". Also invisible: entries with no trace on the chain (for instance a reject of a malformed payment), and a different, equally well-signed list that the host showed someone else (a fork).

**What it would take to check completeness months later with no relay running.**

| Piece | What it gives | Effort | Notes |
|---|---|---|---|
| 1. The host saves the final public copy at close and shows its fingerprint (the hash of the last entry and the number of entries) | one durable file and one short line anyone can compare a file against; detects cut-off, including the close entry, and substitution | 3 to 4 h with tests (the export exists; add it to close, show the line in the dashboard) | only as durable as where the host puts the file and the line (own site, a public repository, a web archive); no trust in a relay needed |
| 2. Copies held by contributors | the page keeps the full verified list it last saw, in the browser and in the backup file; the recount takes several files and uses the longest valid one | 7 to 10 h (page 4 to 6, recount 3 to 4) | catches a cut-off only if some holder has a longer copy; nothing if nobody kept one |
| 3. A public fingerprint in the host's own words (post it where it will be archived) | same as piece 1's line, with no code | 1 to 2 h of habit and a README paragraph | trust moves to wherever it is posted |
| 4. On-chain anchor at close (design notes, option A) | the fingerprint on the Zcash chain, readable by anyone with the campaign's viewing key, for ever | 14 to 20 h; touches money (a fee from a float), so the same care as close | strongest; the recount could check it |
| 5. Outside timestamp (OpenTimestamps, option D) | the same fingerprint proved to have existed by a time, without money | 4 to 6 h; command-line check only | third party and Bitcoin |
| 6. A witness countersigns (option C) | a second key signed the head | 8 to 12 h | needs a second party who stays up |

**Recommendation:** before the freeze, piece 1 (3 to 4 hours, close path already open and tested; no new trust) together with the habit in piece 3. After the freeze, piece 2, then piece 4. Say plainly in the docs what is not yet true: without an anchor, completeness weeks later is only as strong as the fingerprint's own durability and the copies others kept.

## 7. The rename (internal): what was left unchanged on purpose

Script: `app/rename-product.sh` (dry run by default, `--apply` to change; running it again changes nothing). Public name: Clewbook (domain clewbook.xyz). Programs: `cb-host`, `cb-relay`, `cb-contrib`, `cb-recount`; each is also built under its old `ll-*` name, so scripts and the live programs keep working.

Left unchanged, because changing it would break something real:
* **Hash and signature domain-separation strings** `ledgerlab_rules`, `ledgerlab_entry`, `ledgerlab_sign`, `ledgerlab_enc`, `ledgerlab_eph`, `ledgerlab_amount`, `ledgerlab_blob`, `ledgerlab_ufvk`, `ledgerlab_lock`, `ledgerlab_chal`, the signed prefix `ledgerlab_heartbeat` and the fingerprint prefix `LL fingerprint ` (in `app/core/src`, `app/host/src`, `app/relay/src`, `app/web/src`, and described in SPEC). Changing any of them changes every campaign id (`rules_id`), every ledger entry hash and signature, ticket and payload keys: every existing campaign, ticket, backup and saved copy would stop verifying.
* **The memo prefix `LL1:`** (payment code format, SPEC section 2): old payments could not be read and old pages could not build payments the host accepts.
* **File and wire format names:** the JSON `kind` values `ledger-export` and `contribution-backup`, the browser storage keys starting `ll:`, the relay's URL paths: saved copies, backups and stored state would stop loading.
* **Cargo package and library names** (`ll-core`, `ll-host` as a package, `ll_web`, `ll_proofcheck`; the file names `ll_web_bg.wasm`): nothing a reader sees; renaming touches every import and every test script.
* The vendored wallet tool in `src/` (its own project's code and licence notices) and the third-party credits in `NOTICE`.
* Internal planning documents and the GitHub repository name `[private list: oldnames]` (a setting on GitHub, not in the files).
