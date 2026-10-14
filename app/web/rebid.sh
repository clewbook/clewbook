#!/usr/bin/env bash
# Pay, withdraw, pay again in one browser profile (app/web/rebid-e2e.cjs) on a new TEST network campaign, then close it after the deadline
# and recount. Usage: app/web/rebid.sh auction|raise   From the repository root. Play money only.
# Env: BIN (default the review build), PAYER (a funded test wallet), STATIC (a folder built with make-static.sh), LD_LIBRARY_PATH for Chromium.
set -uo pipefail
MODE=${1:?auction or raise}
ZD=./target/release/zcash-devtool; BIN=${BIN:-./app/target/review/release}; PAYER=${PAYER:?a funded test wallet}
STATIC=${STATIC:-runs/static-review}; RELAY=http://127.0.0.1:8831; PORT=${PORT:-8834}
RUN=runs/review-rebid-$MODE-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$RUN"
say() { echo; echo "== [$(date -u +%H:%M:%SZ)] $*"; }
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
tip() { "$ZD" wallet -w "$PAYER" get-info 2>/dev/null | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2; }
newwallet() { for n in 1 2 3 4 5 6; do timeout 60 "$ZD" wallet -w "$1" init --name "$(basename "$1")" -i "$1.age" -n test >/dev/null 2>&1 && return 0; case $1 in runs/?*) rm -rf -- "$1" "$1.age";; esac; done; return 1; }
ss -ltn | grep -q ':8831 ' || { ./app/target/review/release/ll-relay serve --dir runs/review-relay --listen 127.0.0.1:8831 > runs/review-relay.log 2>&1 & echo $! > runs/review-relay.pid; sleep 2; }
newwallet "$RUN/wallet" || exit 1; newwallet "$RUN/refund" || exit 1
if [ "$MODE" = auction ]; then ARGS=(--mode auction --items 1); else ARGS=(--goal-zat 50000000); fi
$BIN/ll-host create --run "$RUN" --wallet "$RUN/wallet" --identity "$RUN/wallet.age" "${ARGS[@]}" --deadline-in ${DEADLINE_IN:-90} --ticket-k 10 --relay $RELAY > "$RUN/create.log" 2>&1 || { cat "$RUN/create.log"; exit 1; }
ID=$(cat "$RUN/rules_id"); DEAD=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["deadline_height"])' "$RUN/rules.json")
say "campaign $ID ($MODE), deadline $DEAD; the host's watcher runs every 15 seconds"
( while [ ! -f "$RUN/stop" ]; do $BIN/ll-host watch --run "$RUN" --once >> "$RUN/watch.log" 2>&1; sleep 15; done ) &
python3 -m http.server $PORT --bind 127.0.0.1 --directory "$STATIC" >/dev/null 2>&1 & SRV=$!
sleep 2
LINK="http://127.0.0.1:$PORT/contribute.html#c=$ID&relay=$RELAY&server=https%3A%2F%2Fzjs.zec.rocks%2Ftestnet" REFUND_ADDR=$(addr "$RUN/refund") PAYER=$PAYER \
  SHOTS=runs/review-shots/rebid-$MODE OUT=$RUN/rebid.json timeout 3600 node app/web/rebid-e2e.cjs
RC=$?
kill $SRV
say "waiting for the deadline ($DEAD), then the host closes and the campaign is recounted"
until [ "$(tip || echo 0)" -gt "$DEAD" ]; do sleep 20; done
sleep 40
touch "$RUN/stop"; sleep 20
$BIN/ll-host close --run "$RUN" --sweep-to "$(addr "$RUN/refund")" 2>&1 | sed 's/^/   /'
for _ in $(seq 1 30); do $BIN/ll-host watch --run "$RUN" --once 2>&1 | grep -q "lock released" && break; sleep 20; done
"$ZD" wallet -w "$RUN/wallet" sync >/dev/null 2>&1; "$ZD" wallet -w "$RUN/wallet" enhance >/dev/null 2>&1
$BIN/ll-recount --rules "$RUN/rules.json" --rules-id "$ID" --ledger "$RUN/ledger" --wallet "$RUN/wallet" 2>&1 | sed 's/^/   /'
say "done ($RUN), browser test exit $RC"
exit $RC
