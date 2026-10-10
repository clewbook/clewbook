# Threat model

This document says who can attack a campaign, what they can try, what stops them, and what is left. Each protection names the test that backs it. Where a protection does not exist, it says so. Test names are files in this repository; the numbers are the checks in the last full run (2026-10-08, testnet).

## What is being protected

1. **Contributor privacy.** Who paid and where a refund goes are not published, and no name is collected, provided the contributor pays from their own wallet's shielded balance (threat 19). What *is* public (see the table in the README): the rules; each contribution's transaction id, nullifier and block height; in a fundraiser each amount and, through the public viewing key, each payment's amount and sealed memo; in an auction, after the close, every bid amount (losing bids too), the clearing price and the settlements. `app/privacy-test.sh` checks that none of what is public contains a refund address, payer address, contributor secret or name (18 checks over three finished testnet campaigns).
2. **Contributor money.** A contributor who holds a ticket can get their money back before the deadline, or after it if the host has not closed within the ticket window.
3. **Honest books.** A visitor can check the host's signed ledger against the chain.

## Who we assume

| Actor | Assumed to do |
|---|---|
| Host | May be dishonest, careless or offline. Holds the campaign wallet and key. |
| Contributor | May be honest or hostile. Pays from their own wallet. |
| Observer | Reads the chain and the public servers. Can copy anything public. |
| Server or relay | May be offline, stale, or lie. |
| Visitor | Runs the recount in their own browser. Trusts the code that loads. |

We do not defend against: a contributor's wallet leaking their own data; a compromised host computer; an attacker who controls every server a visitor can reach; a malicious copy of the recount page.

## Threats

Status: **Stopped** (prevented, or always flagged, and a test shows it), **Reduced** (partly handled), **Open** (not handled).

| # | Threat | What stops it | Status | Evidence |
|---|---|---|---|---|
| 1 | Host keeps the money and vanishes | Each contributor who got a ticket holds a pre-signed refund that pays only back to them and never expires. A host that vanishes **before issuing** a ticket leaves that contribution with nothing: the recount flags it (R4) but cannot recover the money | Reduced | `contribute-e2e.cjs` (a refund sent and mined), `app/e2e-one.sh` scenario b and d |
| 2 | Host's ledger does not match the chain (an entry that is not a payment, a missing ticket, a forged or dropped entry, a spend that is not a ticket, a wrong outcome) | The recount compares the signed ledger with the chain (R1 to R7) | Stopped (flagged) | `cargo test -p ll-core`: `tampered_dropped_or_foreign_entries_fail`, `missing_ticket_fails_r4_only_after_k_blocks`, `early_spend_by_non_ticket_fails_r5`, `goal_missed_keeping_money_fails_r6_and_lying_about_the_outcome_fails_r7` |
| 3 | Host rewrites or forks the ledger after publishing | The ledger is host-signed and chained, so an edit breaks the chain for anyone holding an earlier copy, and relays that differ give "cannot conclude". The ledger's fingerprint is not published anywhere public, so a host can still show different ledgers to different readers; readers can only compare report hashes | Reduced | `pages-e2e.cjs` (relays that disagree), `recount-hash-e2e.cjs`. Anchoring is not built |
| 4 | Observer copies a pending sealed memo into their own payment | The sealed payload binds the intended amount and a payment counts only if it pays at least that amount; the earliest accepted payment wins. A copier who pays enough takes the contributor's place, but their money is refunded to the contributor's address and the contributor's own payment becomes a donation: the contributor's loss is about one network fee (SPEC section 2). Old-format memos bind no amount and are labelled "copyable" | Reduced | `cargo test -p ll-core`: `a_message_copied_into_an_earlier_payment_takes_the_contributors_place_but_is_visible`, `a_copier_paying_less_does_not_take_the_contributors_place`, `a_copier_paying_exactly_the_same_amount_still_wins_but_costs_them_the_whole_amount`, `an_old_format_memo_still_works_and_stays_copyable`; `app/replay-e2e.sh` |
| 5 | Contributor underpays (for example a wallet that lets the sender lower the amount) | The shortfall is not counted; the payment is a non-refundable donation, shown as one, and the page warns before and after paying | Reduced (the loss itself is not prevented) | `challenge-e2e.cjs` (underpaid case), `contribute-e2e.cjs` (the warning), `a_wallet_that_lowers_the_amount_makes_the_payment_a_donation_and_the_reject_is_justified` in `cargo test -p ll-core` |
| 6 | Contributor overpays and sees a false failure | An overpayment counts in full and is refunded as the payment minus the fee; the ticket check passes with a note | Stopped | `your_amount_exact_under_over` in `cargo test -p ll-ticketcheck`; `challenge-e2e.cjs` (over and under cases) |
| 7 | A junk or malicious ticket is handed to a contributor | Level 1 and 2 checks on the contributor's device, plus the optional proof check; a failing ticket is never shown as received and checked | Reduced | `app/web/junk-ticket.sh` (45 checks). L4 anchor check not built |
| 8 | A contributor's refund address is published by accident (the page used to publish proof by itself) | Proof is published only when the contributor presses "Publish proof that my payment was valid", after a warning that it reveals the refund address for that one payment and cannot be undone | Stopped | `challenge.sh` with `challenge-e2e.cjs` (22 checks), `contribute-e2e-reject.cjs` (11 checks) |
| 9 | One relay or chain server lies or is stale | The recount reads several of each, says how many answered, marks a one-source result "limited", and gives "cannot conclude" when they disagree. The two default testnet servers run on the same hosting, which the recount says | Reduced | `pages-e2e.cjs`. It cannot detect every lie |
| 10 | Tickets issued too late during a burst | The ticket window `ticket_k` (default 30 blocks, set per campaign, 10 to 1000); a late ticket is flagged by R4 | Reduced | `app/stress-e2e.sh` (40 contributions from 5 wallets over 36 blocks: every ticket on time, delay 0 blocks; not a same-block burst), `missing_ticket_fails_r4_only_after_k_blocks` |
| 11 | Host goes silent after the deadline | After deadline + `ticket_k` with no close entry, the contributor's page offers the contributor's own ticket for sending (SPEC section 7) | Stopped (for contributions that have a ticket) | `app/e2e-one.sh` scenario c, rerun 2026-10-08 with the default ticket window of 30 blocks: the contributor's ticket was broadcast at deadline + 31 and mined (testnet block 4,477,768), recount R1 to R8 pass, "host has not closed" shown. `app/e2e-close.sh` with `ONLY=C`, run 2026-10-08 with the same window: the contributor's ticket was broadcast at deadline + 31, the host's lock was released once it was spent, recount R1 to R8 pass and "refunded 0.01" with "host has not closed" |
| 12 | Host loses the campaign folder (the wallet and key) | Nothing recovers it. The set-up page warns first. Contributors can still use their tickets | Open | `setup-e2e.cjs` (the warning is shown) |
| 13 | A mainnet campaign spans the NU7 activation | Creation is refused if the campaign could still be running near the activation (with the published height, or by date until it is known). Creating (command line or dashboard) and closing (dashboard) need a real-money confirmation. Only as good as the height given: the height is not yet published | Reduced | `mainnet-guard.sh` (15 checks), unit tests in `app/host/src/mainnet.rs` |
| 14 | A fixed "verified" badge claims more than was checked | The badge claims nothing, says "Not yet recounted" and links to the live recount | Stopped | `badge-e2e.cjs` (13 checks) |
| 15 | A page leaks a visitor's address to a font or other third-party service | Fonts are self-hosted, and the pages request nothing from outside this computer except the public chain servers | Stopped (third parties); see 18 for the chain servers | the "nothing was requested from outside" checks in `setup-e2e.cjs`, `start-e2e.cjs`, `badge-e2e.cjs`, `card-e2e.cjs`, `dashboard-view-e2e.cjs` |
| 16 | Secrets or large files pushed to the public repository | `app/audit.sh` measures what a push would send and checks for banned content | Reduced | `app/audit.sh`, run before every push |
| 17 | The recount page itself is replaced with a malicious copy | Not handled. Visitors must trust the page they load | Open | none |
| 18 | Network traffic links a contributor to a payment | The shielded protocol protects the payment. **The contribute and recount pages talk straight to public chain servers**, which can see the visitor's network address and which transactions and blocks the page asks for. Nothing in this project hides that. A relay cannot tell which ticket belongs to which visitor: the contribute page fetches every ticket, in random order. Traffic through Cloudflare (the tunnel, or a host behind it) is also visible to Cloudflare | Open (relay ticket requests: Reduced) | `app/web/stage-h-e2e.cjs` (40 of 40 tickets fetched, in a different order on another visit) |
| 19 | The payment transaction itself shows who paid or how much | The ledger names each payment's transaction. One funded from transparent money (an exchange, a transparent address) shows the paying address and amount on the chain; one that crosses shielded pools shows the amount crossing, which in an auction is close to the bid, before the close. An exchange may also drop the memo, so the payment cannot be ticketed. The payment step says in one line to pay from the payer's own shielded balance; the reasons are in the README ("How to pay, and why"). Nothing detects or blocks it | Open (warned) | none |

## What the recount proves

If a visitor sees R1 to R8 pass, then, for the servers the page named, the ledger the host signed matches the chain: every entry is a real payment, each contribution has a ticket entry within the ticket window, no contribution was spent early except by its own ticket, and the outcome is what the rules select.

## What it does not prove

- That each ticket is valid. The ticket checks (L1 to L3) run on each contributor's device, not in the recount.
- That the promised amount of any contributor was honoured. This needs the contributor's secret.
- That servers agreed, if only one answered (the page then says "limited").
- That each ticket's chain anchor is still valid (L4, not built).
- That the ticket proof is valid, unless the contributor presses "Check the proof too".
- That the host's ledger was not rewritten, or shown differently to different readers, before a visitor first saw it (no anchoring).

The recount page lists most of this under "Not checked"; the statement that it does not check each ticket's validity is made here; SPEC section 3.1 describes those checks as the contributor page's. The recount page does not say it.

## Design choices that limit harm

- A ticket is valid under one consensus branch only. This project does not build tickets valid under two. Before mainnet NU7 activation the libraries have to be updated (this build has no mainnet NU7 height; not done), and the host's watcher re-issues tickets while it is running.
- The wallet and key are created on the host's computer and are never entered through a web page; the dashboard listens only on 127.0.0.1 and refuses requests from other sites.
- A campaign's rules are committed in its id. The capability card is generated from the committed rules, and the same check the contribute page makes (the rules must match the campaign id) must pass before it draws anything. Tested: `card-e2e.cjs` makes a relay answer with another campaign's rules, and then with the right rules changed by one number; the card draws nothing in both cases.
- Creating or closing a campaign on the real network needs a ticked or flagged confirmation.

## Open items before publishing

- Ledger anchoring (threat 3).
- L4 ticket anchor check (threat 7).
- Key backup help for hosts (threat 12).
- The recount command-line help still says "R1 to R7".
- Repeat the main-network run with more than one contribution, so that the host refunds at close with the current version (a pilot on 2026-10-08 with the current version covered one phone-wallet contribution taken back by its owner; the host-close refund on the main network was run only on 2026-10-06 with an earlier version), publish to at least two relays so the recount is not limited, and record what fails.
- Scenarios A, B and D of `app/e2e-close.sh` (sweep, re-issue, auction) have not been rerun since the ticket window became per-campaign; only C has (threat 11).
- A security review of the wallet and ticket code before the repository goes public.
