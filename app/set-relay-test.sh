#!/usr/bin/env bash
# ./run.sh set-relay on a COPY of a testnet campaign folder (default runs/restore-test/restored), with the practice relay as the new address.
# Checks: a look changes nothing; --yes changes only the dead address; a copy of the old file is kept; the rules and the campaign id are untouched
# (the address is not part of the campaign); a bad or silent address is refused; and a running host picks the new address up on its own, without a
# restart. From the repository root. Needs the testnet server for the last check.
set -uo pipefail
SRC=${FOLDER:-runs/restore-test/restored}; T=runs/set-relay-test; failed=0
check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
rm -rf $T; mkdir -p $T; cp -a "$SRC" $T/c1; rm -f $T/c1/private/host.lock
python3 - <<PY
import json
p='$T/c1/config.json'; c=json.load(open(p)); c['wallet']='wallet1'; c['identity']='wallet1.age'; json.dump(c,open(p,'w'))
PY
./run.sh start practice-relay >/dev/null; NEW=http://127.0.0.1:8794
printf 'http://127.0.0.1:9\nhttp://127.0.0.1:8787\n' > $T/c1/private/relays
H0=$(sha256sum $T/c1/rules.json $T/c1/rules_id | sha256sum); ID=$(cat $T/c1/rules_id)
OUT=$(./run.sh set-relay $NEW $T/c1); [[ "$OUT" == *"would become: http://127.0.0.1:8794, http://127.0.0.1:8787"* && "$OUT" == *"only a look"* ]]; check "a look shows the change and says it was only a look" $? "$OUT"
[ "$(cat $T/c1/private/relays)" = "$(printf 'http://127.0.0.1:9\nhttp://127.0.0.1:8787')" ]; check "  ... and changed nothing" $? ""
OUT=$(./run.sh set-relay $NEW $T/c1 --yes); [[ "$OUT" == *"changed $T/c1/private/relays"* && "$OUT" == *"WHAT TO RESTART: nothing"* ]]; check "--yes applies it and says nothing needs a restart" $? "$OUT"
[ "$(cat $T/c1/private/relays)" = "$(printf 'http://127.0.0.1:8794\nhttp://127.0.0.1:8787')" ]; check "only the dead address was replaced; the one that answers was kept" $? "$(cat $T/c1/private/relays)"
ls $T/c1/private/relays.before-* >/dev/null 2>&1; check "a copy of the old file was kept" $? ""
[ "$(grep -c . $(ls $T/c1/private/relays.before-* | head -1))" = 2 ] && grep -q "127.0.0.1:9" $(ls $T/c1/private/relays.before-* | head -1); check "  ... and it holds the old addresses" $? ""
[ "$(sha256sum $T/c1/rules.json $T/c1/rules_id | sha256sum)" = "$H0" ]; check "the rules and the campaign id are untouched (the address is not part of the campaign)" $? ""
python3 -c "import json;r=open('$T/c1/rules.json').read();assert 'http' not in r"; check "the signed rules contain no address at all" $? ""
OUT=$(./run.sh set-relay $NEW $T/c1 --yes); [[ "$OUT" == *"nothing to change"* ]]; check "running it again changes nothing" $? "$OUT"
OUT=$(./run.sh set-relay http://127.0.0.1:9 $T/c1 --yes 2>&1); RC=$?; [ $RC = 1 ] && [[ "$OUT" == *"does not answer. Nothing was changed"* ]]; check "an address that does not answer is refused" $? "$OUT"
OUT=$(./run.sh set-relay not-an-address $T/c1 --yes 2>&1); [ $? = 2 ]; check "something that is not an address is refused" $? "$OUT"
OUT=$(./run.sh set-relay $NEW /nonexistent --yes 2>&1); [ $? = 2 ]; check "a folder that is not a campaign is refused" $? "$OUT"
printf 'http://127.0.0.1:8787\n' > $T/c1/private/relays
OUT=$(./run.sh set-relay $NEW $T/c1 --replace http://127.0.0.1:8787 --yes); [ "$(cat $T/c1/private/relays)" = "http://127.0.0.1:8794" ]; check "--replace swaps exactly the named address, even one that still answers" $? "$(cat $T/c1/private/relays)"
OUT=$(./run.sh set-relay $NEW --all 2>&1); [[ "$OUT" == *"skipped"* || "$OUT" == *"nothing to change"* || "$OUT" == *"would become"* ]]; check "--all runs, and only looks without --yes" $? ""
# --all only looks at open real-network campaigns: a watched test campaign is skipped, and --add is the way to add an address on purpose
printf 'http://127.0.0.1:8787\n' > $T/c1/private/relays
OUT=$(./run.sh set-relay $NEW --all 2>&1); [[ "$OUT" == *"skipped $T/c1 (a test-network campaign: name it explicitly"* && "$OUT" != *"$T/c1  (campaign"* ]]; check "--all skips a test-network campaign (it is never given a real-network address by accident)" $? "$(echo "$OUT" | grep "$T/c1")"
OUT=$(./run.sh set-relay $NEW $T/c1 --add --yes 2>&1); [ "$(cat $T/c1/private/relays)" = "$(printf 'http://127.0.0.1:8787\nhttp://127.0.0.1:8794')" ]; check "--add adds the address and keeps the one that answers" $? "$(cat $T/c1/private/relays)"
OUT=$(./run.sh set-relay $NEW $T/c1 --add --yes 2>&1); [[ "$OUT" == *"nothing to change"* ]]; check "adding what is already there changes nothing" $? "$OUT"
# a running host reads the file on every check: no restart
printf 'http://127.0.0.1:9\n' > $T/c1/private/relays
mkdir -p $T/relay-new
./app/target/release/ll-relay serve --dir $T/relay-new --listen 127.0.0.1:8796 >/dev/null 2>&1 & RL=$!; sleep 1
./run.sh start watcher $T/c1 >/dev/null; sleep 20
curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8796/v1/campaigns/$ID | grep -q 404; check "before: the new relay does not hold the campaign (the host cannot reach its stored address)" $? ""
./run.sh set-relay http://127.0.0.1:8796 $T/c1 --yes >/dev/null
GOT=000; for i in $(seq 1 30); do GOT=$(curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8796/v1/campaigns/$ID); [ "$GOT" = 200 ] && break; sleep 2; done
[ "$GOT" = 200 ]; check "after set-relay the running host published the campaign to the new relay by itself, with no restart ($GOT)" $? ""
./run.sh stop watcher $T/c1 >/dev/null; kill $RL 2>/dev/null; ./run.sh stop practice-relay >/dev/null
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
