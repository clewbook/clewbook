// The real network (mainnet) guards, with no money and no wallet: `ll-host serve --network main` on an empty folder. The set-up page shows a loud
// MAINNET banner and will not create anything until the box is ticked; the host refuses without the confirmation; it refuses a campaign that could
// still be running when the NU7 upgrade activates (announced for 5 November 2026, height not yet published); nothing is created by any refusal.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8780', SHOTS = process.env.SHOTS || 'runs/design-shots', RUNS = process.env.RUNS || 'runs/mainnet-guard/runs';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const post = (body) => fetch(`${BASE}/api/campaigns`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, j: await r.json() }));
(async () => {
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  check('the host program reports the main network, real ZEC, and no NU7 height yet', cfg.network === 'main' && cfg.ticker === 'ZEC' && cfg.nu7_mainnet_height === null, JSON.stringify(cfg).slice(0, 160));
  const base = { mode: 'raise', goal_zat: 100000, deadline_in: 500, min_contribution_zat: 20000, relays: [] };
  let r = await post(base);
  check('creating without the confirmation is refused, in plain words', r.status === 400 && /MAINNET/.test(r.j.error) && /real ZEC/.test(r.j.error), r.j.error);
  r = await post({ ...base, confirm_mainnet: true, deadline_in: 60000 });
  check('a campaign that could still be running at the NU7 upgrade is refused even when confirmed', r.status === 400 && /NU7/.test(r.j.error) && /5 November 2026/.test(r.j.error) && /not published yet/.test(r.j.error), r.j.error);
  r = await post({ ...base, confirm_mainnet: 'yes', deadline_in: 500 });
  check('only a real true counts as the confirmation', r.status === 400 && /MAINNET/.test(r.j.error), r.j.error);
  const made = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((n) => n.startsWith('campaign-')) : [];
  check('no refusal created a wallet or a campaign', made.length === 0, made.join(','));

  const browser = await chromium.launch();
  const errors = [];
  for (const [w, h, tag] of [[1280, 900, '1280'], [390, 844, '390']]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/setup.html`);
    await page.waitForSelector('#mainnet-banner:not([hidden])', { timeout: 20000 });
    if (tag === '1280') {
      const banner = await text(page, '#mainnet-banner');
      check('the set-up page opens with a loud MAINNET banner that says real money and names the NU7 rule', /MAINNET: real money/.test(banner) && /real ZEC/.test(banner) && /5 November 2026/.test(banner), banner.slice(0, 200));
      check('the Create button is disabled until the real-money box is ticked', await page.isDisabled('#create-btn') && await page.isVisible('#confirm-row'));
      await page.fill('#goal', '0.001'); await page.fill('#deadline', '60000');
      await page.check('#confirm-mainnet');
      check('ticking the box enables Create', !(await page.isDisabled('#create-btn')));
      await page.click('#create-btn');
      await page.waitForSelector('#setup-error:not([hidden])', { timeout: 15000 });
      const e = await text(page, '#setup-error');
      check('a deadline that could cross NU7 gives a calm notice and creates nothing', /NU7/.test(e) && /Check this/.test(e) && fs.readdirSync(RUNS).filter((n) => n.startsWith('campaign-')).length === 0, e.slice(0, 160));
      await page.uncheck('#confirm-mainnet');
      check('un-ticking the box disables Create again', await page.isDisabled('#create-btn'));
    }
    check(`no horizontal scrolling (${tag})`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: `${SHOTS}/mainnet-setup-${tag}.png`, fullPage: true });
    await page.close();
  }
  const dash = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  dash.on('pageerror', (e) => errors.push(String(e)));
  await dash.goto(BASE);
  await dash.waitForSelector('#mainnet-banner:not([hidden])', { timeout: 20000 });
  check('the dashboard carries the MAINNET banner too: label ZCASH MAINNET, the sentence unchanged, and no "Main network: real money." line under the heading', (await text(dash, '#mainnet-banner .k')) === 'ZCASH MAINNET' && /Everything here uses real ZEC\. Closing a campaign moves real money and cannot be undone\./.test(await text(dash, '#mainnet-banner')) && (await dash.locator('#net-note').count()) === 0 && !/Main network: real money/.test(await text(dash, 'main')));
  const look = await dash.evaluate(() => { const b = document.querySelector('#mainnet-banner'), k = b.querySelector('.k'), c = getComputedStyle(b); return { border: c.borderLeftColor, bg: c.backgroundColor, label: getComputedStyle(k).color, ink: getComputedStyle(b.querySelector('p')).color }; });
  check('the mainnet banner is neutral grey (border #808084, light grey background, darker grey label) with dark body text, no red', look.border === 'rgb(128, 128, 132)' && look.bg === 'rgb(230, 230, 232)' && look.label === 'rgb(68, 68, 74)' && look.ink === 'rgb(28, 27, 24)', JSON.stringify(look));
  check('closing needs the confirmation: the Close now button starts disabled on mainnet', await dash.isDisabled('#close-yes'));
  await dash.screenshot({ path: `${SHOTS}/mainnet-dashboard-1280.png`, fullPage: true });
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
