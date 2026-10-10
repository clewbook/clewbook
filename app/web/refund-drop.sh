#!/usr/bin/env bash
# Sets up a real testnet campaign with one contribution and a ticket, then runs refund-drop-e2e.cjs against it, then checks
# on the chain that the coin was spent exactly once, by the ticket. From the repository root; uses the `bidder` wallet.
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=./app/target/release
RELAY1=http://127.0.0.1:8787; RELAY2=http://127.0.0.1:8788
D=runs/refund-drop
# a watcher left over from an earlier run would keep using the old campaign's keys on the new one (and wrongly reject its payment)
for p in $(ps -eo pid,args | awk -v r="$D/campaign" '$3=="watch" && $5==r {print $1}'); do kill $p 2>/dev/null; done
rm -rf $D; mkdir -p $D
RUN=$D/campaign RELAY1=$RELAY1 RELAY2=$RELAY2 timeout 300 ./app/web/start-test-campaign.sh 5000000 400 > $D/start.log 2>&1 || { cat $D/start.log; exit 1; }
RUN=$(cat runs/page/latest); ID=$(cat $RUN/rules_id)
$BIN/ll-contrib keygen --out $D/seed >/dev/null
RA=$($ZD wallet -w bidder list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3)
M=$($BIN/ll-contrib memo --rules $RUN/rules.json --seed $D/seed --refund-address $RA)
PT=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['pay_to'])")
TX=""
for i in 1 2 3 4 5 6; do
  timeout 300 $ZD wallet -w bidder sync >/dev/null 2>&1
  TX=$(echo y | timeout 120 $ZD wallet -w bidder send -i bidder.age --address "$PT" --value 500000 --memo "$M" --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$' | head -1); [ -n "$TX" ] && break; sleep 20
done
[ -n "$TX" ] || { echo "payment failed"; exit 1; }
echo "payment $TX"
for i in $(seq 1 60); do [ "$(ls $RUN/ledger 2>/dev/null | wc -l)" -ge 1 ] && break; sleep 10; done
[ "$(ls $RUN/ledger | wc -l)" -ge 1 ] || { echo "no ticket issued"; exit 1; }
python3 - "$RUN" "$D" "$ID" "$TX" "$RA" "$M" <<'PY'
import json, sys, glob
run, d, rid, tx, ra, memo = sys.argv[1:7]
e = json.load(open(sorted(glob.glob(f"{run}/ledger/*.json"))[0]))
json.dump({"kind": "contribution-backup", "version": 1, "campaign": rid, "relays": ["http://127.0.0.1:8787", "http://127.0.0.1:8788"],
  "server": "https://zjs.zec.rocks/testnet", "seed": open(f"{d}/seed").read().strip(), "refundAddress": ra, "amountZat": 500000, "memo": memo,
  "payment": f"{tx}:{e['contribution']['action']}", "ticket": None}, open(f"{d}/backup.json", "w"))
PY
LINK="${PAGE_BASE:-http://127.0.0.1:8770}/contribute.html#c=$ID&relay=$RELAY1&relay=$RELAY2&server=https://zjs.zec.rocks/testnet" BACKUP=$D/backup.json SHOTS=runs/page/shots timeout 2400 node app/web/refund-drop-e2e.cjs
RC=$?
echo "chain check: the coin must be spent exactly once, by the ticket"
sleep 30   # the campaign's own watcher (started with the campaign) syncs its wallet every few seconds; a second ll-host would be refused
python3 - "$RUN" <<'PY'
import json, sqlite3, sys, glob
run = sys.argv[1]
import os
w = json.load(open(f"{run}/config.json"))["wallet"]
if not os.path.isabs(w) and os.path.isdir(os.path.join(run, w)):
    w = os.path.join(run, w)  # stored as a name inside the campaign folder
e = json.load(open(sorted(glob.glob(f"{run}/ledger/*.json"))[0]))
nf, ticket = e["contribution"]["nf"], e["ticket"]["txid"]
db = sqlite3.connect(f"file:{w}/data.sqlite?mode=ro", uri=True)
rows = db.execute("""select hex(st.txid), st.mined_height from ironwood_received_notes n join ironwood_received_note_spends s on s.ironwood_received_note_id = n.id
  join transactions st on st.id_tx = s.transaction_id where hex(n.nf) = ?""", (nf.upper(),)).fetchall()
spenders = {bytes.fromhex(r[0])[::-1].hex() for r in rows}
print(("PASS" if spenders == {ticket} else "FAIL"), "coin spent exactly once, by the ticket", ticket[:12], "mined at", [r[1] for r in rows])
sys.exit(0 if spenders == {ticket} else 1)
PY
exit $(( RC + $? ))
