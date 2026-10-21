// The bid page warns at once when a bid is higher than the chosen deposit allows (the deposit minus the refund fee), as the contribute page does
// for an amount: the bid box glows red, one short line under it names the smallest deposit that fits (or says none does), and "Create my
// payment" waits. The deposit is never changed for the person. In a headless browser against the real relay serving app/web/testdata/bid-page
// (private chain data) and a stand in for the chain server (tip and block times only).
// Run from the repository root with BIN=<folder with ll-relay>: node app/web/bid-too-high-e2e.cjs
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const BIN = process.env.BIN || 'app/target-review/release';
const WEB = 8818, RELAY = 18798, CHAIN = 18799;
const ID = '704e2910a0b57876256ec55fb0a0599bb4a54750889bd673f16a6e009d3cfab6'; // open, deposits 0.1 and 0.3, fee 0.0001
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

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
const chain = { tip: 120 };
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-too-high-'));
  fs.cpSync('app/web/testdata/bid-page/relay', tmp, { recursive: true });
  const relay = spawn(`${BIN}/ll-relay`, ['serve', '--allow-regtest', '--dir', tmp, '--listen', `127.0.0.1:${RELAY}`], { stdio: 'ignore' });
  const web = spawn('python3', ['-m', 'http.server', String(WEB), '--bind', '127.0.0.1', '--directory', 'app/web/www'], { stdio: 'ignore' });
  chainServer.listen(CHAIN, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  try {
    const p = await (await browser.newContext()).newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`http://127.0.0.1:${WEB}/bid.html#c=${ID}&relay=http://127.0.0.1:${RELAY}&server=http://127.0.0.1:${CHAIN}`);
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 30000 });
    await p.waitForFunction(() => !document.querySelector('#create').disabled, null, { timeout: 30000 });
    const look = async () => p.evaluate(() => ({
      msg: document.querySelector('#bid-error').hidden ? '' : document.querySelector('#bid-error').textContent,
      hint: !document.querySelector('#bid-hint').hidden, red: document.querySelector('.amountbox').classList.contains('bad'),
      invalid: document.querySelector('#bid').getAttribute('aria-invalid') === 'true', off: document.querySelector('#create').disabled,
      deposit: document.querySelector('#tranche').value,
    }));
    await p.selectOption('#tranche', '10000000');
    await p.fill('#bid', '0.0999');
    let s = await look();
    check('a bid within the deposit: no line, no glow, the button is on', !s.msg && !s.red && !s.off && s.hint, JSON.stringify(s));
    await p.fill('#bid', '0.15');
    s = await look();
    check('too high for this deposit: the line names the smallest deposit that fits', /^Too high for this deposit\. Pick 0\.3 \S+ or lower your bid\.$/.test(s.msg), s.msg);
    check('the bid box glows red, the grey hint gives way, the button waits', s.red && s.invalid && !s.hint && s.off, JSON.stringify(s));
    check('the deposit is never changed for the person', s.deposit === '10000000', s.deposit);
    await p.selectOption('#tranche', '30000000');
    s = await look();
    check('picking the larger deposit clears it at once', !s.msg && !s.red && !s.off, JSON.stringify(s));
    await p.fill('#bid', '0.5');
    s = await look();
    check('a bid no deposit allows says so', /^Too high for any deposit here\. Lower your bid to 0\.2999 \S+ or less\.$/.test(s.msg) && s.off, s.msg);
    await p.fill('#bid', '0.3');
    s = await look();
    check('a bid equal to the deposit is too high (the fee comes off)', s.off && /Too high/.test(s.msg), s.msg);
    await p.fill('#bid', '0.2999');
    s = await look();
    check('the deposit minus the fee is allowed', !s.msg && !s.off, JSON.stringify(s));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('the test ran to the end', false, String(e).slice(0, 300));
  } finally {
    await browser.close();
    relay.kill(); web.kill(); chainServer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
})();
