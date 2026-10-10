#!/usr/bin/env python3
"""Writes relay data as plain files, in the layout a relay answers with, so any static web host can stand in for a relay.

A relay answers GET /v1/campaigns/<id> (the rules), /v1/campaigns/<id>/ledger?from=0 (every entry), /challenges and /tickets/<nullifier>.
On a static host a path cannot be both a file and a folder, so the rules go to <id>/index.html (the host sends the browser there), and the
others are files next to it: <id>/ledger, <id>/challenges (always an empty list here: published challenges can hold a contributor's secrets,
so none are exported), <id>/tickets/<nullifier>. The query string (?from=0) is ignored by a static host, which is fine: the whole ledger is served.

Usage: static-export.py <relay folder with campaigns/> <output folder>   (writes <output>/v1/campaigns/...)
"""
import glob, json, os, shutil, sys

src, out = sys.argv[1], sys.argv[2]
n = 0
for cdir in sorted(glob.glob(os.path.join(src, "campaigns", "*"))):
    cid = os.path.basename(cdir)
    dest = os.path.join(out, "v1", "campaigns", cid)
    os.makedirs(os.path.join(dest, "tickets"), exist_ok=True)
    shutil.copyfile(os.path.join(cdir, "rules.json"), os.path.join(dest, "index.html"))
    files = sorted(glob.glob(os.path.join(cdir, "ledger", "*.json")))
    raw = [open(f, "rb").read().strip() for f in files]
    with open(os.path.join(dest, "ledger"), "wb") as f:
        f.write(b"[" + b",".join(raw) + b"]")
    with open(os.path.join(dest, "challenges"), "w") as f:
        f.write("[]")
    last = {}  # nullifier -> blob hash of its newest ticket entry, as the relay finds it
    for r in raw:
        e = json.loads(r)
        nf = (e.get("contribution") or {}).get("nf")
        if nf and e.get("blob_hash"):
            last[nf] = e["blob_hash"]
    for nf, h in last.items():
        shutil.copyfile(os.path.join(cdir, "blobs", h), os.path.join(dest, "tickets", nf))
    n += 1
print(f"exported {n} campaign(s) to {out}")
