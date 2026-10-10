#!/usr/bin/env bash
# Campaign names, end to end on the testnet (no money moves; wallets are only created):
#   1. the command line refuses a bad name (too long, markup, invisible characters) and creates nothing;
#   2. three named campaigns are created and published to the two local relays: an ordinary name, a 60-character name, and a name with unusual
#      but allowed characters (accents, Japanese, an ampersand, quotes, text that looks like an HTML entity);
#   3. the dashboard (on its own port) refuses bad names through its form API without creating a folder, accepts a good one, and lists it by name;
#   4. polish-b-e2e.cjs checks every page against them, and against the static examples (one without a name, one with).
# From the repository root; needs the two local relays (8787, 8788), a built static folder (app/web/make-static.sh runs/static-polish), and
# Chromium's libraries on LD_LIBRARY_PATH. Env: DASH_PORT (default 8781).
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=./app/target/release; D=runs/polish-b; P=${DASH_PORT:-8781}
# its own two relays on spare ports, started from the current build: a relay built before names existed refuses a named campaign
# (it cannot reproduce the rules_id without the name), so the long-running local relays are not used here
R1=http://127.0.0.1:8791; R2=http://127.0.0.1:8792
failed=0; check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
rm -rf $D; mkdir -p $D $D/relay1 $D/relay2
$BIN/ll-relay serve --dir $D/relay1 --listen 127.0.0.1:8791 > $D/relay1.log 2>&1 & RL1=$!
$BIN/ll-relay serve --dir $D/relay2 --listen 127.0.0.1:8792 > $D/relay2.log 2>&1 & RL2=$!
trap 'kill $RL1 $RL2 $SRV 2>/dev/null' EXIT
sleep 1
mkwallet() { local run=$1; mkdir -p $run; for n in 1 2 3 4 5; do timeout 45 $ZD wallet -w $run/wallet$n init --name campaign -i $run/wallet$n.age -n test >/dev/null 2>&1 && { echo $run/wallet$n; return 0; }; done; return 1; }

# 1. refusals on the command line
W=$(mkwallet $D/bad) || { echo "could not create a wallet"; exit 1; }
LONG=$(python3 -c "print('x'*61)")
for case in "too long:$LONG" "markup:<b>hi</b>" "angle sign:a > b" "invisible:evil$(printf '\xe2\x80\xae')txt" $'line break:two\nlines' "double space:a  b"; do
  label=${case%%:*}; nm=${case#*:}
  OUT=$($BIN/ll-host create --run $D/bad --wallet $W --identity $W.age --goal-zat 5000000 --deadline-in 400 --name "$nm" 2>&1); RC=$?
  check "command line refuses a name that is $label" $([ $RC -ne 0 ] && echo 0 || echo 1) "$OUT"
  [ ! -f $D/bad/rules.json ] && [ ! -f $D/bad/config.json ]; check "  ... and creates nothing" $? "a campaign was created"
done
echo "$($BIN/ll-host create --run $D/bad --wallet $W --identity $W.age --goal-zat 5000000 --deadline-in 400 --name "$LONG" 2>&1)" | grep -q "1 to 60 characters"; check "the refusal says the limit in plain words" $? ""

# 2. three named campaigns, plus one nameless, on the two local relays
mk() { # dir name
  local out; out=$(CAMPAIGN_NAME="$2" NOWATCH=1 RUN=$D/$1 RELAY1=$R1 RELAY2=$R2 timeout 300 ./app/web/start-test-campaign.sh 5000000 400 2>&1) || { echo "$out"; return 1; }
  cat $D/$1/rules_id; }
ODD='Café ☕ & 東京 – "mast" #1 100% &lt;b&gt;'
export ID_PLAIN=$(NOWATCH=1 RUN=$D/plain RELAY1=$R1 RELAY2=$R2 timeout 300 ./app/web/start-test-campaign.sh 5000000 400 >/dev/null 2>&1; cat $D/plain/rules_id)
export ID_SET=$(mk set "Community radio mast")
export ID_LONG=$(mk long "$(python3 -c "print('Long name '+'0123456789'*5)")")
export ID_ODD=$(mk odd "$ODD")
for v in ID_PLAIN ID_SET ID_LONG ID_ODD; do val=${!v}; [ ${#val} = 64 ]; check "created campaign $v" $? "${!v}"; done
python3 - <<PY
import json
for d,want in (("set","Community radio mast"),("odd",'''$ODD'''),("plain",None)):
    r=json.load(open("$D/"+d+"/rules.json")); assert r.get("name")==want,(d,r.get("name"))
assert len(json.load(open("$D/long/rules.json"))["name"])==60
print("PASS  the signed rules hold the name exactly as typed (and none for the nameless one; 60 characters for the long one)")
PY
[ $? = 0 ] || failed=$((failed+1))
python3 -c "
import json;r=json.load(open('$D/plain/rules.json'));assert 'name' not in r;print('PASS  a campaign created without a name has no name key in its rules')" || failed=$((failed+1))

# 3. the dashboard form API
mkdir -p $D/dash
$BIN/ll-host serve --listen 127.0.0.1:$P --runs-dir $D/dash --relay $R1 --relay $R2 > $D/dash.log 2>&1 & SRV=$!
for i in $(seq 1 30); do curl -s -m 2 http://127.0.0.1:$P/api/config >/dev/null && break; sleep 1; done
post() { curl -s -m 200 -X POST -H 'content-type: application/json' -H 'x-dashboard: 1' http://127.0.0.1:$P/api/campaigns -d "$1"; }
BASE='"mode":"raise","goal_zat":5000000,"deadline_in":500,"min_contribution_zat":20000,"ticket_k":30'
for case in "too long|$LONG" "markup|<script>x</script>" "invisible|a$(printf '\xe2\x80\x8b')b"; do
  label=${case%%|*}; nm=${case#*|}
  OUT=$(post "{$BASE,\"name\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$nm")}")
  echo "$OUT" | grep -q '"ok":false' && echo "$OUT" | grep -q "campaign name"; check "dashboard refuses a name that is $label, saying why" $? "$OUT"
  [ -z "$(ls $D/dash | grep campaign-)" ]; check "  ... and creates no folder" $? "$(ls $D/dash)"
done
OUT=$(post "{$BASE,\"name\":\"Dashboard test name\"}")
echo "$OUT" | grep -q '"ok":true'; check "dashboard accepts a good name" $? "$OUT"
LIST=$(curl -s -m 20 -H 'x-dashboard: 1' http://127.0.0.1:$P/api/campaigns)
echo "$LIST" | grep -q '"name":"Dashboard test name"'; check "the dashboard list carries the name" $? "$LIST"
OUT=$(post "{$BASE,\"name\":\"   \"}")
echo "$OUT" | grep -q '"ok":true'; check "a blank name is the same as none (the campaign is created without one)" $? "$OUT"
LIST=$(curl -s -m 20 -H 'x-dashboard: 1' http://127.0.0.1:$P/api/campaigns)
[ "$(echo "$LIST" | grep -o '"name":null' | wc -l)" = 1 ]; check "  ... and the list shows no name for it" $? "$LIST"
# 4. pages (the dashboard stays up for its list and the set-up form)
STATIC=${STATIC:-runs/static-polish}
read -r EX_NAMED EX_NAMED_NAME < <(python3 - <<'PY'
import json,glob
for f in sorted(glob.glob('examples/relay/campaigns/*/rules.json')):
    r=json.load(open(f))
    if r.get('name'): print(f.split('/')[3], r['name']); break
else: print('', '')
PY
)
export EX_NAMED EX_NAMED_NAME
DASH_PORT=$P DIR=$STATIC SHOTS=${SHOTS:-runs/design-shots} timeout 900 node app/web/polish-b-e2e.cjs; check "pages show the name (polish-b-e2e.cjs)" $? ""
kill $SRV $RL1 $RL2 2>/dev/null; trap - EXIT
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
