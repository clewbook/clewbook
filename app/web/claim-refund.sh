#!/usr/bin/env bash
# "Claim my refund" after a close whose refund never went out, on the testnet with real money (see claim-refund-e2e.cjs). From the repository
# root; needs the testnet relays (8787, 8788), a page server (PAGE_BASE, a spare port), the `bidder` wallet with about 0.002 TAZ, the test-only
# build (app/target-cheat) and Chromium's libraries on LD_LIBRARY_PATH. Takes about an hour (deadline, then the ticket window after the close).
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=./app/target/release
ROOT=${ROOT:-runs/claim-refund-$(date -u +%Y%m%dT%H%M%SZ)}; C=$ROOT/campaign; mkdir -p $C
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
"$ZD" wallet -w $C/wallet init --name campaign-claim -i $C/wallet.age -n test >/dev/null 2>&1 || { echo "wallet init failed"; exit 1; }
$BIN/cb-host create --run $C --wallet $C/wallet --identity $C/wallet.age --goal-zat 5000000 --deadline-in ${DEADLINE_IN:-25} --ticket-k 10 \
  --relay http://127.0.0.1:8787 --relay http://127.0.0.1:8788 > $ROOT/create.log 2>&1 || { cat $ROOT/create.log; exit 1; }
$BIN/cb-host watch --run $C --interval 10 > $ROOT/watch.log 2>&1 & W=$!
trap 'kill $W 2>/dev/null' EXIT
ID=$(cat $C/rules_id)
LINK="${PAGE_BASE:?set PAGE_BASE}/contribute.html#c=$ID&relay=http://127.0.0.1:8787&relay=http://127.0.0.1:8788&server=https://zjs.zec.rocks/testnet" \
  CAMPAIGN=$C WATCHER=$W PAYER=bidder REFUND_ADDR="$(addr bidder)" TREASURY="$(addr outsider)" SHOTS=${SHOTS:-$ROOT} timeout 7200 node app/web/claim-refund-e2e.cjs
