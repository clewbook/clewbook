# Polish and later items (internal working list; not published; nothing here is built yet)

1. **Custom campaign name** instead of "Campaign [private list: ids]…". (Needs a place for the name that is not forgeable: see the note on the host title in `docs/PUBLISH_HISTORY.md` and the earlier decision that a title belongs in the signed rules.)
2. **Status badge:** blinking green while open, static red when closed. Keep the word OPEN or CLOSED on it, respect reduced motion, and give refunding, failed and succeeded their own states.
3. **A way back to the amount screen and a clear "start over".** The browser back arrow currently leaves the site, and reopening the contributor link returns to the payment step.
4. **The pre-payment warning:** clear, boxed, readable at a glance, not a billboard and not tiny.
5. **Later, not a must:** return the excess of an overpayment (needs a ledger entry and the host online). Anything below the smallest contribution stays a donation, and the page should say so clearly.
6. **Later, not a must:** an optional team top-up so contributors get the full amount back (a separate 0.0001 ZEC payment outside the pre-signed ticket).
7. **Question: has ticket re-issue across a real network upgrade ever been tested?** Answer, from the working log: only once and by hand, on the test network at the NU7 activation (a ticket signed under the earlier version was rejected after the upgrade with "transaction uses an incorrect consensus branch id"; a ticket re-issued for the same coin under the new version was accepted and mined). The host's `reissue` command and its watcher were tested on the test network with a simulated version change (`--assume-branch-id`) and on a re-issue scenario, but never across a real upgrade, and nothing has crossed an upgrade on the main network.
8. **Custom campaign name** in the set-up form. It is public and part of the signed rules. Shown top-right on the pages and in the dashboard list instead of "Campaign [private list: ids]…" (supersedes item 1 in wording).
9. **Status badge on the contributor page and the host dashboard:** blinking green while open, static red when closed. Keep the word OPEN or CLOSED. Respect reduced motion. Separate states for refunding, failed and succeeded (item 2 gives the same list).
10. **Contributor page heading follows the campaign type:** "Auction" or "Fundraiser" instead of "Contribute". Labels and explanations match the type.
11. **Boxed pre-payment warning** (glanceable, not a billboard, not tiny); item 4 gives the same list.
12. **Way back to the amount screen and a clear "start over"** (item 3 gives the same list).
13. **Later:** return the excess of an overpayment (ledger entry plus host online; below the minimum stays a donation and the page says so).
14. **Later:** optional team top-up so contributors get the full amount back (separate 0.0001 ZEC payment outside the ticket).
15. **Later:** short public hosting guide for running the host on an always-on small VPS: key and backup advice, and what happens if the server is offline while a campaign is open.
16. **Later, after the polish pass:** deploy the static demo folder to Vercel, rebuilding it first (`app/web/build.sh`, then `app/web/make-static.sh`, then `app/web/static-e2e.cjs`).

Stage A built (items 2, 3, 4, 9, 10, 11, 12 above, plus the "ticket has not arrived" notice). Test: `app/web/polish-a-e2e.cjs` (stand-in chain server, plain files). Not done: the browser back arrow still leaves the site (buttons only); the REFUNDING badge state is checked as text only. Items 1, 8 (campaign name) and the later items are stage B or later.

From the mainnet pilot (2026-10-08):
17. **Never demo from a free tunnel:** the first page load through one took about 2 minutes.
18. **A real campaign and the demo should publish to at least two relays.** The pilot used one, so its recount was marked limited.
19. **One watcher serves one campaign at a time** (one program per campaign folder). Say so in the set-up page and the hosting guide; consider a clearer message when a second campaign is started.
20. **The hosting guide needs dashboard protection:** a dashboard password or private-tunnel access. The dashboard must never be on a public address (it is local-only today).
21. **No host account system (privacy), but a better "your campaigns" list:** outcome, date, one-click export of the campaign folder.
22. **Later:** an optional "delivery details" field that only the host can read (for example, where to send a prize).
23. **The recount should explain "late" in plain words,** for example "ticket issued N blocks after the payment; the rule is within K".
24. **Restore:** (paths fixed in stage B: stored as names inside the folder, a path outside is refused.) Still open: an `ll-host restore-check` command, and rebuilding a stale `ledger/` from a relay (not written).
25. **Contributor tool:** `ll-contrib` needs the seed as a plain hex file, not the page's backup JSON, and `--raw` takes a file. Let it read the backup JSON directly (the backup already holds the seed, the ticket entry and the sealed ticket).

## Scale test plan: auctions with 200, then 1000 items (proposal; nothing run; the item limit stays 1000)

What limits an auction's size, from the code and the 40-contribution stress run (docs/FACTS_FOR_DOCS.md section 3):
- the host issues a refund ticket about every 4 s, so tickets for N bids take about 4N s, and every ticket must be in the ledger within K blocks of its payment (R4);
- the host settles each winner with its own transaction after the deadline (uniform price), all within the settlement window; the window is `max(40, K)` blocks (set from K at creation; the form and command line do not set it separately), maximum 1000;
- the browser recount fetches and checks every settlement (R9 to R12): its time for hundreds of winners is unknown and is the first thing to measure;
- test funds: every bid is at least 0.0002 TAZ plus a payment fee of about 0.0001 TAZ. Most of the money comes back (excess refunds, and the treasury is our own wallet), so the loss is mostly fees, but the peak the payer wallets must hold is about 0.0003 TAZ per bid.

| Step | What | Funds needed (testnet) | Time, typical / worst |
|---|---|---|---|
| S0 baseline | 20 items, 30 bids, K = 30. Gives seconds per ticket and per settlement on this machine, and the recount time for 20 winners | peak 0.01 TAZ, loss about 0.003 | 1 h / 2 h (testnet blocks are 19 to 27 s; two waits of about 30 blocks) |
| S1 | 200 items, 220 bids (so ranking and refunds of losers are exercised), K = 100, 10 payer wallets sending in parallel, at most about 5 payments per block | peak about 0.07 TAZ, loss about 0.03 (we hold about 0.067 now: enough only if nothing else is spent) | 3 h / 5 h: funding the payers 15 min; bidding 45 blocks (about 20 min); tickets overlap with bidding (about 15 min of backlog); deadline wait; settling 200 winners about 15 to 30 min; recount about 5 to 30 min (unknown) |
| S2 | 1000 items, 1100 bids, K = 300 (a 1000-ticket backlog is about 4000 s, which is about 170 blocks, so K must be well above it), 20 payer wallets | peak about 0.35 TAZ, loss about 0.15; **needs a faucet top-up** (about 0.3 TAZ per request, one request) | 8 h / 12 h; or cannot be bounded if the public testnet server throttles us or the recount runs out of memory |

Go / no-go after each step: R1 to R12 pass; the slowest ticket arrived within K; settlement finished inside the window; the browser recount finished and its time and memory are written down; the relay and the wallet database coped. If S1 fails on ticket delay or settlement time, stop and fix before S2 (likely changes: issue tickets in parallel, build settlements in batches). S2 is not worth starting before S1 is clean. Nothing here touches the mainnet, and the one real campaign running (the joke auction) is untouched.

Stage D built (internal): `./run.sh set-relay`; dashboard warnings about the stored relay address; page-load failure message; permanent-address support (`docs/STABLE_ADDRESS.md`, needs the owner's domain); recount from a saved copy and the host export; the host's signed "last seen" heartbeat and the contributor-page note. Still open from the design notes: close should issue missing tickets (or refuse to close) before refunding (`docs/DESIGN_NOTES.md` section 5); the host publishing to the local relay instead of the public address; a "what happens to my payment" explainer on the page for the unticketed case.
