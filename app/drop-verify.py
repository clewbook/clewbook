#!/usr/bin/env python3
"""Evidence for the broadcast-reliability test: for each run directory given, every transaction the host sent was
dropped once by the fake flaky server, sent again with the same bytes, and ended up mined exactly once; no coin was
spent twice. Usage: drop-verify.py <run dir>..."""
import json, sqlite3, sys, os

bad = 0
def check(ok, msg):
    global bad
    print(("PASS  " if ok else "FAIL  ") + msg)
    if not ok: bad += 1

for run in sys.argv[1:]:
    cfg = json.load(open(f"{run}/config.json"))
    wallet = cfg["wallet"]
    items = json.load(open(f"{run}/private/outbox.json"))
    dropped = set(open(f"{wallet}/test-dropped.txt").read().split()) if os.path.exists(f"{wallet}/test-dropped.txt") else set()
    check(len(items) > 0, f"{run}: outbox has {len(items)} transaction(s): " + ", ".join(f"{i['kind']} {i['txid'][:10]} sends={i['sends']} {i['status']}" for i in items))
    check(all(i["txid"] in dropped for i in items), f"{run}: the server dropped the first broadcast of every one of them ({len(dropped)} dropped)")
    check(all(i["sends"] >= 2 for i in items), f"{run}: each was sent again (sends >= 2), same bytes (raw_hex unchanged in the outbox)")
    check(all(i["status"] == "confirmed" and i["mined_height"] for i in items), f"{run}: each confirmed in a block ({[i['mined_height'] for i in items]})")
    check(len({i["txid"] for i in items}) == len(items), f"{run}: no transaction was recorded twice")
    db = sqlite3.connect(f"file:{wallet}/data.sqlite?mode=ro", uri=True)
    for i in items:
        for nf in i["nfs"]:
            rows = db.execute("""select hex(st.txid) from ironwood_received_notes n
                 join ironwood_received_note_spends s on s.ironwood_received_note_id = n.id
                 join transactions st on st.id_tx = s.transaction_id where hex(n.nf) = ?""", (nf.upper(),)).fetchall()
            spenders = {bytes.fromhex(r[0])[::-1].hex() for r in rows}
            check(spenders == {i["txid"]}, f"{run}: coin {nf[:10]}... is spent exactly once, by {i['txid'][:10]}... (spent by {sorted(x[:10] for x in spenders)})")
sys.exit(1 if bad else 0)
