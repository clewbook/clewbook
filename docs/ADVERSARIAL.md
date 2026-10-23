# Attacks tried

Every attack we have tried against Clewbook, who tries it, and what happened. Each row names the test or the transaction that shows it.

Status:

- **caught**: a check fails (the recount says FAIL with the evidence, or the page refuses or says NOT PROTECTED), every time the attack is
  made, in the test named;
- **flagged**: shown as information or a warning, or caught only when someone adds data (a key, a secret) that the attacker cannot stop;
  not a failure on its own;
- **not prevented**: possible today; the row says what limits it. These are also in [LIMITS.md](LIMITS.md).

Fundraisers and auctions: R1 to R12 ([CHECKS.md](CHECKS.md)). Blind bid auctions: R1, R2 and S1 to S8; the cheats found while building them, each
with its test, are in [BLIND_BIDS.md](BLIND_BIDS.md) section 2 and are only summarised here.

## The host

| Attack | Status | What happens | Test or evidence |
|---|---|---|---|
| Spends a contribution that has a ticket, before the deadline | caught (after the fact) | R5 fails, naming the spending transaction. The spend itself is not stopped: the host holds the key | demo proof 3c34b9ff (R5, R6); `early_spend_by_non_ticket_fails_r5`; `app/review-e2e.sh conflict` (testnet, 13 Oct 2026) |
| Keeps a contribution it should refund, after the deadline | caught (after the fact) | R6 fails, naming the spending transaction | demo proof 3c34b9ff; `goal_missed_keeping_money_fails_r6_and_lying_about_the_outcome_fails_r7` |
| Names its own spend a re-issued ticket, with no network upgrade or after the close | caught | R2 refuses the entry and the spend fails R5 or R6 | `a_spend_named_as_a_reissue_without_a_network_upgrade_is_caught`, `a_spend_named_as_a_reissue_after_the_close_is_caught` |
| Names its own spend the one re-issue at a real network upgrade | flagged | The recount accepts one re-issue per upgrade; the contributor's page refuses a re-issued ticket that does not show it pays them | `a_reissued_ticket_must_show_that_it_pays_you` |
| Hands a contributor a broken or junk ticket | caught | The contribute page's ticket checks fail and it says so | `app/web/junk-ticket.sh` (45 checks), `ticket-amount-e2e.cjs` |
| Issues a ticket late, while offline | caught (R4b) | R4b fails, using the issue height the host writes | main network: Clewbook Pre-seed Raise, ticket 110 blocks after its payment ([EVIDENCE.md](EVIDENCE.md) 11c); demo proof 65f3dd51 |
| Writes an earlier issue height than the real one | not prevented | R4b trusts the host's height; a relay run by someone else could stamp it (roadmap) | `app/review-e2e.sh backdate` (testnet) |
| Closes before the deadline when the rules do not allow it | caught | R2 and R5 fail | demo proof 36a51782 |
| Writes an earlier early close height to leave out a later payer | flagged | R3 fails if that payer was ticketed; otherwise listed under R2 as information | `app/review-e2e.sh earlybackdate` |
| Declares the wrong outcome or the wrong winners | caught | R7 fails | `goal_missed_keeping_money_fails_r6_and_lying_about_the_outcome_fails_r7` |
| Keeps a payment over the hard cap | caught | R6 fails | demo proof bc66ccca; `app/cap-e2e.sh` (15 checks) |
| Cancels a campaign that did not opt in, after the deadline, or forges a cancel | caught | R2 (and R7) fail; the relay refuses the first | `a_cancel_on_a_campaign_without_the_field_fails_r2_and_r7`, `a_forged_cancel_not_signed_by_the_host_fails_r2`, `a_cancel_after_the_deadline_fails_r2` |
| Keeps a contribution after a cancel | caught | R6 fails | `a_cancelled_campaign_that_keeps_a_contribution_fails_r6` |
| Keeps a payment that arrived after a cancel | flagged | Listed under R6 as information: the recount cannot open its message | `a_payment_after_the_cancel_does_not_count_and_is_sent_back_by_the_return_on_the_list` |
| Rejects a genuine contribution and keeps it | caught (with the payer's secret) | R8 fails once the payer publishes their one-time secret; without it the reject stands | `app/e2e-reject.sh` (testnet) |
| Settles an auction late, or announces a settlement that never reaches the chain | caught | R9 fails | demo proof 32ea71af; `cargo test -p ll-core` |
| Sends a winner's excess somewhere else (uniform price) | caught (with the winner's key) | R12 fails once the winner publishes a viewing key; without it the recount passes | testnet campaign 922d1bef (cheating build), [EVIDENCE.md](EVIDENCE.md) section 7 |
| Rewrites or drops entries of its published list | caught | R2 fails (broken chain, signature, gap); relays that disagree make the recount say it cannot conclude | `tampered_dropped_or_foreign_entries_fail`, `app/e2e-relay.sh` |
| Shows two different lists to two relays | flagged | The recount says the relays disagree and cannot conclude; ledger anchoring is planned | `pages-e2e.cjs`, `app/e2e-relay.sh` |
| Reads every bid as it arrives in an ordinary auction, and bids itself | not prevented | Stated on the pages; blind bid auctions exist for this | none |
| Keeps the money and disappears | flagged | Every contributor can send their own ticket after the deadline plus the ticket window | `app/e2e-one.sh` scenario c (testnet) |

## The host of a blind bid auction

| Attack | Status | What happens | Test or evidence |
|---|---|---|---|
| Reads bids before bidding closes | caught (impossible) | Bids are locked to a drand round after the close | `h6_the_bids_open_only_with_round_rs_real_signature` |
| Spends a deposit after the late ticket block and names it the deposit's late ticket | caught | S7 checks the spend: exactly the bid page's coin, the lock time, the amounts; with `late_key`, whom it paid | `a_hosts_own_spend_named_as_the_late_ticket_is_caught_by_its_shape`, `a_late_ticket_that_does_not_pay_the_person_fails_s7_once_the_key_is_published` |
| Signs refunds, change or early tickets that pay itself | caught | The bid page refuses before PROTECTED; S4, S6 and S7 open each payment and check whom it pays | [BLIND_BIDS.md](BLIND_BIDS.md) C1, H2, H4 of set 1 and C1 of set 2 |
| Never sends the small payment, or sends it late or wrong | flagged | The page warns and offers the take back; S3 fails | `ch1_to_ch3_...`, `bid-page-e2e.cjs` |
| Refuses to finish after seeing the bids | flagged | Every page that signed a late ticket takes the deposit back after the late ticket block; the recount says "did not finish"; a late ticket watcher can send the pages' copies (staged on the project's server) | test network proof P4 ([EVIDENCE.md](EVIDENCE.md) 12); `app/latewatch/latewatch-test.py`, `latewatch-e2e.cjs` |
| Adds its own bid after the bids open | caught (with a relay it does not run) | Relays refuse new deposits near round R; the recount checks the order. Not prevented when the host runs the only relay | `h1_no_deposit_reject_or_coin_is_added_once_the_bids_are_about_to_open` |
| Builds a late ticket for another network version, or with a fee too low to relay | caught | The bid page refuses to sign it | `h5_...`, `l3_...` in `cargo test -p ll-ticketcheck` |
| Names its own chain server in the link | caught | The bid page ignores it and uses its own two servers | M2 in [BLIND_BIDS.md](BLIND_BIDS.md) section 2, `bid-page-e2e.cjs` |
| Uses a chain server that lies about the coin | caught | The bid page asks two servers and says "The servers disagree. Wait or take your money back." | `bid-page-e2e.cjs` (two server checks) |
| Every cheat in the three sets of BLIND_BIDS section 2 | caught or stated | Each row with its test | [BLIND_BIDS.md](BLIND_BIDS.md) section 2 |

## A contributor, someone who bids, or a stranger

| Attack | Status | What happens | Test or evidence |
|---|---|---|---|
| Copies someone's pending memo into their own payment | flagged | The copier pays and their money goes to the original contributor's refund address; the original becomes a donation, about one network fee lost | `a_message_copied_into_an_earlier_payment_takes_the_contributors_place_but_is_visible`, `app/replay-e2e.sh` |
| Copies a locked bid into another memo, or bids above the deposit | caught | No bid | `b3_...`, `b4_...`, `m4_...` in `cargo test -p ll-core` |
| Hand builds a payment code that would make an honest host's recount fail | caught (as a reject) | The host rejects it at once; the recount upholds the reject | `a_challenge_cannot_revive_a_reject_for_a_refund_the_host_cannot_pay`, `app/review-e2e.sh fuzz` |
| Underpays with a wallet that lowers the amount | flagged | The page warns; the payment does not count as the intended contribution | `challenge-e2e.cjs`, `contribute-e2e.cjs` |
| Pays to the other network's address (a refund that could never arrive) | caught | The pages refuse it | `a_refund_address_for_the_other_network_is_named`, `bid-too-high-e2e.cjs` |
| Fills the cap and takes the payments back just before the close | not prevented | Others wait; it costs only fees | [LIMITS.md](LIMITS.md) |
| Crafts a backup file that runs script on the bid page | caught | The payment code is shown as an image; a restored file is checked | bid page `set 2 L4: a crafted backup file …` |
| Sends junk copies of a late ticket to a relay to crowd out the page's own | caught | The relay takes a copy only if it spends that deposit and its small payment, keeps up to four per deposit, and the watcher sends each; the network refuses all but a valid one | relay `a_late_ticket_is_kept_write_only_for_a_deposit_with_a_small_payment_and_junk_cannot_crowd_it_out` |
| Fills a relay's disk or the listing queue | caught | Storage caps per campaign and relay; at most 5 new records per address a week from hosts not yet approved | `set2_m5_...`, `set2_m6_...` |
| Asks to be listed under a misleading name | flagged | Reserved words refused in any spelling; the operator approves every host by hand | `a_host_may_suggest_its_name_and_reserved_labels_bind_only_the_host` |
| Sends commands to the operator bot | caught | Ignored and logged; only the operator's user id and chat answer | `app/opbot/opbot-e2e.py` (testnet, 23 Oct 2026) |

## Networks, servers and the project itself

| Attack | Status | What happens | Test or evidence |
|---|---|---|---|
| One relay drops, hides or reorders entries | caught or flagged | A broken chain or disagreeing relays: the recount cannot conclude, never a false pass | `app/e2e-relay.sh` ([EVIDENCE.md](EVIDENCE.md) section 6) |
| A chain server lies or is stale | flagged | The recount compares servers and says when only one answered | `pages-e2e.cjs` |
| Watches network traffic to link a visitor to a payment | not prevented | Chain servers and relays see the visitor's address; the contribute page fetches every ticket in random order | `stage-h-e2e.cjs` |
| Serves a changed recount page | not prevented | The command line recount (`cb-recount`) can be built from this repository instead | none |
| A drand round published early by drand's members | not prevented | The design relies on drand's members not working together | none |
