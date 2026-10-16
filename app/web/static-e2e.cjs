// The five example campaigns recounted from a folder of plain files: no relay program and no page server program, only Python's plain
// file server on a spare port (a stand-in for any static host) and the public testnet chain servers. Build the folder with app/web/make-static.sh
// (default runs/static-demo). Env: DIR (folder), PORT (default 8801), SHOTS.
// BASE_URL=https://the-deployed-address runs the same checks against a copy that is already deployed: no local server is started, and the checks
// of the served files (the modules load as application/wasm, the security headers) are made over the network.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const DIR = process.env.DIR || 'runs/static-demo', PORT = process.env.PORT || '8801', SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const REMOTE = (process.env.BASE_URL || '').replace(/\/+$/, '');
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
const CASES = [
  ['uniform-price auction', '5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb', 'pass', 13, 0],
  ['fundraiser, closed and refunded', '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f', 'pass', 9, 0],
  ['fundraiser, 40 contributions', '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da', 'pass', 9, 0],
  ['fundraiser with a name chosen by its host', 'f6737fbc462e75508d424f0612a1ce5ea3df24c5cc1b550074821ccdea5e237a', 'pass', 9, 0],
  ['failing fixture (late settlement)', '32ea71afc470d77909a1b7b4a1fdaba36f0612df3a973df0ce1410c5ca16467a', 'fail', 12, 1, 'R9'],
  ['hard cap: one payment did not fit and was refunded by its ticket', '0e87fe135cb3dd2486efa0809534718bf62ebd3df733d903008550c4c202aef5', 'pass', 9, 0],
  ['caught: a host kept a payment over the hard cap', 'bc66ccca21ec5a3059e03326ec7abbf54fa55c45102a6037cf27f600273addb1', 'fail', 8, 1, 'R6'],
];
(async () => {
  const srv = REMOTE ? { kill() {} } : spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  if (!REMOTE) await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [], other = [];
  const open = async (url, w = 1000, h = 900) => {
    const p = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    // also what the page's security policy refuses; a file a plain host does not have (an optional record next to the list) is an ordinary 404, not an error
    p.on('console', (m) => { if (m.type() === 'error' && !/\/(final|heartbeat|challenges)$/.test(m.location().url || '')) errors.push(m.text()); });
    p.on('request', (r) => { const u = new URL(r.url()); if (!(u.origin === new URL(BASE).origin) && !/zec\.rocks|chainsafe\.dev/.test(u.host)) other.push(r.url()); });
    await p.goto(url);
    return p;
  };
  try {
    if (REMOTE) {
      for (const m of ['/pkg/ll_web_bg.wasm', '/proof/ll_proofcheck_bg.wasm']) {
        const r = await fetch(`${BASE}${m}`); const body = await r.arrayBuffer();
        check(`${m} loads (HTTP ${r.status}, ${Math.round(body.byteLength / 1024)} KiB) as application/wasm`, r.status === 200 && /^application\/wasm/.test(r.headers.get('content-type') || '') && body.byteLength > 1000000 && new Uint8Array(body).slice(0, 4).join() === '0,97,115,109', r.headers.get('content-type'));
      }
      const hd = (await fetch(`${BASE}/index.html`)).headers;
      check('the deployed pages carry the security headers (nosniff, no-referrer, a content security policy) and set no cookie', hd.get('x-content-type-options') === 'nosniff' && hd.get('referrer-policy') === 'no-referrer' && /default-src 'self'/.test(hd.get('content-security-policy') || '') && !hd.get('set-cookie'), JSON.stringify([...hd.keys()].filter((k) => /policy|options|cookie|vercel/.test(k))));
    } else check('the folder holds no relay program or page server program, only files', require('fs').readdirSync(DIR).every((f) => !/^ll-|\.py$|\.sh$/.test(f)));
    for (const [name, id, kind, pass, fail, fails = ''] of CASES) {
      // a public chain server that does not answer in time makes the result "limited" (only one server); that says nothing about the files, so try again (at most 3 times)
      let p, got, failing;
      for (let attempt = 1; attempt <= 3; attempt++) {
        p = await open(`${BASE}/recount.html#c=${id}&relay=${BASE}/relays/a&relay=${BASE}/relays/b`);
        await p.waitForFunction(() => (k => k && k !== 'working')(document.querySelector('#verdict').dataset.kind), null, { timeout: 600000 });
        got = { kind: await p.getAttribute('#verdict', 'data-kind'), pass: Number(await p.textContent('#n-pass')), fail: Number(await p.textContent('#n-fail')), attempt };
        failing = await p.evaluate(() => [...document.querySelectorAll('#rules .chk.fail .cid')].map((e) => e.firstChild.textContent));
        const oneServer = /Only one public server/.test(await p.textContent('#banners'));
        if (!(oneServer && got.kind !== kind) || attempt === 3) break;
        await p.close();
      }
      check(`${name}: the recount from plain files gives ${kind} (${pass} pass, ${fail} fail${fail ? `, ${fails}` : ''})`, got.kind === kind && got.pass === pass && got.fail === fail && (!fail || failing.join() === fails), JSON.stringify(got) + ' ' + failing.join());
      // the recount page says when the list ended: the deadline block always, and the close block when the campaign was closed
      const rules = await (await fetch(`${BASE}/relays/a/v1/campaigns/${id}`)).json();
      const led = await (await fetch(`${BASE}/relays/a/v1/campaigns/${id}/ledger?from=0`)).json();
      const closeE = led.find((e) => e.kind === 'close');
      const nfm = (n) => Number(n).toLocaleString('en-US');
      await p.click('#tab-totals'); // design round 2: the totals (deadline and close blocks) and the sources are on the TOTALS tab
      check(`${name}: the page shows the deadline block (${nfm(rules.deadline_height)})`, (await p.textContent('#tl-deadline')).trim() === `block ${nfm(rules.deadline_height)}`);
      if (closeE) {
        const t = ((await p.textContent('#tl-closed')) || '').replace(/\s+/g, ' ');
        check(`${name}: "Closed at block ${nfm(closeE.close.close_height)}" is shown, with how long after the deadline and no outcome words (the Goal row says it)`, await p.isVisible('#tl-closed') && (await p.textContent('#tl-closed-t')).trim() === 'Closed at' && t.startsWith(`block ${nfm(closeE.close.close_height)} (`) && /after the deadline\)/.test(t) && !t.includes('outcome'), t);
      } else check(`${name}: not closed, so no "Closed at" line`, await p.isHidden('#tl-closed') && await p.isHidden('#tl-closed-t'));
      if (kind === 'pass') check(`${name}: the report hash is shown (the page can hash on a plain static host)`, /^[0-9a-f]{64}$/.test(await p.locator('#rf-hash').getAttribute('data-h')));
      await p.close();
    }
    // one relay only: limited, as with a real relay
    const one = await open(`${BASE}/recount.html#c=${CASES[0][1]}&relay=${BASE}/relays/a`);
    await one.waitForFunction(() => (k => k && k !== 'working')(document.querySelector('#verdict').dataset.kind), null, { timeout: 600000 });
    check('one "relay" file set only: the result is marked limited, not a full pass', (await one.getAttribute('#verdict', 'data-kind')) === 'partial');
    await one.close();
    // the other read-only pages from the same folder
    const id = CASES[0][1], q = `c=${id}&relay=${BASE}/relays/a&relay=${BASE}/relays/b`;
    const card = await open(`${BASE}/card.html#${q}`);
    await card.waitForSelector('#card:not([hidden])', { timeout: 90000 });
    check('the capability card draws from the files (R1 to R12 with R4b for the auction)', (await card.locator('#checks .chk').count()) === 13);
    await card.screenshot({ path: `${SHOTS}/static-card-1000.png`, fullPage: true }); await card.close();
    const camp = await open(`${BASE}/campaign.html#${q}`);
    await camp.waitForSelector('#links:not([hidden])', { timeout: 90000 });
    check('the campaign page lists the ledger entries from the files: 6 rows, the newest 5 shown and "Show older (1)"', (await camp.locator('#entries tr').count()) === 6 && (await camp.locator('#entries tr:not([hidden])').count()) === 5 && (await camp.textContent('#entries-more')).trim() === 'Show older (1)');
    await camp.close();
    const idx = await open(`${BASE}/proofs/`);
    check('the proofs page builds its links from wherever it is served', (await idx.locator('#list a').count()) === 39 && /relays\/a/.test(await idx.locator('#list a').first().getAttribute('href')));
    await idx.close();
    check('nothing was requested from a relay program, a page server program or any other site (only the folder and the public chain servers)', other.length === 0, other.slice(0, 3).join(' '));
    check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  } finally { srv.kill(); await browser.close(); }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
