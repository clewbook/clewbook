#!/usr/bin/env bash
# Junk tickets from a cheating host, checked by the contribute page in a real browser (testnet).
# Modes: good (an honest ticket; the page must pass it and say what it did not check); badsig (a broken spend signature with the
# right id); wrongversion (the honest ticket, but the server claims another network version; the page must refuse it).
# mismatch (the opening states the wrong amount); oldformat (a ticket sealed in the version 1 format, before level 2); payshost (the refund pays
# the host's own address). With the good ticket the browser also tries: spent (the page believes the coin was spent by something else) and
# othercoin (the signed list names another coin than the one the ticket spends).
# Needs the cheating build (app/target-cheat, see app/drop-e2e.sh). From the repository root; uses the `bidder` wallet.
# Usage: app/web/junk-ticket.sh [mode ...]   (default: badsig)
set -uo pipefail
MODES=${*:-"badsig good mismatch oldformat payshost badproof"}
ZD=./target/release/zcash-devtool; BIN=./app/target/release; CHEAT=./app/target-cheat/release/ll-host
RELAY1=http://127.0.0.1:8787; RELAY2=http://127.0.0.1:8788
D=runs/junk-ticket
for p in $(ps -eo pid,args | awk -v r="$D/campaign" '$3=="watch" && $5==r {print $1}'); do kill $p 2>/dev/null; done
rm -rf $D; mkdir -p $D
NOWATCH=1 RUN=$D/campaign RELAY1=$RELAY1 RELAY2=$RELAY2 timeout 300 ./app/web/start-test-campaign.sh 5000000 400 > $D/start.log 2>&1 || { cat $D/start.log; exit 1; }
RUN=$D/campaign; ID=$(cat $RUN/rules_id)
RA=$($ZD wallet -w bidder list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3)
PT=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['pay_to'])")
ARGS=()
for mode in $MODES; do
  KEY=$mode
  $BIN/ll-contrib keygen --out $D/$mode.seed >/dev/null
  M=$($BIN/ll-contrib memo --rules $RUN/rules.json --seed $D/$mode.seed --refund-address $RA)
  TX=""
  for i in 1 2 3 4 5 6; do
    timeout 300 $ZD wallet -w bidder sync >/dev/null 2>&1
    TX=$(echo y | timeout 120 $ZD wallet -w bidder send -i bidder.age --address "$PT" --value 300000 --memo "$M" --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$' | head -1); [ -n "$TX" ] && break; sleep 20
  done
  [ -n "$TX" ] || { echo "payment failed"; exit 1; }
  echo "$mode: payment $TX"
  N=$(ls $RUN/ledger 2>/dev/null | wc -l)
  for i in $(seq 1 60); do
    LL_TEST_JUNK_TICKET=$mode timeout 150 $CHEAT watch --run $RUN --once 2>&1 | grep -E "ticket issued|FAKE" | head -3
    [ "$(ls $RUN/ledger 2>/dev/null | wc -l)" -gt "$N" ] && break; sleep 10
  done
  python3 - "$RUN" "$D" "$ID" "$TX" "$RA" "$M" "$mode" <<'PY'
import json, sys, glob
run, d, rid, tx, ra, memo, mode = sys.argv[1:8]
e = [json.load(open(f)) for f in sorted(glob.glob(f"{run}/ledger/*.json")) if json.load(open(f)).get("contribution", {}).get("txid") == tx][0]
assert e["kind"] == "issue", e
json.dump({"kind": "contribution-backup", "version": 1, "campaign": rid, "relays": ["http://127.0.0.1:8787", "http://127.0.0.1:8788"],
  "server": "https://zjs.zec.rocks/testnet", "seed": open(f"{d}/{mode}.seed").read().strip(), "refundAddress": ra, "amountZat": 300000, "memo": memo,
  "payment": f"{tx}:{e['contribution']['action']}", "ticket": None}, open(f"{d}/backup-{mode}.json", "w"))
PY
  ARGS+=("$mode=$D/backup-$mode.json")
  [ "$mode" = good ] && ARGS+=("wrongversion=$D/backup-good.json" "spent=$D/backup-good.json" "othercoin=$D/backup-good.json" "proof=$D/backup-good.json" "cancel=$D/backup-good.json")
done
LINK="${PAGE_BASE:-http://127.0.0.1:8770}/contribute.html#c=$ID&relay=$RELAY1&relay=$RELAY2&server=https://zjs.zec.rocks/testnet" SHOTS=runs/page/shots \
  timeout 1200 node app/web/junk-ticket-e2e.cjs "${ARGS[@]}"
