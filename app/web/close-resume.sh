#!/usr/bin/env bash
# The close resumes after a failed step, on the testnet with real money (a raise that meets its goal): the dashboard closes it from a real
# browser while the sweep is made to fail (test-only build, LL_TEST_FAIL_SWEEP), says so plainly and offers "Try again"; once the failure is
# lifted, "Try again" finishes the sweep, exactly once. Then the recount checks the books. From the repository root; needs the testnet relays
# (8787, 8788), the `bidder` wallet with about 0.021 TAZ, the test-only build (cd app && CARGO_TARGET_DIR=target-cheat cargo build --release
# -p ll-host --features test-cheats) and Chromium's libraries on LD_LIBRARY_PATH. Env: DASH_PORT (default 8783), ROOT.
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=./app/target/release; CHEAT=./app/target-cheat/release/cb-host
P=${DASH_PORT:-8783}; ROOT=${ROOT:-runs/close-resume-$(date -u +%Y%m%dT%H%M%SZ)}; RUNS=$ROOT/runs; C=$RUNS/campaign-resume
for p in $(ss -ltnp 2>/dev/null | grep ":$P " | grep -o 'pid=[0-9]*' | cut -d= -f2); do echo "port $P is in use by pid $p; choose another DASH_PORT"; exit 1; done
mkdir -p $C
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
tip() { "$ZD" wallet -w bidder get-info 2>/dev/null | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2; }
"$ZD" wallet -w $C/wallet init --name campaign-resume -i $C/wallet.age -n test >/dev/null 2>&1 || { echo "wallet init failed"; exit 1; }
$BIN/cb-host create --run $C --wallet $C/wallet --identity $C/wallet.age --goal-zat 1500000 --deadline-in ${DEADLINE_IN:-25} \
  --relay http://127.0.0.1:8787 --relay http://127.0.0.1:8788 > $ROOT/create.log 2>&1 || { cat $ROOT/create.log; exit 1; }
touch $ROOT/fail-sweep
LL_TEST_FAIL_SWEEP=$ROOT/fail-sweep $CHEAT serve --runs-dir $RUNS --listen 127.0.0.1:$P --relay http://127.0.0.1:8787 --relay http://127.0.0.1:8788 > $ROOT/dashboard.log 2>&1 & DASH=$!
trap 'kill $DASH 2>/dev/null' EXIT
pay() { local tag=$1 value=$2 memo txid=""
  $BIN/cb-contrib keygen --out $C/$tag.seed >/dev/null
  memo=$($BIN/cb-contrib memo --rules $C/rules.json --seed $C/$tag.seed --refund-address "$(addr bidder)")
  for _ in $(seq 1 20); do "$ZD" wallet -w bidder sync >/dev/null 2>&1 || true
    txid=$(echo y | "$ZD" wallet -w bidder send -i bidder.age --address "$(cat $C/address)" --value $value --memo "$memo" --min-confirmations 1 2>&1 | grep -oE '^[0-9a-f]{64}$' || true)
    [ -n "$txid" ] && break; sleep 20; done
  [ -n "$txid" ] || { echo "payment failed"; exit 1; }; echo "paid $tag: $value zat, $txid"; }
pay r1 1000000; pay r2 1000000
for _ in $(seq 1 80); do [ "$(ls $C/ledger 2>/dev/null | wc -l)" -ge 2 ] && break; sleep 15; done
echo "tickets: $(ls $C/ledger | wc -l) ledger entries"
D=$(python3 -c "import json;print(json.load(open('$C/rules.json'))['deadline_height'])")
echo "waiting for the deadline $D"; while [ "$(tip)" -le "$D" ]; do sleep 15; done
DASH_PORT=$P FLAG=$ROOT/fail-sweep CAMPAIGN=$C SWEEP_TO="$(addr outsider)" SHOTS=${SHOTS:-$ROOT} timeout 1800 node app/web/close-resume-e2e.cjs; R=$?
# the recount, once the sweep is mined
for _ in $(seq 1 40); do grep -q '"status": "confirmed"' $C/private/outbox.json 2>/dev/null && break; sleep 15; done
KEY=$(python3 -c "import json;print(json.load(open('$C/rules.json'))['campaign_ufvk'])"); START=$(python3 -c "import json;print(json.load(open('$C/rules.json'))['start_height'])")
"$ZD" wallet -w $ROOT/viewer init-fvk --name viewer --fvk "$KEY" --birthday $((START - 2)) >/dev/null 2>&1; "$ZD" wallet -w $ROOT/viewer sync >/dev/null 2>&1; "$ZD" wallet -w $ROOT/viewer enhance >/dev/null 2>&1
$BIN/cb-recount --rules $C/rules.json --rules-id "$(cat $C/rules_id)" --ledger $C/ledger --wallet $ROOT/viewer > $ROOT/recount.log 2>&1; RC=$?
grep -E "^R[0-9]|PASS|FAIL" $ROOT/recount.log | head -12
[ $RC = 0 ] && echo "PASS  the recount of the closed campaign passes" || { echo "FAIL  the recount of the closed campaign"; R=1; }
exit $R
