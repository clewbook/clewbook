// "Claim my refund" after a close whose refund never reached the network, in a real browser at phone width, on the testnet with real money.
// A fundraiser that misses its goal; the contributor pays from the page and gets a ticket; the host closes, but its refund broadcast is
// dropped (test-only build, LL_TEST_DROP_FIRST_BROADCAST) and the host is not run again. Once the ticket window has passed after the close,
// the page offers to send the refund itself, and it is mined. Env: LINK, CAMPAIGN (folder), WATCHER (pid of its watcher), PAYER, REFUND_ADDR,
// TREASURY, SHOTS. See claim-refund.sh.
const { chromium } = require('../vectors/js/node_modules/playwright');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { LINK, CAMPAIGN, WATCHER, PAYER, REFUND_ADDR, TREASURY } = process.env, SHOTS = process.env.SHOTS || 'runs/design-shots';
const ZD = './target/release/zcash-devtool';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tip = () => { spawnSync(ZD, ['wallet', '-w', PAYER, 'sync'], { stdio: 'ignore' }); const o = spawnSync(ZD, ['wallet', '-w', PAYER, 'get-info'], { encoding: 'utf8' }).stdout; return Number((o.match(/"chain_tip_height":(\d+)/) || [])[1] || 0); };
const rules = JSON.parse(fs.readFileSync(`${CAMPAIGN}/rules.json`, 'utf8'));
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  try {
    await p.goto(LINK);
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    await p.fill('#amount', '0.001'); await p.fill('#refund', REFUND_ADDR); await p.click('#create');
    await p.waitForSelector('#pay-card:not([hidden])', { timeout: 20000 });
    await p.evaluate(() => (document.querySelector('#manual').open = true));
    const memo = await text(p, '#memo'), payTo = await text(p, '#pay-to');
    let txid = '';
    for (let i = 0; i < 12 && !txid; i++) {
      spawnSync(ZD, ['wallet', '-w', PAYER, 'sync'], { stdio: 'ignore' });
      const out = spawnSync(ZD, ['wallet', '-w', PAYER, 'send', '-i', PAYER + '.age', '--address', payTo, '--value', '100000', '--memo', memo, '--min-confirmations', '1'], { input: 'y\n', encoding: 'utf8' });
      txid = (out.stdout.match(/^[0-9a-f]{64}$/m) || [''])[0];
      if (!txid) await sleep(15000);
    }
    check('payment of 0.001 TAZ sent from the page\'s payment code', txid.length === 64, txid);
    await p.waitForSelector('#s-ticket.done', { timeout: 900000 });
    const st = await p.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /^ll:[0-9a-f]{64}$/.test(k)))));
    const ticketTxid = st.ticket.entry.ticket.txid, nf = st.ticket.nf;
    check('the ticket arrived and passed its checks', /passed the checks/.test(await text(p, '#s-ticket')), ticketTxid);

    // the deadline passes; the host closes, but its refund broadcast is dropped, and it is not run again
    log(`waiting for the deadline ${rules.deadline_height}`);
    while (tip() <= rules.deadline_height) await sleep(20000);
    process.kill(Number(WATCHER)); await sleep(4000);
    const close = spawnSync('./app/target-cheat/release/cb-host', ['close', '--run', CAMPAIGN, '--sweep-to', TREASURY], { encoding: 'utf8', env: { ...process.env, LL_TEST_DROP_FIRST_BROADCAST: '1' } });
    fs.writeFileSync(`${SHOTS}/close.log`, close.stdout + close.stderr);
    const closeEntry = fs.readdirSync(`${CAMPAIGN}/ledger`).map((f) => JSON.parse(fs.readFileSync(`${CAMPAIGN}/ledger/${f}`, 'utf8'))).find((e) => e.kind === 'close');
    const ob = JSON.parse(fs.readFileSync(`${CAMPAIGN}/private/outbox.json`, 'utf8'));
    check('the host closed (goal missed) and "sent" the refund, which the flaky server dropped', close.status === 0 && closeEntry && closeEntry.close.outcome === 'goal_missed' && /DROPPED/.test(close.stderr) && ob.some((x) => x.kind === 'refund' && x.txid === ticketTxid), `exit ${close.status}`);
    const closeHeight = closeEntry.close.close_height;
    // relays get the close entry from the host's close; the page must see it
    await p.reload(); await p.waitForSelector('#progress-card:not([hidden])', { timeout: 60000 }); await sleep(20000);
    const early = await text(p, '#refund-result');
    check('right after the close: one line says the refund should come, and a button will appear if it does not', early === 'The campaign has closed; if your refund does not appear, a button to send it yourself shows here.' && (await p.isHidden('#refund-btn')), early);
    await p.screenshot({ path: `${SHOTS}/claim-before.png`, fullPage: true });

    log(`waiting for the ticket window after the close (block ${closeHeight + rules.ticket_k + 1})`);
    while (tip() <= closeHeight + rules.ticket_k) await sleep(30000);
    await sleep(10000);
    let offered = false;
    for (let i = 0; i < 8 && !offered; i++) { await p.reload(); await p.waitForSelector('#progress-card:not([hidden])', { timeout: 60000 }); await sleep(25000); offered = await p.isVisible('#refund-btn'); }
    const explain = await text(p, '#refund-explain');
    check('the refund never appeared: the page offers "Claim my refund", in one sentence', offered && explain === 'The campaign closed but your refund has not appeared, so you can send it yourself.' && (await text(p, '#refund-btn')) === 'Claim my refund', explain);
    await p.screenshot({ path: `${SHOTS}/claim-offered.png`, fullPage: true });
    await p.click('#refund-btn');
    check('it asks for confirmation first', await p.isVisible('#refund-confirm'));
    await p.click('#refund-yes');
    await p.waitForSelector('#refund-result:not([hidden])', { timeout: 60000 });
    check('the refund was sent', /was sent/.test(await text(p, '#refund-result')), await text(p, '#refund-result'));
    let confirmed = false;
    for (let i = 0; i < 40 && !confirmed; i++) { await sleep(30000); await p.reload(); await p.waitForSelector('#progress-card:not([hidden])', { timeout: 60000 }); await sleep(15000); confirmed = /confirmed in block/.test(await text(p, '#refund-result')); }
    check('the refund is confirmed on chain', confirmed, await text(p, '#refund-result'));
    const track = await p.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /^ll:[0-9a-f]{64}$/.test(k)))).refundTrack);
    check('it is the very same pre-signed transaction the host had "sent" (so the two could never both pay out)', track && track.spender === ticketTxid, track && track.spender);
    await p.screenshot({ path: `${SHOTS}/claim-confirmed.png`, fullPage: true });
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
    console.log(`payment ${txid}\nticket ${ticketTxid}\nnf ${nf}`);
  } finally {
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
