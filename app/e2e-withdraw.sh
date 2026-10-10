#!/usr/bin/env bash
# Early withdrawal on testnet: a contributor broadcasts their own ticket well before the
# deadline; the recount must count it as withdrawn (R5 PASS), not as a refund.
set -euo pipefail

ZD=./target/release/zcash-devtool
BIN=./app/target/release
RUN=${RUN:-runs/withdraw-$(date -u +%Y%m%dT%H%M%SZ)}
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
say() { echo; echo "== [$(date -u +%H:%M:%SZ)] $*"; }

say "1. New campaign wallet and raise (deadline in 20 blocks)"
mkdir -p "$RUN"
"$ZD" wallet -w "$RUN/wallet" init --name campaign-E -i "$RUN/wallet.age" -n test >/dev/null 2>&1
$BIN/ll-host create --run "$RUN" --wallet "$RUN/wallet" --identity "$RUN/wallet.age" --goal-zat 5000000 --deadline-in $((20 * ${BLOCK_SCALE:-3}))
DEADLINE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["deadline_height"])' "$RUN/rules.json")

say "2. Contribution"
$BIN/ll-contrib keygen --out "$RUN/e1.seed" >/dev/null
MEMO=$($BIN/ll-contrib memo --rules "$RUN/rules.json" --seed "$RUN/e1.seed" --refund-address "$(addr bidder)")
"$ZD" wallet -w bidder sync >/dev/null 2>&1
TXID=$(echo y | "$ZD" wallet -w bidder send -i bidder.age --address "$(cat "$RUN/address")" --value 1000000 \
    --memo "$MEMO" --min-confirmations 1 2>&1 | grep -oE '^[0-9a-f]{64}$')
echo "   txid $TXID"

say "3. Host issues the ticket"
until [ -f "$RUN/ledger/000000.json" ]; do $BIN/ll-host watch --run "$RUN" --once | grep -v "0 new" | sed 's/^/   /' || true; sleep 10; done
ACTION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contribution"]["action"])' "$RUN/ledger/000000.json")

say "4. Contributor withdraws immediately (deadline $DEADLINE)"
$BIN/ll-contrib open-ticket --seed "$RUN/e1.seed" --ledger "$RUN/ledger" --tickets "$RUN/tickets" \
    --contribution "$TXID:$ACTION" --out "$RUN/e1.ticket.hex" | sed 's/^/   /'
$BIN/ll-contrib broadcast --raw "$RUN/e1.ticket.hex" | sed 's/^/   /'

say "5. Recount once the withdrawal is mined (still before the deadline)"
"$ZD" wallet -w "$RUN/viewer" init-fvk --name viewer --birthday $(( $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["start_height"])' "$RUN/rules.json") - 2 )) \
    --fvk "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["campaign_ufvk"])' "$RUN/rules.json")" >/dev/null 2>&1
for _ in $(seq 1 40); do
    "$ZD" wallet -w "$RUN/viewer" sync >/dev/null 2>&1; "$ZD" wallet -w "$RUN/viewer" enhance >/dev/null 2>&1
    OUT=$($BIN/ll-recount --rules "$RUN/rules.json" --rules-id "$(cat "$RUN/rules_id")" --ledger "$RUN/ledger" --wallet "$RUN/viewer" || true)
    echo "$OUT" | grep -q "withdrawn early 0.01" && break
    sleep 15
done
echo "$OUT"
echo "$OUT" | grep -q "withdrawn early 0.01" && echo "$OUT" | grep -q "RESULT: PASS"
