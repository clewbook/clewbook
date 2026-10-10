#!/usr/bin/env bash
# Tests ./run.sh on this machine without touching the real programs: start / stop / restart on the practice programs and on a watcher for a
# testnet campaign folder, and the refusals for the risky ones (they are only asked WITHOUT --yes, so nothing real can stop). From the repository root.
# Needs a testnet campaign folder (default runs/restore-test/restored) for the watcher part.
set -uo pipefail
F=${FOLDER:-runs/restore-test/restored}; failed=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
up() { curl -s -m 3 -o /dev/null "http://127.0.0.1:$1/$2"; }
OUT=$(./run.sh status); RC=$?; check "status runs" $RC "$OUT"
for n in $(./run.sh names); do [ "$n" = watcher ] && continue; echo "$OUT" | grep -q "^$n\b" || [ "${n#practice-}" != "$n" ] || [ "$n" = tunnel-stable ]; check "status lists $n" $? ""; done
for n in $(./run.sh names); do [ "$n" = watcher ] && continue; C=$(./run.sh command $n); [ -n "$C" ]; check "command $n prints a command" $? "$C"; done
./run.sh command nonsense >/dev/null 2>&1; [ $? = 2 ]; check "an unknown name is refused" $? ""
# every real program: the command the script would use is exactly the one it runs now (the sandbox cannot show this for the real ones, so compare)
for n in pageserver relay-testnet-1 relay-testnet-2 relay-demo relay-mainnet tunnel-page tunnel-demo tunnel-mainnet dashboard; do
  pid=$(./run.sh status | awk -v n=$n '$1==n && $3=="up" {print $4}'); [ -z "$pid" ] && { echo "SKIP  $n is not running, command not compared"; continue; }
  [ "$(ps -o args= -p $pid)" = "$(./run.sh command $n | sed 's/ *$//' | sed 's#/cb-#/ll-#')" ]; check "the command for $n is the one it was started with (process $pid)" $? "$(ps -o args= -p $pid) vs $(./run.sh command $n)"
done
# the sandbox
for n in practice-relay practice-page practice-dashboard; do ./run.sh stop $n >/dev/null 2>&1; done
[[ "$(./run.sh start practice-relay)" == *"started"* ]]; check "start practice-relay" $? ""; up 8794 v1/campaigns/x; check "  ... and it answers on its port" $? ""
[[ "$(./run.sh start practice-relay)" == *"already running"* ]]; check "starting it again says it is already running" $? ""
P1=$(./run.sh status | awk '$1=="practice-relay" {print $4}'); [ -n "$P1" ]; check "status shows it, with its process number ($P1)" $? ""
[[ "$(./run.sh restart practice-relay)" == *"started"* ]]; P2=$(./run.sh status | awk '$1=="practice-relay" {print $4}'); [ -n "$P2" ] && [ "$P1" != "$P2" ]; check "restart gives a new process ($P1 -> $P2)" $? ""
[[ "$(./run.sh stop practice-relay)" == *"stopped"* ]]; up 8794 v1/campaigns/x; [ $? != 0 ]; check "stop practice-relay: the port is free" $? ""
[[ "$(./run.sh stop practice-relay)" == *"not running"* ]]; check "stopping a stopped program says so" $? ""
[[ "$(./run.sh start practice-page)" == *"started"* ]]; up 8795 index.html; check "practice-page starts and serves the pages" $? ""; ./run.sh stop practice-page >/dev/null
[[ "$(./run.sh start practice-dashboard)" == *"started"* ]]; sleep 1; curl -s -m 3 http://127.0.0.1:8781/api/config | grep -q '"ok":true'; check "practice-dashboard starts and answers" $? ""
[[ "$(./run.sh logs practice-dashboard)" == *"log file: runs/logs/practice-dashboard.log"* ]]; check "logs says where the log is" $? ""
[[ "$(./run.sh stop practice-dashboard)" == *"stopped"* ]]; check "practice-dashboard stops" $? ""
# the risky ones refuse without --yes, and nothing happens
for n in dashboard relay-mainnet tunnel-page tunnel-mainnet pageserver; do
  before=$(./run.sh status | awk -v n=$n '$1==n {print $4}'); ./run.sh stop $n >/dev/null 2>&1; rc=$?; after=$(./run.sh status | awk -v n=$n '$1==n {print $4}')
  [ $rc = 3 ] && [ "$before" = "$after" ]; check "stop $n without --yes is refused and the process is unchanged ($before)" $? "rc=$rc after=$after"
  ./run.sh restart $n >/dev/null 2>&1; [ $? = 3 ]; check "restart $n without --yes is refused" $? ""
done
# a watcher for a campaign folder, and the "not watched" line
if [ -f $F/rules.json ]; then
  [[ "$(./run.sh status --all | grep -A1 "$F")" == *"NOT WATCHED"* ]]; check "status says a campaign folder nobody watches is NOT WATCHED, with the command to start it" $? ""
  [[ "$(./run.sh start watcher $F)" == *"started"* ]]; check "start watcher $F" $? ""
  [[ "$(./run.sh status --all | grep -A1 "$F")" == *"watched by watcher"* ]]; check "status then shows it as watched" $? ""
  [[ "$(./run.sh stop watcher $F)" == *"stopped"* ]]; check "stop watcher $F" $? ""
  ./run.sh start watcher /nonexistent >/dev/null 2>&1; [ $? != 0 ]; check "a watcher for a folder that is not a campaign is refused" $? ""
else echo "SKIP  no campaign folder at $F for the watcher part"; fi
left=$(ps -eo args= | grep -E "runs/practice|serve.py 8795" | grep -v grep | wc -l); [ "$left" = 0 ]; check "no practice program is left running" $? "$left"
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
