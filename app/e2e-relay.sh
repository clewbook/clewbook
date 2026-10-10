#!/usr/bin/env bash
# Relay behaviour on a FINISHED testnet campaign (default: the latest slice-b run: two
# contributions, a close entry, refunds on chain). What the host, the recount and a
# contributor see when the relay works, is down, comes back empty, or drops entries.
# Run from the repository root.
set -uo pipefail

ZD=./target/release/zcash-devtool
BIN=./app/target/release
RUN=${RUN:-$(ls -d runs/one-b-2* | tail -1)}
T=${T:-runs/relay-test-$(date -u +%Y%m%dT%H%M%SZ)}
PORT=${PORT:-8799}
URL=http://127.0.0.1:$PORT
PORT2=${PORT2:-8797}; URL2=http://127.0.0.1:$PORT2
RELAY_ARGS=(--relay "$URL")
ID=$(cat "$RUN/rules_id")
say() { echo; echo "== $*"; }
mkdir -p "$T"
RELAY_PID=""
start_relay() { $BIN/ll-relay serve --dir "$1" --listen 127.0.0.1:$PORT > "$T/relay.log" 2>&1 & RELAY_PID=$!; sleep 1; }
start_relay2() { $BIN/ll-relay serve --dir "$1" --listen 127.0.0.1:$PORT2 > "$T/relay2.log" 2>&1 & RELAY2_PID=$!; sleep 1; }
stop_relay2() { [ -n "${RELAY2_PID:-}" ] && kill "$RELAY2_PID" 2>/dev/null; wait "$RELAY2_PID" 2>/dev/null; RELAY2_PID=""; }
stop_relay() { [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null; wait "$RELAY_PID" 2>/dev/null; RELAY_PID=""; sleep 1; }
trap 'stop_relay; stop_relay2' EXIT
contrib_of() { python3 - "$RUN" "$1" <<'PY'
import json, os, sys
run, who = sys.argv[1:3]
txid = open(f"{run}/{who}.txid").read().strip()
for f in sorted(os.listdir(f"{run}/ledger")):
    c = json.load(open(f"{run}/ledger/{f}")).get("contribution")
    if c and c["txid"] == txid: print(f'{c["txid"]}:{c["action"]}'); break
PY
}
C1=$(contrib_of c1); C2=$(contrib_of c2)
ticket() { # contributor cache-dir [relay args...]
    local who=$1 cache=$2; shift 2
    $BIN/ll-contrib open-ticket --seed "$RUN/$who.seed" "${RELAY_ARGS[@]}" --campaign "$ID" --cache "$cache" \
        --contribution "$( [ $who = c1 ] && echo $C1 || echo $C2 )" --out "$T/$who.ticket.hex" 2>&1 | sed 's/^/   /'
}
recount() {
    "$ZD" wallet -w "$RUN/viewer" sync >/dev/null 2>&1; "$ZD" wallet -w "$RUN/viewer" enhance >/dev/null 2>&1
    $BIN/ll-recount --rules-id "$ID" "${RELAY_ARGS[@]}" --wallet "$RUN/viewer" 2>&1 | grep -E "ledger read|note:|RELAYS|NO USABLE|DISAGREE|  - |R[1-8] FAIL|R2 |R4 |NOTE|cannot|RESULT|^error|detail|       - " | sed 's/^/   /'
    echo "   (recount exit status: ${PIPESTATUS[0]})"
}
ledger_files() { ls "$1/campaigns/$ID/ledger" | tr '\n' ' '; }

say "1. Start a relay with ONE command and publish the finished campaign's ledger and tickets"
start_relay "$T/data-a"; echo "   ll-relay serve --dir $T/data-a --listen 127.0.0.1:$PORT  (pid $RELAY_PID)"
$BIN/ll-host publish --run "$RUN" --relay "$URL" | sed 's/^/   /'
echo "   relay holds ledger files: $(ledger_files "$T/data-a")"

say "2. A relay refuses an entry that is not signed by the campaign"
python3 - "$RUN" "$T/forged.json" <<'PY'
import json, os, sys
e = json.load(open(f"{sys.argv[1]}/ledger/000001.json")); e["contribution"]["value_zat"] = 1
json.dump(e, open(sys.argv[2], "w"), separators=(",", ":"), sort_keys=True)
PY
echo "   PUT a tampered copy of entry 1 -> HTTP $(curl -s -o "$T/forged.out" -w '%{http_code}' -X PUT --data-binary @"$T/forged.json" "$URL/v1/campaigns/$ID/ledger/1") $(cat "$T/forged.out")"

say "3. Everything fine: recount reads the ledger from the relay; contributor c2 fetches the ticket (and saves a copy)"
recount
ticket c2 "$T/cache-c2"

say "4. The relay goes DOWN"
stop_relay
echo "   recount (must not pass silently):"; recount
echo "   contributor c2 opens the page again:"; ticket c2 "$T/cache-c2"
echo "   contributor c1 never fetched anything before (no saved copy):"; ticket c1 "$T/cache-c1"
echo "   host pass while the relay is down (the ledger stays safe on disk):"
$BIN/ll-host watch --run "$RUN" --once 2>&1 | grep -E "relay|tip" | sed 's/^/   /'

say "5. The relay comes back EMPTY (new data dir): the host's next pass republishes the backlog"
start_relay "$T/data-b"
$BIN/ll-host watch --run "$RUN" --once 2>&1 | grep -E "relay|tip" | sed 's/^/   /'
echo "   relay holds ledger files: $(ledger_files "$T/data-b")"

say "6. A dishonest relay DROPS THE MIDDLE entry (entry 1) from its own storage"
stop_relay; cp -r "$T/data-b" "$T/data-c"; rm "$T/data-c/campaigns/$ID/ledger/000001.json"
start_relay "$T/data-c"; echo "   relay holds ledger files: $(ledger_files "$T/data-c")"
echo "   recount:"; recount
echo "   contributor c2 (has a saved copy):"; ticket c2 "$T/cache-c2"
echo "   contributor c1 (no saved copy):"; ticket c1 "$T/cache-c1"

say "7. A dishonest relay DROPS THE NEWEST entries (entries 1 and 2): the chain stays intact"
stop_relay; cp -r "$T/data-b" "$T/data-d"; rm "$T/data-d/campaigns/$ID/ledger/000001.json" "$T/data-d/campaigns/$ID/ledger/000002.json"
start_relay "$T/data-d"; echo "   relay holds ledger files: $(ledger_files "$T/data-d")"
echo "   recount:"; recount
echo "   contributor c2 (has a saved copy):"; ticket c2 "$T/cache-c2"
echo "   contributor c1 (entry 0 is still there):"; ticket c1 "$T/cache-c1"

say "8. TWO relays: A is honest, B has lost the newest entries. They differ, so: no conclusion (never 'host guilty')"
stop_relay; start_relay "$T/data-b"; start_relay2 "$T/data-d"
RELAY_ARGS=(--relay "$URL" --relay "$URL2")
echo "   recount reading both relays:"; recount
echo "   contributor c2 reading both relays (no saved copy used: this is a fresh cache dir):"; ticket c2 "$T/cache-c2-both"

say "9. TWO relays, one of them down: the other stands alone and the verdict is labelled as coming from one relay"
stop_relay2
echo "   recount:"; recount

say "10. TWO relays that agree"
start_relay2 "$T/data-b"
echo "   recount:"; recount
echo "   challenge: a contributor publishes a challenge to both relays (refused: nobody rejected that payment)"
$BIN/ll-contrib challenge --seed "$RUN/c2.seed" --contribution "$C2" --out "$T/chal.json" --campaign "$ID" --relay "$URL" --relay "$URL2" | sed 's/^/   /'
