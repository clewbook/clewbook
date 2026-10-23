#!/usr/bin/env python3
"""Checks the public page server (app/web/serve.py) on a spare port: the allow list, the security headers, the size limit of its one POST route,
and that it never runs more than a bounded number of requests at once. No network beyond this computer, no browser. From the repository root:
python3 app/web/serve-test.py [port]   (default 8813)"""
import http.client, os, socket, subprocess, sys, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8813
failed = 0
def check(name, ok, extra=""):
    global failed
    print(("PASS  " if ok else "FAIL  ") + name + (f"  {extra}" if extra else ""))
    failed += 0 if ok else 1

def get(path, method="GET", body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
    c.request(method, path, body=body, headers=headers or {})
    r = c.getresponse(); data = r.read(); c.close()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, data

def start(dev=False):
    env = {**os.environ, "SERVE_TIMEOUT": "3", **({"SERVE_DEV": "1"} if dev else {})}
    env.pop("SERVE_DEV", None) if not dev else None
    p = subprocess.Popen([sys.executable, "app/web/serve.py", str(PORT), "127.0.0.1"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close(); break
        except OSError:
            time.sleep(0.1)
    return p

srv = start()
try:
    for path in ["/", "/contribute.html", "/recount.html", "/badge.html", "/ui.css", "/copies.js", "/about.js", "/nu7.js", "/anchor.js", "/go.html", "/go.js", "/pkg/ll_web_bg.wasm", "/fonts/LICENSE-archivo.txt"]:
        st, h, _ = get(path)
        check(f"served: {path}", st == 200, str(st))
    st, h, _ = get("/pkg/ll_web_bg.wasm")
    check("the module is served as application/wasm", h.get("content-type", "").startswith("application/wasm"), h.get("content-type"))
    for path in ["/current.json", "/dashboard.html", "/setup.html", "/dashboard.js", "/components.html", "/recount-bundle.html", "/bundles/raise-a.json",
                 "/node-check.mjs", "/pkg/ll_web.d.ts", "/fonts/../current.json", "/%2e%2e/serve.py", "/../serve.py", "/fonts/"]:
        st, h, body = get(path)
        check(f"not served: {path}", st == 404 and b"isn't here" in body, str(st))
    st, h, _ = get("/contribute.html")
    csp = h.get("content-security-policy", "")
    check("a page carries nosniff, no-referrer and a content security policy", h.get("x-content-type-options") == "nosniff" and h.get("referrer-policy") == "no-referrer" and "default-src 'self'" in csp, csp)
    check("an ordinary page may not be framed by another site, and runs no inline script", "frame-ancestors 'self'" in csp and "'unsafe-inline'" not in csp.split("script-src")[1].split(";")[0], csp)
    st, h, _ = get("/badge.html")
    check("the badge may be framed anywhere (it is made to be embedded)", "frame-ancestors *" in h.get("content-security-policy", ""))
    st, h, _ = get("/grpc/zec.0xrpc.io/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock", "POST", body=b"x" * (64 * 1024 + 1), headers={"Content-Length": str(64 * 1024 + 1)})
    check("a POST body over 64 KiB is refused before anything is forwarded", st == 413, str(st))
    s = socket.create_connection(("127.0.0.1", PORT)); s.sendall(b"POST /grpc/zec.0xrpc.io/x HTTP/1.1\r\nHost: x\r\nContent-Length: 999999999\r\n\r\n"); s.settimeout(5)
    check("a huge announced body is refused at once, not read", b" 413 " in s.recv(200)); s.close()
    st, h, _ = get("/grpc/evil.example/x", "POST", body=b"", headers={"Content-Length": "0"})
    check("the forwarder only talks to its fixed list of chain servers", st == 404, str(st))

    # 100 clients that connect and send nothing: the server never runs more than its bound at once, and recovers after the timeout
    idle = [socket.create_connection(("127.0.0.1", PORT)) for _ in range(100)]
    time.sleep(1)
    threads = int([l for l in open(f"/proc/{srv.pid}/status") if l.startswith("Threads:")][0].split()[1])
    check("100 idle connections: at most 32 handler threads (plus the main one)", threads <= 33, f"{threads} threads")
    time.sleep(8)  # their 3-second timeout passes, in batches of 32
    st, _, _ = get("/contribute.html")
    check("after the idle clients time out, pages are served again", st == 200, str(st))
    for s in idle: s.close()
finally:
    srv.terminate(); srv.wait()

srv = start(dev=True)
try:
    st, _, _ = get("/components.html")
    st2, h, _ = get("/current.json")
    check("SERVE_DEV=1 (tests on this computer only) also serves the developer files", st == 200 and st2 in (200, 404), f"{st} {st2}")
    st, _, _ = get("/dashboard.html")
    check("  but never the host's own pages", st == 404, str(st))
finally:
    srv.terminate(); srv.wait()
print(f"{failed} FAILED" if failed else "ALL PASS")
sys.exit(1 if failed else 0)
