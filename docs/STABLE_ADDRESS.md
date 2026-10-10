# A permanent address instead of the free tunnels (internal, never published)

**Recommendation: a Cloudflare named tunnel with a domain of your own.** Why this one and not Tailscale Funnel:
* The two names (`app.clewbook.xyz` for the pages, `relay.clewbook.xyz` for the relay) are yours. They do not change when you restart anything, and they keep working if you later move the programs to a rented server: you only point the names somewhere else, and every link already handed out keeps working.
* It uses the same program you already run for the free tunnels (`cloudflared`), so `./run.sh` runs it the same way.
* Tailscale Funnel (plan B, below) is free and also stable, but the name belongs to your computer (`<computer>.<something>.ts.net`), the second service has to sit on a different port number, and its limits are not guaranteed. Fine as a stopgap.

**What it costs:** a domain, about **10 to 15 per year** (price from memory, check at purchase). The Cloudflare account and the tunnel are free. Total for the first year: the domain, nothing else.

**What this does not fix:** your computer, the page server, the relay and the program must be running. The tunnel only gives them a permanent address. For something that survives your computer being off, you need a small rented server (see `docs/DESIGN_NOTES.md`, 3A).

## What I need from you (everything else is built)
1. The **domain**: `clewbook.xyz`, as you named it. I have not checked whether it is registered; if it is not yet yours, it must be bought and added to Cloudflare first (I cannot buy it for you).
2. A **Cloudflare account** (free).
3. Your decision on the **two names** (suggestion: `app` and `relay` in front of the domain) and a **tunnel name** (suggestion: `clewbook`).
4. Say when you are ready, because step 8 changes what your real campaigns publish to: do it when no one is about to pay.

## Steps (nothing here has been run: I have no account or domain; each step says how to tell it worked)
1. **Sign up** at cloudflare.com with your email and confirm the email they send. Worked when: you see the Cloudflare dashboard.
2. **Buy the domain** inside Cloudflare: Domain Registration, Register Domains, search the name, pay. Cloudflare then manages its names automatically. Worked when: the domain is listed under Websites and its status says Active. (If you already own a domain elsewhere, use "Add a site" and change its name servers as Cloudflare tells you; it can take hours.)
3. **Log this computer in to Cloudflare:** `~/.local/bin/cloudflared tunnel login`. A browser page opens: pick your domain and press Authorize. Worked when: the terminal says a certificate was saved to `~/.cloudflared/cert.pem`. (That file is a secret: never share it.)
4. **Create the tunnel:** `~/.local/bin/cloudflared tunnel create clewbook`. It prints the tunnel's id and saves `~/.cloudflared/<id>.json`, the tunnel's key. **That file is a secret too: never share, commit or upload it, and back it up privately.**
5. **Point the two names at the tunnel:**
   `~/.local/bin/cloudflared tunnel route dns clewbook app.clewbook.xyz`
   `~/.local/bin/cloudflared tunnel route dns clewbook relay.clewbook.xyz`
   Worked when: each says it added a CNAME record.
6. **Write the one file all the addresses are read from:** `runs/stable-address.conf` (create it with any text editor), exactly:
   ```
   PAGE_URL=https://app.clewbook.xyz
   RELAY_URL=https://relay.clewbook.xyz
   TUNNEL_NAME=clewbook
   ```
   From now on `./run.sh` takes the dashboard's `--relay` and `--page-base` from this file instead of from the free tunnels.
7. **Make the tunnel's configuration:** `./run.sh stable-config > ~/.cloudflared/config.yml`, then look at it (`cat ~/.cloudflared/config.yml`): it must name your tunnel, your key file, `app...` going to port 8770 and `relay...` going to port 8790. Check it: `~/.local/bin/cloudflared tunnel ingress validate` says "OK".
8. **Test it before anything real depends on it.** Make sure the page server and the real-network relay are running (`./run.sh status`). Then `./run.sh start tunnel-stable`: it says "is up" with both addresses. Then:
   * `curl -s -o /dev/null -w "%{http_code}\n" https://app.clewbook.xyz/` prints `200`.
   * `curl -s https://relay.clewbook.xyz/v1/campaigns/0` prints a short error saying the campaign id must be 64 hex characters (that is the relay answering).
   * `./run.sh status` shows both addresses under ADDRESSES as "answers".
   * Open `https://app.clewbook.xyz/` on your phone, on mobile data (not your home wifi). The first load may be slow, later ones fast.
9. **Switch the real campaigns over** (only now):
   * `./run.sh set-relay https://relay.clewbook.xyz --all` (a look), then the same with `--yes`. It replaces only stored addresses that are dead (the old free tunnels') and says nothing needs restarting for the campaigns.
   * `./run.sh restart dashboard --yes`, so the dashboard hands out the new addresses (its command now reads them from the file).
   * In the dashboard, open each campaign and copy its new contribute link. Check it opens on your phone.
10. **Retire the free tunnels** when you are happy: `./run.sh stop tunnel-page --yes`, `./run.sh stop tunnel-mainnet --yes`, `./run.sh stop tunnel-demo --yes`.

**To go back:** delete `runs/stable-address.conf`; `./run.sh` then reads the free tunnels' addresses again (start them with `./run.sh start tunnel-page` and `tunnel-mainnet`, they get new random addresses, then repeat `set-relay` with the new relay address).

## What happens to links already handed out on the free tunnels
* A link whose page address is a free tunnel address (`….trycloudflare.com`) **stays dead for good**: those names are gone and will not come back. Anyone holding one needs a new link. The campaign is the same (same campaign id, nothing on the chain changes).
* A link that has the free relay address inside it (`&relay=https://….trycloudflare.com`) cannot read the campaign even when it is opened on the new page address: the page shows "can't reach the campaign's servers". Hand out the new link from the dashboard.
* A contributor who already paid keeps what they hold: their backup file works with the new link ("I have a backup file" on the new page), and a refund ticket that is already saved in their browser still works if they open the new link in the same browser. A closed campaign's recount works from the new link; the public list is the same.
* The recount and the ticket checks do not depend on the address: addresses are not in the signed rules.

## Plan B: Tailscale Funnel (free, no domain)
Sign up at tailscale.com and install Tailscale on this computer (`tailscale up`), enable HTTPS and Funnel for the tailnet in its admin page, then `tailscale funnel --bg 8770` gives the page a permanent `https://<computer>.<tailnet>.ts.net` address, and `tailscale funnel --https=8443 --bg 8790` gives the relay the same name with `:8443` on the end (Funnel allows only ports 443, 8443 and 10000). Put those two addresses in `runs/stable-address.conf` as `PAGE_URL` and `RELAY_URL` and skip steps 3 to 7 and the `tunnel-stable` program; the other steps are the same. Not tested here, and Tailscale's limits for Funnel are not guaranteed.

## Tested, and not
Tested without any account (`app/stable-address-test.sh`, 15 checks, with a stand-in for the tunnel program): the file the addresses are read from, the dashboard command that uses it, the printed configuration, start, stop and restart, the refusals, and the status line that says an address is NOT ANSWERING while its program is up. **Not tested: that a real named tunnel connects and carries traffic**, that the exact words Cloudflare prints in steps 3 to 5 match what is written here, the price, and the Tailscale route.
