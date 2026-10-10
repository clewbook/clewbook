// The "Publish proof that my payment was valid" button: nothing is published by itself, the warning says what is revealed and that it can't be
// undone, an underpaid payment is told publishing won't change the outcome (secondary button), and the recount outcome is unchanged by publishing
// for an underpaid and a replayed payment, and FAILS (by design) for a wrongful reject of a valid payment.
const { chromium } = require('./../vectors/js/node_modules/playwright');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const txt = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
const E = process.env, relays = ['http://127.0.0.1:8787', 'http://127.0.0.1:8788'];
const mine = async (txid) => (await Promise.all(relays.map(async (r) => (await (await fetch(`${r}/v1/campaigns/${E.CID}/challenges`)).json()).filter((c) => c.txid === txid).length)));
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const fs = require('fs'), { spawnSync } = require('child_process');
  const ZD = './target/release/zcash-devtool', BIN = './app/target/release', RUN = E.RUN;
  const rules = JSON.parse(fs.readFileSync(`${RUN}/rules.json`));
  spawnSync(ZD, ['wallet', '-w', `${RUN}/viewer`, 'init-fvk', '--name', 'viewer', '--fvk', rules.campaign_ufvk, '--birthday', String(rules.start_height - 2)], { stdio: 'ignore' });
  async function recount() {
    spawnSync(ZD, ['wallet', '-w', `${RUN}/viewer`, 'sync'], { stdio: 'ignore' });
    spawnSync(ZD, ['wallet', '-w', `${RUN}/viewer`, 'enhance'], { stdio: 'ignore' });
    const rc = spawnSync(`${BIN}/ll-recount`, ['--rules-id', E.CID, '--relay', relays[0], '--relay', relays[1], '--wallet', `${RUN}/viewer`], { encoding: 'utf8' });
    const kind = rc.status === 0 ? 'pass' : 'fail';
    const rulesText = rc.stdout.split('\n').filter((l) => /^\s*R\d+/.test(l)).join('\n');
    console.log(`   recount: ${kind}; ` + rc.stdout.split('\n').filter((l) => /RESULT|R8/.test(l)).join(' | ').slice(0, 200));
    return { kind, rules: rulesText, full: rc.stdout };
  }
  // O: the owner paid the same message twice; the first payment (300000) is more than the 200000 the message promised.
  // The page holds that ticket, so nothing is offered to prove, and paying more than chosen is a neutral note, not a failure.
  // O2: the same ticket, but the contributor meant to pay MORE (900000) than the list shows (300000): that is a failure.
  for (const [tag, amount] of [['O', null], ['O2', 900000]]) {
    const file = `${E.BACKUP_DIR}/backup-${tag}.json`;
    if (amount) { const b = JSON.parse(fs.readFileSync(`${E.BACKUP_DIR}/backup-O.json`)); b.amountZat = amount; fs.writeFileSync(file, JSON.stringify(b)); }
    const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(E.LINK);
    await page.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    await page.setInputFiles('#restore', file);
    await page.waitForSelector('#progress-card:not([hidden])', { timeout: 120000 });
    await page.waitForFunction(() => /Pass|Fail/.test(document.querySelector('#tc-list').textContent), null, { timeout: 120000 });
    await page.waitForTimeout(3000);
    const amountRow = await txt(page, '#tc-list .chk:has(.cid:text-is("your_amount"))');
    if (tag === 'O') {
      check('O: the owner who paid twice holds a ticket: no proof button, nothing published', await page.isHidden('#challenge-btn') && (await mine(E.TX_R)).every((n) => n === 0), await txt(page, '#s-received'));
      check('O: paying more than chosen is a pass with a plain note, not a failure', /Pass/.test(amountRow) && !/Fail/.test(amountRow) && await page.isHidden('#tc-bad') && await page.isVisible('#over-note') && /whole payment counts as your contribution/.test(await txt(page, '#over-note')), amountRow.slice(0, 200));
    } else {
      check('O2: the list shows less than the contributor meant to pay: your_amount FAILS with a red notice', /Fail/.test(amountRow) && await page.isVisible('#tc-bad') && /did not pass a check/.test(await txt(page, '#tc-bad')) && await page.isHidden('#over-note'), amountRow.slice(0, 200));
    }
    await page.close();
  }
  for (const [name, txid, expectChange] of [['U', E.TX_U, false], ['R', E.TX_R, false], ['W', E.TX_W, true]]) {
    const before = await recount();
    const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(E.LINK);
    await page.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    await page.setInputFiles('#restore', `${E.BACKUP_DIR}/backup-${name}.json`);
    await page.waitForSelector('#challenge-btn:not([hidden])', { timeout: 120000 });
    await page.waitForTimeout(12000); // several page refreshes
    check(`${name}: nothing is published by itself`, (await mine(txid)).every((n) => n === 0), JSON.stringify(await mine(txid)));
    const text = await txt(page, '#challenge-text');
    check(`${name}: before the press it says what is revealed (the refund address, for this one payment) and that it can't be undone`, /refund address for this one payment/.test(text) && /can't be undone/.test(text), text.slice(0, 220));
    const cls = (await page.getAttribute('#challenge-btn', 'class')) || '';
    if (name === 'U') {
      check('U: "This payment looks underpaid. Publishing won\'t change the outcome" comes first and the button is secondary', /^This payment looks underpaid[^.]*\. Publishing won't change the outcome/.test(text) && /secondary/.test(cls), `${cls} | ${text.slice(0, 120)}`);
    } else {
      check(`${name}: no underpaid wording and the button is the primary one`, !/underpaid/.test(text) && !/secondary/.test(cls), `${cls} | ${text.slice(0, 120)}`);
    }
    await page.screenshot({ path: `${E.SHOTS || 'runs/page/shots'}/70-challenge-${name}-before.png`, fullPage: true });
    await page.click('#challenge-btn');
    await page.waitForFunction(() => /published proof that your payment was valid, to all the servers/.test(document.querySelector('#challenge-text').textContent), null, { timeout: 60000 });
    check(`${name}: pressing the button publishes the proof to every relay, once`, (await mine(txid)).every((n) => n === 1), JSON.stringify(await mine(txid)));
    check(`${name}: the button is gone afterwards`, await page.isHidden('#challenge-btn'));
    await page.close();
    const after = await recount();
    if (!expectChange) {
      check(`${name}: the recount outcome is unchanged by publishing (${before.kind} -> ${after.kind}; every rule the same)`, after.kind === before.kind && after.kind === 'pass' && after.rules === before.rules, `${before.kind} -> ${after.kind}`);
    } else {
      check(`${name}: the recount was PASS before (the reject stood) and FAILS on R8 after the proof is published, with the evidence`, before.kind === 'pass' && after.kind === 'fail' && /R8 FAIL/.test(after.rules) && /published secret opens a valid payload/.test(after.full), `${before.kind} -> ${after.kind}`);
    }
  }
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
