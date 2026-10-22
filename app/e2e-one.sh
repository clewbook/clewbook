#!/usr/bin/env bash
# One closing scenario on testnet, with its own new wallet. Usage: app/e2e-one.sh a|b|c|d
#   a  raise closes: goal met, host sweeps after the deadline
#   b  raise fails: goal missed, host broadcasts all tickets at close
#   c  host silent: a contributor broadcasts their own ticket after deadline + K
#   d  early withdrawal: a contributor broadcasts their ticket before the deadline
#   e  auction (1 item, 3 bids): key hash at the start, key revealed at close, winner swept,
#      losers refunded
#   g  upgrade watcher: the reported consensus branch ID changes (simulated with
#      --assume-branch-id); the watch loop re-issues every ticket by itself, locks carry over
#   f  re-issue: host re-issues every ticket; ledger gains reissue entries, wallet locks carry
#      over, a contributor withdraws with the re-issued ticket, host refunds the other at close
#   Since 22 Oct 2026 (SPEC §4, "Re-issue") the host re-issues only tickets under an older network version than the chain really
#   reports, and the recount refuses a re-issue under the same version. On a network that is not upgrading, f and g therefore
#   re-issue nothing; a simulated branch change is not a real one.
# Optional: CAMPAIGN_NAME="a public name" gives the campaign a name.
# Each run ends with the host's lock-release pass and a full recount (R1-R8).
# Run from the repository root. 1 confirmation everywhere. Log it with: ... > runs/x.log 2>&1
set -euo pipefail

S=${1:?usage: e2e-one.sh a|b|c|d}
ZD=./target/release/zcash-devtool
BIN=${BIN:-./app/target/release}
BACKEND=${BACKEND:-libs}
RUN=${RUN:-runs/one-$S-$(date -u +%Y%m%dT%H%M%SZ)}
say() { echo; echo "== [$(date -u +%H:%M:%SZ)] $*"; }
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
tip() { "$ZD" wallet -w bidder get-info 2>/dev/null | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2; }
wait_height() { until [ "$(tip || echo 0)" -ge "$1" ]; do sleep 10; done; echo "   chain at $(tip)"; }
jq_rules() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$RUN/rules.json" "$1"; }

case $S in
  a) GOAL=1500000; N=2; DEADLINE_IN=14 ;;
  b) GOAL=5000000; N=2; DEADLINE_IN=14 ;;
  c) GOAL=5000000; N=1; DEADLINE_IN=10 ;;
  d) GOAL=5000000; N=1; DEADLINE_IN=30 ;;
  e) GOAL=; N=3; DEADLINE_IN=20 ;;
  f) GOAL=5000000; N=2; DEADLINE_IN=24 ;;
  g) GOAL=5000000; N=2; DEADLINE_IN=26 ;;
  *) echo "unknown scenario $S"; exit 2 ;;
esac
# Deadlines are blocks. Testnet blocks are now ~12 s (they were 25 s when these numbers were chosen), so a payment can
# be mined after a short deadline and the scenario would wait forever. Scale them (BLOCK_SCALE, default 3).
DEADLINE_IN=$((DEADLINE_IN * ${BLOCK_SCALE:-3}))

say "1. New campaign wallet and raise (goal $GOAL, backend $BACKEND)"
mkdir -p "$RUN"
# The server connection occasionally stalls: retry with a fresh wallet folder each time.
W=""
for n in 1 2 3 4 5; do
    if timeout 45 "$ZD" wallet -w "$RUN/wallet$n" init --name "campaign-$S" -i "$RUN/wallet$n.age" -n test >/dev/null 2>&1; then W="$RUN/wallet$n"; break; fi
    echo "   wallet init attempt $n stalled, retrying"
done
[ -n "$W" ] || { echo "could not create a wallet"; exit 1; }
if [ "$S" = e ]; then MODE_ARGS="--mode auction --items 1"; else MODE_ARGS="--goal-zat $GOAL"; fi
timeout 180 $BIN/ll-host create --run "$RUN" --wallet "$W" --identity "$W.age" --backend "$BACKEND" \
    $MODE_ARGS --deadline-in "$DEADLINE_IN" ${CAMPAIGN_NAME:+--name "$CAMPAIGN_NAME"} ${RELAY:+--relay "$RELAY"}
DEADLINE=$(jq_rules deadline_height)

VALUES=(0 1000000 1000000 1000000)
[ "$S" = e ] && VALUES=(0 1000000 3000000 2000000)
say "2. $N contribution(s): ${VALUES[*]:1:$N} zat"
for i in $(seq 1 "$N"); do
    $BIN/ll-contrib keygen --out "$RUN/c$i.seed" >/dev/null
    MEMO=$($BIN/ll-contrib memo --rules "$RUN/rules.json" --seed "$RUN/c$i.seed" --refund-address "$(addr bidder)")
    TXID=""
    for _ in $(seq 1 20); do
        "$ZD" wallet -w bidder sync >/dev/null 2>&1 || true
        TXID=$(echo y | "$ZD" wallet -w bidder send -i bidder.age --address "$(cat "$RUN/address")" --value "${VALUES[$i]}" \
            --memo "$MEMO" --min-confirmations 1 2>&1 | grep -oE '^[0-9a-f]{64}$' || true)
        [ -n "$TXID" ] && break
        sleep 20
    done
    [ -n "$TXID" ] || { echo "payment $i failed"; exit 1; }
    echo "$TXID" > "$RUN/c$i.txid"; echo "   c$i: $TXID"
done

say "3. Host issues the tickets by itself"
for waited in $(seq 1 90); do   # give up after ~15 minutes instead of waiting forever
    [ "$(ls "$RUN/ledger" 2>/dev/null | wc -l)" -ge "$N" ] && break
    $BIN/ll-host watch --run "$RUN" --once | grep -E "ticket issued|ALERT|released" | sed 's/^/   /' || true
    sleep 10
done
[ "$(ls "$RUN/ledger" 2>/dev/null | wc -l)" -ge "$N" ] || { echo "STOP: the host issued no ticket within 15 minutes (deadline $DEADLINE; chain at $(tip)): the payment may have been mined after the deadline"; exit 3; }

contribution() { python3 - "$RUN/ledger" "$(cat "$RUN/$1.txid")" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    c = json.load(open(os.path.join(sys.argv[1], f))).get("contribution")
    if c and c["txid"] == sys.argv[2]:
        print(f'{c["txid"]}:{c["action"]}'); break
PY
}
self_refund() { # contributor; with RELAY set the ticket comes from the relay, like a web page
    if [ -n "${RELAY:-}" ]; then
        SRC=(--relay "$RELAY" --campaign "$(cat "$RUN/rules_id")" --cache "$RUN/cache-$1")
    else
        SRC=(--ledger "$RUN/ledger" --tickets "$RUN/tickets")
    fi
    $BIN/ll-contrib open-ticket --seed "$RUN/$1.seed" "${SRC[@]}" \
        --contribution "$(contribution "$1")" --out "$RUN/$1.ticket.hex" | sed 's/^/   /'
    $BIN/ll-contrib broadcast --raw "$RUN/$1.ticket.hex" | sed 's/^/   /'
}

locks() { # wallet: one line per note with its lock owner (short) and expiry
python3 - "$1" <<'PY'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}/data.sqlite?mode=ro", uri=True)
for txid, a, v, lo, le, sp in c.execute("""select hex(t.txid), n.action_index, n.value, hex(n.lock_owner), n.lock_expiry_height,
  (select count(*) from ironwood_received_note_spends s where s.ironwood_received_note_id = n.id)
  from ironwood_received_notes n join transactions t on t.id_tx = n.transaction_id where n.value > 0 order by n.id"""):
    print(f"   note {bytes.fromhex(txid)[::-1].hex()[:12]}:{a} value={v} lock={(lo or 'none')[:8].lower()} lock_expiry={le} spent={'yes' if sp else 'no'}")
PY
}

if [ "$S" = e ]; then
    say "3b. Auction before close: only the key HASH is public; recount can check R1-R2 only"
    echo "   rules.json has ufvk_hash = $(jq_rules ufvk_hash)"
    echo "   rules.json has campaign_ufvk = $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("campaign_ufvk"))' "$RUN/rules.json")  (None = sealed)"
    $BIN/ll-recount --rules "$RUN/rules.json" --rules-id "$(cat "$RUN/rules_id")" --ledger "$RUN/ledger" | grep -E "R1|R2|R3|RESULT" | sed 's/^/   /'
    echo "   ledger entries show commitments, not amounts:"
    python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["contribution"]; print("   ", {k: c[k] for k in c if k in ("amount_commit","value_zat")})' "$RUN/ledger/000000.json"
fi
if [ "$S" = f ]; then
    say "3b. Locks and ledger BEFORE re-issue"
    locks "$W"; ls "$RUN/ledger" | sed 's/^/   ledger: /'
    say "3c. Host re-issues every ticket"
    $BIN/ll-host reissue --run "$RUN" | sed 's/^/   /'
    say "3d. AFTER re-issue: ledger gained reissue entries; locks carried over unchanged"
    python3 - "$RUN/ledger" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    e = json.load(open(os.path.join(sys.argv[1], f)))
    print(f"   entry {e['seq']}: {e['kind']:8} ticket {e['ticket']['txid'][:16]}...")
PY
    locks "$W"
    echo "   ordinary payment from the campaign wallet must be refused:"
    if echo y | "$ZD" wallet -w "$W" send -i "$W.age" --address "$(addr outsider)" --value 500000 --min-confirmations 1 > "$RUN/lockcheck.out" 2>&1; then
        echo "   LOCK FAILED"; cat "$RUN/lockcheck.out"; exit 1
    else grep -iE "insufficient" "$RUN/lockcheck.out" | head -1 | sed 's/^/   /'; fi
    say "3e. Contributor c1 withdraws with the RE-ISSUED ticket (latest ledger entry)"
fi

if [ "$S" = g ]; then
    say "3b. Locks and ledger BEFORE the simulated upgrade (real branch $("$ZD" wallet -w bidder get-info 2>/dev/null | grep -o '"consensus_branch_id":"[0-9a-f]*"' | cut -d'"' -f4))"
    locks "$W"; ls "$RUN/ledger" | sed 's/^/   ledger: /'
    echo "   branch the host last saw: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["branch_id"])' "$RUN/private/branch")"
    say "3c. Normal watch pass: no upgrade, so nothing is re-issued"
    $BIN/ll-host watch --run "$RUN" --once | sed 's/^/   /'
    say "3d. Simulated upgrade: the server now reports branch aaaaaaaa; the watch loop must re-issue by itself"
    $BIN/ll-host watch --run "$RUN" --once --assume-branch-id aaaaaaaa | sed 's/^/   /'
    say "3e. Same pass again: the upgrade is already handled, nothing more is re-issued"
    $BIN/ll-host watch --run "$RUN" --once --assume-branch-id aaaaaaaa | sed 's/^/   /'
    echo "   branch the host last saw: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["branch_id"])' "$RUN/private/branch")"
    say "3f. AFTER: ledger gained reissue entries; locks carried over unchanged"
    python3 - "$RUN/ledger" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    e = json.load(open(os.path.join(sys.argv[1], f)))
    print(f"   entry {e['seq']}: {e['kind']:8} ticket {e['ticket']['txid'][:16]}...")
PY
    locks "$W"
    echo "   ordinary payment from the campaign wallet must be refused:"
    if echo y | "$ZD" wallet -w "$W" send -i "$W.age" --address "$(addr outsider)" --value 500000 --min-confirmations 1 > "$RUN/lockcheck.out" 2>&1; then
        echo "   LOCK FAILED"; cat "$RUN/lockcheck.out"; exit 1
    else grep -iE "insufficient" "$RUN/lockcheck.out" | head -1 | sed 's/^/   /'; fi
    say "3g. Contributor c1 withdraws with the re-issued ticket (latest ledger entry)"
fi

# The public servers answer a little differently from one another: the script's chain height can be one block ahead of the
# host's. Close as soon as the host also sees the deadline pass (never earlier: the host refuses).
close_host() {
    for attempt in $(seq 1 15); do
        out=$($BIN/ll-host close --run "$RUN" --sweep-to "$(addr outsider)" 2>&1) && { echo "$out" | sed 's/^/   /'; return 0; }
        echo "$out" | grep -q "not reached" || { echo "$out" | sed 's/^/   /'; return 1; }
        sleep 20
    done
    echo "   close kept being refused: the deadline was never reached for the host"; return 1
}

case $S in
  a|b|e)
    say "4. Waiting for the deadline ($DEADLINE), then the host closes"
    wait_height $((DEADLINE + 1))
    close_host
    ;;
  f|g)
    self_refund c1
    say "4. Waiting for the deadline ($DEADLINE); the host closes and refunds c2 with its stored re-issued ticket"
    wait_height $((DEADLINE + 1))
    close_host
    ;;
  c)
    say "4. Host stays silent; waiting for deadline + K, then the contributor self-refunds"
    wait_height $((DEADLINE + $(jq_rules ticket_k) + 1))  # the campaign's own ticket window K (the default is now 30, not 10)
    self_refund c1
    ;;
  d)
    say "4. Contributor withdraws now, long before the deadline ($DEADLINE)"
    self_refund c1
    ;;
esac

say "5. Waiting for the spend(s) to be mined, then host pass (lock release) and recount"
# EXTRA_BLOCKS: how long to keep following the host's transactions (the drop test needs more than the default 2:
# the host sends a dropped transaction again after about 10 blocks, on its next watch pass)
TARGET=$(( $(tip) + ${EXTRA_BLOCKS:-2} ))
until [ "$(tip || echo 0)" -ge "$TARGET" ]; do
    $BIN/ll-host watch --run "$RUN" --once 2>&1 | grep -E "outbox:|released" | sed 's/^/   /' || true
    sleep 20
done
sleep 15
$BIN/ll-host watch --run "$RUN" --once | grep -E "lock released|ALERT" | sed 's/^/   /' || true
python3 spikes/notes_db.py "$W" | sed -E 's/nf=[0-9a-f]{56}/nf=…/; s/lock_owner=b?.[^ ]* /lock=/; s/lock_expiry=[0-9]+ /exp=/' | sed 's/^/   /'
START=$(jq_rules start_height)
if [ "$S" = e ]; then
    KEY=$(python3 - "$RUN/ledger" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    e = json.load(open(os.path.join(sys.argv[1], f)))
    if e["kind"] == "close": print(e["close"]["ufvk"])
PY
)
    echo "   revealed key hashes to the committed value: $(python3 -c 'import sys,json; sys.exit(0)' && echo checked by recount R1)"
else
    KEY=$(jq_rules campaign_ufvk)
fi
"$ZD" wallet -w "$RUN/viewer" init-fvk --name viewer --fvk "$KEY" --birthday $((START - 2)) >/dev/null 2>&1
"$ZD" wallet -w "$RUN/viewer" sync >/dev/null 2>&1
"$ZD" wallet -w "$RUN/viewer" enhance >/dev/null 2>&1
$BIN/ll-recount --rules "$RUN/rules.json" --rules-id "$(cat "$RUN/rules_id")" --ledger "$RUN/ledger" --wallet "$RUN/viewer"
if [ -n "${RELAY:-}" ]; then
    echo; echo "   same recount, reading the rules and ledger from the relay ($RELAY):"
    $BIN/ll-recount --rules-id "$(cat "$RUN/rules_id")" --relay "$RELAY" --wallet "$RUN/viewer" | sed 's/^/   /'
fi
