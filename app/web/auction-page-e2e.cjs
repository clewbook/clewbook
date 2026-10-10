// Drives the contribute page's uniform-auction card in a real headless browser: a winner with an excess, the
// marginal winner (no excess), a loser, and the two buttons (publish my viewing key; report non-delivery).
// Env: LINK_A (winner A's contribute link), BACKUP_A, BACKUP_B, BACKUP_C (backup files), UIVK_A, LINK_A2/BACKUP_A2 (second campaign for the complaint)
const { chromium } = require('./../vectors/js/node_modules/playwright');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const txt = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  async function open(link, backup) {
    const p = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await p.goto(link);
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    check('the dedicated-account note is switched on for a uniform auction', await p.evaluate(() => !document.getElementById('auction-account-note').hidden && /account you would be happy to show/.test(document.getElementById('auction-account-note').textContent)));
    check('after the deadline the page still offers the backup restore (no new contributions)', await p.isVisible('#restore') || (await p.locator('#form-card details').count()) > 0);
    await p.setInputFiles('#restore', backup);
    await p.waitForSelector('#auction-card:not([hidden])', { timeout: 120000 });
    return p;
  }
  // winner with an excess
  let p = await open(process.env.LINK_A, process.env.BACKUP_A);
  check('winner sees "you won" and the exact price and excess', /you won/i.test(await txt(p, '#auction-title')) && /paid 0\.00190000/.test(await txt(p, '#auction-text')) && /0\.00100000 TAZ should have been paid back/.test(await txt(p, '#auction-text')), await txt(p, '#auction-text'));
  check('winner sees the settlement deadline in the facts', /settle winners within \d+ blocks/.test(await txt(p, '#about-facts')), (await txt(p, '#about-facts')).slice(0, 200));
  check('proof section (with the dedicated-account warning) is shown to a winner with an excess', await p.isVisible('#auction-proof') && /dedicated account/i.test(await txt(p, '#auction-proof')));
  await p.screenshot({ path: `${process.env.SHOTS || 'runs/page/shots'}/40-auction-winner.png`, fullPage: true });
  await p.click('#proof-publish');
  check('publishing with no key is refused plainly', /paste the viewing key/i.test(await txt(p, '#proof-status')), await txt(p, '#proof-status'));
  await p.fill('#proof-key', process.env.UIVK_A);
  await p.click('#proof-publish');
  await p.waitForFunction(() => /Published to all the servers/.test(document.querySelector('#proof-status').textContent), null, { timeout: 30000 }).catch(() => {});
  check('publishing the real viewing key succeeds on every relay', /Published to all the servers/.test(await txt(p, '#proof-status')), await txt(p, '#proof-status'));
  // marginal winner: nothing paid back
  p = await open(process.env.LINK_A, process.env.BACKUP_B);
  check('marginal winner is told nothing is paid back, and no proof form is offered', /lowest winning bid, so nothing is paid back/.test(await txt(p, '#auction-text')) && !(await p.isVisible('#auction-proof')), await txt(p, '#auction-text'));
  // loser
  p = await open(process.env.LINK_A, process.env.BACKUP_C);
  check('loser is told they did not win and how the refund works', /did not win/i.test(await txt(p, '#auction-title')) && /refunded/.test(await txt(p, '#auction-text')));
  // complaint button on a second campaign
  p = await open(process.env.LINK_A2, process.env.BACKUP_A2);
  await p.click('#proof-complain');
  await p.waitForFunction(() => /published to all the servers/i.test(document.querySelector('#proof-status').textContent), null, { timeout: 30000 }).catch(() => {});
  check('the complaint button publishes an unverified report to every relay', /report was published to all the servers.*unverified/i.test(await txt(p, '#proof-status')), await txt(p, '#proof-status'));
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
