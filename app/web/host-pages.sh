#!/usr/bin/env bash
# The set-up page and the dashboard's view, end to end on testnet (creates one real campaign). From the repository root.
# Starts `ll-host serve` on 127.0.0.1:8780 with an empty runs folder, runs setup-e2e.cjs then dashboard-view-e2e.cjs, stops it.
set -uo pipefail
P=${DASH_PORT:-8780} # the dashboard's port; set DASH_PORT to test beside a running dashboard
D=runs/host-pages; rm -rf $D; mkdir -p $D
for p in $(ss -ltnp 2>/dev/null | grep ":$P " | grep -o 'pid=[0-9]*' | cut -d= -f2); do echo "port $P is in use by pid $p; stop it first"; exit 1; done
${BIN:-./app/target/release}/ll-host serve --listen 127.0.0.1:$P --runs-dir $D/runs --relay http://127.0.0.1:8787 --relay http://127.0.0.1:8788 > $D/serve.log 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s -m 2 http://127.0.0.1:$P/api/config >/dev/null && break; sleep 1; done
SHOTS=runs/design-shots DASH_PORT=$P timeout 900 node app/web/setup-e2e.cjs; R1=$?
SHOTS=runs/design-shots DASH_PORT=$P timeout 600 node app/web/dashboard-view-e2e.cjs; R2=$?
echo "setup-e2e exit $R1, dashboard-view-e2e exit $R2"; [ $R1 = 0 ] && [ $R2 = 0 ]
