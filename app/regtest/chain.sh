#!/usr/bin/env bash
# A private regtest chain for tests: zebrad 7.0.0-rc.0 on this machine only, no peers, NU7 active from block 1, its JSON-RPC on
# 127.0.0.1:18232 and its light wallet service (plain gRPC) on 127.0.0.1:19067. Nothing here touches a public network or real money.
#
#   ZEBRAD=/path/to/zebrad app/regtest/chain.sh start <dir> [miner address]   start a new chain in <dir> (removes an old one there;
#                                                                            with KEEP=1 it keeps the chain, to change the miner address)
#   app/regtest/chain.sh stop <dir>                                          stop it
#   app/regtest/chain.sh mine <n>                                            mine n blocks
#   app/regtest/chain.sh tip                                                 the current height
#   app/regtest/chain.sh rpc <method> [json params]                          any JSON-RPC call
#   DEVTOOL=/path/to/zcash-devtool app/regtest/chain.sh wallet <dir> <name>   a new throwaway wallet <dir>/<name> (key file <dir>/<name>.age);
#                                                                            prints its default address (the wallet tool built with
#                                                                            `--features regtest_support`). Its birthday is the current
#                                                                            height, at least 2: zebrad refuses a request for block 0
#
# zebrad 7.0.0-rc.0 can be built with `cargo install zebrad --version 7.0.0-rc.0 --locked --root <folder>`. The activation heights here
# must match `activation-heights.toml` (the wallets' copy).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RPC=http://127.0.0.1:18232

rpc() { # $1 method, $2 params (json array)
  curl -s -m 60 -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"
}

case "${1:-}" in
  start)
    dir=${2:?chain folder}
    miner=${3:-tmVxozGcsp8akaM3sF6yFebzfahsC3XBqh3}
    : "${ZEBRAD:?set ZEBRAD to the zebrad 7.0.0-rc.0 binary}"
    if rpc getblockcount >/dev/null 2>&1 && rpc getblockcount | grep -q result; then echo "a node already answers on $RPC: stop it first" >&2; exit 1; fi
    [ "${KEEP:-}" = 1 ] || rm -rf "$dir"
    mkdir -p "$dir"
    cat > "$dir/zebrad.toml" <<CFG
[network]
network = "Regtest"
listen_addr = "127.0.0.1:18344"
initial_testnet_peers = []
cache_dir = "$dir/network"

[network.testnet_parameters.activation_heights]
Overwinter = 1
Sapling = 1
Blossom = 1
Heartwood = 1
Canopy = 1
NU5 = 1
NU6 = 1
"NU6.1" = 1
"NU6.2" = 1
"NU6.3" = 1
NU7 = 1

[state]
cache_dir = "$dir/state"

[rpc]
listen_addr = "127.0.0.1:18232"
lightwalletd_listen_addr = "127.0.0.1:19067"
enable_cookie_auth = false

[mining]
miner_address = "$miner"
CFG
    nohup "$ZEBRAD" -c "$dir/zebrad.toml" start > "$dir/zebrad.log" 2>&1 &
    echo $! > "$dir/zebrad.pid"
    for _ in $(seq 1 120); do
      if rpc getblockcount 2>/dev/null | grep -q result; then echo "started, pid $(cat "$dir/zebrad.pid")"; exit 0; fi
      sleep 1
    done
    echo "zebrad did not answer; see $dir/zebrad.log" >&2
    exit 1
    ;;
  stop)
    dir=${2:?chain folder}
    pid=$(cat "$dir/zebrad.pid")
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || { echo stopped; exit 0; }; sleep 1; done
    echo "zebrad $pid still running" >&2
    exit 1
    ;;
  mine)
    left=${2:-1}
    while [ "$left" -gt 0 ]; do   # in chunks: each block takes about 1.5 s and one call is limited to 60 s
      n=$(( left > 20 ? 20 : left ))
      rpc generate "[$n]" | grep -q result
      left=$(( left - n ))
    done
    rpc getblockcount | sed 's/.*"result":\([0-9]*\).*/\1/'
    ;;
  tip)
    rpc getblockcount | sed 's/.*"result":\([0-9]*\).*/\1/'
    ;;
  rpc)
    rpc "$2" "${3:-[]}"
    echo
    ;;
  wallet)
    dir=${2:?wallet folder}; name=${3:?wallet name}
    : "${DEVTOOL:?set DEVTOOL to the wallet tool}"
    mkdir -p "$dir"
    # zebrad's light wallet service may not answer for up to a minute after the node starts: try again
    for try in 1 2 3 4 5 6 7 8; do
      rm -rf "${dir:?}/$name"
      timeout 30 "$DEVTOOL" wallet -w "$dir/$name" init --name "$name" -i "$dir/$name.age" --birthday "$(rpc getblockcount | sed 's/.*"result":\([0-9]*\).*/\1/')" -n regtest --activation-heights "$HERE/activation-heights.toml" -s 127.0.0.1:19067 >/dev/null 2>&1 && break
      [ "$try" = 8 ] && { echo "the wallet tool could not reach the node" >&2; exit 1; }
      sleep 10
    done
    "$DEVTOOL" wallet -w "$dir/$name" list-addresses 2>/dev/null | sed -n 's/.*Default Address: //p'
    ;;
  *)
    sed -n '2,19p' "$0"
    exit 2
    ;;
esac
