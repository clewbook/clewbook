// Bid (or contribute) again after taking the first one back, in ONE browser profile, against a REAL test network campaign: pay, get the
// ticket, withdraw with it before the deadline, wait until the refund is mined, then try to pay again from the same page. Reports exactly
// what the page shows at each step (one saved slot per campaign, the list of earlier payment codes, any backup file it forces) and whether
// the second payment gets its own ticket. Play money only.
// Env: LINK (contribute link), REFUND_ADDR, PAYER (a funded test wallet), AMOUNT (coins, default 0.002), SHOTS, OUT (result json).
// Run from the repository root with Chromium's libraries on LD_LIBRARY_PATH.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { LINK, REFUND_ADDR, PAYER } = process.env;
const AMOUNT = process.env.AMOUNT || '0.002', SHOTS = process.env.SHOTS || 'runs/review-shots', OUT = process.env.OUT || `${SHOTS}/rebid.json`;
const ZD = './target/release/zcash-devtool';
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const text = async (p, s) => ((await p.textContent(s).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const zat = Math.round(Number(AMOUNT) * 1e8);

function pay(payTo, memo) {
  for (let i = 0; i < 14; i++) {
    spawnSync(ZD, ['wallet', '-w', PAYER, 'sync'], { stdio: 'ignore' });
    const out = spawnSync(ZD, ['wallet', '-w', PAYER, 'send', '-i', `${PAYER}.age`, '--address', payTo, '--value', String(zat), '--memo', memo, '--min-confirmations', '1'], { input: 'y\n', encoding: 'utf8' });
    const txid = (out.stdout.match(/^[0-9a-f]{64}$/m) || [''])[0];
    if (txid) return txid;
    spawnSync('sleep', ['20']);
  }
  return '';
}

async function makeCode(page) {
  await page.fill('#amount', AMOUNT); await page.fill('#refund', REFUND_ADDR);
  await page.click('#create');
  await page.waitForSelector('#pay-card:not([hidden])', { timeout: 15000 });
  await page.click('#manual summary').catch(() => {});
  return { memo: (await page.textContent('#memo')).trim(), payTo: (await page.textContent('#pay-to')).trim() };
}

const visible = async (p) => {
  const out = {};
  for (const id of ['form-card', 'form', 'pay-card', 'progress-card', 'start-over', 'change-amount', 'refund-btn', 'rebid', 'earlier']) out[id] = await p.isVisible(`#${id}`).catch(() => false);
  return out;
};

(async () => {
  const result = { link: LINK, steps: [] };
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(LINK);
  await page.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
  const id = new URL(LINK).hash.match(/c=([0-9a-f]+)/)[1];

  // 1. first payment
  const first = await makeCode(page);
  await page.click('#backup'); // the page asks for this first
  result.first_payment = pay(first.payTo, first.memo);
  check('first payment sent', result.first_payment.length === 64, result.first_payment);
  await page.waitForSelector('#s-ticket.done', { timeout: 900000 });
  check('first payment: the ticket arrived', true);
  result.steps.push({ after: 'first ticket', visible: await visible(page) });

  // 2. take it back with the ticket, before the deadline, and wait until that refund is mined
  await page.waitForSelector('#refund-btn:not([hidden])', { timeout: 120000 });
  await page.click('#refund-btn'); await page.click('#refund-yes');
  await page.waitForSelector('#refund-result:not([hidden])', { timeout: 120000 });
  await page.waitForFunction(() => /confirmed in block|already spent/.test(document.querySelector('#refund-result').textContent), null, { timeout: 1500000 });
  const rr = await text(page, '#refund-result');
  check('the withdrawal is mined', /confirmed in block/.test(rr), rr.slice(0, 120));
  await page.screenshot({ path: `${SHOTS}/rebid-after-withdraw.png`, fullPage: true });
  const after = await visible(page);
  result.steps.push({ after: 'withdrawal mined', visible: after, refund_result: rr, form_heading: await text(page, '#form-card h2') });
  log(`after the withdrawal the page shows: ${Object.entries(after).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none of the controls'}`);

  // 3. try to pay again from the same page
  let path = '';
  if (await page.isVisible('#rebid')) { path = 'the new "bid again" button'; await page.click('#rebid'); }
  else if (await page.isVisible('#start-over')) { path = 'Start over'; await page.click('#start-over'); await page.click('#leave-yes'); }
  else if (await page.isVisible('#form')) path = 'the form, shown as it is';
  result.second_path = path || 'none';
  check('the page offers a way to pay again after taking the first payment back', !!path, path || 'no control to start a new payment is visible');
  if (!path) {
    await page.reload(); await page.waitForTimeout(4000);
    const reloaded = await visible(page);
    result.steps.push({ after: 'reload', visible: reloaded });
    check('  ... not even after reloading the page', false, Object.entries(reloaded).filter(([, v]) => v).map(([k]) => k).join(', '));
  } else {
    await page.waitForSelector('#form:not([hidden])', { timeout: 15000 });
    const second = await makeCode(page);
    check('the second payment code is a new one', second.memo !== first.memo);
    const earlier = await page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(`ll:${k}:earlier`)) || []; } catch { return []; } }, id);
    result.earlier_count = earlier.length;
    check('the first contribution is kept in this browser\'s list of earlier payment codes', earlier.some((e) => e.memo === first.memo), `${earlier.length} kept`);
    result.forced_downloads = downloads.length - 1; // the first was the requested backup
    await page.click('#backup');
    result.second_payment = pay(second.payTo, second.memo);
    check('second payment sent', result.second_payment.length === 64, result.second_payment);
    await page.waitForSelector('#s-ticket.done', { timeout: 900000 });
    check('second payment: its own ticket arrived', true);
    const st = await page.evaluate((k) => JSON.parse(localStorage.getItem(`ll:${k}`)), id);
    result.second_ticket = st.ticket && st.ticket.entry.ticket.txid;
    check('the page now follows the second payment', st.txid && st.txid.startsWith(result.second_payment), st.txid);
    await page.screenshot({ path: `${SHOTS}/rebid-second.png`, fullPage: true });
  }
  result.downloads = downloads;
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(2); });
