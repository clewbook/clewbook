// Pay with Noir on the contributor page's pay step, with a stand in for the Noir browser extension (window.noirwallet) and a stand in chain
// server: no extension, no network, no money. Without the extension nothing changes; with it the button appears, connects, refuses the wrong
// network, sends exactly the address, amount and message the code and the link carry, keeps the returned transaction ID like a pasted one and
// hides the button. Plain files from app/web/make-static.sh (default runs/static-polish) on a spare port. Env: DIR, PORT (default 8806), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8806', SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, MOCK = 'https://chain.mock.test/testnet';
const RAISE = { id: '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da', deadline: 4477610 }; // testnet fundraiser, open at this tip
const link = (c) => `${BASE}/contribute.html#c=${c.id}&relay=${BASE}/relays/a&relay=${BASE}/relays/b&server=${encodeURIComponent(MOCK)}`;
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);
const TXID = 'ab'.repeat(32);
const TEST_ADDR = `utest1${'q'.repeat(100)}`, MAIN_ADDR = `u1${'q'.repeat(100)}`;
const BANNED = /\b(anonymous|secure|trustless|guaranteed)\b/i;

/** The stand in extension: cfg.flat puts request on window.noirwallet itself; cfg.late injects it after one second with the init event. */
function stub(cfg) {
  const install = () => {
    window.__noirCalls = [];
    const request = async (r) => {
      window.__noirCalls.push(JSON.parse(JSON.stringify(r)));
      if (r.method === 'zcash_requestAccounts') return cfg.shape === 'pair' ? { transparent: 'tmTESTtransparent', shielded: cfg.address } : [{ address: cfg.address }];
      if (r.method === 'zcash_sendTransaction') {
        if (cfg.fail) { const e = new Error(cfg.fail.message); if (cfg.fail.code) e.code = cfg.fail.code; throw e; }
        return cfg.txid;
      }
      throw new Error('unknown method');
    };
    window.noirwallet = cfg.flat ? { isNoirWallet: true, request } : { isNoirWallet: true, zcash: { request } };
  };
  if (cfg.late) setTimeout(() => { install(); window.dispatchEvent(new Event('noirwallet#initialized')); }, 1000);
  else install();
}

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  const tip = RAISE.deadline - 100;
  let addr = null;
  const toPay = async (noirCfg, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: opts.w || 1000, height: 900 } });
    if (opts.theme) await ctx.addInitScript((t) => { try { localStorage.setItem('cb-theme', t); } catch {} }, opts.theme);
    if (noirCfg) await ctx.addInitScript(stub, noirCfg);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.route(`${MOCK}/**`, async (route) => {
      const url = route.request().url();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(url) ? frame(0, [0x08, ...varint(tip)]) : Buffer.alloc(0);
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
    await p.goto(link(RAISE));
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    if (!addr) addr = await p.evaluate(async (id) => (await (await fetch(`/relays/a/v1/campaigns/${id}`)).json()).pay_to, RAISE.id);
    await p.fill('#amount', '0.0123'); await p.click('#to-addr'); await p.fill('#refund', addr); await p.click('#create');
    await p.waitForSelector('#pay-card:not([hidden])', { timeout: 15000 });
    await p.click('#to-pay'); await p.waitForSelector('#pay-main:not([hidden])');
    return p;
  };
  const msg = async (p) => ((await p.textContent('#noir-msg')) || '').trim();
  const shown = (p) => p.isVisible('#noir-pay');
  const note = async (p) => ((await p.textContent('.wallet-note')) || '').trim();
  const plain = (t) => !/[—–]/.test(t) && !/\w-\w/.test(t) && !/ - /.test(t) && !BANNED.test(t);
  const messages = [];
  try {
    // no extension: nothing changes (after the 3 s the page waits for it)
    let p = await toPay(null);
    await p.waitForTimeout(3500);
    check('no extension: no Pay with Noir button, the note says (Connects with Vizor)', !(await shown(p)) && (await note(p)) === '(Connects with Vizor)' && !(await p.isVisible('#noir-msg')));
    await p.context().close();

    // detected (also when it arrives late, with its initialized event, and with request on the object itself)
    p = await toPay({ address: TEST_ADDR, txid: TXID, late: true, flat: true, shape: 'pair' });
    await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 5000 });
    check('extension arriving late: detected, the button shows, the note says (Connects with Vizor and Noir)', (await shown(p)) && (await note(p)) === '(Connects with Vizor and Noir)');

    // the transparent and shielded addresses as named fields: the shielded one is found
    await p.click('#noir-pay'); await p.waitForFunction(() => document.querySelector('#noir-pay').hidden, null, { timeout: 5000 });
    check('connect answer with transparent and shielded addresses: the shielded one is used and the payment goes out', (await p.evaluate(() => window.__noirCalls.map((c) => c.method).join())) === 'zcash_requestAccounts,zcash_sendTransaction');
    await p.context().close();

    // wrong network: refused, nothing sent
    p = await toPay({ address: MAIN_ADDR, txid: TXID });
    await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 5000 });
    await p.click('#noir-pay'); await p.waitForSelector('#noir-msg:not([hidden])');
    let calls = await p.evaluate(() => window.__noirCalls.map((c) => c.method));
    let m = await msg(p); messages.push(m);
    check('Noir on mainnet for a testnet campaign: refused, nothing sent, the button stays', /^Noir is on the main network, but this campaign is on the test network\. Nothing was sent\./.test(m) && calls.join() === 'zcash_requestAccounts' && (await shown(p)), m);
    await p.context().close();

    // cancelled, not enough funds, any other error: plain words, the button stays, nothing stored
    for (const [fail, want, label] of [[{ code: 4001, message: 'User rejected the request' }, /^Cancelled in Noir\. Nothing was sent\.$/, 'cancelled in Noir'],
      [{ message: 'Insufficient balance' }, /^Noir does not have enough funds for this payment and its fee\. Nothing was sent\.$/, 'not enough funds'],
      [{ message: 'internal failure 17' }, /^Noir could not complete the payment\. Check its activity list before you try again, so you do not pay twice\.$/, 'any other Noir error']]) {
      p = await toPay({ address: TEST_ADDR, fail });
      await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 5000 });
      await p.click('#noir-pay'); await p.waitForSelector('#noir-msg:not([hidden])');
      m = await msg(p); messages.push(m);
      const st = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:${id}`)), RAISE.id);
      check(`${label}: said in plain words, the button stays, nothing stored`, want.test(m) && (await shown(p)) && !st.manualTxid && !st.noirSent, m);
      await p.context().close();
    }

    // success: exactly the code's values, the transaction ID kept like a pasted one, the button gone (also after a reload)
    p = await toPay({ address: TEST_ADDR, txid: TXID });
    await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 5000 });
    const shownValues = await p.evaluate(() => ({ to: document.querySelector('#pay-to').textContent, amount: document.querySelector('#pay-amt').textContent, memo: document.querySelector('#memo').textContent, link: document.querySelector('#paylink').getAttribute('href') }));
    await p.click('#noir-pay'); await p.waitForFunction(() => document.querySelector('#noir-pay').hidden, null, { timeout: 5000 });
    calls = await p.evaluate(() => window.__noirCalls);
    const sent = calls.find((c) => c.method === 'zcash_sendTransaction');
    const lk = new URL(shownValues.link.replace(/^zcash:/, 'zcash://x/'));
    const linkTo = shownValues.link.slice(6).split('?')[0], linkAmount = lk.searchParams.get('amount');
    const linkMemo = Buffer.from((lk.searchParams.get('memo') || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    check('connect first, then one send with exactly the address, amount and message on the page', calls.map((c) => c.method).join() === 'zcash_requestAccounts,zcash_sendTransaction'
      && JSON.stringify(sent.params) === JSON.stringify([{ to: shownValues.to, amount: shownValues.amount, memo: shownValues.memo }]), JSON.stringify(sent && sent.params).slice(0, 160));
    check('the same three values the wallet link carries (address, amount, message)', sent.params[0].to === linkTo && sent.params[0].amount === linkAmount && sent.params[0].memo === linkMemo, `${linkAmount} ${linkMemo.slice(0, 20)}`);
    m = await msg(p); messages.push(m);
    const st = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:${id}`)), RAISE.id);
    check('after sending: the transaction ID is kept like a pasted one, the button is gone, the message says the page waits to see the payment',
      st.manualTxid === TXID && (await p.inputValue('#manual-txid')) === TXID && !(await shown(p)) && /^Sent with Noir\. This page now waits to see your payment on the network/.test(m), m);
    await p.reload(); await p.waitForTimeout(4000);
    check('after a reload the button stays gone (no second payment)', !(await shown(p)));
    await p.context().close();

    check('every Noir message is plain (no em dash, no hyphen used as a dash, no banned word)', messages.every(plain), messages.filter((t) => !plain(t)).join(' | '));

    // screenshots: the button and the note at 1280 and 390, light and dark
    for (const [w, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
      p = await toPay({ address: TEST_ADDR, txid: TXID }, { w, theme });
      await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 5000 });
      const over = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      const h = await p.evaluate(() => document.querySelector('#noir-pay').getBoundingClientRect().height);
      check(`${w} ${theme}: no sideways scroll, button at least 44 px tall`, !over && h >= 44, `${h}px`);
      await p.locator('.cpwallet').scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${SHOTS}/noir-${w}-${theme}.png`, fullPage: false });
      await p.context().close();
    }
  } catch (e) {
    console.log('TEST ERROR', e);
    failed++;
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  srv.kill();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
