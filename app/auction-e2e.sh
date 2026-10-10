#!/usr/bin/env bash
# Uniform-price auction on testnet, end to end (trial). Honest host by default; DIVERT=1 makes the host send the
# excess somewhere else (a fake cheating host). Everything is play money; keys stay in git-ignored runs/.
# DIVERT=1 closes with the cheating build (`cd app && CARGO_TARGET_DIR=target-cheat cargo build --release -p ll-host --features test-cheats`).
# CRASH=1 stops the close dead right after the first settlement is sent and before its entry is written (the same test-only build,
# LL_TEST_CRASH_AFTER_SETTLE_SEND), then runs the close again with the ordinary build: every winner must end with exactly one settle entry and
# exactly one settlement transaction.
# WITHDRAW=A|B|C: that bidder sends their own ticket well before the deadline (a withdrawal); the close then works with the bids left.
# At the end the campaign is recounted in the browser from the host's saved copy (it sees the treasury, so R9 to R12 are judged).
# Usage: DIVERT=0|1 CRASH=0|1 WITHDRAW=<tag> NAME=auction-demo app/auction-e2e.sh      (run from the repository root)
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=${BIN:-./app/target/release}
NAME=${NAME:-auction-demo}; D=runs/$NAME; DIVERT=${DIVERT:-0}; CRASH=${CRASH:-0}
R1=http://127.0.0.1:8787; R2=http://127.0.0.1:8788
mkdir -p $D; LOG=$D/e2e.log
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $LOG; }
die() { say "STOP: $*"; exit 1; }

mkwallet() { # name
  for n in 1 2 3 4 5 6; do
    rm -rf $D/$1 $D/$1.age
    if timeout 45 $ZD wallet -w $D/$1 init --name $1 -i $D/$1.age -n test >/dev/null 2>&1; then return 0; fi
    say "wallet $1: init attempt $n stalled, retrying"
  done; return 1
}
addr() { $ZD wallet -w $D/$1 list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
dbval() { python3 -c "import sqlite3,sys;db=sqlite3.connect('file:$D/$1/data.sqlite?mode=ro',uri=True);print(db.execute('select $2 from accounts').fetchone()[0])"; }

for w in host treasury wa wb wc; do [ -d $D/$w ] || mkwallet $w || die "could not create wallet $w"; done
say "wallets ready"
TREAS=$(addr treasury); TUFVK=$(dbval treasury ufvk)
[ -n "$TREAS" ] && [ -n "$TUFVK" ] || die "no treasury address or key"
if [ ! -f $D/campaign/rules.json ]; then
  # the campaign's wallet and key file must live inside its folder
  mkdir -p $D/campaign && rm -rf $D/campaign/host $D/campaign/host.age && cp -a $D/host $D/campaign/host && cp $D/host.age $D/campaign/host.age
  timeout 300 $BIN/ll-host create --run $D/campaign --wallet $D/campaign/host --identity $D/campaign/host.age --mode auction --items 2 \
    --reserve-zat 50000 --min-contribution-zat 20000 --deadline-in ${DEADLINE:-45} --relay $R1 --relay $R2 \
    --treasury-address "$TREAS" --treasury-ufvk "$TUFVK" > $D/create.log 2>&1 || { cat $D/create.log; die "create failed"; }
fi
RUN=$D/campaign; ID=$(cat $RUN/rules_id)
PT=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['pay_to'])")
DEAD=$(python3 -c "import json;print(json.load(open('$RUN/rules.json'))['deadline_height'])")
say "campaign $ID deadline $DEAD pay_to ${PT:0:12}.. treasury ${TREAS:0:12}.."

watch1() { timeout 150 $BIN/ll-host watch --run $RUN --once > $D/watch-once.log 2>&1; }
entries() { ls $RUN/ledger 2>/dev/null | wc -l; }
i=0
for spec in "wa 300000 A" "wb 200000 B" "wc 100000 C"; do
  set -- $spec; w=$1; amt=$2; tag=$3; i=$((i+1))
  if [ ! -f $D/$tag.paid ]; then
    $BIN/ll-contrib keygen --out $D/$tag.seed >/dev/null
    RA=$(addr $w); echo $RA > $D/$tag.refund
    M=$($BIN/ll-contrib memo --rules $RUN/rules.json --seed $D/$tag.seed --refund-address $RA)
    TX=""
    for try in 1 2 3 4 5 6 7 8; do
      timeout 300 $ZD wallet -w bidder sync >/dev/null 2>&1
      TX=$(echo y | timeout 120 $ZD wallet -w bidder send -i bidder.age --address "$PT" --value $amt --memo "$M" --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$' | head -1)
      [ -n "$TX" ] && break
      say "bid $tag: send attempt $try failed, retrying"; sleep 20
    done
    [ -n "$TX" ] || die "could not pay bid $tag"
    echo $TX > $D/$tag.paid; say "bid $tag: $amt zat paid in $TX"
  fi
  for k in $(seq 1 30); do watch1; [ "$(entries)" -ge $i ] && break; sleep 15; done
  [ "$(entries)" -ge $i ] || die "ticket for bid $tag not issued"
  say "bid $tag: ticket issued ($(entries) entries)"
done

if [ -n "${WITHDRAW:-}" ]; then
  WTX=$(cat $D/$WITHDRAW.paid)
  WACT=$(python3 -c "import json,os;d='$RUN/ledger';print([json.load(open(os.path.join(d,f)))['contribution']['action'] for f in sorted(os.listdir(d)) if (json.load(open(os.path.join(d,f))).get('contribution') or {}).get('txid')=='$WTX'][0])")
  $BIN/ll-contrib open-ticket --seed $D/$WITHDRAW.seed --ledger $RUN/ledger --tickets $RUN/tickets --contribution "$WTX:$WACT" --out $D/$WITHDRAW.ticket.hex > $D/withdraw.log 2>&1
  $BIN/ll-contrib broadcast --raw $D/$WITHDRAW.ticket.hex >> $D/withdraw.log 2>&1; say "bid $WITHDRAW withdraws before the deadline: $(tail -1 $D/withdraw.log | cut -c1-120)"
  for k in $(seq 1 40); do watch1; grep -q "lock released: $WTX" $D/watch-once.log && break; sleep 20; done
  grep -q "lock released: $WTX" $D/watch-once.log && say "PASS  the withdrawal is mined before the deadline: $(grep "lock released: $WTX" $D/watch-once.log | cut -c1-200)" || say "FAIL  the withdrawal was not seen mined"
fi
say "waiting for the deadline $DEAD"
for k in $(seq 1 200); do
  watch1; TIP=$(grep -o '^tip [0-9]*' $D/watch-once.log | tail -1 | cut -d' ' -f2)
  [ -n "$TIP" ] && [ "$TIP" -gt "$DEAD" ] && break; sleep 30
done
[ -n "${TIP:-}" ] && [ "$TIP" -gt "$DEAD" ] || die "deadline not reached"
say "deadline passed at tip $TIP: closing and settling"
if [ "$DIVERT" = 1 ]; then export LL_TEST_DIVERT_EXCESS_TO=$(addr wc); say "FAKE CHEATING HOST: the excess goes to another address"; fi
CLOSE_HOST=$BIN/ll-host; [ "$DIVERT" = 1 ] && CLOSE_HOST=./app/target-cheat/release/ll-host
if [ "$CRASH" = 1 ]; then
  LL_TEST_CRASH_AFTER_SETTLE_SEND=1 timeout 600 ./app/target-cheat/release/ll-host close --run $RUN --sweep-to "$TREAS" > $D/close-crash.log 2>&1; RC=$?
  say "close with a crash after the first settlement was sent: exit $RC"; cut -c1-200 $D/close-crash.log | tee -a $LOG
  SENT=$(python3 -c "import json;print(sum(1 for x in json.load(open('$RUN/private/outbox.json')) if x['kind']=='settle'))" 2>/dev/null || echo 0)
  ENT=$(python3 -c "import json,os;d='$RUN/ledger';print(sum(1 for f in os.listdir(d) if json.load(open(os.path.join(d,f)))['kind']=='settle'))")
  [ $RC = 3 ] && [ "$SENT" = 1 ] && [ "$ENT" = 0 ] && say "PASS  crash state: one settlement recorded as sent, no settle entry yet" || { say "FAIL  crash state: exit $RC, $SENT sent, $ENT entries"; CRASHFAIL=1; }
fi
timeout 600 $CLOSE_HOST close --run $RUN --sweep-to "$TREAS" > $D/close.log 2>&1; say "close exit $?"; cut -c1-200 $D/close.log | tee -a $LOG
if [ "$CRASH" = 1 ]; then
  python3 - "$RUN" <<'PY' | tee -a $LOG
import json, os, sys
run = sys.argv[1]
rules = json.load(open(f"{run}/rules.json"))
entries = [json.load(open(os.path.join(f"{run}/ledger", f))) for f in sorted(os.listdir(f"{run}/ledger"))]
close = [e for e in entries if e["kind"] == "close"][0]["close"]
settles = [e["settle"] for e in entries if e["kind"] == "settle"]
ob = [x for x in json.load(open(f"{run}/private/outbox.json")) if x["kind"] == "settle"]
winners = close["winners"]
ok1 = sorted(s["nf"] for s in settles) == sorted(winners) and len(settles) == len(winners)
ok2 = len(ob) == len(winners) and all(x["status"] in ("sent", "resent", "confirmed") for x in ob) and sorted(x["txid"] for x in ob) == sorted(s["txid"] for s in settles)
print(("PASS" if ok1 else "FAIL") + f"  after the rerun every winner has exactly one settle entry ({len(settles)} for {len(winners)} winners)")
print(("PASS" if ok2 else "FAIL") + f"  ... and exactly one settlement transaction each, the ones the entries name ({len(ob)} sent)")
PY
fi
unset LL_TEST_DIVERT_EXCESS_TO
for k in $(seq 1 40); do watch1; grep -q "lock released" $D/watch-once.log && [ "$(grep -c 'lock released' $D/watch-once.log)" -ge 1 ] && break; sleep 20; done
say "settlement confirmations seen"
$BIN/ll-host export --run $RUN --out $D/export.json >/dev/null 2>&1 && { say "browser recount from the saved copy:"; PORT=${RECOUNT_PORT:-8810} node app/web/recount-file.cjs $D/export.json 2>&1 | tee -a $LOG; }
say "done"
echo "$ID" > $D/id
