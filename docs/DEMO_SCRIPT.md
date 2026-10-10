# Demo script: 3 to 4 minutes (draft)

Lead with the uniform-price auction (a public price, private participants), then the fundraiser and the refund ticket. Everything runs on the testnet; no real money. Nothing here is on the main network.

## Before recording (about 10 minutes, off camera)
1. Browser libraries and build as in the README ("Running it"); the pages need the built module (`app/web/build.sh`).
2. Start the three servers from the repository root:
   ```
   python3 app/web/serve.py 8770 &
   ./app/target/release/cb-relay serve --dir examples/relay --listen 127.0.0.1:8787 &
   mkdir -p runs && cp -r examples/relay runs/example-relay-b && ./app/target/release/cb-relay serve --dir runs/example-relay-b --listen 127.0.0.1:8788 &
   ```
3. Open these tabs in order (the recount needs the internet: it reads the public testnet chain servers; give each recount a minute to finish before you start, so you are not waiting on camera):
   - **A** capability card, auction: `http://127.0.0.1:8770/card.html#c=5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb&relay=http://127.0.0.1:8787&relay=http://127.0.0.1:8788`
   - **B** campaign page, auction: same address with `campaign.html`
   - **C** recount, auction: same address with `recount.html`
   - **D** campaign page, fundraiser with 40 contributions: `http://127.0.0.1:8770/campaign.html#c=47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da&relay=http://127.0.0.1:8787&relay=http://127.0.0.1:8788`
   - **E** recount of the same fundraiser (`recount.html`)
   - **F** the R9-fail fixture, recount: `http://127.0.0.1:8770/recount.html#c=32ea71afc470d77909a1b7b4a1fdaba36f0612df3a973df0ce1410c5ca16467a&relay=http://127.0.0.1:8787&relay=http://127.0.0.1:8788`
   - **G** the README, scrolled to the table "Public / Hidden".
4. For the refund-ticket part you need a contributor's page with a ticket, which only exists on the machine where a contribution was made (the backup file is a secret and is not in the repository). Make one a few minutes before: `app/web/demo.sh` starts a small campaign and prints its link; open it, create a payment (smallest amount), pay it from a funded testnet wallet (`app/web/pay-from-test-wallet.sh <address> <zat> <memo>`, or scan the QR code), and wait for "Contribution received". Leave that page open as tab **H**. If no funded testnet wallet is available, skip tab H and say the refund-ticket sentence over tab D instead (the ticket is the contributor's own signed refund, shown in the contributor's page; it was tested with real payments).

## The script
**0:00 to 0:20. The idea (tab G).** "People pay a shielded address, so who paid and where a refund goes stay off the public record. The host publishes a signed ledger, and anyone can recount it against the chain in their own browser. The table shows what is public and what is not." Point at the Public and Hidden columns.

**0:20 to 1:30. The uniform-price auction (tabs A, B, C).**
- Tab A: "Two items, a reserve price, and one price for every winner." Point at the terms and at "R1 to R12".
- Tab B: "Three bids. Before the close the ledger shows no amounts. After it, the clearing price is public: 0.0019 for both winners." Point at the two Settled rows at 0.00190000, and at the three Contribution rows with hidden amounts.
- Tab C: "Twelve checks pass, including that each winner paid exactly that price and nothing was diverted." Point at the PASS rows R9 to R12 and at the report hash: "Anyone who recounts at the same height gets the same hash."
- One line on privacy: "After the close the key is revealed, so all three bid amounts become public, including the loser's. Nobody's address is. We tested that: `app/privacy-test.sh` scans everything public and fails if a contributor address or secret appears." (If you show it, show the 18 PASS lines, not the whole log.)

**1:30 to 2:35. The fundraiser and the refund ticket (tabs D, E, H).**
- Tab D: "A fundraiser: forty contributions, each amount public, each with a signed refund ticket."
- Tab E: "Eight checks pass. It checked against two servers, and it says plainly that they run on the same hosting, so that is not independent proof."
- Tab H: "This is the contributor's own page. The ticket is a refund signed in advance that never expires. The page checks it itself: the signatures, that it pays this contributor's address, that the coin is unspent." Show the check rows. "If the host disappears, the contributor sends the ticket and gets the money back. Before the deadline they can take it back any time." Press "Refund me" only if you want to show the confirmation; it asks first and explains that a small fee is kept.

**2:35 to 3:20. What is NOT checked (tab E, the "Not checked" lines).** Say exactly this: "A recount does not check the amount each contributor promised, because that needs their one-time secret; it does not check the proof inside each ticket unless the contributor presses the button; and the host's ledger fingerprint is not yet published anywhere public, so a host could still show different ledgers to different people. The page says all of that on screen."

**3:20 to 3:45. It can fail (tab F).** "Here is a campaign where the host settled the winners after the deadline. The recount says so: R9 fails, in red, with the evidence." Then the close: "Check the books yourself; the code and the tests are in the repository."

## Things not to claim in the video
- That everything in the current version has run on the main network (a pilot on 2026-10-08 covered one phone-wallet contribution taken back with its ticket, on one relay; the host-close refund ran on the main network only with an earlier version: docs/EVIDENCE.md section 8), or that every phone wallet can pay a campaign (phone wallets did, twice).
- That the recount "verifies" the campaign: it checks the listed rules and says what it does not.
- Any amount of money raised: these are testnet coins.

## Check before you record
`app/privacy-test.sh` passes; each recount tab shows its verdict (A to C: "All checks pass"; F: "Some checks FAIL" with R9 failing).
