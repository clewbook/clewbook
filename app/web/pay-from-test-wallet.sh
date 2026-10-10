#!/usr/bin/env bash
# Pays a contribution from the testnet wallet `bidder` (play money). Usage: <address> <amount_zat> <message>
set -euo pipefail
echo y | ./target/release/zcash-devtool wallet -w bidder send -i bidder.age --address "$1" --value "$2" --memo "$3" --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$|Error|Insufficient'
