// Campaign names on every page. Env (set by polish-b.sh): ID_PLAIN, ID_SET, ID_LONG, ID_ODD (campaigns on the test's own relay 8791), DIR (built static
// folder), DASH_PORT (a running dashboard that holds a campaign named "Dashboard test name"). The chain server is a stand-in answered by this test.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8803', SHOTS = process.env.SHOTS || 'runs/design-shots', DASH = process.env.DASH_PORT || '8781';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, RELAY = 'http://127.0.0.1:8791', MOCK = 'https://chain.mock.test/testnet';
const NAMES = { ID_SET: 'Community radio mast', ID_LONG: 'Long name ' + '0123456789'.repeat(5), ID_ODD: 'Café ☕ & 東京 – "mast" #1 100% &lt;b&gt;' };
const EX_NAMED = process.env.EX_NAMED, EX_NAMED_NAME = process.env.EX_NAMED_NAME, EX_PLAIN = '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f';
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);
const PAGES = ['contribute', 'campaign', 'card', 'recount', 'badge'];
const hash = (id, relay, extra = '') => `#c=${id}&relay=${relay}&server=${encodeURIComponent(MOCK)}${extra}`;

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  const open = async (w = 1000, h = 900) => {
    const p = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.route(`${MOCK}/**`, async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(route.request().url()) ? frame(0, [0x08, ...varint(4400000)]) : Buffer.alloc(0);
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
    return p;
  };
  const label = async (p, page) => { // the top-right label (badge: the badge's own name line), once it has been filled in
    const sel = page === 'badge' ? '#badge-name' : '#campaign-id';
    await p.waitForTimeout(page === 'badge' ? 4000 : 6000);
    return { text: await p.evaluate((s) => document.querySelector(s).textContent, sel), kids: await p.evaluate((s) => document.querySelector(s).children.length, sel), title: await p.evaluate((s) => document.querySelector(s).title, sel) };
  };
  try {
    // ---------- every page shows the name, as plain text ----------
    for (const page of PAGES) {
      for (const [key, name] of Object.entries(NAMES)) {
        const id = process.env[key];
        const p = await open();
        await p.goto(`${BASE}/${page}.html${hash(id, RELAY)}`);
        const l = await label(p, page);
        check(`${page}: the campaign's own name is shown (${key.slice(3).toLowerCase()})`, l.text === name, JSON.stringify(l.text.slice(0, 70)));
        check(`${page}: ... as plain text (no element was created from it)`, l.kids === 0);
        await p.context().close();
      }
      const p = await open();
      await p.goto(`${BASE}/${page}.html${hash(process.env.ID_PLAIN, RELAY)}`);
      const l = await label(p, page);
      const short = process.env.ID_PLAIN.slice(0, 8);
      check(`${page}: a campaign without a name keeps the short label`, l.text.includes(`${short}…`) && !/mast/i.test(l.text), JSON.stringify(l.text));
      await p.context().close();
    }
    // ---------- a name that does not belong to the rules is never shown ----------
    for (const page of ['contribute', 'badge', 'campaign']) {
      const p = await open();
      await p.route(`${RELAY}/v1/campaigns/${process.env.ID_SET}`, async (route) => {
        const res = await route.fetch(); const j = await res.json(); j.name = 'Official Bank Refund Desk';
        await route.fulfill({ response: res, body: JSON.stringify(j) });
      });
      await p.goto(`${BASE}/${page}.html${hash(process.env.ID_SET, RELAY)}`);
      await p.waitForTimeout(8000);
      const all = await p.evaluate(() => document.body.innerText);
      check(`${page}: rules with a forged name are refused or shown without it, never with it`, !/Official Bank Refund Desk/.test(all), '');
      await p.context().close();
    }
    // ---------- old campaigns, and one with a name, through the static folder ----------
    let p = await open();
    await p.goto(`${BASE}/campaign.html${hash(EX_PLAIN, BASE + '/relays/a')}`);
    let l = await label(p, 'campaign');
    check('an old campaign (made before names existed) still loads and is labelled by its short id', l.text === `${EX_PLAIN.slice(0, 8)}…`, l.text);
    await p.context().close();
    if (EX_NAMED) {
      p = await open();
      await p.goto(`${BASE}/campaign.html${hash(EX_NAMED, BASE + '/relays/a')}`);
      l = await label(p, 'campaign');
      check('the named static example shows its name', l.text === EX_NAMED_NAME, l.text);
      await p.screenshot({ path: `${SHOTS}/polish-b-named.png` });
      await p.context().close();
    }
    // ---------- layout: the longest name on a phone ----------
    p = await open(390, 844);
    await p.goto(`${BASE}/contribute.html${hash(process.env.ID_LONG, RELAY)}`);
    await label(p, 'contribute');
    check('390 px wide, 60-character name: no sideways scrolling and the name stays on one line', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#campaign-id').getBoundingClientRect().height < 30));
    await p.screenshot({ path: `${SHOTS}/polish-b-390-long.png` });
    await p.context().close();
    // ---------- dashboard: the set-up form and the list ----------
    p = await open();
    await p.goto(`http://127.0.0.1:${DASH}/setup.html`);
    await p.waitForSelector('#campaign-name', { timeout: 20000 });
    const note = (await p.textContent('#campaign-name + .hint')).replace(/\s+/g, ' ');
    check('set-up form: an optional name field with the note "The name is public. Do not put anything private in it."', /The name is public\. Do not put anything private in it\./.test(note) && (await p.getAttribute('#campaign-name', 'maxlength')) === '60');
    await p.context().close();
    p = await open();
    await p.goto(`http://127.0.0.1:${DASH}/`);
    await p.waitForSelector('#campaign-select option', { state: 'attached', timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(3000);
    const opts = await p.evaluate(() => [...document.querySelectorAll('#campaign-select option')].map((o) => o.textContent));
    check('dashboard list: a named campaign is listed by its name, an unnamed one by the short number', opts.some((o) => /^Dashboard test name \(/.test(o)) && opts.some((o) => /^[0-9a-f]{8}… \(/.test(o)), JSON.stringify(opts));
    await p.context().close();
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally { srv.kill(); await browser.close(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
