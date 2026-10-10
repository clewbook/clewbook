# Running things on this machine (internal, never published)

Everything is started, stopped and checked with one helper, run from the project folder (`cd` into it first):

    ./run.sh status                  what is running, on which port, and which campaign folders nobody is watching
    ./run.sh start <name>            start one program (nothing happens if it already runs)
    ./run.sh stop <name> --yes       stop one (the real ones need --yes; without it nothing happens)
    ./run.sh restart <name> --yes    stop, then start
    ./run.sh command <name>          show the exact command line behind a name
    ./run.sh logs <name>             where its log is, and its last lines
    ./run.sh names                   the names

`./run.sh start watcher <campaign folder>` starts a watcher for one campaign folder. The names `practice-relay`, `practice-page` and `practice-dashboard` are a sandbox on other ports: start and stop them freely to learn how this works.

## The programs, and the order

| Name | Port | What it is | Real money? |
|---|---|---|---|
| `tunnel-page`, `tunnel-mainnet`, `tunnel-demo` | 8770, 8790, 8789 | free public addresses (random, they change when a tunnel is restarted) | the addresses are in links people hold |
| `pageserver` | 8770 | the web pages | no |
| `relay-mainnet` | 8790 | serves the real campaigns' public list | yes |
| `relay-testnet-1`, `relay-testnet-2`, `relay-demo` | 8787, 8788, 8789 | test relays | no |
| `dashboard` | 8780 | the host dashboard, real network. It also WATCHES every campaign folder in `runs/mainnet-pilot-dash`: without it running, nobody gets a ticket. Local only: never tunnel it. | yes |

Start in this order: tunnels, page server, relays, dashboard (the dashboard reads the two tunnel addresses from `runs/pilot-tunnels/*.url`). Stop in the reverse order. Do not restart a tunnel unless you must: it gets a NEW address and every link that holds the old one stops working.

Real campaigns are also watched by plain watchers (`./run.sh start watcher <folder>`) when they are not inside the dashboard's folder. A campaign folder with no program watching it is listed by `./run.sh status` as NOT WATCHED.

## Where things are

* Logs: `runs/logs/<name>.log` for anything started with `./run.sh`. The dashboard that was started by hand writes to `runs/mainnet-pilot/dashboard.log`. Tunnel logs: `runs/pilot-tunnels/*.log`. A campaign's own log: `<campaign folder>/watch.log` when one exists.
* Campaign folders: `runs/mainnet-pilot-dash/campaign-*`, `runs/mainnet-pilot`, `runs/mainnet-smoke`, and the testnet ones under `runs/`. **Never share, commit or upload these**: they hold the wallet (`wallet*`, `*.age`), `secrets.json` and `private/`. Back them up, privately and off this machine, as whole folders.
* Relay folders: `runs/mainnet-pilot-relay`, `runs/page/relay1`, `runs/page/relay2`, `runs/pilot-relay-demo`. Public data only, but nothing in `runs/` is committed anyway.
* Never committed or published: `runs/` (everything), `.local/` (the private list of names), `docs/RUNNING.md`, `docs/DEPLOY_VERCEL.md`, and the other internal documents listed in `docs/PUBLISH_HISTORY.md`.

## The dashboard says "has not checked the network for N minutes"

It means the program that watches the campaign has stopped looking (stuck, or the network server did not answer). While that lasts, new payments get no tickets. What to do:

1. `./run.sh status`: look at "last network check ... s ago" for the campaign, and at the line for `dashboard`. The warning in the dashboard itself also prints the exact command and the process number.
2. Restart: `./run.sh restart dashboard --yes`. (By hand: stop the process, then run the command shown by `./run.sh command dashboard`, from the project folder.)
3. Confirm it works again: wait one minute, run `./run.sh status`: the campaign must say "last network check" under about 60 s (not "FAILED"), and the dashboard page (http://127.0.0.1:8780, reload it) must show a few seconds in "Last network check" and no red warning. `./run.sh logs dashboard` should show new "tip ..." lines.
4. If it is still stuck: read the last lines of the log. "relay ... unreachable" lines mean a public address is dead (see below), which slows every pass but is not the same as a stopped watcher.

## The permanent address, the saved copy and "host last seen" (stage D)
* **Permanent address:** `docs/STABLE_ADDRESS.md`. Once `runs/stable-address.conf` exists, `./run.sh` reads the page and relay addresses from it, `tunnel-stable` runs the tunnel, and `./run.sh status` shows an ADDRESSES block that says "NOT ANSWERING" for an address that is dead even while its tunnel program is up.
* **Saved copy of a campaign's public list:** on the dashboard, "Download a public copy of the list" (or `./app/target/release/cb-host export --run <campaign folder> --out <file>`). Keep one with every real campaign. The recount page loads it when no relay answers.
* **"Host last seen":** every check the running host sends each relay a small signed record. Nothing to do; if the contributor page says the host was not seen lately, the host program is stopped or cannot reach the relay: `./run.sh status`.
* A page that cannot load its own files now says so after 20 seconds and offers Reload.

## An address changed (a tunnel was restarted, or you moved to a new address)

Each campaign folder remembers the relay address it publishes to (`private/relays`). It is not part of the campaign: it is not in the signed rules and not in the campaign id, so changing it never changes the campaign. The host reads the file on every check (about every 15 seconds), so **changing it needs no restart** for that campaign.

1. Find out what is stored and what answers: `./run.sh status` (the dashboard warns too: "is not reachable" or "differs from the relay the dashboard runs with", and prints the command below ready to copy).
2. Look first: `./run.sh set-relay <new relay address> <campaign folder>`. It shows what is stored, what it would become, checks that the new address answers (it refuses one that does not), and changes nothing.
3. Apply: the same command with `--yes`. Only a stored address that no longer answers is replaced (the others stay); add `--replace <old address>` to swap one exact address. A copy of the old file is kept next to it (`private/relays.before-<time>`). `--all` does this for every open real-network campaign and nothing else: test campaigns are skipped (name one explicitly to change it), so a real-network address is never written into a test campaign by accident. `--add` adds an address and keeps the others even if they answer.
4. Confirm: within a minute the dashboard warnings go away and `./run.sh status` shows a fresh "last network check".
5. What still needs a restart: only the dashboard's own `--relay` and `--page-base` (they decide the address given to NEW campaigns and the links the dashboard shows). Restart it after the tunnel addresses are right: `./run.sh restart dashboard --yes`.
6. Links already handed out keep the old address inside them. Hand out new links from the dashboard.

Tested: `app/set-relay-test.sh` (19 checks, including that a running host publishes to the new address by itself) and `app/relay-warning-test.sh` (6 checks).

## Known problem: a free tunnel can die while the program still runs

Seen on 2026-10-09: the tunnel program was running but its log said "Unauthorized: Tunnel not found", and its address no longer opened. `./run.sh status` cannot tell, because the process is alive: test the address (`curl -s -o /dev/null -w "%{http_code}\n" <address>/` gives 000 when dead), or read `runs/pilot-tunnels/*-tunnel.log`. Fix: `./run.sh restart tunnel-mainnet --yes` (or `tunnel-page`). The NEW address is printed and saved; then `./run.sh restart dashboard --yes` so the dashboard hands out the new address, and re-share any link that held the old one. For anything lasting, use a small always-on server instead of free tunnels (see docs/POLISH_NEXT.md, hosting guide).

Tested: `app/run-sh-test.sh` (start, stop and restart on the sandbox programs and on a watcher for a testnet folder, the refusals without `--yes`, and that every command shown is the one the live program was started with). Not tested, on purpose: restarting the real programs.
