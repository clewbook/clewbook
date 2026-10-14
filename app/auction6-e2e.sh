#!/usr/bin/env bash
# Six bidder uniform price auction on the TEST network (play money only), 3 items, closed by the host the normal way:
#   B1 bids 400000 and withdraws with its own ticket before the deadline
#   B2 500000 and B3 450000 bid above the clearing price and win; their excess comes back
#   B4 and B5 both bid 300000, the clearing price: B4 is paid first and mined in an earlier block, so B4 wins the last item and B5 loses the tie
#   B6 bids 200000, below the clearing price, and loses
# Expected: price = 300000 - fee; B2, B3, B4 settled (price to the treasury, excess back), B5 and B6 refunded with their tickets, B1 withdrawn.
# Every amount that arrives is read from the receiving wallet itself (each bidder refunds to a new wallet of its own).
# Env: BIN (default the review build), PAYER (a funded test wallet, default bidder), D (output folder). From the repository root.
set -uo pipefail
ZD=./target/release/zcash-devtool; BIN=${BIN:-./app/target/review/release}; PAYER=${PAYER:-bidder}
D=${D:-runs/review-auction6-$(date -u +%Y%m%dT%H%M%SZ)}; mkdir -p "$D"
say() { echo; echo "== [$(date -u +%H:%M:%SZ)] $*"; }
note() { echo "   $*"; }
die() { say "STOP: $*"; exit 1; }
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
tip() { "$ZD" wallet -w "$PAYER" get-info 2>/dev/null | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2; }
dbval() { python3 -c "import sqlite3;db=sqlite3.connect('file:$D/$1/data.sqlite?mode=ro',uri=True);print(db.execute('select $2 from accounts').fetchone()[0])"; }
mkwallet() {
  for n in 1 2 3 4 5 6; do
    case $D/$1 in runs/?*/?*) rm -rf -- "$D/$1" "$D/$1.age";; *) die "refusing to remove $D/$1: not under runs/";; esac
    timeout 60 "$ZD" wallet -w "$D/$1" init --name "$1" -i "$D/$1.age" -n test >/dev/null 2>&1 && return 0
    note "wallet $1: init attempt $n stalled, retrying"
  done; die "could not create wallet $1"
}
balance() {
  "$ZD" wallet -w "$D/$1" sync >/dev/null 2>&1
  "$ZD" wallet -w "$D/$1" balance 2>/dev/null | python3 -c '
import re, sys
t = sys.stdin.read(); i = t.find("ironwood_balance"); s = t[i:i + 900]
print(sum(int(v) for k, v in re.findall(r"(\w+): Zatoshis\(\s*(\d+)", s)[:4]))'
}
RUN=$D/campaign
watch1() { timeout 200 $BIN/ll-host watch --run "$RUN" --once > "$D/watch-once.log" 2>&1; }
entries() { ls "$RUN/ledger" 2>/dev/null | wc -l; }
action_of() { python3 -c 'import json,os,sys; d=sys.argv[1]; print([json.load(open(os.path.join(d,f)))["contribution"]["action"] for f in sorted(os.listdir(d)) if (json.load(open(os.path.join(d,f))).get("contribution") or {}).get("txid")==sys.argv[2]][0])' "$RUN/ledger" "$1"; }

say "1. Wallets: campaign, treasury, and one refund wallet per bidder"
for w in host treasury w1 w2 w3 w4 w5 w6; do [ -d "$D/$w" ] || mkwallet $w; done
TREAS=$(addr "$D/treasury"); TUFVK=$(dbval treasury ufvk)
[ -n "$TREAS" ] && [ -n "$TUFVK" ] || die "no treasury address or key"
mkdir -p "$RUN" && cp -a "$D/host" "$RUN/host" && cp "$D/host.age" "$RUN/host.age"
timeout 300 $BIN/ll-host create --run "$RUN" --wallet "$RUN/host" --identity "$RUN/host.age" --mode auction --items 3 \
  --reserve-zat 100000 --min-contribution-zat 20000 --deadline-in ${DEADLINE:-70} --ticket-k ${K:-30} \
  --treasury-address "$TREAS" --treasury-ufvk "$TUFVK" > "$D/create.log" 2>&1 || { cat "$D/create.log"; die "create failed"; }
ID=$(cat "$RUN/rules_id"); PT=$(cat "$RUN/address")
r() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$RUN/rules.json" "$1"; }
DEAD=$(r deadline_height); FEE=$(r refund_fee_zat)
note "campaign $ID: uniform price, 3 items, reserve $(r reserve_zat), fee $FEE, deadline $DEAD, settle by $((DEAD + $(r settle_window)))"

bid() { # tag value
  local tag=$1 amt=$2 i TX=""
  $BIN/ll-contrib keygen --out "$D/$tag.seed" >/dev/null
  local M; M=$($BIN/ll-contrib memo --rules "$RUN/rules.json" --seed "$D/$tag.seed" --refund-address "$(addr "$D/w${tag#B}")")
  for i in $(seq 1 12); do
    "$ZD" wallet -w "$PAYER" sync >/dev/null 2>&1
    TX=$(echo y | timeout 120 "$ZD" wallet -w "$PAYER" send -i "$PAYER.age" --address "$PT" --value "$amt" --memo "$M" --min-confirmations 1 2>&1 | grep -E '^[0-9a-f]{64}$' | head -1)
    [ -n "$TX" ] && break; sleep 20
  done
  [ -n "$TX" ] || die "could not pay bid $tag"
  echo "$TX" > "$D/$tag.paid"; echo "$amt" > "$D/$tag.value"; note "bid $tag: $amt zat in $TX"
}
wait_entries() { for k in $(seq 1 60); do watch1; [ "$(entries)" -ge "$1" ] && return 0; sleep 15; done; return 1; }

say "2. Bids"
# the host's watcher runs after every bid, as a running host would (a bid left waiting for its ticket longer than K fails R4)
n=0
for spec in "B1 400000" "B2 500000" "B3 450000" "B4 300000" "B5 300000" "B6 200000"; do
  set -- $spec; bid $1 $2; n=$((n + 1))
  wait_entries $n || die "the ticket for bid $1 was not issued"
  [ $1 = B4 ] && note "B4 is mined and ticketed; only now B5 pays the same amount, so it is later in chain order"
done
note "ledger: $(entries) entries (amounts are commitments only)"

say "3. B1 withdraws before the deadline with its own ticket"
$BIN/ll-contrib open-ticket --seed "$D/B1.seed" --ledger "$RUN/ledger" --tickets "$RUN/tickets" --contribution "$(cat "$D/B1.paid"):$(action_of "$(cat "$D/B1.paid")")" --out "$D/B1.ticket.hex" 2>&1 | sed 's/^/   /'
$BIN/ll-contrib broadcast --raw "$D/B1.ticket.hex" 2>&1 | sed 's/^/   /'
for k in $(seq 1 40); do watch1; grep -q "lock released: $(cat "$D/B1.paid")" "$D/watch-once.log" && break; sleep 15; done
grep "lock released: $(cat "$D/B1.paid")" "$D/watch-once.log" | sed 's/^/   /' || note "the withdrawal was not seen mined"

say "4. Before the close: the recount can check R1 and R2 only"
$BIN/ll-recount --rules "$RUN/rules.json" --rules-id "$ID" --ledger "$RUN/ledger" 2>&1 | sed 's/^/   /'

say "5. Waiting for the deadline $DEAD"
until [ "$(tip || echo 0)" -gt "$DEAD" ]; do watch1; sleep 20; done
for k in $(seq 1 15); do
  timeout 600 $BIN/ll-host close --run "$RUN" --sweep-to "$TREAS" > "$D/close.log" 2>&1 && break
  grep -q "not reached" "$D/close.log" || break; sleep 20
done
note "close:"; sed 's/^/     /' "$D/close.log" | cut -c1-220

say "6. Following the settlements and refunds until all are mined"
for k in $(seq 1 60); do
  watch1
  python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); sys.exit(0 if o and all(x["status"]=="confirmed" for x in o) else 1)' "$RUN/private/outbox.json" 2>/dev/null && break
  sleep 20
done
python3 -c 'import json,sys
for x in json.load(open(sys.argv[1])): print("   ", x["kind"], x["txid"], x["status"])' "$RUN/private/outbox.json"

say "7. Who won, and the price, from the close entry"
python3 - "$RUN/ledger" "$D" <<'PY'
import json, os, sys
d, base = sys.argv[1], sys.argv[2]
es = [json.load(open(os.path.join(d, f))) for f in sorted(os.listdir(d))]
tag = {}
for t in ["B1", "B2", "B3", "B4", "B5", "B6"]:
    tx = open(f"{base}/{t}.paid").read().strip()
    for e in es:
        c = e.get("contribution") or {}
        if c.get("txid") == tx: tag[c["nf"]] = t
c = [e for e in es if e["kind"] == "close"][0]["close"]
print("    winners:", [tag.get(n, n[:12]) for n in c["winners"]], " clearing price:", c["clearing_price_zat"])
for e in es:
    if e["kind"] == "settle":
        s = e["settle"]; print(f"    settle {tag.get(s['nf'])}: price {s['price_zat']} excess {s['excess_zat']} fee {s['fee_zat']} tx {s['txid']}")
PY

say "8. What each party received, read from its own wallet"
PRICE=$((300000 - FEE))
expect() { case $1 in w1) echo $((400000 - FEE));; w2) echo $((500000 - PRICE - FEE));; w3) echo $((450000 - PRICE - FEE));; w4) echo 0;; w5) echo $((300000 - FEE));; w6) echo $((200000 - FEE));; treasury) echo $((3 * PRICE));; esac; }
ALL=PASS
for w in w1 w2 w3 w4 w5 w6 treasury; do
  got=$(balance $w); want=$(expect $w)
  [ "$got" = "$want" ] && v=PASS || { v=FAIL; ALL=FAIL; }
  note "$v  $w received $got zat (expected $want)"
done
note "amounts: $ALL"

say "9. Recount in a browser from the host's saved copy (it reads the treasury, so R9 to R12 are judged)"
$BIN/ll-host export --run "$RUN" --out "$D/export.json" >/dev/null 2>&1 && PORT=${RECOUNT_PORT:-8811} node app/web/recount-file.cjs "$D/export.json" ${STATIC:-runs/static-polish} 2>&1 | sed 's/^/   /'
say "done ($D)"
