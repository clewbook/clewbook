# Blind bid auctions

For hosts, for people who bid, and for judges. What a blind bid auction is, what it stops, what it does not stop, and how each claim
was checked. Every claim below names its test or its transaction.

## Who holds the money

Each campaign's host. The host runs the host program with its own wallet and keys, and holds the deposits until the close, like any
auctioneer. Clewbook holds money only for campaigns it hosts itself. What is different: every contributor holds a signed refund ticket
from the moment they pay, and anyone can recount the host's books against the Zcash chain, so a host that keeps money it should not gets
caught in public.

## 1. What it is and how it works

In a blind bid auction nobody can read a bid before bidding closes. Not the other people who bid, and not the host. The bids open
together, after the close, and anyone can recount the result against the chain.

### The bid page

The bid page has three steps: Bid, Pay, Status. The person picks a deposit size from cards and types a bid; while they type, a bid
that does not fit the chosen deposit is named at once ("Too high for a 0.1 TAZ deposit. Bid up to 0.0999 or pick a bigger deposit.").
A refund address for the other network is refused with one short line ("This is a mainnet address. Use a testnet one."). The status
card shows whether the deposit is PROTECTED. Taking a deposit back asks twice ("Take my money back", then "Yes, send it back"). After
the close the host sends the treasury to its own wallet from the dashboard ("Send to my wallet"). Tests: bid page
`bid-too-high-e2e.cjs` (the warning and the network check), `blind-cards-e2e.cjs` (the deposit cards), `bid-page-e2e.cjs` (the take back); core `a_refund_address_for_the_other_network_is_named`.

### A small example

A host sells 1 item. The deposit sizes (tranches) are 0.0002 and 0.0004. The price is the lowest winning bid.

1. **The bid.** Ana opens the bid page, picks the 0.0004 deposit and bids 0.0003. The page locks her bid to a future drand round R.
   Nobody can open the lock before drand publishes round R, which comes after bidding closes. The page shows a payment: 0.0004 to the
   auction, with a message (the memo).
2. **The memo.** It holds two parts. The first part holds Ana's refund address and her page's key, and only the host can read it. The
   second holds the locked bid and a binding tag. The tag ties the locked bid to this memo and this deposit size, so a lock copied
   into another payment counts as no bid. The deposit on the chain shows only its size, never the bid.
3. **The first ticket (the early ticket).** Within a few blocks the host writes Ana's deposit on the public list with an early ticket.
   It is a refund signed in advance that expires at the deadline. Until shortly before the deadline Ana can take her deposit back with
   it, from her page. With it the host also signs a refund for the close.
4. **The lock and the second ticket (the late ticket).** Before the coin cutoff the host sends Ana's page a small payment (the coin).
   Her page then signs a late ticket. It spends her deposit and the coin, and the chain takes it only after the late ticket block.
   Her page checks both tickets in full: who they pay, how much, the signatures, the proof, and the expiry or lock time. Then it says
   PROTECTED. From the deadline to the late ticket block, no ticket Ana holds works, so nobody can pull a deposit back after seeing
   the result.
5. **The close.** After the deadline drand publishes round R. The host opens every bid with the round's signature, writes the close
   on the list, sends the winner's price to the treasury and the rest of the winner's deposit back as change, and sends every other
   deposit back with its signed refund. Then it publishes its viewing key and its payload key.
6. **If the host never finishes.** If the host never finishes, open your bid page after block N and press Take my money back. N is the
   auction's late ticket block; the bid page shows it. The deposit, minus the fee, comes back by the late ticket. A backup file restored on
   any device works too. This needs the page to have said PROTECTED: the host's small payment (the coin) reached it before the cutoff and the
   page checked and signed the late ticket (step 4). A page that signs a late ticket from 23 Oct 2026 on also gives each list server a
   copy, which the server keeps and never shows (before the close it would show the deposit's size). A late ticket watcher running next
   to the relay sends each copy 60 minutes after the late ticket block (a setting) when the list shows no close and no settlement by then
   (`app/latewatch/`). The copy can only pay
   the deposit back to the refund address the page signed. On the project's server the watcher is staged, not running yet.
7. **The recount.** Anyone can recount the auction against the chain: checks R1 and R2 for the list, and S1 to S8 for the auction.
   It opens every bid itself, works out the winners and the price, and checks every payment the host made: the price to the
   treasury, and each refund, change and return to the refund address in the memo of the person it belongs to.

## Timing for hosts

Every number here is in the auction's signed rules, or in `app/core/src/sealed.rs`. The host program plans the timing when it makes the
auction, from the chain's height and time then.

| Moment | Rule (standard timing) |
|---|---|
| Last block for a deposit | 20 blocks before the deadline (the coin cutoff, then 10 blocks to mine the coin). A payment after it goes back on its own. |
| Bid window | From the start to the last block for a deposit. It must hold at least 10 blocks: the deadline must be at least K + 10 blocks away (K is the ticket window; at least 10). |
| Coin cutoff | 10 blocks before the deadline. Every small payment from the host must be mined by then. |
| Take back with the early ticket | Until 4 blocks before the deadline. The early ticket expires at the deadline. |
| Bids open | At a drand round (one every 3 seconds). It is planned so that, even if every block is slow, the deadline comes at least 30 minutes before it. |
| Settlement window | After the round, the host has at least 60 minutes on mainnet (30 minutes on the test network) to settle every winner and refund the others, even if every block is fast. |
| Safety margin | 60 more minutes before the late ticket block, so a run of fast blocks soon after the plan does not leave the auction without slack. |
| Late ticket block | Late tickets work from the next block on. The host must close before it. |
| Relays | From 5 minutes before the round, the list takes no new deposit, reject or small payment. |

"Slow" and "fast" are the planning range of block times:

| Auction | Range |
|---|---|
| Mainnet, made before NU7 | 60 to 80 seconds |
| Mainnet, made at or after NU7 (block 3,543,405) | 20 to 80 seconds |
| Test network | 20 to 80 seconds |
| Quick test timing (test network only) | 20 to 40 seconds, 10 minutes before the round, 10 minutes of margin |

What this gives, from the same formula the host program uses:

| Auction | Late ticket block |
|---|---|
| Mainnet before NU7, 1 day (1,152 blocks) | deadline + 534 blocks, about 11 hours |
| Mainnet before NU7, 3 days (3,456 blocks) | deadline + 1,302 blocks, about 27 hours |
| Mainnet after NU7, 1 day (3,456 blocks) | deadline + 10,818 blocks, about 75 hours |
| Test network, 1 day (3,456 blocks) | deadline + 10,728 blocks, about 75 hours |
| Test network, quick timing, 120 blocks | deadline + 271 blocks (an auction of 23 Oct 2026) |

The wide range after NU7 makes the wait long: the bids must not open before the close if blocks are slow, and late tickets must not work
before the settlement if blocks are fast.

**Why the bid page refuses an auction with no slack.** Before anyone bids, the page checks the plan against the chain as it is now. It
refuses if the bids could open before bidding closes, or if late tickets could work before the host can settle. It also refuses a round
more than 10 minutes, or a late ticket block more than 10 blocks, later than the plan gives. Then it says "This auction's timing is
wrong. Do not bid." **Such an auction cannot be fixed.** The round and the late ticket block are part of the signed rules and of
the auction's id. Make a new auction.

## 2. What this design prevents

Each row is a cheat and the test that tries it and shows it caught. "Core", "ticket check", "relay" and "module" are Rust or browser
tests in this repository; "private chain" means a run on a private regtest chain on one machine, with no public network and no money;
"bid page" means the real page in a real browser. The ids are grouped in three sets by date; the ids B and H with numbers are the
cheating tests of the earlier two ticket prototype.

### First set (20 Oct 2026)

| Id | The cheat | What stops it | Test |
|---|---|---|---|
| C1 | The host signs a refund that pays itself, so it keeps a losing deposit | The refund is sealed to the bid page with its own outgoing key; the page opens it and checks who it pays before PROTECTED; after the close the recount opens it on the chain (S7) | core `c1_h2_with_open_payouts_every_refund_and_change_must_pay_the_refund_address_in_the_memo`; ticket check `c1_outputs_open_only_with_the_payments_own_key`; private chain `check-sealed-fixes.sh`, auction C (the host's refunds pay its own address: S7 fails); bid page `H4: an early ticket that does not pay this page's refund address` |
| H1 | After the bids open, the host adds its own bids with old block numbers | Relays refuse new deposit, reject and coin entries from 5 minutes before round R; the recount checks the order of entries (S2). This holds only with a relay the host does not run (see section 3) | relay `h1_no_deposit_reject_or_coin_is_added_once_the_bids_are_about_to_open`; core `h1_an_entry_added_to_the_list_long_after_later_payments_shows` |
| H2 | The host sends a winner's change to itself | The change is paid with an outgoing key the winner's page works out; the page and the recount (S6) open it | core `c1_h2_…` (above); private chain, auction D (S6 fails) |
| H3 | The host rejects a valid deposit and keeps it | A rejected payment is sent back on its own, minus the fee, and S7 requires it; the reject carries the memo's hash, so the bid page shows it and offers a button to publish proof | core `h3_a_rejected_payment_must_be_sent_back_and_its_reject_must_name_its_memo`; relay `h3_a_rejected_payment_and_l6_a_deposit_a_reorg_made_late_are_sent_back`; private chain, auctions A (sent back) and B (kept: S7 fails); bid page `bid-page-reject-e2e.cjs` |
| H4 | The host hands out a broken early ticket, and the page still says PROTECTED | The page runs the full ticket check (who it pays, amount, signatures, proof, expiry equal to the deadline) before PROTECTED or the take back button | ticket check `h4_an_early_ticket_must_expire_exactly_at_the_deadline`; bid page `H4: an early ticket that does not pay this page's refund address is NOT PROTECTED` |
| H5 | The host builds the late ticket for another network version, so the network never takes it | The page asks the network for its version and refuses a late ticket built for another | ticket check `h5_a_late_ticket_for_another_network_version_is_refused` |
| M1 | The host sets late tickets to work years later, or the bids to open long after the close, or a late ticket block read as a date | The rules check refuses a late ticket block of 500,000,000 or more; the page compares the round and the late ticket block with what the plan gives from the chain when the auction was made | core `m1_the_round_and_the_late_ticket_block_have_upper_limits`; module `M1: a late ticket block a year after the plan is refused`, `M1: a round a day after the plan is refused` |
| M2 | The host's link names the host's own chain server, which fakes the coin and the heights | On the test and main networks the bid page uses its own chain server and ignores the one in the link | test network check of the fixes (section 4): a link naming a dead server; the page asked only its own server and said so |
| M3 | A person closes the page before PROTECTED, and has no late ticket | The page says plainly to keep it open until PROTECTED, and warns from 15 blocks before the cutoff | bid page `M3: … the page says to keep it open until PROTECTED`, `M3: 8 blocks before the cutoff …, warns, and offers the take back` |
| M4 | A funded host searches for a memo whose 7 byte tag matches someone else's lock | New auctions use a 16 byte tag made with a key inside the lock; nobody knows the key before round R, so nobody can search for a match; the memo fills its 512 bytes exactly | core `m4_the_bound_kind_fills_the_memo_and_a_copied_lock_never_binds`, `m4_with_the_long_tag_a_copied_lock_and_an_older_memo_are_no_bid`; module `M4: … exactly fills 512 bytes` |
| M5 | A person pays twice with the same memo, and the host keeps the second payment | The second payment is sent back on its own, minus the fee; S7 requires it | core `m5_a_second_payment_with_a_deposits_memo_goes_back`; private chain, auction A |
| L1 | The block number on the reveal entry is the host's own claim | Not fixed. S8 still checks that the reveal comes after every settlement is mined and that the keys match; the money checks (S6, S7) do not depend on it | none |
| L2 | The recount cannot read the block times around the deadline, and takes "void" on trust | The recount says "cannot conclude", never "void"; it is never a pass | core `l2_without_the_block_times_a_void_close_cannot_be_concluded` |
| L3 | The host sets the late ticket's network fee too low to be relayed | The page checks the fee is at least what the network relays | ticket check `l3_a_late_ticket_whose_fee_the_network_would_not_relay_is_refused` |
| L4 | A reorganised chain drops the coin, and the page still says PROTECTED | A page opened again checks the coin is still on the chain | bid page `L4: reopened after the coin left the chain, PROTECTED becomes NOT PROTECTED` |
| L5 | An early ticket sent in the last blocks is refused by zcashd nodes | The page offers the take back until the deadline minus 4: zcashd refuses a transaction whose next block plus 3 passes its expiry, Zebra one whose expiry the tip has reached; the larger margin is used | bid page `margin: at block deadline minus 4 …`, `margin: at block deadline minus 3 it is gone` |
| L6 | A reorganised chain moves a deposit into the last blocks before the deadline, and nothing sends it back | The host sends back any payment in those blocks, with or without tickets; the recount requires it | core `l6_a_deposit_a_reorg_moves_into_the_last_blocks_still_goes_back`; relay `h3_…_and_l6_…` |
| L7 | A main network auction needs its late tickets after a network upgrade, which they would not survive | The rules check counts the whole life of the auction, up to and past the late ticket block, and refuses it unless it ends before the upgrade height (an assumed height until the official one is published) | core `l7_on_the_main_network_the_upgrade_cutoff_counts_from_the_late_ticket_block` |

### Second set (21 Oct 2026)

| Id | The cheat | What stops it | Test |
|---|---|---|---|
| C1 | The host hands out an early ticket that pays the host, in a format the page cannot open, and the page still offers the take back | The page uses a ticket only when it has checked who it pays and the network version; new auctions make the early ticket with its own outgoing key, and S4 checks a deposit taken back paid the refund address in its memo | core `set2_c1_a_deposit_taken_back_must_have_paid_its_refund_address`; private chain `check-sealed-fixes.sh`, auction E (a take back to the host: S4 fails); bid page `bid-page-early-e2e.cjs` |
| H1 | Every refund address becomes public at the close, and nobody was told | Said plainly before the payment on the bid page and on the set up page, and in section 3 | bid page `set 2 H1: before the payment the form says …` |
| H2 | The host fills a rejected payment's challenge slots on the relay with junk, so the real proof is refused | In new auctions the relay takes a challenge only with the payment's memo (checked against the reject's hash) and only if its secret opens that memo | relay `set2_h2_junk_cannot_fill_a_rejected_payments_challenge_slots`; bid page `bid-page-reject-e2e.cjs` (the real challenge is taken) |
| M1 | A person pays a little more than the deposit size, and the page wrongly says the host's honest ticket does not check out | The page accepts a ticket paying at least the size minus the fee and takes the amount paid from the ticket; the recount checks the exact amount | bid page `set 2 M1: a deposit that paid more than its size …` (private chain fixture) |
| M2 | The listing cannot judge a blind bid auction, and never marks a host that does not finish | The listing reads the coins and judges at the chain's height; it lists a blind bid auction only if it publishes to our relay, judged together with ours | listing `set2_m2_a_blind_bid_auction_is_listed_only_through_our_relay`, `…_a_late_entry_only_on_the_hosts_relay_shows_the_relays_disagree`, `…_a_host_that_never_closes_is_marked_did_not_finish_by_the_listing` |
| M3 | A host that runs the only relay adds a late bid | Not fixed by code: a documented limit (section 3) | none |
| M4 | Rules that say "regtest" switch off the test network's checks | The rules check takes only main, test and regtest; public relays refuse regtest rules; the bid page opens a regtest auction only on the computer of that chain | relay `set2_m4_a_public_relay_takes_no_regtest_rules_and_no_unknown_network`; bid page `set 2 M4: …` |
| M5 | A stranger fills a relay's disk | Storage caps per campaign (64 MB) and per relay (4 GB) | relay `set2_m5_a_campaign_and_the_relay_have_a_storage_cap` |
| M6 | A stranger fills the listing queue with free host keys | At most 5 new records per address per week from hosts not approved | listing `set2_m6_one_address_cannot_fill_the_queue_with_new_host_keys` |
| L1 | A late ticket that spends more than the deposit | Exactly two actions, and only the deposit minus the refund may leave the pool; a balanced extra spend is still not visible (section 3) | ticket check `set2_l1_a_late_ticket_that_takes_more_than_the_deposit_minus_the_refund_out_of_the_pool_is_refused` |
| L2 | The network version cannot be asked, and the page takes that as fine or as a lasting failure | The page asks again on the next refresh and uses no ticket meanwhile | bid page `set 2 L2: …` |
| L3 | The proof checker fails to load and the page waits for ever | The page then says NOT PROTECTED; the checker uses the network's version | bid page `set 2 L3: …` |
| L4 | A crafted backup file runs script in the page | The payment code is shown as an image, and a restored file is checked | bid page `set 2 L4: a crafted backup file …`, `… a backup file with a malformed key is refused` |
| L5 | A ticket window that does not fit is cut down, after wallets are made | It is checked first, and refused when it does not fit | host `set2_l5_the_ticket_window_is_checked_before_anything_is_made` |
| L6, L7 | Set up and dashboard wording that is not true for blind bids | Each line corrected, one short line | set up page `L6: …`, `L7: …` |

### Third set (22 Oct 2026)

| Id | The cheat | What stops it | Test |
|---|---|---|---|
| L-T | The host spends a deposit itself after the late ticket block and writes that spend on its list as the deposit's late ticket; before the fix the recount counted any spend with that id as refunded | S7 reads the spend's shape: a real late ticket spends exactly the bid page's coin, which only the page can sign after checking whom the ticket pays, with the late ticket block as lock time, two actions and only the fee leaving the pool. New auctions also make the late ticket with its own key (`late_key`); the page refuses one made with any other key, and once the host publishes its key the recount opens it and checks it paid the refund address. Refunds, returns and early tickets get the same shape check. An auction made before these checks is flagged as not fully checkable | core `a_hosts_own_spend_named_as_the_late_ticket_is_caught_by_its_shape`, `a_late_ticket_that_does_not_pay_the_person_fails_s7_once_the_key_is_published`, `an_auction_without_every_check_is_flagged_not_fully_checkable`; the four test network proofs P1 to P4 and the sample auction keep their results with the new check (22 Oct 2026) |

### From the two ticket prototype and the recount tests

| Id | The cheat | What stops it | Test |
|---|---|---|---|
| B1 | The winner pulls the deposit back after the deadline | The early ticket has expired and the late ticket is locked | prototype A1, A2 (research note 16) |
| B2 | Use both tickets, or one twice | The chain spends each note once | prototype B2 |
| B3 | Pay the small tranche but bid more than it holds | It counts as no bid | core `b3_a_bid_above_its_tranche_is_no_bid` |
| B4 | Copy someone else's locked bid into one's own memo | The binding tag: no bid, and the original still counts | core `b4_a_lock_copied_into_another_memo_is_no_bid_and_the_original_still_counts` |
| B5 | Pay an amount between two tranches | It counts as the tranche below | core `b5_a_payment_between_tranches_counts_as_the_tranche_below` |
| H1 | The host spends a deposit other than by its tickets | S4 and S7 fail | core `h1_spending_a_deposit_other_than_by_its_tickets_fails` |
| H2 | The host never finishes | Every late ticket works after the late ticket block; the recount says "did not finish" | core `h2_a_host_that_does_not_finish_is_marked_did_not_finish`; test network P4 |
| H3 | The host copies a large deposit's memo into a small payment to keep the large one | A payment counts only at the tranche its memo names | core `h3_a_copy_paying_a_smaller_tranche_cannot_take_the_real_deposit` |
| H5 | Wrong winners, wrong price, or keeping more | S5 and S6 fail | core `h5_wrong_winners_wrong_price_or_keeping_more_fail` |
| H6 | Open the bids early | Nothing opens without round R's real signature | core `h6_the_bids_open_only_with_round_rs_real_signature` |
| CH1 to CH3 | The coin comes late, to the wrong address, or from the auction's own funds | S3 fails | core `ch1_to_ch3_the_coin_must_come_in_time_to_the_right_address_from_outside_the_campaign` |
| | A deposit in the last blocks, after the deadline, or without tickets | It is sent back on its own; S7 requires it | core `a_payment_in_the_last_three_blocks_is_late_and_must_be_sent_back`, `a_deposit_after_the_deadline_must_be_sent_back_by_the_return_on_the_list`, `a_deposit_without_tickets_does_not_bid_and_must_be_sent_back_after_the_close` |
| | Round R came too early for the deadline | The auction is void, every deposit goes back | core `the_auction_is_void_only_if_round_r_came_too_early` |

## 3. What it does not prevent

- **The host sees that a bid arrived.** It sees when, the deposit size and the refund address. It does not see the bid.
- **Bids and refund addresses become public after the close.** Once the host publishes its keys, anyone can open every bid, winning or
  not, and every refund address, so that anyone can check every payment. The bid page says so before the payment; use a refund address
  you do not use elsewhere.
- **A host that runs the only relay** can still add a bid of its own after the bids open, made in the last blocks before the deadline:
  the relays' time rule and the order check only help when the host does not control the relay's clock. Use at least one relay the host
  does not run.
- **Auctions listed on clewbook use our relay, which refuses late entries; direct links to other relays do not have this protection.**
- **A late ticket can be tied to another note of the host's.** If the late ticket also spends a note of the host's, balanced by an equal
  output to the host, the page cannot tell; when the host later spends that note, the late ticket fails. The recount then shows the
  deposit was not refunded.
- **drand.** The design relies on the drand network's members not working together to publish round R early.
- **The host can still move a deposit with its key.** Nothing on the chain stops it. The recount shows it, and the person keeps a
  late ticket for the money. Signing by several parties is on the roadmap ("Shared custody" in [ROADMAP.md](ROADMAP.md)); it is
  research, not built.
- **The page must stay open until PROTECTED.** The page checks and signs the late ticket only while it is open, and only after the
  coin arrives. A person who closes it before then, and does not open it again before the cutoff, has no late ticket. If the host
  then disappears with its relays, that deposit stays locked. The page says this plainly and warns from 15 blocks before the cutoff (45 for an auction made after NU7).
- **Inclusion is not promised.** An early ticket sent before the deadline minus 4 may still not be mined in time on a slow network.
  The person's money then comes back at the close by the signed refund (test network, third rerun: early ticket f36c2433…, not mined;
  refund mined in block 4523126).
- **The reveal block is the host's claim** (L1 above).
- **The main network, before NU7.** Blind bid auctions run on the test network since 21 Oct 2026 and on the main network since 23 Oct
  2026. A main network auction must be over, late tickets included, before block 3,542,253: the NU7 upgrade is at block 3,543,405 (ZIP
  259, whose status was still "Proposed" on 22 Oct 2026), less about a day of margin, because signed tickets do not survive a network
  upgrade. The host refuses a longer one before it makes any wallet. Main network auctions are shared by link; the listing takes other
  hosts' main network campaigns only after NU7 (the project's own appear on the home page).

## 4. How it was checked

1. **The two ticket prototype on a private chain** (research note 16): 38 of 38 checks, including the cheating cases B1 to B6 and H1
   to H6.
2. **The cheating tests in this repository**, listed in section 2, run with every change.
3. **Private chain runs of the whole auction:** `app/regtest/check-sealed-intake.sh`, `check-sealed-close.sh`, `check-e2e.sh`
   (sixteen bid pages in a real browser) and `check-sealed-fixes.sh` (the fixes in section 2 with four cheating hosts).
4. **The public test network.** Four proof auctions (P1 uniform price, P2 second price, P3 pay your bid, P4 host never closes), a big
   run of nine cases (B1 to B9) and three reruns. Each is listed with its transactions on the Blind bids tab of
   [clewbook.xyz/demo/proofs](https://clewbook.xyz/demo/proofs), and with their block heights in [EVIDENCE.md](EVIDENCE.md) section 12. Example: P1, auction
   4bbdc3d44705c615ca2d6de3338312685bc19376222817154a94d8cd70cdf6e5, settlements 4d87cc5e… and eb2a2f91…, refund 2d131bc5…, browser recount
   "All checks pass".
5. **The test network check of the first set's fixes**, auction 6e7a904ad557b2a20941af1d562bc93de783855d240beb79f8087ec2dce877e8 (quick test
   timing, uniform price, 1 item). Every page of the five people who bid said PROTECTED before the deadline. One page closed and opened
   again was still PROTECTED. A person who paid after the coin cutoff took the deposit back with the early ticket
   (688027766e55c1d7ec2a76226237eac668c4c9f645ae769b0a321f7d017ffca9, mined in block 4523380, before the deadline 4523383). A payment after the
   deadline went back on its own (4a41c98d5ff3b43aaaa6eefc7c0cea75ac490c61fb16c2dc387aef093b4b10cf). After the close each losing page opened
   its refund on the chain with its own key and said it pays its refund address, and the late payer's page did the same for its return.
   A copy of a page opened with a link naming another chain server used its own server (M2).
6. **The main network.** The first main network auction, Apparition 69_ (23 Oct 2026; `docs/EVIDENCE.md` section 14): the first deposit's
   bid page said PROTECTED with both chain servers agreeing, and the recount from outside passes R1 and R2 before the close.
