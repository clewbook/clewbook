#!/usr/bin/env bash
# What close does with a payment that has no refund ticket (the watcher was not running when it arrived), on the testnet, with a real host program.
#   missed   fundraiser, goal not reached: the payment must be refunded
#   met      fundraiser, goal reached: the payment must be swept to the treasury
#   auction  uniform-price auction, 1 item, two bids, both unticketed: the winner is settled, the loser refunded
#   many-missed  fundraiser, goal not reached, five payments: two ticketed on time (one watcher pass), then three sent one after another with
#                no watcher: all five must be refunded
#   many-met     the same mix, goal reached: all five must be swept
# Usage: app/e2e-unticketed.sh <missed|met|auction|many-missed|many-met> [new|before]      (from the repository root; plays with testnet money from the `bidder` wallet)
#   new     the host program as built now (close first issues the missing tickets, late)
#   before  the host program as it was before this change (app/target-before; see docs/RUNNING.md): shows what close used to do
# Nothing is published to a relay and no watcher runs at any point before the close: that is the point. Output: runs/unticketed-<scenario>-<which>/
set -uo pipefail
S=${1:?usage: e2e-unticketed.sh missed|met|auction [new|before]}; WHICH=${2:-new}
ZD=./target/release/zcash-devtool; NEWBIN=./app/target/release
[ "$WHICH" = before ] && HOSTBIN=./app/target-before/release || HOSTBIN=$NEWBIN
D=runs/unticketed-$S-$WHICH; RUN=$D/campaign; rm -rf $D; mkdir -p $RUN; LOG=$D/e2e.log; DL=${DEADLINE_IN:-30}
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $LOG; }
die() { say "STOP: $*"; exit 1; }
addr() { $ZD wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
tip() { timeout 300 $ZD wallet -w bidder sync 2>&1 | grep -o 'ChainTip([0-9]*\.\.[0-9]*)' | tail -1 | sed -E 's/.*\.\.([0-9]+)\)/\1/'; }
mkwallet() { for n in 1 2 3 4 5; do rm -rf "$1" "$1.age"; timeout 45 $ZD wallet -w "$1" init --name campaign -i "$1.age" -n test >/dev/null 2>&1 && return 0; done; return 1; }
mkwallet $RUN/wallet1 || die "no campaign wallet"
BIDDER=$(addr bidder); TREAS=$BIDDER
case $S in
  missed) ARGS="--goal-zat 5000000"; BIDS="1000000";;
  met) ARGS="--goal-zat 1000000"; BIDS="1500000";;
  many-missed) ARGS="--goal-zat 5000000"; BIDS="100000 100000 100000 100000 100000"; TICKETED=2;;
  many-met) ARGS="--goal-zat 300000"; BIDS="100000 100000 100000 100000 100000"; TICKETED=2;;
  auction)
    mkwallet $D/treasury || die "no treasury wallet"; TREAS=$(addr $D/treasury)
    TUFVK=$(python3 -c "import sqlite3;db=sqlite3.connect('file:$D/treasury/data.sqlite?mode=ro',uri=True);print(db.execute('select ufvk from accounts').fetchone()[0])")
    ARGS="--mode auction --items 1 --reserve-zat 50000 --min-contribution-zat 20000 --treasury-address $TREAS --treasury-ufvk $TUFVK"; BIDS="300000 100000";;
esac
timeout 300 $HOSTBIN/ll-host create --run $RUN --wallet $RUN/wallet1 --identity $RUN/wallet1.age $ARGS --deadline-in $DL > $D/create.log 2>&1 || { cat $D/create.log; die "create failed"; }
ID=$(cat $RUN/rules_id); DEAD=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['deadline_height'])"); PT=$(cat $RUN/address)
say "scenario $S, host program: $WHICH; campaign ${ID:0:8}, deadline block $DEAD"
i=0
for amt in $BIDS; do
  i=$((i+1)); $NEWBIN/ll-contrib keygen --out $RUN/c$i.seed >/dev/null
  MEMO=$($NEWBIN/ll-contrib memo --rules $RUN/rules.json --seed $RUN/c$i.seed --refund-address "$BIDDER" $([ "$S" != auction ] && echo "--amount-zat $amt"))
  TX=""
  for t in $(seq 1 20); do
    timeout 300 $ZD wallet -w bidder sync >/dev/null 2>&1
    TX=$(echo y | timeout 120 $ZD wallet -w bidder send -i bidder.age --address "$PT" --value $amt --memo "$MEMO" --min-confirmations 1 2>&1 | grep -oE '^[0-9a-f]{64}$' | head -1)
    [ -n "$TX" ] && break; sleep 20
  done
  [ -n "$TX" ] || die "payment $i failed"
  echo $TX > $RUN/c$i.txid; say "payment $i: $amt zat paid ($TX), no watcher is running"
  if [ "$i" = "${TICKETED:-0}" ]; then # these first payments get their tickets on time: one watcher pass at a time, then none again
    for k in $(seq 1 40); do timeout 200 $HOSTBIN/ll-host watch --run $RUN --once > $D/watch-once.log 2>&1; [ "$(ls $RUN/ledger 2>/dev/null | wc -l)" -ge $i ] && break; sleep 20; done
    say "the first $i payment(s) are ticketed on time ($(ls $RUN/ledger 2>/dev/null | wc -l) entries); the rest are sent with no watcher"
  fi
done
say "waiting for the deadline (block $DEAD)"
until [ "$(tip || echo 0)" -ge "$((DEAD + 2))" ]; do sleep 30; done
say "deadline passed. Ledger entries before close: $(ls $RUN/ledger 2>/dev/null | wc -l) (${TICKETED:-0} ticketed on time)"
timeout 900 $HOSTBIN/ll-host close --run $RUN --sweep-to "$TREAS" > $D/close.log 2>&1; CLOSE_RC=$?
say "close exit code $CLOSE_RC"; cut -c1-220 $D/close.log | sed 's/^/   /' | tee -a $LOG
say "ledger after close:"; for f in $(ls $RUN/ledger); do python3 -c "import json;e=json.load(open('$RUN/ledger/$f'));print('   ',e['seq'],e['kind'],(e.get('ticket') or {}).get('issue_height',''),(e.get('close') or {}).get('outcome',''))"; done | tee -a $LOG
# follow the transactions the close sent until they are mined (the new program may keep watching; the old one is not asked to, so that it cannot add anything after the close)
TARGET=$(( $(tip) + 4 ))
until [ "$(tip || echo 0)" -ge "$TARGET" ]; do
  [ "$WHICH" = new ] && [ "$CLOSE_RC" = 0 ] && timeout 200 $HOSTBIN/ll-host watch --run $RUN --once 2>&1 | grep -E "outbox:|released|ALERT" | sed 's/^/   /' | tee -a $LOG
  sleep 25
done
KEY=$(python3 - <<PY
import json,os
r=json.load(open('$RUN/rules.json'))
k=r.get('campaign_ufvk')
if not k:
    for f in sorted(os.listdir('$RUN/ledger')):
        e=json.load(open('$RUN/ledger/'+f))
        if e['kind']=='close': k=e['close']['ufvk']
print(k or '')
PY
)
if [ -n "$KEY" ]; then
  $ZD wallet -w $RUN/viewer init-fvk --name viewer --fvk "$KEY" --birthday $(( $(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['start_height'])") - 2 )) >/dev/null 2>&1
  $ZD wallet -w $RUN/viewer sync >/dev/null 2>&1; $ZD wallet -w $RUN/viewer enhance >/dev/null 2>&1
  $NEWBIN/ll-recount --rules $RUN/rules.json --rules-id $ID --ledger $RUN/ledger --wallet $RUN/viewer > $D/recount.txt 2>&1
  say "recount:"; sed 's/^/   /' $D/recount.txt | tee -a $LOG
fi
echo "$CLOSE_RC" > $D/close.rc
# the same recount in the browser, from the host's saved copy: it also sees a uniform auction's treasury (R9 to R12)
$HOSTBIN/ll-host export --run $RUN --out $D/export.json >/dev/null 2>&1 && { say "browser recount:"; LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-} node app/web/recount-file.cjs $D/export.json 2>&1 | tee -a $LOG; }
# where the money is: unspent notes of the campaign wallet (after one more sync, so that spends mined just now are seen)
timeout 300 $ZD wallet -w $RUN/wallet1 sync >/dev/null 2>&1
python3 - <<PY | tee -a $LOG
import sqlite3
c=sqlite3.connect("file:$RUN/wallet1/data.sqlite?mode=ro",uri=True)
rows=c.execute("""select n.value,(select count(*) from ironwood_received_note_spends s where s.ironwood_received_note_id=n.id) from ironwood_received_notes n where n.value>0""").fetchall()
left=[v for v,sp in rows if not sp]
print("   campaign wallet: %d note(s) still unspent, %d zat in total %s" % (len(left), sum(left), left))
PY
case $S in many-*)
  python3 - "$RUN" "$S" "${TICKETED:-0}" <<'PY' | tee -a $LOG
import json, os, sqlite3, sys
run, s, ticketed = sys.argv[1], sys.argv[2], int(sys.argv[3])
es = [json.load(open(os.path.join(run, "ledger", f))) for f in sorted(os.listdir(os.path.join(run, "ledger")))]
issues = [e for e in es if e["kind"] == "issue"]; close = [e for e in es if e["kind"] == "close"]
late = [e for e in issues if e["ticket"]["issue_height"] > e["contribution"]["height"] + json.load(open(os.path.join(run, "rules.json")))["ticket_k"]]
c = sqlite3.connect(f"file:{run}/wallet1/data.sqlite?mode=ro", uri=True)
rows = c.execute("select n.value,(select count(*) from ironwood_received_note_spends s where s.ironwood_received_note_id=n.id) from ironwood_received_notes n where n.value>0").fetchall()
left = [v for v, sp in rows if not sp]
want = "goal_missed" if s == "many-missed" else "goal_met"
ok = len(issues) == 5 and len(close) == 1 and close[0]["close"]["outcome"] == want
print(("PASS" if ok else "FAIL") + f"  five contributions, each with a ticket entry ({ticketed} on time, {len(issues) - ticketed} written by the close), one close entry ({want})")
print(("PASS" if not left else "FAIL") + f"  no contribution is left in the campaign wallet ({'all refunded' if s == 'many-missed' else 'all swept'}); unspent: {left}")
rc = open(os.path.join(os.path.dirname(run), "recount.txt")).read() if os.path.exists(os.path.join(os.path.dirname(run), "recount.txt")) else ""
import re
fails = re.findall(r"^  (R\d+) FAIL", rc, re.M)
named = re.findall(r"^\s+- ([0-9a-f]{64}:\d+) ticketed at", rc, re.M)
ok = rc and fails == (["R4"] if late else []) and len(named) == len(late)
print(("PASS" if ok else "FAIL") + f"  the recount from the chain passes every check, except that R4 names exactly the tickets issued more than K blocks after their payment ({len(late)} such; fails: {fails}, named: {len(named)})")
PY
;; esac
say "done"
