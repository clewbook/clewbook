// Short campaign links, in a real browser, with the real page server (serve.py) and stand ins for the relays and the chain servers: no
// network, no money. /c/<first 8 characters> opens the campaign the listing names (any letter case); two campaigns that share those 8
// characters get a pick list, the older first, each with its full id, title and date; none gets one line "Campaign not found"; an old long
// link still works, and one without a relay uses the project's relay; the campaign page keeps the full id under "more"; Copy link on the
// campaign and bid pages copies the short link for a listed campaign and the full link otherwise.
// Env: RELAY_COPY (a folder with a copy of a relay's data holding the two main network auctions named below), PORT (default 8961).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const PORT = Number(process.env.PORT || 8961), BASE = `http://127.0.0.1:${PORT}`;
const RELAY_COPY = process.env.RELAY_COPY, WORK = process.env.WORK || 'runs/shortlink-e2e';
const PROJECT_RELAY = 'https://relay.clewbook.xyz', STUB_RELAY = 'https://relay.stub.test';
const APPARITION = '5f40200a94bd98a655eb25c36b8b26b7b12c7d2240e7f3270e64b11c9e59c20d'; // listed (main network blind bid auction)
const SKULL = '7b018c43'; // not listed (shared by link only)
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata/shortlink-collision.json'), 'utf8'));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  ' + extra : ''}`); if (!ok) failed++; };

// the page server's root: the pages, and a listing with Apparition 69_ and the two campaigns that share their first 8 characters
fs.rmSync(WORK, { recursive: true, force: true });
fs.cpSync(path.join(__dirname, 'www'), path.join(WORK, 'www'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'www/campaigns.json'), JSON.stringify({ campaigns: [
  { id: APPARITION, relays: [PROJECT_RELAY] }, { id: fx.newer.id, relays: [STUB_RELAY] }, { id: fx.older.id, relays: [STUB_RELAY] },
] }));
const skull = fs.readdirSync(path.join(RELAY_COPY, 'campaigns')).find((d) => d.startsWith(SKULL));

// the relays: the project's from the copy, the stand in from the fixture (rules, an empty list)
function relayAnswer(url) {
  const m = /\/v1\/campaigns\/([0-9a-f]{64})(\/[a-z]+)?/.exec(url);
  if (!m) return null;
  const [, id, sub] = m;
  if (url.startsWith(STUB_RELAY)) {
    const f = [fx.older, fx.newer].find((x) => x.id === id);
    if (!f) return null;
    return !sub ? f.rules : sub === '/ledger' ? '[]' : sub === '/challenges' ? '[]' : null;
  }
  const dir = path.join(RELAY_COPY, 'campaigns', id);
  if (!fs.existsSync(dir)) return null;
  if (!sub) return fs.readFileSync(path.join(dir, 'rules.json'), 'utf8');
  if (sub === '/ledger') return `[${fs.readdirSync(path.join(dir, 'ledger')).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => fs.readFileSync(path.join(dir, 'ledger', f), 'utf8')).join(',')}]`;
  if (sub === '/challenges') return '[]';
  return null;
}
// the chain servers: the tip is block 3,527,500; a block's time is 1,792,000,000 + 75 s × its height (an older start is an earlier date);
// everything else is refused
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frames = (msg) => Buffer.concat([Buffer.from([0, ...[24, 16, 8, 0].map((s) => (msg.length >>> s) & 255)]), Buffer.from(msg), Buffer.from([0x80, 0, 0, 0, 15]), Buffer.from('grpc-status:0\r\n')]);
const timeOf = (h) => 1792000000 + 75 * h;
const relayHits = [];

(async () => {
  const srv = spawn('python3', ['-B', path.join(__dirname, 'serve.py'), String(PORT), '127.0.0.1'], { env: { ...process.env, SERVE_ROOT: path.join(WORK, 'www') }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  const fresh = async () => {
    const ctx = await browser.newContext();
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
      const u = route.request().url(), method = route.request().method();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-grpc-web', 'access-control-allow-methods': 'GET, POST' };
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (u.startsWith(PROJECT_RELAY) || u.startsWith(STUB_RELAY)) {
        relayHits.push(u);
        const body = relayAnswer(u);
        return body == null ? route.fulfill({ status: 404, headers: cors, body: '{"error":"not found"}' }) : route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body });
      }
      if (/\/GetBlockRange$/.test(u)) {
        const b = route.request().postDataBuffer(); let i = 7, h = 0, m = 1, x; // frame (5), BlockRange.start (2), BlockID.height key (1)
        do { x = b[i + 1]; h += (x & 0x7f) * m; m *= 128; i++; } while (x & 0x80);
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: frames([0x10, ...varint(h), 0x28, ...varint(timeOf(h))]) });
      }
      if (/\/GetLatestBlock$/.test(u)) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: frames([0x08, ...varint(3527500)]) });
      return route.abort();
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    return { ctx, p };
  };
  const text = async (p, sel) => ((await p.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  try {
    // 1. one campaign begins with these 8 characters: its campaign page, with the relay the listing gives
    let { ctx, p } = await fresh();
    await p.goto(`${BASE}/c/5f40200a`);
    await p.waitForFunction(() => /campaign\.html#c=/.test(location.href), null, { timeout: 20000 });
    check('/c/5f40200a opens the campaign page of the full id, with the relay the listing gives', p.url() === `${BASE}/campaign.html#c=${APPARITION}&relay=${PROJECT_RELAY}`, p.url());
    await p.waitForFunction(() => /Apparition 69_/.test(document.querySelector('#display-name')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    check('and it shows Apparition 69_', /Apparition 69_/.test(await text(p, '#display-name')), await text(p, '#display-name'));
    check('the full id is under "more"', (await p.$eval('#id-more summary', (s) => s.textContent)) === 'more' && (await text(p, '#full-id')) === APPARITION);
    await p.click('#copy-link'); await p.waitForTimeout(500);
    check('Copy link on the campaign page copies the short link', (await p.evaluate(() => navigator.clipboard.readText())) === `${BASE}/c/5f40200a`, await p.evaluate(() => navigator.clipboard.readText()));
    await ctx.close();
    ({ ctx, p } = await fresh());
    await p.goto(`${BASE}/c/5F40200A`);
    await p.waitForFunction(() => /campaign\.html#c=/.test(location.href), null, { timeout: 20000 });
    check('the short link works in capital letters too', p.url().includes(`#c=${APPARITION}`));
    await ctx.close();

    // 2. two campaigns begin with the same 8 characters: a pick list, the older first, each with its full id, title and date
    ({ ctx, p } = await fresh());
    const pre = fx.older.id.slice(0, 8);
    await p.goto(`${BASE}/c/${pre}`);
    await p.waitForSelector('#go-list:not([hidden])', { timeout: 30000 });
    const items = await p.$$eval('#go-list li', (lis) => lis.map((li) => ({ title: li.querySelector('a').textContent, href: li.querySelector('a').getAttribute('href'), id: li.querySelector('code').textContent, line: li.textContent })));
    check('two campaigns share the 8 characters: a pick list of both, nothing opened by itself', items.length === 2 && /campaign\.html|go\.html/.test(p.url()) && p.url().includes('go.html'), JSON.stringify(items.map((i) => i.title)));
    check('the older campaign is first', items[0] && items[0].id === fx.older.id && items[1].id === fx.newer.id, items.map((i) => i.id.slice(0, 12)).join(' then '));
    const olderStart = JSON.parse(fx.older.rules).start_height, newerStart = JSON.parse(fx.newer.rules).start_height;
    check('each shows its full id, its title and the date it was made', items.every((i) => /^[0-9a-f]{64}$/.test(i.id)) && /^Shortlink test A /.test(items[0].title) && /^Shortlink test B /.test(items[1].title)
      && items[0].line.includes(new Date(timeOf(olderStart) * 1000).toUTCString().replace(/ GMT$/, ' UTC')) && items[1].line.includes(new Date(timeOf(newerStart) * 1000).toUTCString().replace(/ GMT$/, ' UTC')), items.map((i) => i.line.slice(-60)).join(' | '));
    check('each opens its own campaign', items.every((i) => i.href.includes(`#c=${i.id}&relay=${STUB_RELAY}`)));
    check('the page says why', /More than one campaign has this link/.test(await text(p, '#go-title')));
    await ctx.close();

    // 3. none: one line
    for (const tail of ['deadbeef', 'xyz']) {
      ({ ctx, p } = await fresh());
      await p.goto(`${BASE}/c/${tail}`);
      await p.waitForFunction(() => document.querySelector('#go-title').textContent === 'Campaign not found', null, { timeout: 20000 }).catch(() => {});
      check(`/c/${tail}: one line "Campaign not found"`, (await text(p, '#go-title')) === 'Campaign not found' && (await text(p, '#go-line')) === '' && (await p.$eval('#go-list', (l) => l.hidden)));
      await ctx.close();
    }

    // 4. old long links still work; a link without a relay uses the project's relay
    ({ ctx, p } = await fresh());
    await p.goto(`${BASE}/campaign.html#c=${fx.older.id}&relay=${STUB_RELAY}`);
    await p.waitForFunction(() => /Shortlink test A/.test(document.querySelector('#display-name')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    check('an old long link with its relay still works', /Shortlink test A/.test(await text(p, '#display-name')), await text(p, '#display-name'));
    await p.click('#copy-link'); await p.waitForTimeout(500);
    check('Copy link copies the full link when another listed campaign shares the 8 characters', (await p.evaluate(() => navigator.clipboard.readText())) === p.url());
    await ctx.close();
    relayHits.length = 0;
    ({ ctx, p } = await fresh());
    await p.goto(`${BASE}/campaign.html#c=${APPARITION}`);
    await p.waitForFunction(() => /Apparition 69_/.test(document.querySelector('#display-name')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    check('a campaign link without a relay uses https://relay.clewbook.xyz', /Apparition 69_/.test(await text(p, '#display-name')) && relayHits.some((u) => u.startsWith(`${PROJECT_RELAY}/v1/campaigns/${APPARITION}`)), relayHits.length);
    await ctx.close();
    for (const page of ['contribute', 'bid']) {
      relayHits.length = 0;
      ({ ctx, p } = await fresh());
      await p.goto(`${BASE}/${page}.html#c=${APPARITION}`);
      await p.waitForTimeout(4000);
      check(`the ${page} page without a relay in its link asks https://relay.clewbook.xyz`, relayHits.some((u) => u.startsWith(`${PROJECT_RELAY}/v1/campaigns/${APPARITION}`)), relayHits.length);
      await ctx.close();
    }

    // 5. the bid page's Copy link: the short link for a listed auction, the full link for one shared by link only
    for (const [name, id, short] of [['Apparition 69_ (listed)', APPARITION, true], ['Skull of Icul (not listed)', skull, false]]) {
      ({ ctx, p } = await fresh());
      await p.goto(`${BASE}/bid.html#c=${id}&relay=${PROJECT_RELAY}`);
      await p.waitForSelector('#status-line:not([hidden])', { timeout: 30000 }).catch(() => {});
      await p.click('#copy-link'); await p.waitForTimeout(800);
      const got = await p.evaluate(() => navigator.clipboard.readText());
      check(`bid page, ${name}: Copy link copies the ${short ? 'short' : 'full'} link`, short ? got === `${BASE}/c/${id.slice(0, 8)}` : got === p.url(), got);
      await ctx.close();
    }

    // 6. the page server: only short links of letters and digits are sent on
    const res = await fetch(`${BASE}/c/5f40200a`, { redirect: 'manual' });
    check('the page server sends /c/<id> on to go.html', res.status === 302 && res.headers.get('location') === '/go.html?p=5f40200a', `${res.status} ${res.headers.get('location')}`);
    const bad = await fetch(`${BASE}/c/5f40200a/x`, { redirect: 'manual' });
    check('anything else under /c/ is not found', bad.status === 404, String(bad.status));
    check('no page error', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
