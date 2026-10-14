// The host dashboard in the shared design, on a real campaign that is open (testnet): real data only, notices for warnings, a to-do list
// that follows the campaign's phase, self-check rows with check-id tooltips, a recount link, and both screen sizes. Needs `ll-host serve`
// on 127.0.0.1:8780 with one campaign. Env: SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const fs = require('fs');
const BASE = `http://127.0.0.1:${process.env.DASH_PORT || 8780}`, SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const OWN = /^(http:\/\/127\.0\.0\.1|data:|blob:)/;
(async () => {
  const browser = await chromium.launch();
  const errors = [], outside = [];
  for (const [w, h, tag] of [[1280, 900, '1280'], [390, 844, '390']]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => { if (!OWN.test(r.url()) && !/zec\.rocks|chainsafe\.dev/.test(r.url())) outside.push(r.url()); });
    await page.goto(BASE);
    await page.waitForSelector('#live:not([hidden])', { timeout: 60000 });
    await page.waitForFunction(() => /Block time/.test(document.querySelector('#facts').textContent) && document.querySelectorAll('#check-list .chk').length > 0, null, { timeout: 90000 });
    if (tag === '1280') {
      const facts = await text(page, '#facts');
      check('status shows type, status, deadline with a measured time left, goal and minimum with 8 decimals', /Fundraiser/.test(facts) && /Open for contributions/.test(facts) && /Deadlineblock \d+ \(about .* left\)/.test(facts) && /Block timeabout \d+ seconds, measured over the last \d+ blocks/.test(facts) && /Goal0\.\d{8} TAZ/.test(facts) && /Smallest contribution0\.00020000 TAZ/.test(facts), facts.slice(0, 260));
      check('the status badge says OPEN', /OPEN/.test(await text(page, '#status-chip')));
      const todo = await text(page, '#todo-list');
      check('what the host still has to do: keep it running, close after the deadline', /Keep this program and this computer running/.test(todo) && /Close the campaign/.test(todo), todo);
      check('warnings are notices with a kicker, in plain words', await page.evaluate(() => { const n = [...document.querySelectorAll('#warning-list .notice')]; return n.length > 0 && n.every((x) => x.querySelector('.k') && x.querySelector('p')); }));
      check('the self-check lists R1 to R8 and R4b as rows with a Pass chip', await page.evaluate(() => { const ids = [...document.querySelectorAll('#check-list .chk')].map((c) => c.querySelector('.cid').firstChild.textContent); return ['R1', 'R2', 'R3', 'R4', 'R4b', 'R5', 'R6', 'R7', 'R8'].every((r) => ids.includes(r)) && [...document.querySelectorAll('#check-list .chk')].every((c) => c.classList.contains('pass')); }));
      await page.click('#check-list .chk:first-child .cid'); await page.waitForTimeout(200);
      check('tapping a check id shows its name and a sentence', await page.isVisible('#check-list .chk:first-child .tip') && /Rules/.test(await text(page, '#check-list .chk:first-child .tip')));
      check('the recount link points at this campaign\'s recount page', /recount\.html#c=[0-9a-f]{64}/.test(await page.getAttribute('#recount-link', 'href')));
      check('closing is not offered yet: the button is disabled while the campaign is open', await page.isDisabled('#close-btn'));
      check('the page carries no inline styles', await page.evaluate(() => document.querySelectorAll('[style]').length === 0));
    }
    check(`no horizontal scrolling (${tag})`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: `${SHOTS}/dashboard-open-${tag}.png`, fullPage: true });
    await page.close();
  }
  check('nothing was requested from outside this computer except the public network servers', outside.length === 0, outside.slice(0, 3).join(' '));
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
