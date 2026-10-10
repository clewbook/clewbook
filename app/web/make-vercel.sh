#!/usr/bin/env bash
# Builds the folder to upload to Vercel: the static demo (app/web/make-static.sh) under demo/, plus vercel.json (which redirects the bare address to the main site
# and keeps every older path answering). Nothing is deployed and
# nothing is uploaded. From the repository root; needs the built browser modules (app/web/build.sh).
# Usage: app/web/make-vercel.sh [folder]   (default runs/vercel-site). Then: app/web/check-vercel.sh [folder]
set -euo pipefail
OUT=${1:-runs/vercel-site}
# the folder may be linked to a Vercel project (.vercel, made by "vercel link"; .env.local, made by "vercel env pull"): keep that link across rebuilds
KEEP=$(mktemp -d); for f in .vercel .env.local .gitignore; do [ -e "$OUT/$f" ] && cp -a "$OUT/$f" "$KEEP/"; done
# the static demo goes under /demo (its start page and, under /demo/proofs, the five finished test campaigns); the bare address redirects to the main site
mkdir -p "$OUT"; PREFIX=/demo bash app/web/make-static.sh "$OUT/demo" >/dev/null
find "$OUT" -mindepth 1 -maxdepth 1 -not -name demo -not -name .vercel -not -name .env.local -not -name .gitignore -exec rm -rf {} +
for f in .vercel .env.local .gitignore; do [ -e "$KEEP/$f" ] && cp -a "$KEEP/$f" "$OUT/"; done; rm -rf "$KEEP"
cp app/web/vercel.json "$OUT/vercel.json"
# nothing that holds settings or secrets is uploaded: environment files (.env, .env.local, .env.production ...) are listed here, and check-vercel.sh fails without this file
printf '.env\n.env.*\n*.env\n' > "$OUT/.vercelignore"
printf 'User-agent: *\nAllow: /\n' > "$OUT/robots.txt"
echo "upload folder ready: $OUT ($(find "$OUT" -type f | wc -l) files, $(du -sh "$OUT" | cut -f1))"
