// Reject case: a campaign whose host (no watcher running) wrongly rejects a genuine contribution.
// The page must notice the reject and OFFER the proof as a button (nothing is published by itself); the recount over both relays must then FAIL
// with evidence. Env: LINK, RUN (campaign run dir), REFUND_ADDR, PAYER, SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { LINK, RUN, REFUND_ADDR, PAYER } = process.env, SHOTS = process.env.SHOTS || 'runs/page/shots';
const ZD = './target/release/zcash-devtool', BIN = './app/target/release';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const ID = LINK.match(/c=([0-9a-f]{64})/)[1];
const relays = ['http://127.0.0.1:8787', 'http://127.0.0.1:8788'];

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  await page.goto(LINK);
  await page.waitForSelector('#form-card:not([hidden])', { timeout: 30000 });
  await page.fill('#amount', '0.01'); await page.fill('#refund', REFUND_ADDR);
  await page.click('#create');
  await page.waitForSelector('#pay-card:not([hidden])');
  if (await page.isVisible('#to-pay')) await page.click('#to-pay'); // design round 2: Continue to pay after the Backup step
  await page.click('#manual summary');
  const memo = (await page.textContent('#memo')).trim(), payTo = (await page.textContent('#pay-to')).trim();
  let txid = '';
  for (let i = 0; i < 12 && !txid; i++) {
    spawnSync(ZD, ['wallet', '-w', PAYER, 'sync'], { stdio: 'ignore' });
    const out = spawnSync(ZD, ['wallet', '-w', PAYER, 'send', '-i', PAYER + '.age', '--address', payTo, '--value', '1000000', '--memo', memo, '--min-confirmations', '1'], { input: 'y\n', encoding: 'utf8' });
    txid = (out.stdout.match(/^[0-9a-f]{64}$/m) || [''])[0];
    if (!txid) await new Promise((r) => setTimeout(r, 15000));
  }
  check('genuine payment sent', txid.length === 64, txid);

  await page.waitForFunction(() => /seen/.test(document.querySelector('#s-seen .state').textContent), null, { timeout: 300000 });
  check('the page found its own payment on the network', true);
  const state = await page.evaluate((id) => JSON.parse(localStorage.getItem(`ll:${id}`)), ID);
  const [t, a] = state.txid.split(':');
  console.log(`   page found payment ${t}:${a}`);

  // The (cheating) host wrongly rejects it.
  let fr = { stdout: '' };
  for (let i = 0; i < 20 && !/WRONGFUL reject written/.test(fr.stdout); i++) { fr = spawnSync(process.env.CHEAT_HOST || './app/target-cheat/release/ll-host', ['force-reject', '--run', RUN, '--contribution', state.txid], { encoding: 'utf8' }); if (!/WRONGFUL reject written/.test(fr.stdout)) await new Promise((r) => setTimeout(r, 15000)); } // the host's own wallet may still be catching up
  check('host wrote a wrongful reject and published it', /WRONGFUL reject written/.test(fr.stdout), fr.stdout.trim().split('\n').pop());

  await page.waitForSelector('#proof:not([hidden])', { timeout: 120000 });
  await page.waitForSelector('#challenge-btn:not([hidden])', { timeout: 60000 });
  await page.waitForTimeout(12000); // long enough for several page refreshes: nothing may be published by itself
  for (const r of relays) check(`nothing was published by itself to ${r}`, (await (await fetch(`${r}/v1/campaigns/${ID}/challenges`)).json()).length === 0);
  const warn = (await page.textContent('#challenge-text')).replace(/\s+/g, ' ');
  check('before the press it says what gets revealed and that it cannot be undone', /refund address for this one payment/.test(warn) && /can't be undone/.test(warn), warn.slice(0, 200));
  await page.click('#challenge-btn');
  await page.waitForFunction(() => /published proof that your payment was valid, to all the servers/.test(document.querySelector('#proof').textContent), null, { timeout: 120000 });
  const proof = (await page.textContent('#proof')).replace(/\s+/g, ' ').trim();
  check('after the press the proof is published to every relay', true, proof);
  await page.screenshot({ path: `${SHOTS}/10-proof.png`, fullPage: true });
  check('the page says the campaign did not accept the message', /did not accept the message/.test(await page.textContent('#progress-note')));
  for (const r of relays) {
    const list = await (await fetch(`${r}/v1/campaigns/${ID}/challenges`)).json();
    check(`relay ${r} holds the challenge`, list.length === 1 && list[0].txid === t, JSON.stringify(list[0]).slice(0, 90));
  }

  // The recount, reading both relays, now fails with evidence.
  const ufvk = JSON.parse(fs.readFileSync(`${RUN}/rules.json`)).campaign_ufvk, start = JSON.parse(fs.readFileSync(`${RUN}/rules.json`)).start_height;
  spawnSync(ZD, ['wallet', '-w', `${RUN}/viewer`, 'init-fvk', '--name', 'viewer', '--fvk', ufvk, '--birthday', String(start - 2)], { stdio: 'ignore' });
  spawnSync(ZD, ['wallet', '-w', `${RUN}/viewer`, 'sync'], { stdio: 'ignore' });
  spawnSync(ZD, ['wallet', '-w', `${RUN}/viewer`, 'enhance'], { stdio: 'ignore' });
  const rc = spawnSync(`${BIN}/ll-recount`, ['--rules-id', ID, '--relay', relays[0], '--relay', relays[1], '--wallet', `${RUN}/viewer`], { encoding: 'utf8' });
  console.log(rc.stdout.split('\n').filter((l) => /ledger read|R8|opens a valid|RESULT|WARNING/.test(l)).map((l) => '   ' + l).join('\n'));
  check('recount over both relays FAILS on R8 with the evidence', rc.status === 1 && /R8 FAIL/.test(rc.stdout) && /published secret opens a valid payload/.test(rc.stdout));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
