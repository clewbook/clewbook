// The page-load failure message: with one of a page's own script files blocked (as a failing tunnel does), every page that loads scripts shows,
// after the timeout (here ?lg=3, three seconds; the real wait is 20), a visible message that says what happened and offers Reload; a page that loads
// normally shows none; a page that is slow to get its first answer says so, and the message goes away by itself when the answer comes.
// Plain files (default runs/static-polish, from app/web/make-static.sh) on a spare port; a stand-in chain server; no network and no money.
// Env: DIR, PORT (default 8806), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8806', SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, MOCK = 'https://chain.mock.test/testnet';
const ID = '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f';
const q = `c=${ID}&relay=${BASE}/relays/a&relay=${BASE}/relays/b&server=${encodeURIComponent(MOCK)}`;
const PAGES = ['contribute', 'recount', 'campaign', 'card', 'badge', 'index'];
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const open = async () => {
    const p = await (await browser.newContext({ viewport: { width: 900, height: 800 } })).newPage();
    await p.route(`${MOCK}/**`, async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(route.request().url()) ? frame(0, [0x08, ...varint(4477000)]) : Buffer.alloc(0);
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
    return p;
  };
  const url = (page) => `${BASE}/${page}.html?lg=3${page === 'index' ? '' : '#' + q}`;
  try {
    for (const page of PAGES) {
      // 1. one of the page's own files fails to arrive (the static start page has no script file to lose)
      let p = await open();
      if (page !== 'index') {
      await p.route(`${BASE}/ui.js`, (r) => r.abort('connectionreset'));
      await p.goto(url(page));
      await p.waitForSelector('#loadguard', { timeout: 10000 }).catch(() => {});
      const msg = await p.evaluate(() => { const g = document.querySelector('#loadguard'); return g ? { text: g.textContent.replace(/\s+/g, ' ').trim(), kind: g.dataset.kind, button: !!g.querySelector('button'), visible: g.getBoundingClientRect().height > 20 } : null; });
      check(`${page}: a script file that fails to load gives a visible message with Reload`, !!msg && msg.kind === 'load' && msg.button && msg.visible && /could not load all of its files/.test(msg.text) && /Nothing was sent or changed/.test(msg.text), JSON.stringify(msg));
      if (page === 'recount') await p.screenshot({ path: `${SHOTS}/loadguard-load.png` });
      if (msg) {
        await p.unroute(`${BASE}/ui.js`);
        await p.click('#loadguard button'); await p.waitForLoadState('load');
        await p.waitForTimeout(5000);
        check(`${page}: Reload brings the page back, and the message is gone`, (await p.locator('#loadguard').count()) === 0);
      }
      }
      await p.context().close();
      // 2. everything loads: no message
      p = await open();
      await p.goto(url(page));
      await p.waitForTimeout(page === 'index' ? 5000 : 9000);
      check(`${page}: a page that loads normally shows no message`, (await p.locator('#loadguard').count()) === 0);
      await p.context().close();
    }
    // 3. the scripts load but the campaign's servers do not answer: "taking longer", and it clears when they answer
    let p = await open();
    let release;
    const gate = new Promise((r) => { release = r; });
    await p.route(`${BASE}/relays/**`, async (route) => { await gate; await route.continue(); });
    await p.goto(url('contribute'));
    await p.waitForSelector('#loadguard', { timeout: 10000 });
    const w = await p.evaluate(() => ({ kind: document.querySelector('#loadguard').dataset.kind, text: document.querySelector('#loadguard').textContent.replace(/\s+/g, ' ') }));
    check('contribute: scripts loaded but the servers are silent: the message says it is taking longer and that nothing was sent', w.kind === 'wait' && /taking longer than usual/.test(w.text) && /nothing was sent or changed/.test(w.text), JSON.stringify(w));
    release();
    await p.waitForFunction(() => !document.querySelector('#loadguard'), null, { timeout: 15000 }).catch(() => {});
    check('contribute: when the servers answer, the message goes away by itself', (await p.locator('#loadguard').count()) === 0);
    await p.context().close();
    // 4. the recount, waiting for its first answer
    p = await open();
    let release2; const gate2 = new Promise((r) => { release2 = r; });
    await p.route(`${BASE}/relays/**`, async (route) => { await gate2; await route.continue(); });
    await p.goto(url('recount'));
    await p.waitForSelector('#loadguard', { timeout: 10000 });
    check('recount: waiting for the relays shows the message', (await p.getAttribute('#loadguard', 'data-kind')) === 'wait');
    release2();
    await p.context().close();
  } finally { srv.kill(); await browser.close(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
