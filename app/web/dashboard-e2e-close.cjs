// Drives the host dashboard like a campaign host, against real testnet. Env: PAYER (bidder wallet dir),
// REFUND_ADDR, TREASURY (address that receives the kept money), SHOTS.
const { chromium } = require('../vectors/js/node_modules/playwright');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { PAYER, REFUND_ADDR, TREASURY } = process.env, SHOTS = process.env.SHOTS || 'runs/page/shots';
const ZD = './target/release/zcash-devtool', BIN = './app/target/release', BASE = `http://127.0.0.1:${process.env.DASH_PORT || 8780}`;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sh = (cmd) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
const val = (p, sel, label) => p.evaluate(([sel, label]) => { const dts = [...document.querySelectorAll(`${sel} dt`)]; const dt = dts.find((d) => d.textContent.trim() === label); return dt ? dt.nextElementSibling.textContent.trim() : null; }, [sel, label]);
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForSelector('#live:not([hidden])', { timeout: 30000 });
  const sel = await page.inputValue('#campaign-select');
  const st0 = await (await fetch(`${BASE}/api/campaigns/${sel}`)).json();
  // ---- security ----
  const bad1 = await fetch(`${BASE}/api/campaigns/${sel}/close`, { method: 'POST', body: '{}' });
  check('a request without the dashboard header is refused (403)', bad1.status === 403);
  const bad2 = await fetch(`${BASE}/api/campaigns/${sel}/close`, { method: 'POST', headers: { 'x-dashboard': '1', origin: 'http://evil.example' }, body: '{}' });
  check('a request from another site is refused (403)', bad2.status === 403);

  // ---- wait for the deadline, then close from the page ----
  log(`waiting for the deadline (block ${st0.deadline_height})`);
  await page.waitForFunction(() => !document.querySelector('#close-btn').hidden && !document.querySelector('#close-btn').disabled, null, { timeout: 3300000, polling: 5000 });
  await page.waitForFunction(() => /The deadline has passed/.test(document.querySelector('#warning-list').textContent), null, { timeout: 60000 });
  check('after the deadline the page warns to close and enables the button', true, await text(page, '#warning-list').then((t) => t.slice(t.indexOf('The deadline'), t.indexOf('The deadline') + 110)));
  await page.click('#close-btn');
  await page.click('#close-yes'); // no address yet
  await page.waitForSelector('#close-error:not([hidden])');
  check('closing without an address is refused', /address/i.test(await text(page, '#close-error')));
  await page.fill('#sweep-to', 'not an address'); await page.click('#close-yes'); await page.waitForTimeout(800);
  check('closing with an invalid address is refused', /valid address/i.test(await text(page, '#close-error')));
  await page.screenshot({ path: `${SHOTS}/22-dashboard-close.png`, fullPage: true });
  await page.fill('#sweep-to', TREASURY); await page.click('#close-yes');
  await page.waitForFunction(() => document.querySelector('#close-log li'), null, { timeout: 600000 });
  const closeLog = await text(page, '#close-log');
  check('closing wrote the result and moved the money', /close entry/.test(closeLog) && /(refund broadcast|swept)/.test(closeLog), closeLog.slice(0, 200));
  await page.waitForFunction(() => /Closed/.test(document.querySelector('#facts').textContent), null, { timeout: 60000 });
  check('status shows the campaign as closed (goal missed: refund)', /goal missed/.test(await text(page, '#facts')));
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 160));
  await page.screenshot({ path: `${SHOTS}/23-dashboard-closed.png`, fullPage: true });
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
