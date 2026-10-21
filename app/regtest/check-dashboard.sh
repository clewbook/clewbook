#!/usr/bin/env bash
# Private chain check of the host's set up page and dashboard for a sealed bid auction (phase 10). A regtest chain with NU7 active, a local
# relay, a local stand in for drand, and the host dashboard (cb-host serve, regtest build) on this machine; then app/web/sealed-dashboard-e2e.cjs
# drives the pages in a headless browser: create the auction on the set up page, fund its coin wallet, two bids, close from the dashboard,
# and the viewing key. Offline, throwaway keys, no money.
# Usage: ZEBRAD=... BIN=<folder with cb-host (regtest build), ll-relay, ll-contrib, zcash-devtool (regtest build)> check-dashboard.sh <run folder>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
R=${1:?run folder}
: "${ZEBRAD:?zebrad 7.0.0-rc.0}" "${BIN:?folder of the built programs}"
export DEVTOOL=$BIN/zcash-devtool
C=$HERE/chain.sh
CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
ROUND=33187201
SIG=943614203a936e3d4ac466aa2b475e9c1e614f4759fe45b7f4bedeb0316d172e6cacadb08a46b39c67c09555dc6db3a5
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  [ -f "$R/chain/zebrad.pid" ] && "$C" stop "$R/chain" >/dev/null 2>&1 || true
}
trap cleanup EXIT
rm -rf "$R"
mkdir -p "$R/w" "$R/runs" "$R/drand/$CHAIN_HASH/public"
echo "{\"round\":$ROUND,\"signature\":\"$SIG\"}" > "$R/drand/$CHAIN_HASH/public/$ROUND"
python3 -m http.server 18791 --bind 127.0.0.1 --directory "$R/drand" > "$R/drand.log" 2>&1 & PIDS+=($!)

"$C" start "$R/chain" >/dev/null
"$C" mine 5 >/dev/null
for n in funder payer; do "$C" wallet "$R/w" "$n" > "$R/w/$n.address"; done
"$C" stop "$R/chain" >/dev/null
KEEP=1 "$C" start "$R/chain" "$(cat "$R/w/funder.address")" >/dev/null
"$C" mine 110 >/dev/null
nohup "$BIN/ll-relay" serve --allow-regtest --dir "$R/relay" --listen 127.0.0.1:18787 > "$R/relay.log" 2>&1 & PIDS+=($!)
# the host dashboard; TEST ONLY settings: drand from the local stand in, a known round, late tickets 25 blocks after the deadline
export CB_DRAND_URLS=http://127.0.0.1:18791 CB_TEST_DRAND_ROUND=$ROUND CB_TEST_CLAIM_AFTER_IN=25 CB_REGTEST_HEIGHTS=$HERE/activation-heights.toml
cd "$ROOT"
nohup "$BIN/cb-host" serve --runs-dir "$R/runs" --www app/web/www --listen 127.0.0.1:8790 --network regtest --devtool "$DEVTOOL" \
  --relay http://127.0.0.1:18787 --page-base http://127.0.0.1:8790 --server http://127.0.0.1:19067 > "$R/serve.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:8790/api/config >/dev/null && break; sleep 1; done
echo "ok: chain at $("$C" tip), relay, drand stand in and dashboard running"
cd "$ROOT"
RUN="$R" CHAIN="$C" BIN="$BIN" node app/web/sealed-dashboard-e2e.cjs
