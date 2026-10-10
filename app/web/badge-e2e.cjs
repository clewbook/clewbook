// The recount badge a host embeds: drawn by the badge page in the shared design, small, claims nothing, names the campaign, links to the live
// recount, says "Not yet recounted". Embedded in a stand-in host page to see it as a reader would. Env: LINK (any page link of a campaign), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const tail = process.env.LINK.slice(process.env.LINK.indexOf('#'));
const base = process.env.LINK.slice(0, process.env.LINK.indexOf('contribute.html'));
const OWN = /^(http:\/\/127\.0\.0\.1|data:|blob:|about:)/;
(async () => {
  const browser = await chromium.launch();
  const errors = [], outside = [];
  // 1. the campaign page hands the host a snippet; paste it into a stand-in host page
  let p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await p.goto(`${base}campaign.html${tail}`);
  await p.waitForSelector('#badge-card:not([hidden])', { timeout: 60000 });
  const snippet = await p.textContent('#badge-code');
  check('the snippet is one small iframe of the badge page with a plain-link fallback', /^<iframe src="[^"]*badge\.html#c=[0-9a-f]{64}/.test(snippet) && /width="300" height="160"/.test(snippet) && /<a href="[^"]*recount\.html#c=/.test(snippet));
  for (const [w, h, tag] of [[1280, 900, '1280'], [390, 844, '390']]) {
    const host = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    host.on('pageerror', (e) => errors.push(String(e)));
    host.on('request', (r) => { if (!OWN.test(r.url())) outside.push(r.url()); });
    const decoded = snippet.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    await host.goto(`${base}404-stand-in.html`).catch(() => {});
    await host.setContent(`<!doctype html><body style="font:16px Georgia;max-width:40rem;margin:2rem auto;padding:0 1rem"><h1>Lagos Community Radio Mast</h1><p>We are raising money for a new mast. Our books are open: anyone can check them.</p>${decoded}<p>Thanks for reading.</p></body>`);
    const frame = host.frameLocator('iframe');
    await frame.locator('#badge-name').waitFor({ timeout: 30000 });
    await host.waitForFunction(() => document.querySelector('iframe').contentDocument && /…/.test(document.querySelector('iframe').contentDocument.querySelector('#badge-name').textContent), null, { timeout: 30000 });
    const name = await frame.locator('#badge-name').textContent();
    if (tag === '1280') {
      check('it names the campaign (type and short id)', /^(Fundraiser|Auction) [0-9a-f]{8}…$/.test(name), name);
      const text = (await frame.locator('#badge').textContent()).replace(/\s+/g, ' ');
      check('it says "Recount it yourself" and "Not yet recounted"', /Recount it yourself/.test(text) && /Not yet recounted/.test(text), text);
      check('it makes no fixed claim: no "verified", "secure", "audited", "trusted" or "safe"', !/verified|secure|audited|trusted|safe|guarantee/i.test(text));
      check('it links to this campaign\'s live recount page', /recount\.html#c=[0-9a-f]{64}/.test(await frame.locator('#badge').getAttribute('href')) && (await frame.locator('#badge').getAttribute('target')) === '_top');
      const box = await host.locator('iframe').boundingBox();
      check('it is small and capped: at most 300 by 160 pixels', box.width <= 300 && box.height <= 160, `${Math.round(box.width)}x${Math.round(box.height)}`);
      check('the badge uses the shared look: self-hosted fonts load', await frame.locator('body').evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "Newsreader"') && document.fonts.check('16px "Atkinson Hyperlegible Next"'); }));
      const inner = await frame.locator('#badge').boundingBox();
      check('the whole card fits in the frame (nothing cut off)', inner.height <= 160 && inner.width <= 300, `${Math.round(inner.width)}x${Math.round(inner.height)}`);
    }
    check(`no horizontal scrolling (${tag})`, await host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await host.screenshot({ path: `${SHOTS}/badge-${tag}.png`, fullPage: true });
    await host.close();
  }
  // 2. an incomplete link still gives a calm card, not an error
  const bad = await (await browser.newContext({ viewport: { width: 400, height: 300 } })).newPage();
  await bad.goto(`${base}badge.html#c=zz`);
  await bad.waitForFunction(() => /incomplete link/.test(document.querySelector('#badge-name').textContent), null, { timeout: 15000 });
  check('an incomplete link gives a calm card', /Not yet recounted/.test(await bad.textContent('#badge')));
  check('nothing was requested from outside this computer', outside.length === 0, outside.slice(0, 3).join(' '));
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
