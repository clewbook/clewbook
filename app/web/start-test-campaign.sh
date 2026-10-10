#!/usr/bin/env bash
# Creates a real testnet raise campaign for trying the contribute page, publishes it to two local
# relays, starts the host's watcher in the background, and prints the page link.
# Needs the relays (ports 8787, 8788) and a page server (PAGE_BASE, default http://127.0.0.1:8770) running; everything local only.
# Usage: [CAMPAIGN_NAME="a public name"] app/web/start-test-campaign.sh [goal_zat] [deadline_in_blocks]
set -euo pipefail
ZD=./target/release/zcash-devtool
BIN=./app/target/release
GOAL=${1:-5000000}; DEADLINE=${2:-400}
RELAY1=${RELAY1:-http://127.0.0.1:8787}; RELAY2=${RELAY2:-http://127.0.0.1:8788}
RUN=${RUN:-runs/page/campaign-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$RUN"
W=""
for n in 1 2 3 4 5; do
    if timeout 45 "$ZD" wallet -w "$RUN/wallet$n" init --name campaign -i "$RUN/wallet$n.age" -n test >/dev/null 2>&1; then W="$RUN/wallet$n"; break; fi
    echo "wallet init attempt $n stalled, retrying" >&2
done
[ -n "$W" ] || { echo "could not create a wallet" >&2; exit 1; }
timeout 180 $BIN/ll-host create --run "$RUN" --wallet "$W" --identity "$W.age" --goal-zat "$GOAL" ${CAMPAIGN_NAME:+--name "$CAMPAIGN_NAME"} \
    --deadline-in "$DEADLINE" --relay "$RELAY1" --relay "$RELAY2" > "$RUN/create.log" 2>&1
[ -n "${NOWATCH:-}" ] || (nohup setsid $BIN/ll-host watch --run "$RUN" --interval 10 > "$RUN/watch.log" 2>&1 &)
ID=$(cat "$RUN/rules_id")
echo "$RUN" > runs/page/latest
echo "run dir:  $RUN"
echo "link:     ${PAGE_BASE:-http://127.0.0.1:8770}/contribute.html#c=$ID&relay=$RELAY1&relay=$RELAY2&server=https://zjs.zec.rocks/testnet"
