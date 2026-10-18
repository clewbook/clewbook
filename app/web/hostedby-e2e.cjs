// "Hosted by <label>" on opened campaigns only. A copy of the plain files from app/web/make-static.sh (default runs/static-polish), the app's
// home page added as home.html, and an invented campaigns.json: one campaign of an approved host, one with a label holding HTML like signs
// written as text, one whose label breaks the name rules (has < and >), and one of the hand kept list (no host). A campaign opened by direct
// link but not in the list shows nothing either. Chain servers are a stand in answered by this test: no network, no money.
// Env: DIR, PORT (default 8807), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8807', SHOTS = process.env.SHOTS || 'runs/design-shots';
const SITE = 'runs/hostedby-site';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, MOCK = 'https://chain.mock.test/testnet';
const OPEN = { id: '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da', deadline: 4477610 }; // approved host, open fundraiser
const CLOSED = '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f'; // approved host, closed (refunded)
const SIGNS = '5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb'; // label with & and quotes and an entity written as text
const BROKEN = 'f6737fbc462e75508d424f0612a1ce5ea3df24c5cc1b550074821ccdea5e237a'; // label with < and >: refused by the name rules
const HAND = 'd119ba4b6b032cacf5d5838eef8aa9ec5903a224b9c6d9f6cca9362f70d49671'; // hand kept list entry: no host
const UNLISTED = '80fc0eb3081ac58d91ac95fec1fe92286c49d000d5bdd24befe5c53153ed025d'; // opened by direct link, not in campaigns.json
const SIGNS_LABEL = 'Tom & "Jerry\'s" &lt;b&gt; Co';
const TITLE = 'Name given by Clewbook to an approved host.';
const page = (file, id) => `${BASE}/${file}#c=${id}&relay=${BASE}/relays/a&relay=${BASE}/relays/b&server=${encodeURIComponent(MOCK)}`;
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);
const BANNED = /\b(anonymous|secure|trustless|guaranteed)\b/i;

// the site: the plain files, the app's home page, and the invented list
fs.rmSync(SITE, { recursive: true, force: true });
execFileSync('cp', ['-a', DIR, SITE]);
fs.copyFileSync('app/web/www/index.html', `${SITE}/home.html`);
fs.copyFileSync('app/web/www/home.js', `${SITE}/home.js`);
const relays = [`${BASE}/relays/a`];
const host = (label) => ({ label, fingerprint: 'abcd 1234 abcd 1234 abcd' });
fs.writeFileSync(`${SITE}/campaigns.json`, JSON.stringify({ campaigns: [
  { id: HAND, relays },
  { id: OPEN.id, relays, host: host('Garden Collective') },
  { id: CLOSED, relays, host: host('Garden Collective') },
  { id: SIGNS, relays, host: host(SIGNS_LABEL) },
  { id: BROKEN, relays, host: host('<b>Bold</b> Hosts') },
] }));

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', SITE], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  const open = async (url, { w = 1280, theme = 'light', listFails = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('cb-theme', t); } catch {} }, theme);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.route('**/*', async (route) => {
      const u = route.request().url();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (listFails && u === `${BASE}/campaigns.json`) return route.fulfill({ status: 500, body: 'no' });
      if (u.startsWith(BASE) && !/\/grpc\//.test(u)) return route.continue();
      // every chain server (the stand in, the public ones the home page asks, this computer's /grpc/ forwarder): one stand in answer
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(u) ? frame(0, [0x08, ...varint(OPEN.deadline - 100)]) : Buffer.alloc(0);
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
    await p.goto(url);
    return p;
  };
  const line = async (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e ? { shown: !e.hidden && e.offsetParent !== null, text: e.textContent, title: e.title, html: e.innerHTML } : null; }, sel);
  const settle = (p) => p.waitForTimeout(2500);
  try {
    // campaign page: open and closed, an approved host
    for (const [id, state] of [[OPEN.id, 'open'], [CLOSED, 'closed']]) {
      const p = await open(page('campaign.html', id));
      await p.waitForSelector('#display-name', { timeout: 60000 }); await settle(p);
      const l = await line(p, '#hosted-by');
      check(`campaign page, ${state}: "Hosted by Garden Collective" under the name, with the tooltip`, l && l.shown && l.text === 'Hosted by Garden Collective' && l.title === TITLE, JSON.stringify(l));
      const below = await p.evaluate(() => document.querySelector('#hosted-by').getBoundingClientRect().top >= document.querySelector('#display-name').getBoundingClientRect().bottom - 1);
      check(`campaign page, ${state}: the line sits under the campaign name`, below);
      await p.context().close();
    }
    // contribute page: the header line (open), and the closed page's own campaign view
    {
      const p = await open(page('contribute.html', OPEN.id));
      await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 }); await settle(p);
      const l = await line(p, '#hosted-by-c');
      check('contribute page, open: "Hosted by Garden Collective" under the name in the header', l && l.shown && l.text === 'Hosted by Garden Collective' && l.title === TITLE, JSON.stringify(l));
      await p.context().close();
      const q = await open(page('contribute.html', CLOSED));
      await q.waitForSelector('#display-name', { timeout: 60000 }); await settle(q);
      const c = await line(q, '#hosted-by'), h = await line(q, '#hosted-by-c');
      check('contribute page, closed: the line in the campaign view, the header line not shown twice', c && c.shown && c.text === 'Hosted by Garden Collective' && !(h && h.shown), JSON.stringify([c, h]));
      await q.context().close();
    }
    // HTML like signs: plain text; < and >: refused by the name rules, nothing shown
    {
      const p = await open(page('campaign.html', SIGNS));
      await p.waitForSelector('#display-name', { timeout: 60000 }); await settle(p);
      const l = await line(p, '#hosted-by');
      check('a label with & and quotes and an entity written as text: shown exactly as text, no markup made', l && l.shown && l.text === `Hosted by ${SIGNS_LABEL}` && !/<b>/i.test(l.html) && (await p.$$('#hosted-by *')).length === 0, JSON.stringify(l));
      await p.context().close();
      const q = await open(page('campaign.html', BROKEN));
      await q.waitForSelector('#display-name', { timeout: 60000 }); await settle(q);
      const b = await line(q, '#hosted-by');
      check('a label with < and > (against the name rules): nothing shown', b && !b.shown && b.text === '' && !(await q.evaluate(() => /Bold|Hosted by/.test(document.body.innerText))), JSON.stringify(b));
      await q.context().close();
    }
    // the hand kept list (no host) and a campaign not in the list: nothing, on both pages
    for (const [id, what] of [[HAND, 'a hand kept list campaign'], [UNLISTED, 'a campaign opened by direct link, not in the list']]) {
      for (const file of ['campaign.html', 'contribute.html']) {
        const p = await open(page(file, id));
        await p.waitForSelector('#display-name, #form-card:not([hidden])', { timeout: 60000 }); await settle(p);
        check(`${what}, ${file}: no Hosted by line`, !(await p.evaluate(() => /Hosted by/.test(document.body.innerText))));
        await p.context().close();
      }
    }
    // campaigns.json cannot be read: nothing shown, the page works
    {
      const p = await open(page('campaign.html', OPEN.id), { listFails: true });
      await p.waitForSelector('#display-name', { timeout: 60000 }); await settle(p);
      check('campaigns.json fails: no line, the campaign page still shows', !(await p.evaluate(() => /Hosted by/.test(document.body.innerText))) && (await p.isVisible('#display-name')));
      await p.context().close();
    }
    // the home page: cards and the closed list never show a label
    {
      const p = await open(`${BASE}/home.html`);
      // wait until the cards and the closed list are drawn (the listed campaigns are open and closed examples)
      await p.waitForFunction(() => document.querySelectorAll('#live .card, #closed .row, #closed a').length >= 3, null, { timeout: 60000 });
      await p.waitForTimeout(2000);
      const drawn = await p.evaluate(() => document.querySelectorAll('#live .card, #closed .row, #closed a').length);
      const t = await p.evaluate(() => document.body.innerText);
      check('home page: the campaigns are drawn, and no Hosted by and no label anywhere', drawn >= 3 && !/Hosted by|Garden Collective|Jerry/.test(t), `${drawn} cards or rows`);
      await p.context().close();
    }
    // 1280 and 390, light and dark: the line fits (no sideways scroll), quiet, plain words
    const long = 'Garden Collective of the Northern Valley Hosts and Friends A';
    const site = JSON.parse(fs.readFileSync(`${SITE}/campaigns.json`, 'utf8'));
    site.campaigns.find((c) => c.id === CLOSED).host.label = long;
    fs.writeFileSync(`${SITE}/campaigns.json`, JSON.stringify(site));
    for (const [w, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
      for (const [id, tag] of [[CLOSED, 'campaign-long'], [OPEN.id, 'contribute']]) {
        const p = await open(page(tag === 'contribute' ? 'contribute.html' : 'campaign.html', id), { w, theme });
        await p.waitForSelector(tag === 'contribute' ? '#form-card:not([hidden])' : '#display-name', { timeout: 60000 }); await settle(p);
        const r = await p.evaluate((sel) => { const e = document.querySelector(sel); const b = e.getBoundingClientRect(); return { over: document.documentElement.scrollWidth > innerWidth + 1, inside: b.right <= innerWidth + 1, text: e.innerText }; }, tag === 'contribute' ? '#hosted-by-c' : '#hosted-by');
        check(`${w} ${theme} ${tag}: the line fits, no sideways scroll, plain words`, !r.over && r.inside && /^Hosted by /.test(r.text) && !/[—–]/.test(r.text) && !BANNED.test(r.text + TITLE), JSON.stringify(r).slice(0, 120));
        await p.screenshot({ path: `${SHOTS}/hostedby-${tag}-${w}-${theme}.png` });
        await p.context().close();
      }
    }
  } catch (e) {
    console.log('TEST ERROR', e);
    failed++;
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  srv.kill();
  fs.rmSync(SITE, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
