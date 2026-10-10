# Website blueprint

A factual description of every page of the site as it is built now. Each statement names the file it was checked against (paths are under `app/web/www/` unless another folder is named). Where the code and a page's own text disagree, that is said in "Mismatches found while checking" at the end. No design opinions are given.

Contents: 0. How the site is put together · 1. The two network looks · 2. Pages (home, host, recount, campaign, contribute, card, badge) · 3. Rules a designer must not break · 4. The product's story · 5. Limits that must be honest on the page · 6. Mismatches found while checking.

---

## 0. How the site is put together

**Hosts and what they serve**

| Address | What it is | Source |
|---|---|---|
| `app.clewbook.xyz` | The product: the pages below, served from `app/web/www` by `app/web/serve.py`, through a tunnel from the host's own computer. | `serve.py`, `run.sh` (`pageserver`, `tunnel-stable`) |
| `relay.clewbook.xyz` | The relay for the real-money campaigns: data only, no pages. | `run.sh` (`relay-mainnet`), `app/relay/src/lib.rs` |
| `clewbook.xyz` (Vercel) | The bare address redirects to `https://app.clewbook.xyz/`. Under `/demo` and `/demo/proofs` it serves a static copy of the pages with five finished test-network campaigns as plain files. Every older path still answers (same path, or redirect to `/demo/...`). | `app/web/vercel.json`, `app/web/make-vercel.sh`, `app/web/make-static.sh`, `app/web/vercel-old-paths.txt` |

- The page server serves an allow list of files only (`serve.py`: `PAGES`, `FILES`, `PATTERNS`). The dashboard and set-up pages are not on the list: hosting is done from the host's own computer.
- Every page sends: `nosniff`, `Referrer-Policy: no-referrer`, a content security policy (own files only; chain servers and relays may be asked; no inline script), no cookie. Only `badge.html` may be framed by other sites (`frame-ancestors *`); every other page is `'self'` (`serve.py` `csp()`).
- Pages are plain HTML, one script per page, and one WebAssembly module (`pkg/ll_web*`) that does all key, memo, ticket and check work in the visitor's browser. A second module (`proof/ll_proofcheck*`) is downloaded only when a contributor asks for the proof check (`contribute.js`, `proof-worker.js`).
- Pages are static: the campaign is named in the address after `#`, as `page.html#c=<64-hex id>&relay=<url>&relay=<url>[&endpoint=<url>][&server=<url>]` (`public.js` `linkParams`, `sibling`; `contribute.js` top).

**Data sources (the only ones any page uses)**

| Source | What | Used by |
|---|---|---|
| Relay `GET /v1/campaigns/{id}` | the campaign's signed rules; the page hashes them and refuses them unless they equal `{id}` | all campaign pages (`public.js` `readRelay`, `W.campaign_summary`) |
| Relay `GET .../ledger?from=0` | the signed, hash-chained list of entries; checked for signatures, order, gaps (`W.check_ledger`) | same |
| Relay `GET .../challenges`, `.../final`, `.../heartbeat`, `.../tickets/{nullifier}` | published proofs; the host's signed final fingerprint; the host's signed "last seen"; a contributor's sealed ticket | recount, contribute (`recount-page.js`, `copies.js` `fetchFinal`, `contribute.js` `readHostSeen`, `fetchBlob`) |
| Relay `PUT .../challenges` | a contributor's published proof (only on a button press) | contribute |
| Public chain servers (gRPC-web: `GetLatestBlock`, `GetBlockRange`, `GetTransaction`, `SendTransaction`, `GetLightdInfo`) | chain height, blocks for the recount, finding the contributor's own payment, sending a refund | all (`recount.js` `grpcWeb`, `public.js` `DEFAULT_ENDPOINTS`) |
| `campaigns.json` (same folder as the home page) | the list of campaigns the home page shows: `{"campaigns":[{"id","relays":[...]}]}`. Kept by hand. The committed copy is an empty example; the real one is not committed. | `home.js`, `app/web/make-next.sh`, `.gitignore` |
| Browser storage (`localStorage`) | `ll:<id>` the contributor's secret and progress; `ll:<id>:rules`; `ll:<id>:earlier` codes left; `cb:seen:<id>` the last list seen | `contribute.js`, `copies.js` |

Default chain servers by network (`public.js`): test: `zjs.zec.rocks/testnet`, `zcash-testnet.chainsafe.dev`. Main: `zjs.zec.rocks/mainnet`, two forwarded through the page server (`/grpc/zec.0xrpc.io`, `/grpc/z.ombie.cash`, `serve.py` `GRPC_HOSTS`), `zcash-mainnet.chainsafe.dev`.

**Every page:** `loadguard.js` watches the page. If the page's files do not load, or it is still not ready after 20 s, a notice appears with a Reload button:
- not loaded: "This page could not load all of its files. Your connection, or the address this page is served from, may be down for the moment. Nothing was sent or changed."
- slow: "This is taking longer than usual. The servers this page asks have not answered yet. The page keeps trying; nothing was sent or changed."

The notice goes away if the page becomes ready later (`loadguard.js`).

**Words a campaign's rules fix** (`core/src/rules.rs`): type (`raise` or `auction`), goal or number of items, deadline block, smallest contribution (never below twice the refund fee), refund fee, ticket window `ticket_k` (10 to 1000 blocks, default 30), optional name (1 to 60 characters, plain text), for a uniform-price auction a reserve, treasury address and settlement window.

---

## 1. The two network looks

What must differ is set in `ui.js` (`setNetwork`, `NETBAR`) and `ui.css` (`.netbar`, `html[data-net]`). The network comes only from the campaign's checked rules (`campaign.network`), never from the address, a link parameter or a default.

| | Checking (before the rules are read) | Test network | Main network (real money) | Unknown |
|---|---|---|---|---|
| Bar text | "Checking network…" (no amounts) | **TEST MONEY ONLY** · Test network: TAZ has no value. | **ZCASH MAINNET** · Real ZEC. | **NETWORK UNKNOWN** · This page cannot tell which network this is. |
| Bar look | light grey `#E6E6E8`, text `#44444A` | amber `#F4E9CF`, text `#4A3205`, 3 px **dashed** `#76500A` underline | dark `#2B2B2F`, text `#F3F0E8`, 3 px **solid** `#808084` underline | light grey, text `#1C1B18`, 3 px **dotted** `#44444A` underline |
| Header rule | normal | dashed | 3 px solid | n/a |
| Ticker beside amounts | none | **TAZ** | **ZEC** | none |
| `<html data-net>` | not set | `test` | `main` | `unknown` |

- Pages that show the bar: campaign, contribute, recount, card (`setNetwork` is called in `campaign.js`, `contribute.js` `applyNetwork`, `recount-page.js`, `card.js`). The bar is inserted by `setup()` at the top of the page, above the header.
- Pages without the bar: home (each card carries a network chip instead), host (no network), badge (it is embedded in other sites; `badge.js` `setup(..., {netbar:false})`).
- Home-page chips (`home.js` `chip`, `start.css` `.netchip`): "ZCASH MAINNET" (dark), "TEST MONEY ONLY" (amber, dashed border), "NETWORK UNKNOWN" (grey, dotted).
- Test wording belongs to the test side only: the home page and the pages shown for a real-money campaign contain none of "demo", "play money" or "start page" (checked by `app/web/site-next-e2e.cjs`). The one plain link from the home page to the test side is "Try it with test money" → `https://clewbook.xyz/demo` (`index.html`).
- Words that already mark the network in page text: the capability card's "Network" row reads "Test network (no real money)" or "Main network (real money)" (`capabilities.js` `NET`); the contribute page's About list adds "Network: Test network: no real money" for any network other than main (`contribute.js`, near line 421).
- The test-side static pages (`/demo`, `/demo/proofs`) carry a fixed amber "TEST MONEY ONLY" bar in their HTML (`make-static.sh`).

---

## 2. Pages

### 2.1 Home — `index.html`, `home.js`, `start.css` (address: `/`)

**Purpose.** Say what the product is, list its campaigns, and lead to the recount, the host guide and the test side.
**Who sees it.** Anyone; it is the front page of `app.clewbook.xyz`.
**States**

| State | What happens | Source |
|---|---|---|
| Loading | "Looking for campaigns…" in the Live list | `index.html`, `home.js` |
| No list / empty list | "No campaigns are listed yet." | `home.js` |
| Module cannot start | "This page could not start. Please reload it." | `home.js` |
| Cards drawn | One card per listed campaign, drawn as soon as its relay answers (not after the chain server). Main-network cards first. Status first reads "Open." and is filled in when a chain server answers. | `home.js` |
| Open, time known | "Open: about N hours left." (also "less than a minute", "about N minutes", "about N days") | `home.js`, `ui.js` `etaText` |
| Deadline passed, not closed | "The deadline has passed; the host is wrapping up." The Bid/Contribute button is removed. | `home.js` |
| Closed | "Closed: goal met." / "Closed: goal missed." / "Closed: auction settled." / "Closed: finished." Listed under "Closed campaigns" (hidden when none). | `home.js` |
| Relay unreadable | Card titled "Campaign xxxxxxxx…" with "Can't be read right now." and only Open and Recount buttons | `home.js` |
| No open campaign | "No campaign is open right now." | `home.js` |
| Unexpected error | "Something went wrong while loading this page. Please reload it." | `home.js` |

**Text shown (fixed).**
- Heading: "Fundraisers and auctions on Zcash, with books anyone can check".
- Lead (3 sentences): "Contributors pay a shielded address, so who paid and where a refund goes stay private, and each one holds a refund ticket signed in advance. The host publishes a signed list of everything that came in. Any visitor can recount that list against the public chain in their own browser, without trusting the host or this site."
- Sections: "Live campaigns"; "Closed campaigns"; "Check any campaign" — "Have a saved copy of a campaign's list? Open the recount page, load the file, and see for yourself whether the books match the chain."; "Host your campaign" — "Run an auction or a fundraiser of your own. You run the host program on your own computer; this page explains what you need."; "Try it with test money" — "The Zcash test network's coins have no value, so you can try a campaign without risking anything."

**Card text (built).** Title: the campaign's name, else "Fundraiser xxxxxxxx…" / "Auction xxxxxxxx…" (first 8 hex characters). Network chip. "Auction, N item(s)" or "Fundraiser, goal X TICKER". Status line.

**Buttons and destinations**

| Button | Goes to |
|---|---|
| Nav: Home / Recount / Host | `./`, `recount.html`, `host.html` |
| Card: Open | `campaign.html#c=<id>&relay=…` |
| Card: Bid (auction) / Contribute (fundraiser) — only while open | `contribute.html#c=<id>&relay=…` |
| Card: Recount this campaign | `recount.html#c=<id>&relay=…` |
| Open the recount page | `recount.html` (upload mode, 2.3) |
| How to host | `host.html` |
| Try it with test money | `https://clewbook.xyz/demo` |

**Built from.** `campaigns.json` (which campaigns and where to look); each campaign's rules and list from its relay, checked as in section 0; the chain height from the first default chain server that answers for that network; block time measured over the last 100 blocks (`public.js` `observedBlockSeconds`). Nothing about a campaign is taken from `campaigns.json` itself.
**Does not exist on this page:** a link to the host's dashboard (checked by `site-next-e2e.cjs`).

### 2.2 Host guide — `host.html`, `host.js` (address: `/host.html`)

**Purpose.** Tell a would-be host what hosting involves. **Who sees it.** Anyone. **States.** One: plain text; no data is read.
**Text shown.**
- Heading: "Host a campaign". Lead: "You can run a fundraiser or an auction of your own. Hosting is done from your own computer, with a program you run there. This site does not host campaigns, hold keys or touch anyone's money, and it has no button that sets one up for you."
- "Which kind": Fundraiser — "People contribute toward a goal. If the goal is reached by the deadline, you keep the money. If not, everyone is refunded." Auction — "People bid for a number of items. Bids stay sealed until you close. The highest bids win and are paid to your address; everyone else is refunded. A uniform-price auction, where every winner pays the same price and gets the rest of their bid back, is set up from the command line instead of the dashboard."
- "What you need": a computer that stays on and online until the campaign is closed ("Tickets are issued only while the host program runs."); the host program (`cb-host`) and relay program (`cb-relay`), built from the source code, steps in the README; a relay contributors and visitors can reach; a shielded address to receive what the campaign keeps.
- "The steps, from your own computer" (5 numbered steps): start the dashboard on your own computer ("for you only and cannot be reached from other devices"); set up the campaign there; share the contribute link; close after the deadline from the dashboard (refunds, sweeps or settles; saves a final copy of the list with a signed fingerprint); share the recount link.
- "What to know first": try it on the test network first (real-money campaigns ask for an extra confirmation); back up the campaign folder (wallet and key; "contributors can still use their own tickets"); late payments are not counted (stay in the campaign wallet until returned by hand); close in time (otherwise contributors may claim their own refunds); the recount is public.

**Buttons.** Nav Home / Recount / Host; "Back to the home page" → `./`. No link to any local address.
**Built from.** Fixed text. Verified against: `host/src/dashboard.rs` (dashboard listens only on `127.0.0.1`; `create_campaign` makes raise or non-uniform auctions only), `host/src/mainnet.rs` (confirmation), `host/src/main.rs` `close`, `finalize`, `late`.

### 2.3 Recount — `recount.html`, `recount-page.js`, `public.js`, `recount.js`, `copies.js` (address: `/recount.html`, with or without a campaign)

**Purpose.** Re-check a campaign's books in the visitor's browser against the public chain; show every rule as pass or fail with evidence. It never passes quietly when sources disagree.
**Who sees it.** Anyone: contributors, journalists, other hosts; anyone holding a saved copy.

**Two ways in**
- **With a campaign** (`#c=<id>&relay=…`): reads the list from the relays.
- **Upload mode** (no `#`): `uploadMode()` hides the verdict, shows "Check a saved copy": "Load a saved copy of a campaign's public list (a file ending in .json: the host's export, or the copy this site's pages let you save). It is checked here, in your browser, against the public chain. Nothing is uploaded anywhere." A file input accepts `.json`. The campaign number, rules and network are taken from the file (kind `ledger-export`); no relay is asked. Refusals, in one sentence each: "That file is too large to be a saved copy."; "That is not a saved copy: the file is not readable JSON."; "That is not a saved copy of a campaign list (it should be a "ledger-export" file)." After a good file the page runs as below, with the "Ask the relays again instead" button hidden.
- A link with a missing or malformed id/relays (but some `#`) shows the verdict "Incomplete link" — "This link is incomplete. Please ask whoever sent it for the full recount link."

**States of the verdict block** (`verdict(kind,…)`; kicker word and look follow `kind`): working · pass · fail · partial ("Limited check") · cannot ("Cannot conclude").

| State | Title / text (from `recount-page.js`) |
|---|---|
| Working | "Working…" "Reading the public list." then "Scanning the chain from up to three public servers. This can take a minute." |
| Neutral network | netbar "Checking network…" until the rules are read; then test or main look |
| No relay gave an intact list | "Cannot conclude" — "No relay could give an intact, signed list. A relay that drops or damages entries could make anyone look guilty, so no verdict is given. Ask the host for its own copy or try other relays." plus a list of what each relay said |
| Relays disagree | "RELAYS DISAGREE, CANNOT CONCLUDE" — "The relays do not show the same list. This says nothing about the host: a relay can be behind, down or dishonest. …" |
| Servers disagree | "SERVERS DISAGREE, CANNOT CONCLUDE" — "Of N public servers, some showed different data for the same blocks. That says nothing about the campaign. Try again later or add another server below." |
| No chain server answered | "Cannot conclude" — "None of the public servers could give the blocks. Nothing was concluded; try again in a minute." |
| Unclosed auction | "Not yet possible" — "This is an auction that has not closed. Its viewing key stays sealed until the close, so the chain checks cannot run yet. The signed list itself is intact. Come back after it closes." (R1 and R2 only) |
| All pass, cross-checked | "Every check passes at block N. Checked against N servers: they all showed the same chain data, and the relays showed the same list." |
| All pass, limited | "All checks pass (limited check)" — "Every check passes, but not everything could be cross-checked; see the notes below." (one server, or one relay) |
| All pass, from a saved copy | "All checks pass for the saved copy (limited check)" — "Every check passes for the saved copy you loaded, as checked against the chain. This result comes from a file, not from a relay: it shows the file is internally sound and matches the chain, not that it is the list the host showed to others." |
| Fail | "At least one check fails, and the servers and relays agree on what they showed. The evidence is under each failing check." Limited and saved-copy variants say the failure may come from a missing source or from the file |
| Saved copy unusable | "Cannot conclude from the saved copy" with the reason |
| Past deadline, not closed | a note under the result: "This campaign is past its deadline and has not been closed. …" with the block after which contributors may claim their own refunds |
| Open (deadline not passed) | totals shown as of the current chain height; "(the deadline has not passed)" |
| Error | "The recount could not finish: … Nothing was concluded." / "Something went wrong: …" |

**What the page shows once it has a result**
- **Strip:** Passed / Failed / Not checked counts; "Checked", "Not checked", "Coverage" notes (agreement between servers and relays; hosting judged from the outside).
- **The checks:** R1–R8 always, R9–R12 for a uniform-price auction (`ui.js` `CHECKS`):

  R1 Rules · R2 List integrity · R3 Entries are real · R4 Tickets issued · R5 No early spend · R6 Refunds only by ticket · R7 Outcome · R8 Rejects are justified · R9 Settlements · R10 Treasury total · R11 Nothing diverted · R12 Delivery proofs. Each row opens to its description and evidence.
- **Totals:** raised, contributions, taken back early, refunded, kept, still pending, donations; for a uniform auction also clearing price, settlement deadline, received by the treasury, sent back as excess, winners who proved delivery (`recount-page.js` `showTotals`). Deadline block; "Closed at block N (M blocks after the deadline), outcome: …" when closed.
- **Limits note:** "What this check cannot see: without a contributor revealing their one-time secret, it can see that payments repeated an earlier payment's message and that a payment was set aside, but not what amount a message promised, …"
- **What was read:** which relays and servers, blocks read, chain height, time, **report hash** (SHA-256 of the report as canonical JSON).
- **Check against another server:** a web address field ("Add a public lightwalletd server address (it must allow requests from web pages)…"), button "Add and run again".
- **Fingerprint of this list** (after a close): "How many entries the list has, and the hash of its last entry:" and one of: "This list is exactly the one the host fixed when it closed the campaign (N entries, signed by the campaign's key)." · "No fingerprint was published for this list, so nothing could be compared. …" · "A fingerprint record came with this list but it is not signed by the campaign's key, so it was ignored." · "This list has N entries but the host fixed M when it closed the campaign: the end of the list is missing." · "This list is NOT the one the host fixed: its entry number N is not the entry the host…" · "This list has entries after the host's…" (settlement entries after the close are allowed). Failing cases set the title "The list does not match the host's final fingerprint". A field "Compare with a fingerprint you were given". Explainer: what the fingerprint can and cannot show.
- **Keep a copy of the list** (relay lists only): "The list is public, but a server can stop showing part of it. A copy you keep is the one thing nobody else can change." Button "Save a copy of the full list"; "Compare with my saved copy" (file) with plain-language results ("They are identical.", missing / changed / extra entries by number); explainer "What a saved copy can and cannot show".
- **Memory line** (`copies.js` `memoryWords`): first visit "This browser will remember this list (N entries) to compare next time."; same "The same list as on your last visit (…)."; grew "N new entries since your last visit (…); nothing you saw before changed."; cut off "This list is shorter than on …: N entries then, M now; compare a saved copy."; changed "Entry N differs from what you saw on …; compare a saved copy."; blocked storage "This browser cannot remember this list, so save a copy to compare later."
- **Recount from a saved copy** card: explains loading the host's export when no relay answers.

**Buttons.** Nav: Campaign (hidden in upload mode) / Recount; Run it again; Add and run again; Save a copy of the full list; Compare with my saved copy; Remember this list instead (after a shorter or changed list); Ask the relays again instead (saved-copy results only); file inputs for the saved copy and the comparison.
**Built from.** Rules and list from the relays (or the file); chain blocks from up to three servers (`recount.js` `crossCheck`, WebAssembly `Recount`); final fingerprint from the relay `/final` or the file's `final`; browser storage `cb:seen:<id>`.

### 2.4 Campaign — `campaign.html`, `campaign.js` (address: `/campaign.html#c=…`)

**Purpose.** The campaign's public face: what it is, its status, its public list, links to take part or check. **Who sees it.** Anyone given the link, and the home page's "Open".
**States**

| State | Shown | Source |
|---|---|---|
| Loading / neutral | netbar "Checking network…"; title "Campaign" | `campaign.html`, `ui.js` |
| Incomplete link | "This link is incomplete. Please ask whoever sent it for the full campaign link." | `campaign.js` |
| No relay answered | "No relay could give the campaign details, so there is nothing to show yet. Try again in a minute." | `campaign.js` |
| Relays disagree | "RELAYS DISAGREE, CANNOT CONCLUDE. What is shown below comes from the relay with the longest list. Run the recount for a fuller check." | `campaign.js` |
| One relay only | "Only one relay was asked, so nothing here has been cross-checked." | `campaign.js` |
| Test / main | the network bar; amounts with TAZ / ZEC | `campaign.js` `setNetwork`, `c.ticker` |
| Open | chip "Open"; Status "Open for contributions"; Deadline "block N (about X left)" or "N blocks left; the length of a block could not be measured"; Block time "about N seconds, measured over the last 100 blocks" | `campaign.js` |
| Chain height unreadable | chip "Unknown"; Status "Open (the chain height could not be read)" | `campaign.js` |
| Deadline passed | chip "Wrapping up"; Status "Deadline passed, not yet closed"; the Contribute button is greyed | `campaign.js` |
| Closed | chip "Closed"; Status "Closed"; Contribute greyed. Goal met / missed is not stated on this page; the entry "Closed" is in the list | `campaign.js` |
| Error | "Something went wrong: …" | `campaign.js` |

**Text shown.**
- Title "Fundraiser" or "Auction", then the status chip and "Goal X TICKER" or "N item(s) for sale".
- **About this campaign** list: Type; Goal or Items for sale; Smallest contribution; Status; Deadline; Block time; for a uniform auction Pricing ("Every winner pays the same price: the lowest winning bid, at least R TICKER") and Settlement ("the host must settle every winner by block N (M blocks after the deadline); after that winners can claim their own refund"); Ticket window ("N blocks (about …): each contribution gets its refund ticket within this window, and if the host has not closed this long after the deadline, contributors may claim their own refunds"); Refund promise ("Every contribution comes with a signed refund ticket that never expires.").
- **Take part or check:** "The recount checks, in your browser and from the public chain, that the campaign kept its promises."
- **The public list:** "Every contribution the campaign has accepted is listed publicly, signed by the campaign." Entries in the public list; Refund tickets issued; Tickets re-issued; Payments set aside; "Where it was read from" (each relay and its entry count; a relay with no usable answer is marked).
- **Latest entries** (newest 10): number, kind (Contribution, Ticket re-issued, Set aside, Closed, Settled, …), block, amount (in an auction "hidden or none"), a short reference with expand and copy.
- **Badge for your own site:** "Paste this into a web page. It shows a small card that names this campaign and sends readers to its live recount. It does not claim any result by itself." Code box, Copy, and a live preview ("Recount badge preview").

**Buttons.** Nav Campaign / Recount; Contribute → `contribute.html#c=…` (relays only, no endpoints); **Recount this campaign** → `recount.html#c=…` with the campaign's relays, endpoints and server — present for every campaign, open or closed, fundraiser or auction; Capability card → `card.html#c=…`; Copy (badge code).
**Built from.** Rules and list from the relays (checked); chain height from the first server that answers; block time measured; entry kinds counted from the list.

### 2.5 Contribute — `contribute.html`, `contribute.js`, `copies.js`, `proof-worker.js` (address: `/contribute.html#c=…`)

**Purpose.** Let a person pay a campaign and hold the means to get their money back. Everything involving keys, the memo and tickets runs in the browser. **Who sees it.** Contributors and bidders (and anyone with the link).

**Network and refusal rules** (`contribute.js` `applyNetwork`)
- The chain server is never guessed. With no `server=` in the link it comes from the campaign's own network (test: `zjs.zec.rocks/testnet`; main: `zjs.zec.rocks/mainnet`).
- The page **refuses to continue** (no form, no payment code, no progress card, no auction card; no chain server is asked) when: the rules name a network other than `test` or `main` — "This page cannot tell which network this campaign is on, so it will not take a payment."; or the link's server belongs to the other network — "The server in this link is for the other network, so this page will not take a payment; ask for a new link."
- Incomplete link: "This link is incomplete. Please ask whoever sent it for the full campaign link."

**Steps and states**

*Before paying* (amount step; `#form-card`)
- Heading "Your contribution" (auction: "Your bid"). Line: "Your refund address and amount stay in this browser. We never ask for your name." (auction adds "and bids stay private until the auction closes").
- Fields: Amount (TICKER); "Where should a refund go?" ("Paste the full shielded address from your wallet"; hint "You only enter this once. It is sealed so that only the campaign can read it, and it is never shown publicly."). Auction with a uniform price: "For this auction, give a refund address from an account you would be happy to show later."
- Refusals in one sentence: "Please enter an amount like 0.01"; "The smallest amount this campaign accepts is X TICKER."; "That doesn't look like a valid refund address. …"; etc. (`web/src/contribute.rs` `build_payment`).
- Button "Create my payment". Also "I have a backup file" (restore a contribution on this or another device).
- **Near the deadline.** In the last 10 blocks before the deadline (`CUTOFF_BLOCKS`), Create is off and one line says "New payments stop 10 blocks before the deadline, because one mined after it would not count."
- **Deadline passed, no code made:** the form is replaced by "Already contributed?" / "Already bid?" with "You can restore your backup file here to see your result or claim a refund." and the line "This campaign is no longer taking contributions."

*Payment step* (`#pay-card`, "Pay from your wallet")
- Top: **← Edit amount** (hidden once a payment for this code is seen; then "A payment for this code was seen, so its amount can no longer change.").
- Step 1 "Save your backup file first. It lets you get your refund even if you lose this page." Button "Download backup file" (then a "Saved" mark).
- Step 2 the single always-visible line: "Pay exactly {amount} {TICKER} once, from your own wallet's shielded balance, not an exchange or transparent funds." and a closed "Why?": "A smaller or second payment is not refunded, and exchange or transparent funds can show who paid."
- Step 3 "Scan this code with your wallet app. It fills in the amount and a message for you." QR; "Code hard to scan? Show a simpler code"; "This code contains": Address, Amount, Message; "Paying X. You can get back Y if you change your mind (a small fee is kept)."
- Step 4 "If your wallet can't scan it, copy the address and the message below; both are needed." Payment details (address, message) with Copy buttons; "Open in my wallet app (works with some wallets only; scanning the code is the most reliable way)."
- Bottom: "Wrong amount, or want to begin again?" **Back to the amount**, **Start over** (each asks first: "If you already paid with this code, stay; if not, leaving loses nothing and the code is kept." / "This payment was seen, so paying again with a new code makes a second contribution; download your backup first."). The phone's back gesture does the same as Back to the amount; it is refused while a payment is seen, and with blocked storage until a backup is downloaded.
- A code that was left is kept in "Earlier payment codes in this browser (each still counts if you paid it)" with "Follow it again" and "I never paid with it: remove".

*Cautions that appear only when they apply* (one plain sentence each, grey, no box; `warnline`)
- Blocked storage: "This browser cannot save your secret, so download your backup file now."
- Changed amount: "Do not pay the previous code; if you already did, it still counts and is listed below." (with blocked storage: "…keep the backup file just saved.")
- Last 10 blocks, code made but unpaid: "The deadline is block N; a payment mined after it is not counted or refunded."
- **Late payer** (deadline passed, code made, nothing seen): "The deadline has passed, so a payment now is not counted or refunded automatically."
- Host not seen lately: "The host was last seen X ago, so your refund ticket may come late." (fresh: a hint "Host last seen X ago (block N)."; none published: "This campaign does not show when its host was last seen.")
- Servers: "{host} can't be reached right now."; "{host} shows a list that doesn't add up, so it is being ignored."; "The list servers don't show the same list right now; we can't tell why, and your saved ticket still works."; "We can't reach the campaign's servers right now; your refund ticket is saved here and still works." (no ticket: "…please try again in a moment."); "We can't reach the network right now, so some details may be out of date."
- Memory: only a shorter or changed list is shown on this page (wording as in 2.3).

*After paying* ("Where things stand": Your payment · Contribution received · Refund ticket)
- Waiting: "After you pay, this usually takes a minute or two. You can leave this page open, or come back later with the same link; your progress is saved in this browser."
- Ticket received and passed: "Your refund ticket is saved on this device and passed the checks listed below. If anything goes wrong with the campaign, it lets you get your money back without needing anyone." Checks listed by name (`ui.js` `CHECKS`): Readable, Matches the signed list, Shape, Signatures, Network version, No expiry, Fee, Spends your coin, Your amount, Coin unspent, Coin used by the list, Pays you; Proof and Chain state "not checked" until asked / not built. Button "Check the proof too" (with Cancel). A failed proof reads "its proof does not verify".
- Ticket failed a check: "Your ticket did not pass a check: … Don't rely on it yet. Keep your backup file." (older network version adds "the campaign must re-issue it").
- Payment smaller than sealed amount: "Your payment of X is smaller than the Y sealed into your payment code, so it will NOT count as a contribution and will not be refunded (it becomes a donation). Do not pay again with the same code; …"
- Paid more: "You paid more than the amount you chose. The whole payment counts as your contribution, and your refund is the payment minus the fee."
- Old-format code: "This older payment code could have been copied by someone who saw it before your payment was mined."
- Not seen after 10 minutes: "Not seen yet: if your wallet shows the payment failed, nothing was spent; if sent, this page keeps looking."
- Ticket late: "Your refund ticket has not arrived. Do not rely on this payment until it does." plus the block it was mined in and the window.
- Set aside by the campaign: "The campaign did not accept the message that came with your payment." and a button "Publish proof that my payment was valid", with: "Publishing shows everyone your refund address for this one payment, and it can't be undone." Nothing is published without the press.

*Refund* (`refundMode`)
- Before the deadline: "Changed your mind? You can take your contribution back any time before the deadline." Button "Refund me" → "This takes your contribution back out of the campaign. It cannot be undone, and a small fee is kept." Yes, send my refund / Not now.
- Deadline plus ticket window passed, campaign not closed: "The deadline has passed and the campaign hasn't wrapped up. You can now claim your refund yourself." Button "Claim my refund".
- Closed, but no refund within the ticket window after the close (fundraiser that missed its goal, or a bid that did not win): "The campaign closed but your refund has not appeared, so you can send it yourself." Button "Claim my refund". Before then: "The campaign has closed; if your refund does not appear, a button to send it yourself shows here."
- Sent: "Your refund was sent to the network and is waiting to be mined. If it takes long, this page sends the same refund again by itself. Nothing is lost." Confirmed: "Your refund is confirmed in block N. It should reach the address you gave." Resent: "…we sent the very same refund again (send N). You don't need to do anything, and you never need to pay again."
- Closed and nothing owed: "The campaign has closed." Deadline passed, waiting: "The deadline has passed. If the campaign doesn't wrap up, a refund button will appear here after block N."

*Auction result* (`#auction-card`): lost — "Auction result: you did not win … Your contribution is refunded with your ticket (the campaign sends it; if it does not, the refund button appears here)."; won, not settled — "You won. The price every winner pays is X. The campaign has not published your settlement yet; it has until block N. After that you can claim your refund yourself."; won and settled — "You won and paid X (the same price every winner pays). …" plus the excess paid back; an optional section "prove your excess arrived" ("Use a dedicated account" warning: "Publishing this key shows everything that account ever received, so publish only a dedicated account's key.") with buttons "Publish the key so my excess can be checked" and "Report that my excess did not arrive (no key)".

*Always on the page:* "About this campaign" (campaign facts as on 2.4, plus "Network: Test network: no real money" on test); **Recount this campaign** button (top, visible once the link is valid; from the page's own id and relays, no pasting); "Save a copy of the full list" with "The list is public, but a server can stop showing part of it. A copy you keep can be loaded on the recount page to compare it later."; "Know your payment's transaction ID?" (optional); a second "Download backup file"; footer "Your secret stays in this browser. Nothing here is sent anywhere except the payment details you choose to pay with."

**Built from.** Campaign rules and list from the relays (checked); the secret and progress from the browser; the payment found by scanning the chain with the campaign's public viewing key (fundraisers); the ticket fetched from a relay (all tickets are fetched, in random order, so the relay cannot tell which is the visitor's: `detectTicket`); host "last seen" from the relay (signature checked); chain height and refund broadcast from the chain server; payment text from `web/src/contribute.rs` `build_payment`.

### 2.6 Capability card — `card.html`, `card.js`, `capabilities.js` (address: `/card.html#c=…`)

**Purpose.** State what this campaign promises, what a recount checks and what it does not. **Who sees it.** Anyone; linked from the campaign page. **States:** loading/neutral bar; incomplete link ("This link is incomplete. Please ask whoever sent it for the full link."); no relay ("No relay could give the campaign details, so there is nothing to show yet. Try again in a minute."); test / main (bar + "Network" row); error ("Something went wrong: …").
**Text and parts.**
- Heading "Capability card"; lead "What this campaign promises, what a recount checks and what it does not. Every value below comes from the campaign's committed rules, which this page checked against the campaign id before drawing them."
- **Terms** (from `capabilities.js` `cardModel`): Type (Fundraiser / Auction / "Auction, one price for every winner"); Network ("Test network (no real money)" / "Main network (real money)"); Goal or Items for sale; Reserve price (uniform auction); Smallest contribution; Refund fee kept; Deadline (block); Ticket window; Re-issue window after a network upgrade; Settlement window (uniform auction); Rules fingerprint (the campaign id).
- **Not checked by a recount** (fixed): the amount each payment message promised; the proof inside each refund ticket; ticket anchors; ledger anchoring; and for an auction "Your amount (on the ticket check)".
- **What a recount checks:** R1–R8 (+ R9–R12 for a uniform auction) with their descriptions; for an auction "An auction's viewing key stays sealed until it closes, so before the close only R1 and R2 can run; the rest run after it."
- **Ticket checks, by level** (on the contributor's device): Level 1 automatic; Level 2 automatic on tickets issued in the current format; Level 3 only when "Check the proof too" is pressed; Level 4 not built yet.
**Buttons.** Nav Campaign / Capability card / Recount; **Recount this campaign** (top, same link as the campaign page); "Back to the campaign page · Run the recount".
**Built from.** The rules (checked against the id) plus measured block time; fixed descriptions of the checks.

### 2.7 Badge — `badge.html`, `badge.js` (address: `/badge.html#c=…`; meant to be framed)

**Purpose.** A small card a host pastes into their own page; it names the campaign and sends readers to the live recount. It claims nothing. **Who sees it.** Visitors of any site that embeds it (the only page other sites may frame).
**States.** Incomplete link: name "Campaign (incomplete link)". Rules read: name (the campaign's own name, else "Fundraiser xxxxxxxx…" / "Auction xxxxxxxx…", full id in the tooltip when named). Relay unreadable: "Campaign xxxxxxxx…". No network bar.
**Text.** "Powered by Clewbook", "Recount badge", the campaign name, a button-like "Recount this campaign →", a chip "Not yet recounted", and "Nothing is checked here. Open the live recount".
**Buttons.** The whole badge → `recount.html#c=<id>&relay=…` next to the badge (same folder), opened in the top window.
**Built from.** The campaign's rules from the first relay that answers (checked by `W.campaign_summary`); nothing else.

---

## 3. Rules a designer must not break

**What must never be shown or sent** (checked by `app/privacy-test.sh` / `app/privacy-e2e.cjs`: 22 checks on three finished testnet campaigns, the example data and the upload folder)
- No contributor's refund address, paying address, secret (seed) or name on any public page, file, relay answer or served script. A refund address becomes public only for one payment, when its owner presses "Publish proof that my payment was valid", after the warning above.
- No bid amount in an auction before the close (only a commitment is on the list; `core/src/ledger.rs` `Contribution.value_zat` is omitted for auctions). After the close every bid amount, including losing bids, is public — by design (README, "What is public").
- No mainnet campaign number in any tracked file or in the hosted static build (`app/audit.sh`, `privacy-e2e.cjs`). The one file excused is the live app server's `campaigns.json`.
- No third-party requests: fonts are self-hosted; no analytics; the content security policy blocks anything else. (Cloudflare can inject its own script on the tunnel address; the policy blocks it.)
- No cookie. No key, wallet or private folder in anything served (`check-vercel.sh`).
- No link from a public page to the host's dashboard.
- The test-side wording ("demo", "play money", "start page") never on the real-money pages.

**How a payer is kept from mistakes** (all in `contribute.js` unless noted)
- The network and the chain server come only from the campaign's checked rules; a page that cannot tell the network, or has a server for the other one, refuses and shows no form or code.
- One caution line is always visible on the payment step; every other caution appears only when it applies and goes away when it does not. Each is one short sentence.
- The payment link, QR and message are built by one function from the rules, the secret, the refund address and the amount; the amount is sealed in the message, so a smaller payment is set aside rather than counted (`web/src/contribute.rs`, SPEC).
- Changing the amount makes a new code and never reuses the old one; the old one is kept and listed; "Do not pay the previous code" is shown; Back/Edit is refused once a payment is seen.
- New payment codes stop 10 blocks before the deadline; after it a payer is told a late payment is not counted or refunded automatically.
- A backup file comes first on the payment step; with blocked storage the page says so and requires a backup before going back.
- Refunds ask first; a refund is the same pre-signed transaction every time, so it can be resent but never doubled.
- The ticket is checked on the payer's device and shown as received only if checks pass; a failed check is never shown as "received and checked".
- Nothing is published or sent anywhere without a button press, except the payment's own refund broadcast and, on request, the proof.

**Presentation rules the code relies on**
- Status is always a word as well as a look (`ui.js` `statusBadgeHTML`: OPEN, DEADLINE PASSED, CHECKING, CLOSED, SUCCEEDED, FAILED, REFUNDING); network is a word as well as a look (section 1).
- Cautions are plain grey lines, not red boxes (`ui.css` `.warnline`); only conditions about money already at risk (underpaid, ticket late, ticket check failed) keep their boxed look (`contribute.html` `#paid-warning`, `#ticket-late`, `#tc-bad`).
- Amounts are drawn with eight decimals and a dimmed tail, with the ticker beside them (`ui.js` `amountHTML`, `decorateAmounts`).
- Names are shown only as plain text; the name must come from rules that hash to the campaign id (`setCampaignLabel`; `core/src/rules.rs` `check_name` forbids markup characters, control and direction-changing characters).
- No page shows a raw error: failures become one calm sentence (`home.js`, `loadguard.js`, each page's error line).

---

## 4. The product's story, in plain words

**What it does.** A host runs a fundraiser or an auction on Zcash. Contributors pay a shielded address. The host publishes a signed list of what came in. Any visitor can recount the list against the public chain in their own browser and see each rule pass or fail.

**How a contribution works** (README, SPEC, `core/src/payload.rs`, `web/src/contribute.rs`)
1. The page makes a random secret in the browser. A payment message is built from it, sealed to the campaign's key with a one-time key, and attached to a payment to the campaign's single address.
2. The host's program finds the payment, opens the message, and builds and signs in advance a refund that pays the contributor's own address and never expires. It seals that ticket for the contributor and writes a signed, numbered, hash-chained entry in its list.
3. The contributor's page finds its ticket, checks it, and keeps it. With it they can take their money back before the deadline, or after it if the host does not close in time.
4. After the deadline the host closes: a fundraiser that reaches its goal sweeps the money to the host's address, otherwise everyone is refunded; an auction pays the winners' bids to the host (or settles a single price) and refunds the rest. The host then saves a final copy of the list with a signed fingerprint.

**Why it does not leak** (checked in the code)
- Everyone pays the same address (`rules.pay_to`); contributors are told apart only by the sealed message, whose one-time public key and ciphertext differ for every payment (`core/src/keys.rs`, `payload.rs`). Nothing on the public list or in a memo links one contributor to another.
- The refund address, the contributor's keys and secret are only in the sealed message and in the contributor's browser.
- The signed list holds transaction id, output number, nullifier, block height, ticket data; in a fundraiser the amount; in an auction only a commitment until the close.
- What an observer can still use: block heights and, in a fundraiser, amounts; funding from transparent money (the paying address is then on the chain); money moved between shielded pools (the amount crossing is visible); the network address of anyone who contacts a relay or chain server (README, threat model 18, 19).
- The host can open every message, so it can see which payments share a refund address.

**What is real and what is a mock**
- **Real:** the whole system runs end to end on the Zcash test network that has activated NU7 (branch `77190ad9`): payments, tickets, refunds, closes, auctions, recounts, in funded tests (README "Tested behaviour", `docs/EVIDENCE.md`). Two small runs and a pilot on the main network are recorded in `docs/EVIDENCE.md` section 8. The real-money pages read a live main-network relay and the main-network chain servers.
- **Real, but on play money:** every test-network campaign; its coins (TAZ) have no value.
- **Not a mock but static:** `/demo` and `/demo/proofs` are finished test-network campaigns kept as plain files (the two "relays" are two copies of the same files); recounts there read the real public test-network chain servers.
- **Mocks exist only in tests:** stand-in chain and relay servers in the browser tests (`app/web/*-e2e.cjs`); the "cheating host" builds (`--features test-cheats`) used to prove that the recount catches misbehaviour. None of this is on any public page.
- **Not built yet:** anchoring of the list's fingerprint on a public ledger; the ticket chain-anchor check (level 4); returning late payments by command; the main network's NU7 upgrade is not active (the date is announced; the host program refuses campaigns that could still be running then, `host/src/mainnet.rs`).

---

## 5. Limits that must be honest on the page

Each is stated somewhere in the code or README; the page text that carries it is named.
1. **Late payments.** A payment mined after the deadline gets no ticket, is not counted, and is not refunded by the close; it stays in the campaign wallet until the host returns it by hand (`cb-host late` lists them). Page text: the late-payer line (2.5) and the host guide. Not yet built: a return command (README "Known limitations").
2. **Funding source.** Paying from an exchange or transparent money can show who paid and, in an auction, the bid amount before the close; an exchange may not attach the message, so the payment could not be tracked; crossing shielded pools can expose the amount. Page text: the always-visible payment line and its "Why?". Longer reasons: README "How to pay, and why", threat model 19. Detection is not built.
3. **Amounts and timing.** In a fundraiser every amount is public; block heights are public; both can help someone who already knows a payment find it (README).
4. **Network addresses.** Relays and chain servers see the address of whoever contacts them, and so does Cloudflare for the tunnel (README, threat model 18).
5. **What a recount does not check** (card, recount): the amount each message promised (needs the contributor's one-time secret), the proof inside each ticket (only on the contributor's device, on request), ticket chain anchors, ledger anchoring.
6. **Single sources.** One chain server or one relay makes a result "limited"; disagreement gives "cannot conclude", never a pass; hosting independence is judged only from the outside (`recount-page.js`).
7. **Saved copies.** They protect only the person who kept one; a copy taken after the damage proves nothing; a lagging relay can look like a cut-off; memory is per browser and per address; a matching copy does not prove completeness (recount "What a saved copy can and cannot show").
8. **The fingerprint** shows the list is the one the host fixed at the close; it cannot show the host was honest or the list complete at that moment (recount explainer).
9. **An unclosed auction cannot be recounted beyond R1–R2** because its viewing key is sealed until the close.
10. **The host must stay online.** Tickets are issued only while the host program runs; a contributor whose ticket does not arrive within the window is told so; if the host does not close within the ticket window after the deadline, contributors may claim their own refunds. A stalled chain server now makes a host check fail within about 20 s and retry (README "Known limitations").
11. **Losing the campaign folder** loses the host's wallet and key; contributors keep their tickets (threat model 12).
12. **A page can be replaced** by a malicious copy; visitors must trust the page they load (threat model 17).
13. **A refund fee is kept** (the campaign's `refund_fee_zat`); the smallest contribution is at least twice that fee.

---

## 6. Mismatches found while checking

These were found while writing this file; none was changed.
1. **Card, "Ledger anchoring".** `capabilities.js` `NOT_CHECKED` says "the host's ledger fingerprint is not yet published anywhere public". The host now signs a final fingerprint at the close and relays serve it (`app/relay/src/lib.rs` `put_final`, `final_raw`; `recount-page.js` fingerprint card). What is not built is anchoring on a public ledger or chain; the text does not say that distinction. The README carries the same sentence.
2. **Campaign page, closed.** It does not say whether the goal was met or missed; the outcome appears only in the list entry "Closed" and on the home card and the recount (`campaign.js` status text; `home.js` closed text).
3. **Test wording on a main-network page.** The capability card and the contribute page's facts say "Network: Test network: no real money" only for non-main networks; there is no matching "real money" line on the contribute page for main (the network bar carries it) (`contribute.js` near line 421; `capabilities.js` `NET`).
4. **Network chip on a campaign page for an unknown network:** the campaign and card pages call `setNetwork`, so the "NETWORK UNKNOWN" bar shows; the contribute page refuses; the recount page continues only if the rules are valid for a known network (`recount-page.js` `DEFAULT_ENDPOINTS[c.network] || []` → "No public servers are configured for this network.").
5. **Uniform-price set-up.** The host guide says a uniform-price auction is set up from the command line; `app/host/src/dashboard.rs` contains no uniform-price settings, which matches (checked by search for "uniform").
