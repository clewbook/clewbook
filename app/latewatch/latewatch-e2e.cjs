// The late ticket watcher on the test network, with real money of no value: a quick blind bid auction on a throwaway host whose coin wallet
// the test funds; a deposit paid from the test wallet through the bid page (a stand in Noir extension that pays with the test wallet), kept
// open until PROTECTED; the page's copy of its signed late ticket on the relay (write only, in the relay's folder); the host never closes;
// the watcher sends nothing before the late ticket block, nor until WAIT_MINUTES (default 60) after that block's time, and sends the copy
// then; the late ticket is mined and is the page's own.
// Env: HOST (the throwaway host's dashboard), RELAY, RELAY_DIR (its folder), PAYER (test wallet folder), ZD (zcash-devtool), PAGES_PORT.
const { chromium } = require('../vectors/js/node_modules/playwright');
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');
const { HOST, RELAY, RELAY_DIR, PAYER } = process.env, ZD = process.env.ZD, PORT = Number(process.env.PAGES_PORT || 8800);
const WAIT = Number(process.env.WAIT_MINUTES || 60);
const SERVER = 'https://zjs.zec.rocks/testnet', WWW = path.join(__dirname, '..', 'web', 'www'), WORK = process.env.WORK || 'runs/latewatch-e2e';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  ' + extra : ''}`); if (!ok) failed++; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const f = path.join(WWW, path.normalize(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
const devtool = (args, input) => spawnSync(ZD, ['wallet', '-w', PAYER, ...args], { input, encoding: 'utf8', timeout: 300000 });
function pay(to, zat, memo) {
  for (let i = 0; i < 20; i++) {
    devtool(['sync']);
    const out = devtool(['send', '-i', `${PAYER}.age`, '--address', to, '--value', String(zat), ...(memo ? ['--memo', memo] : []), '--min-confirmations', '1'], 'y\n');
    const txid = (out.stdout.match(/^[0-9a-f]{64}$/m) || [''])[0];
    if (txid) return txid;
    spawnSync('sleep', ['20']);
  }
  return '';
}
/** The same payment without blocking: the browser waits on it (the stand in Noir), so this process must keep serving the page meanwhile. */
const run = (args, input) => new Promise((done) => { const c = execFile(ZD, ['wallet', '-w', PAYER, ...args], { timeout: 300000 }, (err, stdout) => done(stdout || '')); if (input) c.stdin.end(input); else c.stdin.end(); });
async function payAsync(to, zat, memo) {
  for (let i = 0; i < 20; i++) {
    await run(['sync']);
    const out = await run(['send', '-i', `${PAYER}.age`, '--address', to, '--value', String(zat), '--memo', memo, '--min-confirmations', '1'], 'y\n');
    const txid = (out.match(/^[0-9a-f]{64}$/m) || [''])[0];
    if (txid) return txid;
    await sleep(20000);
  }
  return '';
}
async function grpc(method, req) {
  const body = Buffer.concat([Buffer.from([0, 0, 0, 0, req.length]), req]);
  const res = await fetch(`${SERVER}/cash.z.wallet.sdk.rpc.CompactTxStreamer/${method}`, { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' }, body });
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length && !(buf[0] & 0x80) ? buf.subarray(5, 5 + new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0)) : null;
}
const varintField = (msg, field) => {
  for (let i = 0; msg && i < msg.length;) {
    const key = msg[i++], f = key >> 3, wt = key & 7;
    if (wt === 2) { let len = 0, s = 0, b; do { b = msg[i++]; len |= (b & 0x7f) << s; s += 7; } while (b & 0x80); i += len; continue; }
    let v = 0, m = 1, b; do { b = msg[i++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    if (f === field) return v;
  }
  return null;
};
const tipNow = async () => { try { return varintField(await grpc('GetLatestBlock', Buffer.alloc(0)), 1); } catch { return null; } };
const minedAt = async (txid) => { try { const h = varintField(await grpc('GetTransaction', Buffer.concat([Buffer.from([0x1a, 32]), Buffer.from(txid, 'hex').reverse()])), 2); return h > 0 && h < 0xffffffff ? h : 0; } catch { return null; } };
const api = async (p, body) => (await fetch(`${HOST}/api/${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) } : {})).json();

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${PORT}`;
  const refund = (devtool(['list-addresses']).stdout.match(/\bz?utest1[0-9a-z]+/) || [''])[0];
  // 1. the auction, and its coin wallet funded by the test
  const made = await api('campaigns', { mode: 'sealed_auction', items: 1, tranches_zat: [30000], pricing: 'uniform', coin_sending: { mode: 'at_once' }, deadline_in: 40, timing: 'quick', ticket_k: 10, relays: [RELAY], name: 'Late ticket watcher check' });
  check('a quick blind bid auction is made on the throwaway host', made.ok === true, JSON.stringify(made).slice(0, 120));
  const id = made.id;
  const rules = await (await fetch(`${RELAY}/v1/campaigns/${id}`)).json();
  const claimAfter = rules.sealed.claim_after;
  const coinAddress = ((await api(`campaigns/${id}`)).sealed || {}).coin_address || '';
  log(`auction ${id.slice(0, 8)}: deadline ${rules.deadline_height}, late tickets after block ${claimAfter}; coin wallet ${coinAddress.slice(0, 12)}…`);
  const fund = pay(coinAddress, 30000);
  check('the coin wallet is funded from the test wallet', fund.length === 64, fund);
  // 2. the deposit, through the bid page, kept open until PROTECTED
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const request = async (r) => {
      if (r.method === 'zcash_requestAccounts') return [{ address: 'utest1standinforthetestnetwork' }];
      if (r.method === 'zcash_sendTransaction') return window.__payNoir(r.params[0]);
      throw new Error('unknown method');
    };
    window.noirwallet = { isNoirWallet: true, zcash: { request } };
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  let deposit = '';
  await p.exposeFunction('__payNoir', async (q) => { deposit = await payAsync(q.to, Math.round(Number(q.amount) * 1e8), q.memo); return deposit; });
  await p.goto(`${BASE}/brand.js`);
  await p.evaluate(async ({ id, relay, refund }) => {
    const W = await import('/pkg/ll_web.js'); await W.default();
    const rules = await (await fetch(`${relay}/v1/campaigns/${id}`)).text();
    const seed = W.generate_seed(), q = JSON.parse(W.sealed_bid_payment(rules, seed, refund, 30000, 15000));
    localStorage.setItem(`ll:sealed:${id}`, JSON.stringify({ seed, refund, tranche: 30000, bid: 15000, memo: q.memo, payTo: q.pay_to, pageKey: q.page_key, qrSvg: q.qr_svg, paidZat: null }));
  }, { id, relay: RELAY, refund });
  await p.goto(`${BASE}/bid.html#c=${id}&relay=${encodeURIComponent(RELAY)}`);
  await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 60000 });
  await p.evaluate(() => document.querySelector('#noir-pay').click()); // the click handler waits for the payment
  await p.waitForFunction(() => /Sent with Noir/.test(document.querySelector('#noir-msg').textContent), null, { timeout: 900000 });
  check('the deposit is paid', deposit.length === 64, deposit);
  await p.waitForFunction(() => document.querySelector('#st-title') && document.querySelector('#st-title').textContent === 'PROTECTED', null, { timeout: 1800000 }).catch(() => {});
  const st = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)), id);
  check('the bid page says PROTECTED: its late ticket is checked and signed', !!(st && st.late && st.late.signed_hex), (await p.textContent('#st-title').catch(() => '')) || '');
  await sleep(10000);
  const st2 = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)), id);
  check('the page gave the relay a copy of its signed late ticket', !!(st2.lateUpload && st2.lateUpload.done.includes(RELAY)), JSON.stringify(st2.lateUpload));
  const lateDir = path.join(RELAY_DIR, 'campaigns', id, 'late');
  const files = fs.existsSync(lateDir) ? fs.readdirSync(lateDir) : [];
  check('the copy is in the relay\'s folder, named by the deposit', files.length === 1 && files[0].startsWith(st2.ticket.nf), files.join(','));
  check('the copy is the page\'s own signed late ticket, byte for byte', files.length === 1 && fs.readFileSync(path.join(lateDir, files[0])).toString('hex') === st2.late.signed_hex);
  check('the relay does not serve it', (await fetch(`${RELAY}/v1/campaigns/${id}/late/${st2.ticket.nf}`)).status >= 400);
  await browser.close();
  server.close();
  // 3. the watcher, every minute; the host never closes
  const stateFile = path.join(WORK, `watch-${id.slice(0, 8)}.json`);
  const watcher = spawn('python3', [path.join(__dirname, 'latewatch.py'), '--relay-dir', RELAY_DIR, '--server', `test=${SERVER},https://zcash-testnet.chainsafe.dev`, '--state', stateFile, '--wait-minutes', String(WAIT), '--every', '60'], { stdio: ['ignore', fs.openSync(path.join(WORK, `watch-${id.slice(0, 8)}.log`), 'a'), 'pipe'] });
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  let beforeOk = true, sentAt = null;
  for (let i = 0; i < 400; i++) { // up to about 6.5 hours
    await sleep(60000);
    const t = await tipNow(), s = readState(), tries = Object.entries(s).filter(([k]) => k.startsWith(id)).map(([, v]) => v);
    if (t != null && t <= claimAfter && tries.some((v) => v.tries > 0)) beforeOk = false;
    if (tries.some((v) => v.done)) { sentAt = t; break; }
    if (i % 10 === 0) log(`tip ${t}, late tickets after ${claimAfter}; watcher tries ${tries.map((v) => v.tries).join(',') || 0}`);
  }
  check('before the late ticket block the watcher sends nothing', beforeOk);
  check('after the late ticket block, with no close on the list, the watcher sends the copy', sentAt != null && sentAt > claimAfter, `at tip ${sentAt}`);
  // the time of the late ticket block (its tree state, field 4), and when the watcher first tried
  const blockTime = varintField(await grpc('GetTreeState', Buffer.concat([Buffer.from([0x08]), Buffer.from((() => { const v = []; let n = claimAfter; while (n > 127) { v.push((n % 128) | 128); n = Math.floor(n / 128); } v.push(n); return v; })())])), 4);
  const firstTry = (fs.readFileSync(path.join(WORK, `watch-${id.slice(0, 8)}.log`), 'utf8').match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) auction /m) || [])[1];
  const triedAt = firstTry ? Date.parse(firstTry.replace(' ', 'T')) / 1000 : null; // the watcher logs local time; this runs on the same computer
  check(`the watcher waited ${WAIT} minutes after the late ticket block's time before sending`, blockTime && triedAt && triedAt >= blockTime + WAIT * 60, `block time ${blockTime}, first send ${triedAt}`);
  let mined = 0;
  for (let i = 0; i < 40 && !mined; i++) { await sleep(30000); mined = (await minedAt(st2.late.txid)) || 0; }
  check('the late ticket is mined after the late ticket block: the deposit is back at its refund address', mined > claimAfter, `${st2.late.txid} in block ${mined}`);
  watcher.kill();
  check('no page error', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
