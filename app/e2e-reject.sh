#!/usr/bin/env bash
# Needs the cheating build: cd app && CARGO_TARGET_DIR=target-cheat cargo build --release -p ll-host --features test-cheats
# Reject rule on testnet, two campaigns:
#   F  a payment with a well-shaped but garbage memo: the host writes a signed reject entry;
#      the payment is a non-refundable donation; the recount still passes.
#   G  a cheating host rejects a genuine contribution: with no challenge the reject stands
#      (recount passes), but once the contributor publishes the one-time secret derived from
#      their seed, the recount must FAIL with evidence (R8, and R4 for the missing ticket).
# Run from the repository root. 1 confirmation everywhere.
set -euo pipefail

ZD=./target/release/zcash-devtool
BIN=./app/target/release
ROOT=${ROOT:-runs/reject-$(date -u +%Y%m%dT%H%M%SZ)}
say() { echo; echo "== [$(date -u +%H:%M:%SZ)] $*"; }
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
tip() { "$ZD" wallet -w bidder get-info 2>/dev/null | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2; }
wait_height() { until [ "$(tip || echo 0)" -ge "$1" ]; do sleep 10; done; }
rules_field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$ROOT/$1/rules.json" "$2"; }

new_campaign() { # name
    local c=$1 n W=""
    mkdir -p "$ROOT/$c"
    for n in 1 2 3 4 5; do
        if timeout 45 "$ZD" wallet -w "$ROOT/$c/wallet$n" init --name "campaign-$c" -i "$ROOT/$c/wallet$n.age" -n test >/dev/null 2>&1; then W="$ROOT/$c/wallet$n"; break; fi
        echo "   wallet init attempt $n stalled, retrying"
    done
    [ -n "$W" ] || { echo "could not create a wallet"; exit 1; }
    timeout 180 $BIN/ll-host create --run "$ROOT/$c" --wallet "$W" --identity "$W.age" --goal-zat 5000000 --deadline-in $((40 * ${BLOCK_SCALE:-3}))
}

mined() { # txid -> prints the mined height of a bidder payment, or nothing
    python3 - "$1" <<'PY'
import sqlite3, sys
db = sqlite3.connect("file:bidder/data.sqlite?mode=ro", uri=True)
r = db.execute("select mined_height from transactions where txid=?", (bytes.fromhex(sys.argv[1])[::-1],)).fetchone()
print(r[0] if r and r[0] else "")
PY
}
pay() { # campaign memo -> txid on stdout. A payment that is never mined (the public server sometimes drops one) is sent again.
    local txid="" try k
    for try in 1 2 3 4; do
        for _ in $(seq 1 20); do
            "$ZD" wallet -w bidder sync >/dev/null 2>&1 || true
            txid=$(echo y | "$ZD" wallet -w bidder send -i bidder.age --address "$(cat "$ROOT/$1/address")" --value 1000000 \
                --memo "$2" --min-confirmations 1 2>&1 | grep -oE '^[0-9a-f]{64}$' || true)
            [ -n "$txid" ] && break
            sleep 20
        done
        [ -n "$txid" ] || { echo "payment failed" >&2; exit 1; }
        for k in $(seq 1 30); do
            "$ZD" wallet -w bidder sync >/dev/null 2>&1 || true
            [ -n "$(mined "$txid")" ] && { echo "$txid"; return 0; }
            sleep 10
        done
        echo "   payment $txid was never mined (attempt $try); sending it again" >&2
        sleep 60   # let the dropped payment's expiry pass so its coins are free again
    done
    echo "payment never mined" >&2; exit 1
}

viewer_recount() { # campaign [extra recount args]
    local c=$1; shift
    local v="$ROOT/$c/viewer"
    if [ ! -d "$v" ]; then
        "$ZD" wallet -w "$v" init-fvk --name viewer --fvk "$(rules_field "$c" campaign_ufvk)" --birthday $(( $(rules_field "$c" start_height) - 2 )) >/dev/null 2>&1
    fi
    "$ZD" wallet -w "$v" sync >/dev/null 2>&1
    "$ZD" wallet -w "$v" enhance >/dev/null 2>&1
    $BIN/ll-recount --rules "$ROOT/$c/rules.json" --rules-id "$(cat "$ROOT/$c/rules_id")" --ledger "$ROOT/$c/ledger" --wallet "$v" "$@"
}

wait_entry() { # campaign
    until [ "$(ls "$ROOT/$1/ledger" 2>/dev/null | wc -l)" -ge 1 ]; do
        $BIN/ll-host watch --run "$ROOT/$1" --once | grep -E "ticket issued|rejected|ALERT" | sed 's/^/   /' || true
        sleep 10
    done
}

say "F1. Campaign F; payment with a well-shaped but garbage memo (LL1: + 252 characters)"
new_campaign F
GARBAGE="LL1:$(python3 -c 'print("QUJD"*63)')"
echo "   memo is ${#GARBAGE} characters"
TX=$(pay F "$GARBAGE"); echo "   payment $TX"

say "F2. Host watches: it must write a signed reject entry (and no ticket)"
wait_entry F
python3 - "$ROOT/F/ledger/000000.json" <<'PY'
import json, sys
e = json.load(open(sys.argv[1]))
print("   entry:", e["kind"], "| reason:", e["reason"], "| signed:", bool(e.get("sig")), "| ticket:", e.get("ticket"))
assert e["kind"] == "reject" and e.get("sig") and not e.get("ticket")
PY

say "F3. Recount F (must PASS: the reject is just; the payment is a donation)"
sleep 20
viewer_recount F | tee "$ROOT/F/recount.txt"
grep -q "RESULT: PASS" "$ROOT/F/recount.txt"
grep -q "reject(s) upheld" "$ROOT/F/recount.txt"

say "G1. Campaign G; a genuine contribution with a valid memo"
new_campaign G
$BIN/ll-contrib keygen --out "$ROOT/G/g1.seed" >/dev/null
MEMO=$($BIN/ll-contrib memo --rules "$ROOT/G/rules.json" --seed "$ROOT/G/g1.seed" --refund-address "$(addr bidder)")
TX=$(pay G "$MEMO"); echo "   payment $TX"

say "G2. The cheating host wrongly rejects it (watch is NOT run, so no ticket is issued)"
until ${CHEAT_HOST:-./app/target-cheat/release/ll-host} force-reject --run "$ROOT/G" --contribution "$TX:0" 2>/dev/null || ${CHEAT_HOST:-./app/target-cheat/release/ll-host} force-reject --run "$ROOT/G" --contribution "$TX:1" 2>/dev/null || ${CHEAT_HOST:-./app/target-cheat/release/ll-host} force-reject --run "$ROOT/G" --contribution "$TX:2" 2>/dev/null; do sleep 10; done
ls "$ROOT/G/ledger"

say "G3. Recount G with no challenge: the reject stands (PASS)"
sleep 20
viewer_recount G | tee "$ROOT/G/recount-nochallenge.txt"
grep -q "RESULT: PASS" "$ROOT/G/recount-nochallenge.txt"

say "G4. The contributor publishes the one-time secret derived from their seed"
ACTION=$(python3 - "$ROOT/G/ledger/000000.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["contribution"]["action"])
PY
)
mkdir -p "$ROOT/G/challenges"
$BIN/ll-contrib challenge --seed "$ROOT/G/g1.seed" --contribution "$TX:$ACTION" --out "$ROOT/G/challenges/g1.json"

say "G5. Recount G with the challenge: it must FAIL with evidence"
set +e
viewer_recount G --challenges "$ROOT/G/challenges" | tee "$ROOT/G/recount-challenged.txt"
STATUS=${PIPESTATUS[0]}
set -e
echo "   recount exit status: $STATUS (1 = FAIL as expected)"
[ "$STATUS" = 1 ]
grep -q "R8 FAIL" "$ROOT/G/recount-challenged.txt"
grep -q "opens a valid payload" "$ROOT/G/recount-challenged.txt"
echo; echo "ALL REJECT CHECKS AS EXPECTED"
