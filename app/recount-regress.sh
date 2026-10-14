#!/usr/bin/env bash
# Regression proof for changes under app/core: runs the recount over every finished TEST NETWORK campaign folder under runs/
# (offline: it reads the saved rules, ledger and the campaign wallet's database read only) and writes one file of results.
# Run it before and after a change and compare the two files: they must be identical.
# Usage (from the repository root): app/recount-regress.sh <output file> [recount binary, default app/target/release/ll-recount]
# Folders of main network campaigns are skipped: nothing here reads or touches them.
set -uo pipefail
OUT=${1:?output file}; BIN=${2:-app/target/release/ll-recount}
: > "$OUT"
find runs -name rules.json -not -path '*/campaigns/*' 2>/dev/null | sort | while read -r rules; do
  d=$(dirname "$rules")
  case $d in runs/mainnet-*) continue;; esac
  grep -q '"network": *"main"' "$rules" && continue
  [ -f "$d/rules_id" ] && [ -d "$d/ledger" ] || continue
  # the wallet that scanned with the campaign's viewing key: the first candidate whose key matches
  res=""; rc=9
  for w in "$d/viewer" "$d"/wallet* "$d/host" "$d/../viewer" "$d/../host" ""; do
    [ -n "$w" ] && [ ! -f "$w/data.sqlite" ] && continue
    args=(--rules "$rules" --rules-id "$(cat "$d/rules_id")" --ledger "$d/ledger")
    [ -d "$d/challenges" ] && args+=(--challenges "$d/challenges")
    res=$("$BIN" "${args[@]}" ${w:+--wallet "$w"} 2>&1); rc=$?
    echo "$res" | grep -q "does not hold the campaign's viewing key\|has not revealed its viewing key\|pass --wallet" && [ -n "$w" ] && continue
    break
  done
  { echo "=== $d exit=$rc"; echo "$res"; } >> "$OUT"
done
echo "folders: $(grep -c '^===' "$OUT")  exit codes: $(grep '^===' "$OUT" | sed 's/.*exit=//' | sort | uniq -c | tr '\n' ' ')"
