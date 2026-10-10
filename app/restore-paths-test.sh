#!/usr/bin/env bash
# A restored copy of a campaign folder must never silently use another folder's wallet. Takes a campaign folder (SRC, default
# runs/polish-a/campaign: a testnet campaign whose config.json is in the older form and names its own wallet, with paths from the folder the program was started in),
# copies it, and checks: (1) unchanged config, old folder still there: refused, naming the problem; (2) unchanged config, old folder gone: refused;
# (3) config edited to names inside the copy: starts (one watch pass on the testnet, no money); (4) the original, in place, still starts.
# From the repository root. Needs the testnet server for steps 3 and 4 only.
set -uo pipefail
SRC=${SRC:-runs/polish-a/campaign}; BIN=./app/target/release/ll-host; T=runs/restore-paths-test
failed=0; check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
[ -f "$SRC/config.json" ] || { echo "no campaign folder at $SRC"; exit 2; }
rm -rf $T; mkdir -p $T; cp -a "$SRC" $T/copy; rm -f $T/copy/private/host.lock
# the wallet the old config names must be a folder that exists, or step 1 is not the case it claims to be
OUT=$($BIN watch --run $T/copy --once 2>&1); RC=$?
check "restored copy, unchanged config, old folder present: refused" $([ $RC -ne 0 ] && echo 0 || echo 1) "rc=$RC"
echo "$OUT" | grep -q "outside this campaign folder" ; check "  ... and the message says the wallet is outside this folder" $? "$OUT"
echo "$OUT" | grep -q "Refusing to start" ; check "  ... and says it refuses to start" $? "$OUT"
# the same, with the old folder gone
mv "$SRC" $T/moved-away
cp -a $T/moved-away $T/copy2; rm -f $T/copy2/private/host.lock
OUT=$($BIN watch --run $T/copy2 --once 2>&1); RC=$?
check "restored copy, unchanged config, old folder gone: refused" $([ $RC -ne 0 ] && echo 0 || echo 1) "rc=$RC"
echo "$OUT" | grep -q "does not exist" ; check "  ... and the message says the wallet does not exist and how to fix it" $? "$OUT"
mv $T/moved-away "$SRC"
# the fix: names inside the copy
python3 - <<PY
import json
p='$T/copy/config.json'; c=json.load(open(p)); c['wallet']='wallet1'; c['identity']='wallet1.age'; json.dump(c,open(p,'w'),indent=2)
PY
OUT=$($BIN watch --run $T/copy --once 2>&1); RC=$?
check "config edited to names inside the copy: it starts and finishes a pass" $RC "$OUT"
echo "$OUT" | grep -q "guard alerts" ; check "  ... and reports its ledger" $? "$OUT"
# the original folder, in its own place, with its older-form config, still starts
OUT=$($BIN watch --run "$SRC" --once 2>&1); RC=$?
check "the original folder, in place, with its older-form config, still starts" $RC "$OUT"
rm -rf $T
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
