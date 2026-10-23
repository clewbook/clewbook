// The 25 second blocks after NU7, on the pages, in a real browser and without any chain or host: the NU7 table of nu7.js is the Rust one;
// block times are measured only from blocks after NU7 once it has come; the set-up page's default ticket window is 90 blocks on a network
// past NU7, 30 with the quick test timing or on a private test chain, and a number the host typed is never changed; the bid page's coin
// warning uses the tripled number only for an auction made after NU7. Serves app/web/www on 127.0.0.1 itself, with a stand in for the host
// program's /api/config; every chain server is refused, so the pages run without a chain height.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const fs = require('fs'), path = require('path'), http = require('http');
const WWW = path.join(__dirname, 'www'), ROOT = path.join(__dirname, '..');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  ' + extra : ''}`); if (!ok) failed++; };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

let config = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(config)); return; }
  if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"campaigns":[]}'); return; }
  const f = path.join(WWW, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const open = async (p) => {
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(`${BASE}/${p}`);
    return page;
  };

  // 1. the table is the Rust one
  const rust = fs.readFileSync(path.join(ROOT, 'core/src/sealed.rs'), 'utf8') + fs.readFileSync(path.join(ROOT, 'core/src/rules.rs'), 'utf8');
  const num = (name) => Number((rust.match(new RegExp(`pub const ${name}: u32 = ([0-9_]+);`)) || [])[1].replace(/_/g, ''));
  let page = await open('index.html');
  const t = await page.evaluate(async () => {
    const m = await import('/nu7.js');
    return {
      table: m.NU7_HEIGHT,
      after: [m.afterNu7('main', 3543404), m.afterNu7('main', 3543405), m.afterNu7('test', 4600000), m.afterNu7('regtest', 9e9)],
      first: [m.firstMeasured('main', 3543300, 100), m.firstMeasured('main', 3543450, 100), m.firstMeasured('main', 3543600, 100), m.firstMeasured('test', 4600000, 200), m.firstMeasured('regtest', 50, 100)],
    };
  });
  check('the NU7 heights of the pages are the Rust ones (main, test)', t.table.main === num('NU7_MAIN_HEIGHT') && t.table.test === num('NU7_TEST_HEIGHT'), JSON.stringify(t.table));
  check('a campaign made from the NU7 block on is "after NU7"; a private test chain never', JSON.stringify(t.after) === '[false,true,true,false]', JSON.stringify(t.after));
  check('block times are measured from the last blocks, but never across NU7 once it has come', JSON.stringify(t.first) === JSON.stringify([3543200, 3543405, 3543500, 4599800, 1]), JSON.stringify(t.first));
  await page.close();

  // 2. the set-up page's default ticket window
  const base = { ok: true, ticker: 'TAZ', min_floor_zat: 20000, relays: [], sealed: true, sealed_quick_timing: true, hard_cap: true };
  const k = async (network, act) => {
    config = { ...base, network, ticker: network === 'main' ? 'ZEC' : 'TAZ' };
    const p = await open('setup.html');
    await p.waitForFunction(() => /Test network|Main network/.test(document.querySelector('#net-note').textContent), null, { timeout: 20000 });
    await p.waitForTimeout(1500); // the block measurement fails at once (every chain server is refused)
    if (act) await act(p);
    const v = await p.inputValue('#ticketk');
    await p.close();
    return v;
  };
  check('test network (past NU7 since block 4,465,026): the default ticket window is 90 blocks', (await k('test')) === '90');
  check('test network, blind bid auction with the quick test timing: 30 blocks', (await k('test', async (p) => { await p.check('input[name=mode][value=sealed_auction]'); await p.check('input[name=stiming][value=quick]'); })) === '30');
  check('test network, back to the standard timing: 90 again', (await k('test', async (p) => { await p.check('input[name=mode][value=sealed_auction]'); await p.check('input[name=stiming][value=quick]'); await p.check('input[name=stiming][value=standard]'); })) === '90');
  check('a number the host typed is kept, whatever the timing', (await k('test', async (p) => { await p.fill('#ticketk', '45'); await p.check('input[name=mode][value=sealed_auction]'); await p.check('input[name=stiming][value=quick]'); })) === '45');
  check('a private test chain: 30 blocks', (await k('regtest')) === '30');
  check('main network with no chain height read: 30 blocks', (await k('main')) === '30');

  // 3. the bid page's coin warning: tripled only for a standard auction made after NU7 (the logic is in bid.js; the auction pages need a chain)
  const bid = fs.readFileSync(path.join(WWW, 'bid.js'), 'utf8');
  check('the bid page warns COIN_WARN_BLOCKS (15, as ll_core::sealed) times the scale before the coin cutoff', /const COIN_WARN_BLOCKS = 15;/.test(bid) && num('COIN_WARN_BLOCKS') === 15 && /tip >= cutoff - COIN_WARN_BLOCKS \* coinScale\(\)/.test(bid) && !/cutoff - 15\)/.test(bid));
  check('the scale is 3 only for the standard timing and an auction made after NU7', /coinScale = \(\) => \(\(rules\.sealed\.timing \|\| 'standard'\) === 'standard' && afterNu7\(rules\.network, rules\.start_height\) \? 3 : 1\)/.test(bid));

  // 4. the host program's dashboard serves a fixed list of files (app/host/src/dashboard.rs, static_file): every module its two pages load,
  // and what those import, must be on it, or the page with the Close button does not load
  const rs = fs.readFileSync(path.join(ROOT, 'host/src/dashboard.rs'), 'utf8');
  const served = new Set((rs.match(/"\/(dashboard|setup|ui|brand|blocktime|loadguard)\.js"/g) || []).map((x) => x.slice(2, -1)));
  const seen = new Set(), todo = ['dashboard.js', 'setup.js'];
  while (todo.length) { const f = todo.pop(); if (seen.has(f)) continue; seen.add(f); for (const m of fs.readFileSync(path.join(WWW, f), 'utf8').matchAll(/from '\.\/([a-z0-9-]+\.js)'/g)) todo.push(m[1]); }
  const missing = [...seen].filter((f) => !served.has(f));
  check('every module the host dashboard and set up pages load is on the host program\'s list of files it serves', served.size >= 5 && missing.length === 0, `loads ${[...seen].join(', ')}; not served: ${missing.join(', ') || 'none'}`);
  // 5. the set up page's blind bid choice says it works on mainnet, with the NU7 note
  config = { ...base, network: 'main', ticker: 'ZEC' };
  const sp = await open('setup.html');
  const sealedText = ((await sp.textContent('#sealed-choice small')) || '').trim();
  check('the set up page\'s blind bid choice says it works on mainnet, with the NU7 note, in one line', /Works on mainnet too; there it must end before NU7 for now\.$/.test(sealedText) && !/Test network only for now/.test(sealedText), sealedText.slice(-80));
  await sp.close();
  check('no page error', errors.length === 0, errors.join(' | '));
  await browser.close();
  server.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
