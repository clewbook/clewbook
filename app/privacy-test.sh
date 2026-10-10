#!/usr/bin/env bash
# Privacy leak test on finished testnet campaigns that are already in the local relays (see app/privacy-e2e.cjs). From the repository root.
# Subjects: a finished uniform-price auction (runs/auction-final2), a finished fundraiser (the newest runs/dash-regress campaign) and the
# 40-contribution stress campaign (runs/stress). For each it makes a view-only wallet from the campaign's PUBLIC viewing key (what any
# observer can do), then runs the scan. Needs the relays and the page server running; writes runs/privacy/report.json.
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=./app/target/release; P=runs/privacy
mkdir -p $P
R1=http://127.0.0.1:8787; R2=http://127.0.0.1:8788
python3 - "$P" <<'PY'
import glob, json, os, subprocess, sys
P = sys.argv[1]
BIN = "./app/target/release"
def info(addr):
    out = subprocess.run([f"{BIN}/ll-contrib", "address-info", addr], capture_output=True, text=True).stdout
    strings, hexes = [addr], []
    for l in out.splitlines():
        k, _, v = l.partition(": ")
        if k in ("standard form", "orchard-only standard form"): strings.append(v.strip())
        if k in ("orchard/ironwood", "sapling"): hexes.append(v.strip())
    return strings, hexes
def seeds(d): return [open(f).read().strip() for f in glob.glob(f"{d}/**/*.seed", recursive=True) if len(open(f).read().strip()) == 64]
def forb(addrs, seed_dirs):
    a_s, a_h = [], []
    for a in addrs:
        s, h = info(a); a_s += s; a_h += h
    sd = [x for d in seed_dirs for x in seeds(d)]
    return [{"label": "contributor refund / payer addresses", "strings": a_s, "hex": a_h}, {"label": "contributor secrets (seeds)", "strings": sd, "hex": sd}]
bidder = subprocess.run(["./target/release/zcash-devtool", "wallet", "-w", "bidder", "list-addresses"], capture_output=True, text=True).stdout
bidder = [l.split()[2] for l in bidder.splitlines() if "Default Address" in l][0]
subs = []
# finished uniform-price auction: the refund addresses of its three bidders
d = "runs/auction-final2"
subs.append({"name": "uniform-price auction (finished)", "kind": "auction", "id": open(f"{d}/id").read().strip(), "dir": f"{d}/campaign",
             "forbidden": forb([open(f"{d}/{t}.refund").read().strip() for t in "ABC"] + [bidder], [d]), "viewer": f"{P}/viewer-auction"})
# finished fundraiser
dd = sorted(glob.glob("runs/dash-regress/runs/campaign-*"))[-1]
subs.append({"name": "fundraiser (finished, goal missed, refunded)", "kind": "raise", "id": open(f"{dd}/rules_id").read().strip(), "dir": dd,
             "forbidden": forb([bidder], [dd]), "viewer": f"{P}/viewer-fundraiser"})
# the stress campaign: 40 contributions, five different refund addresses
sd = "runs/stress"
subs.append({"name": "fundraiser (40 contributions, 5 refund addresses)", "kind": "raise", "id": open(f"{sd}/campaign/rules_id").read().strip(), "dir": f"{sd}/campaign",
             "forbidden": forb([open(f"{sd}/pay{i}.addr").read().strip() for i in range(1, 6)] + [bidder], [sd]), "viewer": f"{P}/viewer-stress"})
for s in subs:
    rules = json.load(open(f"{s['dir']}/rules.json"))
    ufvk = rules.get("campaign_ufvk")
    if not ufvk:  # an auction reveals its key in the close entry
        led = sorted(glob.glob(f"{s['dir']}/ledger/*.json"))
        ufvk = [json.load(open(f))["close"]["ufvk"] for f in led if json.load(open(f))["kind"] == "close"][0]
    s["ufvk"], s["start"] = ufvk, rules["start_height"]
    s["relays"] = ["http://127.0.0.1:8787", "http://127.0.0.1:8788"]
# the example data committed under examples/ (the same files a relay serves): scanned against every subject's list and the fixture's bidders
fx = "runs/auction-late-settlement"
subs_fx = forb([open(f"{fx}/{t}.refund").read().strip() for t in "ABC"], [fx])
json.dump({"examples": "examples/relay", "examples_forbidden": [f for s in subs for f in s["forbidden"]] + subs_fx, "www": os.environ.get("PRIVACY_WWW", "app/web/www"), "base": os.environ.get("PRIVACY_BASE", "http://127.0.0.1:8770"), "server": "https://zjs.zec.rocks/testnet", "subjects": subs}, open(f"{P}/config.json", "w"), indent=1)
PY
for v in auction fundraiser stress; do
  case $v in auction) i=0;; fundraiser) i=1;; stress) i=2;; esac
  UF=$(python3 -c "import json;print(json.load(open('$P/config.json'))['subjects'][$i]['ufvk'])"); ST=$(python3 -c "import json;print(json.load(open('$P/config.json'))['subjects'][$i]['start'])")
  rm -rf $P/viewer-$v; $ZD wallet -w $P/viewer-$v init-fvk --name viewer --fvk "$UF" --birthday $((ST - 2)) >/dev/null 2>&1
  timeout 1200 $ZD wallet -w $P/viewer-$v sync >/dev/null 2>&1; timeout 1200 $ZD wallet -w $P/viewer-$v enhance >/dev/null 2>&1
done
# the folder that would be uploaded to a static host (app/web/make-vercel.sh), when it has been built: scanned too
[ -d "${UPLOAD_DIR:-runs/vercel-site}" ] && export UPLOAD_DIR=${UPLOAD_DIR:-runs/vercel-site}
CONFIG=$P/config.json OUT=$P timeout 3000 node app/privacy-e2e.cjs
