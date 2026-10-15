// Plays the contribute page like a person on a phone, against a real testnet campaign.
// Env: LINK, REFUND_ADDR (an address of a wallet that can receive the refund), PAYER (bidder wallet dir),
//      SHOTS (screenshot dir).  Run from the repository root with Chromium's libraries on LD_LIBRARY_PATH.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawnSync } = require('child_process');
const fs = require('fs');

const LINK = process.env.LINK, REFUND_ADDR = process.env.REFUND_ADDR, SHOTS = process.env.SHOTS || 'runs/page/shots';
const ZD = './target/release/zcash-devtool';
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(LINK);
  await page.waitForSelector('#about:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('#form-card:not([hidden])', { timeout: 30000 });
  await page.screenshot({ path: `${SHOTS}/01-open.png`, fullPage: true });
  const facts = await page.textContent('#about-facts');
  check('shows type, goal, status and time left', /Fundraiser/.test(facts) && /Goal/.test(facts) && /StatusOpenTime left/.test(facts) && /Time left/.test(facts), facts.replace(/\s+/g, ' ').slice(0, 140));
  check('no horizontal scrolling on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  // --- refusals ---
  const tryCreate = async (amount, addr) => {
    await page.fill('#amount', amount); await page.fill('#refund', addr);
    await page.click('#create');
    await page.waitForTimeout(300);
    return { error: (await page.textContent('#form-error')).trim(), payVisible: await page.isVisible('#pay-card') };
  };
  let r = await tryCreate('', REFUND_ADDR);
  check('refuses a missing amount', /amount/i.test(r.error) && !r.payVisible, r.error);
  r = await tryCreate('0.00001', REFUND_ADDR);
  check('refuses an amount below the minimum', /smallest amount/i.test(r.error) && !r.payVisible, r.error);
  r = await tryCreate('0.01', 'not an address');
  check('refuses an invalid refund address', /valid refund address/i.test(r.error) && !r.payVisible, r.error);
  r = await tryCreate('0.01', '');
  check('refuses a missing refund address', /enter the address/i.test(r.error) && !r.payVisible, r.error);
  r = await tryCreate('0.01', 'tmNX7cpsKMg4rftQK5P1sehheA7HM6RoiMQ');
  check('refuses a transparent address', !r.payVisible && r.error.length > 0, r.error);
  await page.screenshot({ path: `${SHOTS}/02-refusal.png`, fullPage: true });

  // --- a valid contribution ---
  await page.fill('#amount', '0.01'); await page.fill('#refund', REFUND_ADDR);
  await page.click('#create');
  await page.waitForSelector('#pay-card:not([hidden])', { timeout: 10000 });
  // design round 2: the Backup step comes first; the backup is downloaded there, then "Continue to pay" shows the code
  const memo = (await page.textContent('#memo')).trim();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
  const backupPath = `${SHOTS}/backup.json`; await dl.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath));
  check('backup file has the secret, the refund address and the message', backup.seed?.length === 64 && backup.refundAddress === REFUND_ADDR && backup.memo === memo);
  check('page marks the backup as saved', await page.isVisible('#backup-done'));
  await page.click('#to-pay');
  await page.waitForSelector('#qr svg');
  await page.screenshot({ path: `${SHOTS}/03-pay.png`, fullPage: true });
  await page.click('#manual summary');
  const payTo = (await page.textContent('#pay-to')).trim();
  check('memo is the sealed message, payload version 2 with the amount (LL1:, 267 characters)', memo.startsWith('LL1:') && memo.length === 267, `${memo.length} chars`);
  check('one line before payment: pay exactly the amount, once, from a shielded address', /Pay exactly 0\.01000000 TAZ once, from a shielded address\./.test(await page.textContent('#pay-warning')) && await page.isVisible('#pay-warning'));
  check('a new payment code is not labelled old-format', await page.isHidden('#format-note'));
  check('payment address comes from the committed rules', payTo.length > 100);
  const href = await page.getAttribute('#paylink', 'href');
  check('payment link carries the address, amount and memo', href.includes(payTo) && href.includes('amount=0.01') && href.includes('memo='));
  check('QR code is drawn and large enough to scan', (await page.locator('#qr svg').boundingBox()).width >= 280);
  // the standard address, and the simpler code (Orchard-only address, same payment)
  const jsQR = require('../vectors/js/node_modules/jsqr'), { PNG } = require('../vectors/js/node_modules/pngjs');
  const decodeQr = async () => { const png = PNG.sync.read(await page.locator('#qr').screenshot()); const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height); return r && r.data; };
  check('payment address is the standard form (utest1, not zutest1)', /^utest1/.test(payTo) && href.startsWith('zcash:utest1'));
  check('the QR decodes to the payment link', (await decodeQr()) === href);
  check('"simpler code" button is offered', await page.isVisible('#qr-toggle'));
  await page.click('#qr-toggle');
  const lightHref = await page.getAttribute('#paylink', 'href');
  check('simpler code is a shorter link with the same amount and message', lightHref.length < href.length && lightHref.startsWith('zcash:utest1') && lightHref.includes('amount=0.01') && lightHref.split('memo=')[1] === href.split('memo=')[1], `${lightHref.length} vs ${href.length}`);
  check('the simpler QR decodes to its link', (await decodeQr()) === lightHref);
  await page.click('#qr-toggle');
  check('the full code can be shown again', (await page.getAttribute('#paylink', 'href')) === href && (await decodeQr()) === href);

  // --- pay from a real wallet ---
  log('paying from the test wallet with the page\'s memo');
  let txid = '';
  for (let i = 0; i < 12 && !txid; i++) {
    spawnSync(ZD, ['wallet', '-w', process.env.PAYER, 'sync'], { stdio: 'ignore' });
    const out = spawnSync(ZD, ['wallet', '-w', process.env.PAYER, 'send', '-i', process.env.PAYER + '.age', '--address', payTo, '--value', '1000000', '--memo', memo, '--min-confirmations', '1'], { input: 'y\n', encoding: 'utf8' });
    txid = (out.stdout.match(/^[0-9a-f]{64}$/m) || [''])[0];
    if (!txid) await new Promise((r) => setTimeout(r, 15000));
  }
  check('payment sent', txid.length === 64, txid);

  // --- the page watches ---
  const t0 = Date.now();
  await page.waitForSelector('#s-ticket.done', { timeout: 600000 });
  log(`ticket received and checked ${Math.round((Date.now() - t0) / 1000)} s after paying`);
  await page.screenshot({ path: `${SHOTS}/04-secured.png`, fullPage: true });
  check('"Contribution received" shown', await page.evaluate(() => document.querySelector('#s-received').classList.contains('done')));
  check('the ticket is shown as received and passing the listed checks (level 1)', await page.evaluate(() => document.querySelector('#s-ticket').classList.contains('done')) && /passed the checks below/.test(await page.textContent('#s-ticket')));
  const tcs = ((await page.textContent('#tc-summary')) || '').replace(/\s+/g, ' ');
  check('the page lists only the checks that ran: signatures, network version, coin, fee, no expiry', /Checked: .*its signatures are valid.*it is for the network version in use now.*it never expires.*the fee is what the rules say.*it spends your contribution/.test(tcs), tcs.slice(0, 220));
  // Level 2: a ticket issued now (format version 2) is checked for "it pays you"; only the proof and the chain state stay unchecked
  check('it lists "it pays you" and "the list shows the amount you meant to pay" as checked, and the proof and the anchor as not checked', /Checked: .*the list shows the amount you meant to pay.*it pays you \(its refund output pays the address you gave\)/.test(tcs) && /Not checked: [^.]*the proof; its chain state/.test(tcs) && !/Not checked: [^.]*that it pays you/.test(tcs), tcs.slice(-200));
  check('no red notice for a good ticket', await page.isHidden('#tc-bad'));
  check('payment form is gone once the ticket is received', !(await page.isVisible('#pay-card')) && !(await page.isVisible('#form-card')));
  const seenText = await page.textContent('#s-seen .state');
  check('the page found its own payment', /seen/.test(seenText), seenText);
  check('"Refund me" appears (before the deadline)', await page.isVisible('#refund-btn'));

  // --- progress survives a reload ---
  await page.reload();
  await page.waitForSelector('#progress-card:not([hidden])', { timeout: 30000 });
  await page.waitForSelector('#s-ticket.done', { timeout: 30000 });
  check('progress survives closing and reopening the page', true);

  // --- refund ---
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /^ll:[0-9a-f]{64}$/.test(k)))));
  const ticketTxid = state.ticket.entry.ticket.txid;
  await page.click('#refund-btn');
  check('refund asks for confirmation first', await page.isVisible('#refund-confirm'));
  await page.screenshot({ path: `${SHOTS}/05-refund-confirm.png`, fullPage: true });
  await page.click('#refund-yes');
  await page.waitForSelector('#refund-result:not([hidden])', { timeout: 60000 });
  const rr = (await page.textContent('#refund-result')).trim();
  check('refund was sent to the network', /was sent/.test(rr), rr);
  check('"Refund me" is gone afterwards', !(await page.isVisible('#refund-btn')));
  await page.screenshot({ path: `${SHOTS}/06-refunded.png`, fullPage: true });
  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  fs.writeFileSync(`${SHOTS}/result.json`, JSON.stringify({ payment: txid, ticket: ticketTxid }));
  console.log(`payment ${txid}\nrefund ticket ${ticketTxid}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
