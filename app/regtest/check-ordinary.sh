#!/usr/bin/env bash
# The private chain check of the harness: on a new regtest chain with NU7 active, the host program (built with `--features regtest`)
# creates an ordinary auction, a contributor pays it with a real memo, the host issues today's ticket, the ticket opens from the relay
# and is mined as a withdrawal, and the contributor's wallet receives the payment minus the refund fee. Throwaway keys, no money, no
# public network. Usage: ZEBRAD=... BIN=<folder with cb-host, ll-relay, ll-contrib, zcash-devtool> app/regtest/check-ordinary.sh <run folder>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
R=${1:?run folder}
: "${ZEBRAD:?zebrad 7.0.0-rc.0}" "${BIN:?folder of the built programs}"
export DEVTOOL=$BIN/zcash-devtool
C=$HERE/chain.sh
RELAY=127.0.0.1:18787
fail() { echo "FAIL: $*"; exit 1; }
cleanup() {
  [ -f "$R/relay.pid" ] && kill "$(cat "$R/relay.pid")" 2>/dev/null || true
  [ -f "$R/chain/zebrad.pid" ] && "$C" stop "$R/chain" >/dev/null 2>&1 || true
}
trap cleanup EXIT
rm -rf "$R"
mkdir -p "$R/w" "$R/campaign" "$R/c1"

# 1. a chain, wallets born after block 2 (zebrad refuses a request for block 0), then mining to the funding wallet until its coins mature
"$C" start "$R/chain" >/dev/null
"$C" mine 5 >/dev/null
for n in funder payer; do "$C" wallet "$R/w" "$n" > "$R/w/$n.address"; done
"$C" wallet "$R/campaign" wallet1 > /dev/null
"$C" stop "$R/chain" >/dev/null
KEEP=1 "$C" start "$R/chain" "$(cat "$R/w/funder.address")" >/dev/null
"$C" mine 110 >/dev/null
timeout 300 "$DEVTOOL" wallet -w "$R/w/funder" sync -s 127.0.0.1:19067 >/dev/null 2>&1 || fail "funder sync"
echo "chain at $("$C" tip), branch $("$C" rpc getblockchaininfo | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["consensus"]["nextblock"])')"

# 2. a relay and an ordinary auction
nohup "$BIN/ll-relay" serve --allow-regtest --dir "$R/relay" --listen "$RELAY" > "$R/relay.log" 2>&1 &
echo $! > "$R/relay.pid"
sleep 1
timeout 300 "$BIN/cb-host" create --run "$R/campaign" --wallet "$R/campaign/wallet1" --identity "$R/campaign/wallet1.age" --backend libs \
  --network regtest --mode auction --items 1 --deadline-in 30 --relay "http://$RELAY" --min-contribution-zat 20000 > "$R/create.log" 2>&1 || fail "create: $(tail -3 "$R/create.log")"
RID=$(cat "$R/campaign/rules_id")
echo "auction $RID created"

# 3. a contribution with a real memo, sealed for 1,000,000 zatoshis, refunds to the payer's wallet
"$BIN/ll-contrib" keygen --out "$R/c1/seed" >/dev/null
MEMO=$("$BIN/ll-contrib" memo --rules "$R/campaign/rules.json" --seed "$R/c1/seed" --refund-address "$(cat "$R/w/payer.address")" --amount-zat 1000000)
TXID=$(timeout 300 "$DEVTOOL" wallet -w "$R/w/funder" send -i "$R/w/funder.age" --address "$(cat "$R/campaign/address")" --value 1000000 --memo "$MEMO" -s 127.0.0.1:19067 2>/dev/null | tail -1)
[[ $TXID =~ ^[0-9a-f]{64}$ ]] || fail "payment not sent"
"$C" mine 2 >/dev/null

# 4. the host issues the ticket and publishes it
timeout 300 "$BIN/cb-host" watch --run "$R/campaign" --once > "$R/watch1.log" 2>&1 || fail "watch: $(tail -3 "$R/watch1.log")"
grep -q "ticket issued: entry 0 for $TXID:" "$R/watch1.log" || fail "no ticket: $(cat "$R/watch1.log")"
grep -o "ticket [0-9a-f]* (branch [0-9a-f]*)" "$R/watch1.log"

# 5. the ticket opens from the relay, checks against the signed list, and is mined as a withdrawal
ACTION=$(sed -n "s/.*ticket issued: entry 0 for $TXID:\([0-9]*\).*/\1/p" "$R/watch1.log")
"$BIN/ll-contrib" open-ticket --seed "$R/c1/seed" --relay "http://$RELAY" --campaign "$RID" --contribution "$TXID:$ACTION" --out "$R/c1/ticket.hex" > "$R/open.log" 2>&1 || fail "open-ticket: $(cat "$R/open.log")"
grep "ticket OK" "$R/open.log"
TICKET=$("$C" rpc sendrawtransaction "[\"$(cat "$R/c1/ticket.hex")\"]" | python3 -c 'import sys,json;v=json.load(sys.stdin);print(v.get("result") or v["error"]["message"])')
[[ $TICKET =~ ^[0-9a-f]{64}$ ]] || fail "ticket refused: $TICKET"
"$C" mine 10 >/dev/null   # the wallet counts a received note as spendable after several confirmations
"$C" rpc getrawtransaction "[\"$TICKET\",1]" | python3 -c 'import sys,json;t=json.load(sys.stdin)["result"];print("ticket mined in block",t["height"],"version",t["version"],"expiry",t["expiryheight"])'

# 6. the payer's wallet received 1,000,000 minus the 10,000 refund fee; the host saw the withdrawal
timeout 300 "$DEVTOOL" wallet -w "$R/w/payer" sync -s 127.0.0.1:19067 >/dev/null 2>&1 || fail "payer sync"
"$DEVTOOL" wallet -w "$R/w/payer" balance 2>/dev/null | tr -d ' \n' | grep -q "ironwood_balance:Balance{spendable_value:Zatoshis(990000,)" || fail "payer balance is not 990000"
echo "payer received 990000 zatoshis"
timeout 300 "$BIN/cb-host" watch --run "$R/campaign" --once > "$R/watch2.log" 2>&1 || fail "watch 2"
grep -q "spent by $TICKET" "$R/watch2.log" || fail "the host did not see the withdrawal: $(cat "$R/watch2.log")"
echo "PASS: ordinary auction on the private chain (NU7), ticket issued, opened, mined, refunded"
