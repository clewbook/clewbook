// Recounts a campaign from a saved copy (the host's export) in a real browser, on the public test-network servers, and prints the verdict, every check
// and the totals. For scripts that need the browser recount's answer (the command-line recount cannot see a uniform auction's treasury).
// Usage: node app/web/recount-file.cjs <export.json> [static folder, default runs/static-polish]     Exit status 0 when no check fails.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const file = process.argv[2], dir = process.argv[3] || 'runs/static-polish', PORT = process.env.PORT || '8810';
const id = JSON.parse(fs.readFileSync(file, 'utf8')).campaign;
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', dir], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
  await p.goto(`http://127.0.0.1:${PORT}/recount.html#c=${id}&relay=http://127.0.0.1:9`);
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 120000 });
  await p.setInputFiles('#saved-file', file);
  await p.waitForFunction(() => /saved copy/i.test(document.querySelector('#verdict-title').textContent), null, { timeout: 900000 });
  await p.waitForTimeout(1500);
  const t = async (s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
  const rows = await p.evaluate(() => [...document.querySelectorAll('#rules .chk')].map((c) => `${c.classList.contains('pass') ? 'PASS' : 'FAIL'} ${c.querySelector('.cid').firstChild.textContent} ${c.querySelector('.name, .nm, h3, b') ? c.querySelector('.name, .nm, h3, b').textContent.trim() : ''}`));
  const fails = await p.evaluate(() => [...document.querySelectorAll('#rules .chk.fail')].map((c) => c.textContent.replace(/\s+/g, ' ').trim().slice(0, 300)));
  console.log(`   browser recount from the saved copy: ${await p.getAttribute('#verdict', 'data-kind')} | ${await t('#verdict-title')} | pass ${await t('#n-pass')} fail ${await t('#n-fail')}`);
  for (const r of rows) console.log('     ' + r);
  for (const f of fails) console.log('     FAIL DETAIL: ' + f);
  console.log('     totals: ' + (await t('#totals')).slice(0, 400));
  const nFail = Number(await t('#n-fail')); // read before the browser is closed
  srv.kill(); await b.close();
  process.exit(nFail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e.message); process.exit(2); });
