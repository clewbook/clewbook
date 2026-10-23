// The bid page when a cheating host hands out an early ticket that pays the host, sealed without opening values (set 2, C1), in
// a real browser, with the real relay serving the public list of auction E from the private chain check of the fixes (written
// before anyone took a deposit back, with the first payer's page state, to <run>/fixture-early) and a stand in chain server. It checks: the
// page cannot see who the early ticket pays, so it says NOT PROTECTED, says why, and offers no take back button.
// Run from the repository root with BIN=<folder with ll-relay> (FIXTURE=<run>/fixture-early for a fresh run; app/web/testdata/bid-early
// holds a copy): node app/web/bid-page-early-e2e.cjs
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const BIN = process.env.BIN || 'app/target-testnet/release';
const FIXTURE = process.env.FIXTURE || 'app/web/testdata/bid-early';
const WEB = 8815, RELAY = 18793, CHAIN = 18794;
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
const rules = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'relay', 'campaigns', FX.E, 'rules.json'), 'utf8'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-early-'));
  fs.cpSync(path.join(FIXTURE, 'relay'), tmp, { recursive: true });
  const relay = spawn(`${BIN}/ll-relay`, ['serve', '--allow-regtest', '--dir', tmp, '--listen', `127.0.0.1:${RELAY}`], { stdio: 'ignore' });
  const web = spawn('python3', ['-m', 'http.server', String(WEB), '--bind', '127.0.0.1', '--directory', process.env.WWW || 'app/web/www'], { stdio: 'ignore' });
  chainServer.listen(CHAIN, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext(), p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    const BASE = `http://127.0.0.1:${WEB}`;
    const st = { seed: FX.e1.seed, refund: FX.e1.refund, tranche: FX.e1.tranche, bid: FX.e1.bid, memo: FX.e1.memo, payTo: rules.pay_to, pageKey: 'x', qrSvg: '', paidZat: null };
    await p.goto(`${BASE}/brand.js`);
    await p.evaluate(({ id, s }) => localStorage.setItem(`ll:sealed:${id}`, JSON.stringify(s)), { id: FX.E, s: st });
    await p.goto(`${BASE}/bid.html#c=${FX.E}&relay=http://127.0.0.1:${RELAY}&server=http://127.0.0.1:${CHAIN}`);
    await p.waitForFunction(() => /does not check out|PROTECTED|Your bid does not count/.test(document.querySelector('#st-title').textContent), null, { timeout: 180000 }).catch(() => {});
    const title = await p.textContent('#st-title'), line = await p.textContent('#st-text'), text = `${line} ${await p.textContent('#st-more')}`;
    check('the page finds its deposit and its early ticket', !!(await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)).ticket, FX.E)));
    check('a ticket the page cannot see the payee of is not protected: a red problem card', title === 'Your ticket does not check out' && await p.$eval('#st-card', (c) => c.dataset.tone === 'r') && (await p.textContent('#st-tag')) === 'PROBLEM', title);
    check('it says why: it cannot see who the early ticket pays', /the early ticket: this page cannot see who it pays/.test(text), text.slice(0, 200));
    check('no take back button is offered for that ticket', await p.$eval('#take-back', (b) => b.hidden));
    check('the page does not tell the person to take the money back with it', line === 'This page cannot take your money back for you. Keep your backup file.', line);
    await ctx.close();
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
