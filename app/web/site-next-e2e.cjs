// The new home page, the network bars, the recount buttons, the recount page's upload mode and the contribute page's network rules, in a real browser,
// on a copy of app/web/www served on a spare port, with a campaign list that names at least one live campaign (make it with: cp -r app/web/www
// runs/site-next && cp runs/campaigns.json runs/site-next/campaigns.json, the hand kept list; the former make-next.sh and app/web/next are gone). A mainnet page is read from the real public relay (read only); testnet pages are
// read from the example campaigns (as files, through a stand-in relay), with a stand-in chain server. No payment is made.
// Env: SITE (folder, default runs/site-next), PORT (default 8776, the server is started by this test), SHOTS (screenshots; keep them outside the repo),
//      EXAMPLES (default runs/static-polish/relays/a), SAVED (a saved copy of a testnet campaign, default runs/final-test/good.json).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const SITE = process.env.SITE || 'runs/site-next', PORT = process.env.PORT || '8776', SHOTS = process.env.SHOTS || `${process.env.HOME}/site-next-screens`;
const EX = process.env.EXAMPLES || 'runs/static-polish/relays/a', SAVED = process.env.SAVED || 'runs/final-test/good.json';
const BASE = `http://127.0.0.1:${PORT}`, MOCK = 'https://chain.mock.test/testnet', REL = 'http://relay.test';
const TEST = { id: '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da', deadline: 4477610 };
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);
const list = JSON.parse(fs.readFileSync(path.join(SITE, 'campaigns.json'), 'utf8')).campaigns;
const LOCAL = new RegExp(`localhost|:8780|127\\.0\\.0\\.1:(?!${PORT}\\b)`); // this computer's own addresses (the test's own server excepted)
const text = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();

(async () => {
  const srv = spawn('python3', ['app/web/serve.py', PORT, '127.0.0.1'], { stdio: 'ignore', env: { ...process.env, SERVE_ROOT: SITE } });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [], seenReq = [];
  let tip = TEST.deadline - 100;
  const open = async (url, { w = 390, h = 844, mock = true, route } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: w < 600, hasTouch: w < 600, acceptDownloads: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('request', (r) => seenReq.push(r.url()));
    await p.route(`${MOCK}/**`, async (rt) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (rt.request().method() === 'OPTIONS') return rt.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(rt.request().url()) ? frame(0, [0x08, ...varint(tip)]) : Buffer.alloc(0);
      await rt.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
    await p.route(`${REL}/**`, async (rt) => {
      const u = new URL(rt.request().url()); const m = /^\/v1\/campaigns\/([0-9a-f]{64})(?:\/(ledger|challenges|tickets\/[0-9a-f]{64}))?$/.exec(u.pathname);
      const cors = { 'access-control-allow-origin': '*' };
      if (!m || m[1] !== TEST.id) return rt.fulfill({ status: 404, headers: cors, body: '{}' });
      const f = path.join(EX, 'v1/campaigns', m[1], m[2] || 'index.html');
      if (!fs.existsSync(f)) return rt.fulfill({ status: 404, headers: cors, body: '{}' });
      await rt.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: fs.readFileSync(f) });
    });
    if (route) await route(p);
    await p.goto(url);
    return p;
  };
  const links = async (p) => p.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href));
  const mainItem = list.find((c) => c.relays.some((r) => /^https:/.test(r)));
  const testLink = (page, extra = '') => `${BASE}/${page}.html#c=${TEST.id}&relay=${REL}${extra}`;
  const mainLink = (page, extra = '') => `${BASE}/${page}.html#c=${mainItem.id}&relay=${mainItem.relays[0]}${extra}`;
  const crawl = [];
  try {
    // ---------- 1. the home page ----------
    let p = await open(`${BASE}/`);
    await p.waitForSelector('.card', { timeout: 120000 });
    await p.waitForTimeout(1500);
    const sentences = (await text(p, '.home-lead')).split(/(?<=[.!?])\s+/).filter(Boolean).length;
    check('home: a description of two or three sentences', sentences >= 2 && sentences <= 3, `${sentences}`);
    const cards = await p.evaluate(() => [...document.querySelectorAll('.card')].map((c) => ({ title: c.querySelector('strong').textContent, chip: (c.querySelector('.netchip') || {}).textContent, status: c.querySelector('.status').textContent, where: c.parentElement.id, btns: [...c.querySelectorAll('a.btn')].map((a) => a.textContent) })));
    check('home: the campaigns of campaigns.json are listed, each marked with its network', cards.length === list.length && cards.every((c) => /^(ZCASH MAINNET|TEST MONEY ONLY)$/.test(c.chip || '')), JSON.stringify(cards.map((c) => [c.chip, c.where])));
    check('home: open and closed campaigns are in their own lists, and every card has "Recount this campaign"', cards.every((c) => (c.where === 'closed') === /^Closed/.test(c.status) && c.btns.includes('Recount this campaign')), JSON.stringify(cards.map((c) => c.status)));
    check('home: closed campaigns have no Contribute or Bid button', cards.filter((c) => c.where === 'closed').every((c) => !c.btns.some((b) => /Contribute|Bid/.test(b))));
    const hl = await links(p);
    check('home: links to the recount page (upload), the host page and exactly one plain link to /demo on the root domain; nothing points at this computer\'s dashboard', hl.some((h) => /\/recount\.html$/.test(h)) && hl.some((h) => /\/host\.html$/.test(h)) && hl.filter((h) => /\/demo/.test(h)).join() === 'https://clewbook.xyz/demo' && !hl.some((h) => LOCAL.test(h)), JSON.stringify(hl.filter((h) => /demo/.test(h) || LOCAL.test(h))));
    const words = /\bdemo\b|play money|start page/i;
    check('home: the words "demo", "play money" and "start page" are not used (only the one plain test-money link)', !words.test(await p.evaluate(() => document.body.innerText)), String((await p.evaluate(() => document.body.innerText)).match(words)));
    check('home: no network bar (each card names its network)', (await p.locator('#netbar').count()) === 0);
    crawl.push(...hl);
    await p.screenshot({ path: `${SHOTS}/home-390.png`, fullPage: true });
    const wide = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    check('home: no sideways scrolling at 390 px', wide);
    await p.context().close();

    // the host page
    p = await open(`${BASE}/host.html`);
    await p.waitForTimeout(1500);
    const ht = await p.evaluate(() => document.body.innerText), hh = await links(p);
    const hl2 = await p.evaluate(() => [...document.querySelectorAll('.hactions a')].map((a) => [a.textContent.trim(), a.getAttribute('href'), a.target, a.rel]));
    check('host: the host page of the handoff (headline, six cards, the two links in a new tab), no link to a local dashboard', /Host your own campaign/.test(ht) && (await p.locator('.htc').count()) === 6 && /Hosting is guided by us for now\./.test(ht)
      && JSON.stringify(hl2) === JSON.stringify([['Host yourself ↗', 'https://github.com/clewbook/clewbook/blob/main/docs/HOSTING.md', '_blank', 'noopener'], ['Contact us', 'https://github.com/clewbook/clewbook/issues/new?title=Host%20with%20us', '_blank', 'noopener']])
      && !hh.some((h) => LOCAL.test(h)) && !/\bdemo\b|play money|start page/i.test(ht), JSON.stringify(hl2));
    check('host: no sideways scrolling at 390 px', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await p.screenshot({ path: `${SHOTS}/host-390.png`, fullPage: true });
    crawl.push(...hh);
    await p.context().close();

    // ---------- 2. the network bar ----------
    let hold; const gate = new Promise((r) => { hold = r; });
    p = await open(testLink('campaign'), { route: async (pg) => { await pg.route(`${REL}/**`, async (rt) => { await gate; await rt.fallback(); }); } });
    await p.waitForTimeout(800);
    const first = await p.evaluate(() => ({ cls: document.querySelector('#netbar').className, t: document.querySelector('#netbar').textContent, net: document.documentElement.dataset.net || null, amounts: /\b(TAZ|ZEC)\b/.test(document.querySelector('#netbar').textContent) }));
    check('banner: neutral grey "Checking network…" with no amounts until the rules are read', first.cls === 'netbar checking' && first.t === 'Checking network…' && !first.net && !first.amounts, JSON.stringify(first));
    hold();
    await p.waitForSelector('#netbar.test', { timeout: 60000 });
    const tb = await p.evaluate(() => ({ t: document.querySelector('#netbar').textContent, bg: getComputedStyle(document.querySelector('#netbar')).backgroundColor }));
    check('banner, testnet campaign page: just the word "ZCASH TESTNET" (no sentence), amber', /^ZCASH TESTNET$/.test(tb.t) && tb.bg === 'rgb(244, 233, 207)', JSON.stringify(tb));
    await p.waitForTimeout(2500);
    check('testnet amounts carry TAZ (goal and smallest contribution)', /Goal0\.5\S* TAZ/.test(await text(p, '#facts')) && !/\bZEC\b/.test(await text(p, 'main')), (await text(p, '#facts')).slice(0, 80));
    await p.screenshot({ path: `${SHOTS}/campaign-testnet-390.png`, fullPage: true });
    crawl.push(...await links(p));
    await p.context().close();

    p = await open(mainLink('campaign'));
    await p.waitForSelector('#netbar.main', { timeout: 120000 });
    await p.waitForTimeout(4000);
    const mb = await p.evaluate(() => ({ t: document.querySelector('#netbar').textContent, bg: getComputedStyle(document.querySelector('#netbar')).backgroundColor }));
    check('mainnet campaign page: no "demo", "play money" or "start page" wording; the badge preview on it has no network bar of its own', !/\bdemo\b|play money|start page/i.test(await p.evaluate(() => document.body.innerText)) && (await Promise.all(p.frames().filter((f) => f !== p.mainFrame()).map((f) => f.locator('#netbar').count()))).every((n) => n === 0));
    check('banner, mainnet campaign page: just the word "ZCASH MAINNET" (no sentence), dark, nothing like the testnet bar', /^ZCASH MAINNET$/.test(mb.t) && mb.bg === 'rgb(43, 43, 47)' && mb.bg !== tb.bg, JSON.stringify(mb));
    check('mainnet page shows ZEC, never TAZ, and never the words "test network"', /ZEC/.test(await text(p, 'main')) && !/\bTAZ\b/.test(await text(p, 'main')) && !/test network/i.test(await text(p, 'main')));
    await p.screenshot({ path: `${SHOTS}/campaign-mainnet-390.png`, fullPage: true });
    check('campaign page: "Recount this campaign" opens the recount for that campaign, no pasting', await (async () => { const h = await p.getAttribute('#recount-link', 'href'); return h.includes(`recount.html#c=${mainItem.id}`) && h.includes(`relay=${mainItem.relays[0]}`); })());
    crawl.push(...await links(p));
    await p.context().close();

    // side by side: a mainnet page and a testnet page
    const a = fs.readFileSync(`${SHOTS}/campaign-mainnet-390.png`).toString('base64'), b = fs.readFileSync(`${SHOTS}/campaign-testnet-390.png`).toString('base64');
    const c = await browser.newContext({ viewport: { width: 860, height: 900 } }); const sp = await c.newPage();
    await sp.setContent(`<body style="margin:0;display:flex;gap:20px;background:#888;align-items:flex-start"><div><p style="margin:4px;font:14px sans-serif;color:#fff">MAINNET</p><img width="390" src="data:image/png;base64,${a}"></div><div><p style="margin:4px;font:14px sans-serif;color:#fff">TESTNET</p><img width="390" src="data:image/png;base64,${b}"></div></body>`);
    await sp.screenshot({ path: `${SHOTS}/mainnet-vs-testnet-side-by-side.png`, fullPage: true }); await c.close();

    // ---------- 3. contribute: the network decides the server; refusal; the recount button; late payer ----------
    seenReq.length = 0;
    p = await open(mainLink('contribute'));
    await p.waitForSelector('#netbar.main', { timeout: 120000 });
    await p.waitForTimeout(6000);
    const mReq = seenReq.filter((u) => /zec\.rocks/.test(u));
    check('contribute, mainnet link with no server: asks the mainnet chain server and never the testnet one', mReq.length > 0 && mReq.every((u) => /\/mainnet/.test(u)) && !seenReq.some((u) => /testnet/.test(u)), JSON.stringify([...new Set(mReq.map((u) => u.slice(0, 50)))]));
    check('contribute: a visible "Recount this campaign" button points at this campaign (also for an auction)', await p.isVisible('#recount-btn') && (await p.getAttribute('#recount-btn', 'href')).includes(`recount.html#c=${mainItem.id}`), await p.getAttribute('#recount-btn', 'href'));
    check('mainnet contribute page: no "demo", "play money" or "start page" wording', !/\bdemo\b|play money|start page/i.test(await p.evaluate(() => document.body.innerText)));
    await p.screenshot({ path: `${SHOTS}/contribute-mainnet-390.png`, fullPage: true });
    crawl.push(...await links(p));
    await p.context().close();

    seenReq.length = 0;
    p = await open(testLink('contribute', `&server=${encodeURIComponent(MOCK)}`));
    await p.waitForSelector('#netbar.test', { timeout: 60000 });
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    check('contribute, testnet: the testnet bar, the form, and the recount button', (await p.isVisible('#recount-btn')) && /^TEST MONEY ONLY/.test(await text(p, '#netbar')));
    await p.screenshot({ path: `${SHOTS}/contribute-testnet-amount-390.png`, fullPage: true });
    const addr = await p.evaluate(async (id) => (await (await fetch(`http://relay.test/v1/campaigns/${id}`)).json()).pay_to, TEST.id);
    await p.fill('#amount', '0.01'); await p.fill('#refund', addr); await p.click('#create'); await p.waitForSelector('#pay-card:not([hidden])');
    await p.waitForTimeout(800);
    await p.screenshot({ path: `${SHOTS}/contribute-testnet-payment-390.png`, fullPage: true });
    // the deadline passes while the code is unpaid: one sentence
    tip = TEST.deadline + 5; await p.reload(); await p.waitForSelector('#pay-card:not([hidden])', { timeout: 60000 }); await p.waitForTimeout(2500);
    const late = await p.evaluate(() => ({ t: document.querySelector('#near-deadline').textContent, vis: !document.querySelector('#near-deadline').hidden }));
    check('late payer (a code made earlier, deadline passed): one sentence that a payment now is not counted or refunded automatically', late.vis && late.t === 'The deadline has passed, so a payment now is not counted or refunded automatically.' && late.t.split(/\s+/).length <= 20, late.t);
    await p.screenshot({ path: `${SHOTS}/contribute-testnet-late-390.png`, fullPage: true });
    await p.context().close();
    tip = TEST.deadline + 5;
    p = await open(testLink('contribute', `&server=${encodeURIComponent(MOCK)}`));
    await p.waitForSelector('#netbar.test', { timeout: 60000 }); await p.waitForTimeout(3000);
    check('late visitor with no code: the form is gone and the page says it takes no more contributions', (await p.isHidden('#form')) && /no longer taking contributions/.test(await text(p, '#banners')));
    await p.context().close();
    tip = TEST.deadline - 100;

    // testnet link with a mainnet server, and a campaign whose network is not known
    p = await open(testLink('contribute', `&server=${encodeURIComponent('https://zjs.zec.rocks/mainnet')}`));
    await p.waitForTimeout(6000);
    check('contribute: a testnet campaign with a mainnet server in the link is refused (no form, no payment code)', (await p.isHidden('#form-card')) && (await p.isHidden('#pay-card')) && /server in this link is for the other network/.test(await text(p, '#banners')), await text(p, '#banners'));
    await p.context().close();
    seenReq.length = 0;
    p = await open(testLink('contribute'), { route: async (pg) => { await pg.route('**/contribute.js', async (rt) => { const r = await rt.fetch(); let b = await r.text(); b = b.split("campaign = JSON.parse(W.campaign_summary(rulesJson, cfg.id));").join("campaign = { ...JSON.parse(W.campaign_summary(rulesJson, cfg.id)), network: 'zzz' };"); await rt.fulfill({ response: r, body: b }); }); } });
    await p.waitForSelector('#netbar.unknown', { timeout: 60000 }); await p.waitForTimeout(3000);
    check('contribute: when the network is unknown the page refuses to continue: no form, no code, no chain server asked, neither testnet nor mainnet', (await p.isHidden('#form-card')) && (await p.isHidden('#pay-card')) && /cannot tell which network/.test(await text(p, '#banners')) && !seenReq.some((u) => /zec\.rocks|chain\.mock/.test(u)), `${await text(p, '#banners')} ${seenReq.filter((u) => /zec\.rocks|mock/.test(u)).length} server requests`);
    await p.screenshot({ path: `${SHOTS}/contribute-network-unknown-390.png`, fullPage: true });
    await p.context().close();

    // ---------- 4. card and badge ----------
    p = await open(testLink('card', `&server=${encodeURIComponent(MOCK)}`));
    await p.waitForSelector('#netbar.test', { timeout: 60000 });
    await p.waitForSelector('#recount-btn:not([hidden])', { timeout: 60000 });
    check('card: banner and a visible "Recount this campaign" button for this campaign', (await p.getAttribute('#recount-btn', 'href')).includes(`recount.html#c=${TEST.id}`) && /^TEST MONEY ONLY/.test(await text(p, '#netbar')));
    await p.screenshot({ path: `${SHOTS}/card-390.png` });
    crawl.push(...await links(p)); await p.context().close();
    p = await open(testLink('badge'), { w: 320, h: 240 });
    await p.waitForTimeout(2500);
    const bd = await p.evaluate(() => ({ t: document.querySelector('.recount-cta').textContent, href: document.querySelector('#badge').href }));
    check('badge: says "Recount this campaign" and links to that recount', /Recount this campaign/.test(bd.t) && bd.href.includes(`recount.html#c=${TEST.id}`), JSON.stringify(bd));
    await p.screenshot({ path: `${SHOTS}/badge.png` }); await p.context().close();

    // ---------- 5. the recount page: upload mode, and the link from a campaign ----------
    p = await open(`${BASE}/recount.html`);
    await p.waitForSelector('#upload-card:not([hidden])', { timeout: 60000 });
    check('recount with no campaign: asks for a saved copy (no "incomplete link"), nothing else to read', (await p.isHidden('#verdict')) && !/Incomplete/.test(await text(p, 'main')) && (await p.isVisible('#upload-file')));
    await p.screenshot({ path: `${SHOTS}/recount-upload-390.png`, fullPage: true });
    await p.setInputFiles('#upload-file', path.join(SITE, 'campaigns.json'));
    await p.waitForSelector('#upload-error:not([hidden])');
    check('upload: a file that is not a saved copy is refused in one plain sentence', /not a saved copy/.test(await text(p, '#upload-error')), await text(p, '#upload-error'));
    await p.setInputFiles('#upload-file', SAVED);
    await p.waitForFunction(() => { const k = document.querySelector('#verdict').dataset.kind; return k && k !== 'working'; }, null, { timeout: 600000 });
    const v = { kind: await p.getAttribute('#verdict', 'data-kind'), pass: String(await p.locator('#rules .rrow.pass').count()), fail: String(await p.locator('#rules .rrow.fail').count()), bar: await text(p, '#netbar') };
    check('upload: a saved copy of a finished testnet campaign is recounted from the file and the chain: all checks pass, the testnet bar shows', v.fail === '0' && Number(v.pass) >= 8 && /^TEST MONEY ONLY/.test(v.bar) && !(await p.isVisible('#saved-clear')), JSON.stringify(v));
    await p.screenshot({ path: `${SHOTS}/recount-upload-result-390.png`, fullPage: true });
    await p.context().close();
    p = await open(testLink('contribute', `&server=${encodeURIComponent(MOCK)}`));
    await p.waitForSelector('#recount-btn:not([hidden])');
    await p.click('#recount-btn');
    await p.waitForSelector('#netbar.test', { timeout: 60000 });
    check('the contribute page\'s button opens the recount already pointed at this campaign', (await p.url()).includes(`recount.html#c=${TEST.id}`) && /Campaign|…/.test(await text(p, '#campaign-id')));
    await p.context().close();

    // ---------- 6. every link found on those pages ----------
    const uniq = [...new Set(crawl.map((u) => u.split('#')[0]))].filter((u) => u.startsWith(BASE));
    const missing = [];
    for (const u of uniq) { const r = await fetch(u); if (!r.ok) missing.push(`${r.status} ${u}`); }
    check(`every link on the pages that stays on this site answers (${uniq.length} checked)`, missing.length === 0, missing.join(' | '));
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    srv.kill();
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
