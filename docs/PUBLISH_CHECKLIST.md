# Publish checklist

Status: **internal, not for publication.** Nothing is published until every row below says "read by me". Statuses:
`draft` (written, not yet read by the owner) or `read by me`. Rules for everything public: no mention of AI tools or
named individuals; no number that is not either measured by us (with how) or sourced; other projects described factually and
respectfully with a link; the word "Zcash" is fine; the contest and project names stay out of commit messages and
repository metadata until 2026-10-28. `app/audit.sh` checks these rules.

| Path | What it is | Status | Open points before publication |
|---|---|---|---|
| `SPEC.md` | the protocol: rules, memo payload, ticket, ledger, recount, relay, contribute page, uniform-price auction | draft | read in full; §8 heading fixed (was marked trial) |
| `docs/EVIDENCE.md` | claim / evidence / network / how to verify | draft | owner to read every row; mainnet ids belong to real wallets (confirm they may be shown); pending items listed |
| `docs/FINDINGS.md` | reusable findings, with unverified items marked | draft | owner to read; planned mainnet date is stated as unverified |
| `README.md` | currently the upstream tool's readme | draft | needs a short project readme (what it is, how to run the recount, how to read the evidence) |
| `app/core`, `app/host`, `app/relay`, `app/contrib`, `app/recount`, `app/vectors` | the Rust crates (rules, host, relay, contributor and recount tools, test vectors) | draft | read before publishing; test-only cheating switches are behind a feature (documented) |
| `app/web` (pages, WebAssembly crate, scripts) | contribute, campaign, recount, dashboard pages and the browser tests | draft | the built WebAssembly (`app/web/www/pkg`) is not committed; document how to build it |
| `app/*.sh`, `app/web/*.cjs`, `app/drop-verify.py` | end-to-end scenarios and checks (testnet) | draft | they use local wallet folders named `bidder`, `outsider`; document or parameterise |
| `src/` (patched wallet command-line tool), `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `LICENSE-MIT`, `LICENSE-APACHE` | the patched copy of the upstream tool, with its licences | draft | keep upstream licences and attribution; say clearly which parts are ours (see FINDINGS §1) |
| `doc/walkthrough.md`, `CONTEXT.md` | upstream documentation of the tool | draft | decide: keep (upstream) or remove |
| `spikes/` | early experiment scripts | draft | read; remove anything that is only local notes |
| `.github/` | upstream CI workflows and dependency-bot config | draft | review: CI is disabled on this repository; decide whether to keep |
| `.gitignore` | ignore rules | draft | **line 23 contains the project name in a comment; reword before publishing** |
| `NOTES.md` | internal working log | **not published** | contains personal names and internal decisions; keep private |
| `runs/`, wallets, `*.age`, seeds | local data | **never published** | already git-ignored |

## Open decisions (nothing has been changed)

1. **Commit history.** The history on the working branch contains, in commit messages, AI co-author trailers and the names of tools
   (see the audit report). Publishing the history as it is would publish them; options (squashing, a fresh history, leaving it)
   are the owner's decision. Nothing has been rewritten.
2. **Repository name and metadata** (name, description, topics, author identity) must not carry the contest or project names before 2026-10-28.
3. Whether the **mainnet transaction ids** in EVIDENCE.md may be shown.
4. **Rename the product** (today's placeholder is "[private list: oldnames]"), in this order, before the repository is made public:
   - `app/web/www/brand.js` (the one constant that every page shows), the page titles, `README.md`, and the repository name;
   - the licence notices that carry the name: `NOTICE`, the second line of `LICENSE-MIT` ("Copyright (c) 2026 the [private list: oldnames] contributors") and the licence line in the README; change "[private list: oldnames] contributors" to the new name in all three and leave the upstream line ("The Electric Coin Company") as it is;
   - then adjust the `app/audit.sh` allowlist for the new name (the banned-name rule must not flag the product's own name), and rerun `app/audit.sh`;
   - search the tree for the old name afterwards, so none is left in code, comments or the documents.
