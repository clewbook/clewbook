# Roadmap

| Item | What it means | What it enables | Effort |
|---|---|---|---|
| Raise (top up) | A public bidder tag in the payment note groups payments into one bid | Raise a bid, one step Replace | 6 to 9 days |
| Quantity per bid | "2 items at 2 ZEC each" in one payment | Multi item bids | 5 to 8 days |
| Timed release bids | Encrypted bids opened at the deadline | The host cannot read bids early | 8 to 12 days |
| Pay your bid, settled like uniform | Winners pay their sealed bid, the rest is returned | No overpay loss | 3 to 5 days |
| Soft cap and hard cap | Soft cap is the minimum for success. Hard cap is a maximum: at the close, payments over it are refunded whole by their own ticket, kept in chain order | Presale style caps | Built and tested on testnet; not yet on the live site |
| Relay stamping | A different party's relay stamps the first seen height | Checks the host reported ticket time | Not built |
| Threshold signing (FROST) | The spending key split among signers | Prevents a host spending a ticketed note | Weeks, library support not established |
| Passphrase flag | Optional start up passphrase | Protects a stolen disk | Small |
| Auto close | Close without pressing the button | Fewer late closes | Not scoped |
| Admission gating | Refuse payments when the host is stale | Fewer unticketed payments | Not scoped |
