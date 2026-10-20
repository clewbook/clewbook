# The checks

Moved here from the README on 14 October 2026, unchanged. What each check shows and does not show is also in [CLAIMS.md](CLAIMS.md); the exact rules are in [SPEC.md](../SPEC.md), section 5.

## Checks

The recount runs in the browser as WebAssembly (and as a command-line tool, `cb-recount`). Each check has a name and a hover or tap explanation on the page.

| Check | What it covers |
|---|---|
| R1 | The published rules (and, for an auction, the revealed key) match what the campaign committed to. |
| R2 | The public list is signed, chained, with no gaps, and closed at most once, after the deadline. |
| R3 | Every entry in the public list is a real payment to the campaign. |
| R4 | Every contribution has a refund ticket on the list once the ticket window has passed (inside it, the ticket is pending). |
| R4b | Each ticket was issued within the ticket window, going by the issue height the host itself writes (host reported: the recount cannot check that height). Until 14 October 2026 R4 and R4b were one check. |
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
