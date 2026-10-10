# Publishing the history: a plan (internal; do not publish this file; nothing here has been run)

Goal: a new public repository whose history has a neutral author, no tool trailers, no internal notes, and no personal strings, and whose final
files are the current ones. The working repository is never touched, and `nu7-libs-local-backup` (285 MB of build output) is never pushed.

Today's facts (scan of `nu7-libs`, 2026-10-08): 596 commits, of which 127 are ours (one author identity, which is also the committer) and the rest
are upstream's; 46 of ours carry a tool co-author trailer; `NOTES.md` was tracked in about 30 early commits (12 commits touch nothing else); the
name list in `app/audit.sh` and `app/privacy-e2e.cjs` is in history and in the current files. No keys, seeds, wallet files or large blobs.

## Before anything
- Tool: `git-filter-repo` is **not installed** here (and `pip` is missing). Install it on the machine that runs the plan: `sudo apt install git-filter-repo`,
  or save the single script from the git-filter-repo project's release page somewhere on `PATH` as `git-filter-repo` and mark it executable (check the
  checksum against the project's page). Confirm with `git filter-repo --version`.
- Work on a disk with space (not `/tmp`, a small memory disk here). Use an empty folder, call it `$W`.
- Decide the neutral identity, for example `[private list: oldnames] contributors <contributors@users.noreply.invalid>` (a placeholder for the new name; see
  `docs/PUBLISH_CHECKLIST.md` for the rename). Do not change the working repository's git identity.
- Done (stage 9): `app/audit.sh` and `app/privacy-e2e.cjs` read the personal names from the untracked file `.local/forbidden-names.txt` (gitignored) and stop with a clear message if it is missing, so the current files no longer contain the names; only old versions in history do (step 2 and 3(d) below). Keep that file out of every clone you publish from.

## Internal files: not in the published repository, nor in any commit of its history
| File | Why it is internal |
|---|---|
| `NOTES.md` | the working log: decisions, names, local paths, process (already untracked; it was tracked in about 30 early commits) |
| `docs/PUBLISH_CHECKLIST.md` | publishing decisions, the rename list, the tool-trailer decision |
| `docs/PUBLISH_HISTORY.md` | this plan (it spells out what to search for) |
| `docs/PILOT_CHECKLIST.md` | the plan for the first real-wallet pilot: spending limits, who approves, what could fail (no public file points to it any more) |
| `docs/POLISH_NEXT.md` | the internal to-do list for later polish, with decisions still open |
| `docs/RUNNING.md` | how to start, stop and check the programs on the owner's machine (paths, ports, tunnels) |
| `docs/DESIGN_NOTES.md` | design options for anchoring, key custody and outages, with a ranking for the freeze |
| `docs/DEPLOY_VERCEL.md` | the steps for putting the static demo on a static host, with what was not verified |
| `docs/FACTS_FOR_DOCS.md` | a working file for writing the README and threat model; its facts are already in the README, the threat model and the specification, and it says "unverified" about things the owner has not yet decided |
Never tracked and never to be: `.local/` (the name list), `runs/` (keys, seeds, wallets), `design/` (the design sheet, which carries the project's contest name), wallet folders, `*.age`.

`docs/EVIDENCE.md` and `docs/FINDINGS.md`: **include both.** They are written for readers: claims, how they were shown, how to check them, and other projects named factually; they contain no person, no tool and no internal process (the audit finds none of the listed words in them). Before publishing: remove their "Status: draft, not published" line; in `EVIDENCE.md`, decide whether the **mainnet transaction ids** may be shown (they belong to real wallets); in `FINDINGS.md`, re-read the table naming other wallets and the "not verified" labels, because it names third-party projects.

### References to internal files
Done (an ordinary commit in the working repository): the README, the demo script, the threat model, `app/drop-e2e.sh`, `app/web/demo.sh` and `spikes/t1.sh` no longer point at any internal file. `docs/PILOT_CHECKLIST.md` still says "until the owner says so"; it is internal and nothing public points to it, so it is left as it is. `.gitignore` lists `/NOTES.md`, which is harmless. Check again just before publishing: `git grep -n -E 'PUBLISH_CHECKLIST|PUBLISH_HISTORY|FACTS_FOR_DOCS|PILOT_CHECKLIST|NOTES\.md'` should print only `.gitignore`, `app/audit.sh` and the internal files themselves.

## The plan (on a fresh clone only)
1. Clone only the branch to publish (this leaves out the backup branch, the trial branches and every other ref):
   `git clone --no-local --single-branch --branch nu7-libs /path/to/working-repo "$W/publish" && cd "$W/publish"`.
   Record the starting point: `git rev-parse HEAD > ../old-tip`, `git rev-list --count HEAD > ../old-count`, `git log --format='%an <%ae>' | sort -u > ../old-authors`.
2. Collect what to replace, from the clone itself (so that no name is written into this plan):
   - `OLD_EMAIL`: the email of our author, from `git log upstream-merge-base..HEAD --format=%ae | sort -u` (it is the only one; the merge base with upstream is `5a26ee8`).
   - The name-list strings: `git log -p -S"<each name>" -- app/audit.sh app/privacy-e2e.cjs` shows every historic form; write one `literal:OLD==>NEW`
     line per distinct form into `$W/replace.txt` (new text: a neutral placeholder such as `LOCALNAME`; for a path, `/home/localuser`).
3. Run one filter pass (it rewrites all hashes; that is expected):
   ```
   printf '[private list: oldnames] contributors <contributors@users.noreply.invalid> <%s>\n' "$OLD_EMAIL" > ../mailmap.txt
   git filter-repo \
     --mailmap ../mailmap.txt \                                  # (a) author and committer of our commits; upstream's are not in the file, so they stay
     --message-callback 'import re; m = re.sub(rb"(?im)^([private list: names]-by|[private list: names]-session)[^\n]*([private list: names]|[private list: names])[^\n]*\n?", b"", message); return m.rstrip() + b"\n"' \   # (b) trailers
     --path NOTES.md --path docs/PUBLISH_CHECKLIST.md --path docs/PUBLISH_HISTORY.md --path docs/FACTS_FOR_DOCS.md --path docs/PILOT_CHECKLIST.md --path docs/POLISH_NEXT.md --path docs/RUNNING.md --path docs/DEPLOY_VERCEL.md --path docs/DESIGN_NOTES.md --invert-paths \   # (c) the internal files, from every commit; commits left empty are dropped (the 12 that touched only NOTES.md, and any that touched only the other internal files)
     --replace-text ../replace.txt                               # (d) the name-list strings in the two scripts
   ```
   Upstream's own co-author trailers (other people) are not matched by (b) and stay.
4. Verify, all of it, before pushing:
   - **Tree:** `git diff --name-status $(cat ../old-tip) HEAD` must list exactly the internal-file deletions (eight: `docs/PUBLISH_CHECKLIST.md`, `docs/PUBLISH_HISTORY.md`, `docs/FACTS_FOR_DOCS.md`, `docs/PILOT_CHECKLIST.md`, `docs/POLISH_NEXT.md`, `docs/RUNNING.md`, `docs/DEPLOY_VERCEL.md`, `docs/DESIGN_NOTES.md`) and nothing else once the references and the name list are already clean at the tip (they are, after the commit described under "References to internal files"); if `app/audit.sh` or `app/privacy-e2e.cjs` still show up, the only differences allowed are the replaced strings: apply the same replacements to the old versions (`git show $(cat ../old-tip):app/audit.sh | sed ...`) and `diff` against the new ones: empty. (`NOTES.md` is untracked at the tip, so removing it changes no current file.)
   - **Authors:** `git log --format='%an <%ae>%n%cn <%ce>' | sort -u` shows the neutral identity, upstream's authors and the web interface's committer, and nothing else.
   - **Trailers:** `git log --format=%B | grep -ci -E '[private list: names]|[private list: names]'` is 0.
   - **Strings, in every commit:** `git rev-list --all | xargs -n 200 git grep -I -l -i -E '<each name>|/home/<user>' ` prints nothing; `git log --all --name-only --format= | grep -E -x 'NOTES.md|docs/PUBLISH_CHECKLIST.md|docs/PUBLISH_HISTORY.md|docs/FACTS_FOR_DOCS.md|docs/PILOT_CHECKLIST.md|docs/POLISH_NEXT.md'` prints nothing.
   - **Count and size:** `git rev-list --count HEAD` is the old count minus the commits that only touched `NOTES.md`; `git count-objects -vH` is small.
   - **Content:** in a scratch checkout run `app/audit.sh` (with the local name file) and the build from the README.
5. Push to a NEW, empty repository (no force is ever needed): `git remote add publish <new url> && git push publish HEAD:main`. Push nothing else (`git push publish --tags` is not run; there are no tags). The account name will appear in the address of the new repository; that is outside this plan.
6. Afterwards: set the repository name, description and topics only on the publish date (docs/PUBLISH_CHECKLIST.md), and keep the old repository private.

## Fallback if the tree check fails
One squashed commit on top of upstream's history, still on a fresh clone:
```
git clone --no-local --single-branch --branch nu7-libs /path/to/working-repo "$W/squash" && cd "$W/squash"
git checkout -b publish 5a26ee85                     # upstream's last commit before our work (keeps upstream's history and credit)
git checkout nu7-libs -- .                           # the current files
git rm -q --cached NOTES.md docs/PUBLISH_CHECKLIST.md docs/PUBLISH_HISTORY.md docs/FACTS_FOR_DOCS.md docs/PILOT_CHECKLIST.md docs/POLISH_NEXT.md docs/RUNNING.md docs/DEPLOY_VERCEL.md docs/DESIGN_NOTES.md 2>/dev/null || true   # the internal files
# apply the step-2 replacements to app/audit.sh and app/privacy-e2e.cjs (sed), then:
git add -A && git -c user.name='[private list: oldnames] contributors' -c user.email='contributors@users.noreply.invalid' commit -m '[private list: oldnames]: project files'
```
Run the same tree, strings and audit checks (the old tip is `nu7-libs`), then push to the new repository as in step 5. Upstream's commits keep their authors; ours disappear into the one commit, so the history shows no tool trailers by construction.

## Not covered
Release assets, the repository settings, the static demo deployment, and anything the host account's web address reveals.
