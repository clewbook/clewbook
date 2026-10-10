#!/usr/bin/env bash
# Recount from a saved copy, end to end. (1) The host's export, by command and through the dashboard, is the same file and holds nothing private.
# (2) The recount page loads it when no relay answers, refuses tampered files, and marks the result as coming from a file (saved-copy-e2e.cjs).
# From the repository root. Needs: a built static folder (app/web/make-static.sh runs/static-polish), the public test-network servers, and Chromium's
# libraries on LD_LIBRARY_PATH. Env: FOLDER (a testnet campaign folder to export; default runs/polish-b2/campaign), STATIC.
set -uo pipefail
F=${FOLDER:-runs/polish-b2/campaign}; STATIC=${STATIC:-runs/static-polish}; T=runs/saved-copy-test; failed=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
rm -rf $T; mkdir -p $T runs/practice/dash
BIN=./app/target/release
# (1) the export: by command
$BIN/ll-host export --run $F --out $T/cli.json >/dev/null; check "ll-host export writes the file" $? ""
$BIN/ll-host export --run $F --out $T/cli.json >/dev/null 2>&1; [ $? != 0 ]; check "  ... and does not overwrite an existing file" $? ""
python3 - <<PY
import json
d=json.load(open('$T/cli.json')); t=open('$T/cli.json').read().lower()
assert d['kind']=='ledger-export' and d['version']==1 and len(d['campaign'])==64 and d['rules'] and isinstance(d['ledger'],list) and len(d['ledger'])>0
for bad in ['ledger_sk','payload_sk','amount_key','secrets.json','seed','wallet','.age','eph_sk','spending','ufvk_private']: assert bad not in t, bad
print("PASS  the export is a ledger-export with the rules and the signed list, and holds no key, wallet or private word")
PY
[ $? = 0 ] || failed=$((failed+1))
# ... and through the dashboard (a copy of the folder under the practice dashboard, which reads the same files)
./run.sh stop practice-dashboard >/dev/null 2>&1; rm -rf runs/practice/dash/*; D=runs/practice/dash/campaign-export; cp -a $F $D; rm -f $D/private/host.lock
python3 - <<PY
import json
p='$D/config.json'; c=json.load(open(p)); c['wallet']='wallet1'; c['identity']='wallet1.age'; json.dump(c,open(p,'w'))
PY
ID=$(cat $D/rules_id); ./run.sh start practice-dashboard >/dev/null; sleep 3
curl -s -m 20 -H 'x-dashboard: 1' http://127.0.0.1:8781/api/campaigns/$ID/export > $T/api.json
cmp -s $T/api.json <($BIN/ll-host export --run $D --out $T/cli2.json >/dev/null && python3 -c "import json;print(json.dumps(json.load(open('$T/cli2.json'))),end='')"); python3 -c "
import json;a=json.load(open('$T/api.json'));b=json.load(open('$T/cli2.json'));assert a==b,'differ'" ; check "the dashboard's export is the same content as the command's" $? ""
[ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Host: evil.example' http://127.0.0.1:8781/api/campaigns/$ID/export)" = 403 ]; check "the export route is refused when the request names another site as its host (the dashboard's own rule)" $? ""
./run.sh stop practice-dashboard >/dev/null
# (2) the page. GOOD: the closed example fundraiser, written as the host's export would be; EXTRA: the real export above.
GOOD=$T/good.json
python3 - <<PY
import json,glob
i='48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f'; d='examples/relay/campaigns/'+i
led=[json.load(open(f)) for f in sorted(glob.glob(d+'/ledger/*.json'))]
json.dump({"kind":"ledger-export","version":1,"campaign":i,"rules":json.load(open(d+'/rules.json')),"ledger":led,"challenges":[]},open('$GOOD','w'))
PY
ID=48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f GOOD=$GOOD EXTRA=$T/cli.json EXTRA_ID=$(python3 -c "import json;print(json.load(open('$T/cli.json'))['campaign'])") DIR=$STATIC TMP_DIR=$T SHOTS=${SHOTS:-runs/design-shots} timeout 1500 node app/web/saved-copy-e2e.cjs; check "the recount page (saved-copy-e2e.cjs)" $? ""
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
