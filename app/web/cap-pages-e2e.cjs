// The hard cap on the pages, and the recount page for an auction that has not closed. Read only: no payment is made (a payment code is only
// made in this browser). Env: BASE (a page server for app/web/www), RELAY, CAPPED (an open capped fundraiser with no payments: soft cap 0.002,
// hard cap 0.003), PLAIN (a fundraiser without a cap), AUCTION (an auction that has not closed), REFUND (a testnet address), and optionally
// CLOSED (a closed capped fundraiser with one payment over the cap) with CLOSED_RELAY, DASH (a test network dashboard, for the set up page)
// and DASH_OLD (a dashboard running a host program from before the hard cap).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const E = process.env;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const link = (page, id, relay = E.RELAY) => `${E.BASE}/${page}#c=${id}&relay=${encodeURIComponent(relay)}`;
const facts = (p, sel) => p.evaluate((s) => Object.fromEntries([...document.querySelectorAll(`${s} dt`)].map((dt) => [dt.textContent.trim(), (dt.nextElementSibling?.textContent || '').replace(/\s+/g, ' ').trim()])), sel);
const noDash = (t) => !/\s-\s|—|–/.test(t) && !t.split(/\s+/).some((w) => /^[A-Za-z]+-[A-Za-z]+$/.test(w));
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const open = async (url) => {
    const p = await b.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    // the dashboard has never served loadguard.js, which its set up page asks for (since before this branch): that one known message is left out
    p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text()) && !/loadguard\.js/.test(m.text())) errors.push(m.text()); });
    await p.goto(url);
    return p;
  };

  // ---- contribute page, capped, nothing paid yet ----
  let p = await open(link('contribute.html', E.CAPPED));
  await p.waitForSelector('#form-card:not([hidden])', { timeout: 120000 });
  await p.waitForFunction(() => /Room left/.test(document.querySelector('#about-facts').textContent), null, { timeout: 60000 });
  let f = await facts(p, '#about-facts');
  check('contribute: "Soft cap", "Hard cap" and the room left are shown, and no "Goal"', /^0\.00200000 TAZ/.test(f['Soft cap'] || '') && /^0\.00300000 TAZ/.test(f['Hard cap'] || '') && /^0\.00300000 TAZ/.test(f['Room left under the hard cap'] || '') && !('Goal' in f), JSON.stringify(f).slice(0, 300));
  check('contribute: the status line names both caps', (await p.textContent('#status-text')).trim() === 'Fundraiser, soft cap 0.00200000 TAZ, hard cap 0.00300000 TAZ', await p.textContent('#status-text'));
  check('contribute: no cap note before paying (owner decision: the paragraph is removed)', (await p.locator('#cap-note').count()) === 0);
  check('contribute: the about text has no hyphens or dashes', noDash(await p.textContent('#about-text')));
  await p.fill('#amount', '0.0031'); await p.fill('#refund', E.REFUND); await p.click('#create');
  await p.waitForTimeout(500);
  const err = (await p.textContent('#form-error')).trim();
  check('contribute: an amount larger than the room left is refused, saying the room', /more than the room left under the hard cap \(0\.003 TAZ\)/.test(err) && await p.isHidden('#pay-card'), err);
  await p.fill('#amount', '0.003'); await p.click('#create');
  await p.waitForSelector('#pay-card:not([hidden])', { timeout: 20000 }).catch(() => {});
  check('contribute: an amount that fits makes a payment code', await p.isVisible('#pay-card'));
  await p.close();

  // ---- contribute page without a cap keeps "Goal" ----
  p = await open(link('contribute.html', E.PLAIN));
  await p.waitForSelector('#form-card:not([hidden])', { timeout: 120000 });
  await p.waitForFunction(() => /Goal/.test(document.querySelector('#about-facts').textContent), null, { timeout: 60000 }).catch(() => {});
  f = await facts(p, '#about-facts');
  check('contribute without a cap: "Goal" as before, no caps, no cap note', 'Goal' in f && !('Soft cap' in f) && !('Hard cap' in f) && await p.isHidden('#cap-note'), Object.keys(f).join(', '));
  await p.close();

  // ---- campaign page and claim sheet ----
  p = await open(link('campaign.html', E.CAPPED));
  await p.waitForFunction(() => /Hard cap/.test(document.body.textContent), null, { timeout: 120000 }).catch(() => {});
  const body = (await p.textContent('body')).replace(/\s+/g, ' ');
  check('campaign page: soft cap and hard cap, with what each means', /Soft cap0\.00200000 TAZthe least it must keep/.test(body) && /Hard cap0\.00300000 TAZthe most it keeps/.test(body) && /Soft cap 0\.00200000 TAZ, hard cap 0\.00300000 TAZ/.test(body), body.slice(0, 200));
  await p.close();
  p = await open(link('card.html', E.CAPPED));
  await p.waitForSelector('#card:not([hidden])', { timeout: 120000 }).catch(() => {});
  const terms = (await p.textContent('#terms')).replace(/\s+/g, ' ');
  check('claim sheet: "Soft cap" and "Hard cap" from the rules, no "Goal"', /Soft cap ?0\.00200000 TAZ/.test(terms) && /Hard cap \(payments over it are refunded at the close\) ?0\.00300000 TAZ/.test(terms) && !/Goal/.test(terms), terms.slice(0, 300));
  await p.close();
  p = await open(link('card.html', E.PLAIN));
  await p.waitForSelector('#card:not([hidden])', { timeout: 120000 }).catch(() => {});
  check('claim sheet without a cap: "Goal" as before', /Goal/.test(await p.textContent('#terms')) && !/Hard cap/.test(await p.textContent('#terms')));
  await p.close();

  // ---- recount page: an auction that has not closed ----
  p = await open(link('recount.html', E.AUCTION));
  await p.waitForFunction(() => { const k = document.querySelector('#verdict').dataset.kind; return k && k !== 'working'; }, null, { timeout: 120000 });
  const rows = await p.evaluate(() => [...document.querySelectorAll('#rules .chk')].map((c) => [c.querySelector('.cid').firstChild.textContent, c.querySelector('summary .chip').textContent.trim(), c.className]));
  const word = Object.fromEntries(rows.map(([id, w]) => [id, w]));
  check('open auction: R1 and R2 PASS, every other check WAIT, as the command line shows', word.R1 === 'PASS' && word.R2 === 'PASS' && ['R3', 'R4', 'R4b', 'R5', 'R6', 'R7', 'R8'].every((id) => word[id] === 'WAIT') && rows.length === 9, JSON.stringify(word));
  check('open auction: the WAIT rows look neutral (not pass, not fail) and stay closed', rows.filter(([, w]) => w === 'WAIT').every(([, , c]) => /\bnc\b/.test(c)));
  const vt = await p.textContent('#verdict-text');
  check('open auction: the verdict says "Not yet possible", that R1 and R2 pass, and why the rest waits', (await p.getAttribute('#verdict', 'data-kind')) === 'cannot' && /Not yet possible/.test(await p.textContent('#verdict-title')) && /R1 and R2 pass/.test(vt) && /published at the close/.test(vt) && noDash(vt), vt);
  await p.close();

  // ---- recount page: a closed capped fundraiser ----
  if (E.CLOSED) {
    p = await open(link('recount.html', E.CLOSED, E.CLOSED_RELAY || E.RELAY));
    await p.waitForFunction(() => { const k = document.querySelector('#verdict').dataset.kind; return k && k !== 'working'; }, null, { timeout: 600000 });
    const t = await facts(p, '#totals');
    const r6 = await p.evaluate(() => [...document.querySelectorAll('#rules .chk')].find((c) => c.querySelector('.cid').firstChild.textContent === 'R6')?.textContent.replace(/\s+/g, ' '));
    check('closed capped recount: all checks pass', (await p.locator('#rules .chk.fail').count()) === 0 && Number(await p.textContent('#n-fail')) === 0);
    check('closed capped recount: totals show the soft cap (met), the hard cap and what was over it', /met/.test(t['Soft cap'] || '') && 'Hard cap' in t && /in 1 payment\(s\), refunded by their own tickets/.test(t['Over the hard cap'] || '') && !('Goal' in t), JSON.stringify(t).slice(0, 400));
    check('closed capped recount: R6 says "1 payment(s) over the cap, refunded by ticket"', /1 payment\(s\) over the cap, refunded by ticket/.test(r6 || ''), r6);
    await p.close();
  }

  // ---- set up page: the hard cap field ----
  if (E.DASH) {
    p = await open(`${E.DASH}/setup.html`);
    await p.waitForSelector('#cap', { timeout: 30000 });
    await p.fill('#goal', '0.002'); await p.fill('#cap', '0.003'); await p.waitForTimeout(300);
    const w = (await p.textContent('#cap-warn')).trim();
    check('set up page: a hard cap below twice the goal shows the plain warning (and does not block)', await p.isVisible('#cap-warn') && /less than twice the soft cap/.test(w) && await p.isEnabled('#create-btn') && noDash(w), w);
    let pv = (await p.textContent('#terms')).replace(/\s+/g, ' ');
    check('set up page: the summary says "Soft cap" and "Hard cap" when a cap is entered', /Soft cap ?0\.00200000/.test(pv) && /Hard cap ?0\.00300000/.test(pv) && !/Goal/.test(pv), pv.slice(0, 200));
    await p.fill('#cap', '0.004'); await p.waitForTimeout(300);
    check('set up page: twice the goal: no warning', await p.isHidden('#cap-warn'));
    await p.fill('#cap', ''); await p.waitForTimeout(300);
    pv = (await p.textContent('#terms')).replace(/\s+/g, ' ');
    check('set up page: without a cap the summary says "Goal" as before', /Goal ?0\.00200000/.test(pv) && !/Hard cap/.test(pv), pv.slice(0, 200));
    check('set up page: the hard cap hint has no hyphens or dashes', noDash(await p.textContent('#cap-hint')));
    await p.close();
  }

  // ---- set up page on a host program that does not know the hard cap: no cap field (it would be ignored) ----
  if (E.DASH_OLD) {
    p = await open(`${E.DASH_OLD}/setup.html`);
    await p.waitForSelector('#goal', { timeout: 30000 });
    await p.waitForTimeout(1500);
    check('set up page on an older host program: the hard cap field is not offered', await p.isHidden('#cap-row') && await p.isHidden('#cap'));
    await p.close();
  }

  check('no page errors and no content policy violations', errors.length === 0, errors.join(' | ').slice(0, 300));
  await b.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e); process.exit(2); });
