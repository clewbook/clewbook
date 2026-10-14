#!/usr/bin/env bash
# The hard cap on the TEST network (play money only), one campaign per case, all running at the same time so the block waits overlap:
#   relay      a relay built before the cap existed refuses a capped campaign (it drops the field and computes another id); the current one
#              accepts it and keeps the field; an older campaign without a cap is accepted by both
#   below      below the soft cap at the deadline: everyone is refunded
#   between    between the soft and the hard cap: everything is kept
#   crossing   the payment that crosses the cap is refunded whole by its own ticket, the others are kept
#   large      a large payment that does not fit, then a smaller one that does: the large one is refunded, the smaller one kept
#   withdraw   a contributor takes their payment back after the cap was reached: a later payment over the cap moves into the kept set
#   early      an early close once the soft cap is met, with a payment over the cap: that payment is refunded at the close
#   cheat      a cheating host (test-cheats build) keeps the payment over the cap: the recount must fail R6, and only R6
# Payments come from PAYER (default bidder) and, for one case, PAYER2; kept money and refunds go back to PAYER, so little is used up.
# From the repository root. Env: BIN (default the review build), CHEAT (the test-cheats ll-host), OLD_RELAY (a relay built before the cap),
# PAYER, PAYER2, TOP (run folder), NEWP and OLDP (ports of the two local relays). Exit status 1 when a check fails.
set -uo pipefail
ZD=./target/release/zcash-devtool
BIN=${BIN:-./app/target/review/release}
CHEAT=${CHEAT:-./app/target/review-cheat/release/ll-host}
OLD_RELAY=${OLD_RELAY:-./app/target/release/cb-relay}
PAYER=${PAYER:-bidder}; PAYER2=${PAYER2:-runs/review-payer2}
TOP=${TOP:-runs/cap-e2e-$(date -u +%Y%m%dT%H%M%SZ)}
NEWP=${NEWP:-8852}; OLDP=${OLDP:-8851}
NEW=http://127.0.0.1:$NEWP; OLD=http://127.0.0.1:$OLDP
mkdir -p "$TOP"
failed=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  ${3:-}"; failed=$((failed+1)); fi; }
say() { echo; echo "== [$(date -u +%H:%M:%SZ)] $*"; }
note() { echo "   $*"; }
die() { say "STOP: $*"; exit 1; }
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
tip() { "$ZD" wallet -w "$PAYER" get-info 2>/dev/null | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2; }
rj() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]))' "$TOP/$1/rules.json" "$2"; }
mkwallet() {
  for n in 1 2 3 4 5 6; do
    case $1 in runs/?*) rm -rf -- "$1" "$1.age";; *) die "refusing to remove $1: not under runs/";; esac
    timeout 60 "$ZD" wallet -w "$1" init --name "$(basename "$1")" -i "$1.age" -n test >/dev/null 2>&1 && return 0
    note "wallet $(basename "$1"): init attempt $n stalled, retrying"
  done
  die "could not create wallet $1"
}

"$OLD_RELAY" serve --dir "$TOP/relay-old" --listen 127.0.0.1:$OLDP > "$TOP/relay-old.log" 2>&1 & R_OLD=$!
"$BIN/ll-relay" serve --dir "$TOP/relay-new" --listen 127.0.0.1:$NEWP > "$TOP/relay-new.log" 2>&1 & R_NEW=$!
trap 'kill $R_OLD $R_NEW 2>/dev/null' EXIT
for _ in $(seq 1 40); do curl -s -o /dev/null $OLD/v1/health && curl -s -o /dev/null $NEW/v1/health && break; sleep 0.3; done
REFUND=$(addr "$PAYER"); [ -n "$REFUND" ] || die "no address for $PAYER"

create() { # case goal cap [extra args]
  local c=$1 g=$2 cap=$3; shift 3
  mkdir -p "$TOP/$c"
  mkwallet "$TOP/$c/wallet"
  timeout 300 "$BIN/ll-host" create --run "$TOP/$c" --wallet "$TOP/$c/wallet" --identity "$TOP/$c/wallet.age" --goal-zat "$g" --cap-zat "$cap" \
    --deadline-in 90 --ticket-k 10 --relay $NEW "$@" > "$TOP/$c/create.log" 2>&1 || { cat "$TOP/$c/create.log"; die "create $c failed"; }
  note "$c: campaign $(cat "$TOP/$c/rules_id" | cut -c1-12)…, goal $g, cap $cap, deadline $(rj "$c" deadline_height)$(grep -q '^warning:' "$TOP/$c/create.log" && echo ', with the cap warning')"
}
watch() { "$BIN/ll-host" watch --run "$TOP/$1" --once > /dev/null 2>&1; }
watch_all() { local x; for x in $CASES; do watch "$x"; done; } # its own loop variable: a caller's local "c" must not change
pay() { # case tag value [payer]: a fresh payment code from ll-contrib (refund to PAYER), paid from the payer; the txid goes to <tag>.txid
  local c=$1 tag=$2 v=$3 p=${4:-$PAYER} txid="" m
  "$BIN/ll-contrib" keygen --out "$TOP/$c/$tag.seed" > /dev/null
  m=$("$BIN/ll-contrib" memo --rules "$TOP/$c/rules.json" --seed "$TOP/$c/$tag.seed" --refund-address "$REFUND")
  for _ in $(seq 1 30); do
    "$ZD" wallet -w "$p" sync > /dev/null 2>&1 || true
    txid=$(echo y | "$ZD" wallet -w "$p" send -i "$p.age" --address "$(cat "$TOP/$c/address")" --value "$v" --memo "$m" --min-confirmations 1 2>&1 | grep -oE '^[0-9a-f]{64}$' || true)
    [ -n "$txid" ] && { echo "$txid" > "$TOP/$c/$tag.txid"; note "$c/$tag: paid $v ($txid)"; return 0; }
    watch_all; sleep 15
  done
  die "payment $c/$tag failed"
}
entries() { ls "$TOP/$1/ledger" 2>/dev/null | wc -l; }
wait_entries() { for _ in $(seq 1 80); do [ "$(entries "$1")" -ge "$2" ] && return 0; watch_all; sleep 15; done; return 1; }
wait_height() { until [ "$(tip || echo 0)" -ge "$1" ]; do watch_all; sleep 15; done; }
contribution() { python3 - "$TOP/$1/ledger" "$2" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    c = json.load(open(os.path.join(sys.argv[1], f))).get("contribution")
    if c and c["txid"] == sys.argv[2]:
        print(f'{c["txid"]}:{c["action"]}'); break
PY
}
close_case() { # case [host binary]
  local c=$1 host=${2:-$BIN/ll-host} out
  for _ in $(seq 1 30); do
    out=$("$host" close --run "$TOP/$c" --sweep-to "$REFUND" 2>&1) && { echo "$out" | tail -4 | sed 's/^/   /'; return 0; }
    echo "$out" | grep -q "not reached" || { echo "$out" | tail -6 | sed 's/^/   /'; return 1; }
    watch_all; sleep 20
  done; return 1
}
settled() { # case: every transaction the close sent is mined
  python3 - "$TOP/$1/private/outbox.json" <<'PY'
import json, sys
try: items = json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
sys.exit(0 if items and all(i.get("mined_height") for i in items) else 1)
PY
}
recount() { "$BIN/ll-recount" --rules "$TOP/$1/rules.json" --rules-id "$(cat "$TOP/$1/rules_id")" --ledger "$TOP/$1/ledger" --wallet "$TOP/$1/wallet" 2>&1; }

say "Payers: $PAYER and $PAYER2. Run folder $TOP. Relays: new $NEW (this build), old $OLD (built before the cap)."
CASES="below between crossing large withdraw early cheat"
say "1. Seven capped fundraisers (deadline in 90 blocks, K 10), registered on the new local relay"
create below 300000 600000
create between 200000 600000
create crossing 200000 400000
create large 200000 400000
create withdraw 200000 300000
create early 200000 300000 --early-close
create cheat 150000 200000
grep -q '^warning: The hard cap is less than twice the soft cap' "$TOP/withdraw/create.log"; check "creating with a cap below twice the goal warns, and still creates" $? "$(cat "$TOP/withdraw/create.log" | tail -2)"
! grep -q '^warning:' "$TOP/crossing/create.log"; check "a cap of twice the goal gives no warning" $? ""

say "2. The relays"
ID=$(cat "$TOP/crossing/rules_id")
code=$(curl -s -o "$TOP/old-put.txt" -w '%{http_code}' -X PUT --data-binary @"$TOP/crossing/rules.json" $OLD/v1/campaigns/$ID)
[ "$code" != 200 ]; check "a relay built before the cap refuses a capped campaign (HTTP $code: $(head -c 120 "$TOP/old-put.txt"))" $? ""
curl -s $NEW/v1/campaigns/$ID | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r.get("cap_zat")==400000 else 1)'; check "the new relay holds it, with its cap, under the same id" $? ""
OLDRULES=$(ls runs/review-cli-doc/rules.json 2>/dev/null || ls runs/*/rules.json | head -1)
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary @"$OLDRULES" $OLD/v1/campaigns/$(cat "$(dirname "$OLDRULES")/rules_id"))
case $code in 200|201) true;; *) false;; esac; check "the old relay still accepts a campaign without a cap (HTTP $code)" $? ""

say "3. Payments (each case in its chain order)"
pay below b1 100000 "$PAYER2"
pay between b1 150000; pay between b2 150000
pay crossing c1 150000; pay crossing c2 150000; pay crossing c3 150000
pay large l1 150000; pay large l2 300000; pay large l3 200000
pay withdraw w1 150000; pay withdraw w2 150000; pay withdraw w3 150000
pay early e1 150000; pay early e2 150000; pay early e3 150000
pay cheat x1 150000; pay cheat x2 150000
say "4. Tickets for every payment"
for c in below:1 between:2 crossing:3 large:3 withdraw:3 early:3 cheat:2; do wait_entries "${c%:*}" "${c#*:}" || die "no tickets for ${c%:*}"; done
note "all tickets issued at $(tip)"
recount crossing > "$TOP/crossing/recount-open.txt"
grep -q "1 payment(s) over the cap so far" "$TOP/crossing/recount-open.txt"; check "before the close, the recount says one payment is over the cap so far" $? "$(grep -A3 ' R6 ' "$TOP/crossing/recount-open.txt")"

say "5. withdraw: the second contributor takes their payment back with their own ticket, before the deadline"
"$BIN/ll-contrib" open-ticket --seed "$TOP/withdraw/w2.seed" --ledger "$TOP/withdraw/ledger" --tickets "$TOP/withdraw/tickets" --contribution "$(contribution withdraw "$(cat "$TOP/withdraw/w2.txid")")" --out "$TOP/withdraw/w2.ticket.hex" 2>&1 | tail -2 | sed 's/^/   /'
"$BIN/ll-contrib" broadcast --raw "$TOP/withdraw/w2.ticket.hex" 2>&1 | tail -2 | sed 's/^/   /'

say "6. early: the host closes early (the soft cap is met), with one payment over the cap"
close_case early || note "early close did not finish yet"

say "7. The deadline, then the other closes (cheat: the test-cheats host keeps the payment over the cap)"
DL=$(for c in $CASES; do rj "$c" deadline_height; done | sort -n | tail -1)
wait_height $((DL + 1)); note "chain at $(tip)"
for c in below between crossing large withdraw; do note "close $c"; close_case "$c" || note "$c: close reported unfinished steps"; done
note "close cheat"; LL_TEST_KEEP_OVER_CAP=1 close_case cheat "$CHEAT" || note "cheat: close reported unfinished steps"

say "8. Wait until every close transaction is mined"
for _ in $(seq 1 80); do watch_all; ok=1; for c in $CASES; do settled "$c" || ok=0; done; [ $ok = 1 ] && break; sleep 20; done
[ $ok = 1 ]; check "every sweep and refund the closes sent is mined" $? ""
watch_all

say "9. Recount each case"
expect() { # case pattern...: the final recount says each pattern
  local c=$1; shift; recount "$c" > "$TOP/$c/recount.txt"
  for p in "$@"; do grep -qE -- "$p" "$TOP/$c/recount.txt" || { check "$c: the recount says /$p/" 1 "$(grep -E 'RESULT|soft cap|over the hard cap|withdrawn early|R6|R7' "$TOP/$c/recount.txt" | head -8 | tr '\n' '|')"; return; }; done
  check "$c: $(grep -E '^RESULT' "$TOP/$c/recount.txt"); $(grep -oE 'kept [0-9.]+' "$TOP/$c/recount.txt" | head -1); $(grep -oE 'over the hard cap [0-9.]+ in [0-9]+' "$TOP/$c/recount.txt")" 0
}
expect below    '^RESULT: PASS' 'soft cap 0\.00300000 \(missed\)' 'refunded 0\.00100000'
expect between  '^RESULT: PASS' 'soft cap 0\.00200000 \(met\)' 'kept 0\.00300000' 'over the hard cap 0\.00000000 in 0'
expect crossing '^RESULT: PASS' 'kept 0\.00300000' 'over the hard cap 0\.00150000 in 1' '1 payment\(s\) over the cap, refunded by ticket'
expect large    '^RESULT: PASS' 'kept 0\.00350000' 'over the hard cap 0\.00300000 in 1'
expect withdraw '^RESULT: PASS' 'withdrawn early 0\.00150000' 'kept 0\.00300000' 'over the hard cap 0\.00000000 in 0'
expect early    '^RESULT: PASS' 'closed early at' 'kept 0\.00300000' 'over the hard cap 0\.00150000 in 1'
expect cheat    '^RESULT: FAIL' ' R6 FAIL'
FAILS=$(grep -oE '^  R[0-9]+b? FAIL' "$TOP/cheat/recount.txt" | awk '{print $1}' | tr '\n' ' ')
[ "$FAILS" = "R6 " ]; check "cheat: only R6 fails (failing: $FAILS)" $? ""
say "Done. Run folder $TOP"
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
