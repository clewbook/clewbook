// The contributor page after the security fixes, at phone width (390 px), with a stand-in chain server and plain files (no network, no money):
// - the page copy rules: on the payment step at most one caution line is always visible; every visible caution line is one sentence of at most
//   20 words, plain grey, never a red box; in the amount and payment steps, normally, near the deadline, with blocked storage, after a change;
// - late payments: no new payment code in the last 10 blocks before the deadline, one line says why, only then;
// - the relay cannot tell which ticket is the visitor's: every ticket is fetched, in random order.
// Plain files from app/web/make-static.sh (default runs/static-polish) on a spare port. Env: DIR, PORT (default 8806), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8806', SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, MOCK = 'https://chain.mock.test/testnet';
const RAISE = { id: '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da', deadline: 4477610 }; // 40 contributions, 40 tickets
const link = (c) => `${BASE}/contribute.html#c=${c.id}&relay=${BASE}/relays/a&relay=${BASE}/relays/b&server=${encodeURIComponent(MOCK)}`;
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);
// every visible caution line: paragraphs and list items inside caution elements (hints and plain text are not cautions)
const CAUTIONS = () => {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const sel = '.warnline, .notice, .error, #banners > *';
  return [...document.querySelectorAll(sel)].filter((e) => vis(e) && !e.parentElement.closest(sel)).map((e) => ({
    text: e.textContent.replace(/\s+/g, ' ').trim(), red: /\b(bad|fail|error)\b/.test(e.className), boxed: parseFloat(getComputedStyle(e).borderTopWidth) > 0 || parseFloat(getComputedStyle(e).borderLeftWidth) > 0,
  })).filter((x) => x.text);
};

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  let tip = 0;
  const page = async ({ t = RAISE.deadline - 100, blocked = false, onRequest } = {}) => {
    tip = t;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    if (onRequest) p.on('request', onRequest);
    if (blocked) await p.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
    await p.route(`${MOCK}/**`, async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(route.request().url()) ? frame(0, [0x08, ...varint(tip)]) : Buffer.alloc(0);
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
    await p.goto(link(RAISE));
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    await p.waitForTimeout(1200);
    return p;
  };
  const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
  const addrOf = (p) => p.evaluate(async (id) => (await (await fetch(`/relays/a/v1/campaigns/${id}`)).json()).pay_to, RAISE.id);
  const create = async (p, a, amount) => { await p.fill('#amount', amount); await p.fill('#refund', a); await p.click('#create'); await p.waitForSelector('#pay-card:not([hidden])', { timeout: 15000 }); if (await p.isVisible('#to-pay')) await p.click('#to-pay'); await p.waitForTimeout(600); }; // design round 2: Continue to pay after the Backup step
  const rules = (name, list, { max = Infinity } = {}) => {
    check(`${name}: ${list.length} caution line(s) visible${max < Infinity ? `, at most ${max}` : ''}`, list.length <= max, JSON.stringify(list.map((x) => x.text)));
    check(`${name}: each is one sentence of at most 20 words, grey, not boxed, not red`, list.every((x) => x.text.split(/\s+/).length <= 20 && (x.text.match(/[.;?!](\s|$)/g) || []).length <= 2 && !x.red && !x.boxed), JSON.stringify(list));
  };
  try {
    // ---------- the four cases ----------
    let p = await page(); const addr = await addrOf(p);
    rules('amount step, normal', await p.evaluate(CAUTIONS), { max: 0 });
    await create(p, addr, '0.01');
    const normal = await p.evaluate(CAUTIONS);
    rules('payment step, normal', normal, { max: 1 });
    check('payment step, normal: the one line says to pay exactly the amount once, from a shielded address', normal.length === 1 && /^Pay exactly 0\.01 TAZ once, from a shielded address\.$/.test(normal[0].text), normal[0] && normal[0].text);
    check('payment step: "Why?" is closed and holds one sentence', (await p.evaluate(() => !document.querySelector('#pay-why').open)) && (await text(p, '#pay-why p')).split(/\.\s/).length === 1);
    await p.screenshot({ path: `${SHOTS}/stage-h-payment.png`, fullPage: true });
    // changed amount
    await p.click('#back-to-backup'); await p.click('#edit-amount'); await p.click('#leave-yes'); await p.waitForSelector('#form-card:not([hidden])'); await p.waitForTimeout(500); // design round 2: Back to the Backup step, then Back to the amount
    const changed = await p.evaluate(CAUTIONS);
    rules('amount step, after the amount was changed', changed, { max: 1 });
    check('  ... the one line says not to pay the previous code', changed.length === 1 && /^Do not pay the previous code/.test(changed[0].text));
    await create(p, addr, '0.02');
    rules('payment step, after the amount was changed', await p.evaluate(CAUTIONS), { max: 1 });
    await p.context().close();

    // blocked storage
    p = await page({ blocked: true });
    rules('amount step, storage blocked', await p.evaluate(CAUTIONS), { max: 0 });
    await create(p, addr, '0.01');
    const blocked = await p.evaluate(CAUTIONS);
    rules('payment step, storage blocked', blocked, { max: 2 });
    check('  ... the extra line, only now, says to download the backup file', blocked.some((x) => x.text === 'This browser cannot save your secret, so download your backup file now.'));
    await p.context().close();

    // ---------- the last blocks before the deadline ----------
    p = await page({ t: RAISE.deadline - 5 });
    const near = await p.evaluate(CAUTIONS);
    rules('amount step, 5 blocks before the deadline', near, { max: 1 });
    check('  ... no new payment code: Create is off and one line says why', (await p.isDisabled('#create')) && near.length === 1 && near[0].text === 'New payments stop 10 blocks before the deadline, because one mined after it would not count.', JSON.stringify(near));
    await p.fill('#amount', '0.01'); await p.fill('#refund', addr); await p.click('#create', { force: true }).catch(() => {}); await p.waitForTimeout(500);
    check('  ... and pressing it anyway makes nothing', await p.isHidden('#pay-card'));
    await p.context().close();
    p = await page({ t: RAISE.deadline - 10 });
    check('exactly 10 blocks before the deadline: a payment code can still be made, and no deadline line', (await p.isEnabled('#create')) && (await p.isHidden('#near-deadline')));
    await create(p, addr, '0.01');
    await p.context().close();
    // a code made earlier, the deadline now close
    p = await page({ t: RAISE.deadline - 50 });
    await create(p, addr, '0.01');
    tip = RAISE.deadline - 3; await p.reload(); await p.waitForSelector('#pay-card:not([hidden])', { timeout: 60000 }); await p.waitForTimeout(1500);
    const late = await p.evaluate(CAUTIONS);
    rules('payment step, 3 blocks before the deadline', late, { max: 2 });
    check('  ... one line gives the deadline block and says a later payment is not counted', late.some((x) => x.text === `The deadline is block ${RAISE.deadline}; a payment mined after it is not counted or refunded.`), JSON.stringify(late));
    await p.screenshot({ path: `${SHOTS}/stage-h-near-deadline.png`, fullPage: true });
    await p.context().close();

    // ---------- every ticket is fetched, in random order ----------
    const orders = [];
    for (let round = 0; round < 2; round++) {
      const seen = [];
      p = await page({ onRequest: (r) => { const m = /\/relays\/a\/v1\/campaigns\/[0-9a-f]{64}\/tickets\/([0-9a-f]{64})$/.exec(r.url()); if (m) seen.push(m[1]); } });
      if (round === 0) await create(p, addr, '0.01'); else { await create(p, addr, '0.01'); }
      await p.waitForTimeout(6000);
      orders.push(seen);
      await p.context().close();
    }
    const n = new Set(orders[0]).size;
    check(`every one of the campaign's tickets is fetched (${n} of 40), each once`, n === 40 && orders[0].length === 40, `${orders[0].length} requests`);
    check('  ... in a different order on another visit (random), so the order says nothing', orders[1].length === 40 && orders[0].join() !== orders[1].join());
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    srv.kill();
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
