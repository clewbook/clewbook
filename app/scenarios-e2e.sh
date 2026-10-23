#!/usr/bin/env bash
# Scenarios on the TEST network (play money only), one campaign each, with its own new wallets. From the repository root.
#   sweep      a fundraiser reaches its goal and the host sweeps; then the contributor broadcasts their ticket: the network must refuse it,
#              and the recount must still pass (the contribution was kept)
#   conflict   the host spends a ticketed contribution with another transaction (it clears its own wallet lock first, as a dishonest
#              host could): before the deadline the recount must fail R5, after it R6, naming the spending transaction
#   twotickets the host re-issues a ticket, so two tickets exist for one contribution; both are broadcast: one is mined, the other refused,
#              and the recount accepts the mined one as the contribution's ticket
#   odd        payments a stranger could send: no message, below the smallest contribution, a message for another campaign, the same
#              message twice, a hand made message whose refund address type is not Orchard (then challenged), one after the deadline.
#              The recount must stay honest; it shows which, if any, turn a check red
#   badreceiver a hand made message whose refund address bytes are not a valid address: what the host and the recount do
#   selfrefund the host stays silent; after deadline + K the contributor sends their own ticket; the net amount that arrives at the
#              refund address is read from that address's own wallet
#   fuzz       hand made payment messages changing one field at a time; for each: the expected reject, donation or ticket, no skipped
#              pass, no lock left on a rejected note, the close goes ahead, and the recount stays green even after every secret is published
#   earlyok, earlygoal, earlyforged, earlyauction   early close of a fundraiser (SPEC §4): allowed and met; refused while the goal is
#              not met or after a withdrawal undid it; refused without the field, and caught (R2) when a cheating host forces it; never for an auction
#   poisonfix  the fixed host on a campaign that already holds an unpayable payment (POISONED=<run folder>)
#   backdate   a lying host (test-cheats build) writes an earlier issue height for one of two equally late tickets: the recount passes
#              R4 for the backdated one and fails it for the honest late one
# Env: BIN (default app/target/review/release), CHEAT (the test-cheats ll-host), PAYER (default bidder), RUN.
set -uo pipefail
S=${1:?usage: scenarios-e2e.sh sweep|conflict|twotickets|odd|badreceiver|selfrefund|backdate|fuzz|poisonfix|earlyok|earlygoal|earlyforged|earlyauction|earlybackdate}
ZD=./target/release/zcash-devtool
BIN=${BIN:-./app/target/review/release}
CHEAT=${CHEAT:-./app/target/review-cheat/release/ll-host}
CRAFT=${CRAFT:-./app/target/review/release/examples/craft_memo}
PAYER=${PAYER:-bidder}
RUN=${RUN:-runs/scenarios-$S-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$RUN"
say() { echo; echo "== [$(date -u +%H:%M:%SZ)] $*"; }
note() { echo "   $*"; }
die() { say "STOP: $*"; exit 1; }
addr() { "$ZD" wallet -w "$1" list-addresses 2>/dev/null | grep -o 'Default Address: [^ ]*' | head -1 | cut -d' ' -f3; }
tip() { "$ZD" wallet -w "$PAYER" get-info 2>/dev/null | grep -o '"chain_tip_height":[0-9]*' | cut -d: -f2; }
wait_height() { until [ "$(tip || echo 0)" -ge "$1" ]; do sleep 15; done; note "chain at $(tip)"; }
rules() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]))' "$RUN/rules.json" "$1"; }
mkwallet() { # folder: a new empty test network wallet, retried because the server connection sometimes stalls
  for n in 1 2 3 4 5 6; do
    case $1 in runs/?*) rm -rf -- "$1" "$1.age";; *) die "refusing to remove $1: not under runs/";; esac
    timeout 60 "$ZD" wallet -w "$1" init --name "$(basename "$1")" -i "$1.age" -n test >/dev/null 2>&1 && return 0
    note "wallet $(basename "$1"): init attempt $n stalled, retrying"
  done
  die "could not create wallet $1"
}
pay() { # value [memo]: pays the campaign address from the payer; prints the txid
  local txid="" m=()
  [ -n "${2:-}" ] && m=(--memo "$2")
  for _ in $(seq 1 20); do
    "$ZD" wallet -w "$PAYER" sync >/dev/null 2>&1 || true
    txid=$(echo y | "$ZD" wallet -w "$PAYER" send -i "$PAYER.age" --address "$(cat "$RUN/address")" --value "$1" "${m[@]}" --min-confirmations 1 2>&1 | grep -oE '^[0-9a-f]{64}$' || true)
    [ -n "$txid" ] && { echo "$txid"; return 0; }
    sleep 20
  done
  return 1
}
memo() { # tag [refund wallet]: a fresh payment code from cb-contrib, refunds to that wallet (default: a new wallet r-<tag>)
  local w=${2:-$RUN/r-$1}
  [ -d "$w" ] || mkwallet "$w"
  $BIN/ll-contrib keygen --out "$RUN/$1.seed" >/dev/null
  $BIN/ll-contrib memo --rules "$RUN/rules.json" --seed "$RUN/$1.seed" --refund-address "$(addr "$w")"
}
create() { # extra create arguments
  mkwallet "$RUN/wallet"
  W=$RUN/wallet
  timeout 300 $BIN/ll-host create --run "$RUN" --wallet "$W" --identity "$W.age" "$@" > "$RUN/create.log" 2>&1 || { cat "$RUN/create.log"; die "create failed"; }
  note "campaign $(cat "$RUN/rules_id"), start $(rules start_height), deadline $(rules deadline_height), K $(rules ticket_k)"
}
watch() { ${HOST:-$BIN/ll-host} watch --run "$RUN" --once 2>&1; }
entries() { ls "$RUN/ledger" 2>/dev/null | wc -l; }
wait_entries() { for _ in $(seq 1 60); do [ "$(entries)" -ge "$1" ] && return 0; watch | grep -E "ticket issued|rejected|skipped|BACKDATED" | sed 's/^/   /'; sleep 15; done; return 1; }
contribution() { python3 - "$RUN/ledger" "$1" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    c = json.load(open(os.path.join(sys.argv[1], f))).get("contribution")
    if c and c["txid"] == sys.argv[2]:
        print(f'{c["txid"]}:{c["action"]}'); break
PY
}
open_ticket() { # tag out
  $BIN/ll-contrib open-ticket --seed "$RUN/$1.seed" --ledger "$RUN/ledger" --tickets "$RUN/tickets" --contribution "$(contribution "$(cat "$RUN/$1.txid")")" --out "$2" 2>&1 | sed 's/^/   /'
}
broadcast() { $BIN/ll-contrib broadcast --raw "$1" 2>&1 | sed 's/^/   /'; }
recount() { $BIN/ll-recount --rules "$RUN/rules.json" --rules-id "$(cat "$RUN/rules_id")" --ledger "$RUN/ledger" --wallet "$W" "$@" 2>&1 | sed 's/^/   /'; }
sync_w() { "$ZD" wallet -w "$1" sync >/dev/null 2>&1; "$ZD" wallet -w "$1" enhance >/dev/null 2>&1; }
balance() { # wallet: total Ironwood value it holds (spendable + waiting), in zatoshis
  sync_w "$1"
  "$ZD" wallet -w "$1" balance 2>/dev/null | python3 -c '
import re, sys
t = sys.stdin.read(); i = t.find("ironwood_balance"); s = t[i:i + 900]
print(sum(int(v) for k, v in re.findall(r"(\w+): Zatoshis\(\s*(\d+)", s)[:4]))'
}
notes() { python3 spikes/notes_db.py "$W" | sed -E 's/nf=[0-9a-f]{56}/nf=…/' | sed 's/^/   /'; }
unlock() { # txid: clears the wallet lock on that payment's note in the campaign wallet, as a dishonest host could
  python3 - "$W/data.sqlite" "$1" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
raw = bytes.fromhex(sys.argv[2])[::-1]
n = c.execute("update ironwood_received_notes set lock_owner = null, lock_expiry_height = null where transaction_id = (select id_tx from transactions where txid = ?)", (raw,)).rowcount
c.commit(); print(f"   lock cleared on {n} note(s) of {sys.argv[2][:12]}")
PY
}
host_spend() { # value: an ordinary payment out of the campaign wallet, which can only use notes that are not locked
  local out
  out=$(echo y | "$ZD" wallet -w "$W" send -i "$W.age" --address "$(addr outsider)" --value "$1" --min-confirmations 1 2>&1)
  echo "$out" | grep -oE '^[0-9a-f]{64}$' || { echo "$out" | tail -3 | sed 's/^/   /' >&2; return 1; }
}
close_host() {
  for _ in $(seq 1 15); do
    out=$($BIN/ll-host close --run "$RUN" --sweep-to "$(addr outsider)" 2>&1) && { echo "$out" | sed 's/^/   /'; return 0; }
    echo "$out" | grep -q "not reached" || { echo "$out" | sed 's/^/   /'; return 1; }
    sleep 20
  done; return 1
}
mined() { # txid: waits until the campaign wallet sees that transaction mined
  for _ in $(seq 1 60); do
    sync_w "$W"
    python3 - "$W/data.sqlite" "$1" <<'PY' && return 0
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
r = c.execute("select mined_height from transactions where txid = ?", (bytes.fromhex(sys.argv[2])[::-1],)).fetchone()
sys.exit(0 if r and r[0] else 1)
PY
    sleep 15
  done; return 1
}

case $S in
sweep)
  say "1. Fundraiser, goal 500000 zat, one contribution of 600000"
  create --goal-zat 500000 --deadline-in 25 --ticket-k 10
  M=$(memo c1); pay 600000 "$M" > "$RUN/c1.txid" || die "payment failed"; note "c1 paid: $(cat "$RUN/c1.txid")"
  wait_entries 1 || die "no ticket"
  say "2. The contributor saves their ticket now"; open_ticket c1 "$RUN/c1.ticket.hex"
  say "3. Deadline, then the host closes (goal met: it sweeps)"; wait_height $(( $(rules deadline_height) + 1 )); close_host
  SWEEP=$(python3 -c 'import json,sys; print([x["txid"] for x in json.load(open(sys.argv[1])) if x["kind"]=="sweep"][0])' "$RUN/private/outbox.json")
  note "sweep transaction: $SWEEP"; mined "$SWEEP" && note "sweep mined"
  say "4. The contributor broadcasts the saved ticket after the sweep: the network must refuse it"; broadcast "$RUN/c1.ticket.hex"
  say "5. Recount"; watch >/dev/null; notes; recount
  ;;
conflict)
  say "1. Fundraiser, goal 5000000 zat (it will be missed), two contributions of 300000"
  create --goal-zat 5000000 --deadline-in 45 --ticket-k 10
  M1=$(memo c1); pay 300000 "$M1" > "$RUN/c1.txid" || die "payment 1 failed"; note "c1 paid: $(cat "$RUN/c1.txid")"
  M2=$(memo c2); pay 300000 "$M2" > "$RUN/c2.txid" || die "payment 2 failed"; note "c2 paid: $(cat "$RUN/c2.txid")"
  wait_entries 2 || die "no tickets"; notes
  say "2. Before the deadline the host clears its own lock on c1 and spends it with an ordinary payment"
  unlock "$(cat "$RUN/c1.txid")"
  X1=$(host_spend 250000) || die "the host's spend of c1 failed"; note "host spend of c1: $X1"; mined "$X1" && note "mined"
  say "3. Recount before the deadline (tip $(tip), deadline $(rules deadline_height)): R5 must fail and name $X1"; recount
  say "4. The contributor of c1 tries their ticket now: it must be refused"; open_ticket c1 "$RUN/c1.ticket.hex"; broadcast "$RUN/c1.ticket.hex"
  say "5. After the deadline the host spends c2 as well instead of refunding it (the goal was missed)"
  wait_height $(( $(rules deadline_height) + 1 ))
  unlock "$(cat "$RUN/c2.txid")"
  X2=$(host_spend 250000) || die "the host's spend of c2 failed"; note "host spend of c2: $X2"; mined "$X2" && note "mined"
  say "6. Recount after the deadline: R5 fails for c1 and R6 for c2, naming $X1 and $X2"; notes; recount
  ;;
twotickets)
  say "1. Fundraiser, one contribution of 300000"
  create --goal-zat 5000000 --deadline-in 40 --ticket-k 10
  M=$(memo c1); pay 300000 "$M" > "$RUN/c1.txid" || die "payment failed"; note "c1 paid: $(cat "$RUN/c1.txid")"
  wait_entries 1 || die "no ticket"
  say "2. The contributor saves the first ticket"; open_ticket c1 "$RUN/c1.ticket1.hex"
  say "3. The host re-issues: a second ticket for the same contribution"; $BIN/ll-host reissue --run "$RUN" 2>&1 | sed 's/^/   /'
  open_ticket c1 "$RUN/c1.ticket2.hex"
  python3 - "$RUN/ledger" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    e = json.load(open(os.path.join(sys.argv[1], f)))
    print(f"   entry {e['seq']}: {e['kind']:8} nullifier {e['contribution']['nf'][:16]}… ticket {e['ticket']['txid']}")
PY
  say "4. Both tickets are broadcast, one right after the other"
  broadcast "$RUN/c1.ticket2.hex"; broadcast "$RUN/c1.ticket1.hex"
  T1=$(python3 -c 'import json,sys,os; d=sys.argv[1]; print([json.load(open(os.path.join(d,f)))["ticket"]["txid"] for f in sorted(os.listdir(d))][0])' "$RUN/ledger")
  T2=$(python3 -c 'import json,sys,os; d=sys.argv[1]; print([json.load(open(os.path.join(d,f)))["ticket"]["txid"] for f in sorted(os.listdir(d))][1])' "$RUN/ledger")
  for _ in $(seq 1 40); do sync_w "$W"; notes | grep -q "spent_by=[0-9a-f]" && break; sleep 15; done
  say "5. Which one was mined (the note's spender), and a later broadcast of the other"; notes
  note "ticket 1: $T1"; note "ticket 2: $T2"
  broadcast "$RUN/c1.ticket1.hex"
  say "6. Recount (before the deadline: the contribution counts as withdrawn by its own ticket)"; watch >/dev/null; recount
  ;;
odd)
  say "1. Fundraiser, goal 5000000 zat (missed), smallest contribution 20000"
  create --goal-zat 5000000 --deadline-in 45 --ticket-k 10
  OTHER=${OTHER_RULES:-$(ls -d runs/review-sweep-*/rules.json runs/scenarios-sweep-*/rules.json 2>/dev/null | tail -1)}
  [ -f "$OTHER" ] || die "needs the rules of another campaign (OTHER_RULES=…/rules.json)"
  M1=$(memo c1); pay 300000 "$M1" > "$RUN/c1.txid" || die "pay"; note "valid contribution c1: $(cat "$RUN/c1.txid")"
  M2=$(memo c2); pay 15000 "$M2" > "$RUN/below.txid" || die "pay"; note "below the minimum (15000 zat, valid message): $(cat "$RUN/below.txid")"
  pay 30000 > "$RUN/nomemo.txid" || die "pay"; note "no message: $(cat "$RUN/nomemo.txid")"
  mkwallet "$RUN/r-x"; $BIN/ll-contrib keygen --out "$RUN/x.seed" >/dev/null
  MX=$($BIN/ll-contrib memo --rules "$OTHER" --seed "$RUN/x.seed" --refund-address "$(addr "$RUN/r-x")")
  pay 30000 "$MX" > "$RUN/other.txid" || die "pay"; note "a message for another campaign: $(cat "$RUN/other.txid")"
  M3=$(memo c3); pay 50000 "$M3" > "$RUN/c3.txid" || die "pay"; note "c3, first payment with its message: $(cat "$RUN/c3.txid")"
  pay 50000 "$M3" > "$RUN/copy.txid" || die "pay"; note "the same message paid again: $(cat "$RUN/copy.txid")"
  $BIN/ll-contrib keygen --out "$RUN/t2.seed" >/dev/null
  MT=$($CRAFT "$RUN/rules.json" "$RUN/t2.seed" 2 "$(python3 -c 'print("11"*43)')" 30000) || die "craft"
  pay 30000 "$MT" > "$RUN/type2.txid" || die "pay"; note "a hand made message whose refund address type is 2 (not Orchard): $(cat "$RUN/type2.txid")"
  wait_entries 5 || note "fewer entries than expected"
  say "2. What the host wrote"
  python3 - "$RUN/ledger" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    e = json.load(open(os.path.join(sys.argv[1], f)))
    c = e.get("contribution") or {}
    print(f"   entry {e['seq']}: {e['kind']:7} {c.get('txid','')[:12]} {c.get('value_zat')}  {e.get('reason') or ''}")
PY
  say "3. A payment after the deadline (valid message)"
  wait_height $(( $(rules deadline_height) + 1 ))
  M4=$(memo c4); pay 30000 "$M4" > "$RUN/late.txid" || die "pay"; note "late: $(cat "$RUN/late.txid")"
  mined "$(cat "$RUN/late.txid")" && note "mined at $(tip)"
  say "4. The host closes (goal missed: it refunds the contributions)"; close_host
  for _ in $(seq 1 30); do watch | grep -q "lock released" && break; sleep 15; done
  say "5. Recount with no challenges"; recount
  say "6. The hand made payment's owner publishes their one time secret (a challenge); recount again"
  mkdir -p "$RUN/challenges"
  $BIN/ll-contrib challenge --seed "$RUN/t2.seed" --contribution "$(cat "$RUN/type2.txid"):$(python3 -c 'import json,os,sys; d=sys.argv[1]; print([json.load(open(os.path.join(d,f)))["contribution"]["action"] for f in sorted(os.listdir(d)) if (json.load(open(os.path.join(d,f))).get("contribution") or {}).get("txid")==sys.argv[2]][0])' "$RUN/ledger" "$(cat "$RUN/type2.txid")")" --out "$RUN/challenges/t2.json" 2>&1 | sed 's/^/   /'
  recount --challenges "$RUN/challenges"
  note "late payments the host can list: "; $BIN/ll-host late --run "$RUN" 2>&1 | sed 's/^/   /'
  ;;
badreceiver)
  say "1. Fundraiser; one payment whose hand made message names refund address bytes that are not a valid address"
  create --goal-zat 5000000 --deadline-in 30 --ticket-k 10
  $BIN/ll-contrib keygen --out "$RUN/b.seed" >/dev/null
  MB=$($CRAFT "$RUN/rules.json" "$RUN/b.seed" 3 "$(python3 -c 'print("ff"*43)')" 30000) || die "craft"
  pay 30000 "$MB" > "$RUN/b.txid" || die "pay"; note "paid: $(cat "$RUN/b.txid")"
  mined "$(cat "$RUN/b.txid")"; PH=$(python3 -c "import sqlite3,sys;c=sqlite3.connect('file:$W/data.sqlite?mode=ro',uri=True);print(c.execute('select mined_height from transactions where txid=?',(bytes.fromhex('$(cat "$RUN/b.txid")')[::-1],)).fetchone()[0])")
  note "mined at $PH; ticket due by $((PH + $(rules ticket_k)))"
  say "2. Host watch passes until the ticket window has passed"
  until [ "$(tip)" -gt $((PH + $(rules ticket_k) + 1)) ]; do watch | grep -E "issued|rejected|skipped" | sed 's/^/   /'; sleep 20; done
  note "ledger entries: $(entries)"; notes
  say "3. Recount after the window"; recount
  say "4. After the deadline the host tries to close"; wait_height $(( $(rules deadline_height) + 1 )); close_host || note "close refused (exit $?)"
  ;;
selfrefund)
  say "1. Fundraiser (missed), one contribution of 300000, refunds to a new wallet of its own"
  create --goal-zat 5000000 --deadline-in 25 --ticket-k 10
  M=$(memo c1); pay 300000 "$M" > "$RUN/c1.txid" || die "payment failed"; note "c1 paid: $(cat "$RUN/c1.txid")"
  wait_entries 1 || die "no ticket"
  B0=$(balance "$RUN/r-c1"); note "refund wallet holds $B0 zat before"
  say "2. The host stays silent from now on; the contributor waits for deadline + K, then sends the ticket"
  wait_height $(( $(rules deadline_height) + $(rules ticket_k) + 1 ))
  open_ticket c1 "$RUN/c1.ticket.hex"; broadcast "$RUN/c1.ticket.hex"
  T=$(python3 -c 'import json,sys,os; d=sys.argv[1]; print([json.load(open(os.path.join(d,f)))["ticket"]["txid"] for f in sorted(os.listdir(d))][-1])' "$RUN/ledger")
  mined "$T" && note "ticket $T mined"
  for _ in $(seq 1 20); do B1=$(balance "$RUN/r-c1"); [ "$B1" -gt "$B0" ] && break; sleep 15; done
  FEE=$(rules refund_fee_zat)
  say "3. What arrived at the refund address"
  note "refund wallet holds $B1 zat after; arrived $((B1 - B0)) zat; expected 300000 - fee $FEE = $((300000 - FEE)) zat: $([ $((B1 - B0)) -eq $((300000 - FEE)) ] && echo PASS || echo FAIL)"
  say "4. Recount"; recount
  ;;
backdate)
  [ -x "$CHEAT" ] || die "needs the test-cheats build at $CHEAT"
  say "1. Fundraiser, K 10; two payments while the host is not running"
  create --goal-zat 5000000 --deadline-in 60 --ticket-k 10
  M1=$(memo c1); pay 300000 "$M1" > "$RUN/c1.txid" || die "pay"; note "c1: $(cat "$RUN/c1.txid")"
  M2=$(memo c2); pay 300000 "$M2" > "$RUN/c2.txid" || die "pay"; note "c2: $(cat "$RUN/c2.txid")"
  mined "$(cat "$RUN/c1.txid")"; mined "$(cat "$RUN/c2.txid")"
  H=$(python3 -c "import sqlite3;c=sqlite3.connect('file:$W/data.sqlite?mode=ro',uri=True);print(max(c.execute('select mined_height from transactions where txid in (?,?)',(bytes.fromhex('$(cat "$RUN/c1.txid")')[::-1],bytes.fromhex('$(cat "$RUN/c2.txid")')[::-1])).fetchall())[0])")
  note "both mined by $H; tickets due by $((H + 10))"
  say "2. The host stays away for more than K blocks"; wait_height $((H + 14))
  say "3. The host comes back: c1's ticket gets a BACKDATED issue height (lying host), c2's gets the true, late one"
  HOST=$CHEAT LL_TEST_BACKDATE_ISSUE="$(cat "$RUN/c1.txid")" watch | grep -E "issued|BACKDATED|tip" | sed 's/^/   /'
  python3 - "$RUN/ledger" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    e = json.load(open(os.path.join(sys.argv[1], f)))
    print(f"   entry {e['seq']}: payment {e['contribution']['txid'][:12]} at {e['contribution']['height']}, issue height written: {e['ticket']['issue_height']}")
PY
  say "4. Recount: R4 fails only for c2, the honest late one; the backdated c1 passes"; recount
  ;;
fuzz)
  say "1. Fundraiser (goal missed), K 30; hand made payment messages, one field changed at a time"
  create --goal-zat 50000000 --deadline-in ${DEADLINE_IN:-110} --ticket-k 30
  mkwallet "$RUN/r-valid"
  VALID=$($BIN/ll-contrib address-info "$(addr "$RUN/r-valid")" | sed -n 's/^orchard\/ironwood: //p')
  FF=$(python3 -c 'print("ff"*43)'); ZERO=$(python3 -c 'print("00"*43)')
  # name | value paid | environment for the tool | typecode | receiver | sealed amount (- for none) | expected: issue, reject:<code or text>, none
  CASES="normal|30000||3|$VALID|30000|issue
exact_minimum|20000||3|$VALID|20000|issue
sealed_amount_zero|30000||3|$VALID|0|issue
old_format_no_amount|30000||3|$VALID|-|issue
encryption_key_zero|30000|CRAFT_ENC=$(python3 -c 'print("00"*32)')|3|$VALID|30000|issue
other_campaign|30000|CRAFT_RULES_ID=$(python3 -c 'print("ab"*32)')|3|$VALID|30000|reject:other_campaign
underpaid|30000||3|$VALID|40000|reject:underpaid
receiver_bytes_ff|30000||3|$FF|30000|reject:receiver_bytes
receiver_bytes_zero|30000||3|$ZERO|30000|reject:receiver_bytes
receiver_type_2|30000||2|$VALID|30000|reject:receiver_type
receiver_type_0|30000||0|$VALID|30000|reject:receiver_type
receiver_type_255|30000||255|$VALID|30000|reject:receiver_type
version_7|30000|CRAFT_VERSION=7|3|$VALID|30000|reject:unsupported payload version
version_1_with_amount|30000|CRAFT_VERSION=1|3|$VALID|30000|reject:unsupported payload version
garbage_right_length|30000|CRAFT_GARBAGE=1|3|$VALID|30000|reject:unsupported payload version
truncated|30000|CRAFT_DROP=5|3|$VALID|30000|none
below_minimum|15000||3|$VALID|15000|none
at_the_fee|10000||3|$VALID|10000|none
no_message|30000||||-|none"
  echo "$CASES" > "$RUN/cases.txt"
  while IFS='|' read -r name value envs tc recv amt want; do
    if [ "$name" = no_message ]; then pay "$value" > "$RUN/$name.txid" || die "pay $name"; else
      $BIN/ll-contrib keygen --out "$RUN/$name.seed" >/dev/null
      A=(); [ "$amt" != - ] && A=("$amt")
      M=$(env $envs "$CRAFT" "$RUN/rules.json" "$RUN/$name.seed" "$tc" "$recv" "${A[@]}") || die "craft $name"
      pay "$value" "$M" > "$RUN/$name.txid" || die "pay $name"
    fi
    note "$name: $value zat in $(cat "$RUN/$name.txid")"
  done < "$RUN/cases.txt"
  say "2. Host watch passes until every payment is answered (any 'skipped' line would be a problem)"
  : > "$RUN/watch-all.log"
  for _ in $(seq 1 40); do watch >> "$RUN/watch-all.log"; [ "$(entries)" -ge 15 ] && break; sleep 20; done
  for _ in 1 2; do sleep 20; watch >> "$RUN/watch-all.log"; done
  note "skipped lines in all watch passes: $(grep -c '^skipped' "$RUN/watch-all.log")"
  say "3. Each case: what the host did, and whether the note is locked"
  python3 - "$RUN" <<'PY'
import json, os, sqlite3, sys
run = sys.argv[1]
es = [json.load(open(os.path.join(run, "ledger", f))) for f in sorted(os.listdir(os.path.join(run, "ledger")))]
db = sqlite3.connect(f"file:{run}/wallet/data.sqlite?mode=ro", uri=True)
ok = True
for line in open(f"{run}/cases.txt"):
    name, value, envs, tc, recv, amt, want = line.rstrip("\n").split("|")
    tx = open(f"{run}/{name}.txid").read().strip()
    e = [x for x in es if (x.get("contribution") or {}).get("txid") == tx]
    got = "none" if not e else ("issue" if e[0]["kind"] == "issue" else "reject:" + (e[0].get("reason") or ""))
    lock = db.execute("select n.lock_owner is not null from ironwood_received_notes n join transactions t on t.id_tx = n.transaction_id where t.txid = ? and n.is_change = 0", (bytes.fromhex(tx)[::-1],)).fetchone()
    locked = bool(lock and lock[0])
    good = (got == want if not want.startswith("reject:") else got.startswith("reject:") and want[7:] in got) and (locked == (want == "issue"))
    ok &= good
    print(f"   {'PASS' if good else 'FAIL'}  {name:24} expected {want:40} got {got[:90]:90} locked={locked}")
print("   ALL CASES AS EXPECTED" if ok else "   SOME CASES DIFFER")
PY
  say "4. Deadline; the host closes (goal missed: it refunds the contributions)"
  wait_height $(( $(rules deadline_height) + 1 )); close_host || note "CLOSE FAILED"
  for _ in $(seq 1 30); do watch | grep -q "lock released" && break; sleep 15; done
  for _ in 1 2 3; do sleep 20; watch > /dev/null; done
  say "5. Recount with no challenges"; recount
  say "6. Every hand made payment that was rejected publishes its one time secret; recount again"
  mkdir -p "$RUN/challenges"
  python3 - "$RUN" <<'PY' > "$RUN/rejected.txt"
import json, os, sys
run = sys.argv[1]
for f in sorted(os.listdir(os.path.join(run, "ledger"))):
    e = json.load(open(os.path.join(run, "ledger", f)))
    if e["kind"] == "reject": print(e["contribution"]["txid"], e["contribution"]["action"])
PY
  while read -r tx act; do
    name=$(grep -l "$tx" "$RUN"/*.txid | head -1 | xargs basename | sed 's/\.txid$//')
    $BIN/ll-contrib challenge --seed "$RUN/$name.seed" --contribution "$tx:$act" --out "$RUN/challenges/$name.json" > /dev/null 2>&1 && note "challenge published for $name"
  done < "$RUN/rejected.txt"
  recount --challenges "$RUN/challenges"
  ;;
poisonfix)
  # the fixed host on a campaign that already holds an unpayable payment (made by the scenario badreceiver with the old host)
  RUN=${POISONED:?POISONED=<run folder of a badreceiver campaign>}; W=$RUN/wallet
  say "1. Before: entries $(entries), and the payment's lock"; notes
  say "2. The fixed host's watch pass"; watch | grep -E "rejected|skipped|issued|released" | sed 's/^/   /'
  python3 - "$RUN/ledger" <<'PY'
import json, os, sys
for f in sorted(os.listdir(sys.argv[1])):
    e = json.load(open(os.path.join(sys.argv[1], f)))
    print(f"   entry {e['seq']}: {e['kind']} {(e.get('contribution') or {}).get('txid','')[:12]} {e.get('reason') or ''}")
PY
  notes
  say "3. Recount"; recount
  say "4. The close now goes ahead"; close_host || note "CLOSE FAILED"
  say "5. Recount after the close"; watch > /dev/null; recount
  ;;
earlyok)
  say "1. Fundraiser that allows closing early, goal 500000; one contribution of 600000"
  create --goal-zat 500000 --deadline-in ${DEADLINE_IN:-200} --ticket-k 10 --early-close
  note "rules: early_close = $(rules early_close)"
  M=$(memo c1); pay 600000 "$M" > "$RUN/c1.txid" || die "pay"; note "c1 paid: $(cat "$RUN/c1.txid")"
  wait_entries 1 || die "no ticket"
  say "2. The goal is met; the host closes EARLY (tip $(tip), deadline $(rules deadline_height))"
  $BIN/ll-host close --run "$RUN" --sweep-to "$(addr outsider)" 2>&1 | sed 's/^/   /'
  CH=$(python3 -c 'import json,os,sys; d=sys.argv[1]; print([json.load(open(os.path.join(d,f)))["close"]["close_height"] for f in sorted(os.listdir(d)) if json.load(open(os.path.join(d,f)))["kind"]=="close"][0])' "$RUN/ledger")
  note "close entry at block $CH, $(( $(rules deadline_height) - CH )) blocks before the deadline"
  SWEEP=$(python3 -c 'import json,sys; print([x["txid"] for x in json.load(open(sys.argv[1])) if x["kind"]=="sweep"][0])' "$RUN/private/outbox.json")
  mined "$SWEEP" && note "sweep $SWEEP mined"
  say "3. A payment after the early close (valid message): not counted, shown as late"
  M2=$(memo c2); pay 300000 "$M2" > "$RUN/c2.txid" || die "pay"; mined "$(cat "$RUN/c2.txid")" && note "c2 paid after the close: $(cat "$RUN/c2.txid")"
  for _ in 1 2 3; do watch | grep -E "issued|rejected|released" | sed 's/^/   /'; sleep 15; done
  note "ledger entries: $(entries) (no entry for the payment after the close)"
  $BIN/ll-host late --run "$RUN" 2>&1 | sed 's/^/   /'
  say "4. Recount: all checks pass, 1 contribution, kept"; recount
  ;;
earlygoal)
  say "1. Fundraiser that allows closing early, goal 500000"
  create --goal-zat 500000 --deadline-in ${DEADLINE_IN:-200} --ticket-k 10 --early-close
  M1=$(memo c1); pay 300000 "$M1" > "$RUN/c1.txid" || die "pay"; note "c1: 300000 in $(cat "$RUN/c1.txid")"
  wait_entries 1 || die "no ticket"
  say "2. (ii) The goal is not met (300000 of 500000): an early close must be refused"
  $BIN/ll-host close --run "$RUN" --sweep-to "$(addr outsider)" 2>&1 | sed 's/^/   /'; note "close entries: $(python3 -c 'import json,os,sys; d=sys.argv[1]; print(sum(json.load(open(os.path.join(d,f)))["kind"]=="close" for f in os.listdir(d)))' "$RUN/ledger")"
  M2=$(memo c2); pay 300000 "$M2" > "$RUN/c2.txid" || die "pay"; note "c2: 300000 in $(cat "$RUN/c2.txid"); the goal is now met (600000)"
  wait_entries 2 || die "no ticket"
  say "3. (vi) c2 takes the contribution back with its ticket before any close"
  open_ticket c2 "$RUN/c2.ticket.hex"; broadcast "$RUN/c2.ticket.hex"
  T2=$(python3 -c 'import json,os,sys; d=sys.argv[1]; print([json.load(open(os.path.join(d,f)))["ticket"]["txid"] for f in sorted(os.listdir(d))][-1])' "$RUN/ledger")
  mined "$T2" && note "withdrawal $T2 mined"
  for _ in 1 2; do watch > /dev/null; sleep 10; done
  say "4. The goal is no longer met (300000 of 500000 after the withdrawal): an early close must be refused"
  $BIN/ll-host close --run "$RUN" --sweep-to "$(addr outsider)" 2>&1 | sed 's/^/   /'; note "close entries: $(python3 -c 'import json,os,sys; d=sys.argv[1]; print(sum(json.load(open(os.path.join(d,f)))["kind"]=="close" for f in os.listdir(d)))' "$RUN/ledger")"
  say "5. Recount (open, before the deadline): all pass"; recount
  ;;
earlyforged)
  [ -x "$CHEAT" ] || die "needs the test-cheats build at $CHEAT"
  say "1. Fundraiser WITHOUT early close in its rules, goal 500000; one contribution of 600000 (goal met)"
  create --goal-zat 500000 --deadline-in ${DEADLINE_IN:-200} --ticket-k 10
  note "rules: early_close = $(rules early_close)"
  M=$(memo c1); pay 600000 "$M" > "$RUN/c1.txid" || die "pay"; note "c1 paid: $(cat "$RUN/c1.txid")"
  wait_entries 1 || die "no ticket"
  say "2. (iii) The honest host tries to close early: refused"
  $BIN/ll-host close --run "$RUN" --sweep-to "$(addr outsider)" 2>&1 | sed 's/^/   /'
  say "3. (v) A cheating host (test-cheats build) writes an early close anyway and sweeps"
  LL_TEST_FORCE_EARLY_CLOSE=1 $CHEAT close --run "$RUN" --sweep-to "$(addr outsider)" 2>&1 | grep -v "^#\|^$" | sed 's/^/   /'
  SWEEP=$(python3 -c 'import json,sys; print([x["txid"] for x in json.load(open(sys.argv[1])) if x["kind"]=="sweep"][0])' "$RUN/private/outbox.json")
  mined "$SWEEP" && note "sweep $SWEEP mined"
  say "4. Recount: R2 must fail"; recount
  ;;
earlyauction)
  say "1. (iv) An auction: closing before the deadline is refused (and its rules cannot allow it)"
  create --mode auction --items 1 --deadline-in ${DEADLINE_IN:-200} --ticket-k 10
  $BIN/ll-host close --run "$RUN" --sweep-to "$(addr outsider)" 2>&1 | sed 's/^/   /'
  note "close entries: $(ls "$RUN/ledger" 2>/dev/null | wc -l) ledger entries in all"
  say "2. Creating an auction that allows an early close is refused"
  mkdir -p "$RUN/second"; RUN2=$RUN; RUN=$RUN2/second; mkwallet "$RUN/wallet"
  $BIN/ll-host create --run "$RUN" --wallet "$RUN/wallet" --identity "$RUN/wallet.age" --mode auction --items 1 --deadline-in 200 --early-close 2>&1 | tail -1 | sed 's/^/   /'
  RUN=$RUN2
  ;;
earlybackdate)
  # Can a host backdate an early close to leave out a later payer? BACKDATE_TO=withheld (default): the close height is set just
  # before p2, whose ticket the host never issued; BACKDATE_TO=ticketed: just before p1, whose ticket the host had already issued.
  [ -x "$CHEAT" ] || die "needs the test-cheats build at $CHEAT"
  say "1. Fundraiser that allows closing early, goal 500000, K 10; c1 pays 600000 and the host tickets it"
  create --goal-zat 500000 --deadline-in ${DEADLINE_IN:-200} --ticket-k 10 --early-close
  M=$(memo c1); pay 600000 "$M" > "$RUN/c1.txid" || die "pay"; wait_entries 1 || die "no ticket"
  say "2. p1 pays 300000; the host is still watching and tickets it"
  M=$(memo p1); pay 300000 "$M" > "$RUN/p1.txid" || die "pay"; wait_entries 2 || die "no ticket"
  say "3. The host stops watching; p2 pays 300000 and gets no ticket"
  M=$(memo p2); pay 300000 "$M" > "$RUN/p2.txid" || die "pay"; mined "$(cat "$RUN/p2.txid")" || die "not mined"
  H=$(python3 - "$W/data.sqlite" "$RUN" <<'PY'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
for t in ["c1", "p1", "p2"]:
    tx = open(f"{sys.argv[2]}/{t}.txid").read().strip()
    print(t, c.execute("select mined_height from transactions where txid = ?", (bytes.fromhex(tx)[::-1],)).fetchone()[0])
PY
)
  echo "$H" | sed 's/^/   mined at: /'
  HP1=$(echo "$H" | awk '$1=="p1"{print $2}'); HP2=$(echo "$H" | awk '$1=="p2"{print $2}')
  if [ "${BACKDATE_TO:-withheld}" = ticketed ]; then CH=$((HP1 - 1)); else CH=$((HP2 - 1)); fi
  say "4. A cheating host (test-cheats build) closes early at the chain's height $(tip) but writes the close height $CH"
  LL_TEST_BACKDATE_CLOSE=$CH $CHEAT close --run "$RUN" --sweep-to "$(addr outsider)" 2>&1 | grep -v "^#\|^$" | sed 's/^/   /'
  SWEEP=$(python3 -c 'import json,sys; o=[x["txid"] for x in json.load(open(sys.argv[1])) if x["kind"]=="sweep"]; print(o[0] if o else "")' "$RUN/private/outbox.json" 2>/dev/null)
  [ -n "$SWEEP" ] && mined "$SWEEP" && note "sweep $SWEEP mined"
  sync_w "$W"
  say "5. What the list and the wallet show"; notes; $BIN/ll-host late --run "$RUN" 2>&1 | sed 's/^/   /'
  say "6. Recount"; recount
  ;;
*) die "unknown scenario $S" ;;
esac
say "done ($RUN)"
