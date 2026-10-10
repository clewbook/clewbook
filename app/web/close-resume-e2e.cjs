// The dashboard's "Try again" after a close whose sweep failed, in a real browser against a real testnet campaign (see close-resume.sh).
// Env: DASH_PORT, FLAG (the file whose presence makes the sweep fail), CAMPAIGN (the campaign folder), SWEEP_TO, SHOTS.
const { chromium } = require('../vectors/js/node_modules/playwright');
const fs = require('fs');
const BASE = `http://127.0.0.1:${process.env.DASH_PORT}`, { FLAG, CAMPAIGN, SWEEP_TO } = process.env, SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const sweeps = () => { try { return JSON.parse(fs.readFileSync(`${CAMPAIGN}/private/outbox.json`, 'utf8')).filter((x) => x.kind === 'sweep'); } catch { return []; } };
const status = async (id) => (await fetch(`${BASE}/api/campaigns/${id}`)).json();

(async () => {
  const browser = await chromium.launch();
  const p = await (await browser.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  try {
    await p.goto(BASE);
    await p.waitForSelector('#live:not([hidden])', { timeout: 60000 });
    const id = await p.inputValue('#campaign-select');
    for (let i = 0; i < 80 && (await status(id)).phase !== 'deadline_passed'; i++) await new Promise((r) => setTimeout(r, 15000));
    await p.reload(); await p.waitForSelector('#live:not([hidden])');
    check('the deadline has passed and the page offers to close', (await status(id)).phase === 'deadline_passed' && (await p.isVisible('#close-btn')));

    // 1. close while the sweep fails
    await p.click('#close-btn');
    await p.fill('#sweep-to', SWEEP_TO);
    log('closing (the sweep is made to fail)');
    await p.click('#close-yes');
    await p.waitForFunction(() => !document.querySelector('#close-error').hidden || document.querySelector('#close-explain').textContent.startsWith('Closed'), null, { timeout: 600000 });
    await p.waitForTimeout(1500);
    const err = await text(p, '#close-error');
    check('the close reports, in one sentence, that it closed but the sweep did not finish, and that Try again sends nothing twice',
      err === 'The campaign is closed, but the sweep to your address did not finish; Try again finishes it without sending anything twice.', err);
    check('it does not claim that nothing was lost (the close entry was written)', !/Nothing was lost/.test(err));
    let s = await status(id);
    check('the campaign is closed (goal met) and one step is recorded as not done', s.phase === 'closed' && s.outcome === 'goal_met' && JSON.stringify(s.close_unfinished) === '["the sweep to your address"]', JSON.stringify(s.close_unfinished));
    await p.click('#close-no').catch(() => {});
    await p.reload(); await p.waitForSelector('#live:not([hidden])'); await p.waitForTimeout(1000);
    check('the page says what is left, in one sentence, and the button now says Try again',
      (await text(p, '#close-explain')) === 'Closed, but the sweep to your address did not finish yet.' && (await p.isVisible('#close-btn')) && (await text(p, '#close-btn')) === 'Try again', await text(p, '#close-explain'));
    check('nothing was swept yet', sweeps().length === 0, JSON.stringify(sweeps().map((x) => x.status)));
    await p.screenshot({ path: `${SHOTS}/close-resume-unfinished.png`, fullPage: true });

    // 2. Try again while it still fails: still nothing sent, the same plain message
    await p.click('#close-btn');
    await p.waitForFunction(() => document.querySelector('#close-btn').textContent === 'Try again' && !document.querySelector('#close-btn').disabled, null, { timeout: 600000 });
    await p.waitForTimeout(1000);
    check('Try again while the step still fails: it says so again, and still nothing is sent', /did not finish/.test(await text(p, '#close-finish-error')) && sweeps().length === 0, await text(p, '#close-finish-error'));

    // 3. the failure is lifted: Try again finishes the sweep
    fs.unlinkSync(FLAG);
    log('the sweep may now succeed: Try again');
    let by = 'Try again';
    if (await p.isVisible('#close-btn')) await p.click('#close-btn'); else by = 'the watcher (it got there first)';
    await p.waitForFunction(() => document.querySelector('#close-explain').textContent === 'This campaign is closed.', null, { timeout: 600000 }).catch(() => {});
    await p.reload(); await p.waitForSelector('#live:not([hidden])'); await p.waitForTimeout(1500);
    s = await status(id);
    check(`the sweep went out (finished by ${by}) and nothing is left`, s.close_unfinished.length === 0 && sweeps().length === 1, JSON.stringify(sweeps().map((x) => [x.txid.slice(0, 12), x.status])));
    check('the page now just says the campaign is closed, without a Try again button', (await text(p, '#close-explain')) === 'This campaign is closed.' && (await p.isHidden('#close-btn')));
    await p.screenshot({ path: `${SHOTS}/close-resume-finished.png`, fullPage: true });
    // 4. later checks of the running program send nothing more
    await new Promise((r) => setTimeout(r, 45000));
    check('three more checks of the running program later: still exactly one sweep', sweeps().length === 1, String(sweeps().length));
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
