#!/usr/bin/env bash
# Private chain check of the fixes from the independent review (research note 20) that touch the chain: four sealed bid auctions on one
# regtest chain with NU7 active, made with open payouts and the long tag. A has an honest host: a valid deposit that a cheating step
# rejects (H3) and a second payment with an accepted deposit's memo (M5) are sent back on their own, and so is a payment in the last
# blocks before the deadline; after the close every refund, change and return is opened on the chain with its own outgoing key and pays
# the refund address in its memo (C1, H2): A's recount passes. B's host keeps a payment it rejected (S7 fails). C's host signs refunds
# that pay its own address (C1: S7 fails). D's host sends a winner's change to its own address (H2: S6 fails). E's host makes early tickets
# that pay its own address, sealed without opening values (the second review's C1): one person takes the deposit back with it anyway, and
# S4 fails. A's relay copy with the rejected payer's page state, and E's (before the take back) with its first payer's, are kept for the bid
# page tests (app/web/bid-page-reject-e2e.cjs). Offline, throwaway keys, no money.
# Usage: ZEBRAD=... BIN=<folder with cb-host (regtest and test-cheats build), ll-relay, ll-contrib, zcash-devtool (regtest build)>
#        check-sealed-review.sh <run folder>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
R=${1:?run folder}
: "${ZEBRAD:?zebrad 7.0.0-rc.0}" "${BIN:?folder of the built programs}"
export DEVTOOL=$BIN/zcash-devtool
C=$HERE/chain.sh
RELAY=127.0.0.1:18787
LWD=127.0.0.1:19067
CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
ROUND=33187201
SIG=943614203a936e3d4ac466aa2b475e9c1e614f4759fe45b7f4bedeb0316d172e6cacadb08a46b39c67c09555dc6db3a5
export CB_DRAND_URLS="http://127.0.0.1:18791"
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok: $*"; }
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  [ -f "$R/chain/zebrad.pid" ] && "$C" stop "$R/chain" >/dev/null 2>&1 || true
}
trap cleanup EXIT
rm -rf "$R"
mkdir -p "$R/w" "$R/b"
R=$(cd "$R" && pwd)
tip() { "$C" tip; }
mine_to() { local t; t=$(tip); [ "$1" -gt "$t" ] && "$C" mine $(( $1 - t )) >/dev/null; true; }
sync_w() { timeout 600 "$DEVTOOL" wallet -w "$1" sync -s "$LWD" >/dev/null 2>&1 || true; }
send() { # $1 to, $2 zatoshis, $3 memo (optional): prints the txid
  sync_w "$R/w/funder"
  local args=(wallet -w "$R/w/funder" send -i "$R/w/funder.age" --address "$1" --value "$2" -s "$LWD")
  [ -n "${3:-}" ] && args+=(--memo "$3")
  timeout 600 "$DEVTOOL" "${args[@]}" 2>/dev/null | tail -1
}
field() { python3 -c 'import sys,json;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
entry() { # $1 campaign, $2 python expression over the list `L` of entries
  python3 -c 'import sys,json,glob;L=[json.load(open(f)) for f in sorted(glob.glob(sys.argv[1]+"/ledger/*.json"))];print(eval(sys.argv[2]))' "$R/$1" "$2"
}
# each auction's own cheat, for its watcher and its close (test-cheats build only)
declare -A CHEAT=([A]="" [B]="LL_TEST_KEEP_REJECTS=1" [C]="" [D]="" [E]="")
watch() { env ${CHEAT[$1]} timeout 900 "$BIN/cb-host" watch --run "$R/$1" --once > "$R/$1.watch.log" 2>&1 || fail "watch $1: $(tail -5 "$R/$1.watch.log")"; }

mkdir -p "$R/drand/$CHAIN_HASH/public"
echo "{\"round\":$ROUND,\"signature\":\"$SIG\"}" > "$R/drand/$CHAIN_HASH/public/$ROUND"
python3 -m http.server 18791 --bind 127.0.0.1 --directory "$R/drand" > "$R/drand.log" 2>&1 & PIDS+=($!)

# 1. chain, wallets, funding
"$C" start "$R/chain" >/dev/null
"$C" mine 5 >/dev/null
for n in funder payer treasury thief; do "$C" wallet "$R/w" "$n" > "$R/w/$n.address"; done
for x in A B C D E; do
  mkdir -p "$R/$x"
  "$C" wallet "$R/$x" wallet1 > /dev/null
  "$C" wallet "$R/$x" coins1 > "$R/$x.coins.address"
done
"$C" stop "$R/chain" >/dev/null
KEEP=1 "$C" start "$R/chain" "$(cat "$R/w/funder.address")" >/dev/null
"$C" mine 110 >/dev/null
for x in A B C D E; do [[ $(send "$(cat "$R/$x.coins.address")" 1000000) =~ ^[0-9a-f]{64}$ ]] || fail "funding $x's coin wallet"; done
"$C" mine 3 >/dev/null
nohup "$BIN/ll-relay" serve --allow-regtest --dir "$R/relay" --listen "$RELAY" > "$R/relay.log" 2>&1 & PIDS+=($!)
sleep 1
TUFVK=$("$DEVTOOL" wallet -w "$R/w/treasury" list-accounts 2>/dev/null | sed -n 's/.*UFVK: //p')
THIEF=$(cat "$R/w/thief.address")
CHEAT[C]="LL_TEST_REFUND_TO=$THIEF"
CHEAT[E]="LL_TEST_EARLY_TO=$THIEF"
for x in A B C D E; do
  timeout 600 "$BIN/cb-host" create-sealed --run "$R/$x" --wallet "$R/$x/wallet1" --identity "$R/$x/wallet1.age" \
    --coin-wallet "$R/$x/coins1" --coin-identity "$R/$x/coins1.age" --network regtest --items 1 --tranches-zat 10000000,30000000 \
    --pricing second --reserve-zat 1000000 --treasury-address "$(cat "$R/w/treasury.address")" --treasury-ufvk "$TUFVK" \
    --coin-sending at-once --deadline-in 40 --relay "http://$RELAY" --test-drand-round $ROUND --test-claim-after-in 25 > "$R/$x.create.log" 2>&1 \
    || fail "create $x: $(tail -3 "$R/$x.create.log")"
  grep -q '"open_payouts": true' "$R/$x/rules.json" && grep -q '"long_tag": true' "$R/$x/rules.json" && grep -q '"early_key": true' "$R/$x/rules.json" || fail "$x is not made with open payouts, the long tag and the early key"
done
DEADLINE=$(field "$R/A/rules.json" deadline_height)
ok "chain at $(tip); five blind bid auctions with open payouts, the long tag and the early key, deadline $DEADLINE"

# 2. two bids in each (20M in the 30M tranche, 5M in the 10M tranche); the bound memos fill 512 bytes
declare -A DEP MEMO
bid() { # $1 campaign, $2 name, $3 tranche, $4 bid
  "$BIN/ll-contrib" keygen --out "$R/b/$2.seed" >/dev/null
  MEMO[$2]=$("$BIN/ll-contrib" bid-memo --rules "$R/$1/rules.json" --seed "$R/b/$2.seed" --refund-address "$(cat "$R/w/payer.address")" --tranche-zat "$3" --bid-zat "$4")
  echo -n "${MEMO[$2]}" > "$R/b/$2.memo"
  DEP[$2]=$(send "$(cat "$R/$1/address")" "$3" "${MEMO[$2]}")
  [[ ${DEP[$2]} =~ ^[0-9a-f]{64}$ ]] || fail "deposit $2"
  echo "$3" > "$R/b/$2.paid"
}
for x in A B C D E; do
  l=$(echo $x | tr A-Z a-z)
  bid $x ${l}1 30000000 20000000; bid $x ${l}2 10000000 5000000
done
[ "${#MEMO[a1]}" = 512 ] || fail "the bound memo is ${#MEMO[a1]} bytes, not 512"
# the deposits that a cheating step rejects before the host tickets them (H3): A's and B's third payer
bid A a3 10000000 4000000; bid B b3 10000000 4000000
# the second review, M1: a5 pays 0.31 with a memo made for the 0.3 deposit (a person who typed a little more): a deposit like any other
"$BIN/ll-contrib" keygen --out "$R/b/a5.seed" >/dev/null
MEMO[a5]=$("$BIN/ll-contrib" bid-memo --rules "$R/A/rules.json" --seed "$R/b/a5.seed" --refund-address "$(cat "$R/w/payer.address")" --tranche-zat 30000000 --bid-zat 6000000)
echo -n "${MEMO[a5]}" > "$R/b/a5.memo"
DEP[a5]=$(send "$(cat "$R/A/address")" 31000000 "${MEMO[a5]}")
[[ ${DEP[a5]} =~ ^[0-9a-f]{64}$ ]] || fail "deposit a5"
"$C" mine 1 >/dev/null
force_reject() { # $1 campaign, $2 name
  local a
  for a in 0 1 2; do timeout 600 "$BIN/cb-host" force-reject --run "$R/$1" --contribution "${DEP[$2]}:$a" > "$R/$1.reject.log" 2>&1 && return 0; done
  fail "force reject $2: $(cat "$R/$1.reject.log")"
}
force_reject A a3; force_reject B b3
for x in A B C D E; do watch $x; done
for x in A B C D E; do
  want=2; [ $x = A ] && want=3
  [ "$(entry $x 'sum(e["kind"]=="issue" for e in L)')" = $want ] || fail "$x: deposits: $(cat "$R/$x.watch.log")"
done
# E: kept for the bid page test before anything is taken back; then e1 takes its deposit back with the early ticket the host made
mkdir -p "$R/fixture-early"
cp -r "$R/relay" "$R/fixture-early/relay"
python3 - "$R" "$(cat "$R/E/rules_id")" "$(cat "$R/b/e1.seed")" "$(cat "$R/w/payer.address")" <<'PY'
import json, sys
R, rid, seed, refund = sys.argv[1:5]
json.dump({"E": rid, "e1": {"seed": seed, "memo": open(f"{R}/b/e1.memo").read(), "tranche": 30000000, "bid": 20000000, "refund": refund}}, open(f"{R}/fixture-early/fixture.json", "w"), indent=1)
PY
E1A=$(entry E "[e['contribution']['action'] for e in L if e['kind']=='issue' and e['contribution']['txid']=='${DEP[e1]}'][0]")
"$BIN/ll-contrib" open-ticket --seed "$R/b/e1.seed" --relay "http://$RELAY" --campaign "$(cat "$R/E/rules_id")" --contribution "${DEP[e1]}:$E1A" \
  --out "$R/b/e1.early.hex" > "$R/b/e1.early.log" 2>&1 || fail "e1 could not open its early ticket: $(cat "$R/b/e1.early.log")"
T=$("$C" rpc sendrawtransaction "[\"$(cat "$R/b/e1.early.hex")\"]" | python3 -c 'import sys,json;v=json.load(sys.stdin);print(v.get("result") or v["error"]["message"])')
[[ $T =~ ^[0-9a-f]{64}$ ]] || fail "e1's early ticket was refused: $T"
"$C" mine 1 >/dev/null
ok "E: e1 took its deposit back with the early ticket the cheating host made ($T)"
grep -q "a payment the host rejected" "$R/A.watch.log" || fail "A did not send its rejected payment back: $(cat "$R/A.watch.log")"
grep -q "a payment the host rejected" "$R/B.watch.log" && fail "B's cheating host sent its rejected payment back"
ok "A's falsely rejected payment went back on its own (H3); B's cheating host kept its own"

# 3. M5: a second payment with a1's memo; a payment in the last blocks before the deadline
DEP[a1again]=$(send "$(cat "$R/A/address")" 30000000 "${MEMO[a1]}")
[[ ${DEP[a1again]} =~ ^[0-9a-f]{64}$ ]] || fail "the repeated payment"
"$C" mine 1 >/dev/null
watch A
grep -q "a payment the host rejected" "$R/A.watch.log" || fail "the repeated payment was not sent back: $(cat "$R/A.watch.log")"
mine_to $(( DEADLINE - 2 ))
"$BIN/ll-contrib" keygen --out "$R/b/a4.seed" >/dev/null
M4=$("$BIN/ll-contrib" bid-memo --rules "$R/A/rules.json" --seed "$R/b/a4.seed" --refund-address "$(cat "$R/w/payer.address")" --tranche-zat 10000000 --bid-zat 3000000)
DEP[a4]=$(send "$(cat "$R/A/address")" 10000000 "$M4")
"$C" mine 1 >/dev/null
for x in A B C D E; do watch $x; done
grep -q "too late to bid" "$R/A.watch.log" || fail "A's late payment was not sent back: $(cat "$R/A.watch.log")"
"$C" mine 2 >/dev/null
ok "the repeated payment (M5) and the payment in the last blocks went back on their own"

# 4. close every auction after the deadline (D's host sends the winner's change to its own address)
mine_to $(( DEADLINE + 1 ))
CHEAT[D]="LL_TEST_CHANGE_TO=$THIEF"
for x in A B C D E; do
  env ${CHEAT[$x]} timeout 900 "$BIN/cb-host" close-sealed --run "$R/$x" > "$R/$x.close.log" 2>&1 || fail "close $x: $(cat "$R/$x.close.log")"
done
"$C" mine 2 >/dev/null
for x in A B C D E; do watch $x; done
"$C" mine 1 >/dev/null
for x in A B C D E; do
  watch $x
  [ "$(entry $x 'sum(e["kind"]=="reveal" for e in L)')" = 1 ] || fail "$x: no viewing key yet: $(cat "$R/$x.watch.log")"
  entry $x '[e["reveal"].get("payload_sk") is not None for e in L if e["kind"]=="reveal"][0]' | grep -q True || fail "$x: the reveal has no payload key"
done
"$C" mine 12 >/dev/null
ok "closed, settled and revealed with the payload key; $(tip)"

# 5. the recounts, from the chain: each payment opened with its own outgoing key
sync_w "$R/w/treasury"
check() { timeout 600 "$BIN/cb-host" self-check --run "$R/$1" --treasury-wallet "$R/w/treasury" > "$R/$1.check.log" 2>&1; }
check A || fail "A's recount: $(cat "$R/A.check.log")"
grep -E "^(S6|S7)" -A6 "$R/A.check.log" | head -20
[ "$(grep -c "was rejected or repeated a deposit's memo, and was sent back by" "$R/A.check.log")" = 2 ] || fail "A: the two returns are not both checked"
grep -q "came too late to bid" "$R/A.check.log" || fail "A: the late return is not checked"
ok "A passes: the refund, the change and the three returns pay the refund addresses in their memos, opened on the chain (C1, H2, H3, M5)"
check B && fail "B's recount passed although its host kept a rejected payment"
grep -q "was rejected or repeated a deposit's memo, and was not sent back within" "$R/B.check.log" || fail "B: $(cat "$R/B.check.log")"
ok "B fails S7: $(grep -o "payment [0-9a-f]* (block [0-9]*) was rejected[^|]*" "$R/B.check.log" | head -1)"
check C && fail "C's recount passed although its refunds pay the host"
grep -q "the refund .* does not pay" "$R/C.check.log" || fail "C: $(cat "$R/C.check.log")"
ok "C fails S7: $(grep -o "deposit [0-9a-f]*: the refund [0-9a-f]* does not pay[^|]*" "$R/C.check.log" | head -1 | cut -c1-200)"
check D && fail "D's recount passed although the change went to the host"
grep -q "the change in .* does not pay" "$R/D.check.log" || fail "D: $(cat "$R/D.check.log")"
ok "D fails S6: $(grep -o "winner [0-9a-f]*: the change in [0-9a-f]* does not pay[^|]*" "$R/D.check.log" | head -1 | cut -c1-200)"

check E && fail "E's recount passed although a deposit was taken back to the host's address"
grep -q "the early ticket .* does not pay" "$R/E.check.log" || fail "E: $(cat "$R/E.check.log")"
ok "E fails S4: $(grep -o "deposit [0-9a-f]*: the early ticket [0-9a-f]* does not pay[^|]*" "$R/E.check.log" | head -1 | cut -c1-200)"

# 6. kept for the bid page test: A's public list from the relay, and the falsely rejected payer's page state
mkdir -p "$R/fixture"
cp -r "$R/relay" "$R/fixture/relay"
python3 - "$R" "$(cat "$R/A/rules_id")" "$(cat "$R/b/a3.seed")" "$(cat "$R/w/payer.address")" <<'EOF'
import json, sys
R, rid, seed, refund = sys.argv[1:5]
memo = open(f"{R}/b/a3.memo").read()
a5 = {"seed": open(f"{R}/b/a5.seed").read().strip(), "memo": open(f"{R}/b/a5.memo").read(), "tranche": 30000000, "bid": 6000000, "refund": refund, "paid": 31000000}
json.dump({"A": rid, "a3": {"seed": seed, "memo": memo, "tranche": 10000000, "bid": 4000000, "refund": refund}, "a5": a5}, open(f"{R}/fixture/fixture.json", "w"), indent=1)
EOF
ok "fixture for the bid page test in $R/fixture"
echo "PASS: review fixes on the private chain (NU7)"
