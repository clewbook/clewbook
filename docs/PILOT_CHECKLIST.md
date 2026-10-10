# One real phone wallet, smallest amount: pilot checklist (draft)

Status: **draft. The current version has not been run on the real network; a first run of an earlier version was made on 2026-10-06 (docs/EVIDENCE.md section 8).** Nothing is spent until the owner says so. Spending cap for the whole pilot: 0.01 ZEC.
Expected cost: 0.0003 ZEC leaves the phone wallet at once (the contribution of 0.0002 ZEC, the smallest the rules allow because it is twice the 0.0001 ticket fee, plus the wallet's own network fee of about 0.0001). The refund (by the host at close, or by the contributor with the ticket) brings back 0.0001 (the contribution minus the 0.0001 ticket fee, which is taken from the contribution). Final cost about 0.0002 ZEC. The host wallet needs no funding. The cap of 0.01 ZEC is about 30 times that.

## Before anything (once)
1. NU7: the mainnet activation height is announced for 2026-10-20 (the upgrade for 2026-11-05). Until the height is given with `--nu7-mainnet-height`, the host refuses any campaign that could still be running within 7 days of 5 November (it must be over before 29 October). With the height: the whole life of the campaign must end well before it. Plan the pilot to finish within a day.
2. Check the build: `app/audit.sh` clean; the test-cheats build is **not** the one in use (`app/target/release/cb-host`, not `app/target-cheat`).
3. Wallet and campaign folder: create the host wallet for the real network (`zcash-devtool wallet -w <dir>/wallet init --name pilot -i <dir>/wallet.age -n main`). **Back up the whole campaign folder** (wallet, `wallet.age`, `secrets.json`, `rules.json`) to a second place **before the link is shared**, and again after the campaign is closed. These files are secrets: never commit or upload them (`runs/` is ignored by git).
4. Keep the computer awake and online until the campaign is closed and refunds are confirmed (no sleep, no lid close).

## Create the campaign (smallest amounts, short deadline)
```
./app/target/release/cb-host create --run runs/mainnet-pilot --wallet runs/mainnet-pilot/wallet --identity runs/mainnet-pilot/wallet.age \
  --network main --mode raise --goal-zat 100000 --deadline-in 200 --min-contribution-zat 20000 --ticket-k 30 \
  --relay <relay address(es), see HTTPS below> --confirm-mainnet [--nu7-mainnet-height <H>]
```
Then run the watcher (`cb-host watch --run runs/mainnet-pilot`) or the dashboard (`cb-host serve --network main --server https://zjs.zec.rocks/mainnet --page-base <page address>`; it shows the MAINNET banner and asks for confirmation before closing). 200 blocks is about 4 hours at 75 seconds a block.

## HTTPS for the phone (free, no account)
The phone's browser needs `https://` pages (the recount page's report hash and the copy buttons need a secure page; a plain `http://192.168...` address will not do), and the page must reach a relay over `https://` too.
- Run the page server (`python3 app/web/serve.py 8770`) and one relay (`cb-relay serve --dir runs/pilot-relay --listen 127.0.0.1:8787`).
- Open two free tunnels, e.g. `cloudflared tunnel --url http://127.0.0.1:8770` and `cloudflared tunnel --url http://127.0.0.1:8787` (each prints a random `https://….trycloudflare.com` address; they change every time you start them). Download `cloudflared` from its official release page first (unverified: its availability and terms are for you to check).
- Give the second address to `--relay` and the first to `--page-base`. Never tunnel the dashboard (port 8780).
- Test the link from the phone on mobile data before paying anything.

## The pilot (one phone wallet)
1. Open the contributor link on the phone; enter 0.0002 ZEC and the wallet's own refund address; save the backup file.
2. Pay by scanning the QR code (try "simpler code" if the camera cannot read it). The wallet must show address, amount 0.0002 and the memo; do not change the amount.
3. Wait for "Contribution received" and the refund ticket (a minute or two after one block). Note the transaction id for the evidence log.

## Afterwards: did it work?
- The page lists the ticket checks with no red notice (ticket checks L1 and L2 pass; L3 only if you press "Check the proof too").
- Recount page (laptop): "All checks pass", checked against two servers (it will say the servers may share hosting). Run it on the phone too: the two report hashes should be equal at the same chain height.
- Capability card shows network "Main network (real money)", the ticket window 30 and the smallest contribution 0.00020000 ZEC.
- Optional second pass (another 0.0001 ZEC fee): close after the deadline from the dashboard, or press "Refund me" on the phone, and check the refund arrives in the wallet.

## What could fail with a real wallet (the 2026-10-06 run tried an earlier version with one phone wallet; the rest is untried)
- **Shielded address:** the campaign pays to a standard `u1…` unified address with two receivers: an Orchard-type receiver, which on the main network since NU6.3 is paid into the Ironwood pool (the 2026-10-06 run's tickets were Ironwood transactions mined on the main network), and a Sapling receiver. A wallet that picks the Sapling receiver would pay a pool the campaign's tickets cannot spend from (what the host does then is untested). One phone wallet used the right one in the earlier run. A wallet that does not know that receiver may refuse the address, ignore it, or choose another pool. **Unverified** which phone wallets can pay it (and whether the pool is called that in their screens); test with the smallest amount.
- **Memo size:** the payment code memo is 267 characters (the limit is 512 bytes). A wallet that truncates, drops or rewrites the memo makes the payment a donation that cannot be refunded.
- **The 562-character QR code:** very dense (version 16). Some cameras and wallet scanners fail; the "simpler code" is 490 characters (shorter, same message). Copying the address and memo by hand is the last resort.
- **Amount:** a wallet that lets you lower the amount, or rounds it, can make the payment smaller than the code promises (it is then set aside as a donation). Paying twice with one code is not refunded either.
- **Confirmations:** wallets show a payment as sent before it is mined; the page waits for it on the chain (a minute or two at 75 seconds a block).
- **The tunnel:** addresses change when a tunnel restarts; a restart breaks every link already shared.
- **NU7:** if the upgrade activates while tickets are outstanding they must be re-issued (the host's watcher does this while it is running); this is why the pilot must finish early.

## Restoring a host's campaign folder from a backup (tested on a testnet copy)

What to back up: the whole campaign folder (it holds the wallet, the wallet's key file `wallet*.age`, `secrets.json` with the ledger signing key and the payload key, `rules.json`, `ledger/`, `tickets/`, `private/`). Back it up after creating the campaign and again after the first contributions; the folder changes as tickets are issued. Keep the copy private and off the machine.

Steps (run from the repository folder, with the campaign not running anywhere else; two copies of one host signing at the same time would fork the ledger):
1. Stop the old program for that campaign if it is still alive (check `private/host.lock`).
2. Copy the backup folder to where the campaign should live.
3. Delete `private/host.lock` in the copy if present.
4. Open `config.json` in the copy. Campaigns created from now on store `wallet` and `identity` as names inside the folder, so a copy just works. Older folders store paths from the folder the program was started in: a copy of one of those is now refused ("outside this campaign folder", or "does not exist" when the old folder is gone) instead of silently using the old wallet. Change `wallet` and `identity` to the names inside the copy (for example `wallet1` and `wallet1.age`).
5. Run `cb-host watch --run <copy> --once` and read the last line: it should list the same number of ledger entries, 0 new, 0 guard alerts. Then start the watcher (or the dashboard) as usual.

Tested on a testnet copy: restored from a backup, config edited, `watch --once` agreed with the original (same ledger), a new payment made afterwards got a ticket from the restored host as entry 1, `cb-contrib open-ticket` opened it against the restored ledger (signature and chain good), and `cb-contrib broadcast` of that ticket was accepted by the network. Not tested: restoring a mainnet folder, restoring from a backup older than the last ledger entry (the host would not know about entries it already published; the relays still hold them, so the folder's own `ledger/` would need to be rebuilt from a relay first: not written, not tested), and restoring on another operating system.

Upgrading note (stage B): programs built before the wallet-path fix read `wallet` and `identity` in `config.json` relative to the folder they were started in, so they cannot start a campaign created by the new build (which stores names such as `wallet1`). Programs built before the campaign-name field cannot reproduce the id of a named campaign (a relay refuses it; the contributor tool writes a payment code the host sets aside as a donation: seen in a test, 0.02 TAZ lost). After upgrading, rebuild every program together: the host (also the `test-cheats` build used by some tests), the relay, the contributor tool, the recount tool and the browser module, and restart the relays before creating a named campaign. Running processes keep working; the live joke auction's dashboard and the two mainnet relays were not restarted.
