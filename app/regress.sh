#!/usr/bin/env bash
# Runs every closing / relay / reject / watcher scenario on testnet, one after another (they share the `bidder`
# wallet), and writes one line per scenario to runs/regress/summary.txt. From the repository root.
# Needs the cheating build for the reject scenario (see app/e2e-reject.sh).
set -uo pipefail
OUT=runs/regress; mkdir -p $OUT; : >> $OUT/summary.txt
run() { # name, command...
  local name=$1; shift
  echo "[$(date -u +%H:%M:%S)] start $name" | tee -a $OUT/progress.txt
  timeout ${TIMEOUT:-2700} "$@" > $OUT/$name.log 2>&1; local rc=$?
  echo "$name EXIT=$rc" >> $OUT/summary.txt
  echo "[$(date -u +%H:%M:%S)] done $name exit $rc" | tee -a $OUT/progress.txt
}
[ -z "${ONLY:-}" ] && run raise-slice ./app/e2e.sh
for s in ${SCENARIOS:-a b c d e f g}; do run one-$s ./app/e2e-one.sh $s; done
[ -z "${ONLY:-}" ] && { run withdraw ./app/e2e-withdraw.sh; run reject ./app/e2e-reject.sh; run relay ./app/e2e-relay.sh; }
# Broadcast reliability (needs the cheating build and app/target-drop, see app/drop-e2e.sh): a flaky server drops the first
# broadcast of every host transaction; the browser test swallows the first "Refund me" send.
[ -z "${ONLY:-}" ] && { run drop-host ./app/drop-e2e.sh; run drop-refund-page ./app/web/refund-drop.sh; }
echo ALLDONE >> $OUT/summary.txt
