// Drives the host dashboard like a campaign host, against real testnet. Env: PAYER (bidder wallet dir),
// REFUND_ADDR, TREASURY (address that receives the kept money), SHOTS.
const { chromium } = require('../vectors/js/node_modules/playwright');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { PAYER, REFUND_ADDR, TREASURY } = process.env, SHOTS = process.env.SHOTS || 'runs/page/shots';
const ZD = './target/release/zcash-devtool', BIN = './app/target/release', BASE = `http://127.0.0.1:${process.env.DASH_PORT || 8780}`;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sh = (cmd) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
const val = (p, sel, label) => p.evaluate(([sel, label]) => { const dts = [...document.querySelectorAll(`${sel} dt`)]; const dt = dts.find((d) => d.textContent.trim() === label); return dt ? dt.nextElementSibling.textContent.trim() : null; }, [sel, label]);
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForSelector('#no-campaigns:not([hidden])', { timeout: 20000 });
  check('empty dashboard says there is no campaign yet', true);

  // ---- setup refusals ----
  await page.click('#new-btn');
  await page.waitForSelector('#setup-form', { timeout: 20000 }); // the set-up form is its own page now
  const submit = async () => { await page.click('#create-btn'); await page.waitForSelector('#setup-error:not([hidden])', { timeout: 8000 }); return text(page, '#setup-error'); };
  await page.fill('#goal', ''); let e = await submit();
  check('refuses a missing goal', /goal/i.test(e), e);
  await page.fill('#goal', '0.05'); await page.fill('#minimum', '0.00005'); e = await submit();
  check('refuses a smallest contribution below twice the fee', /0\.0002|at least/i.test(e), e);
  await page.fill('#minimum', '0.0002'); await page.fill('#deadline', '5'); e = await submit();
  check('refuses a deadline that is too close', /20 blocks/.test(e), e);
  await page.check('input[value=auction]'); await page.fill('#deadline', '500'); await page.fill('#items', ''); e = await submit();
  check('auction needs a number of items', /how many items/i.test(e), e);
  await page.check('input[value=raise]');

  // ---- create a real campaign (deadline soon, so closing can be tested) ----
  await page.fill('#goal', '0.05'); await page.fill('#deadline', '60'); // blocks; testnet blocks are 12-25 s, so a short deadline can pass before the payment is mined
  log('creating a campaign (needs the public test server; can take a minute)');
  await page.click('#create-btn');
  await page.waitForSelector('#live:not([hidden])', { timeout: 300000 });
  await page.screenshot({ path: `${SHOTS}/20-dashboard-new.png`, fullPage: true });
  const facts = await text(page, '#facts');
  check('shows the new campaign (type, goal, deadline, minimum)', /Fundraiser/.test(facts) && /Goal0\.05000000 TAZ/.test(facts) && /Deadline/.test(facts) && /0\.00020000 TAZ/.test(facts), facts.slice(0, 160));
  const sel = await page.inputValue('#campaign-select');
  const st0 = await (await fetch(`${BASE}/api/campaigns/${sel}`)).json();
  check('contributor link is built', st0.contribute_link.includes(`#c=${sel}`) && st0.contribute_link.includes('relay='));
  check('close button is disabled while the campaign is open', await page.isDisabled('#close-btn'));
  const warn0 = await text(page, '#warning-list');
  check('shows the "keep this program running" reminder', /Keep this program and this computer running/.test(warn0));

  // ---- a real contribution ----
  const run = sh(`ls -d ${process.env.DASH_RUNS || 'runs/dash-regress'}/campaign-* | tail -1`).stdout.trim();
  fs.writeFileSync(`${SHOTS}/dash-seed`, '');
  sh(`rm -f ${SHOTS}/dash-seed`);
  const seed = `${run}/c1.seed`;
  sh(`${BIN}/ll-contrib keygen --out ${seed}`);
  const memo = sh(`${BIN}/ll-contrib memo --rules ${run}/rules.json --seed ${seed} --refund-address ${REFUND_ADDR}`).stdout.trim();
  let txid = '';
  for (let i = 0; i < 12 && !txid; i++) {
    spawnSync(ZD, ['wallet', '-w', PAYER, 'sync'], { stdio: 'ignore' });
    const out = spawnSync(ZD, ['wallet', '-w', PAYER, 'send', '-i', PAYER + '.age', '--address', st0.pay_to, '--value', '1000000', '--memo', memo, '--min-confirmations', '1'], { input: 'y\n', encoding: 'utf8' });
    txid = (out.stdout.match(/^[0-9a-f]{64}$/m) || [''])[0];
    if (!txid) await new Promise((r) => setTimeout(r, 15000));
  }
  check('payment sent to the campaign', txid.length === 64, txid);
  await page.waitForFunction(() => { const dt = [...document.querySelectorAll('#counts dt')].find((d) => d.textContent.trim() === 'Refund tickets issued'); return dt && dt.nextElementSibling.textContent.startsWith('1'); }, null, { timeout: 400000 });
  check('live counts: 1 contribution received', (await val(page, '#counts', 'Contributions received')) === '1');
  check('live counts: 1 refund ticket issued', (await val(page, '#counts', 'Refund tickets issued')) === '1');
  check('live counts: 1 of 1 locked in the wallet', (await val(page, '#counts', 'Contributions locked in the wallet')) === '1 of 1');
  check('raised so far shows 0.01 TAZ (8 decimals)', (await val(page, '#facts', 'Raised so far')) === '0.01000000 TAZ');
  const checks = await text(page, '#check-list');
  check('self-check: all rules pass', !/FAILS/.test(checks) && /R1/.test(checks), checks.slice(0, 80));
  check('both relays reported up to date', (await text(page, '#relay-list')).match(/up to date/g)?.length === 2);
  await page.screenshot({ path: `${SHOTS}/21-dashboard-live.png`, fullPage: true });

  // ---- a relay goes down: a clear warning ----
  const pid = sh("ss -ltnp | grep ':8788 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2").stdout.trim();
  if (pid) sh(`kill ${pid}`);
  await page.waitForFunction(() => /8788 is not reachable/.test(document.querySelector('#warning-list').textContent), null, { timeout: 90000 });
  check('a relay that is down produces a plain warning', /safe on this computer/.test(await text(page, '#warning-list')));
  require('child_process').spawn(`${BIN}/ll-relay`, ['serve', '--dir', 'runs/page/relay2', '--listen', '127.0.0.1:8788'], { detached: true, stdio: 'ignore' }).unref(); // detached, so the test never waits on it

  // ---- security ----
  const bad1 = await fetch(`${BASE}/api/campaigns/${sel}/close`, { method: 'POST', body: '{}' });
  check('a request without the dashboard header is refused (403)', bad1.status === 403);
  const bad2 = await fetch(`${BASE}/api/campaigns/${sel}/close`, { method: 'POST', headers: { 'x-dashboard': '1', origin: 'http://evil.example' }, body: '{}' });
  check('a request from another site is refused (403)', bad2.status === 403);

  // ---- wait for the deadline, then close from the page ----
  log(`waiting for the deadline (block ${st0.deadline_height})`);
  await page.waitForFunction(() => !document.querySelector('#close-btn').hidden && !document.querySelector('#close-btn').disabled, null, { timeout: 3300000, polling: 5000 });
  await page.waitForFunction(() => /The deadline has passed/.test(document.querySelector('#warning-list').textContent), null, { timeout: 60000 });
  check('after the deadline the page warns to close and enables the button', true, await text(page, '#warning-list').then((t) => t.slice(t.indexOf('The deadline'), t.indexOf('The deadline') + 110)));
  await page.click('#close-btn');
  await page.click('#close-yes'); // no address yet
  await page.waitForSelector('#close-error:not([hidden])');
  check('closing without an address is refused', /address/i.test(await text(page, '#close-error')));
  await page.fill('#sweep-to', 'not an address'); await page.click('#close-yes'); await page.waitForTimeout(800);
  check('closing with an invalid address is refused', /valid address/i.test(await text(page, '#close-error')));
  await page.screenshot({ path: `${SHOTS}/22-dashboard-close.png`, fullPage: true });
  await page.fill('#sweep-to', TREASURY); await page.click('#close-yes');
  await page.waitForFunction(() => document.querySelector('#close-log li'), null, { timeout: 600000 });
  const closeLog = await text(page, '#close-log');
  check('closing wrote the result and moved the money', /close entry/.test(closeLog) && /(refund broadcast|swept)/.test(closeLog), closeLog.slice(0, 200));
  await page.waitForFunction(() => /Closed/.test(document.querySelector('#facts').textContent), null, { timeout: 60000 });
  check('status shows the campaign as closed (goal missed: refund)', /goal missed/.test(await text(page, '#facts')));
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 160));
  await page.screenshot({ path: `${SHOTS}/23-dashboard-closed.png`, fullPage: true });
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
