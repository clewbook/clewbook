#!/usr/bin/env bash
# ./run.sh with a permanent address, tested with a stand-in for the tunnel program (no account, no domain, no network): the one file the addresses are
# read from, the dashboard command that uses them, the printed tunnel configuration, start / stop, the refusals, and the status line that says an
# address is NOT ANSWERING. What this cannot show: that a real named tunnel connects (see docs/STABLE_ADDRESS.md). From the repository root.
set -uo pipefail
T=runs/stable-address-test; failed=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
rm -rf $T; mkdir -p $T
export RUNSH_STABLE_CONF=$T/stable.conf RUNSH_CF_CONFIG=$T/config.yml CLOUDFLARED=./app/stub-bin/cloudflared
OUT=$(./run.sh start tunnel-stable 2>&1); [[ "$OUT" == *"no permanent address is set"* ]]; check "without the file, tunnel-stable refuses and says what to write" $? "$OUT"
OUT=$(./run.sh stable-config 2>&1); [ $? = 2 ]; check "without the file, stable-config refuses" $? "$OUT"
cat > $RUNSH_STABLE_CONF <<'CONF'
# the permanent addresses (one place)
PAGE_URL=https://app.example.invalid
RELAY_URL=https://relay.example.invalid/   # a trailing slash is ignored
TUNNEL_NAME=lab-test
CONF
C=$(./run.sh command dashboard); [[ "$C" == *"--relay https://relay.example.invalid --page-base https://app.example.invalid "* ]]; check "the dashboard command takes both addresses from the one file" $? "$C"
[[ "$C" != *trycloudflare* ]]; check "  ... and no free-tunnel address is left in it" $? "$C"
C=$(./run.sh command tunnel-stable); [[ "$C" == *"tunnel --no-autoupdate --protocol http2 run lab-test"* ]]; check "tunnel-stable runs the named tunnel" $? "$C"
OUT=$(./run.sh stable-config); [[ "$OUT" == *"tunnel: lab-test"* && "$OUT" == *"hostname: app.example.invalid"* && "$OUT" == *"service: http://127.0.0.1:8770"* && "$OUT" == *"hostname: relay.example.invalid"* && "$OUT" == *"service: http://127.0.0.1:8790"* && "$OUT" == *"http_status:404"* ]]; check "stable-config prints the page and relay rules with their ports and a final 404 rule" $? "$OUT"
OUT=$(./run.sh start tunnel-stable 2>&1); [[ "$OUT" == *"no tunnel configuration at $RUNSH_CF_CONFIG"* ]]; check "without the tunnel configuration file it says where to save it" $? "$OUT"
./run.sh stable-config > $RUNSH_CF_CONFIG
OUT=$(./run.sh start tunnel-stable 2>&1); [[ "$OUT" == *"is up. Page: https://app.example.invalid   Relay: https://relay.example.invalid"* ]]; check "tunnel-stable starts and reports both addresses" $? "$OUT"
OUT=$(./run.sh status); [[ "$OUT" == *"tunnel-stable"*"up"* ]]; check "status shows tunnel-stable as up" $? ""
[[ "$OUT" == *"app.example.invalid/"*"NOT ANSWERING"*"./run.sh restart tunnel-stable --yes"* ]]; check "status says an address that does not answer is NOT ANSWERING, with the restart command, even though the program is up" $? "$(echo "$OUT" | sed -n '/ADDRESSES/,/OTHER/p')"
OUT=$(./run.sh stop tunnel-stable 2>&1); [ $? = 3 ]; check "stopping it needs --yes" $? "$OUT"
OUT=$(./run.sh restart tunnel-stable --yes 2>&1); [[ "$OUT" == *"stopped"* && "$OUT" == *"is up"* ]]; check "restart --yes stops it and starts it again" $? "$OUT"
OUT=$(./run.sh stop tunnel-stable --yes 2>&1); [[ "$OUT" == *"stopped"* ]]; check "stop --yes stops it" $? "$OUT"
[ -z "$(ps -eo args= | grep 'stub-bin/cloudflared' | grep -v grep)" ]; check "nothing is left running" $? ""
rm -f $RUNSH_STABLE_CONF
C=$(./run.sh command dashboard); [[ "$C" == *trycloudflare* || "$C" == *"--relay  "* || "$C" == *"--relay "* ]]; check "without the file the dashboard command goes back to the free tunnels' addresses" $? "$C"
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
