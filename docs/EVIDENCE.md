# Evidence log

Status: **draft, not published.** Every row says what is claimed, what shows it, on which network, and how a reader
can check it for themselves. Where something was observed once and cannot be re-run by a reader, the row says so.
Transaction ids are shown in full where they were recorded; a few early experiment ids were only recorded in part
and are marked "partial". "Testnet" means the public Zcash test network after the NU7 upgrade (consensus branch
`77190ad9`); "mainnet" means the live Zcash network on the NU6.3 branch (`37a5165b`).

How to look up a transaction: any Zcash block explorer for the matching network, or ask a lightwalletd server for it
(`GetTransaction`). How to re-run a scenario: the scripts named below, from the repository root, with the test
wallets described in `app/e2e-one.sh`. The "recount" is `app/recount` (command line) or the recount web page
(`app/web/www/recount.html`), which re-checks a campaign from its public ledger and the chain.

## 1. Refund tickets and network upgrades

| Claim | Evidence | Network | How to verify |
|---|---|---|---|
| A refund ticket with no expiry can be held for a long time and still be accepted. | A ticket signed at height 4,465,406 was held for 1,517 blocks and then mined at height 4,466,926: txid `7701b38cb5583c7da31ff8b48e87f6941461f5e2cb8ced22bc1bd9cc17f4521f`. | testnet | Look up the txid; its expiry height field is 0 and its block height is 4,466,926. Re-create with the patched `zcash-devtool` in `src/` (`pczt create --expiry-height 0`). |
| A ticket signed under one network version is rejected after the next upgrade activates; re-issuing under the new version works. | An NU6.3 ticket broadcast after NU7 activated (testnet height 4,465,026) was rejected with "transaction uses an incorrect consensus branch id". A ticket re-issued for the same coin under the new version was accepted and mined at height 4,465,381 (id not recorded). | testnet | The rejection text is the node's own message; it was observed once and the rejected ticket's id was not kept, so a reader cannot replay it exactly. The host's re-issue behaviour is exercised by `app/e2e-one.sh g`, which **simulates** the change of version (it changes the version the host is told about); a real transition end to end was not re-tested. |
| A host can detect an upgrade by the chain's reported branch id and re-issue tickets by itself. | `cb-host watch` re-issued both tickets when the reported branch changed (scenario g, recount R1–R8 pass). Commit `bcbec1e`. | testnet (simulated change) | `app/e2e-one.sh g`. Limit: simulated, see above. |
| A ticket's transaction id can be published before the ticket is broadcast, because signing does not change it. | The id shown by `pczt inspect` before signing equalled the id of the extracted transaction. | testnet | `pczt inspect` the unsigned ticket, sign, extract, compare ids. |

## 2. A spent coin cannot be refunded: double-spend evidence

| Claim | Evidence | Network | How to verify |
|---|---|---|---|
| If a coin is spent by something other than its ticket, the ticket is rejected and the evidence is the coin's nullifier plus the spending transaction. | A normal wallet send spent a ticketed coin (txid `5194f283682665379b5566b4fd971bb6931aca030d6ed55abb80e04f4ba5e062`, mined at 4,466,965); broadcasting the held ticket (partial id `d511e41e…2518`, never mined) was then rejected with "ironwood double-spend: duplicate nullifier". | testnet | Find the nullifier of the coin in the spending transaction's action list; the recount's rule R5 reports exactly this kind of spend. Unit tests: `recount::tests` in `app/core` (`cargo test -p ll-core`). |
| A wallet does not reserve a coin just because a ticket spends it, so the host must lock coins itself. | The wallet's lock fields stayed empty and an ordinary send spent the coin (same experiment). With the host's lock, an ordinary payment from the campaign wallet was refused ("Insufficient balance"). | testnet | `app/e2e.sh` (lock check step). |
| The recount compares nullifiers correctly although tools print them in different byte orders. | The node's error printed the nullifier byte-reversed relative to the wallet database; the recount normalises the order (SPEC §0). | testnet | Compare the two representations of one nullifier; test in `app/core`. |

## 3. Hidden refund recipients

| Claim | Evidence | Network | How to verify |
|---|---|---|---|
| With the outgoing viewing key discarded, a holder of the campaign's viewing key sees that a ticket spent a coin and paid a fee, but not who received the refund or the memo. The recipient sees amount and memo. An unrelated wallet sees nothing. | Ticket `3c03768340a5d10998f4015373cb9d6f2f435248e7839814bbedb3c4fcb655df` (mined at 4,467,027) compared with an otherwise identical ticket that kept the outgoing key (`7701b38c…521f`). | testnet | Import the campaign's viewing key into a view-only wallet, sync, run the wallet's `enhance` step, and compare the two transactions. Caveat shown by the same test: the refund **amount** can still be inferred by viewing-key holders (input minus fee minus change). |

## 4. The three closing paths, and early withdrawal

All four were run on testnet in fresh wallets, with the recount rules R1–R8 passing; they are re-run by `app/e2e-one.sh a|b|c|d` and were re-run on 2026-10-06 after later changes (every scenario exited 0 and every recount said PASS).

| Path | Evidence (transactions) | How to verify |
|---|---|---|
| Goal met: the host sweeps the kept contributions after the deadline | sweeps `f5093779830e6583dd18e08ee32cd994f6cf96980f4249a52936288fee3e7d4d`, `6549d8d11a9ac12f99ac4648348b7b698555c90b64494e76b297bcbc3cb773d2` | `app/e2e-one.sh a` |
| Goal missed: the host broadcasts every refund ticket at close | refunds and totals are printed by the recount ("refunded 0.02") | `app/e2e-one.sh b` |
| Host silent: a contributor broadcasts their own ticket after the deadline plus K blocks | `66ea5e540da13bc7dd480c9a20cc3e36c03a1d63fb3835af162466fb08df980c`, `b69de9d435c18b6d8dc1042af6736b56418e86bb01488bec6c45cdc6ce54feef` | `app/e2e-one.sh c` |
| Early withdrawal: a contributor broadcasts their ticket before the deadline and is counted as withdrawn, not refunded | `1bf5ef00ac248f3afd43d8e344a26168d51212ded4e83b6f956657f2deecf22e`, `443d07e98cac8ca9a036d462294ff2d2e58dbf00fa00e07d27544c3593fe14dd` | `app/e2e-withdraw.sh`, `app/e2e-one.sh d` |
| Sealed-bid auction (pay-your-bid): the viewing key stays sealed until close, then winner swept and losers refunded | sweep `5ba67c017ccd75592f723a4c54c900b4dc413307cb9fa77465011c8dd6403ca1` | `app/e2e-one.sh e` |
| Re-issue keeps the wallet lock and tickets keep working | `app/e2e-one.sh f` (re-issued ticket partial id `4b15fb6a…cd93`) | `app/e2e-one.sh f` |

## 5. Rejected payments and challenges

| Claim | Evidence | Network | How to verify |
|---|---|---|---|
| A payment whose message cannot be opened is rejected in the signed ledger and counted as a donation; the recount still passes. | payment `e89df063d75ebe1269e813b395556c2759a17ce733cdf3fdc2b1a19cb8ecb0af` | testnet | `app/e2e-reject.sh` (needs the test-only cheating build, see the script header) |
| A host that wrongly rejects a genuine contribution is caught once the contributor publishes their one-time secret: the recount fails with evidence (rule R8). Without the secret the reject stands. | genuine payment `65d3704dd18f38ed8cdab2ce65a8903af79261e241fc6b8b28e38488325f01a0`; recount exit status 1 with the secret | testnet | `app/e2e-reject.sh`; unit tests `genuine_garbage_memo_reject_is_upheld_even_when_challenged` and the false-reject test in `app/core`. Commits `0baee37`, `57b1bfc`. |

## 6. Relay failure cases

A relay stores and serves the signed ledger; it is not trusted. Scenario `app/e2e-relay.sh` (commits `f7323fa`, `2ddf409`); 16 relay tests (`cargo test -p ll-relay`) and the scenario passed again on 2026-10-06.

| Situation | What the recount says |
|---|---|
| relay down | cannot conclude (exit status 4), never a pass |
| relay comes back empty | the host's next pass republishes everything it lacks |
| relay drops a middle entry | cannot conclude (broken chain), the saved copy of a ticket is used |
| one relay drops the newest entries | FAIL with a note that a single relay was read and may be missing entries |
| two relays disagree | cannot conclude; the output says it proves nothing about the host |
| one of two relays down | pass, labelled as read from one relay |
| two relays agree | pass |

## 7. Uniform-price auction and its cheating test

Specification: `SPEC.md` §8; merged in commit `e7bbce2`. Every winner pays the same price (the lowest winning bid, at least a reserve); each settlement is one transaction paying the price to a treasury whose viewing key is public and the excess back to the winner.

| Claim | Evidence | Network | How to verify |
|---|---|---|---|
| An honest auction passes the recount, including the new rules R9–R12; the treasury received exactly winners × price. | campaign `05866b7692862757cf830da6ee410f45d27e046e8e27b4969878e9e86bb37b66`: settlement `1adb202c8623f7313ccd4a9c818242802477ee550f51927190afce95d8841a60` (excess 100,000 zatoshi paid), loser's refund `1c38f84ebfdb0cba9b070614a7e2a337169a4d88e5060eba3170d2b8272a4bed`; price 0.0019, treasury 0.0038 | testnet | `app/auction-e2e.sh`, then open the recount page for the campaign |
| The public **cannot** see where a winner's excess went (outgoing key discarded). A host that sends the excess elsewhere passes the recount unless the winner proves non-delivery. | campaign `922d1bef762a058b89bb121c433b0e6c2dda55b9ddba7d102c5dd0b722cb7cd7` (host built with the test-only `test-cheats` feature, which prints a banner): diverted settlement `c2f003e51ed2647811203e2421672471fad26bc41cf4d79a5bfb0562b3c361e9`. Recount without the winner's key: all checks pass. Recount with the winner's incoming viewing key: **FAIL R12, "excess not delivered … opens outputs of []"**. | testnet | `DIVERT=1 app/auction-e2e.sh` (cheating build), then the recount page, before and after `cb-contrib challenge --uivk …` |
| A winner who does publish a key can show the excess arrived. | campaign `05866b76…` above: after the winner's key was published the recount said "excess delivered (100000 zat …)". | testnet | as above |
| Settlements made too late, or an auction whose host announces a settlement that never reaches the chain, fail rule R9. | campaigns `33a840087f0c7b097aef8d2f92799fc89d4c546cda90b80c90612a507d5ce681` and `32ea71afc470d77909a1b7b4a1fdaba36f0612df3a973df0ce1410c5ca16467a` (first runs): R9 "settled … after the settlement deadline". Unit tests in `app/core/src/recount/tests/uniform.rs` (40 core tests pass). | testnet | `cargo test -p ll-core` |
| Tie-breaking follows the chain, not the host's ledger order. | unit test `tie_order_follows_the_chain_not_the_ledger_or_the_hosts_choice` | n/a | `cargo test -p ll-core` |

The cheating hosts above are produced by switches that exist only in builds made with `--features test-cheats`; a normal build refuses them.

## 8. Mainnet runs (live network, small amounts)

Transaction ids, campaign ids and block heights of these runs are deliberately not published in this file. Each run was made by the project's own wallets; what was observed is stated below, and nothing is claimed beyond it.

### 8a. Pilot, 2026-10-08 (current version of the payment code and pages)

One fundraiser on the main network (network version before NU7, branch `37a5165b`), goal 0.001 ZEC, one contribution of 0.0002 ZEC from a phone wallet.

| Claim | What was observed |
|---|---|
| A real phone wallet paid a fundraiser's shielded address from the page's payment code. | The wallet showed the correct amount and message before the payment was confirmed. |
| The ticket was issued and passed the checks. | The page showed the refund ticket as received and passed (the ticket checks L1 to L3; see below for what was not checked). |
| The contributor took the contribution back with the ticket ("Refund me"). | The refund was mined 16 blocks after the payment. The 0.0001 ZEC that reached the contributor's wallet is the 0.0002 ZEC contribution minus the 0.0001 ZEC ticket fee. |
| The campaign closed as "goal missed". | The host closed it from the dashboard after the deadline; the public ledger holds the one issue entry and the close entry. |
| The recount agreed. | Raised 0.0002 ZEC, taken back 0.0002 ZEC. The campaign was published to a single relay, so the recount was marked **limited**, not a full pass. |

Not tested in this pilot, and so not claimed for the current version on the main network:

* **The host refunding a contribution at close.** The only contribution was taken back by its owner before the deadline. (This path was run on the main network on 2026-10-06 with an earlier version, section 8b, and on the test network with the current version, section 4.)
* **Re-issuing a ticket across a real network upgrade.** No upgrade happened during the pilot. It was done once, by hand, on the test network at the NU7 activation (section 1).
* **The ticket proof check and the anchor check.** The proof check was not run on the main network. The anchor check (L4) and ledger anchoring are not built.
* More than one contribution, an auction on the main network, other wallets, and a full multi-relay recount.

Other things observed: loading the page through a free tunnel the first time took about 2 minutes, so a demo should not run from one.

### 8b. Smoke run, 2026-10-06 (earlier version of the payment code and pages)

One fundraiser, goal 0.005 ZEC, two contributions of 0.002 ZEC each from two separate wallets (one a phone wallet, Vizor on Android, which scanned the page's payment code; this code did not yet have the amount sealed in). Network version at the time: `37a5165b`.

| Claim | Evidence |
|---|---|
| A contributor withdrew early with their own ticket. | Observed on chain; ids withheld. |
| The host refunded the other contribution at close (goal missed). | Observed on chain; ids withheld. |
| The recount, run in the browser against three public servers that appear to run on three separate hosting providers (hosting can only be judged from the outside), said all checks pass. | Totals: raised 0.004, withdrawn early 0.002, refunded 0.002, kept 0. The campaign's public ledger was served from the host's own machine. |
| Spent: 0.004 ZEC paid in, 0.0038 returned. | Ticket fees 0.0002 plus the payers' own network fees. |

## 9. Re-sending dropped transactions

Commit `53b710a` (host outbox) and `e6efa6a` (contribute page). Every transaction the host sends is recorded first and followed until mined; if a server drops it, the very same bytes are sent again after about ten blocks. A fake flaky server (test-only build) dropped the first broadcast of each transaction; each was then sent again with identical bytes, mined once, and every coin ended up spent exactly once (`app/drop-e2e.sh`, verifier `app/drop-verify.py`).

| Transaction | Id (the same before the drop, in the resend log line and when confirmed) | Confirmed in block |
|---|---|---|
| close refund | `d952b112b60beb72784c818afa2defc48b84b03db412aa5b5063a213e94664e0` | 4,471,637 |
| close refund | `34ca1757ed07ecacf507e14192acd0732d34dbd6a07cf2e42c9e26b46811f002` | 4,471,637 |
| sweep | `ac51c53e928f37f1be54163edfe226575baabfd6186ef2d920981c204f665ed4` | 4,471,717 |
| settlement | `22a1f921410f3378c2abef479067e971eddebb69c28af28482430b9351d94e76` | 4,471,799 |
| settlement | `0afa1b30a27d4fb8555ea3ba4e63d2879c4d73d5593b34e2da2ae500b93d7914` | 4,471,799 |
| refund (auction loser) | `09de66c2ac6a513c98384ecad0e2535842c7caa4ffdb138e58b796da2982283e` | 4,471,799 |

Unit tests for the outbox: `cargo test -p ll-host` (resend with identical bytes, a node answering "already known" is not an error, a coin spent by something else supersedes). The browser "Refund me" version of this test (`app/web/refund-drop.sh`) is described in the repository; its result is recorded when it is run.

## 10. Other checks

| Claim | Evidence | How to verify |
|---|---|---|
| The key-derivation and sealed-box formats match an independent implementation (libsodium.js). | 22 checks pass | `app/vectors` (`ll-vectors generate`, then `node js/check.cjs vectors.json`) |
| The campaign, contribute and recount pages work in a real browser against a real campaign. | 24 and 30 browser checks, 17 for the auction result card | `app/web/pages-e2e.cjs`, `contribute-e2e.cjs`, `auction-page-e2e.cjs` |
| A phone wallet could scan the payment code from a screen and fill in address, amount and message. | observed once on Android with Zkool 6.32.0-rc on testnet; its send then failed (see FINDINGS). On the main network a phone wallet (Vizor, Android) paid a campaign by scanning the page's payment code on 2026-10-06 (earlier code, without the amount sealed in) and a phone wallet did so again on 2026-10-08 with the current code (section 8) | observation only; try it with the contribute page |

## Pending

* A ticket held since 2026-10-06 00:15 UTC (testnet campaign id `c73081f362e81b82af4087a47c24fee636dc23d1e991eb0998c7c5b0e3a0c7eb`, ticket `027b2bcac3c765de9f3eab4346c56575f1ad96ded644919e3e16d51a824febae`) is to be broadcast later to measure how long a ticket really stays valid. No result yet.
* Mainnet addresses in the standard `u1` form: phone wallets paid a campaign's `u1` address on 2026-10-06 and 2026-10-08 (section 8); other wallets are not yet checked.
