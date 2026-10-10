#!/usr/bin/env bash
# The host's "last seen" signal, end to end on the testnet (no money): two relays from the current build; one campaign watched by the current host
# (it publishes the signed heartbeat on every check), one that nobody watches; the host program does not complain about a relay that is too old to
# know heartbeats; then heartbeat-e2e.cjs checks the contributor page (fresh, stale, missing, forged). From the repository root; needs the testnet
# server and Chromium's libraries on LD_LIBRARY_PATH; a built static folder (app/web/make-static.sh runs/static-polish). Takes about 5 minutes.
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=./app/target/release; D=runs/heartbeat-test; failed=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
rm -rf $D; mkdir -p $D/relay1 $D/relay2
$BIN/ll-relay serve --dir $D/relay1 --listen 127.0.0.1:8797 > $D/relay1.log 2>&1 & R1=$!
$BIN/ll-relay serve --dir $D/relay2 --listen 127.0.0.1:8798 > $D/relay2.log 2>&1 & R2=$!
trap 'kill $R1 $R2 2>/dev/null; ./run.sh stop watcher $D/live >/dev/null 2>&1; ./run.sh stop watcher $D/old >/dev/null 2>&1' EXIT
sleep 1
mk() { NOWATCH=1 RUN=$D/$1 RELAY1=http://127.0.0.1:8797 RELAY2=http://127.0.0.1:8798 timeout 300 ./app/web/start-test-campaign.sh 5000000 400 > $D/$1.start.log 2>&1 && cat $D/$1/rules_id; }
ID=$(mk live); ID_NONE=$(mk none); [ ${#ID} = 64 ] && [ ${#ID_NONE} = 64 ]; check "two campaigns created and published to the two relays" $? "$ID $ID_NONE"
./run.sh start watcher $D/live > /dev/null
for i in $(seq 1 40); do curl -s -m 5 -f http://127.0.0.1:8797/v1/campaigns/$ID/heartbeat > $D/hb.json 2>/dev/null && break; sleep 3; done
python3 - <<PY
import json,time
h=json.load(open('$D/hb.json')); assert h['v']==1 and h['rules_id']=='$ID' and h.get('sig') and abs(time.time()-h['time'])<300 and h['height']>0
print("PASS  the running host published a signed heartbeat (height %d, %d s old)"%(h['height'],time.time()-h['time']))
PY
[ $? = 0 ] || failed=$((failed+1))
sleep 20; H1=$(python3 -c "import json;print(json.load(open('$D/hb.json'))['time'])"); curl -s -m 5 http://127.0.0.1:8798/v1/campaigns/$ID/heartbeat > $D/hb2.json; H2=$(python3 -c "import json;print(json.load(open('$D/hb2.json'))['time'])")
[ "$H2" -ge "$H1" ]; check "the second relay holds one too, and it is renewed on every check" $? "$H1 $H2"
curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8797/v1/campaigns/$ID_NONE/heartbeat | grep -q 404; check "a campaign nobody watches has none (404)" $? ""
# a relay that is too old to know heartbeats (the long-running test relay 8788 was built before): the host must not complain about it on every check
cp -a $D/live $D/old; rm -f $D/old/private/host.lock; printf 'http://127.0.0.1:8788\n' > $D/old/private/relays; ./run.sh stop watcher $D/live >/dev/null
OLD_OK=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X PUT -d '{}' http://127.0.0.1:8788/v1/campaigns/$ID/heartbeat)
./run.sh start watcher $D/old > /dev/null; sleep 40
if [ "$OLD_OK" = 404 ]; then ! grep -q "heartbeat to" runs/logs/watcher_runs_heartbeat-test_old.log; check "a relay without the heartbeat route is not complained about (log has no 'heartbeat to' lines)" $? "$(grep 'heartbeat to' runs/logs/watcher_runs_heartbeat-test_old.log | head -2)"; else echo "SKIP  relay 8788 knows heartbeats ($OLD_OK): the old-relay check does not apply"; fi
./run.sh stop watcher $D/old >/dev/null; ./run.sh start watcher $D/live >/dev/null; sleep 20
ID=$ID ID_NONE=$ID_NONE RELAY1=http://127.0.0.1:8797 RELAY2=http://127.0.0.1:8798 DIR=${STATIC:-runs/static-polish} SHOTS=${SHOTS:-runs/design-shots} timeout 900 node app/web/heartbeat-e2e.cjs; check "the contributor page (heartbeat-e2e.cjs)" $? ""
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
