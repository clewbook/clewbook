#!/usr/bin/env python3
"""The late ticket watcher (docs/BLIND_BIDS.md, "If the host never finishes"). A blind bid page gives each list server a copy of its signed
late ticket; this program runs next to a relay, reads those copies from the relay's own folder (the relay never serves them), and once an
auction's late ticket block has passed with no close entry on its list (the host never finished), sends each copy to the chain servers.

It waits a while after the late ticket block (--wait-minutes, 60 by default, counted from that block's own time on the chain), so a host
that is only late still has time, and skips any auction whose list shows a close or a settlement by then (the owner's rule of 23 Oct 2026).

A late ticket can only pay the deposit back to the refund address its page signed, and only after the late ticket block; if the host has
spent the deposit (settled or refunded it), the network refuses the copy. So sending is safe whoever sends it. A copy the network refuses
(a junk copy, or a deposit already spent) is noted and tried again a few times, then left.

Python standard library only. Usage:
  latewatch.py --relay-dir DIR --server test=URL[,URL2] --server main=URL[,URL2] --state FILE [--wait-minutes 60] [--every SECONDS] [--once]
"""
import argparse, json, os, sys, time, urllib.request

SERVICE = "cash.z.wallet.sdk.rpc.CompactTxStreamer"
MAX_TRIES = 12  # tries per copy the network refuses (one a pass), then it is left


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + msg, flush=True)


def varint(n):
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out)


def fields(msg):
    """The fields of a protobuf message: {number: value} (varints as int, length delimited as bytes; the last one wins)."""
    out, i = {}, 0
    while i < len(msg):
        key, s = 0, 0
        while True:
            b = msg[i]; i += 1; key |= (b & 127) << s; s += 7
            if b < 128:
                break
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, s = 0, 0
            while True:
                b = msg[i]; i += 1; v |= (b & 127) << s; s += 7
                if b < 128:
                    break
            out[f] = v
        elif wt == 2:
            n, s = 0, 0
            while True:
                b = msg[i]; i += 1; n |= (b & 127) << s; s += 7
                if b < 128:
                    break
            out[f] = msg[i:i + n]; i += n
        elif wt == 5:
            i += 4
        elif wt == 1:
            i += 8
        else:
            raise ValueError("unreadable answer")
    return out


def grpc(server, method, req, timeout=30):
    """One grpc-web call: the first message of the answer."""
    body = b"\x00" + len(req).to_bytes(4, "big") + req
    r = urllib.request.Request(f"{server}/{SERVICE}/{method}", data=body, method="POST",
                               headers={"content-type": "application/grpc-web+proto", "x-grpc-web": "1"})
    with urllib.request.urlopen(r, timeout=timeout) as res:
        buf = res.read()
        status = res.headers.get("grpc-status")
    msgs, trailers, i = [], "", 0
    while i + 5 <= len(buf):
        flag, n = buf[i], int.from_bytes(buf[i + 1:i + 5], "big")
        part = buf[i + 5:i + 5 + n]; i += 5 + n
        if flag & 0x80:
            trailers += part.decode(errors="replace")
        else:
            msgs.append(part)
    for line in trailers.splitlines():
        if line.lower().startswith("grpc-status:"):
            status = line.split(":", 1)[1].strip()
    if status not in (None, "", "0"):
        raise RuntimeError(f"{method}: grpc-status {status} {trailers.strip()}")
    return msgs[0] if msgs else b""


def tip(servers):
    for s in servers:
        try:
            return fields(grpc(s, "GetLatestBlock", b"")).get(1)
        except Exception as e:  # the next server
            log(f"{s}: no chain height ({e})")
    return None


def block_time(servers, height):
    """The time (unix seconds) of a block, from its note tree state (TreeState field 4)."""
    for s in servers:
        try:
            t = fields(grpc(s, "GetTreeState", b"\x08" + varint(height))).get(4)
            if t:
                return t
        except Exception as e:  # the next server
            log(f"{s}: no time for block {height} ({e})")
    return None


def send(servers, raw):
    """Sends the transaction to every server; (accepted by one, what each said)."""
    said, ok = [], False
    for s in servers:
        try:
            f = fields(grpc(s, "SendTransaction", b"\x0a" + varint(len(raw)) + raw))
            code, msg = f.get(1, 0), f.get(2, b"").decode(errors="replace")
            code = code - (1 << 64) if code >= 1 << 63 else code  # an int32 sent as a 64 bit varint
            ok = ok or code == 0
            said.append(f"{s}: {'accepted' if code == 0 else f'refused ({code}) {msg}'}")
        except Exception as e:
            said.append(f"{s}: {e}")
    return ok, said


def entries(campaign_dir):
    out = []
    ledger = os.path.join(campaign_dir, "ledger")
    for name in sorted(os.listdir(ledger)) if os.path.isdir(ledger) else []:
        if name.endswith(".json"):
            try:
                with open(os.path.join(ledger, name)) as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                pass
    return out


def run_pass(relay_dir, servers_by_net, state, wait_secs=3600, now=None):
    """One look at every auction that has late tickets; returns how many copies were sent."""
    root, sent = os.path.join(relay_dir, "campaigns"), 0
    tips = {}
    for cid in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        cdir = os.path.join(root, cid)
        late = os.path.join(cdir, "late")
        if not os.path.isdir(late) or not os.listdir(late):
            continue
        try:
            with open(os.path.join(cdir, "rules.json")) as f:
                rules = json.load(f)
        except (OSError, ValueError):
            continue
        sealed, net = rules.get("sealed") or {}, rules.get("network")
        servers = servers_by_net.get(net)
        if not sealed or not servers:
            continue
        if net not in tips:
            tips[net] = tip(servers)
        h = tips[net]
        if h is None or h <= sealed["claim_after"]:
            continue  # late tickets are valid only after the late ticket block
        if any(e.get("kind") in ("close", "settle") for e in entries(cdir)):
            continue  # the host closed or settled: its settlements and refunds spend the deposits
        t = block_time(servers, sealed["claim_after"])
        if t is None or (now if now is not None else time.time()) < t + wait_secs:
            continue  # still inside the wait after the late ticket block (or its time could not be read: asked again next pass)
        for name in sorted(os.listdir(late)):
            key = f"{cid}/{name}"
            st = state.setdefault(key, {"tries": 0, "done": False})
            if st["done"] or st["tries"] >= MAX_TRIES:
                continue
            with open(os.path.join(late, name), "rb") as f:
                raw = f.read()
            st["tries"] += 1
            ok, said = send(servers, raw)
            st["last"] = said
            if ok:
                st["done"] = True
                sent += 1
            log(f"auction {cid[:8]} ({net}), deposit {name[:8]}, try {st['tries']}: " + "; ".join(said))
    return sent


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--relay-dir", required=True, help="the relay's folder (cb-relay serve --dir)")
    ap.add_argument("--server", action="append", default=[], help="NETWORK=URL[,URL2]: grpc-web chain servers, e.g. test=https://zjs.zec.rocks/testnet")
    ap.add_argument("--state", required=True, help="a file where the watcher keeps what it sent")
    ap.add_argument("--wait-minutes", type=int, default=60, help="minutes after the late ticket block's time before sending")
    ap.add_argument("--every", type=int, default=300, help="seconds between passes")
    ap.add_argument("--once", action="store_true", help="one pass, then stop")
    a = ap.parse_args()
    servers = {}
    for s in a.server:
        net, _, urls = s.partition("=")
        servers[net] = [u.rstrip("/") for u in urls.split(",") if u]
    if not servers:
        sys.exit("give at least one --server NETWORK=URL")
    try:
        with open(a.state) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    log(f"late ticket watcher: relay folder {a.relay_dir}, networks {', '.join(sorted(servers))}, waits {a.wait_minutes} minutes after the late ticket block")
    while True:
        try:
            run_pass(a.relay_dir, servers, state, a.wait_minutes * 60)
        except Exception as e:
            log(f"pass failed: {e}")
        tmp = a.state + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, a.state)
        if a.once:
            break
        time.sleep(a.every)


if __name__ == "__main__":
    main()
