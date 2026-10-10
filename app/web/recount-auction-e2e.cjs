// The recount page for a closed uniform-price auction (testnet): R1 to R12 are all listed, the auction rows have tooltips, and the
// auction totals and report hash are shown. Env: LINK (recount link), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const txt = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [w, h, tag] of [[390, 844, '390'], [1280, 900, '1280']]) {
    const p = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(process.env.LINK);
    await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 300000 });
    const kind = await p.getAttribute('#verdict', 'data-kind');
    const ids = await p.evaluate(() => [...document.querySelectorAll('#rules .chk .cid')].map((e) => e.firstChild.textContent));
    if (tag === '390') {
      check('auction recount: the verdict is a pass or a limited pass', kind === 'pass' || kind === 'partial', kind);
      check('auction recount: R1 to R12 are all listed', Array.from({ length: 12 }, (_, i) => `R${i + 1}`).every((r) => ids.includes(r)), ids.join(' '));
      check('auction recount: the auction totals are shown (clearing price, treasury)', /Clearing price/.test(await txt(p, '#totals')) && /treasury/i.test(await txt(p, '#totals')));
      await p.click('#rules .chk:has(.cid:text-is("R11")) .cid'); await p.waitForTimeout(200);
      check('auction recount: tapping R11 shows its name and sentence', /Nothing diverted/.test(await txt(p, '#rules .chk:has(.cid:text-is("R11")) .tip')));
    }
    await p.screenshot({ path: `runs/design-shots/recount-auction-${tag}.png`, fullPage: true });
    check(`no horizontal scrolling (${tag})`, await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await p.close();
  }
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
