#!/usr/bin/env bash
# The whole dashboard scenario on testnet: create (through the set-up page), a real payment, relay-down warning, 403s, wait for the deadline, close from the page.
# From the repository root; uses the `bidder` wallet and an empty runs folder. Takes about half an hour.
set -uo pipefail
P=${DASH_PORT:-8780} # the dashboard's port; set DASH_PORT to test beside a running dashboard
D=runs/dash-regress; rm -rf $D; mkdir -p $D
for p in $(ss -ltnp 2>/dev/null | grep ":$P " | grep -o 'pid=[0-9]*' | cut -d= -f2); do echo "port $P is in use by pid $p; stop it first"; exit 1; done
./app/target/release/ll-host serve --listen 127.0.0.1:$P --runs-dir $D/runs --relay http://127.0.0.1:8787 --relay http://127.0.0.1:8788 > $D/serve.log 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s -m 2 http://127.0.0.1:$P/api/config >/dev/null && break; sleep 1; done
RA=$(./target/release/zcash-devtool wallet -w bidder list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3)
DASH_PORT=$P DASH_RUNS=$D/runs PAYER=bidder REFUND_ADDR=$RA TREASURY=$RA SHOTS=${SHOTS:-runs/design-shots/e2e} timeout 3600 node app/web/dashboard-e2e.cjs; R=$?
node app/web/design-shot.cjs http://127.0.0.1:$P/ dashboard-closed
exit $R
