#!/usr/bin/env bash
# The sealed bid auction host, separate from every other host: its own port (8786) and its own campaigns folder (runs/testnet-sealed).
# It never uses the ports of the live hosts (8780, 8783) and never their folders. Nothing is started unless asked.
#
#   app/sealed-testnet.sh dry-run    print what would run, check the port and the folder, start nothing
#   app/sealed-testnet.sh start      start the host on the public test network (only when the owner has said so)
#   app/sealed-testnet.sh stop       stop it (by the process number it saved)
#   app/sealed-testnet.sh status     whether it runs, and its last log lines
#
# SEALED_RELAY: the relay to publish to (required to start; there is no default).
# CB_HOST: the host program to use, a normal build of this branch (not the regtest test build); default app/target-sealed/release/cb-host.
# TEST ONLY: SEALED_NETWORK=regtest with SEALED_SERVER=http://127.0.0.1:19067 points it at a private chain instead (a regtest build).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=8786
DIR=${SEALED_RUNS:-runs/testnet-sealed}
NETWORK=${SEALED_NETWORK:-test}
SERVER=${SEALED_SERVER:-https://zjs.zec.rocks/testnet}
RELAY=${SEALED_RELAY:-}   # no default: the owner chooses which relay the sealed auctions publish to
HOST=${CB_HOST:-app/target-sealed/release/cb-host}
DEVTOOL=${SEALED_DEVTOOL:-app/target-sealed/release/zcash-devtool}
PIDFILE=$DIR/host.pid

refuse() { echo "sealed-testnet.sh: $*" >&2; exit 1; }
case "$DIR" in *testnet-live-dash*|*mainnet-pilot-dash*|*.backups*) refuse "that folder belongs to a live host";; esac
[ "$NETWORK" = main ] && refuse "sealed bid auctions run on the test network only for now"
cmd=("$HOST" serve --runs-dir "$DIR" --www app/web/www --listen "127.0.0.1:$PORT" --network "$NETWORK" --devtool "$DEVTOOL"
     --relay "${RELAY:-<SEALED_RELAY not set>}" --page-base "http://127.0.0.1:$PORT" --server "$SERVER")

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

case "${1:-}" in
  dry-run)
    echo "would run: ${cmd[*]}"
    echo "folder: $DIR ($( [ -d "$DIR" ] && echo exists || echo "would be created"))"
    if port_busy; then echo "port $PORT: in use"; else echo "port $PORT: free"; fi
    [ -x "$HOST" ] && echo "program: $HOST" || echo "program: $HOST is missing; build it with: cargo build --release -p ll-host (from app/, CARGO_TARGET_DIR=app/target-sealed)"
    ;;
  start)
    [ -n "$RELAY" ] || refuse "set SEALED_RELAY to the relay to publish to (there is no default)"
    running && refuse "already running (process $(cat "$PIDFILE"))"
    port_busy && refuse "port $PORT is in use by another program"
    [ -x "$HOST" ] || refuse "$HOST is missing"
    mkdir -p "$DIR"; chmod 700 "$DIR"
    nohup "${cmd[@]}" >> "$DIR/host.log" 2>&1 &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 30); do port_busy && { echo "started (process $(cat "$PIDFILE")): http://127.0.0.1:$PORT"; exit 0; }; sleep 1; done
    refuse "it did not start; see $DIR/host.log"
    ;;
  stop)
    running || { echo "not running"; rm -f "$PIDFILE"; exit 0; }
    pid=$(cat "$PIDFILE"); kill "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || { rm -f "$PIDFILE"; echo stopped; exit 0; }; sleep 1; done
    refuse "process $pid did not stop"
    ;;
  status)
    if running; then echo "running (process $(cat "$PIDFILE")) on port $PORT"; else echo "not running"; fi
    [ -f "$DIR/host.log" ] && tail -5 "$DIR/host.log"
    ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
