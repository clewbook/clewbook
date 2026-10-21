// The bid page warns at once when a bid is higher than the chosen deposit allows (the deposit minus the refund fee), as the contribute page does
// for an amount: the bid box glows red, the chosen deposit card turns red, one short line under it names the limit (the deposit minus the
// fee) and, if there is one, says to pick a bigger deposit, and "Create my payment" waits (design handoff of 21 Oct 2026). The deposit is never changed for the person. In a headless browser against the real relay serving app/web/testdata/bid-page
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
    await p.waitForSelector('#tranche [role=radio]', { timeout: 30000 });
    check('the button waits while the bid and the refund address are empty', await p.$eval('#create', (x) => x.disabled));
    const look = async () => p.evaluate(() => ({
      msg: document.querySelector('#bid-error').hidden ? '' : document.querySelector('#bid-error').textContent,
      hint: !document.querySelector('#bid-hint').hidden, red: document.querySelector('#bidbox').classList.contains('bad'),
      card: [...document.querySelectorAll('#tranche [role=radio]')].filter((c) => c.classList.contains('bad')).map((c) => c.dataset.zat).join(','),
      invalid: document.querySelector('#bid').getAttribute('aria-invalid') === 'true', off: document.querySelector('#create').disabled,
      deposit: document.querySelector('#tranche [aria-checked="true"]').dataset.zat,
    }));
    await p.click('#tranche [data-zat="10000000"]');
    await p.fill('#refund', JSON.parse(fs.readFileSync('app/web/testdata/bid-page/fixture.json', 'utf8')).refund_address);
    await p.fill('#bid', '0.0999');
    let s = await look();
    check('a bid within the deposit: no line, no glow, the button is on', !s.msg && !s.red && !s.card && !s.off && s.hint, JSON.stringify(s));
    await p.fill('#bid', '0.15');
    s = await look();
    check('too high for this deposit: the line names the limit, the deposit minus the fee, and a bigger deposit', /^Too high for a 0\.1 \S+ deposit\. Bid up to 0\.0999 or pick a bigger deposit\.$/.test(s.msg), s.msg);
    check('the chosen deposit card turns red with it', s.card === '10000000', s.card);
    check('the bid box glows red, the grey hint gives way, the button waits', s.red && s.invalid && !s.hint && s.off, JSON.stringify(s));
    check('the deposit is never changed for the person', s.deposit === '10000000', s.deposit);
    await p.click('#tranche [data-zat="30000000"]');
    s = await look();
    check('picking the larger deposit clears it at once', !s.msg && !s.red && !s.off, JSON.stringify(s));
    await p.fill('#bid', '0.5');
    s = await look();
    check('a bid no deposit allows names the limit and no bigger deposit', /^Too high for a 0\.3 \S+ deposit\. Bid up to 0\.2999\.$/.test(s.msg) && s.off && s.card === '30000000', s.msg);
    await p.fill('#bid', '0.3');
    s = await look();
    check('a bid equal to the deposit is too high (the fee comes off)', s.off && /^Too high for a 0\.3 \S+ deposit\. Bid up to 0\.2999\.$/.test(s.msg), s.msg);
    await p.fill('#bid', '0.2999');
    s = await look();
    check('the deposit minus the fee is allowed', !s.msg && !s.off, JSON.stringify(s));
    // the refund address must be for the auction's network (the owner's report of 21 Oct 2026: a u1 address was taken on a testnet
    // auction). Addresses made from fixed test bytes for each network, nobody's wallet.
    const MAIN = 'u1w4yfx9fl0pjklxesr8k94598wcyedtw0w4ekqmvqfe7u88wjl06c57z9rfdwclwzd6c8wjlsyun8949vuc7jykcwmkrc5687ftqa5aa59txr7682d0vw6fqzmyuxfs7xpgm5tjm2pwrzpc9jys7gdy3cyylly6k59dwu584lsu5y8jd8';
    const TEST = 'utest13x4neahaknjvdwe5j4h5le2zhfh502nava4jf5g43z9n8ynk9g5whlvsztnn9lm88eq83zzpvsjst0vnfda32lywxv9uz8qgk8wtgr84d6da980fg0wrj2en9hnywv4khl35008f263gztnlqa3zf0he97k0ahttlmmhm7e7ycmn45nm';
    await p.fill('#refund', MAIN);
    s = await look();
    const rmsg = await p.textContent('#refund-msg');
    check('an address for another network: one red line, and the button waits', rmsg === 'This address is for another network.' && await p.$eval('#refund', (r) => r.classList.contains('bad') && r.getAttribute('aria-invalid') === 'true') && s.off, rmsg);
    const w = await p.evaluate(async ({ main, test, id, relay }) => {
      const W = await import('/pkg/ll_web.js'); await W.default();
      const rules = (await (await fetch(`${relay}/v1/campaigns/${id}`)).text()).replace('"network":"regtest"', '"network":"test"');
      let built;
      try { W.sealed_bid_payment(rules, W.generate_seed(), main, 10000000, 5000000); built = 'built'; } catch (e) { built = String(e.message || e); }
      return { onTest: W.sealed_refund_problem('test', main), onMain: W.sealed_refund_problem('main', test), same: W.sealed_refund_problem('test', test), built };
    }, { main: MAIN, test: TEST, id: ID, relay: `http://127.0.0.1:${RELAY}` });
    check('a mainnet address on a testnet auction: "This is a mainnet address. Use a testnet one."', w.onTest === 'This is a mainnet address. Use a testnet one.', w.onTest);
    check('a testnet address on a mainnet auction: "This is a testnet address. Use a mainnet one."', w.onMain === 'This is a testnet address. Use a mainnet one.', w.onMain);
    check('the payment for a testnet auction is never built for a mainnet refund address', w.built === 'This is a mainnet address. Use a testnet one.', w.built);
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
