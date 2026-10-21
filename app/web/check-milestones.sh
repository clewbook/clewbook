#!/usr/bin/env bash
# Where the back links lead from pages opened on the demo's "Tested milestones" page (app/web/milestones-back-e2e.cjs): builds the demo as
# for Vercel into runs/milestones-test/site, serves it on 127.0.0.1:8797 and runs the test; stops the server at the end. Nothing is deployed.
# Usage: LD_LIBRARY_PATH=<browser libraries> app/web/check-milestones.sh     (LIVE=1 ... checks the deployed demo and test site instead)
set -uo pipefail
cd "$(dirname "$0")/../.."
if [ -n "${LIVE:-}" ]; then
  LIVE=1 DEMO=https://clewbook.xyz/demo/ timeout 1200 node app/web/milestones-back-e2e.cjs
  exit $?
fi
SITE=runs/milestones-test/site
bash app/web/make-vercel.sh "$SITE" > /dev/null || exit 1
python3 -m http.server 8797 --bind 127.0.0.1 --directory "$SITE" > runs/milestones-test/server.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null' EXIT
for _ in $(seq 1 20); do curl -s -o /dev/null --max-time 2 http://127.0.0.1:8797/demo/ && break; sleep 0.5; done
DEMO=http://127.0.0.1:8797/demo/ SITE="$PWD/$SITE" timeout 1200 node app/web/milestones-back-e2e.cjs
