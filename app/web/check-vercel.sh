#!/usr/bin/env bash
# Checks the folder that will be uploaded (default runs/vercel-site; build it with app/web/make-vercel.sh): its contents (names, ids, keys, local
# paths), its vercel.json headers (served through serve-vercel.cjs on a spare port), and no analytics or tracking. Nothing is deployed.
# From the repository root. Exit status 1 if any check fails.
set -uo pipefail
DIR=${1:-runs/vercel-site}; PORT=${PORT:-8805}
failed=0; check() { if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1  $3"; failed=$((failed+1)); fi; }
[ -f "$DIR/vercel.json" ] || { echo "no vercel.json in $DIR: run app/web/make-vercel.sh first"; exit 2; }
python3 -c "import json;json.load(open('$DIR/vercel.json'))"; check "vercel.json is valid JSON" $? ""
[ -f "$DIR/.vercelignore" ] && grep -qx '.env' "$DIR/.vercelignore" && grep -qx '.env.\*' "$DIR/.vercelignore"; check ".vercelignore exists and keeps .env and every .env.* file out of the upload" $? ""
OUT=$(app/audit.sh --folder "$DIR" 2>&1); RC=$?; check "audit of the upload folder (names, ids, keys, wallets, local paths)" $RC "$OUT"
# the audit must catch what it is for: plant things in a copy (an id from the private list)
PLANT=$(sed -n -E 's/^ids: *//p' .local/forbidden-names.txt | head -1); [ -n "$PLANT" ] || PLANT=$(sed -n -E 's/^names: *//p' .local/forbidden-names.txt | head -1 | tr -d '\\b')
T=$(mktemp -d); cp -r "$DIR" "$T/copy"; echo "$PLANT" > "$T/copy/note.txt"; touch "$T/copy/x.age"; mkdir "$T/copy/private"; echo "/home/someone/x" > "$T/copy/p.txt"
app/audit.sh --folder "$T/copy" > "$T/out" 2>&1; PL=$?; rm -rf "$T"
[ $PL = 1 ]; check "self-test: the audit catches a planted id, key file, private folder and local path" $? "exit $PL"
# the product name the pages show is the current one (the old names are caught by the audit above)
grep -q "PRODUCT_NAME = 'Clewbook'" "$DIR/demo/brand.js"; check "the pages carry the product name Clewbook (brand.js)" $? ""
grep -q "Powered by" "$DIR/demo/badge.html"; check "the badge says \"Powered by\" the product name" $? ""
# no analytics, trackers, or third-party scripts and styles in the pages
if grep -r -l -a -i -E 'vercel-insights|/_vercel/(insights|speed-insights)|vercel\.live|googletagmanager|google-analytics|gtag\(|plausible\.io|matomo|segment\.(io|com)|hotjar|mixpanel|facebook\.net|doubleclick' "$DIR" --include='*.html' --include='*.js' --include='*.css' --include='*.json' | grep -q .; then check "no analytics or tracking in the pages and scripts" 1 "found"; else check "no analytics or tracking in the pages and scripts" 0 ""; fi
EXT=$(grep -r -h -o -a -E '(<script[^>]*src|<link[^>]*href|<img[^>]*src|<iframe[^>]*src)="https?://[^"]+"' "$DIR" --include='*.html' | sort -u | grep -v -E 'zec\.rocks|chainsafe' || true)  # what a page LOADS; a plain link to another site is not a load
[ -z "$EXT" ]; check "the pages load nothing from any other site (no external script, style, font or image)" $? "$EXT"
# headers, through the local server
node app/web/serve-vercel.cjs "$DIR" $PORT > /dev/null 2>&1 & SRV=$!
for i in $(seq 1 20); do curl -s -o /dev/null http://127.0.0.1:$PORT/robots.txt && break; sleep 0.3; done
h() { curl -s -D - -o /dev/null "http://127.0.0.1:$PORT$1" | tr -d '\r'; }
H=$(h /demo/pkg/ll_web_bg.wasm); echo "$H" | grep -qi '^content-type: application/wasm'; check "the browser module is served as application/wasm" $? "$H"
H=$(h /demo/proof/ll_proofcheck_bg.wasm); echo "$H" | grep -qi '^content-type: application/wasm'; check "the proof module is served as application/wasm" $? "$H"
H=$(h /demo/recount.html); echo "$H" | grep -qi '^x-content-type-options: nosniff'; check "pages carry nosniff" $? "$H"
echo "$H" | grep -qi '^referrer-policy: no-referrer'; check "pages carry referrer-policy no-referrer" $? "$H"
echo "$H" | grep -qi "^content-security-policy: default-src 'self'"; check "pages carry a content security policy (own files only; any relay or chain server may be asked)" $? "$H"
echo "$H" | grep -qi '^set-cookie'; [ $? = 1 ]; check "no cookie is set" $? "$H"
echo "$H" | grep -i '^content-security-policy:' | grep -q "frame-ancestors 'self'"; check "an ordinary page may not be shown inside another site's page (frame-ancestors 'self')" $? "$H"
echo "$H" | grep -i '^content-security-policy:' | sed 's/.*script-src//; s/;.*//' | grep -q "unsafe-inline"; [ $? = 1 ]; check "pages allow no inline script (no 'unsafe-inline' for scripts)" $? "$H"
H=$(h /demo/badge.html); echo "$H" | grep -i '^content-security-policy:' | grep -q "frame-ancestors \*"; check "the badge, made to be embedded, may be shown inside any site's page" $? "$H"
# the one inline script allowed is the small theme script at the top of each page (it sets the theme before the page is drawn): the same
# script on every page, and the served policy allows exactly it by its hash (no other inline script would run)
INL=$(python3 - "$DIR" <<'PY'
import sys, re, glob, hashlib, base64
bodies = set()
for f in glob.glob(sys.argv[1] + '/demo/*.html') + glob.glob(sys.argv[1] + '/demo/proofs/*.html'):
    for attrs, body in re.findall(r'<script([^>]*)>(.*?)</script>', open(f).read(), re.S):
        if 'src=' not in attrs: bodies.add(body)
if len(bodies) == 1 and next(iter(bodies)).startswith("(function(){var c='system';try{c=localStorage.getItem('cb-theme')"):
    print("'sha256-" + base64.b64encode(hashlib.sha256(next(iter(bodies)).encode()).digest()).decode() + "'")
else: print('other', len(bodies))
PY
)
case "$INL" in "'sha256-"*) for pg in /demo/recount.html /demo/badge.html; do h $pg | grep -i '^content-security-policy:' | grep -qF "$INL" || INL="not allowed on $pg: $INL"; done ;; esac
case "$INL" in "'sha256-"*) R=0 ;; *) R=1 ;; esac; check "the only inline script on any page is the theme script, and the served policy allows exactly it by its hash" $R "$INL"
ATTR=$(grep -l -E ' on[a-z]+="' "$DIR"/demo/*.html "$DIR"/demo/proofs/*.html || true); [ -z "$ATTR" ]; check "no page has an inline event handler" $? "$ATTR"
H=$(h /demo/fonts/$(ls "$DIR/demo/fonts" | head -1)); echo "$H" | grep -qi '^cache-control: public, max-age=31536000, immutable'; check "fonts are cached for a long time" $? "$H"
R=$(find "$DIR/demo/relays/a" -name ledger | head -1 | sed "s|$DIR||"); H=$(h "$R"); echo "$H" | grep -qi '^access-control-allow-origin: \*'; check "the example relay files can be read from other pages (CORS)" $? "$H"
# the bare address leads to the main site; everything that answered before still answers (at its old path, or through a redirect to its place under /demo)
H=$(h /); echo "$H" | head -1 | grep -qE ' 30[78] '; R1=$?; echo "$H" | grep -qi '^location: https://app.clewbook.xyz/$'; check "the bare address redirects to https://app.clewbook.xyz/ (and nothing else does)" $((R1 + $?)) "$H"
# a short campaign link on this address goes to the same short link on the main site, where the listing and the campaigns are
H=$(h /c/5f40200a); echo "$H" | head -1 | grep -qE ' 30[78] '; R1=$?; echo "$H" | grep -qi '^location: https://app.clewbook.xyz/c/5f40200a$'; check "a short campaign link /c/<id> goes on to https://app.clewbook.xyz/c/<id>" $((R1 + $?)) "$H"
OTHER=$(for p in /index.html /recount.html /ui.css /pkg/ll_web.js /relays/a /demo/ /demo/proofs /demo/proofs/; do c=$(curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:$PORT$p"); echo "$c"; done | grep -c 'app.clewbook.xyz' || true); [ "$OTHER" = 0 ]; check "no other path redirects to the main site" $? "$OTHER"
for p in /demo/ /demo/proofs /demo/proofs/ /demo/recount.html /demo/campaign.html /demo/card.html /demo/contribute.html /demo/badge.html /robots.txt; do c=$(curl -s -L -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p"); [ "$c" = 200 ]; check "answers: $p" $? "$c"; done
if [ -f app/web/vercel-old-paths.txt ]; then
  BAD=$(while read -r f; do c=$(curl -s -L -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/$f"); [ "$c" = 200 ] || echo "$c /$f"; done < app/web/vercel-old-paths.txt | head -5)
  [ -z "$BAD" ]; check "every path the hosted copy answered before ($(wc -l < app/web/vercel-old-paths.txt) files) still answers, at the same place or by redirect to /demo" $? "$BAD"
fi
PROOFS=$(grep -c 'proofs' "$DIR/demo/proofs/index.html"); [ -f "$DIR/demo/proofs/examples.js" ] && [ "$(sed '/const SEALED/,$d' "$DIR/demo/proofs/examples.js" | grep -c "'[0-9a-f]\{64\}'")" = 13 ]; check "the tested milestones page lists all eleven finished test campaigns" $? ""
# the sealed bid auctions: their own list after the thirteen, and their tab
NS=$(sed -n '/const SEALED/,/^];/p' "$DIR/demo/proofs/examples.js" | grep -c "'[0-9a-f]\{64\}'"); [ "$NS" = 4 ] && grep -q 'id="seg-sealed"' "$DIR/demo/proofs/index.html"; check "the Blind bids tab lists the four sealed bid auction proofs" $? "$NS"
kill $SRV 2>/dev/null
[ $failed = 0 ] && echo "ALL PASS" || echo "$failed FAILED"; exit $failed
