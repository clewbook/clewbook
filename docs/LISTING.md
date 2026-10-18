# The listing job (operator reference)

The home page of app.clewbook.xyz lists two kinds of campaigns:

- the **fixed entries**: the project's own campaigns, in a hand kept list that only the operator edits;
- the campaigns of **approved hosts**: hosts send a signed listing request, the listing job checks it, and the operator approves the host key.

The job is `cb-listing` (crate `app/listing`). Hosts send their requests with the **Submit for listing** button on the host dashboard, or with `cb-host host-key` and `cb-host listing-record` (see `docs/HOSTING.md` section 7). The job lists **testnet only**. A mainnet request is accepted and kept in the queue, marked as mainnet, but it is never listed or recounted until mainnet listing is switched on explicitly. It is not switched on (see "Mainnet" below and `app/listing/MAINNET-REVIEW.md`).

Tests: `app/listing/tests/e2e.rs`, `app/listing/tests/recount.rs` and the unit tests in `app/listing/src` (`cargo test -p ll-listing` in `app`).

## How it works

1. A host sends a **listing record** to `POST https://listing.clewbook.xyz/v1/records`. The endpoint checks the size, the shape and both signatures, applies the caps, and stores the record. It never fetches anything because of a request.
2. Every 10 minutes a **pass** reads every stored record and decides for each:
   - listed;
   - queued (the host key is not approved yet);
   - checking (it waits for its first recount);
   - waiting for mainnet (a mainnet record while mainnet listing is off);
   - refused (with the reason);
   - hidden, revoked or expired.
3. The pass writes, each file atomically:
   - `out/campaigns.json`, the combined list for the home page;
   - `out/status.json`, why each record and each fixed entry is where it is, with its last recount;
   - `out/queue.json`, the hosts waiting for approval, the mainnet records waiting for mainnet listing, and listed campaigns flagged "attention".
4. The operator approves a host key with a **label**. From the next pass on, that host's campaigns that pass every check are listed.

## The listing record

A JSON object (at most 4096 bytes, unknown fields refused):

| field | meaning |
|---|---|
| `v`, `kind` | `1`, `"clewbook-listing"` |
| `campaign` | the campaign id (64 lowercase hex): the hash of its rules |
| `network` | `"test"` or `"main"`, as in the rules |
| `relays` | 1 to 4 relay addresses (https, at most 200 characters each) |
| `host_pubkey` | the host's long lived public key (64 hex) |
| `ledger_pubkey` | the campaign's ledger key (64 hex); must equal `ledger_pubkey` in its rules |
| `created` | unix seconds |
| `host_sig`, `ledger_sig` | two signatures over the same bytes |

**Signatures.** Both keys sign the domain tag `clewbook_listing_record_v1\n` followed by the canonical JSON of the record without its two signatures. The tag is never valid JSON, so neither signature can be taken for a ledger entry, a heartbeat or anything else these keys sign.

**Fingerprint.** A host key's fingerprint is BLAKE2b-256 of the key's hex text, personalised `clewbook_hostfp\0`. Its first 10 bytes are shown in groups of four hex digits.

The record carries **no label**: a record with a `label` field is refused (`listing_end_to_end`). Labels come only from the operator's approved hosts file.

## The checks, in order

1. **At submission:**
   - size, shape, both signatures;
   - not revoked and not hidden;
   - at most 10 records per host key, 1000 in all, 200 from hosts not approved;
   - a newer record for the same campaign replaces the older one.
2. **Each pass, for each record:**
   - **Hidden or revoked**: not fetched at all.
   - **Expiry**: a record whose host was never approved is removed after 7 days (`--queue-days`). The queue shows how long each entry has left. A mainnet record waiting for mainnet listing never expires; its 7 days start when mainnet listing opens.
   - **Mainnet while mainnet listing is off**: the record is kept and shown as `waiting_mainnet`, approved host or not. Its relays are read only to check that they serve its rules and to get its name, so the name checks can be reported early; no chain height is read, no deadline is checked, nothing is recounted and nothing is listed. At most 100 such records are kept (`--max-mainnet-waiting`); further mainnet requests are refused at submission until there is room. They also count toward the existing caps (10 per host key, 1000 in all).
   - **The relays**: every relay named must serve rules that hash to the campaign id, carry the record's ledger key and network, and pass the rules' own validation. At least one must answer, and every relay that answers must pass.
   - **The network**: only `test` unless mainnet is allowed.
   - **The deadline**: it must still be ahead, but only before the campaign is first listed. A listed campaign stays listed after its deadline, as a closed campaign.
   - **Mainnet only (when allowed)**: the campaign's whole life must end before the NU7 activation height. That is its deadline, ticket window, close grace, re-issue window and 50 blocks of margin, the same formula as cb-host's own guard.
3. **Names**, for campaigns of approved hosts:
   - The comparison form of a name folds case and accents, maps Cyrillic and Greek look-alikes, digits that pass for letters, "rn"/"m", "vv"/"w" and "cl"/"d", and drops everything but letters and digits.
   - Two names collide when these forms are equal or one or two edits apart, depending on length.
   - The word Clewbook, in any spelling (built in), and the names and words in `reserved.txt` are refused. Any other reserved word lives only in `reserved.txt` on the server, never in the code. Labels are not checked against `reserved.txt`: only the operator writes them.
   - A campaign already listed keeps its place. Newcomers that look alike are all refused until the operator hides one.
   - Letters outside plain Latin are named in the queue.
4. **The recount check**:
   - A campaign is listed for the first time only after a recount over the ledger its relays show now passes every check that can run.
   - The recount is the real one: the browser's recount module (`app/web`), compiled natively and given the relays' ledger and the public chain. It runs the same `ll_core::recount` as `cb-recount` and the recount page.
   - A fundraiser gets the full recount: R1 to R8 and R4b, plus R9 to R12 for a uniform-price auction.
   - An auction before its close keeps its viewing key sealed. Only R1 (the rules are the committed ones) and R2 (the signed list is intact) run; the other checks are reported as waiting. The full recount runs once the close entry reveals the key.
   - Every relay that answers must show the same intact, signed ledger. If they disagree, or none has an intact ledger, there is no verdict and nothing new is listed.
   - A server that does not answer is not a verdict. The last result is kept and the recount is tried again on the next pass.
   - Tests in `app/listing/tests/recount.rs`:
     - a clean campaign is listed;
     - a tampered entry, a forged entry and a broken entry chain are refused;
     - a late ticket (R4b) and a missing ticket (R4) are refused;
     - relays that disagree give no listing;
     - a recount over its time limit gives no listing;
     - a sealed auction gets R1 and R2, and the full recount at its close.
5. **The attention flag**:
   - A campaign that is already listed and later fails its recount is **not removed**.
   - It is flagged in `out/status.json` and appears in the queue output as `ATTENTION`, with the failing rule and since when. A failure with no verdict also flags it when trying again will not fix it, such as relays that disagree or a limit that was hit.
   - The operator decides whether to hide it. The home page does not show the flag.
   - Test: `a_listed_campaign_that_later_fails_is_flagged_not_removed`.
6. **Fixed entries**: never checked for listing and never removed; the network rule does not apply to them. Their recount runs for information and is shown in `out/status.json` (`fixed_entries_show_their_recount_and_are_never_removed`).

**Recount limits** (options of `cb-listing run` and `cb-listing serve`):

| Limit | Default |
|---|---|
| Recounts at a time | one |
| Recounts per pass | 2 (`--recounts-per-pass`) |
| Time per recount | 600 s (`--recount-seconds`) |
| Blocks per recount | 20,000 (`--recount-max-blocks`) |
| Recheck of a submitted listed campaign | every 6 h (`--recheck-hours`) |
| Recheck of a fixed entry | every 24 h (`--recheck-fixed-hours`) |

- Order: new campaigns of approved hosts first, then listed campaigns that are due, then testnet records waiting for approval (for the operator's information), then the fixed entries.
- A **mainnet** record is never recounted while mainnet listing is off, nor while its host is not approved.
- Results are cached by ledger head and close state: nothing is recounted unless one of them moved, or the recheck time has passed. The recheck time matters because a payment the host ignores does not move the ledger.
- Measured on 16 October 2026 against public servers: 2,300 to 5,400 blocks took 45 to 98 s and 4 to 11 MB of compact blocks, with about 2 kB from the relay.

## Hardening

**Fetching from strangers' relays** (`app/listing/src/fetch.rs`, test `listing_end_to_end` part 7 and 8). The relay addresses come from records anyone can send, so every request:
- uses https only;
- resolves the name itself and refuses it if any address is loopback, private, link local, carrier grade NAT, documentation, multicast or otherwise not public;
- follows no redirect;
- has a 5 s connect and a 10 s total timeout (30 s for a ledger);
- reads at most 64 kB (8 MB for a ledger);
- refuses addresses with a user name or password in them.

**The chain server** is always one the operator chooses (`--chain-server`, `--chain-server-main`), never an address from a record.

**The endpoint** (`app/listing/src/serve.rs`, test `the_endpoint_limits_size_and_rate_and_only_stores`):
- answers 413 to a body over 4 KB, which it does not read further;
- handles one request at a time;
- allows at most 10 requests a minute per source address, then answers 429.

  The source is the address the tunnel passes on (`CF-Connecting-IP`), trusted only when the connection comes from the server itself. A request from the server itself without that header counts as one source, "local". Cloudflare refuses any request that carries a faked `CF-Connecting-IP` (checked from outside on 16 October 2026: 403).

**Labels:**
- plain text, 1 to 60 characters;
- no `#`, `<`, `>`, control, invisible or direction characters;
- not the word Clewbook in any spelling;
- not a look-alike of another approved host's label.

## The service on the server

| | |
|---|---|
| unit | `clewbook-listing.service` (enabled, `Restart=always`) |
| program | `/opt/clewbook-listing/cb-listing` (owned by root) |
| user | `clewbook-listing` (system user, no login shell, no sudo) |
| data folder | `/var/lib/clewbook-listing` (the only folder it may write) |
| hand kept list | `/etc/clewbook-listing/hand-campaigns.json` (owned by the operator's account, read only for the job) |
| listens on | `127.0.0.1:8795`, published as `https://listing.clewbook.xyz` through the server's tunnel |
| command | `cb-listing --dir /var/lib/clewbook-listing serve --hand-list /etc/clewbook-listing/hand-campaigns.json --listen 127.0.0.1:8795` |

**Sandbox:**
- `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`;
- the kernel and clock protections;
- an empty capability set;
- `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK`, `SystemCallFilter=@system-service`, `MemoryDenyWriteExecute`;
- `MemoryMax=256M`, `TasksMax=64`;
- a log rate limit of 200 lines a minute (the system journal rotates the log).

On 16 October 2026 it used 14 MB of memory at its peak.

**The data folder:**

| | |
|---|---|
| `records/` | stored records |
| `approved_hosts.txt` | key, then label |
| `revoked_hosts.txt`, `hidden.txt` | revoked host keys; hidden campaign ids or host keys |
| `reserved.txt` | names no campaign may look like; a line `contains:<word>` refuses any name containing that word; a line `relay:<word>` refuses any relay address containing that word (put a longer word before a shorter one it contains, so the reason names it) |
| `state/seen.json`, `state/recount.json` | what the job remembers between passes |
| `out/campaigns.json`, `out/status.json`, `out/queue.json` | the outputs |

**The hand kept list** has the form `{"campaigns":[{"id":"<64 hex>","relays":["https://..."]}]}`. The job only reads it.
- Its entries come first in `out/campaigns.json`, exactly as written. When nothing else is listed, `out/campaigns.json` is a byte for byte copy of it (`the_hand_list_closed_campaigns_and_queue_expiry`).
- If the file is missing or broken, the pass writes nothing, so the home page keeps its last good list and the health check turns 503.

## Operator commands

Run on the server. From another computer, put `ssh <server>` in front; quote a label as `"... --label 'My Label'"`. Name a host by its fingerprint without spaces, or by its full key.

```
L="sudo -u clewbook-listing /opt/clewbook-listing/cb-listing --dir /var/lib/clewbook-listing"
$L queue                                   # hosts waiting for approval, MAINNET records waiting, and ATTENTION items
$L approve <fingerprint> --label 'Garden Collective'
$L label <fingerprint> 'New Label'         # change a label
$L hide <campaign id>                      # or a fingerprint: every campaign of that host
$L unhide <campaign id>
$L revoke <fingerprint>                    # its campaigns disappear; approve again to undo
$L status                                  # why each record and fixed entry is where it is
$L run --hand-list /etc/clewbook-listing/hand-campaigns.json   # a pass now
$L recount <campaign id> --relay https://<relay> --network test   # one recount now, read only, prints JSON
nano /etc/clewbook-listing/hand-campaigns.json                    # edit the hand kept list
python3 -m json.tool /etc/clewbook-listing/hand-campaigns.json > /dev/null && echo "valid JSON"
```

Changes show on the next pass, or at once after `run`.

## Health

`https://listing.clewbook.xyz/v1/health` answers:
- 200 with the time, block and summary of the last good pass;
- 503 when there was none in the last three intervals plus a minute (about 31 minutes).

Also `systemctl status clewbook-listing` and `journalctl -u clewbook-listing`.

## The home page switch

The page server serves `campaigns.json` from its `www` folder. On our server that file is a symlink to the job's output, so the home page shows the combined list.

**Switch** (as the page server's user; `W` is the `www` folder):

```
cmp $W/campaigns.json /etc/clewbook-listing/hand-campaigns.json
cp -p $W/campaigns.json <outside www>/campaigns.json.before-listing
ln -s /var/lib/clewbook-listing/out/campaigns.json $W/campaigns.json.new && mv -T $W/campaigns.json.new $W/campaigns.json
```

The `cmp` line checks that the hand kept list is current; it must print nothing. The `mv -T` swaps the file in one step, so there is no moment when the file is missing.

**Rollback** (one line): either the copy from before the switch, or the hand kept list if it was edited since:

```
cp -p <outside www>/campaigns.json.before-listing $W/campaigns.json.new && mv -T $W/campaigns.json.new $W/campaigns.json
cp /etc/clewbook-listing/hand-campaigns.json $W/campaigns.json.new && mv -T $W/campaigns.json.new $W/campaigns.json
```

Undo the switch before removing the listing service, or the symlink points at nothing and the home page lists nothing. A page sync to the server must keep skipping `campaigns.json`.

## Telegram notices

Optional. When a new request enters the queue (testnet, waiting for approval, or mainnet, waiting for mainnet listing), the endpoint's pass sends one Telegram message to the operator: the network, the campaign's name and short id, the host fingerprint, whether the host is already approved, and the approve command to copy. Several new requests in one pass share one message (ten spelled out, the rest counted); each request is named in one delivered message at most; at most 20 messages go out in any hour (`--telegram-per-hour`), and requests over that wait for the next message. When the pass fails three times in a row, one message says so.

- **Settings live only on the server**: `/etc/clewbook-listing/telegram.conf` (`--telegram-conf`), owned by the listing user, mode 600, with the lines `token=<bot token>` and `chat_id=<chat id>`. Without the file the notices are off; a file others can read is refused. It is read for every notice, so a change needs no restart.
- **The token is never logged or printed.** An error names only an HTTP status, or says Telegram could not be reached.
- **Telegram never holds up a pass**: messages go out from a thread of their own, with a 10 second limit. A failed message is tried on the next pass, at most three times per request.
- `cb-listing telegram-test` sends one test message with the conf file.
- Tests: the unit tests in `app/listing/src/notify.rs`, against a stand in for the Telegram API on this computer.

## Mainnet

Off. `--network main` refuses to start without both `--confirm-mainnet-listing` and `--nu7-mainnet-height` (the published NU7 activation height, not published yet); these two switches are the only way to turn it on. Until then mainnet requests are accepted and wait in the queue (see "Each pass" above). Approving a host is allowed meanwhile; its mainnet campaigns still wait. Once mainnet listing is on, each waiting record is decided like any other on the next pass. The review of what mainnet would need is `app/listing/MAINNET-REVIEW.md`.

**Status lookup.** `GET /v1/records/<campaign id>` answers with the request's state from the last pass and a plain reason, nothing else: `Waiting` (received, or waiting for approval, or waiting for its first recount), `Listed`, `Not listed` (with the reason: refused, expired, hidden or revoked), or `Waiting for mainnet listing to open`; `Not found` when there is no request for that campaign. It counts toward the same per source limit as submissions. The dashboard's **Check status** button calls it.

## Known limits

- **One chain server per network.** The recount page compares up to three; a dishonest chain server could hide payments.
- **Every recount scans from the campaign's start height.** A campaign longer than 20,000 blocks (about 17 days of mainnet) gets no verdict.
- **The home page shows neither the host's label nor the attention flag.** The label is in `out/campaigns.json` for a page that wants it.
- **Look-alike letters** from scripts outside the comparison table (for example Armenian) are not caught. A campaign name is not compared with host labels.
- **The endpoint trusts `CF-Connecting-IP` from the server itself,** so an account on the server can make any number of requests.
- **The browser module was built for a browser.** Its error paths stop with a panic outside one; the job catches it, and the log shows a line.
- **Untested with a real chain:** the job's full scan of a testnet campaign, an auction after its close, and a uniform-price auction's treasury.
