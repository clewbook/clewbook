"""Read-only view of a wallet's Ironwood notes: value, nullifier, spend and lock state."""
import sqlite3, sys

wallet = sys.argv[1]
c = sqlite3.connect(f"file:{wallet}/data.sqlite?mode=ro", uri=True)
q = """
select hex(t.txid), n.action_index, n.value, hex(n.nf), n.lock_owner, n.lock_expiry_height,
       (select hex(st.txid) from ironwood_received_note_spends s
          join transactions st on st.id_tx = s.transaction_id
         where s.ironwood_received_note_id = n.id)
from ironwood_received_notes n join transactions t on t.id_tx = n.transaction_id
order by n.id
"""
for txid, idx, value, nf, owner, lexp, spent_by in c.execute(q):
    # txids are stored in internal byte order; display order is reversed
    disp = lambda h: bytes.fromhex(h)[::-1].hex() if h else None
    print(f"note {disp(txid)[:12]}:{idx} value={value} nf={nf.lower() if nf else None} "
          f"lock_owner={owner} lock_expiry={lexp} spent_by={(disp(spent_by) or '-')[:12]}")
