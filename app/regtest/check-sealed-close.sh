#!/usr/bin/env bash
# Private chain check of the sealed bid auction's close (phase 7): four auctions on one regtest chain with NU7 active, three bids each.
# U (uniform price), S (second price) and P (pay your bid) are closed by their hosts: round R's signature comes from a local stand in for
# drand (the first address is down, the second gives a forged signature, the third the real one; each is checked against the pinned key),
# the bids open, the winners are settled to the treasury, the others get their signed refunds, and the viewing key is published once the
# settlements are mined; each host's recount passes. N's host never closes: the payers' late tickets, checked and signed by the payers,
# are refused before the late ticket block and mined after it, and the recount says "did not finish". Offline, throwaway keys, no money.
# Usage: ZEBRAD=... BIN=<folder with cb-host (regtest build), ll-relay, ll-contrib, zcash-devtool (regtest build)> check-sealed-close.sh <run folder>
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
SIG_1000=b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39
export CB_DRAND_URLS="http://127.0.0.1:1,http://127.0.0.1:18792,http://127.0.0.1:18791"
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
watch() { timeout 900 "$BIN/cb-host" watch --run "$R/$1" --once > "$R/$1.watch.log" 2>&1 || fail "watch $1: $(tail -5 "$R/$1.watch.log")"; }

# 0. a local stand in for drand: a good answer and a forged one (the real signature of another round)
mkdir -p "$R/drand/good/$CHAIN_HASH/public" "$R/drand/forged/$CHAIN_HASH/public"
echo "{\"round\":$ROUND,\"signature\":\"$SIG\"}" > "$R/drand/good/$CHAIN_HASH/public/$ROUND"
echo "{\"round\":$ROUND,\"signature\":\"$SIG_1000\"}" > "$R/drand/forged/$CHAIN_HASH/public/$ROUND"
python3 -m http.server 18791 --bind 127.0.0.1 --directory "$R/drand/good" > "$R/drand-good.log" 2>&1 & PIDS+=($!)
python3 -m http.server 18792 --bind 127.0.0.1 --directory "$R/drand/forged" > "$R/drand-forged.log" 2>&1 & PIDS+=($!)

# 1. chain, wallets, funding
"$C" start "$R/chain" >/dev/null
"$C" mine 5 >/dev/null
for n in funder payer treasury; do "$C" wallet "$R/w" "$n" > "$R/w/$n.address"; done
for x in U S P N; do
  mkdir -p "$R/$x"
  "$C" wallet "$R/$x" wallet1 > /dev/null
  "$C" wallet "$R/$x" coins1 > "$R/$x.coins.address"
done
"$C" stop "$R/chain" >/dev/null
KEEP=1 "$C" start "$R/chain" "$(cat "$R/w/funder.address")" >/dev/null
"$C" mine 110 >/dev/null
for x in U S P N; do [[ $(send "$(cat "$R/$x.coins.address")" 1000000) =~ ^[0-9a-f]{64}$ ]] || fail "funding $x's coin wallet"; done
"$C" mine 3 >/dev/null
nohup "$BIN/ll-relay" serve --allow-regtest --dir "$R/relay" --listen "$RELAY" > "$R/relay.log" 2>&1 & PIDS+=($!)
sleep 1
TUFVK=$("$DEVTOOL" wallet -w "$R/w/treasury" list-accounts 2>/dev/null | sed -n 's/.*UFVK: //p')
declare -A PRICING=([U]=uniform [S]=second [P]=pay_your_bid [N]=uniform)
for x in U S P N; do
  timeout 600 "$BIN/cb-host" create-sealed --run "$R/$x" --wallet "$R/$x/wallet1" --identity "$R/$x/wallet1.age" \
    --coin-wallet "$R/$x/coins1" --coin-identity "$R/$x/coins1.age" --network regtest --items 2 --tranches-zat 10000000,30000000 \
    --pricing "${PRICING[$x]}" --reserve-zat 1000000 --treasury-address "$(cat "$R/w/treasury.address")" --treasury-ufvk "$TUFVK" \
    --coin-sending at-once --deadline-in 40 --relay "http://$RELAY" --test-drand-round $ROUND --test-claim-after-in 25 > "$R/$x.create.log" 2>&1 \
    || fail "create $x: $(tail -3 "$R/$x.create.log")"
done
DEADLINE=$(field "$R/U/rules.json" deadline_height)
HS=$(( DEADLINE + 25 ))
ok "chain at $(tip); four sealed auctions, deadline $DEADLINE, late tickets valid after $HS"

# 2. three bids in each: 20M in the 30M tranche, 8M and 5M in the 10M tranche
declare -A DEP
bid() { # $1 campaign, $2 name, $3 tranche, $4 bid
  "$BIN/ll-contrib" keygen --out "$R/b/$2.seed" >/dev/null
  local memo; memo=$("$BIN/ll-contrib" bid-memo --rules "$R/$1/rules.json" --seed "$R/b/$2.seed" --refund-address "$(cat "$R/w/payer.address")" --tranche-zat "$3" --bid-zat "$4")
  DEP[$2]=$(send "$(cat "$R/$1/address")" "$3" "$memo")
  [[ ${DEP[$2]} =~ ^[0-9a-f]{64}$ ]] || fail "deposit $2"
  echo "$3" > "$R/b/$2.paid"
}
for x in U S P N; do
  l=$(echo $x | tr A-Z a-z)
  bid $x ${l}1 30000000 20000000; bid $x ${l}2 10000000 8000000; bid $x ${l}3 10000000 5000000
done
"$C" mine 1 >/dev/null
for x in U S P N; do watch $x; done
for x in U S P N; do
  [ "$(entry $x 'sum(e["kind"]=="issue" for e in L)')" = 3 ] && [ "$(entry $x 'sum(e["kind"]=="coin" for e in L)')" = 3 ] || fail "$x: deposits and coins: $(cat "$R/$x.watch.log")"
done
"$C" mine 2 >/dev/null
ok "every deposit has its early ticket, signed refund, coin and late ticket"

# 3. the payers of N (and one of U) check their late tickets against the chain and sign them
late() { # $1 campaign, $2 name
  local action; action=$(entry $1 "[e['contribution']['action'] for e in L if e['kind']=='issue' and e['contribution']['txid']=='${DEP[$2]}'][0]")
  "$BIN/ll-contrib" late-ticket --seed "$R/b/$2.seed" --relay "http://$RELAY" --campaign "$(cat "$R/$1/rules_id")" --contribution "${DEP[$2]}:$action" \
    --paid-zat "$(cat "$R/b/$2.paid")" --refund-address "$(cat "$R/w/payer.address")" --server "http://$LWD" --out "$R/b/$2.late.hex" > "$R/b/$2.late.log" 2>&1 \
    || fail "late ticket $2: $(cat "$R/b/$2.late.log")"
}
late N n1; late N n2; late N n3; late U u3
cat "$R/b/n1.late.log"
ok "late tickets checked (coin, anchor, refund output, signatures, proof) and signed by their payers' pages"

# 4. after the deadline U, S and P close; N does not
mine_to $(( DEADLINE + 1 ))
for x in U S P; do
  timeout 900 "$BIN/cb-host" close-sealed --run "$R/$x" > "$R/$x.close.log" 2>&1 || fail "close $x: $(cat "$R/$x.close.log")"
done
grep -h "signature from\|WINS\|no bid\|close entry" "$R/U.close.log"
grep -q "from http://127.0.0.1:18791" "$R/U.close.log" || fail "the round did not come from the good address"
"$C" mine 2 >/dev/null
for x in U S P; do watch $x; done
"$C" mine 1 >/dev/null
for x in U S P; do
  watch $x
  [ "$(entry $x 'sum(e["kind"]=="reveal" for e in L)')" = 1 ] || fail "$x: no viewing key yet: $(cat "$R/$x.watch.log")"
done
ok "U, S and P closed: settlements mined, then the viewing key published"
P_U=$(entry U '[e["close"]["clearing_price_zat"] for e in L if e["kind"]=="close"][0]')
P_S=$(entry S '[e["close"]["clearing_price_zat"] for e in L if e["kind"]=="close"][0]')
P_P=$(entry P 'sorted(e["settle"]["price_zat"] for e in L if e["kind"]=="settle")')
[ "$P_U" = 8000000 ] && [ "$P_S" = 5000000 ] && [ "$P_P" = "[8000000, 20000000]" ] || fail "prices: uniform $P_U, second $P_S, pay your bid $P_P"
ok "prices: uniform 8,000,000 (the lowest winning bid), second 5,000,000 (the highest losing bid), pay your bid 20,000,000 and 8,000,000"
sync_w "$R/w/treasury"
for x in U S P; do
  timeout 600 "$BIN/cb-host" self-check --run "$R/$x" --treasury-wallet "$R/w/treasury" > "$R/$x.check.log" 2>&1 || fail "self check $x: $(cat "$R/$x.check.log")"
done
grep -E "^(S[0-9]|R[0-9])|RESULT|deposits" "$R/P.check.log"
ok "the recount passes for U, S and P, treasury amounts included"

# 5. U's loser was refunded, so its late ticket is dead; N's late tickets wait for the late ticket block, then work
OUT=$("$C" rpc sendrawtransaction "[\"$(cat "$R/b/n1.late.hex")\"]")
echo "$OUT" | grep -qi "lock" || fail "N's late ticket was not refused before block $HS: $OUT"
ok "before the late ticket block: $(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["error"]["message"][:100])')"
mine_to $(( HS + 1 ))
for n in n1 n2 n3; do
  T=$("$C" rpc sendrawtransaction "[\"$(cat "$R/b/$n.late.hex")\"]" | python3 -c 'import sys,json;v=json.load(sys.stdin);print(v.get("result") or v["error"]["message"])')
  # the node may still hold the copy sent before the late ticket block (refused for mining then, kept in its mempool): that is the same ticket
  [[ $T =~ ^[0-9a-f]{64}$ || $T == "transaction already exists in mempool" ]] || fail "late ticket $n refused after the late ticket block: $T"
done
"$C" mine 2 >/dev/null
POOL=$("$C" rpc getrawmempool | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]))')
[ "$POOL" = 0 ] || fail "N's late tickets were not mined: $POOL transaction(s) still in the mempool"
OUT=$("$C" rpc sendrawtransaction "[\"$(cat "$R/b/u3.late.hex")\"]")
echo "$OUT" | grep -qiE "spent|duplicate|nullifier|missing|inputs" || fail "U's refunded deposit's late ticket was accepted: $OUT"
"$C" mine 2 >/dev/null
ok "after block $HS N's three late tickets were mined; U's refunded loser's late ticket was refused: $(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["error"]["message"][:80])')"
timeout 600 "$BIN/cb-host" self-check --run "$R/N" > "$R/N.check.log" 2>&1 && fail "N's recount passed although its host never closed"
grep -q "did not finish true" "$R/N.check.log" || fail "N not marked did not finish: $(cat "$R/N.check.log")"
grep -E "^S5|did not finish" "$R/N.check.log"
ok "N's recount: the host did not finish; every deposit went back by its late ticket"
echo "PASS: sealed auction close on the private chain (NU7)"
