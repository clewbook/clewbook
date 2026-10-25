#!/usr/bin/env bash
# The mainnet guards (no money, no wallet). From the repository root. Starts `ll-host serve --network main` on an empty folder, runs mainnet-e2e.cjs.
# Env: PORT (default 8780; pick another when a live host uses 8780), BIN (folder with ll-host, default app/target/release).
set -uo pipefail
D=runs/mainnet-guard; rm -rf $D; mkdir -p $D
PORT=${PORT:-8780}; BIN=${BIN:-app/target/release}
ss -ltn 2>/dev/null | grep -q ":$PORT " && { echo "port $PORT is in use; pick another with PORT="; exit 1; }
$BIN/ll-host serve --network main --listen 127.0.0.1:$PORT --runs-dir $D/runs --relay http://127.0.0.1:8787 --relay http://127.0.0.1:8788 --server https://zjs.zec.rocks/mainnet > $D/serve.log 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s -m 2 http://127.0.0.1:$PORT/api/config >/dev/null && break; sleep 1; done
BASE=http://127.0.0.1:$PORT RUNS=$D/runs SHOTS=runs/design-shots timeout 300 node app/web/mainnet-e2e.cjs
