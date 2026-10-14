# Privacy: what is public and what is not

Moved here from the README on 14 October 2026, unchanged.

Not everything about a contribution is hidden. What is public and what is not (tested: see "Privacy" below):

| Public | Off the public record (the host sees what it receives) |
|---|---|
| The campaign's rules: type, goal or number of items, deadline, smallest contribution, fee, ticket window, the address that receives payments, the host's public keys (and, in a uniform-price auction, the reserve, the treasury address and its viewing key). | **Who paid:** the paying wallet and its address, **when the payment comes from the payer's own shielded balance** (see "How to pay" below). |
| Each contribution's transaction id, output number, nullifier and block height, so when it arrived, and when it was spent or refunded. | **Where a refund goes:** the refund address, sealed inside the payment's memo, which the host can read. It is revealed for one payment only if that contributor chooses to "Publish proof" for it. |
| **Fundraiser:** each contribution's amount, and the campaign's viewing key. Amounts are visible to anyone with the campaign viewing key, and that key is public; only the sender is not shown. Anyone can also see each payment's sealed memo. | **The contributor's secret** (the backup file): it stays on their device. |
| **Auction:** only a commitment per bid until the close. At the close the host reveals the viewing key and the amount key, so **every bid amount, including every losing bid, becomes public**, with the clearing price, the winners' nullifiers and each settlement's price, fee and excess. This is deliberate, and a consequence of how the recount works: it has to see all the bids to check that the right bids won and that the price is the one the rules give (R7 and R9 to R12), and anyone must be able to repeat that check. Who made each bid stays off the public record. The host sees every bid amount as it arrives, before the close. | The contents of the refund tickets (sealed to their owners; only an unreadable blob is public). |
| The sealed memo's length (it shows the payment code format) and the sealed ticket blobs. | Names: none are collected, asked for or published. |

Amounts and timing can still help someone who already knows a person's payment to find it in the ledger, and in a fundraiser every amount is public. Contributors' network addresses are not hidden by this project: the relays and the public chain servers see the address of whoever contacts them (see docs/THREAT_MODEL.md, threat 18). When the pages and the relay are reached through Cloudflare (the tunnel, or a site hosted behind it), Cloudflare also sees visitors' network addresses.

### How to pay, and why

The ledger names each payment's transaction, so whatever that transaction shows on the chain is linked to the campaign:

- **Pay from your own wallet's shielded balance.** A payment funded from transparent money (an exchange withdrawal, or a transparent address) shows the paying address and amount on the chain, so the ledger then links who paid to the contribution; in an auction it also shows the bid amount before the close.
- **Not from an exchange.** Besides the point above, an exchange may not be able to attach the payment's message (memo), and without it the campaign cannot track or ticket the contribution.
- **From the same pool as the campaign's address where you can.** Moving money between shielded pools (for example from Sapling, or from Orchard into Ironwood) shows the amount that crosses, which in an auction is close to the bid.

The contribute page says this in one line on the payment step; the reasons are here. The project does not detect how a payment was funded: the host could read a payment's transparent and cross-pool parts from the chain and flag them, but it cannot stop them, and a flag would come after the information is already public.

### When the host is not seen

The contribute page shows when the host was last seen. If it has not been seen lately, a payment made now is ticketed when the host comes back; if that takes longer than the ticket window, the ticket is late (R4 flags it) and, until it arrives, the refund depends on the host closing the campaign. If the host never comes back, that payment never gets a ticket, and there is nothing the contributor can do on their own to get it back: the money is in the campaign wallet and only the host has the key. The page does not stop a payment when the host has not been seen.

### Late payments

New payment codes stop 10 blocks before the deadline (a wallet may need a few minutes to sync and send, and a payment can wait a block or two to be mined). A payment mined after the deadline is not a contribution: it gets no ticket, it is not counted, it is not refunded by the close, and it stays in the campaign wallet. The host can list such payments with `./app/target/release/cb-host late --run <campaign folder>` (it reads the wallet file only) and return them by hand; the dashboard shows a line when there are any.

## Privacy

`app/privacy-test.sh` is a leak test. For three finished testnet campaigns (a uniform-price auction, a fundraiser closed with a refund, and a 40-contribution fundraiser with five different refund addresses) it collects everything public: the relays' rules, ledger, challenges and sealed tickets; every request and response, and the final text, of the five pages (campaign, recount, capability card, badge, contribute); every file the page server hands out; and what each campaign's public viewing key decrypts on the chain. It fails if any of it contains a contributor's refund address or payer address (in any of its forms, as text or as raw bytes), a contributor's secret, or a personal or machine name. It also checks that its scanner can see the data (every contribution's transaction id is found) and that it catches a planted address. Result: 18 of 18 checks pass.

What the public data reveals, as measured: the rules; per contribution a transaction id, output number, nullifier, block height and ticket issue height; in a fundraiser each amount (and, with the public viewing key, each payment's amount and sealed memo); in an auction after the close all three bids' amounts, the clearing price, the winners and each settlement; the memo length (which shows the payment code format). What it does not reveal in any of those: the payer, the refund address, the contributor's secret, or any name.

The first run of the test found one real leak, which is fixed: the built browser module (served to every visitor) contained the builder's home-folder path inside its error messages; `app/web/build.sh` now removes it. What the test cannot show: network addresses seen by relays and chain servers, or correlation by amounts and timing.

## Copied memos and underpayment

Someone who sees a sealed memo before it is mined could copy it into a payment of their own. The sealed payload binds the intended amount, and a payment counts only if it pays at least that amount. A copier who pays at least that amount takes the contributor's place, but their money is then refunded to the contributor's address, and the contributor's own later payment is set aside as a donation: the contributor's loss is about one network fee (SPEC section 2). An underpayment is a non-refundable donation. An overpayment counts in full and is refunded as the payment minus the fee. Old-format memos are labelled "copyable" on the page.
