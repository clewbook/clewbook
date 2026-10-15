// Second browser test: restoring from a backup file, and what the page says when the public lists
// are unreachable or disagree. Uses the campaign and backup from contribute-e2e.cjs.
// Env: LINK, BACKUP (path), RUN (campaign run dir), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const LINK = process.env.LINK, BACKUP = process.env.BACKUP, RUN = process.env.RUN, SHOTS = process.env.SHOTS || 'runs/page/shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sh = (c) => spawnSync('bash', ['-c', c], { encoding: 'utf8' });
const pidOn = (port) => (sh(`ss -ltnp | grep ':${port} ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`).stdout || '').trim();
const stopRelay = (port) => { const p = pidOn(port); if (p) sh(`kill ${p}`); return sh('sleep 1'); };
const startRelay = (dir, port) => { spawn('./app/target/release/ll-relay', ['serve', '--dir', dir, '--listen', `127.0.0.1:${port}`], { detached: true, stdio: 'ignore' }).unref(); return sh('sleep 1'); };
const relayDir = (n) => `runs/page/relay${n}`;
const text = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(LINK);
  await page.waitForSelector('#form-card:not([hidden])', { timeout: 30000 });

  // A. lost the page: restore from the backup file taken before paying
  await page.click('#form-card details summary');
  await page.setInputFiles('#restore', BACKUP);
  await page.waitForSelector('#s-ticket.done', { state: 'attached', timeout: 60000 }); // the status rows show on the Pay step only
  check('restoring the backup finds the ticket again from the public lists', true);
  await page.waitForSelector('#refund-result:not([hidden])', { timeout: 30000 });
  const rr = await text(page, '#refund-result');
  check('a refund that was already sent is not offered again', /was sent/.test(rr) && !(await page.isVisible('#refund-btn')), rr);
  await page.screenshot({ path: `${SHOTS}/07-restored.png`, fullPage: true });

  // B. one list is behind (lost its newest entry): the page says so calmly and never blames anyone
  stopRelay(8788);
  const files = fs.readdirSync(`${relayDir(2)}/campaigns/${fs.readdirSync(relayDir(2) + '/campaigns')[0]}/ledger`);
  const campaignIds = fs.readdirSync(relayDir(2) + '/campaigns');
  for (const id of campaignIds) {
    const l = `${relayDir(2)}/campaigns/${id}/ledger`;
    if (id === LINK.match(/c=([0-9a-f]{64})/)[1]) for (const f of fs.readdirSync(l)) fs.unlinkSync(`${l}/${f}`);
  }
  startRelay(relayDir(2), 8788);
  await page.reload();
  await page.waitForSelector('#banners .notice', { timeout: 30000 });
  await page.waitForFunction(() => /don't show exactly the same/.test(document.querySelector('#banners').textContent), null, { timeout: 30000 });
  const b = await text(page, '#banners');
  check('lists that differ: calm notice, "cannot tell why"', /can't tell why/.test(b) && !/guilty|dishonest|stole|fraud|cheat/i.test(b), b.slice(0, 160));
  check('the ticket still shows as received and checked', await page.evaluate(() => document.querySelector('#s-ticket').classList.contains('done')));
  await page.screenshot({ path: `${SHOTS}/08-disagree.png`, fullPage: true });

  // C. one list down
  stopRelay(8788);
  await page.reload();
  await page.waitForFunction(() => /can't be reached/.test(document.querySelector('#banners').textContent), null, { timeout: 30000 });
  check('one list unreachable: says which one cannot be reached', /127\.0\.0\.1:8788 can't be reached/.test(await text(page, '#banners')));
  check('still shows the saved ticket', await page.evaluate(() => document.querySelector('#s-ticket').classList.contains('done')));

  // D. both lists down
  stopRelay(8787);
  await page.reload();
  await page.waitForFunction(() => /can't reach the campaign's servers/.test(document.querySelector('#banners').textContent), null, { timeout: 30000 });
  const d = await text(page, '#banners');
  check('both unreachable: says the saved ticket still works', /saved on this device and still works/.test(d), d.slice(0, 200));
  check('uses the saved copy of the ticket', await page.evaluate(() => document.querySelector('#s-ticket').classList.contains('done')));
  await page.screenshot({ path: `${SHOTS}/09-down.png`, fullPage: true });

  startRelay(relayDir(1), 8787); startRelay(relayDir(2), 8788);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
