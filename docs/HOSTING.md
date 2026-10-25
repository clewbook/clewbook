# How to Host Clewbook

This guide is for someone who wants to run their own campaign. Everything in it comes from the code and README in this repository and from our own setup. **It was tested on Ubuntu under WSL only**, plus one small Ubuntu 24.04 server for the relay and page server. Anything we have not run ourselves is marked **untested**. We have not followed this guide from a clean machine start to finish, so expect to meet small gaps. If a step fails, trust the code and the README over this page.

Words used here: the **host** is whoever runs a campaign. A **relay** is a small web service that stores and serves the host's signed list and the sealed refund tickets. A **tunnel** is a program that makes a service on your machine reachable from the internet over https without opening a port. **Testnet** is the Zcash test network, where the coins have no value.

## Host checklist (one page)

Each line links to the part that explains it. Numbers are from the code; on the test network and after NU7 some differ (tables below).

**Before you create**

| Check | Where |
|---|---|
| Choose the network. Mainnet uses real ZEC and asks you to tick a box. | [Mainnet](#8-mainnet) |
| Mainnet before NU7: the whole campaign must end before the upgrade. A blind bid auction must end, late tickets included, before block 3,542,253. | [MAINNET.md](MAINNET.md#how-long-a-blind-bid-auction-can-run-before-nu7) |
| Pick a deadline that leaves at least 10 blocks for deposits after the ticket window. | [Timing](BLIND_BIDS.md#timing-for-hosts) |
| Have a wallet of your own ready, with a `u1` address, for the money you keep. | [Addresses](#addresses) |
| Blind bid: plan to fund the coin wallet, about 0.0002 ZEC per deposit. | [Coin wallet](#the-coin-wallet-blind-bid-auctions) |

**While it runs**

| Check | Where |
|---|---|
| Keep the host program and its computer running. A ticket must be issued within the ticket window. | [Tickets](#refund-tickets) |
| Blind bid: keep the coin wallet funded. Every small payment must be mined by the coin cutoff. | [Coin wallet](#the-coin-wallet-blind-bid-auctions) |
| Watch the dashboard warnings, or the operator bot's alerts. | [Operator bot](#7c-operator-bot-telegram-optional) |

**At close**

| Check | Where |
|---|---|
| Fundraiser or auction: close after the deadline and before the ticket window ends. | [Closing](#closing) |
| Blind bid: close after the bids open and before the late ticket block. The dashboard shows "Close before block N". | [Closing](#closing) |
| Wait until the dashboard shows every settlement and refund confirmed. Press Try again if it says unfinished. | [Closing](#closing) |

**After close**

| Check | Where |
|---|---|
| Blind bid: press "Send to my wallet" for the prices the auction collected. | [Closing](#closing) |
| Blind bid: press "Send the coin wallet back to my wallet" for what is left in the coin wallet. | [Coin wallet](#the-coin-wallet-blind-bid-auctions) |
| Run the recount from outside and check it passes. | [CHECKS.md](CHECKS.md) |

## Tickets, timing and money

### Refund tickets

A refund ticket is a transaction the host signs in advance. It pays a contribution back to the refund address the person gave. The
person's page checks it and keeps it. Using a ticket needs no help from the host: the page sends it to the network itself.

| Ticket | Campaign | When it can be used | Who sends it |
|---|---|---|---|
| Refund ticket | Fundraiser, auction | Any time before the deadline ("Refund me"). After the deadline, if the host has not closed within the ticket window ("Claim my refund"). | The person's page |
| Early ticket | Blind bid auction | Until 4 blocks before the deadline ("Take my money back"). It expires at the deadline. | The bid page |
| Signed refund | Blind bid auction | At the close, for a bid that does not win. | The host |
| Late ticket | Blind bid auction | After the late ticket block, if the host never finishes. | The bid page, or the late ticket watcher |

The ticket window (K) is the number of blocks the host has to issue a ticket after a payment, and to close after the deadline.

| Setting | Default before NU7 | Default after NU7 | Allowed |
|---|---|---|---|
| Ticket window K | 30 blocks | 90 blocks | 10 to 1,000 blocks |
| Close grace (kept in the rules, decides nothing) | 10 blocks | 30 blocks | |
| Reissue window (kept in the rules) | 20 blocks | 60 blocks | |
| Settle window (uniform price auction) | 40 blocks, or K if larger | 120 blocks, or K if larger | up to 1,000 |
| Confirmations before a ticket is issued: fundraiser, auction | mainnet 3, test network 1 | the same | up to 20 |
| Confirmations before a ticket is issued: blind bid auction | 1 (`--min-confirmations` on the command line) | the same | up to 20 |

A ticket is valid for one network version only. A ticket signed before a network upgrade stops working after it. See
[MAINNET.md](MAINNET.md#25-second-blocks-after-nu7).

### Blind bid timing

The full table is in [BLIND_BIDS.md](BLIND_BIDS.md#timing-for-hosts). In short: deposits until 20 blocks before the deadline; the bids
open with a drand round planned after the close; the host then has a settlement window; the late ticket block comes after that, with a
60 minute safety margin. The bid page refuses an auction whose timing has no slack left. Such an auction cannot be fixed: make a new one.

### The coin wallet (blind bid auctions)

Each deposit needs a small payment from the host, the coin. It lets the bid page sign its late ticket. The coins are paid from a
separate coin wallet, which you fund from your own money.

| Fact | Value |
|---|---|
| One coin | 5,000 zatoshis (0.00005 ZEC) |
| Network fee, one coin at a time | 15,000 zatoshis. Measured on the test network on 23 Oct 2026: 20,000 zatoshis per deposit in all. |
| Network fee, coins sent together | 5,000 zatoshis per coin plus 10,000 per payment (the ZIP 317 fee rule; not measured) |
| How much to fund | About 0.0002 ZEC per deposit you expect, plus a margin |
| Coin cutoff | Every coin must be mined by 10 blocks before the deadline |
| Coins go out at once, whatever you chose | From 20 blocks before the cutoff (60 for an auction made after NU7) |
| The bid page warns that the cutoff is close | From 15 blocks before the cutoff (45 after NU7) |
| Coin payment expiry | 40 blocks; 120 blocks after NU7 |

If the coin wallet runs dry, coins stop going out and the dashboard says why. A deposit whose coin is not mined by the cutoff has no
late ticket. Its bid page tells the person to take the money back with the early ticket while it still can. A deposit mined after the
last deposit block is sent back by the host on its own.

After the close, press **Send the coin wallet back to my wallet** (or `/send_coin_back` in the operator bot). What is left, minus the
network fee, goes to your wallet.

### Closing

| Campaign | Close window | If the host misses it |
|---|---|---|
| Fundraiser | After the deadline, before deadline + K | Each person presses "Claim my refund" and gets the contribution back with the ticket. |
| Auction (uniform price) | Close after the deadline; settle every winner within the settle window | After it, each person can claim their own refund. |
| Blind bid auction | After the drand round is out, before the late ticket block + 1 ("Close before block N" on the dashboard) | Every bid page that signed a late ticket can take its deposit back after the late ticket block, and the late ticket watcher can send it for them. The recount says "did not finish". |

At the close of a blind bid auction the host settles the winners, sends each losing deposit its signed refund, then publishes the viewing
key. The prices the winners paid go to the auction's treasury wallet. Press **Send to my wallet** (or `/send_treasury`) to move them to
your own wallet. The dashboard reminds you while money is still there.

### Payments not in the auction (blind bid auctions)

A payment with no memo, a memo that is not a bid, or less than the smallest deposit is not a bid. It has no refund address the host
can read, so it stays in the auction wallet. The dashboard lists each one under **Payments not in the auction**, and the operator bot
alerts once for each. Only the dashboard can send one back; Telegram cannot.

**Send it back** asks for the payer's `u1` address (the `zu1` form is refused). Everything else is optional evidence:

| Evidence | What the dashboard shows |
|---|---|
| Bid backup file | Whether its message opens with this auction's key, the deposit size, the block it was made at, and whether its refund address is the address given (a clear warning if not). The page reads only those fields, never the file's seed. |
| Payer's wallet key | "This key shows the transaction" or "does not match". A full viewing key or an outgoing viewing key. It shows every payment that account sent (a full viewing key also every payment received), so it is optional. A proof for one transaction does not exist on Ironwood. The key is used for the check and dropped, never stored. |
| Notes | How the host checked, in one line. |

None of it proves who paid. Each missing piece is named ("not given"). With none of them the dashboard says "Nothing here shows who
paid. Anyone can see this transaction id." and still allows the send. The last step shows the amount, the fee (0.0004 ZEC comes back
from 0.0005) and the address, and asks for the first 8 characters of the payment's transaction id. The return spends only that payment
and pays only that address; anything else is refused before it is sent. The dashboard then gives an evidence line for
[EVIDENCE.md](EVIDENCE.md) that lists which proofs were given, and keeps a copy in the campaign folder (`sendback-evidence.txt`). The
return cannot go on the public list: the relay takes no entries after the close. The recount still lists the payment, with the
transaction that spent it.

A challenge (a tiny payment with a code in its memo that the payer reads back) is not offered. It only shows that the payer can read
payments to the address they gave, which anyone giving their own address can. It says nothing about who paid.

A return is built and signed when you press the button, for the network version of the next block. The libraries choose that version
from their own settings, not from the chain. Host programs built before the move to `zcash_protocol 0.11.0` (21 Oct 2026) do not know
the main network NU7 height (block 3,543,405, about 5 November 2026) and keep signing for the version before it: on the main network a
return pressed after NU7 would be refused and the payment would stay locked until an update. This build knows it and signs for NU7
from that block on (test `libraries_pick_the_branch_the_networks_report`). Refund tickets are different: they are signed in advance,
so a ticket signed before NU7 stops working after it, whatever the build.

### Automatic late tickets

A bid page that signs its late ticket gives each list server a copy. The server keeps it and never shows it (before the close it would
show the deposit's size). The late ticket watcher runs next to the relay. After the late ticket block it waits 60 minutes, counted from
that block's own time. The wait is a setting (`--wait-minutes`). Then, if the list shows no close and no settlement, it sends each copy.
It skips any auction the host closed or settled. If the watcher is not running, or a copy did not reach a server, the person opens their
bid page after the late ticket block and presses **Take my money back**. Install: [app/latewatch/INSTALL.md](../app/latewatch/INSTALL.md).

### Addresses

Some wallets reject the `zu1` form of an address (Vizor did on 22 Oct 2026). The dashboard shows every address it gives out in the
standard `u1` form. Use a `u1` address for your own wallet too. The operator bot's payout addresses are set only through ssh on the
server; they can never be changed from Telegram.

## 1. What you need first

The README lists some of these. The ones it leaves out are marked with a star.

- Rust, stable, version 1.89 or newer, installed with `rustup`.
- A C compiler and linker, and `git` (star, untested: on Ubuntu the package `build-essential` normally provides the compiler and linker). Other system packages may be needed on a bare machine. We did not record which.
- Python 3 (the page server uses only its standard library).
- A few gigabytes of free disk for build output. The first build takes a while because the Zcash libraries are large. We did not time it on a clean machine.
- For the browser module: the WebAssembly target (`rustup target add wasm32-unknown-unknown`), `wasm-bindgen-cli` at exactly version 0.2.129 (`cargo install wasm-bindgen-cli --version 0.2.129`), and **Zig 0.14**. Download Zig from ziglang.org, unpack it, and set the variable `ZIG` to the path of the `zig` program when you run the build script. Zig compiles the one C dependency for the browser.
- Node 22 only if you want to run the browser tests. They also need Chromium: after `cd app/vectors/js && npm ci`, run `npx playwright install chromium`, and on Ubuntu `sudo npx playwright install-deps chromium` for its system libraries (if you cannot use sudo, the four missing ones on a bare WSL Ubuntu were `libnspr4`, `libnss3`, `libnssutil3` and `libasound2`: `apt-get download` them and point `LD_LIBRARY_PATH` at the unpacked folder, as we did).
- For a real campaign: a machine that stays on and online, a public https address for the relay, and an https address for the pages.
- A place for the public list: a relay that contributors and visitors can reach. You can run your own (section 4) or use one you trust.
- A shielded address to receive what the campaign keeps.

## 2. Build

From the repository root:

```
cd app && cargo build --release          # cb-host, cb-relay, cb-contrib, cb-recount: app/target/release
cd .. && cargo build --release           # the patched wallet tool: target/release/zcash-devtool
ZIG=/path/to/zig app/web/build.sh        # the browser module: app/web/www/pkg and app/web/www/proof
```

All three are needed. The wallet tool is required because the dashboard creates each campaign's wallet by running it. The browser module is required because the pages do not work without it. It is not stored in the repository, so you build it yourself.

## 3. A full local trial on testnet

This runs everything on one computer and moves no real money. Open three terminals in the repository root.

```
python3 app/web/serve.py 8770
./app/target/release/cb-relay serve --dir runs/relay1 --listen 127.0.0.1:8787
./app/target/release/cb-host serve --relay http://127.0.0.1:8787
```

1. Open `http://127.0.0.1:8780`. This is the host dashboard. It only listens on your own computer. Use its set up page to create a campaign. It makes the campaign's wallet and keys inside a new folder under `runs/dashboard`. It needs the testnet chain server to answer.
2. The dashboard shows a contributor link. Open it in a browser. The pages are served at `http://127.0.0.1:8770`.
3. To contribute you need testnet coins (TAZ, which have no value) in a wallet of your own. This repository does not provide any. The faucet we used during testing is the Zcash Testnet Faucet run by Valar at `https://faucet.testnet.valargroup.dev/`. It is not run by this project; on 14 October 2026 it answered and reported itself ready, paying 0.125 TAZ per address once a day. If it is gone, look for a current Zcash testnet faucet on the Zcash community forum. You can make a wallet for the coins with the wallet tool (see "A campaign from the command line" below for the command; use your own folder name, for example `payer`), and print its address with `./target/release/zcash-devtool wallet -w payer list-addresses`.
4. Pay from your wallet by scanning the code or copying the address and message. Within a minute or two the page shows a refund ticket. The host must be running (the dashboard runs the watcher) for tickets to be issued.
5. Close the campaign from the dashboard after its deadline, then open the Recount page from the campaign page and check the result.

### A campaign from the command line

The dashboard makes a campaign's wallet for you. From the command line you make it yourself first, with the wallet tool, inside the campaign's own folder (the host program refuses a wallet or key file outside it):

```
mkdir -p runs/my-campaign
./target/release/zcash-devtool wallet -w runs/my-campaign/wallet1 init --name campaign -i runs/my-campaign/wallet1.age -n test
./app/target/release/cb-host create --run runs/my-campaign --wallet runs/my-campaign/wallet1 --identity runs/my-campaign/wallet1.age \
    --goal-zat 5000000 --deadline-in 500 --relay http://127.0.0.1:8787
./app/target/release/cb-host watch --run runs/my-campaign       # keep this running: it issues the tickets
```

- `init` needs the testnet chain server; if it stalls, delete the half made folder and try again.
- `wallet1.age` is the key file that unlocks the wallet's seed. It sits next to the wallet, so the folder as a whole is the key: back it up and keep it private.
- Run `cb-host create --help` for every option, including `--mode auction`, `--items`, `--goal-zat`, `--deadline-in`, `--ticket-k`, `--early-close`, `--name` and `--relay`.
- For the main network add `-n main` to `init` and `--network main --confirm-mainnet` to `create`; section 8 applies.

### The steps of a campaign

These are the steps of every campaign, run from your own computer. This site does not host campaigns, hold keys or touch anyone's money, and it has no button that sets one up for you.

1. Start the host program's dashboard on your own computer. It is for you only and cannot be reached from other devices.
2. Set up the campaign there: type, goal or items, deadline, smallest contribution, and the ticket window. It makes a wallet and a key for this campaign alone.
3. Share the contribute link it gives you. Contributors pay from their own wallets, and each one gets a refund ticket signed in advance.
4. After the deadline, close the campaign from the dashboard. It refunds, sweeps or settles, and saves a final copy of the list with a signed fingerprint.
   A fundraiser made with "I may cancel and refund everyone" can instead be cancelled from the dashboard at any time before the deadline, even after the goal is met: every contributor gets their money back by their own ticket, minus the network fee, and nothing is kept. Payments that arrive after the cancel are sent back on their own.
5. Share the recount link. Anyone can then check your books against the public chain.

The two kinds: in a **fundraiser** people contribute toward a goal; if the goal is reached by the deadline you keep the money, and if not, everyone is refunded. In an **auction** people bid for a number of items; bid amounts stay off the public record until you close, though you see each bid as it arrives. The highest bids win and everyone else is refunded. Winners pay in one of two ways, chosen on the set up page: by default everyone who wins pays the same price, the lowest winning bid, and gets back anything extra they sent, with the payments going to a treasury wallet made for the campaign; or each winner pays their own bid, and it is sent to your address.

## 4. Running a relay on a small server

A relay needs very little: in our own run on a small Ubuntu 24.04 server it used about 5 MB of memory and almost no processor time. Its data is a folder of plain files.

**Read this first: the relay accepts campaign registrations from anyone, without a signature.** It checks that the rules are valid and hash to the campaign id, and nothing else. Ledger entries and the host's heartbeat do need the campaign's own signature, but anyone can register a campaign with their own key and then add entries for it. So a public relay can be filled with junk. Limit the damage with these flags and watch the disk:

- `--max-campaigns N`: how many campaigns the relay accepts (default 200).
- `--max-entries N`: how many entries one campaign may hold (default 5000, and a fixed ceiling of 100000 in the code).
- Worst case disk is roughly campaigns times entries times up to 80 KB (16 KB per entry plus 64 KB per ticket are the code's limits). A real contribution uses about 10 KB. Choose numbers your disk can hold, and check free space regularly.

A systemd service example (placeholders in angle brackets, adapt to your machine). We run this shape ourselves, with the paths changed here:

```
[Unit]
Description=Clewbook relay
After=network-online.target
Wants=network-online.target

[Service]
User=<relay_user>
WorkingDirectory=<install_dir>
ExecStart=<install_dir>/cb-relay serve --dir <data_dir> --listen 127.0.0.1:8790 --max-campaigns 20 --max-entries 5000
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=<data_dir>

[Install]
WantedBy=multi-user.target
```

Keep it bound to `127.0.0.1`. The relay speaks plain http, so put an https front in front of it:

- **A tunnel** (we use a Cloudflare Tunnel, tested): run the tunnel program on the same machine and point a public hostname of yours at `http://127.0.0.1:8790`. The tunnel adds the visitor's address in a header called `CF-Connecting-IP`, which the relay's per address rate limit uses (600 requests a minute by default). The relay trusts that header only when the request comes from the same machine.
- **A reverse proxy** such as Caddy or nginx on the same machine: **untested**. It would need to terminate https, forward to `127.0.0.1:8790`, and set that header to the real visitor address. Without the header the relay does not rate limit those requests.
- The relay already answers cross origin browser requests (it sends `Access-Control-Allow-Origin: *`), which the pages need.
- Browsers block an http relay on an https page, so the public relay address must be https.
- Close all other inbound ports with a firewall. A tunnel needs none.

Move the built `cb-relay` to the server. The build machine and the server need compatible system libraries (it uses only the C library and `libgcc_s`). If they differ, build on the server.

## 5. Pointing the host and the pages at your addresses

- Tell the host which relay to publish to: `cb-host serve --relay https://<your_relay_address>` (repeat the flag for more than one). A campaign created from the command line takes `--relay` the same way. Inside each campaign folder the file `private/relays` lists the relays, one per line, and the host reads it again on every check.
- Tell the dashboard where your pages live, so the contributor links it builds are right: `--page-base https://<your_pages_address>`. The default is `http://127.0.0.1:8770`, which only works on your own computer.
- The contribute page needs a chain server for the network. The dashboard option `--server` sets it (default is the testnet server). For mainnet pass `--network main` and the address of a public mainnet chain server.
- The home page lists campaigns from a file `campaigns.json` next to the pages. Its form is `{"campaigns": [{"id": "<64 hex characters>", "relays": ["https://<your_relay_address>"]}]}`. You maintain it by hand: start from the empty example, `cp app/web/www/campaigns.example.json app/web/www/campaigns.json`, and add your campaign's id and relays. Without the file the home page lists nothing. Campaign, contribute and recount pages work for any campaign from a link, with no list. (On app.clewbook.xyz the list comes from the listing job, section 7.)
- Keep the host (`cb-host serve`) running on your own machine until the campaign has closed and refunds are confirmed. The dashboard is for you only and cannot be reached from other devices.

## 6. The page server

`python3 app/web/serve.py <port> <bind address>` (default 8770 on 127.0.0.1) serves the folder `app/web/www`. Put the same kind of https front in front of it as for the relay. Things to know:

- It serves only an **allow list** of files: the pages (home, host page, campaign, contribute, recount, card, badge), their scripts and styles, the fonts, the images, the browser modules in `pkg/` and `proof/`, `campaigns.json` and `robots.txt`. Anything else gets the same plain 404 page, including the dashboard files, which are never served. A different folder can be served by setting the environment variable `SERVE_ROOT`.
- It sends a strict content policy, no referrer, no sniffing and no cookies. Only the badge page may be shown inside another site's page.
- It forwards browser calls under `/grpc/<host>` to two public chain servers that do not answer browsers themselves, with a small body limit and a limit on parallel requests.
- Do not turn on its developer mode on a public server. The code warns about this.
- Every response is marked as not cacheable, so each visit downloads the browser module again (about 2.4 MB, 0.6 MB compressed). Plan transfer for that.

## 7. Listing and contact

The project runs one public set of pages, app.clewbook.xyz. Its home page shows the project's own campaigns and the campaigns of hosts we have approved. You can ask for your campaign to be listed there yourself, from the dashboard or from the command line.

**From the dashboard (the usual way).** Open the campaign in your dashboard and press **Submit for listing** in the section "Listing on app.clewbook.xyz". A short box says what will be sent, and nothing is sent until you press **Send the request**. The first time, the dashboard makes your **host key**: a long lived key in `host_key.json` in the dashboard's runs folder (readable only by you, never replaced, never printed). Then it sends the request to `https://listing.clewbook.xyz` (another server with `cb-host serve --listing-url <address>`). The campaign then shows the answer: "Sent, waiting for approval" with your host **fingerprint** (five groups of four characters), or the reason it was refused. Later, **Check status** asks the listing server where the request stands: Waiting, Listed, Not listed (with the reason), or Waiting for mainnet listing to open. Closed campaigns can be sent too; they are listed as closed campaigns. Each dashboard folder has its own host key, so two dashboards (for example one for testnet and one for mainnet) have two fingerprints.

**What the request holds**: the campaign id, its relays (from the campaign's `private/relays`), its network, your host's public key, and two signatures, one by your host key and one by the campaign's own ledger key, so only someone who holds both can ask for that campaign. It holds no money and no secret. From the dashboard it can also hold a name you suggest for yourself (the box "Your name", optional, up to 30 characters; the command line request has none). The listing reads the campaign's name from its relays. Before sending, the dashboard checks the campaign's name for the word Clewbook, and does not send a request that would be refused for it. The listing server checks the rest.

Then:

1. **Tell us who you are.** Open an issue at https://github.com/clewbook/clewbook/issues/new?title=Host%20with%20us (this needs a GitHub account) with your fingerprint, the label you would like if you did not suggest one (see below) and a word about your campaign. Approval is for your host key: once it is approved, your later campaigns are listed on their own, without asking again.
2. **Wait for approval.** Every 10 minutes the listing job reads your campaign from every relay you named and checks it. Your relay must be on https and reachable from the internet. Before it is listed for the first time, your campaign must pass a **recount**: the same check the recount page runs, over your relays' list and the public chain. A fundraiser gets the full recount; an auction before its close gets the two checks that can run without its viewing key, and the full recount after its close. Then, once we approve your host key, the campaign appears on the home page.

**Mainnet campaigns** can be sent the same way. Mainnet campaigns are listed once mainnet listing opens after the next network upgrade; the request is kept until then, and is not removed after 7 days like a testnet request.

**From the command line (the alternative).**

1. Make your host key, once: `cb-host host-key init --runs-dir runs`. It shows the public key and the fingerprint; `cb-host host-key show --runs-dir runs` shows them again.
2. Send a listing request: `cb-host listing-record --run runs/<campaign folder> --runs-dir runs --out listing-request.json --post https://listing.clewbook.xyz`. It writes the same request as the button to the file and sends it to `https://listing.clewbook.xyz/v1/records`. Its relays come from the campaign's `private/relays`, or repeat `--relay https://<your_relay_address>`. The answer says "received"; nothing is decided at that moment.
3. Then the same two steps as above.

What approval means: **we show your campaign under Clewbook with your label. It is not an audit**, and it says nothing about what the campaign is for. Once your host key is approved, your campaign's own page and its contribute page show one small line under the campaign's name: "Hosted by <label>". The home page never shows it. The label is the name you suggested, if we approve it as it is, or one we choose. A suggested name is plain text of at most 30 characters, follows the same rules as campaign names, and may not contain a word from the listing's reserved labels list, in any spelling; such a name is refused when the request arrives. Campaign names that look like a name already listed, or like the word Clewbook in any spelling, are refused.

Some things to know:

- A request from a host we have not approved waits at most **7 days**, then it is removed. You can send it again.
- A listed campaign stays listed after its deadline, as a closed campaign. It is recounted again when its list changes and at least every 6 hours; if a recount fails later, the campaign stays listed and we are told, and we decide whether to take it off.
- We can hide a campaign or revoke a host key at any time. Nothing is deleted from any relay.
- If your relay or the chain cannot be reached for a while (no connection, a timeout, an HTTP 5xx answer), a listed campaign stays listed with its last good state for up to 1 hour, then is taken off until the relay answers again. A relay that answers wrongly (a 404, or content that does not check out) takes it off at once.
- **Mainnet listing is not open yet.** Mainnet requests are kept until it opens (see above). For help with hosting, use the same issue link (Contact us).

A link to a campaign on those pages works without being listed: the pages take the campaign and its relay from the link, provided your relay is on https. We have not tested this with a relay run by someone else.

How the listing job works, its checks and limits: `docs/LISTING.md`.

## 7b. Blind bid auctions (test network; main network before NU7)

A blind bid auction (SPEC section 9) runs from its own host on port 8786 with its own campaigns folder, `runs/testnet-sealed`, never the
ports or folders of other hosts: `app/sealed-testnet.sh dry-run | start | stop | status` (start needs `SEALED_RELAY`; there is no
default). Create one on its set up page (the "Blind bid auction" choice appears when the host runs off mainnet) or with
`cb-host create-sealed`. What the host must do:

- **Fund the coin wallet** the dashboard shows, from your own money: it sends each bid page 0.00005 so that the person can take their deposit
  back on their own if you never finish. Choose when they go out (at once, every N bids, every N minutes); near the cutoff they always go
  out at once.
- **Keep the program running** until the cutoff, 10 blocks before the deadline.
- **Close after the deadline**, once drand round R is out (the dashboard shows R and its time) and before the late ticket block. Closing
  opens the bids, pays each price into the auction's treasury, sends everyone else their signed refund, and publishes the viewing key once
  the settlements are mined. If you do not, everyone whose page signed a late ticket can take their deposit back with it (each person opens their bid page after
  the late ticket block and presses one button), and the auction is shown as not
  finished.

After the close, send the treasury to your own wallet from the dashboard ("Send to my wallet").

Tested on private regtest chains (`app/regtest/README.md`) and on the public test network (four proof auctions, `docs/EVIDENCE.md`
section 12). Live on the test network since 21 Oct 2026 and on the main network since 23 Oct 2026: there the set up page asks for the
mainnet tick, takes only the standard timing, and refuses an auction that would still run, late tickets included, at block 3,542,253
(the NU7 upgrade at 3,543,405, less a day). After the close, send the treasury to your own wallet ("Send to my wallet") and what is left
in the coin wallet ("Send the coin wallet back to my wallet"); the dashboard reminds you while either still holds money.

## 7c. Operator bot (Telegram, optional)

`app/opbot/opbot.py` runs a few commands from Telegram for the hosts on one server. It uses the Python standard library only. It asks
Telegram for new messages (no open port) and acts only through each host's dashboard on 127.0.0.1.

| It can | It cannot |
|---|---|
| `/status`: each campaign, its phase, deposits, coin wallet and treasury | Create a campaign |
| `/close <id>`: close a campaign | Change a payout address (only through ssh on the server) |
| `/send_treasury <id>`: move a closed auction's prices to the saved payout address | Send money to an address typed in the chat |
| `/send_coin_back <id>`: move what is left in the coin wallet to the saved payout address | Read a wallet or a key (it has no access to the campaign folders) |
| `/queue`, `/approve`, `/hide`: the listing job's queue (only if you run one) | Answer anyone but the one user and chat in its settings |
| Alerts: the bids are open, 6 hours and 1 hour before the last block to close, the coin wallet running low, "did not finish" | Take more than 10 commands a minute |

Every money or close command first shows a Confirm button with the exact amount and address. Cancel sends nothing, and a used button does
not work again. Money goes only to the payout address saved for that network (`main=` or `test=`). Without one, the bot says so.

**Set it up with your own bot**

1. In Telegram, open BotFather, send `/newbot`, and follow it. It gives you a token. Keep the token private.
2. Send your new bot any message. Then open `https://api.telegram.org/bot<token>/getUpdates` in a browser. The number after
   `"chat":{"id":` is your chat id.
3. On the server, write a root owned file, mode 600, with two lines: `token=<token>` and `chat_id=<chat id>`. In a group chat, add
   `user_id=<your user id>`.
4. Write a second root owned file, mode 600, with your payout addresses: `main=u1...` and, if you like, `test=utest1...`.
5. Install the service: `app/opbot/INSTALL.md`, one command a step, each with its rollback. Give `--hosts` your dashboards, for example
   `--hosts main=http://127.0.0.1:8780`. `--listing` is required; if you run no listing job, give `/bin/false` and the listing commands
   answer with an error.
6. Send `/help` to the bot.

Tested end to end on the test network: `app/opbot/opbot-e2e.py`.

## 7d. Late ticket watcher (optional, next to a relay)

A relay keeps the copies of signed late tickets that bid pages give it, and never serves them. `app/latewatch/latewatch.py` reads them
from the relay's folder. It holds no key and no wallet. 60 minutes after an auction's late ticket block (a setting, `--wait-minutes`), if
the list shows no close and no settlement, it sends each copy to the chain servers. Install steps, each with its rollback:
`app/latewatch/INSTALL.md`. More: [Automatic late tickets](#automatic-late-tickets).

## 8. Mainnet

Testnet campaigns have no restriction. For mainnet, the host program refuses to create a campaign that could still be open when the next Zcash network upgrade (NU7) activates. The upgrade already runs on testnet. The mainnet update of the libraries follows the upgrade and has not been done. Until you give the program the mainnet activation height (`--nu7-mainnet-height`), a campaign must end at least a week before 5 November 2026, the date announced for the upgrade (we have not confirmed it ourselves). Creating a mainnet campaign also needs an explicit confirmation (a tick box on the set up page, or `--confirm-mainnet`). After the upgrade, mainnet hosting waits for a library update. Real money runs so far: two small early ones (`docs/EVIDENCE.md` section 8) and the project's four mainnet campaigns (section 11).

## 9. Honest cautions

- **Keys are plain files on the host's machine today.** The campaign's signing and memo keys are in `secrets.json` in the campaign folder (readable only by its owner, but not protected by a passphrase). The wallet's seed phrase file is locked with a key file that sits in the same folder, so it adds no protection against someone who can read the folder.
- **The host machine must stay online** from before the first contribution until the campaign is closed and refunds are confirmed. If it is off, new payments get no ticket, and the recount flags it.
- **Try it on the test network first.** Its coins have no value. A real money campaign asks for an extra confirmation (section 8).
- **The campaign folder is the key.** Back it up before taking any money, keep the backup private, and never share the folder. There is no key import. If you lose it, nothing can recover the wallet or the key; contributors can still use their own tickets.
- A payment that arrives after the deadline is not counted and is not refunded automatically. See "Late payments" in [PRIVACY.md](PRIVACY.md).
- **Close in time.** If you do not close within the ticket window after the deadline, contributors may claim their own refunds.
- **The recount is public.** Anything that does not match the chain shows up as a failed check for everyone to see.
- The relay holds no secrets, but it is a public service: everything on it is public data.

## 10. Hardening (optional)

None of this is needed to run a campaign. Each step trades some convenience for safety.

- **A sudo password on the server.** If the server's user can run `sudo` without a password, anyone who gets into that account controls the whole machine. Require the password: give the user one (`sudo passwd <user>`) and remove any `NOPASSWD` line for it (edit with `sudo visudo`). Tradeoff: every update or service restart you do by hand then asks for that password, so a script cannot do it unattended. The services still restart by themselves after a crash (`Restart=always` above), because systemd does that, not your user.
- **A separate deploy user.** Run the relay and the page server as a user that cannot use `sudo`, and do updates as another user that can. A flaw in the relay or the page server then reaches only the files of the service's own user. Tradeoff: one more account to look after, and files you copy in must be handed to the service's user (`chown`).
- **A passphrase on the host's keys: not available yet.** Today the host reads its keys from the campaign folder without asking for anything (section 9). An optional start up passphrase is planned (see `docs/ROADMAP.md`, "Passphrase flag"). The tradeoff, once it exists: a passphrase protects the keys on a stolen or copied disk, but the host can no longer restart by itself after a crash or a reboot. Someone has to type the passphrase each time, and until they do, new payments get no ticket.
