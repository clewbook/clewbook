# Roadmap

| Item | What it means | What it enables | Effort | Done |
|---|---|---|---|---|
| Raise (top up) | A public bidder tag in the payment note groups payments into one bid | Raise a bid, one step Replace | 6 to 9 days |  |
| Quantity per bid | "2 items at 2 ZEC each" in one payment | Multi item bids | 5 to 8 days |  |
| Timed release bids | Encrypted bids opened at the deadline | The host cannot read bids early | 8 to 12 days | ✓ (testnet; mainnet by link, ends before NU7; public listing after NU7) |
| Pay your bid, settled like uniform | Winners pay their sealed bid, the rest is returned | No overpay loss | 3 to 5 days |  |
| Auto close at the cap | The campaign closes by itself once the kept amount reaches the hard cap | Presale style caps that stop at once | Not scoped |  |
| Refund only the excess | A payment that only partly fits under the hard cap keeps the part that fits; only the rest is refunded | Fewer whole refunds near the cap | Not scoped |  |
| Room left with unconfirmed payments | The room left under the cap also counts payments seen but not yet on the public list | A room left figure that is less often too large | Not scoped |  |
| Relay stamping | A different party's relay stamps the first seen height | Checks the host reported ticket time | Not built |  |
| Threshold signing (FROST) | The spending key split among signers | Prevents a host spending a ticketed note | Weeks, library support not established |  |
| Passphrase flag | Optional start up passphrase | Protects a stolen disk | Small |  |
| Auto close | Close without pressing the button | Fewer late closes | Not scoped |  |
| Admission gating | Refuse payments when the host is stale | Fewer unticketed payments | Not scoped |  |
| NU7 update for mainnet tickets | Refund tickets are valid under one Zcash network upgrade; this update makes mainnet tickets work across the next upgrade (NU7). Until then, new mainnet campaigns must end before the upgrade | Mainnet campaigns that run past the upgrade date | Not scoped |  |
| Ledger anchoring | At the close the host publishes a fingerprint of the final public list (the number of entries and the hash of the last one) on the Zcash chain, and the recount checks that the list it reads matches it. A second part checks that each refund ticket was made against a real earlier state of the chain | A host cannot later show a history that disagrees with the published fingerprint | About 14 to 20 hours for the fingerprint at the close; the ticket check is not scoped |  |
| Cancel and refund all (fundraisers only) | The host calls off a campaign and everyone is refunded by their ticket; the recount reports a clean "called off, all refunded" result instead of flagging the early refunds. Opt in per campaign, so existing campaigns are not affected | A host can stop a campaign cleanly | About 3 to 5 working sessions | ✓ (testnet) |
| Host pays the refund fee on cancel | On a cancel the host tops up the network fee, so contributors get the full amount back | Full refunds when a host calls a campaign off | About 3 to 4 more sessions after the plain cancel |  |
| Pay from a wallet extension | A "Pay with Noir" button that fills in the address, amount and memo. Vizor already opens from our payment link | Paying from a browser wallet without copying anything | About 1.5 sessions | ✓ |
| Open ended fundraiser or donation mode | No deadline and no tickets; periodic signed snapshots; sweeps recorded in the ledger | Ongoing donations | Not scoped |  |
| Hosted by label | The opened campaign page shows the label of its approved host; it is never shown on the home page | Visitors see who hosts a campaign | About half a day | ✓ |
| Mainnet listing of other hosts' campaigns | Automatic listing for mainnet, after the upgrade height is published and a review | Other hosts' mainnet campaigns on the home page | About half a day plus review |  |
| Shared custody | The host team and Clewbook, plus an independent guardian, must co-sign before money moves (2 of 3 or 3 of 5, FROST) | No single party can move the money alone | Not started. Research stage; we are looking for developers and cryptographers to help |  |
