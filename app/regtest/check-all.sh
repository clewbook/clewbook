#!/usr/bin/env bash
# Every private chain check of the sealed bid auction, one after the other (each starts and stops its own chain), with a summary at the end.
# About an hour and a half. Usage: ZEBRAD=... BIN=... LD_LIBRARY_PATH=<browser libraries> app/regtest/check-all.sh <runs folder>
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
R=${1:?runs folder}
mkdir -p "$R"
R=$(cd "$R" && pwd)
declare -a RESULTS
run() { # $1 name, $2... command
  local name=$1; shift
  echo "=== $name"
  if timeout 3000 "$@" > "$R/$name.out" 2>&1; then RESULTS+=("PASS $name"); else RESULTS+=("FAIL $name (see $R/$name.out)"); fi
  tail -2 "$R/$name.out"
}
run ordinary "$HERE/check-ordinary.sh" "$R/ordinary"
run intake "$HERE/check-sealed-intake.sh" "$R/intake"
run close "$HERE/check-sealed-close.sh" "$R/close"
run pages "$HERE/check-pages.sh" "$R/close"
run dashboard "$HERE/check-dashboard.sh" "$R/dashboard"
run e2e "$HERE/check-e2e.sh" "$R/e2e"
echo "=== summary"
printf '%s\n' "${RESULTS[@]}"
