#!/usr/bin/env bash
# Pre-push audit. Usage: app/audit.sh [<range>]   (default: what is not yet pushed). Exit status 1 if anything is found.
# 1. data files and secrets in added lines; 2. project, contest, personal and tool names in commit messages and in added lines outside docs/;
# 3. the public documents must also be free of those and of the generic words in the list (the word "Zcash" is fine).
# The words to look for are in an untracked local file (default .local/forbidden-names.txt, or FORBIDDEN_NAMES_FILE), so that this script does not
# carry them. Without that file the audit stops: it must never pass because it had nothing to look for.
set -uo pipefail
# app/audit.sh --folder <dir>: the same look at a folder that will be uploaded (every file, the built modules too): forbidden names and ids,
# secrets, key and wallet files, and local folder paths. Exit status 1 if anything is found.
if [ "${1:-}" = "--folder" ]; then
  DIR=${2:?usage: app/audit.sh --folder <dir>}; [ -d "$DIR" ] || { echo "AUDIT ERROR: no folder $DIR"; exit 2; }
  LIST=${FORBIDDEN_NAMES_FILE:-.local/forbidden-names.txt}
  [ -s "$LIST" ] || { echo "AUDIT ERROR: the list of forbidden names is missing or empty: $LIST"; exit 2; }
  PAT=$(sed -n -E 's/^(project|names|ids|internal): *//p' "$LIST" | grep -v '^$' | paste -sd'|' -)   # not the generic words: they would match by chance in binary files
  [ -n "$PAT" ] || { echo "AUDIT ERROR: $LIST has no patterns"; exit 2; }
  n=$(find "$DIR" -type f | wc -l); echo "files in folder: $n"
  REPORT=$(mktemp)
  find "$DIR" -type f | sed "s|^$DIR/||" | grep -E '\.age$|\.seed$|\.sqlite$|\.log$|\.env$|\.pem$|(^|/)(private|secrets|wallet[0-9]*|runs|node_modules|\.git|\.local)(/|$)|backup\.json|secrets\.json' | sed 's|^|FORBIDDEN FILE: |' >> "$REPORT"
  # names and ids, case-insensitive, in every file (binary files as text); a file name may carry one too
  grep -r -a -l -i -E "$PAT" "$DIR" | sed 's|^|NAME OR ID IN FILE: |' >> "$REPORT"   # tool names and local paths of this computer are in the list too
  ALLOW=$(sed -n -E 's/^allow: *//p' "$LIST" | paste -sd'|' -)
  for cat in oldnames others; do
    P=$(sed -n -E "s/^$cat: *//p" "$LIST" | paste -sd'|' -); [ -n "$P" ] || continue
    grep -r -a -n -H -E "$P" "$DIR" 2>/dev/null | { [ -n "$ALLOW" ] && grep -v -E "$ALLOW" || cat; } | cut -c1-160 | sed "s|^|FORBIDDEN NAME ($cat): |" >> "$REPORT"
  done
  find "$DIR" | grep -i -E "$PAT" | sed 's|^|NAME OR ID IN FILE NAME: |' >> "$REPORT"
  grep -r -a -l -i -E 'seed phrase|mnemonic|BEGIN (RSA|OPENSSH|PRIVATE)|AGE-SECRET-KEY|ghp_|AKIA|uview1[a-z0-9]{40}|uviewtest1[a-z0-9]{40}|uvitest1[a-z0-9]{40}' "$DIR" | sed 's|^|SECRET-LIKE: |' >> "$REPORT"
  grep -r -a -l -E 'eph_sk|"seed"' --exclude='*.wasm' "$DIR" | sed 's|^|SECRET-LIKE FIELD: |' >> "$REPORT"
  grep -r -a -l -E '/home/|/Users/|C:\\Users|runs/(mainnet|pilot|static|polish)' "$DIR" | sed 's|^|LOCAL PATH: |' >> "$REPORT"
  if [ -s "$REPORT" ]; then cat "$REPORT"; rm -f "$REPORT"; echo "AUDIT FOUND PROBLEMS"; exit 1; fi
  rm -f "$REPORT"; echo "audit clean (folder $DIR)"; exit 0
fi
RANGE=${1:-}
[ -z "$RANGE" ] && RANGE='@{u}..HEAD'
git rev-parse "${RANGE%%..*}" >/dev/null 2>&1 || { echo "AUDIT ERROR: bad range $RANGE"; exit 2; }
LIST=${FORBIDDEN_NAMES_FILE:-.local/forbidden-names.txt}
[ -s "$LIST" ] || { echo "AUDIT ERROR: the list of forbidden names is missing or empty: $LIST. Create it (one 'category: regex' per line; categories project, names, words, internal; see the comment at the top of app/audit.sh) or set FORBIDDEN_NAMES_FILE."; exit 2; }
list() { sed -n -E "s/^($1): *//p" "$LIST" | grep -v '^$' | paste -sd'|' -; }   # the regular expressions of these categories, joined
PAT_CODE=$(list 'project|names|ids'); PAT_DOCS=$(list 'project|names|words|ids')
[ -n "$PAT_CODE" ] && [ -n "$PAT_DOCS" ] || { echo "AUDIT ERROR: $LIST has no 'project:' or 'names:' lines"; exit 2; }

# ---- names that must not be in public files or an upload folder (whole tree, case sensitive; the lists are in the private file) ----
cats() { sed -n -E "s/^($1): *//p" "$LIST" | grep -v '^$'; }
ALLOW=$(cats allow | paste -sd'|' -)
# $1: category; files on stdin (one per line); prints "path:line:text" for every hit that the allow list does not excuse
scan_cat() {
  local pat; pat=$(cats "$1" | paste -sd'|' -); [ -n "$pat" ] || return 0
  tr '\n' '\0' | xargs -0 -r grep -a -n -H -E "$pat" 2>/dev/null | if [ -n "$ALLOW" ]; then grep -v -E "$ALLOW"; else cat; fi
}
REPORT=$(mktemp)
flag() { sed "s|^|$1: |" >> "$REPORT"; }   # reads lines on stdin, tags them, records them
files=$(git diff --name-only "$RANGE")
echo "files in range: $(echo "$files" | grep -c .)"
# what a push would really send: every object in the commits, not just the net change (a file added and later removed is still sent)
bytes=$(git rev-list --objects "$RANGE" | cut -d' ' -f1 | git cat-file --batch-check='%(objectsize)' | awk '{s+=$1} END {print s+0}')
echo "objects a push would send: $((bytes / 1048576)) MB"
[ "$bytes" -gt 20971520 ] && echo "over 20 MB would be pushed ($((bytes / 1048576)) MB): build output or data files hidden in the history of these commits?" | flag "SIZE"
echo "$files" | grep -E '(^|/)target(-[a-z]+)?/|\.rlib$|\.rmeta$|\.so$|\.dylib$' | head -3 | flag "BUILD OUTPUT"
echo "$files" | wc -l | awk '$1 > 400 {print "MORE THAN 400 FILES IN ONE PUSH (" $1 "): is build output included?"}' | flag "SIZE"
big=$(git diff --stat=200 "$RANGE" | grep -cE '\| +[0-9]{6,} ') ; [ "${big:-0}" -gt 0 ] && echo "$big file(s) with over 100000 changed lines" | flag "SIZE"
echo "$files" | grep -E '\.age$|\.seed$|wallet[0-9]*/|/data\.sqlite|^runs/|backup\.json' | flag "FORBIDDEN FILE"
git diff "$RANGE" -- . ':!app/audit.sh' ':!examples' | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -n -i -E 'seed phrase|mnemonic|BEGIN (RSA|OPENSSH|PRIVATE)|AGE-SECRET-KEY|ghp_|AKIA|uview1[a-z0-9]{40}|uviewtest1[a-z0-9]{40}|uvftest1[a-z0-9]{40}|uvitest1[a-z0-9]{40}' | head -3 | flag "SECRET-LIKE"
# examples/ holds public relay data, where a campaign's own full viewing key (uvftest1...) is public by design; anything else key-like is still refused there
git diff "$RANGE" -- examples | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -n -i -E 'seed phrase|mnemonic|BEGIN (RSA|OPENSSH|PRIVATE)|AGE-SECRET-KEY|ghp_|AKIA|uview1[a-z0-9]{40}|uviewtest1[a-z0-9]{40}|uvitest1[a-z0-9]{40}|"seed"|eph_sk' | head -3 | flag "SECRET-LIKE (examples)"
git log "$RANGE" --format=%B | grep -n -i -E "$PAT_CODE" | head -3 | flag "COMMIT MESSAGE"
git diff "$RANGE" -- . ':!docs' ':!NOTES.md' ':!app/audit.sh' ':!README.md' ':!SPEC.md' | grep -E '^\+' | grep -vE '^\+\+\+' | grep -n -i -E "$PAT_CODE" | head -3 | flag "NAME IN CODE/TEXT"
# the documents meant to be published (the internal working documents are not checked here)
for f in README.md SPEC.md docs/THREAT_MODEL.md docs/DEMO_SCRIPT.md docs/EVIDENCE.md docs/FINDINGS.md; do
  [ -f "$f" ] && grep -n -i -E "$PAT_DOCS" "$f" | head -3 | flag "PUBLIC DOC $f"
done
# every tracked file, and every new file that is not ignored (it would be tracked by the next commit), this script and the internal documents
# included: no forbidden string may be in any of them (the strings live only in the private list). Names, project names and ids in any case;
# old and other names and phrases case sensitive, minus what the allow list excuses. The "words" (public documents) and "internal" (privacy test)
# categories have narrower uses and are checked where they apply.
TRACKED=$( { git ls-files; git ls-files --others --exclude-standard; } | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done)
PAT_ALL=$(list 'project|names|ids')
echo "$TRACKED" | tr '\n' '\0' | xargs -0 -r grep -a -n -H -i -E "$PAT_ALL" 2>/dev/null | cut -d: -f1,2 | head -8 | flag "FORBIDDEN STRING IN A TRACKED FILE (name, project or id)"
for cat in oldnames others phrases; do
  echo "$TRACKED" | scan_cat $cat | cut -d: -f1,2 | head -8 | sed "s|^|FORBIDDEN STRING IN A TRACKED FILE ($cat): |" >> "$REPORT"
done
if [ -s "$REPORT" ]; then cat "$REPORT"; rm -f "$REPORT"; echo "AUDIT FOUND PROBLEMS"; exit 1; fi
rm -f "$REPORT"; echo "audit clean"
