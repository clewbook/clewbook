# How to Host Clewbook

This guide is for someone who wants to run their own campaign. Everything in it comes from the code and README in this repository and from our own setup. **It was tested on Ubuntu under WSL only**, plus one small Ubuntu 24.04 server for the relay and page server. Anything we have not run ourselves is marked **untested**. We have not followed this guide from a clean machine start to finish, so expect to meet small gaps. If a step fails, trust the code and the README over this page.

Words used here: the **host** is whoever runs a campaign. A **relay** is a small web service that stores and serves the host's signed list and the sealed refund tickets. A **tunnel** is a program that makes a service on your machine reachable from the internet over https without opening a port. **Testnet** is the Zcash test network, where the coins have no value.

## 1. What you need first

The README lists some of these. The ones it leaves out are marked with a star.

- Rust, stable, version 1.88 or newer, installed with `rustup`.
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

**What the request holds**: the campaign id, its relays (from the campaign's `private/relays`), its network, your host's public key, and two signatures, one by your host key and one by the campaign's own ledger key, so only someone who holds both can ask for that campaign. It holds no money, no secret, no name and no label: the listing reads the campaign's name from its relays, and the label comes from us. Before sending, the dashboard checks the campaign's name for the word Clewbook, and does not send a request that would be refused for it. The listing server checks the rest.

Then:

1. **Tell us who you are.** Open an issue at https://github.com/clewbook/clewbook/issues/new?title=Host%20with%20us (this needs a GitHub account) with your fingerprint, the label you would like (see below) and a word about your campaign. Approval is for your host key: once it is approved, your later campaigns are listed on their own, without asking again.
2. **Wait for approval.** Every 10 minutes the listing job reads your campaign from every relay you named and checks it. Your relay must be on https and reachable from the internet. Before it is listed for the first time, your campaign must pass a **recount**: the same check the recount page runs, over your relays' list and the public chain. A fundraiser gets the full recount; an auction before its close gets the two checks that can run without its viewing key, and the full recount after its close. Then, once we approve your host key, the campaign appears on the home page.

**Mainnet campaigns** can be sent the same way. Mainnet campaigns are listed once mainnet listing opens after the next network upgrade; the request is kept until then, and is not removed after 7 days like a testnet request.

**From the command line (the alternative).**

1. Make your host key, once: `cb-host host-key init --runs-dir runs`. It shows the public key and the fingerprint; `cb-host host-key show --runs-dir runs` shows them again.
2. Send a listing request: `cb-host listing-record --run runs/<campaign folder> --runs-dir runs --out listing-request.json --post https://listing.clewbook.xyz`. It writes the same request as the button to the file and sends it to `https://listing.clewbook.xyz/v1/records`. Its relays come from the campaign's `private/relays`, or repeat `--relay https://<your_relay_address>`. The answer says "received"; nothing is decided at that moment.
3. Then the same two steps as above.

What approval means: **we show your campaign under Clewbook with your label. It is not an audit**, and it says nothing about what the campaign is for. Once your host key is approved, your campaign's own page and its contribute page show one small line under the campaign's name: "Hosted by <label>". The home page never shows it. The label comes from us, never from your request; it follows the same rules as campaign names, and it may not contain the word Clewbook. Campaign names that look like a name already listed, or like the word Clewbook in any spelling, are refused.

Some things to know:

- A request from a host we have not approved waits at most **7 days**, then it is removed. You can send it again.
- A listed campaign stays listed after its deadline, as a closed campaign. It is recounted again when its list changes and at least every 6 hours; if a recount fails later, the campaign stays listed and we are told, and we decide whether to take it off.
- We can hide a campaign or revoke a host key at any time. Nothing is deleted from any relay.
- **Mainnet listing is not open yet.** Mainnet requests are kept until it opens (see above). For help with hosting, use the same issue link (Contact us).

A link to a campaign on those pages works without being listed: the pages take the campaign and its relay from the link, provided your relay is on https. We have not tested this with a relay run by someone else.

How the listing job works, its checks and limits: `docs/LISTING.md`.

## 7b. Blind bid auctions (test network only, not shipped)

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
  the settlements are mined. If you do not, everyone takes their deposit back with their late ticket and the auction is shown as not
  finished.

Tested on private regtest chains only (`app/regtest/README.md`); not run on the public test network.

## 8. Mainnet

Testnet campaigns have no restriction. For mainnet, the host program refuses to create a campaign that could still be open when the next Zcash network upgrade (NU7) activates. The upgrade already runs on testnet. The mainnet update of the libraries follows the upgrade and has not been done. Until you give the program the mainnet activation height (`--nu7-mainnet-height`), a campaign must end at least a week before 5 November 2026, the date announced for the upgrade (we have not confirmed it ourselves). Creating a mainnet campaign also needs an explicit confirmation (a tick box on the set up page, or `--confirm-mainnet`). After the upgrade, mainnet hosting waits for a library update. Real money runs so far were two small ones, described in `docs/EVIDENCE.md` section 8.

## 9. Honest cautions

- **Keys are plain files on the host's machine today.** The campaign's signing and memo keys are in `secrets.json` in the campaign folder (readable only by its owner, but not protected by a passphrase). The wallet's seed phrase file is locked with a key file that sits in the same folder, so it adds no protection against someone who can read the folder.
- **There has been no outside review of the code or of the design.** The tests and evidence in this repository are ours.
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
