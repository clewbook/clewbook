#!/usr/bin/env python3
"""The late ticket watcher's decisions, without a network: a stand in chain server on this computer (grpc-web: the height, and what it
says to each transaction sent) and a stand in relay folder. Checks: nothing is sent before the late ticket block; nothing for an auction
whose list has a close entry; nothing for a fundraiser or a network without a server; after the block, each copy is sent once and kept as
sent; a copy the network refuses is tried again on each pass, at most MAX_TRIES times; what it sent survives a restart (the state file);
nothing is sent until the wait after the late ticket block's own time is over (60 minutes by default, a setting), and an auction whose
list shows a close or a settlement by then is skipped.

Usage: python3 app/latewatch/latewatch-test.py
"""
import http.server, json, os, sys, tempfile, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import latewatch as lw  # noqa: E402

failed = 0


def check(name, ok, extra=""):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + str(extra)) if extra else ''}", flush=True)
    failed += 0 if ok else 1


class Chain:
    tip, sent, refuse, block_time = 1000, [], set(), 1_800_000_000


def frame(msg):
    return b"\x00" + len(msg).to_bytes(4, "big") + msg + b"\x80" + len(b"grpc-status:0\r\n").to_bytes(4, "big") + b"grpc-status:0\r\n"


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"]))[5:]
        if self.path.endswith("/GetLatestBlock"):
            out = b"\x08" + lw.varint(Chain.tip)
        elif self.path.endswith("/GetTreeState"):
            out = b"\x10" + lw.varint(lw.fields(body)[1]) + b"\x20" + lw.varint(Chain.block_time)
        else:
            raw = lw.fields(body)[1]
            Chain.sent.append(raw)
            if raw in Chain.refuse:
                msg = b"bad-txns-joinsplit-requirements-not-met"
                out = b"\x08" + lw.varint((1 << 64) - 26) + b"\x12" + lw.varint(len(msg)) + msg
            else:
                out = b""
        res = frame(out)
        self.send_response(200)
        self.send_header("content-type", "application/grpc-web+proto")
        self.send_header("content-length", str(len(res)))
        self.end_headers()
        self.wfile.write(res)


def campaign(root, cid, network, sealed, closed, copies, settled=False):
    d = os.path.join(root, "campaigns", cid)
    os.makedirs(os.path.join(d, "ledger"))
    rules = {"network": network, "mode": "sealed_auction" if sealed else "raise"}
    if sealed:
        rules["sealed"] = {"claim_after": 1100}
    with open(os.path.join(d, "rules.json"), "w") as f:
        json.dump(rules, f)
    with open(os.path.join(d, "ledger", "0.json"), "w") as f:
        json.dump({"kind": "issue"}, f)
    if closed:
        with open(os.path.join(d, "ledger", "1.json"), "w") as f:
            json.dump({"kind": "close"}, f)
    if settled:
        with open(os.path.join(d, "ledger", "2.json"), "w") as f:
            json.dump({"kind": "settle"}, f)
    os.makedirs(os.path.join(d, "late"))
    for name, raw in copies.items():
        with open(os.path.join(d, "late", name), "wb") as f:
            f.write(raw)


def main():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    root = tempfile.mkdtemp(prefix="latewatch-test-")
    good, junk, done_elsewhere = b"G" * 2000, b"J" * 2000, b"C" * 2000
    campaign(root, "a" * 64, "test", True, False, {"nf1-good.tx": good, "nf1-junk.tx": junk})
    campaign(root, "b" * 64, "test", True, True, {"nf2-x.tx": done_elsewhere})
    campaign(root, "c" * 64, "test", False, False, {"nf3-x.tx": b"R" * 2000})
    campaign(root, "d" * 64, "main", True, False, {"nf4-x.tx": b"M" * 2000})
    campaign(root, "e" * 64, "test", True, False, {"nf5-x.tx": b"S" * 2000}, settled=True)
    Chain.refuse = {junk}
    servers, state = {"test": [url]}, {}

    t0 = Chain.block_time  # the late ticket block's own time
    Chain.tip = 1100
    lw.run_pass(root, servers, state, 3600, now=t0 + 7200)
    check("at the late ticket block itself nothing is sent (a late ticket is valid only after it)", Chain.sent == [], len(Chain.sent))
    Chain.tip = 1101
    lw.run_pass(root, servers, state, 3600, now=t0 + 3599)
    check("after the block, but 59 minutes 59 seconds after its time: nothing sent yet (the wait is 60 minutes)", Chain.sent == [], len(Chain.sent))
    lw.run_pass(root, servers, state, 600, now=t0 + 600)
    check("the wait is a setting: with 10 minutes, sent at 10 minutes", sorted(Chain.sent) == sorted([good, junk]), len(Chain.sent))
    Chain.sent, state = [], {}
    n = lw.run_pass(root, servers, state, 3600, now=t0 + 3600)
    check("after the block, with no close on the list: both copies of the open auction are sent", sorted(Chain.sent) == sorted([good, junk]) and n == 1, n)
    check("an auction whose list has a close entry: nothing sent", done_elsewhere not in Chain.sent)
    check("an auction whose list has a settlement entry: nothing sent", b"S" * 2000 not in Chain.sent)
    check("a fundraiser, and a network with no chain server given: nothing sent", all(r[:1] not in (b"R", b"M") for r in Chain.sent))
    check("the accepted copy is kept as sent; the refused one as tried once, with what the server said",
          state[f"{'a' * 64}/nf1-good.tx"]["done"] and not state[f"{'a' * 64}/nf1-junk.tx"]["done"]
          and "refused (-26)" in state[f"{'a' * 64}/nf1-junk.tx"]["last"][0], state[f"{'a' * 64}/nf1-junk.tx"]["last"])
    Chain.sent = []
    for _ in range(lw.MAX_TRIES + 3):
        lw.run_pass(root, servers, state, 3600, now=t0 + 4000)
    check(f"a refused copy is tried again on each pass, {lw.MAX_TRIES} times in all, and the sent one never again",
          Chain.sent.count(junk) == lw.MAX_TRIES - 1 and good not in Chain.sent and state[f"{'a' * 64}/nf1-junk.tx"]["tries"] == lw.MAX_TRIES)
    # the state file: a restart keeps what was sent
    path = os.path.join(root, "state.json")
    with open(path, "w") as f:
        json.dump(state, f)
    with open(path) as f:
        again = json.load(f)
    Chain.sent = []
    lw.run_pass(root, servers, again, 3600, now=t0 + 4000)
    check("after a restart (the state file read back) nothing is sent twice", Chain.sent == [])
    srv.shutdown()
    print("ALL PASS" if not failed else f"{failed} check(s) failed", flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
