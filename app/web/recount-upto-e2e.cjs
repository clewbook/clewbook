// The recount page with upto=<block> (a finished example checked at a fixed block), on the test network: the two demo examples the README
// links, read from the demo's relays on clewbook.xyz and from public test network servers, with the pages served from this folder. Each must
// finish in under a minute, give the result it gives up to today (the passing fundraiser: all 9 checks pass; the cheating host: R5 and R6
// fail), say which block it read up to, and offer the check up to today. No money. Env: PORT (default 8977).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.PORT || '8977', BASE = `http://127.0.0.1:${PORT}`;
const RELAYS = 'relay=https://clewbook.xyz/demo/relays/a&relay=https://clewbook.xyz/demo/relays/b';
const CASES = [
  { name: 'the passing fundraiser', id: '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f', upto: 4477500, verdict: /All checks pass/, fails: [] },
  { name: 'the cheating host', id: '3c34b9ff18656a9fad2e81ea91e803320917eced570ba5f69dde1a10dbba4004', upto: 4498800, verdict: /Some checks FAIL/, fails: ['R5', 'R6'] },
];
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  ' + extra : ''}`); if (!ok) failed++; };

(async () => {
  const srv = spawn('python3', [path.join(__dirname, 'serve.py'), PORT], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await chromium.launch();
  try {
    for (const c of CASES) {
      const p = await browser.newPage();
      const errors = []; p.on('pageerror', (e) => errors.push(String(e)));
      const t0 = Date.now();
      await p.goto(`${BASE}/recount.html#c=${c.id}&${RELAYS}&upto=${c.upto}`);
      let line = '';
      const done = await p.waitForFunction(() => /pass|FAIL|conclude/i.test(document.querySelector('.verdict')?.textContent || '') && !/Working/.test(document.querySelector('.verdict')?.textContent || ''), null, { timeout: 90000, polling: 500 })
        .then(() => true).catch(() => false);
      const secs = Math.round((Date.now() - t0) / 1000);
      check(`${c.name}: finishes in under a minute`, done && secs < 60, `${secs} s`);
      if (!done) { await p.close(); continue; }
      const r = await p.evaluate(() => ({
        verdict: document.querySelector('.verdict').textContent,
        fails: [...document.querySelectorAll('#rules .rrow')].filter((x) => x.dataset.st === 'fail').map((x) => x.querySelector('.rr-id').textContent),
        height: document.querySelector('#rf-height').textContent,
        note: [...document.querySelectorAll('#banners > *')].map((x) => x.textContent).find((t) => /Checked up to block/.test(t)) || '',
        full: [...document.querySelectorAll('#banners a')].map((a) => a.getAttribute('href')).find((h) => /^#c=/.test(h)) || '',
        progress: document.querySelector('#progress').textContent,
      }));
      line = r.progress;
      check(`${c.name}: the same result as up to today`, c.verdict.test(r.verdict) && JSON.stringify(r.fails) === JSON.stringify(c.fails), `${r.fails.join(',') || 'no failures'}`);
      check(`${c.name}: it read the chain up to the block the link names`, r.height === c.upto.toLocaleString('en-US') && new RegExp(`^Read the chain from block [\\d,]+ to ${c.upto.toLocaleString('en-US')}\\.$`).test(line), `${r.height} | ${line}`);
      check(`${c.name}: a note says so, with the check up to today`, r.note.startsWith(`Checked up to block ${c.upto.toLocaleString('en-US')}, as this link asks. Later blocks were not read.`) && !/upto=/.test(r.full) && r.full.includes(c.id), r.full.slice(0, 40));
      check(`${c.name}: no page error`, errors.length === 0, errors.join(' | '));
      await p.close();
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
