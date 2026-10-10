#!/usr/bin/env bash
# The final public copy and its fingerprint, on a copy of a CLOSED testnet campaign folder (default runs/unticketed-met-new/campaign): the host step that writes
# the copy and the signed record (and does it again without change), the relay that keeps the record, the dashboard line, the export that carries it, and the
# recount page (final-fp-e2e.cjs) with a full, a cut-off, a cut-off-and-stripped, a forked and a changed-record copy. No money moves.
# From the repository root. Needs the test-cheats build for the fork (cd app && CARGO_TARGET_DIR=target-cheat cargo build --release -p ll-host --features test-cheats),
# the built static folder (app/web/make-static.sh runs/static-polish), and Chromium's libraries on LD_LIBRARY_PATH.
set -uo pipefail
SRC=${FOLDER:-runs/unticketed-met-new/campaign}; T=runs/final-test; BIN=./app/target/release; CHEAT=./app/target-cheat/release/cb-host; failed=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
rm -rf $T; mkdir -p $T $T/relay; cp -a $SRC $T/c1; rm -f $T/c1/private/host.lock; rm -rf $T/c1/public
python3 - <<PY
import json
p='$T/c1/config.json'; c=json.load(open(p)); c['wallet']='wallet1'; c['identity']='wallet1.age'; json.dump(c,open(p,'w'))
PY
ID=$(cat $T/c1/rules_id)
OUT=$($BIN/cb-host finalize --run $T/c1 2>&1); [[ "$OUT" == *"final copy saved in"* && "$OUT" == *"entries, last entry"* ]]; check "finalize writes the final copy and prints the fingerprint line" $? "$OUT"
ls $T/c1/public/final.json $T/c1/public/final-ledger.json >/dev/null 2>&1; check "  ... as public/final.json and public/final-ledger.json" $? ""
M1=$(stat -c %Y $T/c1/public/final.json); sleep 1; OUT2=$($BIN/cb-host finalize --run $T/c1 2>&1); M2=$(stat -c %Y $T/c1/public/final.json)
[[ "$OUT2" != *"saved in"* && "$M1" = "$M2" ]]; check "run again it changes nothing (the record is not rewritten)" $? "$OUT2"
python3 - <<PY
import json
r=json.load(open('$T/c1/public/final.json')); c=json.load(open('$T/c1/public/final-ledger.json'))
assert r['v']==1 and r['rules_id']=='$ID' and r.get('sig') and r['entries']==len(c['ledger']) and c['final']==r
for bad in ['ledger_sk','payload_sk','amount_key','secrets','seed','wallet']: assert bad not in json.dumps(c).lower(), bad
print("PASS  the copy holds the rules, the list and the signed record, and nothing private")
PY
[ $? = 0 ] || failed=$((failed+1))
$BIN/cb-host export --run $T/c1 --out $T/good.json >/dev/null; python3 -c "
import json;a=json.load(open('$T/good.json'));b=json.load(open('$T/c1/public/final-ledger.json'));assert a==b" ; check "the host's export is the same file and carries the record" $? ""
# a fresh campaign before its close has no final record
$BIN/cb-host finalize --run runs/polish-b2/campaign > $T/open.out 2>&1; [ $? != 0 ] && grep -q "not closed yet" $T/open.out; check "a campaign that is not closed has nothing to finalize (it says so)" $? "$(cat $T/open.out | head -2)"
# the relay keeps the record, once the list is there
$BIN/cb-relay serve --dir $T/relay --listen 127.0.0.1:8811 > $T/relay.log 2>&1 & RL=$!; sleep 1
trap 'kill $RL $SRV 2>/dev/null' EXIT
printf 'http://127.0.0.1:8811\n' > $T/c1/private/relays
$BIN/cb-host publish --run $T/c1 --relay http://127.0.0.1:8811 > /dev/null 2>&1
$BIN/cb-host finalize --run $T/c1 > /dev/null 2>&1
curl -s -m 5 http://127.0.0.1:8811/v1/campaigns/$ID/final > $T/relay-final.json; cmp -s <(python3 -c "import json;print(json.dumps(json.load(open('$T/relay-final.json')),sort_keys=True))") <(python3 -c "import json;print(json.dumps(json.load(open('$T/c1/public/final.json')),sort_keys=True))"); check "the relay serves the same record" $? ""
# the dashboard shows the line (practice dashboard on a copy)
./run.sh stop practice-dashboard >/dev/null 2>&1; rm -rf runs/practice/dash/*; D=runs/practice/dash/campaign-final; cp -a $T/c1 $D; rm -f $D/private/host.lock; printf 'http://127.0.0.1:8794\n' > $D/private/relays
./run.sh start practice-dashboard >/dev/null; sleep 4
LINE=$(curl -s -m 10 -H 'x-dashboard: 1' http://127.0.0.1:8781/api/campaigns/$ID | python3 -c "import sys,json;print((json.load(sys.stdin).get('final') or {}).get('line',''))"); python3 -c "import json;r=json.load(open('$T/c1/public/final.json'));import sys;sys.exit(0 if '$LINE'==f\"{r['entries']} entries, last entry {r['last_hash']}\" else 1)"; check "the dashboard shows the fingerprint line" $? "$LINE"
./run.sh stop practice-dashboard >/dev/null
# the files for the page test
python3 - <<PY
import json
g=json.load(open('$T/good.json'))
c=json.loads(json.dumps(g)); c['ledger']=c['ledger'][:-1]; json.dump(c,open('$T/cut.json','w'))
n=json.loads(json.dumps(c)); n['final']=None; json.dump(n,open('$T/cut-norec.json','w'))
PY
$CHEAT force-fork --run $T/c1 --out $T/fork.json >/dev/null 2>&1; [ -s $T/fork.json ]; check "a forked copy was made (test-cheats build: the same key signed a different close entry)" $? ""
ID=$ID GOOD=$T/good.json CUT=$T/cut.json CUT_NOREC=$T/cut-norec.json FORK=$T/fork.json RELAY=http://127.0.0.1:8811 DIR=${STATIC:-runs/static-polish} SHOTS=${SHOTS:-runs/design-shots} timeout 1500 node app/web/final-fp-e2e.cjs; check "the recount page (final-fp-e2e.cjs)" $? ""
kill $RL 2>/dev/null; trap - EXIT
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
