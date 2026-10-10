#!/usr/bin/env bash
# Changes the public product name and the names of the four command-line programs. Repeatable: running it again changes nothing more.
#   app/rename-product.sh            a DRY RUN: lists every change it would make, writes nothing
#   app/rename-product.sh --apply    makes the changes
# What it changes (the old name comes from OLD_NAME or the private list, so it is not written here):
#   * the product name in every public text file (README, NOTICE, licences, public documents, the brand constant the pages read) and in the operating
#     documents and run.sh;
#   * the program names ll-host, ll-relay, ll-contrib, ll-recount to cb-host, cb-relay, cb-contrib, cb-recount in documents, run.sh and the text the
#     pages show (the old names keep working: each program is built under both names, see the [[bin]] entries in app/*/Cargo.toml).
# What it never touches: anything cryptographic or part of a wire or file format (domain-separation strings such as the "ledgerlab_..." prefixes, the
# memo prefix, the JSON "kind" names, the browser storage keys), the Cargo package and library names (ll-core, ll-host as a package, ll_web...), the
# vendored wallet tool in src/, and the internal planning documents (they are never published). See docs/DESIGN_NOTES.md, section 7, for the list.
set -uo pipefail
cd "$(dirname "$0")/.."
# the old name is not written in this file: it comes from OLD_NAME, or from the first "oldnames:" line of the private list (.local/forbidden-names.txt)
NEW=${NEW_NAME:-Clewbook}
OLD=${OLD_NAME:-$(sed -n -E 's/^oldnames: *//p' "${FORBIDDEN_NAMES_FILE:-.local/forbidden-names.txt}" 2>/dev/null | head -1)}
[ -n "$OLD" ] || { echo "no old name given: set OLD_NAME or add an 'oldnames:' line to the private list"; exit 2; }
APPLY=0; [ "${1:-}" = --apply ] && APPLY=1
# files whose text a reader sees
NAME_FILES="README.md NOTICE LICENSE-MIT SPEC.md docs/THREAT_MODEL.md docs/DEMO_SCRIPT.md docs/EVIDENCE.md docs/FINDINGS.md app/web/www/brand.js"
# files that name the programs
CMD_FILES="README.md SPEC.md run.sh docs/THREAT_MODEL.md docs/DEMO_SCRIPT.md docs/EVIDENCE.md docs/FINDINGS.md docs/RUNNING.md docs/STABLE_ADDRESS.md docs/DEPLOY_VERCEL.md docs/PILOT_CHECKLIST.md app/web/www/setup.js app/web/www/dashboard.js app/web/www/index.html app/host/src/dashboard.rs app/host/src/main.rs"
changed=0
# programs: ll-<name> -> cb-<name>, but not a Cargo package selection (-p ll-host), a path into a build folder of another tool, or a library name
CMD_RE='(?<![\w.-])(?<!-p )(?<!--package )ll-(host|relay|contrib|recount)(?![\w-])'   # used inside m{...} below
show() { printf '%-34s %s\n' "$1" "$2"; changed=$((changed+1)); }
for f in $NAME_FILES; do
  [ -f "$f" ] || continue
  n=$(grep -c "$OLD" "$f" || true)
  if [ "$n" -gt 0 ]; then show "$f" "$n line(s): old name -> $NEW"; [ $APPLY = 1 ] && sed -i "s/$OLD/$NEW/g" "$f"; fi
done
for f in $CMD_FILES; do
  [ -f "$f" ] || continue
  n=$(RE="$CMD_RE" perl -ne 'BEGIN{$c=0; $re=qr{$ENV{RE}}} $c++ if m{$re}; END{print $c}' "$f")
  if [ "$n" -gt 0 ]; then show "$f" "$n line(s): program names ll-* -> cb-*"; [ $APPLY = 1 ] && RE="$CMD_RE" perl -pi -e 'BEGIN{$re=qr{$ENV{RE}}} s{$re}{cb-$1}g' "$f"; fi
done
# the badge says who made it
if ! grep -q "Powered by" app/web/www/badge.html; then
  show app/web/www/badge.html 'brand line reads "Powered by <name>"'
  [ $APPLY = 1 ] && sed -i 's#<span class="brand" data-brand></span>#<span class="brand">Powered by <span data-brand></span></span>#' app/web/www/badge.html
fi
if [ $APPLY = 1 ]; then echo "applied: $changed file change(s)"; else echo "DRY RUN: $changed file change(s) would be made. Run with --apply to make them."; fi
