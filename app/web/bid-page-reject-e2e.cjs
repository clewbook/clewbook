// The bid page when the host rejects a valid deposit (the independent review, H3), in a real browser, with the real relay serving the public
// list of auction A from the private chain check of the review fixes (app/regtest/check-sealed-review.sh writes it, with the rejected
// payer's page state, to <run>/fixture) and a stand in for the chain server (tip and block times only). It checks: the page finds the
// reject by its memo hash and says so plainly, with the return the host sent on its own; no payment card invites a second payment; the
// "publish proof" button sends the challenge to the relay, which takes it, and the page says so; the button is gone once every relay has it.
// Run from the repository root with BIN=<folder with ll-relay> (FIXTURE=<run>/fixture for a fresh run; app/web/testdata/bid-reject
// holds a copy): node app/web/bid-page-reject-e2e.cjs
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const BIN = process.env.BIN || 'app/target-testnet/release';
const FIXTURE = process.env.FIXTURE || 'app/web/testdata/bid-reject';
const WEB = 8814, RELAY = 18795, CHAIN = 18796;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const FX = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'fixture.json'), 'utf8'));

function varint(n) { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; }
const fv = (f, n) => [...varint((f << 3) | 0), ...varint(n)];
const fb = (f, bytes) => [...varint((f << 3) | 2), ...varint(bytes.length), ...bytes];
function fields(buf) {
  const out = {}; let i = 0;
  const rv = () => { let v = 0n, s = 0n, b; do { b = buf[i++]; v |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); return v; };
  while (i < buf.length) {
    const k = Number(rv()), f = k >> 3, wt = k & 7;
    let v;
    if (wt === 0) v = Number(rv()); else if (wt === 2) { const n = Number(rv()); v = buf.subarray(i, i + n); i += n; } else break;
    (out[f] = out[f] || []).push(v);
  }
  return out;
}
const rules = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'relay', 'campaigns', FX.A, 'rules.json'), 'utf8'));
const chain = { tip: rules.deadline_height - 20 };
function answer(method, req) {
  const F = fields(req);
  switch (method) {
    case 'GetLatestBlock': return { msgs: [fv(1, chain.tip)] };
    case 'GetBlockRange': {
      const s = fields(F[1][0])[1][0], e = fields(F[2][0])[1][0], msgs = [];
      for (let h = s; h <= e; h++) msgs.push([...fv(2, h), ...fv(5, 1296688603 + h * 75)]);
      return { msgs };
    }
    case 'GetLightdInfo': return { msgs: [[...fb(6, Buffer.from('77190ad9')), ...fv(7, chain.tip)]] };
    default: return { status: 5, msgs: [] };
  }
}
const chainServer = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-grpc-web,x-user-agent', 'access-control-expose-headers': 'grpc-status,grpc-message' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const msg = Buffer.concat(chunks).subarray(5);
    const { msgs, status = 0 } = answer(req.url.split('/').pop(), msg);
    const frames = [];
    for (const m of msgs) { const b = Buffer.from(m), h = Buffer.alloc(5); h.writeUInt32BE(b.length, 1); frames.push(h, b); }
    const t = Buffer.from(`grpc-status:${status}\r\ngrpc-message:${status ? 'not found' : 'OK'}\r\n`), th = Buffer.alloc(5); th[0] = 0x80; th.writeUInt32BE(t.length, 1);
    frames.push(th, t);
    res.writeHead(200, { ...cors, 'content-type': 'application/grpc-web+proto' });
    res.end(Buffer.concat(frames));
  });
});

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-reject-'));
  fs.cpSync(path.join(FIXTURE, 'relay'), tmp, { recursive: true });
  const relay = spawn(`${BIN}/ll-relay`, ['serve', '--allow-regtest', '--dir', tmp, '--listen', `127.0.0.1:${RELAY}`], { stdio: 'ignore' });
  const web = spawn('python3', ['-m', 'http.server', String(WEB), '--bind', '127.0.0.1', '--directory', 'app/web/www'], { stdio: 'ignore' });
  chainServer.listen(CHAIN, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext(), p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    const BASE = `http://127.0.0.1:${WEB}`;
    const st = { seed: FX.a3.seed, refund: FX.a3.refund, tranche: FX.a3.tranche, bid: FX.a3.bid, memo: FX.a3.memo, payTo: rules.pay_to, pageKey: 'x', qrSvg: '', paidZat: null };
    await p.goto(`${BASE}/brand.js`);
    await p.evaluate(({ id, s }) => localStorage.setItem(`ll:sealed:${id}`, JSON.stringify(s)), { id: FX.A, s: st });
    await p.goto(`${BASE}/bid.html#c=${FX.A}&relay=http://127.0.0.1:${RELAY}&server=http://127.0.0.1:${CHAIN}`);
    await p.waitForFunction(() => /rejected your payment/.test(document.querySelector('#st-title').textContent), null, { timeout: 60000 });
    const text = `${await p.textContent('#st-text')} ${await p.textContent('#st-more')}`;
    check('the page finds the reject by its memo hash and says the host rejected the payment', (await p.textContent('#st-title')) === 'The host rejected your payment' && (await p.textContent('#st-tag')) === 'REJECTED', text.slice(0, 140));
    check('it names the return the host sent on its own, minus the fee', /It was sent back to you, minus the fee/.test(text) && /transaction [0-9a-f]{64}/.test(text), text.slice(0, 260));
    check('no payment card asks for a second payment', await p.$eval('#pay-card', (e) => e.hidden));
    check('it offers to publish proof, and says what that shows', !(await p.$eval('#challenge', (b) => b.hidden)) && /shows everyone your refund address/.test(text));
    await p.click('#challenge');
    await p.waitForFunction(() => /You published proof that it was valid/.test(document.querySelector('#st-more').textContent), null, { timeout: 30000 });
    const got = await (await fetch(`http://127.0.0.1:${RELAY}/v1/campaigns/${FX.A}/challenges`)).json();
    const rej = JSON.parse(fs.readFileSync(path.join(tmp, 'campaigns', FX.A, 'ledger', fs.readdirSync(path.join(tmp, 'campaigns', FX.A, 'ledger')).sort().find((f) => JSON.parse(fs.readFileSync(path.join(tmp, 'campaigns', FX.A, 'ledger', f), 'utf8')).kind === 'reject')), 'utf8'));
    check('the relay took the challenge for the rejected payment', Array.isArray(got) && got.some((c) => c.txid === rej.contribution.txid && c.action === rej.contribution.action && /^[0-9a-f]{64}$/.test(c.eph_sk)), JSON.stringify(got).slice(0, 160));
    check('the page says so, and the button is gone once every relay has it', await p.$eval('#challenge', (b) => b.hidden));
    await ctx.close();
    // the second review, M1: a5 paid 0.31 with a memo for the 0.3 deposit; its tickets pay back 0.31 minus the fee, and the page accepts them
    // (before, it expected exactly 0.3 minus the fee and said the host's honest ticket did not check out)
    if (FX.a5) {
      const c5 = await browser.newContext(), q = await c5.newPage();
      q.on('pageerror', (e) => errors.push(String(e)));
      const s5 = { seed: FX.a5.seed, refund: FX.a5.refund, tranche: FX.a5.tranche, bid: FX.a5.bid, memo: FX.a5.memo, payTo: rules.pay_to, pageKey: 'x', qrSvg: '', paidZat: null };
      await q.goto(`${BASE}/brand.js`);
      await q.evaluate(({ id, s }) => localStorage.setItem(`ll:sealed:${id}`, JSON.stringify(s)), { id: FX.A, s: s5 });
      await q.goto(`${BASE}/bid.html#c=${FX.A}&relay=http://127.0.0.1:${RELAY}&server=http://127.0.0.1:${CHAIN}`);
      await q.waitForFunction((id) => { const st = JSON.parse(localStorage.getItem(`ll:sealed:${id}`)); return st && st.ticketsChecked; }, FX.A, { timeout: 180000 }).catch(() => {});
      const st = await q.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)), FX.A);
      check('second review M1: a deposit that paid more than its size: its tickets check out, and the page knows what was paid', st.ticketsChecked && st.ticketsChecked.ok && st.paidZat === FX.a5.paid, JSON.stringify(st.ticketsChecked && st.ticketsChecked.problems) + ` paid ${st.paidZat}`);
      await c5.close();
    }
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  } catch (e) {
    check('run', false, String(e).slice(0, 300));
  } finally {
    await browser.close();
    relay.kill(); web.kill(); chainServer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
