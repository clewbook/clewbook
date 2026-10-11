#!/usr/bin/env bash
# Assembles a folder that any static HTTPS web host can serve: the recount page and the pages that only read (campaign, capability card, badge,
# contribute for looking at a campaign), the built browser module, the fonts, and the example campaigns as files standing in for two relays.
# No relay program and no page server program is needed. Nothing is deployed. From the repository root; needs app/web/www/pkg and proof built.
# Usage: app/web/make-static.sh [output folder]   (default runs/static-demo)
set -euo pipefail
OUT=${1:-runs/static-demo}
PREFIX=${PREFIX:-}   # where the folder is served from, for the absolute links of its start page (the hosted copy serves it under /demo)
WWW=${WWW:-app/web/www}   # WWW=runs/site-next builds the demo from the next version of the pages
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
<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo</title>
<link rel="stylesheet" href="$PREFIX/ui.css"><link rel="icon" href="$PREFIX/img/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="$PREFIX/img/app-icon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="$PREFIX/img/app-icon-16.png"><link rel="icon" type="image/png" sizes="512x512" href="$PREFIX/img/app-icon-512.png"><link rel="apple-touch-icon" sizes="180x180" href="$PREFIX/img/app-icon-180.png"><body>
<div class="netbar test"><b>TEST MONEY ONLY</b> · Test network: TAZ has no value.</div>
<header class="bar"><a class="word" href="https://app.clewbook.xyz/"><img class="logo" src="$PREFIX/img/clewbook-lockup-colour.svg" alt="Clewbook" width="180" height="28"></a><nav class="nav" aria-label="Main"><a href="$PREFIX/" aria-current="page">Test money</a><a href="$PREFIX/proofs/">Proofs</a><a href="$PREFIX/recount.html">Recount</a></nav></header>
<main class="page"><h1 class="t-h1">Try it with test money</h1>
<p class="t-lead">Everything here uses the Zcash test network: its coins have no value, and no real money is involved. The campaigns below are finished and kept as plain files, so you can recount them yourself in your browser without anyone's server.</p>
<section class="sect"><div class="hd"><h2>Tested milestones</h2></div><p class="muted">Five finished test campaigns, each ready to recount: a fundraiser, an auction, one with a name, and one that is meant to fail so you can see what a failure looks like.</p>
<p style="margin-top:var(--s3)"><a class="btn" href="$PREFIX/proofs/">Open the tested milestones</a></p></section>
<section class="sect"><div class="hd"><h2>Check a saved copy</h2></div><p class="muted">Have a saved copy of a campaign's list? Load it on the recount page.</p>
<p style="margin-top:var(--s3)"><a class="btn sec" href="$PREFIX/recount.html">Open the recount page</a></p></section>
<section class="sect"><div class="hd"><h2>The real thing</h2></div><p class="muted">Real campaigns, with real ZEC, are on the main site.</p>
<p style="margin-top:var(--s3)"><a class="btn sec" href="https://app.clewbook.xyz/">Go to the main site</a></p></section>
</main>
<script src="$PREFIX/loadguard.js"></script>
<script src="$PREFIX/demo.js"></script></body></html>
HTML
cat > "$OUT/demo.js" <<'JS'
document.documentElement.dataset.started = "1"; document.documentElement.dataset.ready = "1";
for (const el of document.querySelectorAll('[data-brand]')) el.textContent = 'Clewbook';
JS
cat > "$OUT/proofs/index.html" <<HTML
<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tested milestones</title>
<link rel="stylesheet" href="$PREFIX/ui.css"><link rel="icon" href="$PREFIX/img/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="$PREFIX/img/app-icon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="$PREFIX/img/app-icon-16.png"><link rel="icon" type="image/png" sizes="512x512" href="$PREFIX/img/app-icon-512.png"><link rel="apple-touch-icon" sizes="180x180" href="$PREFIX/img/app-icon-180.png"><body>
<div class="netbar test"><b>TEST MONEY ONLY</b> · Test network: TAZ has no value.</div>
<main class="page"><div class="crumb"><a href="$PREFIX/">Test money</a> / Tested milestones</div><h1 class="t-h1">Tested milestones</h1>
<p class="t-lead">Five finished test campaigns. Each recount runs in your browser, reads the public test-network chain servers, and takes up to a minute. The two "relays" are two copies of the same files on this server.</p>
<ul id="list" class="steps"></ul><p class="muted">Nothing here is real money.</p></main>
<script src="$PREFIX/loadguard.js"></script>
<script src="$PREFIX/proofs/examples.js"></script></body></html>
HTML
cat > "$OUT/proofs/examples.js" <<'JS'
document.documentElement.dataset.started = "1"; document.documentElement.dataset.ready = "1";
const items = [
  ['Uniform-price auction, finished (expect: all 12 checks pass)', '5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb'],
  ['Fundraiser, closed and refunded (expect: 8 of 8 pass)', '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f'],
  ['Fundraiser with 40 contributions (expect: 8 of 8 pass)', '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da'],
  ['Fundraiser with a name chosen by its host, closed and refunded (expect: 8 of 8 pass)', 'f6737fbc462e75508d424f0612a1ce5ea3df24c5cc1b550074821ccdea5e237a'],
  ['Failing fixture: winners settled after the deadline (expect: R9 fails)', '32ea71afc470d77909a1b7b4a1fdaba36f0612df3a973df0ce1410c5ca16467a'],
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
