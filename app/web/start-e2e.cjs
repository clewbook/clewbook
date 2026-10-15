// The start page (demo home) and the friendly "not here" page, in the shared design (page server on 127.0.0.1:8770).
// Calm sentences only, links to the demo campaign's pages, the status from a measured block time, both screen sizes. Env: SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const SHOTS = process.env.SHOTS || 'runs/design-shots';
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
    await page.goto('http://127.0.0.1:8770/');
    await page.waitForFunction(() => !document.querySelector('#contribute-link').classList.contains('off') || /no demo campaign/i.test(document.querySelector('#contribute-text').textContent), null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#contribute-status').textContent.length > 0, null, { timeout: 40000 }).catch(() => {});
    if (tag === '1280') {
      const hasCampaign = !(await page.evaluate(() => document.querySelector('#contribute-link').classList.contains('off')));
      check('the start page links to the demo campaign\'s contribute, campaign and recount pages', !hasCampaign || ((await page.getAttribute('#contribute-link', 'href')).includes('contribute.html#c=') && /campaign\.html#c=/.test(await page.getAttribute('#campaign-link', 'href')) && /recount\.html#c=/.test(await page.getAttribute('#recount-link', 'href'))));
      const st = await text(page, '#contribute-status');
      check('the status is one calm sentence (open with a time left from a measured block time, wrapping up, closed, or cannot tell)', /^(Open: (about .* left|\d+ blocks left \(the length of a block could not be measured\))\.|The deadline has passed; the host is wrapping up\.|This campaign has closed\.|Can't tell right now whether it is still open\.)$/.test(st), st);
      check('the dashboard link and the way to start a campaign are there', /8780/.test(await page.getAttribute('#dashboard-link', 'href')) && /Set up a new campaign/.test(await text(page, 'main')));
      check('the page uses the shared look: self-hosted fonts load', await page.evaluate(async () => { await document.fonts.ready; return ['700 16px "Archivo"', '400 16px "Chivo Mono"'].every((f) => document.fonts.check(f)); }));
    }
    check(`no horizontal scrolling (${tag})`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: `${SHOTS}/start-${tag}.png`, fullPage: true });
    await page.close();
  }
  const nf = await (await browser.newContext({ viewport: { width: 390, height: 600 } })).newPage();
  const res = await nf.goto('http://127.0.0.1:8770/nope.html');
  check('an address that does not exist gives a friendly page in the shared look, never a raw error', res.status() === 404 && /That page isn't here/.test(await text(nf, 'main')));
  await nf.screenshot({ path: `${SHOTS}/not-found-390.png` });
  check('nothing was requested from outside this computer except the public network servers', outside.length === 0, outside.slice(0, 3).join(' '));
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
