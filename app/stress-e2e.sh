#!/usr/bin/env bash
# Stress test on testnet: N contributions (default 40) from P payer wallets (default 5) paying at the same time to one campaign, with the
# host's watcher issuing a refund ticket for each. Reports the recount's R4 (every contribution has a ticket within K blocks), the slowest
# ticket (blocks and seconds) and the whole timeline. Play money only. From the repository root; funds the payers from the `bidder` wallet.
# Usage: N=40 P=5 app/stress-e2e.sh        Output: runs/stress/ (logs, timings.txt)
set -uo pipefail
N=${N:-40}; P=${P:-5}; AMOUNT=${AMOUNT:-100000}; M=$(( (N + P - 1) / P ))
ZD=./target/release/zcash-devtool; BIN=./app/target/release; D=runs/stress
R1=http://127.0.0.1:8787; R2=http://127.0.0.1:8788
rm -rf $D; mkdir -p $D; LOG=$D/timeline.txt
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $LOG; }
T0=$(date +%s)
say "stress test: $N contributions of $AMOUNT zat from $P payer wallets ($M each)"

# --- the campaign, with a timestamped watcher ---
NOWATCH=1 RUN=$D/campaign RELAY1=$R1 RELAY2=$R2 timeout 300 ./app/web/start-test-campaign.sh 50000000 600 > $D/start.log 2>&1 || { cat $D/start.log; exit 1; }
RUN=$D/campaign; ID=$(cat $RUN/rules_id); PT=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['pay_to'])")
K=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['ticket_k'])")
(nohup setsid bash -c "$BIN/ll-host watch --run $RUN --interval 10 2>&1 | while IFS= read -r l; do echo \"\$(date +%s) \$l\"; done" > $D/watch.log 2>&1 &)
say "campaign $ID, ticket window K = $K blocks"

# --- payer wallets, funded from bidder ---
for i in $(seq 1 $P); do
  for n in 1 2 3 4 5 6; do rm -rf $D/pay$i $D/pay$i.age
    timeout 45 $ZD wallet -w $D/pay$i init --name pay$i -i $D/pay$i.age -n test >/dev/null 2>&1 && break; say "payer $i: init attempt $n stalled"; done
  [ -d $D/pay$i ] || { say "could not create payer $i"; exit 1; }
  addr=$($ZD wallet -w $D/pay$i list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3)
  echo "$addr" > $D/pay$i.addr
done
FUND=$(( M * (AMOUNT + 20000) + 200000 ))
for i in $(seq 1 $P); do
  for t in $(seq 1 10); do
    timeout 300 $ZD wallet -w bidder sync >/dev/null 2>&1
    TX=$(echo y | timeout 120 $ZD wallet -w bidder send -i bidder.age --address "$(cat $D/pay$i.addr)" --value $FUND --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$' | head -1)
    [ -n "$TX" ] && break; sleep 15; done
  [ -n "$TX" ] || { say "could not fund payer $i"; exit 1; }
  say "payer $i funded with $FUND zat in $TX"
done
funded() { python3 - "$1/data.sqlite" <<'PY'
import sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
v = 0
for t in ("orchard", "ironwood", "sapling"):
    try: v += db.execute(f"select coalesce(sum(value),0) from {t}_received_notes where id not in (select {t}_received_note_id from {t}_received_note_spends)").fetchone()[0]
    except Exception: pass
sys.exit(0 if v > 0 else 1)
PY
}
for i in $(seq 1 $P); do for k in $(seq 1 60); do
  timeout 300 $ZD wallet -w $D/pay$i sync >/dev/null 2>&1
  funded $D/pay$i && break
  sleep 10; done; done
say "payers funded: starting the contributions, all payers at once"
T_PAY=$(date +%s)

# --- the contributions: every payer sends M in a row, all payers in parallel ---
payer() { # index
  local i=$1 w=$D/pay$1 RA; RA=$(cat $D/pay$i.addr)
  for j in $(seq 1 $M); do
    $BIN/ll-contrib keygen --out $D/p$i-$j.seed >/dev/null
    MEMO=$($BIN/ll-contrib memo --rules $RUN/rules.json --seed $D/p$i-$j.seed --refund-address "$RA" --amount-zat $AMOUNT)
    TX=""
    for t in $(seq 1 60); do
      timeout 300 $ZD wallet -w $w sync >/dev/null 2>&1
      TX=$(echo y | timeout 120 $ZD wallet -w $w send -i $w.age --address "$PT" --value $AMOUNT --memo "$MEMO" --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$' | head -1)
      [ -n "$TX" ] && break; sleep 10
    done
    echo "$(date +%s) $i $j ${TX:-FAILED}" >> $D/sent.log
  done
}
for i in $(seq 1 $P); do payer $i & done
wait
T_SENT=$(date +%s); say "all payments sent ($(grep -vc FAILED $D/sent.log) of $N) in $((T_SENT - T_PAY)) s"

# --- wait for the tickets ---
GOT=0
for k in $(seq 1 $((N * 6 + 60))); do
  GOT=$(ls $RUN/ledger 2>/dev/null | wc -l); [ "$GOT" -ge "$(grep -vc FAILED $D/sent.log)" ] && break; sleep 10
done
T_DONE=$(date +%s); say "$GOT ledger entries after $((T_DONE - T_PAY)) s from the first payment"

# --- timings ---
python3 - $D $RUN $K > $D/timings.txt <<'PY'
import glob, json, sys, re, statistics
D, RUN, K = sys.argv[1], sys.argv[2], int(sys.argv[3])
sent = {}
for l in open(f"{D}/sent.log"):
    t, i, j, tx = l.split()
    if tx != "FAILED": sent[tx] = int(t)
issued = {}
for l in open(f"{D}/watch.log"):
    m = re.match(r"(\d+) ticket issued: entry \d+ for ([0-9a-f]{64}):\d+", l)
    if m: issued[m.group(2)] = int(m.group(1))
entries = [json.load(open(f)) for f in sorted(glob.glob(f"{RUN}/ledger/*.json"))]
blocks = []
for e in entries:
    if e["kind"] == "issue": blocks.append((e["ticket"]["issue_height"] - e["contribution"]["height"], e["contribution"]["txid"]))
e2e = sorted(((issued[tx] - sent[tx]), tx) for tx in sent if tx in issued)
order = sorted(issued.values())
gaps = [b - a for a, b in zip(order, order[1:])]
print(f"contributions sent: {len(sent)}; tickets issued: {len(issued)}; ledger entries: {len(entries)}")
if blocks:
    print(f"ticket delay in blocks (issue height - contribution height): max {max(b for b, _ in blocks)}, median {statistics.median(b for b, _ in blocks)}, window K = {K}; over the window: {sum(1 for b, _ in blocks if b > K)}")
if e2e: print(f"seconds from sending the payment to its ticket: slowest {e2e[-1][0]} (tx {e2e[-1][1][:12]}), median {int(statistics.median(x for x, _ in e2e))}, fastest {e2e[0][0]}")
if gaps: print(f"seconds between one ticket and the next (the host works one at a time): slowest {max(gaps)}, median {int(statistics.median(gaps))}, fastest {min(gaps)}")
PY
cat $D/timings.txt | tee -a $LOG

# --- the public recount ---
UFVK=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['campaign_ufvk'])"); START=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['start_height'])")
$ZD wallet -w $D/viewer init-fvk --name viewer --fvk "$UFVK" --birthday $((START - 2)) >/dev/null 2>&1
timeout 900 $ZD wallet -w $D/viewer sync >/dev/null 2>&1; timeout 900 $ZD wallet -w $D/viewer enhance >/dev/null 2>&1
$BIN/ll-recount --rules-id $ID --relay $R1 --relay $R2 --wallet $D/viewer > $D/recount.txt 2>&1; REXIT=$?
grep -E "ledger read|R[0-9]+ (PASS|FAIL)|RESULT" $D/recount.txt | tee -a $LOG
say "recount exit $REXIT; total time $(( $(date +%s) - T0 )) s"
pkill -f "ll-host watch --run $RUN" 2>/dev/null
exit $REXIT
