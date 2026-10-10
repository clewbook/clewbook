#!/usr/bin/env bash
# Copies of the list, memory between visits and the comparison with a saved copy, with saved ledgers only (no testnet funds, no network). Needs the artefacts of
# final-copy.sh (runs/final-test: a real closed testnet campaign's export and a forked copy; it runs that script first when they are missing), the test-cheats
# build for the big lists (cd app && CARGO_TARGET_DIR=target-cheat cargo build --release -p ll-host --features test-cheats), the built static folder
# (app/web/make-static.sh runs/static-polish) and Chromium's libraries on LD_LIBRARY_PATH. From the repository root.
set -uo pipefail
T=runs/final-test; CHEAT=./app/target-cheat/release/cb-host; failed=0
[ -s $T/good.json ] && [ -s $T/fork.json ] || bash app/web/final-copy.sh > /dev/null 2>&1
[ -s $T/good.json ] && [ -s $T/fork.json ] || { echo "no fixtures: run app/web/final-copy.sh"; exit 2; }
mkdir -p runs/copies-test
$CHEAT force-big --run $T/c1 --entries 3000 --out runs/copies-test/big-small.json >/dev/null 2>&1 || { echo "FAIL  the test-only build could not make the 3000-entry list"; failed=$((failed+1)); }
$CHEAT force-big --run $T/c1 --entries 20000 --out runs/copies-test/big-large.json >/dev/null 2>&1 || { echo "FAIL  the test-only build could not make the 20000-entry list"; failed=$((failed+1)); }
echo "PASS  the big lists were made ($(du -h runs/copies-test/big-large.json | cut -f1) for the large one)"
GOOD=$T/good.json FORK=$T/fork.json BIG_SMALL=runs/copies-test/big-small.json BIG_LARGE=runs/copies-test/big-large.json DIR=${STATIC:-runs/static-polish} SHOTS=${SHOTS:-runs/design-shots} timeout 1700 node app/web/copies-e2e.cjs; [ $? = 0 ] || failed=$((failed+1))
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
