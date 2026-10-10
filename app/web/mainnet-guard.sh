#!/usr/bin/env bash
# The mainnet guards (no money, no wallet). From the repository root. Starts `ll-host serve --network main` on an empty folder, runs mainnet-e2e.cjs.
set -uo pipefail
D=runs/mainnet-guard; rm -rf $D; mkdir -p $D
for p in $(ss -ltnp 2>/dev/null | grep ':8780 ' | grep -o 'pid=[0-9]*' | cut -d= -f2); do echo "port 8780 is in use by pid $p; stop it first"; exit 1; done
./app/target/release/ll-host serve --network main --runs-dir $D/runs --relay http://127.0.0.1:8787 --relay http://127.0.0.1:8788 --server https://zjs.zec.rocks/mainnet > $D/serve.log 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s -m 2 http://127.0.0.1:8780/api/config >/dev/null && break; sleep 1; done
RUNS=$D/runs SHOTS=runs/design-shots timeout 300 node app/web/mainnet-e2e.cjs
