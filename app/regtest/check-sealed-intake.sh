#!/usr/bin/env bash
# Private chain check of the sealed bid auction's intake (phase 6): four auctions on one regtest chain with NU7 active, one for each way
# of sending coins. Deposits get their early ticket (expiring at the deadline) and a signed refund; coins go out from each host's own coin
# wallet at once (A), every 3 bids (B), every 2 minutes (C), or near the cutoff whatever was chosen (D); each coin brings a late ticket; a
# deposit after the cutoff gets no coin; the host's self check (the recount of phase 4) passes; an early ticket is refused after the
# deadline. Throwaway keys, no money, no public network.
# Usage: ZEBRAD=... BIN=<folder with cb-host (regtest build), ll-relay, ll-contrib, zcash-devtool (regtest build)> check-sealed-intake.sh <run folder>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
R=${1:?run folder}
: "${ZEBRAD:?zebrad 7.0.0-rc.0}" "${BIN:?folder of the built programs}"
export DEVTOOL=$BIN/zcash-devtool
C=$HERE/chain.sh
RELAY=127.0.0.1:18787
LWD=127.0.0.1:19067
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
cleanup() {
  [ -f "$R/relay.pid" ] && kill "$(cat "$R/relay.pid")" 2>/dev/null || true
  [ -f "$R/chain/zebrad.pid" ] && "$C" stop "$R/chain" >/dev/null 2>&1 || true
}
trap cleanup EXIT
rm -rf "$R"
mkdir -p "$R/w" "$R/b"
tip() { "$C" tip; }
mine_to() { local t; t=$(tip); [ "$1" -gt "$t" ] && "$C" mine $(( $1 - t )) >/dev/null; true; }
send() { # $1 to, $2 zatoshis, $3 memo (optional): prints the txid (the wallet syncs first, so its expiry height is current)
  timeout 600 "$DEVTOOL" wallet -w "$R/w/funder" sync -s "$LWD" >/dev/null 2>&1 || true
  local args=(wallet -w "$R/w/funder" send -i "$R/w/funder.age" --address "$1" --value "$2" -s "$LWD")
  [ -n "${3:-}" ] && args+=(--memo "$3")
  timeout 600 "$DEVTOOL" "${args[@]}" 2>/dev/null | tail -1
}
count() { # $1 campaign, $2 entry kind
  python3 -c 'import sys,json,glob;print(sum(1 for f in glob.glob(sys.argv[1]+"/ledger/*.json") if json.load(open(f))["kind"]==sys.argv[2]))' "$R/$1" "$2"
}
watch() { timeout 900 "$BIN/cb-host" watch --run "$R/$1" --once > "$R/$1.watch.log" 2>&1 || fail "watch $1: $(tail -5 "$R/$1.watch.log")"; }

# 1. chain, wallets (born after block 2), funding
"$C" start "$R/chain" >/dev/null
"$C" mine 5 >/dev/null
for n in funder payer treasury; do "$C" wallet "$R/w" "$n" > "$R/w/$n.address"; done
for x in A B C D; do
  mkdir -p "$R/$x"
  "$C" wallet "$R/$x" wallet1 > /dev/null
  "$C" wallet "$R/$x" coins1 > "$R/$x.coins.address"
done
"$C" stop "$R/chain" >/dev/null
KEEP=1 "$C" start "$R/chain" "$(cat "$R/w/funder.address")" >/dev/null
"$C" mine 110 >/dev/null
timeout 600 "$DEVTOOL" wallet -w "$R/w/funder" sync -s "$LWD" >/dev/null 2>&1 || fail "funder sync"
for x in A B C D; do [[ $(send "$(cat "$R/$x.coins.address")" 1000000) =~ ^[0-9a-f]{64}$ ]] || fail "funding $x's coin wallet"; done
"$C" mine 3 >/dev/null
ok "chain at $(tip); each host's coin wallet funded with 1,000,000 zatoshis of its own"

# 2. a relay and four sealed auctions (testing: a real quicknet round whose signature is known, late tickets 30 blocks after the deadline)
nohup "$BIN/ll-relay" serve --allow-regtest --dir "$R/relay" --listen "$RELAY" > "$R/relay.log" 2>&1 &
echo $! > "$R/relay.pid"
sleep 1
TUFVK=$("$DEVTOOL" wallet -w "$R/w/treasury" list-accounts 2>/dev/null | sed -n 's/.*UFVK: //p')
declare -A SENDING=([A]=at-once [B]=every-bids:3 [C]=every-minutes:2 [D]=every-bids:10)
for x in A B C D; do
  timeout 600 "$BIN/cb-host" create-sealed --run "$R/$x" --wallet "$R/$x/wallet1" --identity "$R/$x/wallet1.age" \
    --coin-wallet "$R/$x/coins1" --coin-identity "$R/$x/coins1.age" --network regtest --items 1 --tranches-zat 10000000,30000000 \
    --pricing uniform --treasury-address "$(cat "$R/w/treasury.address")" --treasury-ufvk "$TUFVK" --coin-sending "${SENDING[$x]}" \
    --deadline-in 60 --relay "http://$RELAY" --test-drand-round 33187201 --test-claim-after-in 30 > "$R/$x.create.log" 2>&1 || fail "create $x: $(tail -3 "$R/$x.create.log")"
done
DEADLINE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["deadline_height"])' "$R/A/rules.json")
CUTOFF=$(( DEADLINE - 10 ))
ok "four sealed auctions created; deadline $DEADLINE, coin cutoff $CUTOFF, coins at once from block $(( CUTOFF - 20 ))"

# 3. deposits: A two, B two (then a third), C one, D one
bid() { # $1 campaign, $2 seed name, $3 tranche, $4 bid: pays the deposit, prints its txid
  "$BIN/ll-contrib" keygen --out "$R/b/$2.seed" >/dev/null
  local memo; memo=$("$BIN/ll-contrib" bid-memo --rules "$R/$1/rules.json" --seed "$R/b/$2.seed" --refund-address "$(cat "$R/w/payer.address")" --tranche-zat "$3" --bid-zat "$4")
  send "$(cat "$R/$1/address")" "$3" "$memo"
}
A1=$(bid A a1 30000000 20000000); bid A a2 10000000 5000000 >/dev/null
bid B b1 10000000 7000000 >/dev/null; bid B b2 10000000 6000000 >/dev/null
bid C c1 10000000 4000000 >/dev/null
bid D d1 30000000 25000000 >/dev/null
"$C" mine 1 >/dev/null
for x in A B D; do watch $x; done
# C: the last batch went out just now, so the next is due in 2 minutes
python3 -c 'import time;print(int(time.time()))' > "$R/C/private/coins_last"
watch C
[ "$(count A issue)" = 2 ] && [ "$(count A coin)" = 2 ] || fail "A (at once): $(count A issue) deposits, $(count A coin) coins; $(cat "$R/A.watch.log")"
ok "A (at once): 2 deposits ticketed, 2 coins sent in the same pass, each with its late ticket"
[ "$(count B issue)" = 2 ] && [ "$(count B coin)" = 0 ] || fail "B: $(count B issue) deposits, $(count B coin) coins"
ok "B (every 3 bids): 2 deposits, no coins yet"
[ "$(count C issue)" = 1 ] && [ "$(count C coin)" = 0 ] || fail "C: $(count C issue) deposits, $(count C coin) coins"
ok "C (every 2 minutes): 1 deposit, no coin yet"
[ "$(count D issue)" = 1 ] && [ "$(count D coin)" = 0 ] || fail "D: $(count D issue) deposits, $(count D coin) coins"
ok "D (every 10 bids): 1 deposit, no coin yet"
grep -h "deposit ticketed" "$R/A.watch.log" | head -1
grep -h "coins sent\|coin entry" "$R/A.watch.log"

bid B b3 30000000 9000000 >/dev/null
"$C" mine 1 >/dev/null
watch B
[ "$(count B coin)" = 3 ] || fail "B after the third bid: $(count B coin) coins; $(cat "$R/B.watch.log")"
[ "$(grep -c "coins sent: 3 coin" "$R/B.watch.log")" = 1 ] || fail "B's three coins were not one transaction"
ok "B: the third bid sends 3 coins in one transaction"

sleep 125
watch C
[ "$(count C coin)" = 1 ] || fail "C after 2 minutes: $(count C coin) coins"
ok "C: the coin went out after 2 minutes"

watch D
[ "$(count D coin)" = 0 ] || fail "D sent a coin before the rush"
mine_to $(( CUTOFF - 20 ))
watch D
[ "$(count D coin)" = 1 ] || fail "D near the cutoff: $(count D coin) coins; $(cat "$R/D.watch.log")"
ok "D: at block $(tip), within 20 blocks of the cutoff, the coin went out though fewer than 10 bids came"

# 4. a deposit after the cutoff: tickets and a signed refund, no coin
mine_to $(( CUTOFF + 1 ))
bid D d2 10000000 9990000 >/dev/null
"$C" mine 1 >/dev/null
watch D
[ "$(count D issue)" = 2 ] && [ "$(count D coin)" = 1 ] || fail "D after the cutoff: $(count D issue) deposits, $(count D coin) coins"
ok "D: a deposit after the cutoff got its early ticket and signed refund, and no coin"

# 5. every host's own recount (phase 4) on the chain: nothing fails; coins checked against the chain
for x in A B C D; do
  timeout 600 "$BIN/cb-host" self-check --run "$R/$x" > "$R/$x.check.log" 2>&1 || fail "self check $x: $(cat "$R/$x.check.log")"
done
grep -E "^S[0-9]" "$R/D.check.log"
ok "self checks: A, B, C and D all PASS (S5 to S8 wait for the close)"

# 6. the early ticket: valid until the deadline, refused after it
"$BIN/ll-contrib" open-ticket --seed "$R/b/a1.seed" --relay "http://$RELAY" --campaign "$(cat "$R/A/rules_id")" --contribution "$A1:$(python3 -c '
import sys,json,glob
for f in glob.glob(sys.argv[1]+"/ledger/*.json"):
    e=json.load(open(f))
    if e["kind"]=="issue" and e["contribution"]["txid"]==sys.argv[2]: print(e["contribution"]["action"])' "$R/A" "$A1")" --out "$R/b/a1.early.hex" > "$R/a1.open.log" 2>&1 || fail "open-ticket: $(cat "$R/a1.open.log")"
# the version 5 and 6 header: version, version group, branch, lock time, expiry height (4 bytes each, little endian)
EXP=$(python3 -c 'import sys;b=bytes.fromhex(open(sys.argv[1]).read().strip());print(int.from_bytes(b[16:20],"little"))' "$R/b/a1.early.hex")
[ "$EXP" = "$DEADLINE" ] || fail "early ticket expiry $EXP, deadline $DEADLINE"
mine_to $(( DEADLINE ))
OUT=$("$C" rpc sendrawtransaction "[\"$(cat "$R/b/a1.early.hex")\"]")
echo "$OUT" | grep -qi "expir" || fail "the early ticket was not refused after the deadline: $OUT"
ok "early ticket expires at the deadline ($DEADLINE); sent at tip $(tip) it is refused: $(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["error"]["message"][:120])')"
echo "PASS: sealed auction intake on the private chain (NU7)"
