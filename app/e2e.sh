#!/usr/bin/env bash
# End-to-end slice on testnet: create a raise campaign, contribute with a sealed memo,
# let the host issue a ticket automatically, open the ticket, check the wallet lock, recount.
# Run from the repository root. Uses 1 confirmation everywhere.
set -euo pipefail

BACKEND=${BACKEND:-libs}
RUN=${RUN:-runs/e2e-$BACKEND-$(date -u +%Y%m%dT%H%M%SZ)}
ZD=./target/release/zcash-devtool
BIN=./app/target/release
VALUE=${VALUE:-1000000}

say() { echo; echo "== [$(date -u +%H:%M:%SZ)] $*"; }
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }

say "1. Host creates a raise campaign with a new dedicated wallet (backend: $BACKEND)"
mkdir -p "$RUN"
"$ZD" wallet -w "$RUN/wallet" init --name campaign -i "$RUN/wallet.age" -n test >/dev/null 2>&1
$BIN/ll-host create --run "$RUN" --wallet "$RUN/wallet" --identity "$RUN/wallet.age" --backend "$BACKEND" \
    --goal-zat 5000000 --deadline-in 60
CAMPAIGN_ADDR=$(cat "$RUN/address")

say "2. Contributor makes a seed and the sealed memo (refunds to the bidder wallet)"
$BIN/ll-contrib keygen --out "$RUN/contributor.seed"
MEMO=$($BIN/ll-contrib memo --rules "$RUN/rules.json" --seed "$RUN/contributor.seed" --refund-address "$(addr bidder)")
echo "memo (${#MEMO} chars): ${MEMO:0:40}..."

say "3. Bidder pays $VALUE zat to the campaign with that memo"
"$ZD" wallet -w bidder sync >/dev/null 2>&1
echo y | "$ZD" wallet -w bidder send -i bidder.age --address "$CAMPAIGN_ADDR" --value "$VALUE" \
    --memo "$MEMO" --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$|Error' | tee "$RUN/contribution.txid"

say "4. Host watches; it must issue the ticket by itself"
for i in $(seq 1 60); do
    $BIN/ll-host watch --run "$RUN" --once | sed 's/^/   host: /'
    [ -f "$RUN/ledger/000000.json" ] && break
    sleep 20
done
[ -f "$RUN/ledger/000000.json" ] || { echo "no ticket issued"; exit 1; }
NF=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contribution"]["nf"])' "$RUN/ledger/000000.json")

say "5. Contributor opens the ticket and checks it against the ledger"
CONTRIB=$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["contribution"]; print(c["txid"] + ":" + str(c["action"]))' "$RUN/ledger/000000.json")
$BIN/ll-contrib open-ticket --seed "$RUN/contributor.seed" --ledger "$RUN/ledger" --tickets "$RUN/tickets" \
    --contribution "$CONTRIB" --out "$RUN/ticket.rawtx.hex"

say "6. Wallet lock check: an ordinary payment from the campaign must NOT spend the ticketed note"
python3 spikes/notes_db.py "$RUN/wallet" | grep "$NF" || true
if echo y | "$ZD" wallet -w "$RUN/wallet" send -i "$RUN/wallet.age" --address "$(addr outsider)" --value 500000 \
        --min-confirmations 1 > "$RUN/lockcheck.out" 2>&1; then
    echo "LOCK FAILED: the ordinary payment went through"; cat "$RUN/lockcheck.out"; exit 1
else
    echo "lock held: the payment was refused:"; grep -iE "error|insufficient" "$RUN/lockcheck.out" | head -3
fi

say "7. Recount from public data and a view-only wallet"
START=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["start_height"])' "$RUN/rules.json")
UFVK=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["campaign_ufvk"])' "$RUN/rules.json")
"$ZD" wallet -w "$RUN/viewer" init-fvk --name viewer --fvk "$UFVK" --birthday $((START - 2)) >/dev/null 2>&1
"$ZD" wallet -w "$RUN/viewer" sync >/dev/null 2>&1
"$ZD" wallet -w "$RUN/viewer" enhance >/dev/null 2>&1
$BIN/ll-recount --rules "$RUN/rules.json" --rules-id "$(cat "$RUN/rules_id")" \
    --ledger "$RUN/ledger" --wallet "$RUN/viewer"
