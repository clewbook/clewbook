// "Payment seen, waiting for the network" on the test network, with real payments: the contribute page of a fundraiser sees its payment
// while it waits in the mempool (it fetches every waiting transaction and opens each with the campaign's public viewing key), a second page
// with another payment code does not, and both captions give way once the payment is mined; the bid page sees a deposit sent with Noir (a
// stand in extension that pays with the test wallet and returns the real transaction id) and says so until it is mined. A payment mined before
// the page looked is reported and paid again, at most three times. Serves app/web/www itself on PAGES_PORT.
// Env: PARTS (default "contribute,bid"), RAISE and AUCTION (campaign ids on RELAY, a throwaway test network host), RELAY, PAYER (test wallet folder), ZD (zcash-devtool).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');
const { RAISE, AUCTION, RELAY, PAYER } = process.env, ZD = process.env.ZD || 'runs/blind-bin/zcash-devtool', PORT = Number(process.env.PAGES_PORT || 8799);
const SERVER = 'https://zjs.zec.rocks/testnet', WWW = path.join(__dirname, 'www');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  ' + extra : ''}`); if (!ok) failed++; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const f = path.join(WWW, path.normalize(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const devtool = (args, input) => spawnSync(ZD, ['wallet', '-w', PAYER, ...args], { input, encoding: 'utf8', timeout: 300000 });
function pay(to, zat, memo) {
  for (let i = 0; i < 8; i++) {
    devtool(['sync']);
    const out = devtool(['send', '-i', `${PAYER}.age`, '--address', to, '--value', String(zat), '--memo', memo, '--min-confirmations', '1'], 'y\n');
    const txid = (out.stdout.match(/^[0-9a-f]{64}$/m) || [''])[0];
    if (txid) return txid;
    spawnSync('sleep', ['15']);
  }
  return '';
}
/** The height the chain server gives the transaction: 0 while it waits in the mempool; undefined when the server does not answer (3 tries). */
async function heightOf(txid) {
  for (let i = 0; i < 3; i++) { try { return await heightOnce(txid); } catch { await new Promise((r) => setTimeout(r, 3000)); } }
  return undefined;
}
async function heightOnce(txid) {
  const req = Buffer.from(txid, 'hex').reverse();
  const body = Buffer.concat([Buffer.from([0, 0, 0, 0, req.length + 2, 0x1a, req.length]), req]);
  const res = await fetch(`${SERVER}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction`, { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' }, body });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!buf.length || buf[0] & 0x80) return null;
  const msg = buf.subarray(5, 5 + new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0));
  for (let i = 0; i < msg.length;) {
    const key = msg[i++], f = key >> 3, wt = key & 7;
    if (wt === 2) { let len = 0, s = 0, b; do { b = msg[i++]; len |= (b & 0x7f) << s; s += 7; } while (b & 0x80); i += len; continue; }
    let v = 0, m = 1, b; do { b = msg[i++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    if (f === 2) return v > 0 && v < 0xffffffff ? v : 0;
  }
  return 0;
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${PORT}`;
  const refund = (devtool(['list-addresses']).stdout.match(/\bz?utest1[0-9a-z]+/) || [''])[0];
  check('the test wallet has a test network address for the refunds', /^z?utest1/.test(refund));
  const browser = await chromium.launch();
  const errors = [];
  const fresh = async (init, arg) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    if (init) await ctx.addInitScript(init, arg);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    return { ctx, p };
  };
  const seenState = (p) => p.evaluate(() => ({ done: document.querySelector('#s-seen').classList.contains('done'), caption: document.querySelector('#s-seen .state').textContent, sr: (document.querySelector('#s-seen .st-sr') || {}).textContent || '', received: document.querySelector('#s-received').classList.contains('done') }));

  const parts = {
    contribute: async () => {
  // ---------- the contribute page of a fundraiser ----------
  const link = `${BASE}/contribute.html#c=${RAISE}&relay=${encodeURIComponent(RELAY)}`;
  const makeCode = async (p) => {
    await p.goto(link);
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    await p.fill('#amount', '0.0003'); await p.click('#to-addr'); await p.fill('#refund', refund);
    await p.click('#create');
    await p.waitForSelector('#pay-card:not([hidden])', { timeout: 15000 });
    await Promise.all([p.waitForEvent('download'), p.click('#backup')]);
    await p.click('#to-pay');
    await p.waitForSelector('#qr svg', { timeout: 15000 });
    return { memo: (await p.textContent('#memo')).trim(), to: (await p.textContent('#pay-to')).trim() };
  };
  let caught = false;
  for (let attempt = 1; attempt <= 3 && !caught; attempt++) {
    const a = await fresh(), b = await fresh();
    const mine = await makeCode(a.p), other = await makeCode(b.p);
    check(`attempt ${attempt}: before paying, the page waits for the payment`, /waiting for you to pay/.test((await seenState(a.p)).sr));
    log(`attempt ${attempt}: paying 30,000 zat with the page's memo`);
    const txid = pay(mine.to, 30000, mine.memo);
    check(`attempt ${attempt}: payment sent`, txid.length === 64, txid);
    if (!txid) { await a.ctx.close(); await b.ctx.close(); break; }
    // the page refreshes on its own; watch it until the payment is mined
    let sawPending = false, minedFirst = false, other0 = null;
    const until = Date.now() + 600000;
    while (Date.now() < until) {
      const s = await seenState(a.p);
      if (s.caption === 'Payment seen, waiting for the network' && !s.done) {
        const h = await heightOf(txid);
        if (!h) { sawPending = true; other0 = await seenState(b.p); break; }
      }
      if (s.done) { minedFirst = true; break; }
      await a.p.waitForTimeout(1000);
    }
    if (minedFirst) { log(`attempt ${attempt}: the payment was mined before the page looked at the mempool; paying again`); await a.ctx.close(); await b.ctx.close(); continue; }
    caught = sawPending;
    check('the contribute page shows "Payment seen, waiting for the network" while the payment waits in the mempool (the server says height 0)', sawPending);
    const s1 = await seenState(a.p);
    check('"Contribution received" is not done yet', !s1.received && !s1.done);
    check('a second page with another payment code does not take this payment for its own', other0 && /waiting for you to pay/.test(other0.sr) && other0.caption === '', JSON.stringify(other0));
    await a.p.waitForFunction(() => document.querySelector('#s-seen').classList.contains('done'), null, { timeout: 600000 });
    const s2 = await seenState(a.p);
    check('once mined: "seen on the network", and the waiting caption is gone', /seen on the network/.test(s2.sr) && s2.caption === '', JSON.stringify(s2));
    const t0 = Date.now();
    await a.p.waitForSelector('#s-received.done', { state: 'attached', timeout: 900000 }).catch(() => {});
    check('"Contribution received" comes with the ticket, after the payment is mined', (await seenState(a.p)).received, `${Math.round((Date.now() - t0) / 1000)} s after mining`);
    await a.ctx.close(); await b.ctx.close();
  }
  check('the contribute page caught a payment in the mempool within three tries', caught);

    },
    bid: async () => {
  // ---------- the bid page, a deposit sent with Noir ----------
  await new Promise((r) => setTimeout(r, 1000));
  const stub = () => {
    const request = async (r) => {
      if (r.method === 'zcash_requestAccounts') return [{ address: 'utest1standinforthetestnetwork' }]; // the page only reads the network from it
      if (r.method === 'zcash_sendTransaction') return window.__payNoir(r.params[0]);
      throw new Error('unknown method');
    };
    window.noirwallet = { isNoirWallet: true, zcash: { request } };
  };
  let bidCaught = false;
  for (let attempt = 1; attempt <= 3 && !bidCaught; attempt++) {
    const { ctx, p } = await fresh(stub);
    let txid = '';
    await p.exposeFunction('__payNoir', async (q) => { txid = pay(q.to, Math.round(Number(q.amount) * 1e8), q.memo); return txid; });
    await p.addInitScript((r) => { window.__refund = r; }, refund);
    await p.goto(`${BASE}/brand.js`);
    await p.evaluate(async ({ id, relay, refund }) => {
      window.__refund = refund;
      const W = await import('/pkg/ll_web.js'); await W.default();
      const rules = await (await fetch(`${relay}/v1/campaigns/${id}`)).text();
      const seed = W.generate_seed(), q = JSON.parse(W.sealed_bid_payment(rules, seed, refund, 30000, 15000));
      localStorage.setItem(`ll:sealed:${id}`, JSON.stringify({ seed, refund, tranche: 30000, bid: 15000, memo: q.memo, payTo: q.pay_to, pageKey: q.page_key, qrSvg: q.qr_svg, paidZat: null }));
    }, { id: AUCTION, relay: RELAY, refund });
    await p.goto(`${BASE}/bid.html#c=${AUCTION}&relay=${encodeURIComponent(RELAY)}`);
    await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 60000 });
    log(`bid page, attempt ${attempt}: paying the deposit through the stand in Noir`);
    await p.click('#noir-pay');
    await p.waitForFunction(() => /Sent with Noir/.test(document.querySelector('#noir-msg').textContent), null, { timeout: 600000 });
    check(`bid page, attempt ${attempt}: the deposit was sent and its id kept`, txid.length === 64, txid);
    if (!txid) { await ctx.close(); break; }
    if (!(await p.isVisible('#st-title'))) await p.click('#to-status').catch(() => {});
    let saw = false, minedFirst = false;
    const until = Date.now() + 600000;
    while (Date.now() < until) {
      const title = (await p.textContent('#st-title').catch(() => '')) || '';
      const h = await heightOf(txid);
      if (title === 'Payment seen, waiting for the network' && h === 0) { saw = true; break; }
      if (h) { minedFirst = true; break; } // undefined: the server did not answer; look again
      await p.waitForTimeout(1500);
    }
    if (minedFirst && !saw) { log(`bid page, attempt ${attempt}: mined before the page looked; trying again`); await ctx.close(); continue; }
    bidCaught = saw;
    check('the bid page shows "Payment seen, waiting for the network" for a Noir deposit waiting in the mempool', saw);
    await p.waitForFunction(() => document.querySelector('#st-title').textContent !== 'Payment seen, waiting for the network', null, { timeout: 600000 }).catch(() => {});
    const after = await p.textContent('#st-title');
    check('once the deposit is mined the bid page moves on', after !== 'Payment seen, waiting for the network' && (await heightOf(txid)) > 0, after);
    await ctx.close();
  }
  check('the bid page caught a deposit in the mempool within three tries', bidCaught);
    },
  };
  for (const name of (process.env.PARTS || 'contribute,bid').split(',')) await parts[name]();
  check('no page error', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
