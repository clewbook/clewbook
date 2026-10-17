#!/usr/bin/env bash
# Assembles a folder that any static HTTPS web host can serve: the recount page and the pages that only read (campaign, capability card, badge,
# contribute for looking at a campaign), the built browser module, the fonts, and the example campaigns as files standing in for two relays.
# No relay program and no page server program is needed. Nothing is deployed. From the repository root; needs app/web/www/pkg and proof built.
# Usage: app/web/make-static.sh [output folder]   (default runs/static-demo)
set -euo pipefail
OUT=${1:-runs/static-demo}
PREFIX=${PREFIX:-}   # where the folder is served from, for the absolute links of its start page (the hosted copy serves it under /demo)
WWW=${WWW:-app/web/www}   # WWW=<folder> builds the demo from another copy of the pages
[ -f $WWW/pkg/ll_web_bg.wasm ] && [ -f $WWW/proof/ll_proofcheck_bg.wasm ] || { echo "make-static.sh: build the browser module first (app/web/build.sh)" >&2; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"
# the pages and what they load; the host-only pages (dashboard, set-up) are left out because they need the host program
for f in recount campaign card badge contribute; do cp $WWW/$f.html "$OUT/"; done
# inside the demo the header's "Testnet demo" is the place you are: a marked item, not a link (design round 11)
for f in recount campaign card contribute; do sed -i 's#<a class="demo-link" href="https://clewbook.xyz/demo/" title="Testnet demo, no real money" aria-label="Testnet demo, no real money">Testnet demo</a>#<span class="demo-link cur" aria-current="page" title="Testnet demo, no real money"><i class="demo-dot" aria-hidden="true"></i>Testnet demo</span>#' "$OUT/$f.html"; grep -q 'demo-link cur' "$OUT/$f.html" || { echo "make-static.sh: no demo item in $f.html" >&2; exit 1; }; done
for f in recount recount-page campaign card badge contribute public capabilities canon ui brand blocktime recount proof-worker loadguard copies; do [ -f $WWW/$f.js ] && cp $WWW/$f.js "$OUT/"; done
cp $WWW/ui.css $WWW/start.css $WWW/recount.css $WWW/campaign.css $WWW/card.css $WWW/badge.css $WWW/contribute.css "$OUT/"
cp -r $WWW/fonts $WWW/img $WWW/pkg $WWW/proof "$OUT/"
# two relays, as two copies of the examples (a demonstration, not independent evidence)
python3 app/web/static-export.py examples/relay "$OUT/relays/a"
python3 app/web/static-export.py examples/relay "$OUT/relays/b"
# a start page that builds the links from wherever it is served
# the demo's start page and, under proofs/, the five example recounts (their scripts are files of their own: the pages allow no inline script)
mkdir -p "$OUT/proofs"
cat > "$OUT/index.html" <<HTML
<!doctype html><html lang="en"><meta charset="utf-8"><script>(function(){var c='system';try{c=localStorage.getItem('cb-theme')||'system'}catch(e){}if(c!=='light'&&c!=='dark')c='system';var r=document.documentElement,m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');r.dataset.themeChoice=c;r.dataset.theme=(c==='dark'||(c==='system'&&m&&m.matches))?'dark':'light'})()</script><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo</title>
<link rel="stylesheet" href="$PREFIX/ui.css"><link rel="stylesheet" href="$PREFIX/start.css"><link rel="stylesheet" href="$PREFIX/demo.css"><link rel="icon" href="$PREFIX/img/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="$PREFIX/img/app-icon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="$PREFIX/img/app-icon-16.png"><link rel="icon" type="image/png" sizes="512x512" href="$PREFIX/img/app-icon-512.png"><link rel="apple-touch-icon" sizes="180x180" href="$PREFIX/img/app-icon-180.png"><body>
<div id="netbar" class="netbar test" role="status"><b>TESTNET</b> · TAZ has no value.</div>
<header class="bar"><a class="word" href="https://app.clewbook.xyz/" aria-label="clewbook home"><svg class="mark" viewBox="1 6 44 33" width="30" height="23" aria-hidden="true" focusable="false"><path d="M16 12H32A6 6 0 0 1 32 24H12A6 6 0 0 0 12 36H41" fill="none" stroke-width="6" stroke-linecap="round"/><circle cx="6" cy="12" r="3"/></svg><span>clewbook</span></a><span class="tagline">Private Markets. Public Accounting.</span><nav class="nav" aria-label="Main"><a href="https://app.clewbook.xyz/">Campaigns</a><a href="$PREFIX/recount.html">Recount</a><a href="https://app.clewbook.xyz/host.html">Host</a><span class="demo-link cur" aria-current="page" title="Testnet demo, no real money"><i class="demo-dot" aria-hidden="true"></i>Testnet demo</span></nav></header>
<div class="aurora" aria-hidden="true"><div></div></div>
<main class="page dpage"><div class="dwrap">
<div class="dhero"><span class="dk2"><span class="tn">TESTNET</span><span class="dm">DEMO</span></span><h1 class="dh1">Try it with test money</h1>
<p class="dlede">Test coins (TAZ) have no value. All campaigns here exist only for Recount and verification purposes.</p></div>
<div class="dcards">
<section class="dc one"><span class="dc-k">01 · START HERE</span><h2>Tested milestones</h2><p>13 finished test campaigns. Five were built to cheat, so you can watch a recount catch them.</p><div class="sp"></div><a class="dbtn pri" href="$PREFIX/proofs/">Open tested milestones →</a></section>
<section class="dc"><span class="dc-k">02</span><h2>Check a saved copy</h2><p>Saved a campaign's list? Load it on the recount page.</p><div class="sp"></div><a class="dbtn" href="$PREFIX/recount.html">Open recount</a></section>
<section class="dc"><span class="dc-k">03</span><h2>Mainnet</h2><p>Real campaigns run on Zcash Mainnet, on the main site.</p><div class="sp"></div><a class="dbtn" href="https://app.clewbook.xyz/">Go to main site ↗</a></section>
</div>
</div></main>
<footer class="sitefoot"><span><span data-brand></span> · Private Markets. Public Accounting.</span></footer>
<script src="$PREFIX/loadguard.js"></script>
<script src="$PREFIX/demo.js"></script>
<script type="module" src="$PREFIX/theme-mount.js"></script></body></html>
HTML

# the Theme control and the phone menu on the two pages written here (the other pages mount them themselves through ui.js)
printf "import { mountFrame } from '%s/ui.js';\nmountFrame();\n" "$PREFIX" > "$OUT/theme-mount.js"
cat > "$OUT/demo.js" <<'JS'
document.documentElement.dataset.started = "1"; document.documentElement.dataset.ready = "1";
for (const el of document.querySelectorAll('[data-brand]')) el.textContent = 'Clewbook';
JS
cat > "$OUT/proofs/index.html" <<HTML
<!doctype html><html lang="en"><meta charset="utf-8"><script>(function(){var c='system';try{c=localStorage.getItem('cb-theme')||'system'}catch(e){}if(c!=='light'&&c!=='dark')c='system';var r=document.documentElement,m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');r.dataset.themeChoice=c;r.dataset.theme=(c==='dark'||(c==='system'&&m&&m.matches))?'dark':'light'})()</script><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tested milestones</title>
<link rel="stylesheet" href="$PREFIX/ui.css"><link rel="stylesheet" href="$PREFIX/start.css"><link rel="stylesheet" href="$PREFIX/demo.css"><link rel="icon" href="$PREFIX/img/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="$PREFIX/img/app-icon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="$PREFIX/img/app-icon-16.png"><link rel="icon" type="image/png" sizes="512x512" href="$PREFIX/img/app-icon-512.png"><link rel="apple-touch-icon" sizes="180x180" href="$PREFIX/img/app-icon-180.png"><body>
<div id="netbar" class="netbar test" role="status"><b>TESTNET</b> · TAZ has no value.</div>
<header class="bar"><a class="word" href="https://app.clewbook.xyz/" aria-label="clewbook home"><svg class="mark" viewBox="1 6 44 33" width="30" height="23" aria-hidden="true" focusable="false"><path d="M16 12H32A6 6 0 0 1 32 24H12A6 6 0 0 0 12 36H41" fill="none" stroke-width="6" stroke-linecap="round"/><circle cx="6" cy="12" r="3"/></svg><span>clewbook</span></a><span class="tagline">Private Markets. Public Accounting.</span><nav class="nav" aria-label="Main"><a href="https://app.clewbook.xyz/">Campaigns</a><a href="$PREFIX/recount.html">Recount</a><a href="https://app.clewbook.xyz/host.html">Host</a><span class="demo-link cur" aria-current="page" title="Testnet demo, no real money"><i class="demo-dot" aria-hidden="true"></i>Testnet demo</span></nav></header>
<div class="aurora" aria-hidden="true"><div></div></div>
<main class="page dpage"><div class="dwrap">
<div class="pintro"><a class="pback" href="$PREFIX/">← Testnet demo</a><h1 class="ph1">Tested milestones</h1>
<p class="dlede">Pick any one and press Recount. Your browser checks it live. Green ones should pass. Red ones were built to cheat and should fail.</p></div>
<div class="ptools"><div class="pchips" role="group" aria-label="Expected result"><button type="button" class="pchip" data-res="all" aria-pressed="true">All</button><button type="button" class="pchip" data-res="pass" aria-pressed="false">✓ Passed</button><button type="button" class="pchip" data-res="fail" aria-pressed="false">✕ Failed</button></div>
<div class="pright"><div class="pseg" role="group" aria-label="Type"><button type="button" data-type="all" aria-pressed="true">All</button><button type="button" data-type="Fundraiser" aria-pressed="false">Fundraisers</button><button type="button" data-type="Auction" aria-pressed="false">Auctions</button></div>
<button type="button" class="pview" id="view" aria-label="Show as grid" title="Show as grid"><svg id="ic-grid" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="9" y="1" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="1" y="9" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="9" y="9" width="6" height="6" rx="1.5" fill="currentColor"/></svg><svg id="ic-list" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style="display:none"><rect x="1" y="2" width="14" height="2.4" rx="1.2" fill="currentColor"/><rect x="1" y="6.8" width="14" height="2.4" rx="1.2" fill="currentColor"/><rect x="1" y="11.6" width="14" height="2.4" rx="1.2" fill="currentColor"/></svg></button></div></div>
<div id="list" class="plist"></div><p class="pnone" id="none" hidden>Nothing matches these filters.</p>
<p class="pfoot">Expected results are what each example was built to show. The recount itself runs live. No real money.</p>
</div></main>
<footer class="sitefoot"><span><span data-brand></span> · Private Markets. Public Accounting.</span></footer>
<script src="$PREFIX/loadguard.js"></script>
<script src="$PREFIX/proofs/examples.js"></script>
<script type="module" src="$PREFIX/theme-mount.js"></script></body></html>
HTML

# the tested milestones page's script and the two pages' own stylesheet (demo only: the app's pages never load them)
cp app/web/demo/proofs.js "$OUT/proofs/examples.js"
cp app/web/demo/demo.css "$OUT/demo.css"
echo "static folder ready: $OUT ($(du -sh "$OUT" | cut -f1)); serve it with any static host, for example: python3 -m http.server --directory $OUT 8800"
