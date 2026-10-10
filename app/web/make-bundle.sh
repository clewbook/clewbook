#!/usr/bin/env bash
# Packages a finished test campaign for the browser recount, with the CLI's output as the
# expected result. Usage: app/web/make-bundle.sh <run dir> <name>
set -euo pipefail
RUN=$1; NAME=$2
ZD=./target/release/zcash-devtool
OUT=app/web/www/bundles; mkdir -p "$OUT"
"$ZD" wallet -w "$RUN/viewer" sync >/dev/null 2>&1
"$ZD" wallet -w "$RUN/viewer" enhance >/dev/null 2>&1
EXPECTED=$(./app/target/release/ll-recount --rules "$RUN/rules.json" --rules-id "$(cat "$RUN/rules_id")" \
    --ledger "$RUN/ledger" --wallet "$RUN/viewer" || true)
python3 - "$RUN" "$OUT/$NAME.json" "$EXPECTED" <<'PY'
import json, os, sqlite3, sys
run, out, expected = sys.argv[1], sys.argv[2], sys.argv[3] + "\n"
rules = json.load(open(f"{run}/rules.json"))
ledger = [json.load(open(f"{run}/ledger/{f}")) for f in sorted(os.listdir(f"{run}/ledger"))]
ufvk = rules.get("campaign_ufvk") or next(e["close"]["ufvk"] for e in ledger if e["kind"] == "close")
tip = sqlite3.connect(f"file:{run}/viewer/data.sqlite?mode=ro", uri=True).execute("select max(height) from blocks").fetchone()[0]
json.dump({"network": rules["network"], "ufvk": ufvk, "start": rules["start_height"], "end": tip,
           "rules": rules, "rules_id": open(f"{run}/rules_id").read().strip(), "ledger": ledger,
           "challenges": [], "expected": expected}, open(out, "w"), indent=1)
print(f"{out}: blocks {rules['start_height']}..{tip}, {len(ledger)} ledger entries")
PY
