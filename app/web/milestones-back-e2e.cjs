// Where the back links lead when a page is opened from the demo's "Tested milestones" page (/demo/proofs), in a headless browser against a
// copy of the demo (started by app/web/check-milestones.sh, which sets DEMO and SITE; the test site's pages come from app/web/www, served
// in place of app-test.clewbook.xyz, and the hosted milestones page in place of clewbook.xyz/demo/proofs). Every check follows the link
// and looks at where it landed: the page, the selection (type and result) and the item it came from.
// LIVE=1 runs the same checks against the deployed demo and test site, without serving anything in their place.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const { DEMO, SITE, LIVE } = process.env; // DEMO: the demo folder's address, ending in /; SITE: the built folder holding demo/
const WWW = path.join(__dirname, 'www');
const samePath = (a, b) => new URL(a).pathname.replace(/\/$/, '') === new URL(b).pathname.replace(/\/$/, ''); // the hosted demo drops the last slash
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const TYPES = { auction: 'Auction', sealed: 'Blind bid auction' };
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', wasm: 'application/wasm', json: 'application/json', svg: 'image/svg+xml', woff2: 'font/woff2', ico: 'image/x-icon', png: 'image/png' };
const serveFile = (route, file) => fs.existsSync(file) && fs.statSync(file).isFile()
  ? route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': MIME[path.extname(file).slice(1)] || 'application/octet-stream', 'access-control-allow-origin': '*' } })
  : route.fulfill({ status: 404, body: 'not found' });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (!LIVE) {
    // the test site, from this branch's pages
    await ctx.route('https://app-test.clewbook.xyz/**', (r) => serveFile(r, path.join(WWW, new URL(r.request().url()).pathname.replace(/^\/$/, '/index.html'))));
    // the hosted demo, from the copy being tested (the hosted address has no slash after proofs)
    await ctx.route(/^https:\/\/clewbook\.xyz\/demo\//, (r) => {
      const p = new URL(r.request().url()).pathname.replace(/^\/demo\/proofs\/?$/, '/demo/proofs/index.html');
      return serveFile(r, path.join(SITE, p));
    });
    // a page server that is not the demo (as the live site): the same pages, with the demo's example relays beside them
    await ctx.route(/^http:\/\/127\.0\.0\.1:\d+\/live\//, (r) => {
      const p = new URL(r.request().url()).pathname.replace(/^\/live\//, '');
      return serveFile(r, p.startsWith('relays/') ? path.join(SITE, 'demo', p) : path.join(WWW, p));
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e}`));
  const sel = async () => page.evaluate(() => ({
    type: (document.querySelector('.pseg button[aria-pressed=true]') || {}).dataset?.type,
    res: (document.querySelector('.pchip[aria-pressed=true]') || {}).dataset?.res,
  }));
  const inView = (id) => page.evaluate((id) => { const e = document.querySelector(`[data-id="${id}"]`); if (!e) return false; const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }, id);
  const onProofs = async (want, id) => {
    await page.waitForSelector('#list .dp-item', { timeout: 60000 });
    const s = await sel();
    const ok = /\/demo\/proofs\/?(index\.html)?$/.test(new URL(page.url()).pathname) && s.type === want.type && s.res === want.res && (!id || await inView(id));
    return { ok, extra: `${page.url().split('#')[0]} type ${s.type} result ${s.res}${id ? ` item in view ${await inView(id)}` : ''}` };
  };
  const linkText = async (s) => { await page.waitForFunction((s) => { const a = document.querySelector(s); return a && a.textContent.trim().length > 0 && a.getAttribute('href') !== '#'; }, s, { timeout: 120000 }); return (await page.textContent(s)).trim(); };
  // the top left link reads `text` once the page has set it (each page sets it early, before reading the relays)
  const waitText = (s, text) => page.waitForFunction(([s, t]) => { const a = document.querySelector(s); return a && a.textContent.trim() === t; }, [s, text], { timeout: 120000 }).then(() => true, () => false);
  const openProofs = async (type, res) => {
    await page.goto(`${DEMO}proofs/`);
    await page.waitForSelector('#list .dp-item', { timeout: 60000 });
    await page.click(`.pseg button[data-type="${type}"]`);
    if (res !== 'all') await page.click(`.pchip[data-res="${res}"]`);
    // the last item shown, so that coming back has to scroll to it
    const items = await page.$$eval('#list .dp-item', (xs) => xs.map((x) => x.dataset.id));
    return items[items.length - 1];
  };
  const linkOf = (id, name) => page.$eval(`[data-id="${id}"] .pacts`, (box, name) => [...box.querySelectorAll('a')].find((a) => a.textContent.includes(name)).href, name);

  try {
    // 1. Auctions + Passed: Campaign, Recount and Capability card each come back to the same selection and item
    for (const [name, back] of [['Campaign', '.ctop .cback'], ['Recount', '#nav-campaign'], ['Capability card', '#nav-campaign']]) {
      const id = await openProofs('Auction', 'pass');
      const href = await linkOf(id, name);
      check(`${name}: the link carries the marker and the selection`, /&from=proofs&mt=auction&mr=pass$/.test(href), href.slice(-60));
      await page.goto(href);
      check(`${name}: the top left link reads "← Tested milestones"`, await waitText(back, '← Tested milestones'), await linkText(back));
      await page.click(back);
      const r = await onProofs({ type: 'Auction', res: 'pass' }, id);
      check(`${name}: it leads back to Tested milestones, Auctions + Passed, scrolled to the item`, r.ok, r.extra);
    }

    // 2. one step further: campaign (from the milestones) -> its recount -> "← Campaign" -> the campaign -> "← Tested milestones"
    {
      const id = await openProofs('Auction', 'pass');
      await page.goto(await linkOf(id, 'Campaign'));
      await waitText('.ctop .cback', '← Tested milestones');
      await page.waitForFunction(() => /recount\.html#/.test(document.querySelector('#nav-recount').getAttribute('href') || ''), null, { timeout: 120000 });
      await page.click('#nav-recount');
      check('campaign -> recount: the recount keeps "← Campaign"', await waitText('#nav-campaign', '← Campaign'), await linkText('#nav-campaign'));
      await page.click('#nav-campaign');
      check('  ... which leads to the campaign page', /\/campaign\.html$/.test(new URL(page.url()).pathname) && /c=[0-9a-f]{64}/.test(page.url()), page.url().slice(0, 90));
      check('  ... whose top left link still reads "← Tested milestones"', await waitText('.ctop .cback', '← Tested milestones'));
      await page.click('.ctop .cback');
      const r = await onProofs({ type: 'Auction', res: 'pass' }, id);
      check('  ... and leads back to Auctions + Passed, at the item', r.ok, r.extra);
    }

    // 3. the contribute page of a finished campaign (from the campaign page): its top left link and the ticket step's back link
    {
      const id = await openProofs('Auction', 'pass');
      await page.goto(await linkOf(id, 'Campaign'));
      await waitText('.ctop .cback', '← Tested milestones');
      // a finished campaign shows no Bid or Contribute button: open the contribute page with the address that button carries on an open one
      // (the campaign page's link, with the way back: the same onward link its Recount item has)
      await page.waitForFunction(() => /recount\.html#/.test(document.querySelector('#nav-recount').getAttribute('href') || ''), null, { timeout: 120000 });
      const recount = await page.$eval('#nav-recount', (a) => a.href);
      check('the campaign page\'s onward links keep the way back', /&via=proofs&mt=auction&mr=pass$/.test(recount), recount.slice(-50));
      const contribute = recount.replace('recount.html', 'contribute.html').replace(/&endpoint=[^&]*/g, '');
      await page.goto(contribute);
      check('contribute (finished campaign): the top left link reads "← Tested milestones"', await waitText('#flow-back', '← Tested milestones'), await linkText('#flow-back'));
      const tk = await page.$eval('#tk-back', (a) => ({ text: a.textContent.trim(), href: a.href }));
      check('contribute: the ticket step\'s back link reads "← Tested milestones"', tk.text === '← Tested milestones', tk.text);
      await page.click('#flow-back');
      let r = await onProofs({ type: 'Auction', res: 'pass' }, id);
      check('  ... the top left link leads back to Auctions + Passed, at the item', r.ok, r.extra);
      await page.goto(tk.href);
      r = await onProofs({ type: 'Auction', res: 'pass' }, id);
      check('  ... the ticket step\'s back link leads there too (followed by its address: the ticket step needs a payment)', r.ok, r.extra);
    }

    // 4. the browser's Back keeps working and keeps the selection
    {
      const id = await openProofs('Auction', 'fail');
      await page.goto(await linkOf(id, 'Recount'));
      await waitText('#nav-campaign', '← Tested milestones');
      await page.goBack();
      const r = await onProofs({ type: 'Auction', res: 'fail' }, null);
      check('the browser\'s Back returns to Tested milestones with Auctions + Failed', r.ok, r.extra);
    }

    // 5. Sealed bids: the test site's pages come back to the hosted demo, on the Sealed bids tab, at the item (only where the tab exists)
    await page.goto(`${DEMO}proofs/`);
    await page.waitForSelector('#list .dp-item', { timeout: 60000 });
    if (await page.$('#seg-sealed:not([hidden])') == null) console.log('SKIP  Sealed bids: this demo has no Sealed bids tab');
    else {
      const id = await openProofs('Blind bid auction', 'all');
      const href = await linkOf(id, 'Campaign');
      check('Sealed bids: the link goes to the test site with the marker', href.startsWith('https://app-test.clewbook.xyz/campaign.html#') && /&from=proofs&mt=sealed&mr=all$/.test(href), href.slice(0, 50));
      await page.goto(href);
      check('Sealed bids: the test site\'s campaign page reads "← Tested milestones"', await waitText('.ctop .cback', '← Tested milestones'), await linkText('.ctop .cback'));
      await page.click('.ctop .cback');
      check('  ... which leads to clewbook.xyz/demo/proofs', page.url().startsWith('https://clewbook.xyz/demo/proofs'), page.url().slice(0, 60));
      const r = await onProofs({ type: 'Blind bid auction', res: 'all' }, id);
      check('  ... on the Sealed bids tab, at the item', r.ok, r.extra);
      await page.goto((await openProofs('Blind bid auction', 'all'), await linkOf(id, 'Recount')));
      check('Sealed bids: the test site\'s recount page reads "← Tested milestones"', await waitText('#nav-campaign', '← Tested milestones'));
      await page.click('#nav-campaign');
      const r2 = await onProofs({ type: 'Blind bid auction', res: 'all' }, id);
      check('  ... and leads back to the Sealed bids tab', r2.ok, r2.extra);
    }

    // 6. opened any other way, the back links are as before
    {
      const id = await openProofs('Auction', 'pass');
      const plain = (await linkOf(id, 'Campaign')).replace(/&from=proofs.*$/, '');
      await page.goto(plain);
      check('without the marker: the campaign page reads "← Campaigns"', await waitText('.ctop .cback', '← Campaigns'));
      await page.click('.ctop .cback');
      check('  ... and leads to the demo\'s start page', samePath(page.url(), DEMO), page.url());
      await page.goto(plain.replace('campaign.html', 'recount.html'));
      await page.waitForFunction(() => /campaign\.html#/.test(document.querySelector('#nav-campaign').getAttribute('href') || ''), null, { timeout: 120000 });
      check('without the marker: the recount page reads "← Campaign"', (await page.textContent('#nav-campaign')).trim() === '← Campaign');
      await page.click('#nav-campaign');
      check('  ... and leads to the campaign page', /\/campaign\.html$/.test(new URL(page.url()).pathname), page.url().slice(0, 80));
      await page.goto(plain.replace('campaign.html', 'contribute.html'));
      check('without the marker: contribute (finished campaign) reads "← Campaigns"', await waitText('#flow-back', '← Campaigns'));
      check('  ... the ticket step\'s back link reads "← Back to home"', (await page.textContent('#tk-back')).trim() === '← Back to home');
      await page.click('#flow-back');
      check('  ... and the top left link leads to the demo\'s start page', samePath(page.url(), DEMO), page.url());
    }

    // 7. a page server that is not the demo (as the live site) ignores the marker
    if (!LIVE) {
      const id = await openProofs('Auction', 'pass');
      const u = new URL(DEMO);
      const href = (await linkOf(id, 'Campaign')).replace(`${u.origin}${u.pathname}campaign.html`, `${u.origin}/live/campaign.html`).replaceAll(`${u.origin}${u.pathname}relays/`, `${u.origin}/live/relays/`);
      await page.goto(href);
      check('elsewhere, with the marker: the campaign page still reads "← Campaigns"', await waitText('.ctop .cback', '← Campaigns'), await linkText('.ctop .cback'));
      await page.waitForSelector('#view', { timeout: 60000 });
      await page.click('.ctop .cback');
      check('  ... and leads to that site\'s own start, as today', new URL(page.url()).pathname === '/live/', page.url());
      await page.goto(href.replace('campaign.html', 'recount.html'));
      await page.waitForFunction(() => /campaign\.html#/.test(document.querySelector('#nav-campaign').getAttribute('href') || ''), null, { timeout: 120000 });
      check('elsewhere, with the marker: the recount page still reads "← Campaign"', (await page.textContent('#nav-campaign')).trim() === '← Campaign');
      check('  ... and its link carries no marker onward', !/proofs/.test(await page.getAttribute('#nav-campaign', 'href')));
    }
  } catch (e) {
    check('run', false, String(e).slice(0, 400));
  }
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
