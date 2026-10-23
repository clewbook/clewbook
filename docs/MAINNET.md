# Mainnet and the NU7 network upgrade

Moved here from the README on 14 October 2026, unchanged.

- The testnet activated NU7 at height 4,465,026 (branch id 0x77190ad9). A ticket is valid under one consensus branch only (observed: a ticket signed before NU7 and sent after it was rejected), so tickets signed before an upgrade must be re-issued after it. This project does not build tickets valid under two branches. This build's libraries have no mainnet NU7 height yet, so before mainnet activation they have to be updated; that has not been done.
- Creating a campaign on the main network (command line or dashboard) and closing one from the dashboard need an explicit "real money" confirmation. A campaign that could still be running when NU7 activates is refused: with `--nu7-mainnet-height` it must end well before that height; without it, it must be over a week before 5 November 2026 (the rule and its unit tests are in `app/host/src/mainnet.rs`).
- A first run on the main network, with two wallets (one a phone wallet) and 0.002 ZEC each, was made on 2026-10-06 on the network version before NU7 (branch 37a5165b): one contribution was taken back early with its own ticket, the other refunded by the host at close, and the recount passed (docs/EVIDENCE.md section 8). On 2026-10-08 a pilot with the current version followed (branch 37a5165b): a phone wallet paid 0.0002 ZEC into a fundraiser, the ticket was issued and passed the checks, the contributor took the contribution back with it, the campaign closed as goal missed, and the recount agreed; it ran on a single relay, so the recount was marked limited. Not tested on the main network with the current version: the host refunding at close, ticket re-issue across a real network upgrade, the ticket proof and anchor checks, an auction, and a multi-relay recount (docs/EVIDENCE.md section 8).
- The mainnet NU7 activation height and date: **unverified** (reports only, not read from an official specification by us). State them here only once confirmed.

Built for the Zcash network. It runs today on the testnet that has activated NU7 (consensus branch 0x77190ad9), using the Ironwood shielded pool. Two small runs on the main network are recorded in docs/EVIDENCE.md section 8: one on 2026-10-06 with an earlier version of the payment code and pages, and a pilot on 2026-10-08 with the current version (one phone-wallet contribution, taken back with its ticket; one relay only, so the recount was marked limited). What was not tested there is listed in section 8 and in the list above.

## Blind bid auctions on the main network (from 23 Oct 2026)

A blind bid auction (docs/BLIND_BIDS.md) runs on the main network only if it is over, late tickets included, before block 3,542,253: the
NU7 upgrade is at block 3,543,405 (ZIP 259, still "Proposed" on 22 Oct 2026), less about a day of margin. Signed tickets, early and late,
are valid for one network version only, so an auction that ran across the upgrade could leave late tickets the network refuses. The host
checks this before it makes any wallet, the rules check refuses such an auction everywhere (host, relay, bid page, recount), and the quick
test timing is refused. The bid page trusts the host's small payment after 2 confirmations and asks two chain servers before it says
PROTECTED. The project runs its main network blind bid host on its own server; each auction's wallets are made there. The first auction
and its transactions are in docs/EVIDENCE.md section 14.

## How long a blind bid auction can run before NU7

A blind bid auction on mainnet must be over, late tickets included, before block **3,542,253** (NU7 at 3,543,405, less 1,152 blocks).
"Over" means its late ticket block, plus the ticket window K, plus 100 blocks for the late tickets to be sent and mined.

The dashboard's Create button checks this before it makes any wallet, and refuses a deadline that is too far with one line naming the
block the auction would end at. `cb-host create-sealed --confirm-mainnet` refuses it when it checks the rules. The rules check refuses it
again everywhere (host, relay, bid page, recount).

To check by hand before you try: with the chain at block T and a deadline D blocks from now, the late ticket block is about
T + (80 × D + 9,000) ÷ 60 (block times of 60 to 80 seconds, 30 minutes before the round, 60 minutes to settle, 60 minutes of margin). So
the auction fits when

T + (80 × D + 9,000) ÷ 60 + K + 100 < 3,542,253

| Chain at | Ticket window K | Longest deadline |
|---|---|---|
| 3,527,300 (23 Oct 2026) | 30 | about 11,000 blocks, about 9.5 days |

Each day the chain moves about 1,152 blocks, and the longest deadline shrinks by about 860 blocks.

## 25 second blocks after NU7

NU7 is at block 3,543,405 (ZIP 259, still "Proposed"), expected about 6 November 2026. Blocks then come every 25 seconds instead of 75
(ZIP 218). Windows counted in blocks would last a third as long, so a campaign made at or after NU7 on its network (main from block
3,543,405; test since block 4,465,026) gets three times the blocks. A campaign's rules are signed when it is made, so one made before NU7
keeps its own numbers.

**A campaign made before NU7 and still open after it**

| What | What happens |
|---|---|
| Its windows | They keep their block numbers, so they pass three times faster. A ticket window of 30 blocks lasts about 12 minutes instead of 37. |
| Its tickets | Each ticket is signed for the network version before NU7. The network refuses it after the upgrade. The host must issue every ticket again after NU7. |
| This build | It cannot sign mainnet tickets after NU7: its libraries do not have the mainnet NU7 settings yet. A host needs an updated build first. |
| So | The host program refuses to make a mainnet campaign that could still be open at NU7. A blind bid auction must end before block 3,542,253 (above). |

| What | Made before NU7 | Made after NU7 | Test |
|---|---|---|---|
| Default ticket window K, close grace, reissue window, settle window | 30, 10, 20, 40 blocks | 90, 30, 60, 120 blocks | core `a_campaign_made_after_nu7_gets_three_times_the_default_windows` |
| Blind bid timing on the main network | blocks of 60 to 80 s | 20 to 80 s, as on the test network | core `on_the_main_network_an_auction_made_from_nu7_on_plans_with_25_second_blocks` |
| Blind bid: the host sends coins at once, and the bid page warns, before the coin cutoff | 20 and 15 blocks | 60 and 45 blocks (standard timing) | core `the_coin_rush_and_warning_are_tripled_for_a_standard_auction_made_after_nu7_only`, host `coins_go_out_as_the_host_chose_and_always_near_the_cutoff` |
| Expiry of the coin payments (the only sends that expire) | the wallet library's 40 blocks | 120 blocks, as ZIP 218 advises | host `a_coin_send_after_nu7_expires_after_120_blocks_and_before_it_keeps_the_default` |
| "About N days" on the pages | the last 100 or 200 blocks | only blocks after NU7 (no estimate for the first 20) | `app/web/nu7-e2e.cjs` |
| Listing job: blocks and time per recount | 60,000 blocks, 1,800 s (were 20,000 and 600 s) | the same | listing tests |

The quick test timing keeps its short numbers.
