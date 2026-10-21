# Spec v1 (draft)

Formats and rules shared by the host app, the relay, the recount and the web app.
Shared test values: `app/vectors/vectors.json` (checked against libsodium.js by
`app/vectors/js/check.cjs`, and in reverse by `ll-vectors verify-js`).

## 0. Conventions

- **Canonical JSON:** RFC 8785 (JCS): sorted keys, no whitespace, integers only (zatoshis,
  heights). Every hash or signature over JSON is over its canonical form.
- **Hash:** BLAKE2b-256, unkeyed, zero salt, with the ASCII label zero-padded to a 16-byte
  personalization. (libsodium.js cannot hash a message with a personalization; web code uses
  `@noble/hashes` for these hashes and libsodium.js for boxes and signatures.)
- **Txids:** lowercase hex in display order (as block explorers and `zcash-devtool` print them).
- **Nullifiers (byte-order rule):** lowercase hex of the 32 bytes exactly as serialized in
  the transaction's action (`Nullifier::to_bytes()`, the `nf` column of the wallet
  database). Never byte-reversed. Some tools print nullifiers reversed (zebra's double-spend
  error printed `2f7b…a3f6` for nullifier `f6a3…7b2f`); any nullifier taken from such a
  source MUST be reversed before comparison. Recount compares nullifiers only after
  normalizing to this form.
- **Viewing keys:** one UFVK has several valid encodings (`uview…` Revision 0, `uvf…`
  Revision 1). Compare UFVKs by their decoded items, never as strings.
- **Heights, not dates:** every deadline is a block height. Converting a date uses each
  upgrade epoch's block time (about 75 s on the main network before NU7; 25 s after NU7 is reported but not yet verified by us, and the test network measured 19 to 27 s); displayed dates are estimates.

## 1. Campaign rules

Published at creation; immutable. `rules_id = BLAKE2b-256("ledgerlab_rules", canonical JSON)`.

| Field | Type | Meaning |
|---|---|---|
| `v` | int | `1` |
| `network` | string | `"test"` or `"main"` |
| `mode` | string | `"raise"` or `"auction"` |
| `goal_zat` | int | raise only: amount that must remain (after early withdrawals) at the deadline, or at an early close (§4, "Early close"). With `cap_zat` it is the soft cap, counted on the kept amount only (§4, "Hard cap") |
| `items` | int | auction only: number of items; the top `items` bids win |
| `start_height` | int | contributions mined before this height are ignored |
| `deadline_height` | int | last height at which a contribution counts |
| `ticket_k` | int | a ticket's ledger entry must exist within K blocks of its contribution. K is chosen when the campaign is created, 10 to 1000 blocks, default 30. It also sets how long after the deadline the host has to close before contributors may claim their own refunds (§4). It is a timing allowance, not a key or a trust assumption: a longer K leaves a contribution without a ticket, and a silent host unaccountable, for longer |
| `close_grace` | int | kept for compatibility (10): it is part of every campaign's id. It was the close window when K was fixed at 10; the close window is now K itself (deadline + `ticket_k`), for the contribute page, the recount page and the recount alike |
| `reissue_window` | int | blocks after a network upgrade in which outstanding tickets may be re-issued (20) |
| `name` | string, optional | a public name chosen by the host, 1 to 60 characters, plain text: no leading, trailing or doubled space, no control, invisible or direction-changing characters, no `<` or `>`. It is part of the signed rules and so of the `rules_id`; it is shown wherever the campaign is shown, in place of the short id. Omitted when not set, and a campaign without it keeps the `rules_id` it always had. Pages show it as plain text only, and a contribute page refuses rules whose name breaks these limits. |
| `early_close` | bool, optional | fundraiser only, and only ever `true`: the host may close before the deadline once the goal is met (§4, "Early close"). Left out when not allowed, so older campaigns keep their `rules_id`. An auction's rules are refused if they carry it. |
| `cap_zat` | int, optional | fundraiser only: the hard cap, the most the campaign keeps; at least `goal_zat` and at least `min_contribution_zat` (§4, "Hard cap"). Left out when not set, so older campaigns keep their `rules_id`. An auction's rules are refused if they carry it. A relay or recount built before this field drops it, computes a different id and refuses the campaign |
| `refund_fee_zat` | int | fee each ticket pays; refund = contribution − fee (10000, the ZIP 317 fee for a 1-in, 1-out Ironwood transaction) |
| `min_contribution_zat` | int | smaller payments are not contributions (2 × refund fee) |
| `campaign_ufvk` | string | raise only: the campaign account's unified full viewing key |
| `ufvk_hash` | hex | auction only: `BLAKE2b-256("ledgerlab_ufvk", ufvk string)`; the key is revealed at close |
| `pay_to` | string | the campaign's payment address (unified). Committed in the rules, so a link carrying only `rules_id` cannot be made to point at another address |
| `ledger_pubkey` | hex | Ed25519 key that signs ledger entries |
| `payload_pubkey` | hex | X25519 key that memo payloads are encrypted to |

## 2. Contribution memo payload

The contributor pays the campaign address with this memo (ZIP 321 `memo` parameter):

```
memo text  = "LL1:" || base64url_nopad(sealed)
sealed     = crypto_box_seal(plaintext, payload_pubkey)        // libsodium sealed box, 48 bytes overhead
plaintext  = 0x01                                               // version
          || rules_id               (32 bytes)                  // binds the payload to this campaign
          || sign_pubkey            (32 bytes, Ed25519)         // winner proofs and contributor signatures
          || enc_pubkey             (32 bytes, X25519)          // tickets are sealed to it
          || refund_typecode        (1 byte: 0x03 Orchard/Ironwood receiver, 0x02 Sapling)
          || refund_receiver        (43 bytes, raw receiver)
```

Plaintext 141 bytes, sealed 189, memo text 256 characters (fits the 512-byte memo).

**Payload version 2 (the amount sealed in).** `plaintext = 0x02 || …the same fields… || amount_zat (8 bytes, little-endian)`: the amount the
contributor intends to pay. Plaintext 149 bytes, sealed 197, memo text 267 characters; the payment link grows by 14 characters and its QR code
stays at version 16 (562 characters, measured). **A payment counts as a contribution only if it pays at least `amount_zat`** ("at least": paying more
is fine). A smaller payment is rejected by the host (reason "underpaid") and is a non-refundable donation; a wallet that lets the sender lower the
amount therefore turns the payment into a donation, which the contribute page warns about before and after payment. Fees do not matter: the payment
amount excludes the network fee. **Version 1 payloads (no amount) keep working**: any amount counts, and such a memo can still be copied (see below);
the page labels it "older payment code (copyable)". New contribute pages always make version 2.

**What the public recount can and cannot conclude without the contributor revealing their one-time secret:** it can see that payments repeated an
earlier payment's message and that a host rejected a payment, but it cannot see what amount a message promised, so it cannot tell whether a reject
for being too small was fair; with the secret (a challenge, §4) it opens the message and can: a reject of a payment below the promised amount stands,
a reject of a payment at or above it is a false reject (R8), and a ticket for a payment below it is a failure (R8).

**Contributor keys.** The contributor's device draws one random 32-byte `seed` per contribution
and derives two independent keys from it; one key is never used for both jobs:
`sign_sk = BLAKE2b-256("ledgerlab_sign", seed)` (Ed25519 secret seed),
`enc_sk = BLAKE2b-256("ledgerlab_enc", seed)` (X25519 secret key, used directly as the scalar).
Backing up `seed` backs up all three keys.

**The validity rule** (one rule, `ll_core::payload::check`, used by the host and the recount alike). A payment whose message opens is a
contribution only if: it is sealed for this campaign; it pays at least the amount sealed in it (version 2); its refund receiver has type
0x03 (Orchard/Ironwood) and its 43 bytes are a valid address (the check a wallet makes before paying it); and it leaves something to refund
after the fee. Otherwise the host writes a signed `reject` at once, with the reason in plain words followed by a code in brackets
(`[other_campaign]`, `[underpaid]`, `[receiver_type]`, `[receiver_bytes]`, `[nothing_to_refund]`, and `[unreadable]` for a message that does not open); it takes no lock, builds no ticket and
does not try again, so such a payment can never hold up the close. A message that does not open, or opens to a wrong length or version, is
rejected the same way. The recount upholds every reject that fails this rule even when the payer publishes their secret (R8). Failures on the
host's side (a wallet that is not synced, a lock, the network) are never rejects: the payment waits for its ticket, and the close refuses
while it waits.

**Donations.** A payment to the campaign without a valid payload for this `rules_id` has no
refund address and can never be refunded. It counts toward the totals, is reported separately
as a non-refundable donation, and is excluded from R1 to R7. The contribute page MUST make it
impossible to send one by accident (it only offers QR codes and links that carry the payload).

The refund receiver is the raw shielded receiver, not a Unified Address string, to keep
the memo short.

**Memo one-time key.** The sealed box's ephemeral key is not random: it is
`eph_sk = BLAKE2b-256("ledgerlab_eph", seed)` (X25519). The result is an ordinary libsodium
sealed box (`crypto_box_seal_open` opens it), and the contributor can always recover `eph_sk`
from the seed to challenge a false reject (§4).

**Replayed payloads.** A sealed memo is accepted from one payment only. If two payments in the contribution window carry the identical memo,
only the earliest *accepted* one (by chain order: block height, position in the block, action; a payment the host rejected, for instance as
"underpaid", does not use up the message) can be a contribution; every later one is a
non-refundable donation, listed as such. The host writes a `reject` entry for it with the reason "replayed payload", a challenge cannot turn it
into a contribution (it is not a new contribution by anyone), and a ledger entry that tickets a replay fails R3. The recount says so in a plain
warning ("N payment(s) repeated the sealed message of an earlier payment …"). One payment code paid twice therefore counts once.

**Known limitation (copying a pending message).** A version 1 payload binds the rules, the contributor's keys and refund receiver; it does **not**
bind the amount or the payment. A version 2 payload binds the amount ("at least"), which removes the cheap attack: a copier must pay at least the
contributor's amount, and then the copier's own money is refunded to the contributor's address, so the harm is about one network fee.
The text below describes the attack on version 1 payloads (and the same-amount copy on version 2). In a fundraiser the viewing key is public, so anyone who sees a pending payment's sealed message (a mempool
stream) can put it into a payment of their own that mines first. By the earliest-wins rule that copy is then the contribution (its ticket refunds
*the copier's* amount to the real contributor's refund address) and the real contributor's later payment is set aside as a donation, which the host
can keep. A host can do this to itself at the cost of a fee. Today this is not prevented; it is made visible: the recount's warning names both
payments and their amounts, and the contributor's page compares the amount the list shows for their message with the amount they meant to pay and
shows a red notice if they differ. A prevention that does not change the memo needs a signed claim by the contributor (their signing key is already in
the payload) naming the payment that is theirs; that is proposed, not built.

## 3. Ticket

A PCZT-built transaction that spends exactly one contribution note to the refund receiver
for `value − refund_fee_zat`, with:
- expiry height `0`;
- outgoing viewing key discarded (`OvkPolicy::Discard`), so UFVK holders see the spend but not
  the recipient or memo (the amount is still inferable: input − fee);
- the consensus branch ID current at issuance; re-issued after each network upgrade.

The host locks the note twice:
- **Application guard:** only one of the note's listed tickets, or the post-deadline sweep of
  the kept set, may spend it. Every transaction the host builds is checked before signing
  (exactly the expected notes, one output to the expected receiver, expiry 0 for tickets), and
  any other spend of a ticketed note raises an alert.
- **Wallet output lock** (owner `"ticket:<nf>"`): set when the ticket is issued, with no end
  height. It is **not** released at the deadline or after `close_grace`: it lasts until the note
  is spent (by its own ticket, whoever broadcast it, or by the sweep) **and that spend is
  confirmed on chain**; then the host releases it. A contributor broadcasting their own ticket
  is detected as an ordinary spend. A re-issued ticket keeps the same owner, so the lock carries
  over unchanged.

Tickets are broadcast with `send-without-storing`.

The signed ticket is delivered as `crypto_box_seal(blob, enc_pubkey)`, where the sealed `blob` has a version:
- **Version 1** (issued before 2026-10-06): `blob = raw_tx` (the transaction bytes; they begin with the transaction header, never with `LLT2`).
- **Version 2**: `blob = "LLT2" || u32le(len(raw_tx)) || raw_tx || u8 action || u64le value_zat || rseed[32]`: the opening values of the refund output (which action of the Ironwood bundle holds it, its amount, the note's random seed). The note's `rho` is the nullifier spent by the same action, so it is read from the transaction, not trusted from the blob. Readers accept both versions; the ledger entry's `blob_hash` covers the sealed bytes either way.
The test vectors (`app/vectors`) include a version 2 blob that Rust and libsodium.js each build and open.

### 3.1 What the contributor's page checks

A ticket's transaction id covers everything except its signatures and its proof, so a matching id alone does not show
the ticket works. The page runs these checks and **lists only the checks that actually ran** ("Checked: …. Not
checked: …."); a ticket that fails one is never shown as received and checked, and the page shows a red notice naming
the failed check ("Don't rely on it yet. Keep your backup file.").

| Check | How | Level |
|---|---|---|
| matches the signed list | the transaction id equals the ledger entry's `ticket.txid` | 1 |
| shape | exactly two Ironwood actions, nothing in other pools | 1 |
| signatures | every spend authorization signature and the binding signature verify against the signature hash, which for a transaction without transparent inputs equals the transaction id (ZIP 244) | 1 |
| network version | the consensus branch the transaction commits to equals the one the server reports now (`GetLightdInfo`); otherwise "the campaign must re-issue it" | 1 |
| never expires | expiry height 0 | 1 |
| fee | the Ironwood value balance equals `refund_fee_zat` | 1 |
| spends your contribution | one action's nullifier is the contribution's | 1 |
| coin unspent | the contribution's nullifier is searched in compact blocks from the contribution's height; a spend by a transaction the ledger names for that coin (its tickets, a settlement) is expected, any other spend fails | 1 |
| pays you | recompute the refund output's note commitment from the opening values in the sealed blob, the **rho of that action in the ticket's own transaction**, and the Orchard receiver of the refund address the contributor gave; it must equal the output commitment (`cmx`) inside the ticket's own transaction (never a value the host merely claims). If the contribution amount is public (a fundraiser) the opened amount must also equal contribution − fee. Passes only then ("it pays you"). A ticket in format version 1 carries no opening: the page says "Not checked: that it pays you", never a failure. | 2 |
| proof | the Halo 2 proof verifies | 3 |
| anchor | the anchor is a real earlier tree root | 4 |

## 4. Ticket ledger entry

Append-only, hash-chained, signed. Absent optional fields are omitted from the JSON.

| Field | Type | Meaning |
|---|---|---|
| `v` | int | `1` |
| `rules_id` | hex | campaign |
| `seq` | int | 0, 1, 2, … with no gaps |
| `prev` | hex | `entry_hash` of entry `seq − 1`; 32 zero bytes for `seq = 0` |
| `kind` | string | `"issue"`, `"reissue"`, `"reject"` or `"close"` |
| `contribution` | object | issue/reissue/reject: `txid`, `action`, `nf` (§0), `height`; raise: `value_zat`; auction: `amount_commit` instead |
| `ticket` | object | issue/reissue: `txid`, `issue_height`, `branch_id` (hex). Refund = value − `refund_fee_zat` |
| `blob_hash` | hex | issue/reissue: BLAKE2b-256("ledgerlab_blob", encrypted ticket) |
| `reason` | string | reject: why the memo could not be accepted |
| `close` | object | close: `close_height`, `outcome` (`"goal_met"`, `"goal_missed"` or `"auction"`); auction also `winners` (nullifiers, best first), `ufvk` (revealed), `amount_key` |
| `sig` | hex | Ed25519 signature by `ledger_pubkey` over the canonical entry without `sig` |

**Rejects and challenges.** The host writes a `reject` entry for every payment whose memo has
the payload shape but does not open to a valid payload for this campaign; that payment is a
non-refundable donation. A contributor who disputes a reject publishes a **challenge**
`{txid, action, eph_sk}` (the memo one-time key, recoverable from their seed). Anyone can then
open the memo with `campaign payload_pk` and `eph_sk`; if it holds a valid payload for this
`rules_id`, the reject was false (R8 fails) and the payment is a contribution owed a ticket.
Publishing a challenge reveals that contribution's refund address. A challenge is **neither signed
nor sealed**: the secret itself is the proof (anyone opens the memo with it and sees whether the
payload was valid), and it is meant to be public. Relays store challenges (§6).

- **A challenge is valid at any time and never expires.** The recount accepts one regardless
  of the campaign's phase, the deadline, or whether the host has already spent the payment.
- **Swept rejects are flagged.** When the host spends a payment it rejected, the recount prints
  a visible `WARNING` with the amount, the payment and the spending transaction. It is not a
  rule failure (a just reject may be spent), but readers see that a contributor may still
  hold a genuine claim.
- **The contribute page must watch for rejects of its own payment** (match the ledger's
  `contribution.txid`/`action` against the payment it made) **and publish the challenge
  automatically**, using the one-time secret it derives from the contributor's seed, without
  asking the contributor to notice anything.

**Sealed bids.** In auction mode entries never contain amounts. `amount_commit =
BLAKE2b-256("ledgerlab_amount", amount_key || nf || value as 8-byte little-endian)`, where
`amount_key` is a random 32-byte host secret revealed in the close entry. Bid timing (height,
txid) is visible during the auction.

`entry_hash = BLAKE2b-256("ledgerlab_entry", canonical entry including sig)`.
A later entry for the same `nf` supersedes earlier ones for delivery. On chain, any listed ticket
for that `nf` is an honest spend (a ticket re-issued within the same upgrade epoch leaves both valid).

### Early close (fundraisers whose rules carry `early_close`)

- The host may write the close entry before the deadline only if the rules carry `early_close` and the goal is met at that moment, counting
  only contributions not taken back by their tickets; every pending ticket must be issued first (as for any close). The outcome is `goal_met`.
- The close height then ends the contribution range: payments mined after it are not contributions (like late payments: no ticket, not
  counted, not refunded by the close). Contributors may take their contribution back with their ticket until the close entry is published;
  after it the kept contributions are swept as in any goal met close.
- The recount (`contribution_end`): R2 accepts a close at or before the deadline only for such rules and only with outcome `goal_met`; R7
  recomputes the goal over the range that ends at the close height; R5 and R6 split spends at the close height instead of the deadline.
  For every other campaign the range ends at the deadline, so a forged early close fails R2 and changes nothing else.
- An auction can never close early: its host sees every bid and could pick a convenient moment.

### Hard cap (fundraisers whose rules carry `cap_zat`)

- At the close, the contributions not taken back by their tickets are taken in chain order (height, then position in the block, then txid,
  then action). Each one that still fits under `cap_zat` is kept and uses up room; one that does not fit is **not** kept and is refunded
  whole by its own ticket, like any contribution outside the kept set. A ticket cannot split a payment, so there is no partial refund.
  A payment that does not fit does not stop later, smaller ones that do.
- The goal (`goal_zat`, the soft cap) is counted on the kept amount only. If it is not reached, nothing is kept and everyone is refunded,
  as without a cap. An early close needs the same: the soft cap met by what fits under the hard cap.
- The kept set is decided at the close: a contribution taken back before it frees room for later ones.
- The host's close needs nothing new: it sweeps the kept set and refunds every other contribution with its stored ticket. The recount's
  R6 then checks that every payment over the cap left only through its ticket, and R7 that the outcome follows the soft cap on the kept
  amount. R5 is unchanged.
- The cap cannot be changed after creation (it is part of the `rules_id`). The program warns, but does not refuse, when `cap_zat` is less
  than twice `goal_zat`: with little room above the goal, one payment that does not fit can leave the kept amount below the goal even
  when enough was paid in.
- The contribute page shows the room left under the cap by replaying this rule over the public list in its order (payments taken back
  are not visible there, so the real room can only be larger), refuses an amount larger than that room, and says before payment that a
  payment that does not fit is refunded at the close, minus the refund fee, and stays locked until then.

## 5. Recount

Inputs: the rules, the ledger, published challenges, and the chain scanned with the campaign's
UFVK (raise: from the rules; auction: revealed at close; before that only R1 and R2 can be
checked). Full transactions are needed, not only compact blocks: memos need full data.

**Two independent servers (web recount).** A lightwalletd server can omit blocks, so the web
recount scans the same block range from **two independent public endpoints** and compares the
results (the notes found, their nullifiers, memos and spends). If they differ, or one cannot be
reached, the page shows a visible warning ("the servers disagree about this campaign" or "only
one server answered") next to the verdict. It must **never pass silently** when the servers
disagree. A verdict from a single server is labelled as such.

A **contribution** is a note received by the campaign account, mined in
`[start_height, deadline_height]`, with value ≥ `min_contribution_zat` and a valid payload.
Other received notes in range are **donations**, as are payments with an upheld reject. They are
listed separately and excluded from the refund rules. A contribution refunded by its own ticket
at or before the deadline is **withdrawn**. The **kept set** is computed from the contributions
that were not withdrawn: raise, all of them if their sum reaches `goal_zat`, otherwise none; raise with `cap_zat`, in chain order
each one that still fits under the cap, if their sum reaches `goal_zat`, otherwise none (§4, "Hard cap"); auction, the top `items`
by value (ties: lower height, then txid, then action).

| # | Rule | Fail means |
|---|---|---|
| R1 | `rules_id` matches the published rules; auction: the revealed UFVK matches `ufvk_hash` | wrong rules or key |
| R2 | Signatures verify, the hash chain has no gaps, at most one close entry, after the deadline (or before it, only as §4 "Early close" allows) | forged, dropped or premature entries |
| R3 | Every entry points at a real payment with matching details (raise amounts; auction commitments; rejects only for payload-shaped memos; auction entries never show amounts) | fake or leaky entry |
| R4 | Every contribution has a ticket entry once `tip > height + ticket_k` (inside the window it is pending) | missing ticket |
| R4b | Every ticket's `issue_height ≤ height + ticket_k`. The issue height is written by the host, so this is the host's report (the title says so) | ticket issued late, by the host's own height |
| R5 | No contribution is spent at or before `deadline_height` except by one of its listed tickets | early spend (evidence: nf, spending txid, height) |
| R6 | After the deadline, contributions outside the kept set leave only through their tickets | stolen refund |
| R7 | The close entry's outcome (raise) or winners (auction) equal the recomputed ones | wrong outcome or winner list |
| R8 | No published challenge opens a valid payload for a rejected payment | false reject |

For a fundraiser closed early (§4, "Early close"), the close height takes the place of the deadline in R5 to R7: it ends the contributions R7 counts, and R5 and R6 split spends at it.

Totals: `raised` (sum of contributions), `withdrawn` (refunded by ticket before the deadline),
`refunded` (by ticket after the deadline), `kept` (swept from the kept set), `pending` (unspent),
and non-refundable `donations`, listed separately. With `cap_zat`: `over_cap` (the contributions that do not fit under the cap,
their number and amount), and R6 adds one information line, "N payment(s) over the cap, refunded by ticket" (before the close:
"so far", refunded at the close unless room frees up).
Output: one line per rule, PASS or FAIL with evidence, and the totals.

**Report hash.** The browser recount prints a hash of its report so two people can compare what they got. It is
`SHA-256(canonical_json({"v":1, "rules_id":<campaign id>, "end_height":<last chain height read>, "report":<the report>}))`,
written as 64 lowercase hex characters. *Canonical JSON* means: object keys sorted by their UTF-16 code units; no whitespace
anywhere; strings written as `JSON.stringify` writes them; whole numbers in plain decimal; any other number as decimal with exactly
8 places (the report has none today); arrays kept in the order the report gives them; `null`, `true` and `false` as usual.
The report is the rule results (id, title, pass/fail, evidence lines), the totals and the warnings, exactly as the page shows them;
the time the recount ran and the servers' names are not part of it. A campaign with `cap_zat` adds `cap_zat`, `over_cap` and
`over_cap_zat` to its report; a campaign without one has exactly the report (and so the hash) it had before. Two recounts of the same campaign up to the same height give the
same hash. A different height gives a different hash, which is correct: the report is about that height.

## 6. Relay

A relay stores and serves the ledger entries and the sealed tickets. It is a convenience, not a
trust anchor: it holds no secret, cannot create entries, and every client re-checks what it
serves. Anyone may run one; several can mirror the same campaign. A relay compares the `rules_id` with the hash of the rules it receives; software built before the optional `name` field existed drops the name when it reads the rules and so refuses a named campaign (observed). Upgrade relays before using names.

**Rules a relay enforces** (a gate against junk, never a replacement for client checks):
- Anyone can read. Writes are accepted only for entries signed by the campaign's `ledger_pubkey`
  (from the campaign's rules, registered first), with `seq` equal to the next number, `prev` equal
  to the previous entry's hash, a valid signature, and the exact canonical JSON bytes. A different
  entry for an already stored `seq` is refused (409); an identical one is accepted again (idempotent).
- No entries after a `close` entry.
- **Before it writes the close entry, the host issues every ticket that is still missing** (late, exactly as its watcher would have), because nothing but a settlement may be added afterwards and a payment without a ticket cannot be refunded. If a counted contribution still has no ticket after that, the host does not close: it stops before writing or sending anything and names the payments. A late ticket is visible to the recount (R4 compares the issue height with the payment's height plus K).
- A ticket blob is accepted only if its `BLAKE2b-256("ledgerlab_blob", blob)` equals the `blob_hash`
  of a stored entry. Blobs are opaque ciphertext: the relay cannot read them.
- Bodies are size-limited. The relay never receives seeds, secret keys, viewing keys (auction) or
  plaintext tickets: the formats in §2-§4 contain none.

**HTTP API** (`/v1`, CORS open to any origin):

| Method and path | Body / answer |
|---|---|
| `PUT /campaigns/{rules_id}` | the rules JSON; accepted only if `hash(rules) = rules_id` |
| `GET /campaigns/{rules_id}` | the rules JSON |
| `PUT /campaigns/{rules_id}/ledger/{seq}` | one entry, canonical JSON |
| `GET /campaigns/{rules_id}/ledger?from=N` | JSON array of entries with `seq >= N` |
| `GET /campaigns/{rules_id}/head` | `{"entries": n, "last_hash": "..."}` |
| `PUT /campaigns/{rules_id}/blobs/{blob_hash}` | the sealed ticket bytes |
| `GET /campaigns/{rules_id}/blobs/{blob_hash}` | the sealed ticket bytes |
| `GET /campaigns/{rules_id}/tickets/{nf}` | the sealed ticket of the latest entry for that nullifier |
| `PUT /campaigns/{rules_id}/challenges` | a challenge `{txid, action, eph_sk}`; accepted only if a stored `reject` entry names that payment; at most 8 different secrets per payment |
| `GET /campaigns/{rules_id}/challenges` | JSON array of challenges |
| `PUT /campaigns/{rules_id}/heartbeat` | the host's "last seen" record (below); accepted only if signed by the campaign's `ledger_pubkey`, for this campaign, and later (by height, then time) than the one stored (409 otherwise) |
| `GET /campaigns/{rules_id}/heartbeat` | the newest record, or 404 |
| `PUT /campaigns/{rules_id}/final` | the host's final fingerprint of a closed campaign (below); accepted only if signed by the campaign's `ledger_pubkey`, for this campaign, and describing a list this relay holds (that many entries, a close entry among them, the same last entry hash); a later record replaces an earlier one only if it covers more entries |
| `GET /campaigns/{rules_id}/final` | the record, or 404 |

**Heartbeat ("host last seen").** On every check a running host sends each relay that just took its list a record `{"v":1, "rules_id", "height", "time", "sig"}`: the chain height it saw, its clock in Unix seconds, and an Ed25519 signature by the ledger key over `"ledgerlab_heartbeat\n"` followed by the canonical JSON of the record without `sig`. It is not part of the ledger and not hash-chained. It proves only that the holder of the ledger key was running at that moment. A relay can withhold it or serve an old one, which looks old; it cannot make a fresh one. The contributor page checks the signature itself, compares `height` with the chain height it reads, and while the campaign is open and the person has not paid, shows a warning when the lag is more than `clamp(round(ticket_k / 3), 3, 20)` blocks ("tickets cannot be issued right now"), a plain line when it is not, and a quiet line when there is no record. A campaign (or relay) that predates this simply shows no record; nothing fails. It is a warning, not a guarantee: the host can stop the next minute.

**Final fingerprint.** After the close entry is written (a separate step that moves no money: the host program, on its next check, or `cb-host finalize`), the host signs `{"v":1, "rules_id", "entries", "last_hash", "close_height", "sig"}`: the number of entries the list then had and the hash of the last of them, Ed25519 over `"clewbook_final\n"` followed by the canonical JSON without `sig`. It saves it with the final public copy of the list (`public/final.json` and `public/final-ledger.json` in the campaign folder), puts it inside every export (`"final"`), shows the line `N entries, last entry H` in the dashboard, and gives it to the relays that took the list. If settlement entries are added after the close (uniform auction), a later record covers them. A client compares any list it holds: **matches** (same entries up to `entries`, only settlements after), **cut off** (fewer entries), **different** (another entry at that place: another history, even if signed by the same key), or **extra** (non-settlement entries after the record). It shows that the list is the one the host fixed at the close. It does not show that the host was honest, that the list was complete when it was fixed (a note the host never wrote is caught only through its effect on the chain, R4 to R6), or that this record is the one others were shown; with no record, no check is made and a copy stripped of its record cannot be told apart from one that never had it.

**What clients must do.** The campaign link carries `rules_id`; a client fetching rules from a
relay checks `hash(rules) = rules_id`. It verifies every entry's signature and the hash chain
itself (recount R2) and a ticket's `blob_hash` and txid (§3).

**What a relay can still do, and how it shows.** It can be down, or withhold entries or tickets.
It cannot forge or alter one. A dropped entry in the middle breaks the chain (R2 FAIL). A dropped
newest entry is caught by R4 once K blocks pass (a contribution on chain with no ticket in the
ledger), and the contributor's page reports "no ticket found" and keeps using its saved copy: a
ticket stays valid on chain whatever any relay says. The host publishes to every relay it
knows and retries while one is down; contributors save their entry and ticket on first fetch.

**Several relays; "cannot conclude", never "guilty".** A relay can be down, behind or dishonest,
and none of that is evidence about the host. The host publishes to every relay it knows (the
campaign page lists them) and retries while one is down. A reader (recount, contributor page)
reads all the relays it knows and judges:
- **Agree:** two or more relays give the same intact ledger. Normal verdict.
- **Single:** exactly one relay gives an intact ledger (the others are down, refusing or damaged).
  A verdict is shown, and any FAIL is labelled as coming from one relay and as possibly caused by a
  relay that dropped entries.
- **Disagree:** intact ledgers differ, or one is behind. The result is **"RELAYS DISAGREE, CANNOT
  CONCLUDE"**: no pass and no fail, with each relay's entry count and the first differing `seq`.
- **No usable ledger:** none is intact (down, refusing, or a gap or broken chain). Also **"CANNOT
  CONCLUDE"**. A damaged ledger is a relay fault: a conforming relay never stores a broken chain.
A ticket that matches a signed entry in an intact ledger is genuine whatever the relays disagree
about; what a disagreement forbids is any conclusion about the host. Challenges are merged from every
relay that answered. The host's own copy of its ledger is the reference in a dispute.

## 7. Contribute page

A plain page (HTML, CSS, one script and the WebAssembly module; no framework). Keys, memos and
tickets are handled in the browser only; it talks to the campaign's relays and to a public network
server (chain height, finding the payment, sending a refund). Link: `#c=<rules_id>&relay=<url>...&server=<url>`.

- **Campaign details** come from a relay, are checked against `rules_id`, and include the payment
  address (`pay_to`). The page shows goal or items, the deadline (block height and an estimate of
  the time left), status, the smallest contribution and the refund fee.
- **Making a payment.** Amount and refund address are entered once. The page makes one random
  secret (the seed, §2) in the browser, derives the keys, builds the sealed memo and a payment link
  with a QR code (the main path: Zodl fills the memo from a scanned QR, not from a tapped link), and
  shows the memo and a copy button as the fallback. It **refuses** to build a payment for an invalid
  refund address (wrong network, no shielded receiver, not an address), an amount below
  `min_contribution_zat`, or a memo that is missing or malformed. The seed is saved in the browser
  before the QR appears, a backup file (seed, refund address, memo, ticket) is offered first, and
  restoring it on another device finds the ticket again.
- **Watching.** The page reads every relay (§6) and tries to open each new ticket with the device's
  encryption key; the one that opens is the contributor's (checked against its signed entry). When
  the campaign key is public (raise), it also scans recent blocks for a payment whose memo equals the
  contributor's, which gives the payment's `txid:action` before any ticket exists. Statuses: payment
  seen, contribution received, refund ticket secured.
- **Rejects.** With the payment known, the page looks for a `reject` entry for it and offers a button, "Publish proof that my
  payment was valid". Before the press it says what is revealed (the refund address, for this one payment) and that it cannot be
  undone; **nothing is published until the button is pressed**. If the page can see the payment was below the promised amount it
  says "This payment looks underpaid. Publishing won't change the outcome" and the button is secondary. On the press it publishes
  the challenge (§4) to every relay, and offers to retry the relays that did not take it. For an auction (no public key) the
  contributor can paste the payment's transaction ID instead.
- **Refund button** appears only when allowed: before the deadline (withdraw), or after
  deadline + `ticket_k` while no `close` entry exists (the host is silent). After a close it shows
  that the campaign has wrapped up. It asks for confirmation, then sends the ticket. A ticket the
  network already knows is not offered again.
- **Trouble with relays** is stated plainly and never blames anyone: unreachable relays are named,
  differing relays give "the lists don't show exactly the same thing, and we can't tell why", and
  the saved copy of the ticket keeps working.

## 8. Uniform-price auction

An auction with `pricing: "uniform"` replaces the pay-your-bid sweep. Everyone who wins pays one price.

**8.1 Rules (committed).** `reserve_zat` (> 0), `treasury_address` and `treasury_ufvk` (the PUBLIC viewing
key of a dedicated treasury account; the address must belong to it). Amounts below are **net**: a bid is the
note value minus `refund_fee_zat` (`f`), i.e. what a refund would return. All integers.

**8.2 Bids, winners, price.** A bid is a contribution note unspent at `deadline_height`. A note taken back
with its own ticket at or before the deadline is a withdrawal, not a bid. Bids with net value ≥ `reserve_zat`
compete: highest first; ties by chain order `(height, position of the transaction in its block, action
index)`, never by the ledger's order (the host signs the ledger order). The top `items` win. The **clearing
price** `P` is the net value of the last winner when `items` bids won, otherwise `reserve_zat`. Every winner
pays `P`, whatever their bid.

**8.3 Settlement.** For each winner the host broadcasts one transaction spending only that winner's note
(value `v`): output 1 = `P` to `treasury_address`; output 2 = `E = v − P − f` to the refund receiver in the
winner's payload (omitted when `E = 0`); the fee `f` is paid out of the note (the winner bears it, as with
refunds); no change; no other output; outgoing viewing key discarded. So `v = P + E + f` exactly. Losers
(below the reserve or outside the top `items`) are refunded through their tickets as before. After the close
entry the host appends one signed **`settle`** entry per winner `{nf, txid, price_zat, excess_zat, fee_zat}`
(entries of this kind may follow the close entry; no other kind may). The close entry also carries
`clearing_price_zat`.
- **Deadline for settlement:** `deadline_height + ticket_k`. After it, winners may self-refund.
- **Defaulted winner:** a winner whose note is spent by their own ticket after the deadline and before
  settlement. Not a failure of the host. The item goes unsold (no promotion; the price is not recomputed),
  and the recount lists it.

**8.4 Recount rules** (in addition to §5; R7 also checks the price):
| # | Rule | Fail means |
|---|---|---|
| R7 | winners and `clearing_price_zat` equal the recomputed ones | wrong winner or price |
| R9 | each non-defaulted winner's note is spent by exactly one settlement, mined by `deadline + K`, announced by a matching `settle` entry, whose fee (the transaction's net value balance) is exactly `f`, and in which the treasury (scanned with its public key) received exactly one note of exactly `P` | wrong price, short or over payment, missing/lying entry, late or missing settlement |
| R10 | the treasury received, from the settlement transactions, exactly (settled winners × `P`) | treasury short or over |
| R11 | no settlement created a note for the campaign account (nothing back to its change address), has exactly two Ironwood actions, and nothing in the other pools | value diverted to the host, extra outputs |
| R12 | a winner's optional proof that the excess was paid back, when published, holds (8.5); this is about money, not the auctioned item | "excess not delivered", with evidence |

**8.5 What the public can and cannot verify.** From the chain the public can verify: the winners and the price;
that each winner paid exactly `P` into the public treasury; that nothing came back to the campaign account;
the fee; and, by conservation, that the excess existed as one hidden output of exactly `v − P − f` (nothing
was skimmed in amount). It **cannot** verify where that excess went: with a discarded outgoing viewing key
only the winner can see it, so a host that sends it to another address is **not detectable from the chain**.
Handling:
- **A. The host's signed `settle` entry** states what each winner was owed and in which transaction; a
  diversion is then a signed false statement.
- **B. A complaint** `{txid, action, eph_sk, complaint: true}` (the same one-time secret as a challenge, §4,
  proving the author owns that contribution) is shown as an **unverified warning** and counted.
- **D. Opt-in provable proof.** A winner publishes `{txid, action, eph_sk, uivk}`: the one-time secret and the
  **incoming viewing key of a dedicated refund account**. The recount opens the payload with the secret, checks
  that the key derives the refund address inside it, opens the settlement transaction's outputs with that key,
  and shows "excess delivered" or a FAIL "excess not delivered" with evidence. Publishing the key reveals that
  account's incoming activity: the contribute page tells winners (before they pay) to use a dedicated
  account. A proof is only evidence for the winner who publishes it; an unproven winner stays "unverified".
- Relays accept such a statement only for a payment whose nullifier has a `settle` entry (§6).

## 9. Blind bid auction

A blind bid auction hides every bid's amount from the host until a drand round publishes the key that opens them all, after bidding
has closed. Each person who bids pays a **deposit** of one of the host's **tranches** and locks a bid at or below it. Each deposit gets an **early
ticket** (valid only up to the deadline) and a **late ticket** (valid only after the late ticket block), so nobody can pull a deposit back
while the host settles, and everyone gets their deposit back if the host never does. The design and its tests are in the research notes
(14, 16); this section is the format.

It is its own mode, `"sealed_auction"`. Older campaigns keep their rules and ids, and a relay, page or recount that does not know this mode
refuses it (it drops the unknown `sealed` key, computes a different id and refuses the campaign; the unknown mode is refused as well).

### 9.1 Rules

The fields of §1 apply, with these differences: `mode` is `"sealed_auction"`; `items`, `ufvk_hash`, `treasury_address` and
`treasury_ufvk` are required; `reserve_zat` is optional (when present it is more than zero); `goal_zat`, `campaign_ufvk`, `cap_zat`,
`early_close`, `pricing` and `settle_window` are refused; `min_contribution_zat` equals the smallest tranche. One more field:

| `sealed` field | Type | Meaning |
|---|---|---|
| `tranches_zat` | array of int | 1 to 10 deposit sizes, strictly increasing. A bid must be at most its tranche minus `refund_fee_zat`, and every tranche is more than `refund_fee_zat` plus the reserve |
| `pricing` | string | `"uniform"` (the k highest bids win, each pays the k-th highest), `"second"` (each pays the (k+1)-th highest, or the reserve) or `"pay_your_bid"` (each pays its own bid) |
| `drand_chain` | hex | always drand quicknet, `52db9ba7…e971`; the page and the recount pin its public key and never take it from the rules |
| `drand_round` | int | R: the round whose signature opens every bid |
| `claim_after` | int | H_s: late tickets are valid in blocks after this height |
| `coin_zat` | int | the small transparent coin the host sends to each bid page, at least 5000 |
| `coin_cutoff` | int | blocks before the deadline by which the coin must be mined, at least 10 |
| `coin_sending` | object | how the host sends coins, chosen by the host: `{"mode":"at_once"}`, `{"mode":"every_bids","n":1..1000}` or `{"mode":"every_minutes","n":1..1440}`. Whatever it chose, within 20 blocks of the cutoff coins go out at once |
| `timing` | string | left out (standard) or `"quick"` (test network only: a faster block range and a 10 minute gap) |
| `open_payouts` | bool | left out (false) by auctions made before 20 Oct 2026. When true: every payment the host signs to a person (the signed refund, a winner's change, every return) is made with that payment's own outgoing viewing key, `BLAKE2b("ledgerlab_payovk", X25519(payload secret, the memo's page encryption key) \|\| nf \|\| 0 \|\| kind)` with kind `refund`, `change`, `return` (`ll_core::payout`); the signed refund is sealed to the page with the early ticket (`LLS1` blob); the reveal publishes the payload secret key; rejected and repeated payments are sent back (§9.5); a reject carries the memo's hash, and a challenge carries the memo |
| `long_tag` | bool | when true, bids use the bound memo of §9.3 (a 16 byte tag); the older memo is no bid |
| `early_key` | bool | when true, the early ticket is made with its own outgoing key too (kind `early`), and S4 checks a deposit taken back paid the refund address in its memo |

The rules check also refuses a late ticket block of 500,000,000 or more (a lock time read as a date), and, on the main network, an auction
whose life (its late ticket block, the ticket window and 100 blocks) does not end before the assumed NU7 height (`ll_core::sealed`). The
bid page refuses a round or late ticket block much later than the plan of §9.2 gives from the block before the start.

### 9.2 Timing

The rules fix the deadline H_c, the round R and the late ticket block H_s when the auction is created (`ll_core::sealed::plan`). They
assume blocks arrive, on average, between 60 and 80 seconds each on the main network (`BLOCK_SECS`) and between 20 and 80 seconds on the
test network (`BLOCK_SECS_TEST`, whose blocks came every 24 to 25 seconds on 20 October 2026):

- R's time is at least the latest the deadline can come (every block at the slow end) plus 30 minutes, so the bids cannot open before
  bidding closes.
- The first block after H_s comes at least 60 minutes after R on the main network (`SETTLE_SECS`), 30 minutes on the test network
  (`SETTLE_SECS_TEST`), even if every block is at the fast end, so the host has time to settle before late tickets become valid.

The host checks both when it creates the auction, and the bid page checks them again before anyone bids (`Sealed::check_timing`, from the
chain's current block and its time). Both stay true as the chain moves on, as long as blocks stay inside the assumed range. If blocks are
slower, the bids could open before the close: the auction is then void and everyone gets their deposit back (§9.7). If blocks are faster, late
tickets could become valid before the host has settled: a winner could take their deposit back; money is never lost.

Quick test timing (test network only, `sealed.timing: "quick"`): a 20 to 40 second range (`BLOCK_SECS_QUICK`) and a 10 minute gap before R
(`GAP_SECS_QUICK`) in place of 30, for short trial auctions; the settlement time is the test network's. The void rule (§9.7) uses the same
gap. The field is left out of the rules for the standard timing, so auctions made before it keep their ids; a reader that does not know
it drops it, computes another id and refuses the campaign. `Sealed::check` refuses it on the main network.

Bidding window: deposits are taken until block H_c minus the larger of the ticket window and the coin cutoff (the bid page closes there).
An auction whose window is under 10 blocks (`MIN_BID_WINDOW_BLOCKS`) is refused when it is made, before any wallet exists
(`sealed::check_bid_window`).

A payment counts as the largest tranche at or below its value (a payment that matches no tranche counts as the one below; below the
smallest it is not a deposit).

### 9.3 The bid memo (version 3)

```
memo text = "LL3:" || base64url_nopad(sealed) || "." || base64url_nopad(lock || page_key)
sealed    = the payload of §2, version 2, with amount_zat = the tranche   (197 bytes; only the host opens it)
lock      = tlock to drand quicknet round R of (bid_zat 8 bytes little endian || tag 7 bytes || 0x01)   (128 bytes)
page_key  = the bid page's transparent public key, compressed (33 bytes)
tag       = first 7 bytes of BLAKE2b-256("ledgerlab_bidtag", rules_id || sealed || page_key || tranche_zat 8 bytes little endian)
```

The text is 483 characters (`ll_core::bid`). With `long_tag` the lock holds a random key instead (15 random bytes and 0x01), and the
memo carries, between the lock and the page key, the bid encrypted with that key (6 bytes) and a 16 byte tag made with it over the
campaign, the sealed part, the page key, the tranche and the encrypted bid; that memo is exactly 512 bytes. Nobody knows the key before
round R, so nobody can make a tag for another memo. Anyone who can read the memo (the host now, everyone once the viewing key is published) can
read the lock and the page key; the bid opens only with round R's signature, which is checked against quicknet's pinned public key first.

- A deposit counts only if it pays at least the amount in its sealed part (§2), so a copy of a large deposit's memo inside a small payment
  does not count (16, H3).
- After opening, the tag must match the memo it was found in and the deposit's tranche. A lock copied into another memo, or a bid moved to
  another tranche, opens with a tag that does not match and counts as no bid. A whole memo copied into another payment is a replay (§2).
- A lock that does not open (altered, locked to another round, or without the marker), or a signature that is not round R's, is no bid. It
  never stops the host or the recount.
- A valid bid is at least the reserve (if any) and at most its tranche minus `refund_fee_zat`.

### 9.4 List entries

The entries of §4, with these additions (every added field is left out when empty, so the entries of other campaigns, their hashes and
their signatures are unchanged):

| Entry | Meaning |
|---|---|
| `issue` | As §4 (the deposit, its early ticket, its sealed blob; the amount hidden by `amount_commit` until the close), plus `refund`: the id of the refund the host signed at once for this deposit. The early ticket expires at the deadline. |
| `coin` | `coin: {nf, txid, index, value_zat}`: the coin the host sent, from its own wallet, to the page of the person who made deposit `nf`; `late`: the id of the deposit's late ticket, which spends the deposit and this coin (so it is built once the coin is sent); `blob_hash`: the late ticket, sealed to the person who bid like a ticket, for the page to check and sign. A version 6 transaction id does not cover anchors, proofs or signatures, so both ids are known when the transactions are built. |
| `close` | As §4, with `outcome` `"sealed_auction"` (or `"void"`, §9.7), the winners, the price where there is one, `amount_key`, and `drand_signature`: round R's signature. No viewing key. |
| `settle` | As §8: one per winner. |
| `reveal` | `reveal: {ufvk, height}`: the campaign's viewing key, published once every winner's settlement is mined (the owner's decision 8). With `open_payouts` also `payload_sk`, the payload secret key: with it anyone opens every memo's sealed part (so every refund address becomes public) and works out every payment's outgoing key. |
| `late_return` | A deposit mined after the deadline, sent back (§9.5): `contribution: {txid, action, nf, height}` with no amount, and `refund`: the id of the return. |

A relay stores `issue` entries of a blind bid auction only with `refund` (and without `late`), `coin` entries only with `late` and
`blob_hash` and for a deposit already on the list, one `reveal` after the close, and `late_return` entries only for a payment mined after the
deadline or after it (or, after the close, for a deposit not on the list), once each, without an amount; after the close only `settle`, `reveal` and `late_return` may follow. It refuses `late`, `refund`,
`coin`, `reveal` and `late_return` for every other campaign.

### 9.5 Deposits

A payment to the campaign counts as a deposit when it is mined from `start_height` to three blocks before the deadline
(`sealed::last_deposit_height`, `LATE_MARGIN_BLOCKS` = 3), carries a version 3 memo (§9.3), and
pays at least the smallest tranche. It counts as the largest tranche at or below what it pays. Payments are taken in chain order (height,
then position in the block, then txid and action). A payment that repeats the memo of an earlier deposit is a replay: it is a donation,
listed with a note. A payment the host rejected does not use up its memo, so a later payment with the same memo can still be the deposit.
The host rejects a payment that pays less than the tranche sealed in its memo (the one validity rule of §2, `payload::check`).

A payment with a version 3 memo mined in the last three blocks before the deadline (the deadline and the two blocks before it) or after it
is not a deposit: an early ticket expiring at the deadline cannot be built for it in time (found on the test network on 20 October 2026).
The host sends it back on its own, on the test and the main network alike: to the refund address in its memo, all of it minus the network fee (`refund_fee_zat`; 0.1 sent, 0.0999 back), from that
one note, within the ticket window of blocks, and names the return on the list (`late_return`). It does so whenever it sees one, also after
the close. A late payment that is not worth more than the fee, has no version 3 memo, or whose memo does not open with this auction's key
has no refund address the host can use, and stays (`sealed_recount::is_late_deposit` is the test both sides use).

The safety net: once the auction is closed, any deposit that has no early ticket and signed refund on the list, for whatever reason, is
sent back the same way (minus the fee, named by a `late_return` entry), so no edge case can keep someone's money. Such a deposit does not
bid; the recount still fails S2 for the missing tickets, and S7 checks it was sent back within the ticket window after the close.

### 9.6 Opening the bids and the outcome

After the deadline the host fetches round R's signature from drand quicknet (the four addresses of `DRAND_URLS`, in turn) and checks it
against the pinned public key; a signature that does not check is never used. The auction is void when round R came too early: when
`round_time(R)` is before the median time of blocks `deadline - 10` to `deadline` plus `GAP_SECS`. A void auction refunds every deposit.

Otherwise each deposit that was not taken back with its early ticket is opened. It is a valid bid when the lock opens with round R's
signature, ends with the marker, carries the tag of its own memo and tranche (§9.3), is at most its tranche minus the refund fee, and is at
least the reserve. A deposit mined after the coin cutoff is no bid either (it cannot get its coin in time; the bid page does not pay
after `deadline - ticket_k`). Anything else is no bid: its deposit is refunded. The winners are the `items` highest valid bids; a tie goes to the
earlier deposit. What each winner pays:

| Pricing | Price |
|---|---|
| `uniform` | everyone pays the lowest winning bid (the k-th highest bid) |
| `second` | everyone pays the highest losing bid (the (k+1)-th highest) |
| `pay_your_bid` | each winner pays their own bid |

With too few valid bids to set the price, the price is the reserve, or the lowest winning bid when there is no reserve. The same function
(`sealed_recount::plan_outcome`) is used by the host when it closes and by the recount.

A winner is settled by one transaction that spends the deposit, pays the price to the treasury and the rest, minus the refund fee, back to
the person who bid, mined after the deadline and by `claim_after`. Every other deposit goes back by its signed refund. A deposit still unspent after
`claim_after` goes back by its late ticket.

### 9.7 Recount

R1 and R2 are as §5, plus: a revealed viewing key must match `ufvk_hash`, and there is at most one `reveal`, after the close. Until the
viewing key is revealed, S1 to S8 wait. Then:

| Check | What it checks |
|---|---|
| S1 | every `issue` names a real deposit with its chain details, shows no amount, and its amount commitment opens with `amount_key`; every `reject` names a payment to the campaign; a reject is false when the person who bid publishes the memo's one-time secret and the payment meets the validity rule |
| S2 | every deposit's tickets were issued within `ticket_k` blocks |
| S3 | every deposit mined by the coin cutoff and still in the auction there got its coin: at least `coin_zat`, to the P2PKH address of the memo's page key, mined at or before the cutoff, in a transaction that spends none of the campaign's notes |
| S4 | before the deadline, a deposit was spent only by its early ticket (a withdrawal) |
| S5 | the close carries round R's real signature (or the auction is void exactly when §9.6 says so); the winners and price on the close are what the opened bids give; no accepted deposit copies the memo of a later payment that pays the tranche the bid was made for (the host would then have taken a smaller copy and kept the real deposit) |
| S6 | every winner was settled by its `settle` entry's transaction in the window, the treasury received exactly the price, and the entry's price, fee and excess match |
| S7 | every other deposit was spent only by its signed refund, or by its late ticket after `claim_after`; every payment too late to bid, and every deposit without tickets after the close, was spent by the return its `late_return` entry names, within the ticket window |
| S8 | the viewing key was revealed, and only after every settlement was mined |

The report adds `did_not_finish` (shown on the recount page and in the listing): the host had not closed by `claim_after`, or left a winner
to take the deposit back by the late ticket, or left a deposit unrefunded at `claim_after`, or had not revealed the viewing key by
`claim_after + ticket_k`.
