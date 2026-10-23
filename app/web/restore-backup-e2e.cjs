// A contributor who lost this browser's state: a brand new browser profile restores the backup file of a REAL test network contribution,
// finds the ticket again from the relay, checks it, shows the backup notice (download it again with the ticket: the check mark appears),
// and, when the page allows a refund, claims it. Play money only. Env: LINK (contribute link with relay and server), BACKUP (the backup
// file), SHOTS, CLAIM=1 to press the refund button. Run from the repository root with Chromium's libraries on LD_LIBRARY_PATH.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const fs = require('fs');
const LINK = process.env.LINK, BACKUP = process.env.BACKUP, SHOTS = process.env.SHOTS || 'runs/restore-shots';
fs.mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const text = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true }); // a new profile: nothing stored
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(LINK);
  await p.waitForSelector('#about:not([hidden])', { timeout: 60000 });
  check('a fresh profile holds no contribution for this campaign', await p.evaluate((k) => localStorage.getItem(k) === null, `ll:${new URL(LINK).hash.match(/c=([0-9a-f]+)/)[1]}`));
  await p.setInputFiles('#restore', BACKUP);
  await p.waitForSelector('#ticket-view:not([hidden])', { timeout: 300000 });
  check('restoring the backup finds the ticket again from the relay', true);
  await p.waitForFunction(() => !/Checking/.test(document.querySelector('#progress-note').textContent), null, { timeout: 120000 });
  const note = await text(p, '#progress-note');
  check('the ticket passes the checks on this device', /passed the checks/.test(note), note.slice(0, 160));
  check('the backup notice is shown once the ticket is here', await p.isVisible('#backup-nudge'));
  const nudge = await text(p, '#backup-nudge');
  check('  ... it says the refund right is in this browser and the file, and what someone holding the file can do', /refund right is kept in this browser and in your backup file/.test(nudge) && /send your refund early/.test(nudge) && /cannot be used to send your money anywhere else/.test(nudge), nudge.slice(0, 200));
  check('  ... and has no hyphen or dash in its words', !/\w-\w|—|–/.test(nudge.replace(/backup3?-done/g, '')), nudge);
  check('  ... no check mark yet: the restored file had no ticket in it', !(await p.isVisible('#backup3-done')));
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#backup3')]);
  const saved = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  check('the new backup file holds the ticket and the warning', !!saved.ticket && /send your refund early/.test(saved.note), saved.note);
  await p.waitForSelector('#backup3-done:not([hidden])', { timeout: 5000 }).catch(() => {});
  check('  ... and the check mark appears', await p.isVisible('#backup3-done'));
  await p.screenshot({ path: `${SHOTS}/restore-ticket.png`, fullPage: true });
  if (process.env.CLAIM === '1') {
    await p.waitForSelector('#refund-area:not([hidden])', { timeout: 120000 });
    check('the page offers the refund', true, await text(p, '#refund-explain'));
    await p.click('#refund-btn'); await p.click('#refund-yes');
    await p.waitForSelector('#refund-result:not([hidden])', { timeout: 120000 });
    const rr = await text(p, '#refund-result');
    check('the restored ticket was sent to the network', /sent to the network|confirmed/.test(rr), rr.slice(0, 160));
    await p.screenshot({ path: `${SHOTS}/restore-refund.png`, fullPage: true });
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(2); });
