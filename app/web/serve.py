#!/usr/bin/env python3
"""Serves the public pages of app/web/www. Unknown addresses get a friendly page, never a raw error.
Usage: serve.py [port] [bind address]   (default 8770 on 127.0.0.1)

This server can be reached from outside (through a tunnel), so it serves only an allow list of files (the public pages and what they load),
sends the same security headers as the hosted copy (app/web/vercel.json), accepts at most a small body on its one POST route, and handles a
bounded number of requests at a time. SERVE_DEV=1 also serves the developer files (the component sheet, the recount bundles, the local demo's
current.json) for tests on this computer; never set it for a server that is reachable from outside."""
import http.client, http.server, os, re, ssl, sys, threading

ROOT = os.environ.get("SERVE_ROOT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "www")  # SERVE_ROOT: a folder built to be served instead (for example a copy of www)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
BIND = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
DEV = os.environ.get("SERVE_DEV") == "1"

# The public pages and everything they load. Nothing else is served (no host pages, no developer files, no local state).
PAGES = {"index.html", "recount.html", "campaign.html", "card.html", "badge.html", "contribute.html", "host.html"}
FILES = PAGES | {
    "robots.txt", "campaigns.json",
    "ui.css", "start.css", "recount.css", "campaign.css", "card.css", "badge.css", "contribute.css",
    "loadguard.js", "start.js", "recount.js", "recount-page.js", "campaign.js", "card.js", "badge.js", "contribute.js", "public.js",
    "capabilities.js", "canon.js", "ui.js", "brand.js", "blocktime.js", "proof-worker.js", "copies.js", "home.js", "host.js",
}
PATTERNS = [re.compile(p) for p in (
    r"fonts/[A-Za-z0-9-]+\.(woff2|txt)",
    r"img/[A-Za-z0-9-]+\.(svg|png|ico)",
    r"pkg/ll_web(_bg)?\.(js|wasm)",
    r"proof/ll_proofcheck(_bg)?\.(js|wasm)",
)]
DEV_FILES = {"components.html", "recount-bundle.html", "current.json"}
DEV_PATTERNS = [re.compile(r"bundles/[a-z0-9-]+\.json")]

MAX_BODY = 64 * 1024        # the /grpc route forwards one small request; nothing bigger is read
MAX_ACTIVE = 32             # requests handled at the same time; the rest wait in the queue
TIMEOUT = int(os.environ.get("SERVE_TIMEOUT", "30"))  # seconds a slow client may take before its connection is dropped

def allowed(rel):
    if rel in FILES or any(p.fullmatch(rel) for p in PATTERNS):
        return True
    return DEV and (rel in DEV_FILES or any(p.fullmatch(rel) for p in DEV_PATTERNS))

def csp(rel):
    # the same policy as the hosted copy: only the badge may be shown inside another site's page
    frame = "*" if rel == "badge.html" else "'self'"
    # the one inline script every page carries: it applies the saved theme before the page is drawn (its hash, so no other inline script runs)
    script = "'self' 'wasm-unsafe-eval' 'sha256-tbR7f3dzTMcosXeYlerpxrjuAGprJzX+Z+ggCw7dHKI='" + (" 'unsafe-inline'" if DEV else "")
    return (f"default-src 'self'; script-src {script}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; "
            f"connect-src *; worker-src 'self' blob:; frame-ancestors {frame}; base-uri 'none'; form-action 'none'")

NOT_FOUND = b"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script>(function(){var c='system';try{c=localStorage.getItem('cb-theme')||'system'}catch(e){}if(c!=='light'&&c!=='dark')c='system';var r=document.documentElement,m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');r.dataset.themeChoice=c;r.dataset.theme=(c==='dark'||(c==='system'&&m&&m.matches))?'dark':'light'})()</script>
<title>Not here</title><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/start.css">
<header class="bar"><a class="word" href="/" aria-label="clewbook home"><svg class="mark" viewBox="1 6 44 33" width="30" height="23" aria-hidden="true" focusable="false"><path d="M16 12H32A6 6 0 0 1 32 24H12A6 6 0 0 0 12 36H41" fill="none" stroke-width="6" stroke-linecap="round"/><circle cx="6" cy="12" r="3"/></svg><span>clewbook</span></a><span class="tagline">Private Markets. Public Accounting.</span><nav class="nav" aria-label="Main"><a href="/">Campaigns</a><a href="/recount.html">Recount</a><a href="/host.html">Host</a></nav></header>
<main class="page notfound"><p class="nf-k">404</p><h1 class="nf-h">That page isn't here</h1><p class="nf-l">The address may be mistyped, or the page may not exist yet.</p>
<p class="btns nf-b"><a class="btn" href="/">Go to campaigns</a> <a class="btn neutral" href="/host.html">Host guide</a></p></main>
<footer class="sitefoot"><span>Clewbook &middot; Private Markets. Public Accounting.</span></footer>"""

# Public lightwalletd servers that do not allow browser requests themselves. This local server forwards
# a browser's gRPC-web call to them (same request, same answer, nothing stored), so the recount page can
# ask servers run by different people on different hosting. Extend with LL_GRPC_HOSTS=host[:port],host...
GRPC_HOSTS = {"zec.0xrpc.io", "z.ombie.cash"} | {h for h in os.environ.get("LL_GRPC_HOSTS", "").split(",") if h}

class Handler(http.server.SimpleHTTPRequestHandler):
    timeout = TIMEOUT
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".woff2": "font/woff2", ".js": "text/javascript"}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def rel(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        rel = path.lstrip("/") or "index.html"
        return rel

    def do_POST(self):
        parts = self.path.split("/", 3)  # "", "grpc", host, rest
        if len(parts) < 4 or parts[1] != "grpc" or parts[2] not in GRPC_HOSTS:
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length") or -1)
        except ValueError:
            length = -1
        if length < 0:
            return self.plain(411, b"a length is needed")
        if length > MAX_BODY:
            self.close_connection = True
            return self.plain(413, b"request too large")
        body = self.rfile.read(length)
        host, _, port = parts[2].partition(":")
        try:
            c = http.client.HTTPSConnection(host, int(port or 443), timeout=25, context=ssl.create_default_context())
            c.request("POST", "/" + parts[3], body=body, headers={"content-type": "application/grpc-web+proto", "x-grpc-web": "1"})
            r = c.getresponse(); data = r.read()
        except Exception:
            return self.plain(502, b"")
        self.send_response(r.status)
        self.send_header("Content-Type", r.getheader("content-type") or "application/grpc-web+proto")
        if r.getheader("grpc-status") is not None: self.send_header("grpc-status", r.getheader("grpc-status"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def plain(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if not allowed(self.rel()):
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if not allowed(self.rel()):
            return self.send_error(404)
        return super().do_HEAD()

    def send_error(self, code, message=None, explain=None):
        if code in (404, 403, 405):
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(NOT_FOUND)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(NOT_FOUND)
        else:
            super().send_error(code, message, explain)

    def list_directory(self, path):  # no directory listings
        self.send_error(404)
        return None

    def end_headers(self):
        rel = self.rel()
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
        self.send_header("Content-Security-Policy", csp(rel))
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

class Server(http.server.ThreadingHTTPServer):
    """At most MAX_ACTIVE requests at a time: the next connection waits (in the system's queue) until one finishes."""
    daemon_threads = True
    slots = threading.BoundedSemaphore(MAX_ACTIVE)

    def process_request(self, request, client_address):
        self.slots.acquire()
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

if __name__ == "__main__":
    Server((BIND, PORT), Handler).serve_forever()
