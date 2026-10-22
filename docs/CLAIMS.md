# What Clewbook claims, check by check

This sheet says what each check of the recount shows, what it needs, and what it does not show. It is written so it can also be used as the text of a page. The code is the authority: each check names where it is computed.

Words used here:
- The **host** is whoever runs a campaign.
- The **signed list** (the ledger) is the host's numbered list of payments, signed by the host and published to relays.
- A **ticket** is a refund transaction the host signs in advance for one contribution.
- **K** is the campaign's ticket window, in blocks.

## Four words for a result

A payment can be in four states. The checks below say which state they show.

| Word | Meaning | Shown by |
|---|---|---|
| **Acknowledged** | The host put the payment on its signed list. | R2 (the list is intact), R3 (the entry points at a real payment) |
| **Matches the chain** | What the list says about the payment is what the chain shows. | R3 |
| **Complete** | Every payment to the campaign address that counts as a contribution is on the list. This is only for payments to the campaign address, and in an auction only after the close. | R4 (an entry must exist once K blocks have passed); R4b says whether the host reports it issued each ticket in time |
| **Recoverable** | The contributor holds a ticket that can still be sent. | The contributor's page (ticket checks L1 to L3); R5 and R6 show afterwards if a contribution left any other way |

## The refund ticket in plain steps

1. You pay the campaign address from your own wallet. The payment carries a sealed note that only the host can open, with your refund address in it.
2. When the host program sees the payment, it builds a transaction that spends exactly that payment and pays it back to your refund address, minus a fixed fee. It signs it. The transaction has no expiry height.
3. The host seals the transaction so only you can open it, publishes it to the relays, and puts its transaction id on the signed list.
4. Your page fetches it, opens it, and checks it on your device: it is the one the list names, it spends your payment, it pays your address, the fee is right.
5. You keep it in the browser and in your backup file.

These are three separate properties. Only the first two are claims.

| Property | True? |
|---|---|
| A transaction is built and handed to you. | Yes, when the host is running. A payment made while the host is offline waits until the host returns. If the host never returns, there is no ticket. |
| You can broadcast it without the host while your payment is unspent. | Yes: it is fully signed and needs nobody else. That means until the deadline, and afterwards unless your contribution is kept (a fundraiser that reached its goal, or a winning bid). It is valid for one network version. |
| The host cannot spend your payment first. | **No.** The host holds the campaign key. The host program keeps the payment out of ordinary use, but that is a mark in its own wallet, not a rule of the network. If the host spends it, your ticket stops working, and R5 or R6 shows it afterwards. |

## The checks

Computed in `app/core/src/recount.rs` (R1 to R8, with R4b) and `app/core/src/auction.rs` (R9 to R12). The same code runs in the command line recount and, compiled to WebAssembly, on the recount page.

| Check | Shows | Needs | Does not show |
|---|---|---|---|
| **R1 Rules** | The published rules hash to the campaign id. In an auction after the close, the revealed viewing key matches the hash committed at the start. | the rules and the campaign id | Whether the rules are fair. |
| **R2 List integrity** | Every entry is signed by the campaign's key, the entries are numbered without gaps and chained, there is at most one close, and it came after the deadline, or, for a fundraiser whose rules allow it, before the deadline as "goal met". | the signed list | That the host showed the same list to everyone. A host could sign two different lists; nothing published anchors it. |
| **R3 Entries are real** (acknowledged, matches the chain) | Every entry points at a real payment to the campaign, with the same transaction, output and height. In a fundraiser the amount matches. In an auction after the close, the amount commitment matches the bid. | the campaign viewing key and a chain server | Anything about payments that are not on the list (that is R4). |
| **R4 Tickets issued** (complete) | Every payment the campaign viewing key sees that counts as a contribution has a ticket entry once K blocks have passed since its payment. Inside the window it is pending. This is the completeness check. | the campaign viewing key (public in a fundraiser, published at the close in an auction) | When the ticket was issued (that is R4b). Payments without a valid payment code, below the minimum or after the deadline do not count as contributions, so they are not required on the list. Payments to any other address of the host are not seen. |
| **R4b Ticket timing** (host reported) | Each ticket's issue height, as written in the list, is at most the payment's height + K. | the signed list and the payment heights | That the ticket really was issued then: **the issue height is the host's own statement**, and a host that issued late could write an earlier height (`docs/THREAT_MODEL.md` threat 22). Until 14 October 2026 this and R4 were one check, R4, which passed exactly when both pass. |
| **R5 No early spend** (recoverable) | No contribution was spent before the deadline except by a ticket the list names for it and the recount accepts: its first ticket, or a re-issue written before the close under a new network version (at most one per version). | the viewing key and the chain | Prevention. A host that spends a contribution early is shown, not stopped. That the ticket pays the contributor: the recount cannot open it; the contributor's page checks it, and a re-issued ticket must pass that check. That a re-issue followed a real network upgrade: the recount takes the network version the host wrote. |
| **R6 Refunds only by ticket** (recoverable) | After the deadline, contributions the rules do not let the host keep left only through such tickets. | the viewing key and the chain | Prevention, as for R5, with the same limits. That the host closed at all: the page says when it has not. |
| **R7 Outcome** | The declared outcome is what the rules select: goal met or missed, or in an auction the winners and the price, recomputed from the chain. After an early close the goal is recomputed over the payments up to the close height. Ties go to the bid earlier in chain order. | the close entry | That the host will close. |
| **R8 Rejects are justified** | No published challenge opens a valid payment code for a payment the host set aside. "Valid" is the one validity rule the host applies (SPEC §2): sealed for this campaign, paid at least the amount sealed in it, and a refund address a wallet can pay. | challenges published by contributors | Whether an unchallenged reject was fair. |
| **R9 Settlements** (uniform price auction) | Each winner's payment was settled by one transaction that paid exactly the clearing price into the treasury, with the exact fee. | the treasury's public viewing key | Where the rest of the winner's payment went (that is R12). |
| **R10 Treasury total** (uniform price auction) | The treasury received exactly the sum of the clearing prices. | the treasury's public viewing key | |
| **R11 Nothing diverted** (uniform price auction) | Settlements returned nothing to the campaign account and have no other outputs. | full transactions from a chain server | |
| **R12 Excess paid back** (uniform price auction, optional) | For each winner who chose to publish the viewing key of their refund account: the money owed back to them (their payment minus the price and the fee) arrived. | a winner's published viewing key | Anything for winners who published nothing. It passes when nobody published a proof, and says so. It is not about delivering the auctioned item: that is outside Clewbook. |

## What none of the checks show

- That each ticket is valid. That is checked on each contributor's own device, not in the recount.
- That the host did not spend a contribution first. Shown afterwards only.
- When each ticket was really issued.
- That a payment made while the host was offline will get a ticket.
- That bids were hidden from the host. The host sees each bid as it arrives; amounts are off the public record until the close.
- In an auction before the close, anything about the bids. Only R1 and R2 can run. The recount page says "Not yet possible"; the command line prints `WAIT` for R3 to R8.
- That the page doing the recount is the code in this repository. It is served by the project's own server; the command line recount can be built from the source instead.
- That the chain servers told the truth, when only one answered.
