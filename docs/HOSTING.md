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
- Node 22 only if you want to run the browser tests.
- For a real campaign: a machine that stays on and online, a public https address for the relay, and an https address for the pages.

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
3. To contribute you need testnet coins in a wallet of your own. This repository does not provide any. A public test network faucet exists. We used one during testing and do not name it here.
4. Pay from your wallet by scanning the code or copying the address and message. Within a minute or two the page shows a refund ticket. The host must be running (the dashboard runs the watcher) for tickets to be issued.
5. Close the campaign from the dashboard after its deadline, then open the Recount page from the campaign page and check the result.

Command line alternative for step 1: `cb-host create`. Run `cb-host create --help` for every option, including `--mode auction`, `--items`, `--goal-zat`, `--deadline-in`, `--ticket-k`, `--name` and `--relay`.

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
- The home page lists campaigns from a file `campaigns.json` next to the pages. Its form is `{"campaigns": [{"id": "<64 hex characters>", "relays": ["https://<your_relay_address>"]}]}`. You maintain it by hand. Campaign, contribute and recount pages work for any campaign from a link, with no list.
- Keep the host (`cb-host serve`) running on your own machine until the campaign has closed and refunds are confirmed. The dashboard is for you only and cannot be reached from other devices.

## 6. The page server

`python3 app/web/serve.py <port> <bind address>` (default 8770 on 127.0.0.1) serves the folder `app/web/www`. Put the same kind of https front in front of it as for the relay. Things to know:

- It serves only an **allow list** of files: the pages (home, host guide, campaign, contribute, recount, card, badge), their scripts and styles, the fonts, the images, the browser modules in `pkg/` and `proof/`, `campaigns.json` and `robots.txt`. Anything else gets the same plain 404 page, including the dashboard files, which are never served. A different folder can be served by setting the environment variable `SERVE_ROOT`.
- It sends a strict content policy, no referrer, no sniffing and no cookies. Only the badge page may be shown inside another site's page.
- It forwards browser calls under `/grpc/<host>` to two public chain servers that do not answer browsers themselves, with a small body limit and a limit on parallel requests.
- Do not turn on its developer mode on a public server. The code warns about this.
- Every response is marked as not cacheable, so each visit downloads the browser module again (about 2.4 MB, 0.6 MB compressed). Plan transfer for that.

## 7. Being listed on app.clewbook.xyz

The project runs one public set of pages. Its home page lists campaigns from a file the project edits by hand, so **a campaign can only appear there with the project's approval for now**. There is no submission form. A link to a campaign on those pages can work without being listed: the pages take the campaign and its relay from the link, provided your relay is on https. We have not tested this with a relay run by someone else. A contact route for listing requests has not been set up yet, and we do not invent one here.

## 8. Mainnet

Testnet campaigns have no restriction. For mainnet, the host program refuses to create a campaign that could still be open when the next Zcash network upgrade (NU7) activates. The upgrade already runs on testnet. The mainnet update of the libraries follows the upgrade and has not been done. Until you give the program the mainnet activation height (`--nu7-mainnet-height`), a campaign must end at least a week before 5 November 2026, the date announced for the upgrade (we have not confirmed it ourselves). Creating a mainnet campaign also needs an explicit confirmation (a tick box on the set up page, or `--confirm-mainnet`). After the upgrade, mainnet hosting waits for a library update. Real money runs so far were two small ones, described in `docs/EVIDENCE.md` section 8.

## 9. Honest cautions

- **Keys are plain files on the host's machine today.** The campaign's signing and memo keys are in `secrets.json` in the campaign folder (readable only by its owner, but not protected by a passphrase). The wallet's seed phrase file is locked with a key file that sits in the same folder, so it adds no protection against someone who can read the folder.
- **There has been no outside review of the code or of the design.** The tests and evidence in this repository are ours.
- **The host machine must stay online** from before the first contribution until the campaign is closed and refunds are confirmed. If it is off, new payments get no ticket, and the recount flags it.
- **The campaign folder is the key.** Back it up before taking any money, keep the backup private, and never share the folder. There is no key import.
- A payment that arrives after the deadline is not counted and is not refunded automatically. See the README section on late payments.
- The relay holds no secrets, but it is a public service: everything on it is public data.
