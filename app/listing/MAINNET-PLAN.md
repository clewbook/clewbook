# Listing mainnet campaigns: plan (prototype, not enabled)

Mainnet stays refused by default. Nothing in this note is enabled on the server.

## Checks in place for when it is enabled

- **Explicit flags.** The job refuses to start with `--network main` unless `--confirm-mainnet-listing` and `--nu7-mainnet-height <height>` are also given.
- **NU7 cutoff.** A new mainnet campaign is refused unless its whole life ends before the NU7 activation height: deadline, ticket window, close grace, re-issue window and 50 blocks of margin. This is the same formula as the host's own guard (`app/host/src/mainnet.rs`). Test: `mainnet_needs_its_own_allowance_and_a_close_before_nu7`.
  - The height is block 3,543,405 (ZIP 259, set 21 Oct 2026; Zebra 7.0.0, 22 Oct 2026), expected about 5 November.
  - The host's fallback without a height ("over a week before 5 November", so before 29 October) is not copied. Without the height, mainnet cannot be enabled.
- **Minimum recount pass.** A new campaign is listed only after a recount over its current ledger passes every check that can run.
  - A mainnet fundraiser always gets the full recount: R1 to R8 and R4b.
  - A uniform-price auction also gets R9 to R12.
  - An auction before its close can only run R1 and R2.
- **Relays.** Every relay that answers must show the same intact, signed ledger.

## Threats specific to mainnet

- **Queue flooding.** The limits already in place:
  - 4 KB per record, 10 records per host key, 200 in the queue, 1000 in all;
  - 10 requests a minute per address (Cloudflare refuses a faked address);
  - expiry after 7 days.

  Each record also needs a campaign registered on a relay, which is cheap to make. Queued records are recounted for information, after new and listed campaigns, within the per-pass limit. So a flood cannot delay listed rechecks, but it can use up the remaining recount time. For mainnet: do not recount queued records, or give them a separate, smaller limit.
- **Scam fundraisers that pass the technical checks.**
  - The recount proves the accounting: every payment got a refund ticket in time, refunds were honoured, and the declared outcome is true.
  - It says nothing about who the people are or what they will do with money they keep once the goal is met.
  - The only human gate is the approval of the host key.
- **Payment address spoofing.**
  - The campaign page takes the address only from the rules, and the campaign id is the hash of those rules. The listing never carries an address.
  - A copycat can still publish a different campaign with its own address and a different name that claims to be someone else.
  - Visitors should match the campaign id the host announced elsewhere.
- **Look-alike names and labels.**
  - What is covered:
    - Cyrillic and Greek look-alikes, digits for letters, "rn" for "m", and accents are folded;
    - near matches are caught (edit distance 1 or 2);
    - Clewbook is reserved, together with the names in `reserved.txt`;
    - letters outside Latin are named in the queue.
  - Not covered:
    - scripts beyond that table (for example Armenian or Cherokee look-alikes);
    - a campaign name that imitates a host label;
    - a label that imitates a campaign name.
- **Who may be approved.** Today it is the operator alone, by fingerprint, with no written criteria. Suggested criteria:
  - the operator knows the host and has a way to reach them;
  - one testnet campaign first, then a small mainnet one;
  - a revoke as soon as a listed campaign is flagged and not explained.

## What a listing means for visitors, and what it does not

**It means:**
- the operator approved this host key;
- the host key and the campaign's own ledger key both signed the request;
- every relay that answers shows the same intact ledger;
- the recount passed when it last ran (time and block are in `out/status.json`).

**It does not mean:**
- an endorsement;
- that the campaign will deliver;
- any protection beyond the refund rules;
- a live check: a listed campaign is recounted when its ledger or close state moves and every 6 hours. A listed campaign that starts failing stays listed, flagged "attention", until the operator hides it.

The home page shows neither the recount result nor the attention flag, because no page was changed. A visitor cannot see a flag today.

## Still unverified

- The job's chain path (the browser module compiled natively) was run against public servers on 16 October 2026 only:
  - for the three live mainnet fundraisers;
  - for one sealed testnet auction.

  It was not run for:
  - a full testnet scan;
  - an auction after its close;
  - a uniform-price auction's treasury scan;
  - the winner disclosure checks.
- **One chain server only.** The recount page compares up to three. A dishonest server could hide payments; mainnet should use two and compare.
- **Every recount rescans from the start height.** The measured runs:

  | Blocks | Time | Download |
  |---|---|---|
  | 2,300 | 45 to 98 s | about 4 MB |
  | 5,400 | 92 s | about 10.6 MB |

  The limit of 20,000 blocks covers about 17 days of mainnet. An incremental scan is not built.
- **After NU7 activates,** the refund tickets of a still-open listed campaign stop working. Nothing in the job handles that yet; the campaigns are meant to be closed before it.
