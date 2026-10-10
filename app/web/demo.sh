#!/usr/bin/env bash
# One command to try the contribute page on your own machine (testnet, play money).
#
#   app/web/demo.sh                    local only (127.0.0.1): nothing is reachable from other devices
#   LAN_IP=192.168.1.69 app/web/demo.sh   also reachable from a phone on the same wifi
#
# Starts two relays and the page server if they are not running, reuses the current campaign if it
# is still open (otherwise creates a fresh one), makes sure its host watcher is running, and prints
# the link to open. Run from the repository root.
set -euo pipefail
ZD=./target/release/zcash-devtool
BIN=./app/target/release
mkdir -p runs/page
BIND=127.0.0.1; HOST=127.0.0.1
if [ -n "${LAN_IP:-}" ]; then BIND=0.0.0.0; HOST=$LAN_IP; fi
PORT_PAGE=8770; PORT_R1=8787; PORT_R2=8788
RELAY1=http://$HOST:$PORT_R1; RELAY2=http://$HOST:$PORT_R2
SERVER=${SERVER:-https://zjs.zec.rocks/testnet}

up() { curl -s -m 2 "$1" >/dev/null 2>&1; }
bound_ok() { # port: is it listening on the address we want?
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qx "$BIND:$1" || { [ "$BIND" = 127.0.0.1 ] && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qx "0.0.0.0:$1"; }
}
stop_port() { local p; p=$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true); [ -n "$p" ] && kill "$p" 2>/dev/null || true; }

# --- services (restarted only if they are bound to the wrong address) ---
for n in 1 2; do
    port=$((PORT_R1 + n - 1)); dir=runs/page/relay$n
    if up "http://127.0.0.1:$port/v1/health" && ! bound_ok $port; then stop_port $port; sleep 1; fi
    up "http://127.0.0.1:$port/v1/health" || (nohup setsid $BIN/ll-relay serve --dir "$dir" --listen "$BIND:$port" > "$dir.log" 2>&1 &)
done
if up http://127.0.0.1:$PORT_PAGE/ && ! bound_ok $PORT_PAGE; then stop_port $PORT_PAGE; sleep 1; fi
up http://127.0.0.1:$PORT_PAGE/ || (SERVE_DEV=1 nohup setsid python3 app/web/serve.py $PORT_PAGE "$BIND" > runs/page/static.log 2>&1 &)
sleep 2

# --- is the current campaign still open? ---
RUN=$(cat runs/page/latest 2>/dev/null || true)
STATE=none
if [ -n "$RUN" ] && [ -f "$RUN/rules.json" ]; then
    TIP=$("$ZD" wallet -w bidder get-info 2>/dev/null | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2 || true)
    STATE=$(python3 - "$RUN" "${TIP:-0}" <<'PY'
import json, os, sys
run, tip = sys.argv[1], int(sys.argv[2])
rules = json.load(open(f"{run}/rules.json"))
closed = any(json.load(open(f"{run}/ledger/{f}"))["kind"] == "close" for f in sorted(os.listdir(f"{run}/ledger"))) if os.path.isdir(f"{run}/ledger") else False
left = rules["deadline_height"] - tip
print("closed" if closed else ("unknown" if tip == 0 else (f"open {left}" if left > 0 else "ended")))
PY
)
fi
case "$STATE" in
    open*) echo "The current campaign is still open ($(echo "$STATE" | cut -d' ' -f2) blocks until its deadline). Reusing it." ;;
    unknown) echo "Could not reach the network to check the current campaign; reusing it." ;;
    none) echo "No campaign yet. Creating a fresh one." ;;
    *) echo "The previous campaign has ended. Creating a fresh one." ; RUN="" ;;
esac
if [ "$STATE" = none ] || [ "$STATE" = ended ] || [ "$STATE" = closed ] || [ -z "$RUN" ]; then
    RELAY1=$RELAY1 RELAY2=$RELAY2 ./app/web/start-test-campaign.sh "${1:-5000000}" "${2:-500}" > runs/page/start.log 2>&1 || { cat runs/page/start.log; echo "Could not create a campaign (the public testnet server may be slow). Run this again in a minute."; exit 1; }
    RUN=$(cat runs/page/latest)
fi
# the host watcher must be running for this campaign
if ! ps -eo args | grep -F -- "ll-host watch --run $RUN" | grep -vF grep >/dev/null; then
    (nohup setsid $BIN/ll-host watch --run "$RUN" --interval 10 > "$RUN/watch.log" 2>&1 &)
fi
ID=$(cat "$RUN/rules_id")
LINK="http://$HOST:$PORT_PAGE/contribute.html#c=$ID&relay=$RELAY1&relay=$RELAY2&server=$SERVER"
python3 - "$RUN" "$ID" "$LINK" "$RELAY1" "$RELAY2" "$SERVER" <<'PY'
import json, sys
run, cid, link, r1, r2, server = sys.argv[1:7]
rules = json.load(open(f"{run}/rules.json"))
json.dump({"id": cid, "link": link, "relays": [r1, r2], "server": server, "run": run,
           "deadline_height": rules["deadline_height"]}, open("app/web/www/current.json", "w"))
PY
echo
echo "Contribute page link (open this):"
echo "$LINK"
echo
echo "Start page: http://$HOST:$PORT_PAGE/"
[ -n "${LAN_IP:-}" ] && echo "(reachable from other devices on your network at $LAN_IP)"
echo
echo "To pay without a phone wallet, copy the address and message from 'Show payment details' and run:"
echo "  ./app/web/pay-from-test-wallet.sh <address> <amount_zat> <message>"
