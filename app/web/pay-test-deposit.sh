#!/usr/bin/env bash
# Pays a sealed bid auction deposit from a test network wallet (play money): the address, the amount in TAZ and the message, exactly as the
# bid page shows them. Syncs the wallet first, then sends; prints the transaction ID. Test network only.
# Usage: PAYER_WALLET=<wallet folder> app/web/pay-test-deposit.sh '<address>' <amount in TAZ, e.g. 0.0003> '<message>'
#   PAYER_IDENTITY: the wallet's age file (default: <wallet folder>.age); DEVTOOL: the wallet tool (default: target/release/zcash-devtool,
#   which connects only when it sends, so a slow proof no longer meets a closed connection); SERVER (default testnet.zec.rocks:443).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ $# -eq 3 ] || { sed -n '2,6p' "$0"; exit 2; }
W=${PAYER_WALLET:?set PAYER_WALLET to the test wallet folder}
ID=${PAYER_IDENTITY:-$W.age}
DEVTOOL=${DEVTOOL:-target/release/zcash-devtool}
SERVER=${SERVER:-testnet.zec.rocks:443}
case "$1" in utest1*|zutest1*) ;; *) echo "pay-test-deposit.sh: that is not a test network address (it must start with utest1 or zutest1)" >&2; exit 1;; esac
ZAT=$(python3 -c 'import decimal,sys; d=decimal.Decimal(sys.argv[1]); z=d*100000000; assert z==z.to_integral_value() and z>0, "amount"; print(int(z))' "$2") \
  || { echo "pay-test-deposit.sh: the amount must be in TAZ with at most 8 decimals, as the bid page shows it (e.g. 0.0003)" >&2; exit 1; }
timeout 600 "$DEVTOOL" wallet -w "$W" sync -s "$SERVER" > /dev/null 2>&1 || { echo "pay-test-deposit.sh: the wallet could not sync with $SERVER" >&2; exit 1; }
echo "paying $2 TAZ ($ZAT zatoshis) with a ${#3} character message"
timeout 900 "$DEVTOOL" wallet -w "$W" send -i "$ID" --address "$1" --value "$ZAT" --memo "$3" --min-confirmations 1 -s "$SERVER" 2>&1 \
  | grep -E '^[0-9a-f]{64}$|Error|rror:|Insufficient|trying once more'
