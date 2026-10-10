#!/usr/bin/env bash
# The dashboard's warnings about a campaign's stored relay address, on the practice dashboard (testnet, port 8781, relay 8794) with a COPY of a
# testnet campaign folder: an address that is gone gives "is not reachable" and "differs from the relay the dashboard runs with", each with the exact
# fix command; running that command clears both without a restart. From the repository root; needs the testnet server.
set -uo pipefail
SRC=${FOLDER:-runs/restore-test/restored}; failed=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
./run.sh stop practice-dashboard >/dev/null 2>&1; ./run.sh stop practice-relay >/dev/null 2>&1
rm -rf runs/practice/dash; mkdir -p runs/practice/dash runs/practice/relay
D=runs/practice/dash/campaign-test; cp -a "$SRC" $D; rm -f $D/private/host.lock
python3 - <<PY
import json
p='$D/config.json'; c=json.load(open(p)); c['wallet']='wallet1'; c['identity']='wallet1.age'; json.dump(c,open(p,'w'))
PY
printf 'http://127.0.0.1:9\n' > $D/private/relays; ID=$(cat $D/rules_id)
./run.sh start practice-relay >/dev/null; ./run.sh start practice-dashboard >/dev/null
api() { curl -s -m 10 -H 'x-dashboard: 1' http://127.0.0.1:8781/api/campaigns/$ID; }
W=""; for i in $(seq 1 40); do W=$(api | python3 -c "import sys,json;print('\n'.join(w['text'] for w in json.load(sys.stdin).get('warnings',[])))" 2>/dev/null); [[ "$W" == *"is not reachable"* ]] && break; sleep 3; done
[[ "$W" == *"http://127.0.0.1:9 is not reachable"* ]]; check "an address that is gone gives the 'not reachable' warning" $? "$W"
[[ "$W" == *"publishes to http://127.0.0.1:9 but the dashboard is running with the relay address http://127.0.0.1:8794"* ]]; check "a stored address that differs from the dashboard's own gives the 'differs' warning, naming both" $? "$W"
CMD="./run.sh set-relay http://127.0.0.1:8794 $D --yes"
[[ "$W" == *"$CMD"* ]]; check "both carry the exact fix command" $? "$CMD"
[[ "$W" == *"No restart is needed"* ]]; check "and say that no restart is needed" $? ""
bash -c "$CMD" >/dev/null 2>&1; check "the fix command runs" $? ""
W2="x"; for i in $(seq 1 40); do W2=$(api | python3 -c "import sys,json;print('\n'.join(w['text'] for w in json.load(sys.stdin).get('warnings',[])))" 2>/dev/null); [[ "$W2" != *"is not reachable"* && "$W2" != *"publishes to"* ]] && break; sleep 3; done
[[ "$W2" != *"is not reachable"* && "$W2" != *"publishes to"* ]]; check "after the fix both warnings are gone, without restarting the dashboard" $? "$W2"
./run.sh stop practice-dashboard >/dev/null; ./run.sh stop practice-relay >/dev/null
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
