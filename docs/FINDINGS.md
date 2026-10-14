# Findings others can reuse

Each item says how it was established. "Verified" means we observed it directly
in a test or in code we read; "not verified" means it is reported or reasoned but we did not check it ourselves.
Other projects are named factually; where something did not work for us, that is a statement about a specific
version in a specific situation, not about the project.

## 1. A wallet command-line tool that did not sign Ironwood spends (verified)

`zcash-devtool` ([zcash/zcash-devtool](https://github.com/zcash/zcash-devtool)) at the revision we started from
built and proved a partially created transaction (PCZT) that spent an Ironwood-pool coin, but `pczt sign` did not
sign the Ironwood spend: extraction failed with `MissingSpendAuthSig`. Signing Ironwood spends with the Orchard
spending key fixed it. Our patched copy is in `src/` (flags added for `pczt create`: `--expiry-height`,
`--discard-ovk`, `--min-confirmations`, `--spend-locked-by`; a `wallet lock-note` command). We have not checked whether the upstream tool
has since changed.

## 2. The test network activated NU7 earlier than planned (verified for the test network)

On the public test network, NU7 (consensus branch id `77190ad9`) activated at block 4,465,026 on 2026-10-04, earlier than
the date we had expected, because blocks were arriving much faster than the nominal 75 seconds. Practical consequences
that we hit: (a) a transaction signed under the previous version (`37a5165b`) is rejected after activation with
"transaction uses an incorrect consensus branch id"; (b) a date cannot be converted to a block height with one block time;
(c) software must detect upgrades from the chain's reported branch id, never from the calendar. After activation we
observed test-network blocks every 12 to 28 seconds. Not verified by us: the planned mainnet date (we were told early
November 2026); check the
[Zcash network upgrade pages](https://z.cash/upgrade) and the relevant [ZIPs](https://zips.z.cash/) before relying on it.
Mainnet, when we looked on 2026-10-06, reported branch `37a5165b` and a lightwalletd server running Zebra 6.3.0.

## 3. Wallet support for NU7 on the test network (partly verified)

Method: on 2026-10-05 we read the public release notes and, where we could, the source of seven wallets. We found **no mention
of NU7 support** in the release notes or the code we searched for any of them, so we could not show that any of
them can send on the post-NU7 test network. Absence of a mention is not evidence of absence.

| Wallet | Testnet option seen (source) |
|---|---|
| [Zodl (Android)](https://github.com/zodl-inc/zodl-android), [Zodl (iOS)](https://github.com/zodl-inc/zodl-ios) | an Android `testnet` build flavour; an iOS testnet variant is mentioned in its release documentation (whether it is public: not verified) |
| [Zingo (mobile)](https://github.com/zingolabs/zingo-mobile), [Zingo (desktop)](https://github.com/zingolabs/zingo-pc) | a chain toggle that includes testnet |
| [Zkool](https://github.com/hhanh00/zkool2) | a testnet mode (observed in use) |
| [Vizor](https://github.com/chainapsis/vizor-wallet) | separate testnet builds are mentioned (code search incomplete) |
| [Cake Wallet](https://github.com/cake-tech/cake_wallet) | not determined |

One observation of ours (verified once): on an Android phone, Zkool 6.32.0-rc in testnet mode scanned our payment QR code,
filled in the address, amount and message, accepted the standard test address, and then failed to send with the same
"incorrect consensus branch id" error. That is the expected outcome for a release candidate built before NU7 existed and
says nothing about the wallet beyond that version. The same limitation may appear on mainnet after NU7 activates, until
wallets ship NU7 builds (not verified; a risk to plan for).

## 4. Address encoding: `zutest1` / `zu1` versus `utest1` / `u1` (verified)

The prerelease library family we built against (`zcash_keys` 0.17.0-pre.0, `zcash_address` 0.14.0-pre.0) writes
unified addresses in the newer "Revision 2" encoding of [ZIP 316](https://zips.z.cash/zip-0316) unconditionally:
prefix `zutest1…` on the test network, `zu1…` on mainnet. Zkool 6.32.0-rc rejected such an address ("Invalid Address or
Payment URI") but accepted the standard "Revision 0" form (`utest1…`, `u1…`) carrying the same receivers. We re-encode to
the standard form (`ll_core::receiver::to_standard`, with a round-trip test). Not yet verified: that mainnet `u1…`
addresses from our tools are accepted by each wallet. Wallet databases also store viewing keys as `uvf…`/`uvi…` and
other tools print `uview…`; compare decoded contents, never strings.

## 5. Nullifier byte order differs between tools (verified)

A node's "duplicate nullifier" error printed the coin's nullifier byte-reversed relative to the wallet database. Any code
that compares nullifiers across sources must normalise the order. Our convention (SPEC §0): the order found inside a
transaction.

## 6. A no-expiry transaction is recognisable on chain (verified by construction)

The expiry height of a transaction is public. A refund ticket that never expires (expiry height 0) is therefore
recognisable as such once it is broadcast, and so are the settlement and sweep transactions our host now builds without
expiry. Nothing in the amount, recipient or memo is revealed by this, but the pattern is visible. Whether this matters
depends on the threat model; we state it rather than hide it.

## 7. A wallet does not reserve a coin because a ticket exists (verified)

Building a pre-signed ticket does not lock the coin it spends: an ordinary send from the same wallet spent it and
invalidated the ticket. The wallet library has an output-lock facility; using it (one owner per ticket, spends that name
their owner) made ordinary sends refuse the coin. See SPEC §3.

## 8. The wallet library's fee model reserves a change output (verified)

With ZIP 317 fees ([ZIP 317](https://zips.z.cash/zip-0317)) the library's change strategy always reserves room for a change
output, so a transaction with two payments and no change was refused as "insufficient funds" by 5,000 zatoshis even though
the exact amount was available. We rebuilt the proposal by hand (one spend, two outputs, no change, exact fee).

## 9. Payment-code (QR) size (measured by us)

Our payment link carries a sealed message; the link is about 548 characters and draws a QR code of version 16 (81 × 81
modules) at error-correction level L. A software decoder reads it down to 2 pixels per module when blurred and shrunk;
a real phone camera (Zkool) read it from a laptop screen. Shorter variants (a shorter address: version 15; also dropping a
field from the message: version 14) are supported by a "simpler code" button. How a wide range of phones behave: not tested.

## 10. Browser access to public lightwalletd servers (observed on 2026-10-06)

Browsers need servers that allow cross-origin requests. Of the public mainnet servers listed at
[hosh.zec.rocks](https://hosh.zec.rocks/zec) that we tried, only two allowed browser requests, and both answered through the
same hosting provider, so they are not independent evidence of each other. Others can be reached through a small forwarder
(`app/web/serve.py`). Servers change; re-check before relying on this.

## 11. A public server accepted a transaction and never mined it (observed once; cause not known)

During a test, a payment accepted by the wallet and handed to a public server was never mined and expired. We did not find
out why. Our host now records every transaction it sends and sends the identical bytes again after about ten blocks if the
server does not know it; this cannot create a second transaction because the bytes (and so the id) are identical.

## 12. Things we state as reasoning, not verified

* That `pczt send` (storing in the wallet before broadcast) can leave a coin marked pending forever when the network rejects
  a no-expiry transaction: read from code, not tested.
* That NU7 adds per-pool action limits that will require batching refunds: not found in the library code we read; treated
  as a possibility, and our host plans for batching only in principle (not built).
* The effect of a real network upgrade on our host: only one manual experiment (item 1 of EVIDENCE.md) and a simulation.
