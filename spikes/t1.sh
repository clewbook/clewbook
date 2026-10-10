#!/usr/bin/env bash
# Spike 01, test T1: hold a pre-signed no-expiry ticket, broadcast it later.
#
# Steps:
#   1. bidder sends a bid to campaign
#   2. wait until campaign can spend the bid
#   3. campaign builds, proves and signs a refund ticket with expiry height 0
#      (not broadcast), and checks the expiry really is 0
#   4. wait WAIT_BLOCKS blocks (default 200, about 1.5 hours at 25 s blocks)
#   5. broadcast the ticket, wait for it to be mined, confirm bidder got it
#
# Safe to re-run: each finished step leaves a file in spikes/out/t1/ and is
# skipped next time, so if the terminal closes just run the script again.
#
# Settings (environment variables):
#   BID=1000000           bid in zatoshis (0.01 TAZ)
#   TICKET_VALUE=990000   refund amount = bid minus fee
#   WAIT_BLOCKS=200       blocks to hold the ticket before broadcasting
#   BLOCK_SECS=25         expected block time, only used for the countdown

set -euo pipefail

BID=${BID:-1000000}
TICKET_VALUE=${TICKET_VALUE:-990000}
WAIT_BLOCKS=${WAIT_BLOCKS:-200}
BLOCK_SECS=${BLOCK_SECS:-25}

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/spikes/out/t1"
ZD="$REPO/target/release/zcash-devtool"
mkdir -p "$OUT"
cd "$REPO"
exec > >(tee -a "$OUT/t1.log") 2>&1

say()  { echo "[$(date -u +%H:%M:%SZ)] $*"; }
fail() { say "STOPPED: $*"; exit 1; }
quiet() { "$@" 2> >(grep -v 'INFO' >&2); }

tip() {
    "$ZD" wallet -w campaign get-info 2>/dev/null \
        | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2
}
branch() {  # consensus branch ID the server is currently using
    "$ZD" wallet -w campaign get-info 2>/dev/null \
        | grep -o '"consensus_branch_id":"[0-9a-f]*"' | cut -d'"' -f4
}
spendable() {  # zatoshis spendable in any shielded pool
    "$ZD" wallet -w "$1" balance --json 2>/dev/null | python3 -c '
import json, sys
b = json.load(sys.stdin)
print(sum(b.get(k, 0) for k in ("ironwood_spendable", "orchard_spendable", "sapling_spendable")))'
}
sync() { quiet "$ZD" wallet -w "$1" sync >/dev/null; }
address() {
    "$ZD" wallet -w "$1" list-addresses 2>/dev/null \
        | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3
}
mined_height() {  # wallet, txid -> mined height, or empty if not mined
    "$ZD" wallet -w "$1" list-tx --json 2>/dev/null | python3 -c '
import json, sys
for t in json.load(sys.stdin):
    if t["txid"] == sys.argv[1] and t["mined_height"] is not None:
        print(t["mined_height"])' "$2"
}
last_txid() { grep -oE '^[0-9a-f]{64}$' "$1" | tail -1; }

[ -x "$ZD" ] || fail "tool not built: run cargo build --release"
for w in campaign bidder; do
    [ -d "$w" ] && [ -f "$w.age" ] || fail "wallet $w or $w.age missing"
done
CAMPAIGN_UA=$(address campaign)
BIDDER_UA=$(address bidder)
[ -n "$CAMPAIGN_UA" ] && [ -n "$BIDDER_UA" ] || fail "could not read wallet addresses"
say "T1 start. bid=$BID ticket=$TICKET_VALUE wait=$WAIT_BLOCKS blocks"

# 1. Bid
if [ ! -s "$OUT/bid.txid" ]; then
    sync bidder
    have=$(spendable bidder)
    need=$((BID + 20000))
    [ "$have" -ge "$need" ] || fail "bidder has $have spendable zatoshis, needs $need. Faucet funds not confirmed yet? Try again later."
    say "1. Sending bid of $BID from bidder to campaign"
    echo y | "$ZD" wallet -w bidder send -i bidder.age \
        --address "$CAMPAIGN_UA" --value "$BID" 2>&1 | tee "$OUT/bid.out" || true
    last_txid "$OUT/bid.out" > "$OUT/bid.txid" || true
    [ -s "$OUT/bid.txid" ] || { rm -f "$OUT/bid.txid"; fail "bid send failed, see above"; }
fi
say "1. Bid txid: $(cat "$OUT/bid.txid")"

# 2. Wait until campaign can spend the bid (default policy: 10 confirmations)
if [ ! -f "$OUT/t1.signed" ]; then
    say "2. Waiting for campaign to be able to spend the bid (about 10 blocks)"
    while :; do
        sync campaign
        have=$(spendable campaign)
        [ "$have" -ge "$BID" ] && break
        say "   campaign spendable: $have, tip $(tip). Checking again in 2 minutes."
        sleep 120
    done
    say "2. Campaign can spend $have zatoshis"
fi

# 3. Build, prove and sign the ticket. Do not broadcast.
if [ ! -f "$OUT/t1.signed" ]; then
    say "3. Building ticket: $TICKET_VALUE to bidder, expiry height 0"
    quiet "$ZD" pczt -w campaign create --address "$BIDDER_UA" \
        --value "$TICKET_VALUE" --expiry-height 0 --output "$OUT/t1.pczt" \
        || fail "pczt create failed. If the error mentions insufficient funds or fee, re-run with TICKET_VALUE=<bid minus the fee it reports>."
    quiet "$ZD" pczt -w campaign prove -i campaign.age "$OUT/t1.pczt" --output "$OUT/t1.proven"
    quiet "$ZD" pczt -w campaign sign  -i campaign.age "$OUT/t1.proven" --output "$OUT/t1.signed.tmp"
    "$ZD" pczt -w campaign inspect -i campaign.age "$OUT/t1.signed.tmp" > "$OUT/t1.inspect.txt" 2>&1
    cat "$OUT/t1.inspect.txt"
    grep -qx 'Expiry height: 0' "$OUT/t1.inspect.txt" \
        || fail "ticket does NOT have expiry height 0. Test invalid, not continuing."
    quiet "$ZD" pczt extract < "$OUT/t1.signed.tmp" | grep -oE '^[0-9a-f]{64}$' > "$OUT/ticket.txid" \
        || fail "signed ticket does not extract to a complete transaction (missing signature?), see above"
    tip > "$OUT/created.height"
    branch > "$OUT/created.branch"
    mv "$OUT/t1.signed.tmp" "$OUT/t1.signed"
    say "3. Ticket signed and held. Expiry height 0 confirmed."
fi
CREATED=$(cat "$OUT/created.height")
TICKET_TXID=$(cat "$OUT/ticket.txid")
say "3. Ticket txid $TICKET_TXID, signed at height $CREATED"

# 4. Hold the ticket
TARGET=$((CREATED + WAIT_BLOCKS))
if [ ! -s "$OUT/broadcast.txid" ]; then
    while :; do
        now=$(tip)
        [ "$now" -ge "$TARGET" ] && break
        left=$((TARGET - now))
        say "4. Holding ticket: height $now, broadcast at $TARGET ($left blocks, about $((left * BLOCK_SECS / 60)) min)"
        sleep 600
    done
fi

# 5. Broadcast
if [ ! -s "$OUT/broadcast.txid" ]; then
    tip > "$OUT/broadcast.height"
    # A network upgrade while the ticket was held invalidates it; that is a T4
    # result, not a T1 one, so stop instead of broadcasting.
    if [ -s "$OUT/created.branch" ] && [ "$(branch)" != "$(cat "$OUT/created.branch")" ]; then
        fail "network upgraded while the ticket was held (branch $(cat "$OUT/created.branch") -> $(branch)). Not a valid T1 run; re-issue the ticket."
    fi
    say "5. Broadcasting ticket at height $(cat "$OUT/broadcast.height")"
    # send-without-storing: a rejected no-expiry ticket must never be stored in
    # the wallet, or its note stays pending forever.
    if ! quiet "$ZD" pczt -w campaign send-without-storing "$OUT/t1.signed" 2>&1 | tee "$OUT/broadcast.out"; then
        fail "network REJECTED the ticket (T1 FAIL). Error text is above and in $OUT/broadcast.out"
    fi
    last_txid "$OUT/broadcast.out" > "$OUT/broadcast.txid" || true
    [ -s "$OUT/broadcast.txid" ] || fail "broadcast gave no txid, see above"
fi
BTXID=$(cat "$OUT/broadcast.txid")
[ "$BTXID" = "$TICKET_TXID" ] && say "5. Broadcast txid matches the txid fixed at signing" \
    || say "5. NOTE: broadcast txid $BTXID differs from ticket txid $TICKET_TXID"

say "5. Waiting for the ticket to be mined"
while :; do
    sync bidder
    MINED=$(mined_height bidder "$BTXID")
    [ -n "$MINED" ] && break
    sleep 60
done
GOT=$MINED

echo
say "T1 RESULT"
echo "  ticket signed at height:    $CREATED"
echo "  broadcast at height:        $(cat "$OUT/broadcast.height")"
echo "  mined at height:            $MINED"
echo "  held for:                   $(( $(cat "$OUT/broadcast.height") - CREATED )) blocks"
echo "  txid:                       $BTXID"
echo "  bidder sees the refund:     $([ -n "$GOT" ] && echo yes || echo NO)"
echo "  verdict:                    $([ -n "$GOT" ] && echo PASS || echo 'CHECK (mined but bidder wallet does not show it)')"
