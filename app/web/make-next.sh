#!/usr/bin/env bash
# Builds the next version of the site into one folder (default runs/site-next) WITHOUT touching app/web/www: a copy of www, with the files in app/web/next/
# laid over it, and the list of campaigns (campaigns.json, kept by hand and never committed: it holds real campaign numbers) if there is one.
# Serve it on a spare port:  SERVE_ROOT=runs/site-next python3 app/web/serve.py 8776 127.0.0.1
# Usage: app/web/make-next.sh [folder] [campaigns file]      (campaigns file default: runs/campaigns.json, then campaigns.example.json)
set -euo pipefail
OUT=${1:-runs/site-next}; LIST=${2:-runs/campaigns.json}
[ -f app/web/www/pkg/ll_web_bg.wasm ] || { echo "make-next.sh: build the browser module first (app/web/build.sh)" >&2; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"
cp -r app/web/www/. "$OUT/"
rm -rf "$OUT/bundles" "$OUT/current.json" "$OUT/node-check.mjs"
cp -r app/web/next/. "$OUT/"
[ -f "$LIST" ] && cp "$LIST" "$OUT/campaigns.json" || cp app/web/next/campaigns.example.json "$OUT/campaigns.json"
rm -f "$OUT/campaigns.example.json"
echo "site folder ready: $OUT ($(find "$OUT" -type f | wc -l) files); campaigns: $([ -f "$LIST" ] && echo "$LIST" || echo "the empty example")"
