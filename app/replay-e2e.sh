#!/usr/bin/env bash
# Replayed payload on testnet: the same sealed memo paid twice. Expect: one ticket, one reject ("replayed payload"), and a recount that
# passes and says so plainly. From the repository root; uses the `bidder` wallet.
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=./app/target/release
D=runs/replay-test
for p in $(ps -eo pid,args | awk -v r="$D/campaign" '$3=="watch" && $5==r {print $1}'); do kill $p 2>/dev/null; done
rm -rf $D; mkdir -p $D
NOWATCH=1 RUN=$D/campaign RELAY1=http://127.0.0.1:8787 RELAY2=http://127.0.0.1:8788 timeout 300 ./app/web/start-test-campaign.sh 5000000 400 > $D/start.log 2>&1 || { cat $D/start.log; exit 1; }
RUN=$D/campaign
RA=$($ZD wallet -w bidder list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3)
$BIN/ll-contrib keygen --out $D/seed >/dev/null
M=$($BIN/ll-contrib memo --rules $RUN/rules.json --seed $D/seed --refund-address $RA --amount-zat 200000)
PT=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['pay_to'])")
pay() { # amount
  for i in 1 2 3 4 5 6; do
    timeout 300 $ZD wallet -w bidder sync >/dev/null 2>&1
    TX=$(echo y | timeout 120 $ZD wallet -w bidder send -i bidder.age --address "$PT" --value $1 --memo "$M" --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$' | head -1); [ -n "$TX" ] && { echo $TX; return; }; sleep 20
  done; return 1
}
T1=$(pay 300000) || { echo "first payment failed"; exit 1; }; echo "first payment  $T1"
for i in $(seq 1 40); do timeout 150 $BIN/ll-host watch --run $RUN --once >/dev/null 2>&1; [ "$(ls $RUN/ledger | wc -l)" -ge 1 ] && break; sleep 10; done
T2=$(pay 200000) || { echo "second payment failed"; exit 1; }; echo "second payment $T2 (same memo)"
for i in $(seq 1 40); do timeout 150 $BIN/ll-host watch --run $RUN --once >/dev/null 2>&1; [ "$(ls $RUN/ledger | wc -l)" -ge 2 ] && break; sleep 10; done
# a third payment: a wallet that lowered the amount (the message promises 400000, 100000 are paid): not a contribution
$BIN/ll-contrib keygen --out $D/seed3 >/dev/null
M=$($BIN/ll-contrib memo --rules $RUN/rules.json --seed $D/seed3 --refund-address $RA --amount-zat 400000)
T3=$(pay 100000) || { echo "third payment failed"; exit 1; }; echo "third payment  $T3 (pays 100000, its message promises 400000)"
for i in $(seq 1 40); do timeout 150 $BIN/ll-host watch --run $RUN --once >/dev/null 2>&1; [ "$(ls $RUN/ledger | wc -l)" -ge 3 ] && break; sleep 10; done
python3 - "$RUN" "$T1" "$T2" "$T3" <<'PY'
import json, glob, sys
run, t1, t2, t3 = sys.argv[1:5]
es = [json.load(open(f)) for f in sorted(glob.glob(f"{run}/ledger/*.json"))]
for e in es: print("entry", e["seq"], e["kind"], e["contribution"]["txid"][:12], e.get("reason", ""))
ok = len(es) == 3 and es[2]["kind"] == "reject" and es[2]["contribution"]["txid"] == t3 and "underpaid" in es[2]["reason"] and es[0]["kind"] == "issue" and es[0]["contribution"]["txid"] == t1 and es[1]["kind"] == "reject" and es[1]["contribution"]["txid"] == t2 and "replayed payload" in es[1]["reason"]
print("PASS" if ok else "FAIL", "one ticket for the first payment, a 'replayed payload' reject for the second, an 'underpaid' reject for the third")
sys.exit(0 if ok else 1)
PY
RC=$?
START=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['start_height'])"); KEY=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['campaign_ufvk'])")
$ZD wallet -w $D/viewer init-fvk --name viewer --fvk "$KEY" --birthday $((START - 2)) >/dev/null 2>&1
$ZD wallet -w $D/viewer sync >/dev/null 2>&1; $ZD wallet -w $D/viewer enhance >/dev/null 2>&1
$BIN/ll-recount --rules $RUN/rules.json --rules-id "$(cat $RUN/rules_id)" --ledger $RUN/ledger --wallet $D/viewer | tee $D/recount.txt | grep -E "RESULT|WARNING|Non-refundable"
grep -q "RESULT: PASS" $D/recount.txt && grep -q "repeated the sealed message of an earlier payment" $D/recount.txt && echo "PASS recount passes and warns plainly about the replay" || { echo "FAIL recount"; RC=1; }
exit $RC
