#!/usr/bin/env bash
# Broadcast reliability on testnet (SPEC / NOTES "Broadcast reliability"): a fake flaky public server drops the FIRST broadcast of
# every transaction the host sends (close refunds, sweep, auction settlement). The host's outbox must notice, send the very
# same bytes again after about ten blocks, and end with every transaction mined exactly once. Needs the cheating build:
#   cd app && CARGO_TARGET_DIR=target-cheat cargo build --release -p ll-host --features test-cheats
#   (and app/target-drop = symlinks to the normal tools, with ll-host pointing at the cheating build)
# Run from the repository root.
set -uo pipefail
export BIN=./app/target-drop LL_TEST_DROP_FIRST_BROADCAST=1 EXTRA_BLOCKS=${EXTRA_BLOCKS:-30}
OUT=runs/drop; mkdir -p $OUT; : > $OUT/summary.txt
for s in b a; do
  timeout 3000 ./app/e2e-one.sh $s > $OUT/one-$s.log 2>&1; echo "one-$s EXIT=$?" >> $OUT/summary.txt
done
NAME=auction-drop DIVERT=0 timeout 3000 ./app/auction-e2e.sh > $OUT/auction.log 2>&1; echo "auction EXIT=$?" >> $OUT/summary.txt
B=$(ls -d runs/one-b-2* | tail -1); A=$(ls -d runs/one-a-2* | tail -1)
python3 app/drop-verify.py $B $A runs/auction-drop/campaign > $OUT/verify.log 2>&1; echo "verify EXIT=$?" >> $OUT/summary.txt
cat $OUT/summary.txt
