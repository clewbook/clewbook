#!/usr/bin/env bash
# The sealed set up page and the dashboard notes (app/web/sealed-setup-coins-e2e.cjs) against a throwaway host and relay on the test network.
# Both run on their own ports (8796, 18796) with a new folder under runs/setup-coins-test, and are stopped at the end. Creating the
# auction moves no money: nobody funds or bids on it. Usage: LD_LIBRARY_PATH=<browser libraries> app/web/check-setup-coins.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
HOST=${CB_HOST:-runs/sealed-bin/cb-host}
RELAY_BIN=${CB_RELAY:-runs/sealed-bin/cb-relay}
DEVTOOL=${CB_DEVTOOL:-runs/sealed-bin/zcash-devtool}
R=runs/setup-coins-test/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$R/campaigns" "$R/relay"
chmod 700 "$R"
"$RELAY_BIN" serve --dir "$R/relay" --listen 127.0.0.1:18796 > "$R/relay.log" 2>&1 &
RELAY_PID=$!
"$HOST" serve --runs-dir "$R/campaigns" --www app/web/www --listen 127.0.0.1:8796 --network test --devtool "$DEVTOOL" \
  --relay http://127.0.0.1:18796 --page-base http://127.0.0.1:8796 --server https://zjs.zec.rocks/testnet --listing-url http://127.0.0.1:9 \
  > "$R/host.log" 2>&1 &
HOST_PID=$!
trap 'kill "$HOST_PID" "$RELAY_PID" 2>/dev/null; wait "$HOST_PID" "$RELAY_PID" 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:8796/api/config && break; sleep 1; done
BASE=http://127.0.0.1:8796 RELAY_DIR="$R/relay" RUNS_DIR="$R/campaigns" timeout 1200 node app/web/sealed-setup-coins-e2e.cjs
