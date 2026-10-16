# Roadmap

## Built

- **Soft cap and hard cap for fundraisers:** in the live host program, relay, pages and recount (R6 and R7 check the cap), on testnet and on mainnet. One open mainnet campaign has a hard cap.
- **Early close for fundraisers:** a fundraiser whose rules allow it can close once its goal is met (auctions never). In the live host program and dashboard, on testnet and on mainnet.
- **R4 split into R4 and R4b:** R4 checks that every contribution has a refund ticket; R4b checks that each ticket was issued within the ticket window, by the height the host reports. In the recount page on app.clewbook.xyz and the demo, in cb-recount and in the dashboard's self check.
- **System, Light and Dark theme control:** on app.clewbook.xyz and the demo.
- **The public list as one table on the campaign page:** with Show older, and the close as one summary line. On app.clewbook.xyz and the demo.
- **Automatic listing:** the listing job at listing.clewbook.xyz builds the home page list of app.clewbook.xyz from the project's own campaigns and the campaigns of approved hosts, after a recount. Testnet only; mainnet is off. See `docs/LISTING.md`.

## Planned

| Item | What it means | What it enables | Effort |
|---|---|---|---|
| Raise (top up) | A public bidder tag in the payment note groups payments into one bid | Raise a bid, one step Replace | 6 to 9 days |
| Quantity per bid | "2 items at 2 ZEC each" in one payment | Multi item bids | 5 to 8 days |
| Timed release bids | Encrypted bids opened at the deadline | The host cannot read bids early | 8 to 12 days |
| Pay your bid, settled like uniform | Winners pay their sealed bid, the rest is returned | No overpay loss | 3 to 5 days |
| Auto close at the cap | The campaign closes by itself once the kept amount reaches the hard cap | Presale style caps that stop at once | Not scoped |
| Refund only the excess | A payment that only partly fits under the hard cap keeps the part that fits; only the rest is refunded | Fewer whole refunds near the cap | Not scoped |
| Room left with unconfirmed payments | The room left under the cap also counts payments seen but not yet on the public list | A room left figure that is less often too large | Not scoped |
| Relay stamping | A different party's relay stamps the first seen height | Checks the host reported ticket time | Not built |
| Threshold signing (FROST) | The spending key split among signers | Prevents a host spending a ticketed note | Weeks, library support not established |
| Passphrase flag | Optional start up passphrase | Protects a stolen disk | Small |
| Auto close | Close without pressing the button | Fewer late closes | Not scoped |
| Admission gating | Refuse payments when the host is stale | Fewer unticketed payments | Not scoped |
