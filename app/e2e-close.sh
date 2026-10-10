#!/usr/bin/env bash
# Closing scenarios on testnet, four campaigns side by side (each with its own new wallet):
#   A  raise, goal met: host sweeps after the deadline
#   B  raise, goal missed: host re-issues all tickets, one contributor withdraws early with the
#      re-issued ticket, host refunds the rest at close
#   C  raise, host silent: the contributor self-refunds after deadline + K
#   D  auction (1 item): key sealed until close, winner swept, losers refunded
# Run from the repository root. 1 confirmation everywhere.
# ONLY="C" runs just the named scenarios (default "A B C D"), for example ONLY=C for the silent-host scenario alone.
set -euo pipefail

ZD=./target/release/zcash-devtool
BIN=./app/target/release
BACKEND=${BACKEND:-libs}
ROOT=${ROOT:-runs/close-$(date -u +%Y%m%dT%H%M%SZ)}
DEADLINE_IN=${DEADLINE_IN:-25}
mkdir -p "$ROOT"
declare -A WATCHERS=()   # campaign -> pid of its watcher (by name: ONLY may run any subset)
CAMPS=${ONLY:-A B C D}
has() { [[ " $CAMPS " == *" $1 "* ]]; }
trap 'for p in "${WATCHERS[@]}"; do kill "$p" 2>/dev/null || true; done' EXIT

say() { echo; echo "== [$(date -u +%H:%M:%SZ)] $*"; }
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
tip() { "$ZD" wallet -w bidder get-info 2>/dev/null | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2; }
wait_height() { while [ "$(tip)" -lt "$1" ]; do sleep 15; done; echo "   chain at $(tip)"; }
deadline() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["deadline_height"])' "$ROOT/$1/rules.json"; }
ticket_k() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ticket_k"])' "$ROOT/$1/rules.json"; }
TREASURY=$(addr outsider)

# Pay from the bidder with a fresh contributor seed; prints the contribution txid.
pay() { # campaign tag value
    local c=$1 tag=$2 value=$3 memo txid=""
    $BIN/ll-contrib keygen --out "$ROOT/$c/$tag.seed" >/dev/null
    memo=$($BIN/ll-contrib memo --rules "$ROOT/$c/rules.json" --seed "$ROOT/$c/$tag.seed" --refund-address "$(addr bidder)")
    for _ in $(seq 1 20); do
        "$ZD" wallet -w bidder sync >/dev/null 2>&1 || true
        txid=$(echo y | "$ZD" wallet -w bidder send -i bidder.age --address "$(cat "$ROOT/$c/address")" \
            --value "$value" --memo "$memo" --min-confirmations 1 2>&1 | grep -oE '^[0-9a-f]{64}$' || true)
        [ -n "$txid" ] && break
        sleep 20 # wait for change to confirm
    done
    [ -n "$txid" ] || { echo "payment failed"; exit 1; }
    echo "$txid" > "$ROOT/$c/$tag.txid"
    echo "   $c/$tag: $value zat, txid $txid"
}

# The contribution's action index, from the campaign's own view of the payment.
contribution() { # campaign tag
    local txid; txid=$(cat "$ROOT/$1/$2.txid")
    python3 - "$ROOT/$1/ledger" "$txid" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    c = json.load(open(os.path.join(sys.argv[1], f))).get("contribution")
    if c and c["txid"] == sys.argv[2]:
        print(f'{c["txid"]}:{c["action"]}'); break
PY
}

self_refund() { # campaign tag
    local c=$1 tag=$2
    $BIN/ll-contrib open-ticket --seed "$ROOT/$c/$tag.seed" --ledger "$ROOT/$c/ledger" --tickets "$ROOT/$c/tickets" \
        --contribution "$(contribution "$c" "$tag")" --out "$ROOT/$c/$tag.ticket.hex" | sed 's/^/   /'
    $BIN/ll-contrib broadcast --raw "$ROOT/$c/$tag.ticket.hex" | sed 's/^/   /'
}

recount() { # campaign
    local c=$1 viewer="$ROOT/$1/viewer" key
    key=$(python3 - "$ROOT/$c" <<'PY'
import json, os, sys
d = sys.argv[1]
r = json.load(open(os.path.join(d, "rules.json")))
key = r.get("campaign_ufvk")
for f in sorted(os.listdir(os.path.join(d, "ledger"))):
    e = json.load(open(os.path.join(d, "ledger", f)))
    if e["kind"] == "close" and e["close"].get("ufvk"):
        key = e["close"]["ufvk"]
print(key or "")
PY
)
    if [ -z "$key" ]; then
        $BIN/ll-recount --rules "$ROOT/$c/rules.json" --rules-id "$(cat "$ROOT/$c/rules_id")" --ledger "$ROOT/$c/ledger"
        return
    fi
    if [ ! -d "$viewer" ]; then
        local start; start=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["start_height"])' "$ROOT/$c/rules.json")
        "$ZD" wallet -w "$viewer" init-fvk --name viewer --fvk "$key" --birthday $((start - 2)) >/dev/null 2>&1
    fi
    "$ZD" wallet -w "$viewer" sync >/dev/null 2>&1
    "$ZD" wallet -w "$viewer" enhance >/dev/null 2>&1
    $BIN/ll-recount --rules "$ROOT/$c/rules.json" --rules-id "$(cat "$ROOT/$c/rules_id")" --ledger "$ROOT/$c/ledger" --wallet "$viewer"
}

say "1. Four campaigns, each with a new dedicated wallet (backend: $BACKEND)"
for c in $CAMPS; do
    mkdir -p "$ROOT/$c"
    "$ZD" wallet -w "$ROOT/$c/wallet" init --name "campaign-$c" -i "$ROOT/$c/wallet.age" -n test >/dev/null 2>&1
done
has A && $BIN/ll-host create --run "$ROOT/A" --wallet "$ROOT/A/wallet" --identity "$ROOT/A/wallet.age" --backend "$BACKEND" --goal-zat 1500000 --deadline-in "$DEADLINE_IN"
has B && $BIN/ll-host create --run "$ROOT/B" --wallet "$ROOT/B/wallet" --identity "$ROOT/B/wallet.age" --backend "$BACKEND" --goal-zat 5000000 --deadline-in "$DEADLINE_IN"
has C && $BIN/ll-host create --run "$ROOT/C" --wallet "$ROOT/C/wallet" --identity "$ROOT/C/wallet.age" --backend "$BACKEND" --goal-zat 5000000 --deadline-in "$DEADLINE_IN"
has D && $BIN/ll-host create --run "$ROOT/D" --wallet "$ROOT/D/wallet" --identity "$ROOT/D/wallet.age" --backend "$BACKEND" --mode auction --items 1 --deadline-in "$DEADLINE_IN"

say "2. Hosts start watching (they issue tickets by themselves)"
for c in $CAMPS; do
    $BIN/ll-host watch --run "$ROOT/$c" --interval 15 > "$ROOT/$c/watch.log" 2>&1 &
    WATCHERS[$c]=$!
done

say "3. Contributions"
has A && { pay A a1 1000000; pay A a2 1000000; }
has B && { pay B b1 1000000; pay B b2 1000000; }
has C && pay C c1 1000000
has D && { pay D d1 1000000; pay D d2 3000000; pay D d3 2000000; }

say "4. Waiting for the tickets"
want() { ls "$ROOT/$1/ledger" 2>/dev/null | wc -l; }
need() { has "$1" || return 0; [ "$(want "$1")" -ge "$2" ]; }   # this campaign has this many ledger entries (or is not part of this run)
for _ in $(seq 1 80); do
    need A 2 && need B 2 && need C 1 && need D 3 && break
    sleep 15
done
grep -h "ticket issued\|rejected\|ALERT" "$ROOT"/*/watch.log | sed 's/^/   /'

say "5. Auction D before close: viewing key sealed, only R1-R2 checkable"
has D && { recount D || true; }

say "6. B: host re-issues every outstanding ticket (as after a network upgrade)"
# the host program holds one lock per campaign folder: B's watcher steps aside while the re-issue runs, then watches again
if has B; then
kill "${WATCHERS[B]}" 2>/dev/null || true; sleep 4
$BIN/ll-host reissue --run "$ROOT/B" | sed 's/^/   /'
$BIN/ll-host watch --run "$ROOT/B" --interval 15 > "$ROOT/B/watch2.log" 2>&1 &
WATCHERS[B]=$!
fi

say "7. B: contributor b2 withdraws early with the re-issued ticket"
has B && self_refund B b2

LAST=$(for c in $CAMPS; do deadline "$c"; done | sort -n | tail -1)
say "8. Waiting for the last deadline ($LAST)"
wait_height $(( LAST + 1 ))
for c in $CAMPS; do kill "${WATCHERS[$c]}" 2>/dev/null || true; unset "WATCHERS[$c]"; done
sleep 3   # let the watchers exit and release their campaign locks

say "9. Hosts close A, B, D (C's host stays silent)"
for c in A B D; do
    has $c || continue
    echo "   -- $c"
    $BIN/ll-host close --run "$ROOT/$c" --sweep-to "$TREASURY" | sed 's/^/   /'
done

say "10. C: host silent; contributor self-refunds after deadline + K"
has C && wait_height $(( $(deadline C) + $(ticket_k C) + 1 ))  # the campaign's own ticket window K (the default is now 30, not 10)
has C && self_refund C c1

say "11. Waiting one block for the closing transactions, then recount everything"
wait_height $(( $(tip) + 2 ))
echo "   host passes after the spends are confirmed (locks must be released, including C's self-refund):"
for c in $CAMPS; do $BIN/ll-host watch --run "$ROOT/$c" --once | grep -E "lock released|ALERT" | sed "s/^/   $c: /" || true; done
FAIL=0
for c in $CAMPS; do
    echo; echo "########## campaign $c"
    recount "$c" || FAIL=1
done
exit $FAIL
