#!/usr/bin/env bash
# The campaign and recount pages against the four auctions of a finished check-sealed-close.sh run (phase 11): restarts that run's private
# chain on this machine (its state is kept), serves a copy of its relay data, bridges the chain's light wallet service to the browser, and
# runs app/web/sealed-pages-e2e.cjs. Offline, no money.
# Usage: ZEBRAD=... BIN=<folder with ll-relay> check-pages.sh <run folder of check-sealed-close.sh>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
R=$(cd "${1:?run folder of check-sealed-close.sh}" && pwd)
: "${ZEBRAD:?zebrad 7.0.0-rc.0}" "${BIN:?folder of the built programs}"
C=$HERE/chain.sh
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  "$C" stop "$R/chain" >/dev/null 2>&1 || true
  rm -rf "$R/pages-relay"
}
trap cleanup EXIT
KEEP=1 "$C" start "$R/chain" >/dev/null
rm -rf "$R/pages-relay"; cp -r "$R/relay" "$R/pages-relay"
nohup "$BIN/ll-relay" serve --allow-regtest --dir "$R/pages-relay" --listen 127.0.0.1:18797 > /dev/null 2>&1 & PIDS+=($!)
node "$ROOT/app/web/tools/grpc-web-bridge.cjs" 18799 http://127.0.0.1:19067 & PIDS+=($!)
python3 -m http.server 8813 --bind 127.0.0.1 --directory "$ROOT/app/web/www" > /dev/null 2>&1 & PIDS+=($!)
sleep 3
IDS=$(python3 -c 'import json,sys;print(json.dumps({x:open(f"{sys.argv[1]}/{x}/rules_id").read().strip() for x in "USPN"}))' "$R")
echo "chain at $("$C" tip)"
cd "$ROOT"
IDS="$IDS" RELAY=http://127.0.0.1:18797 ENDPOINT=http://127.0.0.1:18799 WEB=http://127.0.0.1:8813 node app/web/sealed-pages-e2e.cjs
