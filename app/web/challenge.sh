#!/usr/bin/env bash
# The "Publish proof that my payment was valid" button (testnet, real browser). Three rejected payments on one campaign:
#   U  underpaid: the message promises 400000, 100000 are paid: the reject is right; publishing proof must not change the outcome
#   R  replayed (a copier who paid someone else's message, so holds no secret for it): the reject is right; publishing proof must not change the outcome
#   O  the owner of that message, who paid it twice: holds a ticket from the first payment, so no proof button is offered and nothing is published
#   W  wrongful: a cheating host (test-cheats build) rejects a valid payment: publishing proof makes the recount FAIL (by design)
# Nothing may be published by itself. From the repository root; uses the `bidder` wallet; needs the cheating build.
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=./app/target/release; CHEAT=./app/target-cheat/release/ll-host
R1=http://127.0.0.1:8787; R2=http://127.0.0.1:8788
D=runs/challenge
for p in $(ps -eo pid,args | awk -v r="$D/campaign" '$3=="watch" && $5==r {print $1}'); do kill $p 2>/dev/null; done
rm -rf $D; mkdir -p $D
NOWATCH=1 RUN=$D/campaign RELAY1=$R1 RELAY2=$R2 timeout 300 ./app/web/start-test-campaign.sh 5000000 400 > $D/start.log 2>&1 || { cat $D/start.log; exit 1; }
RUN=$D/campaign; ID=$(cat $RUN/rules_id)
RA=$($ZD wallet -w bidder list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3)
PT=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['pay_to'])")
memo() { $BIN/ll-contrib keygen --out $D/$1.seed >/dev/null; $BIN/ll-contrib memo --rules $RUN/rules.json --seed $D/$1.seed --refund-address $RA --amount-zat $2; }
mined() { python3 - "$1" <<'PY'
import sqlite3, sys
db = sqlite3.connect("file:bidder/data.sqlite?mode=ro", uri=True)
r = db.execute("select mined_height from transactions where txid=?", (bytes.fromhex(sys.argv[1])[::-1],)).fetchone()
print(r[0] if r and r[0] else "")
PY
}
pay() { # amount memo -> txid once mined (a payment the public server drops is sent again)
  local TX k t
  for t in 1 2 3 4; do
    for i in $(seq 1 12); do
      timeout 300 $ZD wallet -w bidder sync >/dev/null 2>&1
      TX=$(echo y | timeout 120 $ZD wallet -w bidder send -i bidder.age --address "$PT" --value $1 --memo "$2" --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$' | head -1); [ -n "$TX" ] && break; sleep 20
    done
    [ -n "$TX" ] || return 1
    for k in $(seq 1 30); do timeout 300 $ZD wallet -w bidder sync >/dev/null 2>&1; [ -n "$(mined $TX)" ] && { echo $TX; return 0; }; sleep 10; done
    echo "   payment $TX never mined, sending again" >&2; sleep 60
  done; return 1
}
# W first: reject it (cheating host) before the honest host can ticket it
MW=$(memo W 200000); TW=$(pay 300000 "$MW") || exit 1; echo "W payment $TW"
for i in $(seq 1 60); do
  for a in 0 1 2; do $CHEAT force-reject --run $RUN --contribution $TW:$a >/dev/null 2>&1 && { FR=1; break 2; }; done; sleep 10
done
[ -n "${FR:-}" ] || { echo "could not force-reject W"; exit 1; }
MU=$(memo U 400000); TU=$(pay 100000 "$MU") || exit 1; echo "U payment $TU (pays 100000, promises 400000)"
MR=$(memo R 200000); $BIN/ll-contrib keygen --out $D/C.seed >/dev/null; TR1=$(pay 300000 "$MR") || exit 1; echo "R payment 1 $TR1"; TR2=$(pay 250000 "$MR") || exit 1; echo "R payment 2 $TR2 (same message)"
for i in $(seq 1 60); do timeout 150 $BIN/ll-host watch --run $RUN --once >/dev/null 2>&1; [ "$(ls $RUN/ledger | wc -l)" -ge 4 ] && break; sleep 10; done
python3 - "$RUN" "$D" "$ID" "$RA" "$TW" "$TU" "$TR2" "$MW" "$MU" "$MR" <<'PY'
import json, glob, sys
run, d, rid, ra, tw, tu, tr2, mw, mu, mr = sys.argv[1:11]
es = [json.load(open(f)) for f in sorted(glob.glob(f"{run}/ledger/*.json"))]
for e in es: print("entry", e["seq"], e["kind"], e["contribution"]["txid"][:10], e.get("reason", "")[:70])
def act(tx): return [e["contribution"]["action"] for e in es if e["contribution"]["txid"] == tx][0]
for name, tx, memo, amt, sd in (("U", tu, mu, 400000, "U"), ("R", tr2, mr, 200000, "C"), ("O", tr2, mr, 200000, "R"), ("W", tw, mw, 200000, "W")):
    json.dump({"kind": "contribution-backup", "version": 1, "campaign": rid, "relays": ["http://127.0.0.1:8787", "http://127.0.0.1:8788"],
      "server": "https://zjs.zec.rocks/testnet", "seed": open(f"{d}/{sd}.seed").read().strip(), "refundAddress": ra, "amountZat": amt, "memo": memo,
      "payment": f"{tx}:{act(tx)}", "ticket": None}, open(f"{d}/backup-{name}.json", "w"))
PY
LINK="${PAGE_BASE:-http://127.0.0.1:8770}/contribute.html#c=$ID&relay=$R1&relay=$R2&server=https://zjs.zec.rocks/testnet" RECOUNT="${PAGE_BASE:-http://127.0.0.1:8770}/recount.html#c=$ID&relay=$R1&relay=$R2" \
  RUN=$RUN CID=$ID TX_U=$TU TX_R=$TR2 TX_W=$TW BACKUP_DIR=$D SHOTS=runs/page/shots timeout 1500 node app/web/challenge-e2e.cjs
