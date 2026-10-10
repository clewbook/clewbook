// Independent check of vectors.json with libsodium.js (no Rust code involved).
// Usage: node check.cjs ../vectors.json js_out.json
const fs = require('fs');
const sodium = require('libsodium-wrappers-sumo');
// libsodium.js cannot hash a message with a personalization string, so labelled BLAKE2b
// uses @noble/hashes; sealed boxes, X25519 and Ed25519 use libsodium.js.
const { blake2b } = require('@noble/hashes/blake2b');

const fails = [];
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fails.push(name); };
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

(async () => {
  await sodium.ready;
  const s = sodium;
  const v = JSON.parse(fs.readFileSync(process.argv[2]));
  const hx = (h) => s.from_hex(h);
  const personal = (label) => { const p = new Uint8Array(16); p.set(s.from_string(label)); return p; };
  const h256 = (label, data) => blake2b(data, { dkLen: 32, personalization: personal(label) });
  const canonical = (x) => Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
    : (x !== null && typeof x === 'object') ? `{${Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',')}}`
    : JSON.stringify(x);
  const b64url = (u8) => Buffer.from(u8).toString('base64url');

  // Contributor keys: two independent keys and the memo one-time key, all from one seed.
  const seed = hx(v.contributor.seed);
  const signSeed = h256('ledgerlab_sign', seed);
  check('sign seed = BLAKE2b("ledgerlab_sign", seed)', eq(signSeed, hx(v.contributor.sign_seed)));
  check('sign_pk = Ed25519 from that seed', eq(s.crypto_sign_seed_keypair(signSeed).publicKey, hx(v.contributor.sign_pk)));
  const encSk = h256('ledgerlab_enc', seed);
  check('enc_sk = BLAKE2b("ledgerlab_enc", seed)', eq(encSk, hx(v.contributor.enc_sk)));
  check('enc_pk = X25519 base point * enc_sk', eq(s.crypto_scalarmult_base(encSk), hx(v.contributor.enc_pk)));
  const ephSk = h256('ledgerlab_eph', seed);
  check('eph_sk = BLAKE2b("ledgerlab_eph", seed)', eq(ephSk, hx(v.contributor.eph_sk)));
  const ephPk = s.crypto_scalarmult_base(ephSk);
  check('eph_pk = X25519 base point * eph_sk', eq(ephPk, hx(v.contributor.eph_pk)));
  check('campaign payload_pk from payload_sk', eq(s.crypto_scalarmult_base(hx(v.campaign.payload_sk)), hx(v.campaign.payload_pk)));
  check('campaign ledger_pk from ledger seed', eq(s.crypto_sign_seed_keypair(hx(v.campaign.ledger_seed)).publicKey, hx(v.campaign.ledger_pk)));

  // Rules: canonical JSON and rules_id.
  check('canonical rules JSON', canonical(v.rules.object) === v.rules.canonical);
  const rulesId = h256('ledgerlab_rules', s.from_string(v.rules.canonical));
  check('rules_id', eq(rulesId, hx(v.rules.rules_id)));

  // Memo payload: rebuild the deterministic sealed box from scratch.
  const plaintext = new Uint8Array([0x01, ...rulesId, ...hx(v.contributor.sign_pk), ...hx(v.contributor.enc_pk),
    v.payload.refund_typecode, ...hx(v.payload.refund_receiver)]);
  check('payload plaintext is 141 bytes', plaintext.length === 141);
  const payloadPk = hx(v.campaign.payload_pk);
  const nonce = s.crypto_generichash(24, new Uint8Array([...ephPk, ...payloadPk]), null);
  const sealed = new Uint8Array([...ephPk, ...s.crypto_box_easy(plaintext, nonce, payloadPk, ephSk)]);
  check('sealed memo bytes identical (derived one-time key)', eq(sealed, hx(v.payload.sealed)));
  const memo = 'LL1:' + b64url(sealed);
  check('memo text identical (256 chars)', memo === v.payload.memo && memo.length === 256);
  check('campaign opens it with crypto_box_seal_open',
    eq(s.crypto_box_seal_open(sealed, payloadPk, hx(v.campaign.payload_sk)), plaintext));
  check('anyone opens it with the published one-time key (challenge)',
    eq(s.crypto_box_open_easy(sealed.slice(32), nonce, payloadPk, ephSk), plaintext));

  // Payload version 2 (amount sealed in): version byte 2, the same fields, then the amount as 8 little-endian bytes
  const amt = new Uint8Array(8); new DataView(amt.buffer).setBigUint64(0, BigInt(v.payload_v2.amount_zat), true);
  const plaintext2 = new Uint8Array([0x02, ...rulesId, ...hx(v.contributor.sign_pk), ...hx(v.contributor.enc_pk), v.payload.refund_typecode, ...hx(v.payload.refund_receiver), ...amt]);
  check('payload v2 plaintext is 149 bytes', plaintext2.length === 149);
  const sealed2 = new Uint8Array([...ephPk, ...s.crypto_box_easy(plaintext2, nonce, payloadPk, ephSk)]);
  check('sealed v2 memo bytes identical (derived one-time key)', eq(sealed2, hx(v.payload_v2.sealed)));
  const memo2 = 'LL1:' + b64url(sealed2);
  check('v2 memo text identical (267 chars)', memo2 === v.payload_v2.memo && memo2.length === 267);
  check('campaign opens the v2 memo with crypto_box_seal_open', eq(s.crypto_box_seal_open(sealed2, payloadPk, hx(v.campaign.payload_sk)), plaintext2));

  // Ledger entry: Ed25519 signature over canonical JSON, deterministic; entry hash.
  const ledger = s.crypto_sign_seed_keypair(hx(v.campaign.ledger_seed));
  const unsigned = s.from_string(v.entry.canonical_unsigned);
  check('ledger signature verifies', s.crypto_sign_verify_detached(hx(v.entry.sig), unsigned, ledger.publicKey));
  check('ledger signature identical when recomputed', eq(s.crypto_sign_detached(unsigned, ledger.privateKey), hx(v.entry.sig)));
  check('entry_hash', eq(h256('ledgerlab_entry', s.from_string(v.entry.canonical_signed)), hx(v.entry.entry_hash)));

  // Ticket: Rust's random sealed box opens in libsodium.
  const blob = hx(v.ticket.blob);
  check('ticket blob (Rust crypto_box seal) opens with crypto_box_seal_open',
    eq(s.crypto_box_seal_open(blob, hx(v.contributor.enc_pk), encSk), hx(v.ticket.raw_tx)));
  check('blob_hash', eq(h256('ledgerlab_blob', blob), hx(v.ticket.blob_hash)));

  // Ticket format version 2 (SPEC §3.1): "LLT2" || u32le(len raw) || raw || u8 action || u64le value || rseed[32]
  const t2 = v.ticket_v2, rawTx = hx(v.ticket.raw_tx);
  const le32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const le64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
  const buildV2 = () => new Uint8Array([...s.from_string('LLT2'), ...le32(rawTx.length), ...rawTx, t2.opening.action, ...le64(t2.opening.value_zat), ...hx(t2.opening.rseed)]);
  check('ticket v2 plaintext built independently in JavaScript equals Rust\'s bytes', eq(buildV2(), hx(t2.plaintext)));
  check('ticket v2 blob (Rust seal) opens with crypto_box_seal_open to that plaintext', eq(s.crypto_box_seal_open(hx(t2.blob), hx(v.contributor.enc_pk), encSk), hx(t2.plaintext)));
  check('a version 1 ticket (raw transaction only) does not start with the version 2 marker', !eq(rawTx.slice(0, 4), s.from_string('LLT2')));

  // Other hashes.
  const a = v.hashes.amount_commit;
  const value = new Uint8Array(8); new DataView(value.buffer).setBigUint64(0, BigInt(a.value_zat), true);
  check('amount_commit', eq(h256('ledgerlab_amount', new Uint8Array([...hx(a.amount_key), ...hx(a.nf), ...value])), hx(a.commit)));
  check('ufvk_hash', eq(h256('ledgerlab_ufvk', s.from_string(v.hashes.ufvk_hash.ufvk)), hx(v.hashes.ufvk_hash.hash)));

  // The other direction: libsodium seals, Rust must open (see `ll-vectors verify-js`).
  fs.writeFileSync(process.argv[3], JSON.stringify({
    js_memo: 'LL1:' + b64url(s.crypto_box_seal(plaintext, payloadPk)),
    js_deterministic_memo: memo,
    js_deterministic_memo_v2: memo2,
    eph_sk: v.contributor.eph_sk,
    js_ticket_blob: s.to_hex(s.crypto_box_seal(hx(v.ticket.raw_tx), hx(v.contributor.enc_pk))),
    js_ticket_v2_blob: s.to_hex(s.crypto_box_seal(buildV2(), hx(v.contributor.enc_pk))),
    expected_raw_tx: v.ticket.raw_tx,
  }, null, 2));
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS: libsodium.js reproduces every value');
  process.exit(fails.length ? 1 : 0);
})();
