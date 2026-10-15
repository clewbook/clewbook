// "Edit amount" on the payment step of the contributor page, at phone width (390 px): a visible Back control, the phone's own back gesture, a payment already
// seen, a replaced code that must not be paid, blocked browser storage, fundraiser and auction. Plain files from app/web/make-static.sh (default runs/static-polish)
// on a spare port; the chain server is a stand-in answered by this test, so no network and no money are involved. Env: DIR, PORT (default 8803), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8803', SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, MOCK = 'https://chain.mock.test/testnet';
const RAISE = { id: '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da', deadline: 4477610 };
const AUCTION = { id: '5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb', deadline: 4472149 };
const link = (c) => `${BASE}/contribute.html#c=${c.id}&relay=${BASE}/relays/a&relay=${BASE}/relays/b&server=${encodeURIComponent(MOCK)}`;
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  let tip = 0;
  const newPage = async (c, { blocked = false } = {}) => {
    tip = c.deadline - 100;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|\/(final|heartbeat|challenges)/.test(m.text())) errors.push(m.text()); });
    if (blocked) await p.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
    await p.route(`${MOCK}/**`, async (route) => {
      const url = route.request().url();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(url) ? frame(0, [0x08, ...varint(tip)]) : Buffer.alloc(0);
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
    await p.goto(link(c));
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    return p;
  };
  const text = async (p, sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
  const addrOf = (p, c) => p.evaluate(async (id) => (await (await fetch(`/relays/a/v1/campaigns/${id}`)).json()).pay_to, c.id);
  const create = async (p, addr, amount) => { await p.fill('#amount', amount); await p.fill('#refund', addr); await p.click('#create'); await p.waitForSelector('#pay-card:not([hidden])', { timeout: 15000 }); await p.waitForSelector('#qr svg', { state: 'attached' }); }; // design round 2: Create opens the Backup step; the code is drawn and shown after Continue to pay
  const qrOf = (p) => p.evaluate(() => document.querySelector('#qr').innerHTML.length + ':' + document.querySelector('#qr').innerHTML.slice(0, 400));
  const memoOf = async (p) => { await p.evaluate(() => (document.querySelector('#manual').open = true)); return (await text(p, '#memo')); };
  const inView = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }, sel);
  try {
    for (const [label, c, noun] of [['fundraiser', RAISE, 'contribution'], ['auction', AUCTION, 'bid']]) {
      // ---------- change the amount ----------
      let p = await newPage(c);
      const addr = await addrOf(p, c);
      await create(p, addr, '0.01');
      const memo1 = await memoOf(p), qr1 = await qrOf(p);
      await p.evaluate(() => window.scrollTo(0, 0));
      const box = await p.locator('#edit-amount').boundingBox();
      check(`${label}: on the backup step, a "← Back" button that goes back to the amount is visible without scrolling, at least 44 px high and 120 px wide`, (await p.isVisible('#edit-amount')) && /←\s*Back/.test(await text(p, '#edit-amount')) && box.height >= 44 && box.width >= 120 && (await inView(p, '#edit-amount')), JSON.stringify(box));
      check(`${label}: the backup step comes first, with its download button, before the code is shown`, (await p.isVisible('#backup')) && /Save your backup file first/.test(await text(p, '#pay-card')) && (await p.isHidden('#qr svg')));
      await p.tap('#to-pay');
      check(`${label}: "Continue to pay" shows the warning and the code`, /^Pay exactly 0\.01\d* TAZ once, from your own wallet's shielded balance, not an exchange or transparent funds\.$/.test(await text(p, '#pay-warning')) && (await p.isVisible('#pay-warning')) && (await p.isVisible('#qr svg')));
      await p.tap('#back-to-backup');
      check(`${label}: "← Back" on the payment step returns to the backup step`, (await p.isVisible('#backup')) && (await p.isHidden('#qr svg')));
      await p.screenshot({ path: `${SHOTS}/back-${label}-pay.png` });
      await p.tap('#edit-amount');
      check(`${label}: tapping it asks first, and the question is on screen where the tap was`, (await p.isVisible('#leave-confirm')) && (await inView(p, '#leave-confirm')));
      await p.tap('#leave-no');
      check(`${label}: "Keep it" keeps the payment step`, await p.isVisible('#pay-card'));
      await p.tap('#edit-amount'); await p.tap('#leave-yes');
      await p.waitForSelector('#form-card:not([hidden])');
      const note = await text(p, '#left-note');
      check(`${label}: back on the amount step with 0.01 filled in, and a plain note says not to pay the previous QR`, (await p.inputValue('#amount')) === '0.01' && (await p.isVisible('#left-note')) && note === 'Do not pay the previous code; if you already did, it still counts and is listed below.', note.slice(0, 200));
      let st = await p.evaluate((id) => ({ cur: localStorage.getItem(`ll:${id}`), earlier: JSON.parse(localStorage.getItem(`ll:${id}:earlier`) || '[]') }), c.id);
      check(`${label}: the old code and its secret are kept in the list of earlier codes, not lost`, st.cur === null && st.earlier.length === 1 && st.earlier[0].memo === memo1 && !!st.earlier[0].seed && (await p.isVisible('#earlier')));
      await p.screenshot({ path: `${SHOTS}/back-${label}-amount.png` });
      await create(p, addr, '0.02');
      const memo2 = await memoOf(p), qr2 = await qrOf(p);
      check(`${label}: a new amount gives a new QR and a new message (never the old code)`, memo2 !== memo1 && qr2 !== qr1 && /0\.02/.test(await text(p, '#pay-min')) && (await p.isHidden('#left-note')));
      check(`${label}: the earlier code stays listed on the payment step`, /Earlier payment codes/.test(await text(p, '#earlier')) && /0\.01/.test(await text(p, '#earlier')));
      await p.context().close();

      // ---------- the phone's back gesture ----------
      p = await newPage(c);
      await create(p, addr, '0.01');
      const m1 = await memoOf(p);
      await p.goBack();
      await p.waitForSelector('#form-card:not([hidden])', { timeout: 10000 });
      check(`${label}: the back gesture returns to the amount step and stays on the page`, p.url().startsWith(`${BASE}/contribute.html`) && (await p.isHidden('#pay-card')) && (await p.inputValue('#amount')) === '0.01' && /^Do not pay the previous code/.test(await text(p, '#left-note')));
      st = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:${id}:earlier`) || '[]'), c.id);
      check(`${label}: and the old code is kept`, st.length === 1 && st[0].memo === m1);
      await p.context().close();

      // after a reload the payment step is still one back-step from the amount step
      p = await newPage(c);
      await create(p, addr, '0.01');
      await p.reload(); await p.waitForSelector('#pay-card:not([hidden])', { timeout: 60000 });
      await p.goBack();
      await p.waitForSelector('#form-card:not([hidden])', { timeout: 10000 });
      check(`${label}: the back gesture works after a reload too`, p.url().startsWith(`${BASE}/contribute.html`) && (await p.isHidden('#pay-card')));
      await p.context().close();

      // ---------- a payment already seen ----------
      p = await newPage(c);
      await create(p, addr, '0.01');
      await p.evaluate((id) => { const s = JSON.parse(localStorage.getItem(`ll:${id}`)); s.txid = 'ab'.repeat(32) + ':0'; s.paidZat = 1000000; localStorage.setItem(`ll:${id}`, JSON.stringify(s)); }, c.id);
      await p.reload(); await p.waitForSelector('#pay-card:not([hidden])', { timeout: 60000 });
      check(`${label}: a payment seen: no Edit amount and no Back to the amount; the status is shown instead`, (await p.isHidden('#edit-amount')) && (await p.isHidden('#change-amount')) && (await p.isVisible('#edit-locked')) && /can no longer change/.test(await text(p, '#edit-locked')));
      await p.goBack().catch(() => {});
      await p.waitForTimeout(800);
      check(`${label}: a payment seen: the back gesture does not leave the payment step`, p.url().startsWith(`${BASE}/contribute.html`) && (await p.isVisible('#pay-card')) && (await p.isHidden('#form-card')));
      await p.context().close();
    }

    // ---------- blocked storage ----------
    let p = await newPage(RAISE, { blocked: true });
    const addr = await addrOf(p, RAISE);
    await create(p, addr, '0.01');
    await p.tap('#to-pay');
    check('blocked storage: the payment step works and the existing warning says the browser will not keep the secret', (await p.isVisible('#qr svg')) && (await text(p, '#banners')) === 'This browser cannot save your secret, so download your backup file now.');
    const mb = await memoOf(p);
    await p.goBack();
    await p.waitForTimeout(800);
    check('blocked storage: the back gesture does not drop the only copy of the secret: it stays and asks for the backup file first', (await p.isVisible('#pay-card')) && /cannot keep your secret/.test(await text(p, '#leave-text')));
    await p.tap('#leave-no');
    await p.tap('#back-to-backup');
    const dlP = p.waitForEvent('download', { timeout: 10000 });
    await p.tap('#backup');
    const dl0 = await dlP;
    check('blocked storage: the backup button downloads the file', /contribution-backup-/.test(dl0.suggestedFilename()));
    await p.tap('#edit-amount'); await p.tap('#leave-yes');
    await p.waitForSelector('#form-card:not([hidden])');
    check('blocked storage: after the backup file, Edit amount goes back, and the note says the backup file is the way to follow the old code', /backup file/.test(await text(p, '#left-note')) && (await p.inputValue('#amount')) === '0.01');
    await create(p, addr, '0.02');
    check('blocked storage: a new code for the new amount', (await memoOf(p)) !== mb);
    await p.context().close();

    p = await newPage(RAISE, { blocked: true });
    await create(p, addr, '0.01');
    const dl = p.waitForEvent('download', { timeout: 10000 });
    await p.tap('#edit-amount'); await p.tap('#leave-yes');
    const f = await dl;
    check('blocked storage, no backup yet: leaving by the button saves the backup file of the old code automatically', /contribution-backup-/.test(await f.suggestedFilename()));
    await p.context().close();

    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    srv.kill();
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
