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
for f in recount recount-page campaign card badge contribute public capabilities canon ui brand blocktime recount proof-worker loadguard copies; do [ -f $WWW/$f.js ] && cp $WWW/$f.js "$OUT/"; done
cp $WWW/ui.css $WWW/recount.css $WWW/campaign.css $WWW/card.css $WWW/badge.css $WWW/contribute.css "$OUT/"
cp -r $WWW/fonts $WWW/img $WWW/pkg $WWW/proof "$OUT/"
# two relays, as two copies of the examples (a demonstration, not independent evidence)
python3 app/web/static-export.py examples/relay "$OUT/relays/a"
python3 app/web/static-export.py examples/relay "$OUT/relays/b"
# a start page that builds the links from wherever it is served
# the demo's start page and, under proofs/, the five example recounts (their scripts are files of their own: the pages allow no inline script)
mkdir -p "$OUT/proofs"
cat > "$OUT/index.html" <<HTML
<!doctype html><html lang="en"><meta charset="utf-8"><script>(function(){var c='system';try{c=localStorage.getItem('cb-theme')||'system'}catch(e){}if(c!=='light'&&c!=='dark')c='system';var r=document.documentElement,m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');r.dataset.themeChoice=c;r.dataset.theme=(c==='dark'||(c==='system'&&m&&m.matches))?'dark':'light'})()</script><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo</title>
<link rel="stylesheet" href="$PREFIX/ui.css"><link rel="icon" href="$PREFIX/img/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="$PREFIX/img/app-icon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="$PREFIX/img/app-icon-16.png"><link rel="icon" type="image/png" sizes="512x512" href="$PREFIX/img/app-icon-512.png"><link rel="apple-touch-icon" sizes="180x180" href="$PREFIX/img/app-icon-180.png"><body>
<div class="netbar test"><b>TEST MONEY ONLY</b> · Test network: TAZ has no value.</div>
<header class="bar"><a class="word" href="https://app.clewbook.xyz/"><img class="logo" src="$PREFIX/img/clewbook-lockup-colour.svg" alt="Clewbook" width="180" height="28"></a><nav class="nav" aria-label="Main"><a href="$PREFIX/" aria-current="page">Test money</a><a href="$PREFIX/proofs/">Proofs</a><a href="$PREFIX/recount.html">Recount</a></nav></header>
<main class="page"><h1 class="t-h1">Try it with test money</h1>
<p class="t-lead">Everything here uses the Zcash test network: its coins have no value, and no real money is involved. The campaigns below are finished and kept as plain files, so you can recount them yourself in your browser without anyone's server.</p>
<section class="sect"><div class="hd"><h2>Tested milestones</h2></div><p class="muted">Thirteen finished test campaigns, each ready to recount: fundraisers, auctions, one with a name, one closed early, one full of odd payments, and four that fail on purpose so you can see what the recount catches.</p>
<p style="margin-top:var(--s3)"><a class="btn" href="$PREFIX/proofs/">Open the tested milestones</a></p></section>
<section class="sect"><div class="hd"><h2>Check a saved copy</h2></div><p class="muted">Have a saved copy of a campaign's list? Load it on the recount page.</p>
<p style="margin-top:var(--s3)"><a class="btn sec" href="$PREFIX/recount.html">Open the recount page</a></p></section>
<section class="sect"><div class="hd"><h2>The real thing</h2></div><p class="muted">Real campaigns, with real ZEC, are on the main site.</p>
<p style="margin-top:var(--s3)"><a class="btn sec" href="https://app.clewbook.xyz/">Go to the main site</a></p></section>
</main>
<script src="$PREFIX/loadguard.js"></script>
<script src="$PREFIX/demo.js"></script>
<script type="module" src="$PREFIX/theme-mount.js"></script></body></html>
HTML
# the Theme control on the two pages written here (the other pages mount it themselves through ui.js)
printf "import { mountTheme } from '%s/ui.js';\nmountTheme();\n" "$PREFIX" > "$OUT/theme-mount.js"
cat > "$OUT/demo.js" <<'JS'
document.documentElement.dataset.started = "1"; document.documentElement.dataset.ready = "1";
for (const el of document.querySelectorAll('[data-brand]')) el.textContent = 'Clewbook';
JS
cat > "$OUT/proofs/index.html" <<HTML
<!doctype html><html lang="en"><meta charset="utf-8"><script>(function(){var c='system';try{c=localStorage.getItem('cb-theme')||'system'}catch(e){}if(c!=='light'&&c!=='dark')c='system';var r=document.documentElement,m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');r.dataset.themeChoice=c;r.dataset.theme=(c==='dark'||(c==='system'&&m&&m.matches))?'dark':'light'})()</script><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tested milestones</title>
<link rel="stylesheet" href="$PREFIX/ui.css"><link rel="icon" href="$PREFIX/img/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="$PREFIX/img/app-icon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="$PREFIX/img/app-icon-16.png"><link rel="icon" type="image/png" sizes="512x512" href="$PREFIX/img/app-icon-512.png"><link rel="apple-touch-icon" sizes="180x180" href="$PREFIX/img/app-icon-180.png"><body>
<div class="netbar test"><b>TEST MONEY ONLY</b> · Test network: TAZ has no value.</div>
<main class="page"><div class="crumb"><a href="$PREFIX/">Test money</a> / Tested milestones</div><h1 class="t-h1">Tested milestones</h1>
<p class="t-lead">Thirteen finished test campaigns. Each recount runs in your browser, reads the public test-network chain servers, and takes up to a minute. The two "relays" are two copies of the same files on this server.</p>
<ul id="list" class="steps"></ul><p class="muted">Nothing here is real money.</p></main>
<script src="$PREFIX/loadguard.js"></script>
<script src="$PREFIX/proofs/examples.js"></script>
<script type="module" src="$PREFIX/theme-mount.js"></script></body></html>
HTML
cat > "$OUT/proofs/examples.js" <<'JS'
document.documentElement.dataset.started = "1"; document.documentElement.dataset.ready = "1";
const items = [
  ['Uniform-price auction, finished (expect: all 13 checks pass)', '5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb'],
  ['Fundraiser, closed and refunded (expect: 9 of 9 pass)', '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f'],
  ['Fundraiser with 40 contributions (expect: 9 of 9 pass)', '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da'],
  ['Fundraiser with a name chosen by its host, closed and refunded (expect: 9 of 9 pass)', 'f6737fbc462e75508d424f0612a1ce5ea3df24c5cc1b550074821ccdea5e237a'],
  ['Failing fixture: winners settled after the deadline (expect: R9 fails)', '32ea71afc470d77909a1b7b4a1fdaba36f0612df3a973df0ce1410c5ca16467a'],
  ['Uniform price auction, 6 bids for 3 items: two bids above the price get their excess back, a tie at the price goes to the bid earlier in the chain, one bid was taken back, one was too low (expect: all 13 checks pass)', 'f8b2bc9f0b9e17666b8b87dd0eeb0b19a17ab8e95d154d63ff1b8d2849980501'],
  ['Caught: the host spent two contributions itself, one before the deadline and one after (expect: R5 and R6 fail, each naming the spending transaction)', '3c34b9ff18656a9fad2e81ea91e803320917eced570ba5f69dde1a10dbba4004'],
  ['Late host: the same auction run with the host offline for a while, so one ticket came one block late (expect: R4b, the ticket timing the host reports, fails; everything else passes)', '65f3dd513ee88895804f2135a947ee9ac2e1b5d85b405e3d10c10168324b7ac6'],
  ['Odd payments: 19 hand made payments, from a wrong campaign or an address that cannot be paid to a missing message; the host rejects or ignores each, nothing blocks the close (expect: all 9 checks pass)', '80fc0eb3081ac58d91ac95fec1fe92286c49d000d5bdd24befe5c53153ed025d'],
  ['Closed early: a fundraiser whose rules allow it, closed once its goal was met, 196 blocks before the deadline; a payment after the close does not count (expect: all 9 checks pass)', 'd119ba4b6b032cacf5d5838eef8aa9ec5903a224b9c6d9f6cca9362f70d49671'],
  ['Caught: a host that closed early although the rules do not allow it (expect: R2 and R5 fail)', '36a5178294cc8643929b654ea4f25df1dad7145527a311848dd5f526430d5897'],
  ['Hard cap: a fundraiser with a soft cap of 0.002 and a hard cap of 0.004 TAZ; three payments of 0.0015, the third did not fit and was refunded whole by its own ticket (expect: all 9 checks pass)', '0e87fe135cb3dd2486efa0809534718bf62ebd3df733d903008550c4c202aef5'],
  ['Caught: a host that kept a payment over the hard cap instead of refunding it (expect: R6 fails)', 'bc66ccca21ec5a3059e03326ec7abbf54fa55c45102a6037cf27f600273addb1'],
];
// the demo folder is the one that holds proofs/ (at the site's root on a plain static host, under /demo/ on the page server)
const base = `${location.origin}${location.pathname.replace(/proofs(\/(index\.html)?)?$/, '')}`;
const q = (id) => `c=${id}&relay=${base}relays/a&relay=${base}relays/b`;
const ul = document.getElementById('list');
for (const [t, id] of items) {
  const li = document.createElement('li'), d = document.createElement('div');
  d.append(t + ' ');
  for (const [name, page] of [['recount', 'recount'], ['campaign', 'campaign'], ['capability card', 'card']]) { const a = document.createElement('a'); a.href = `${base}${page}.html#${q(id)}`; a.textContent = name; d.append(a, ' · '); }
  li.append(d); ul.append(li);
}
JS
echo "static folder ready: $OUT ($(du -sh "$OUT" | cut -f1)); serve it with any static host, for example: python3 -m http.server --directory $OUT 8800"
