// The sealed bid auction's set up page and dashboard notes, in a headless browser against a throwaway host on the test network (started by
// app/web/check-setup-coins.sh, which sets BASE, RELAY_DIR and RUNS_DIR):
// - the numbers typed in "Every [ ] bids" and "Every [ ] minutes" are fully visible with 4 digits, typing one chooses its line, the summary
//   shows the choice with its number (or that it is over the limit), and a number over the limit is refused before anything is made;
// - the summary shows the bidding window live, and a window under 10 blocks is refused with the reason, on the page and by the host,
//   before any wallet is made;
// - the timing is standard unless the quick test is chosen, and the summary says which;
// - the auction created keeps the number and the quick test timing in its published rules, and the dashboard shows the timing;
// - every note on the dashboard can be closed (a "Hide note" button inside it): it stays closed until its message changes; one that needs
//   action comes back on reload; "keep this program running" shows only while a campaign on the host still needs it; the deposits tile
//   never shows a bare 0 for an auction that is still being counted.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const fs = require('fs');
const { BASE, RELAY_DIR, RUNS_DIR } = process.env;
const folders = () => fs.readdirSync(RUNS_DIR).length;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

// the typed text fits inside the box: the box's inner width holds the text's width, and nothing scrolls out of sight
const fits = (p, sel) => p.$eval(sel, (e) => {
  const cs = getComputedStyle(e);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const inner = e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const text = ctx.measureText(e.value).width;
  return { ok: e.offsetParent !== null && inner >= text && e.scrollWidth <= e.clientWidth, inner: Math.round(inner), text: Math.round(text), value: e.value };
});

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const p = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${BASE}/setup.html`);
    await p.waitForSelector('#sealed-choice:not([hidden])', { timeout: 30000 });
    await p.check('input[name=mode][value=sealed_auction]');
    if (w === 1280) {
      // set 2 L6 and L7: what the set up page says for a blind bid auction is true for it, in one short line each
      const coinHint = await p.textContent('#s-coins .hint');
      check('L7: the small payments go out at once from 20 blocks before the cutoff, as the host does', /From 20 blocks before the cutoff they go out at once/.test(coinHint) && !/10 blocks before the deadline/.test(coinHint), coinHint);
      check('L6: the ticket window hint is about deposits and their tickets', /Each deposit must get its tickets within this many blocks/.test(await p.textContent('#ticketk-hint')), await p.textContent('#ticketk-hint'));
      check('L6: no promise of a refund ticket with no expiry', !/no expiry height/.test(await p.textContent('.t-lead')), await p.textContent('.t-lead'));
    }
    await p.check('input[name=scoins][value=at_once]');
    await p.fill('#s-coins-min', '9999');
    check(`${w}px: typing in "Every [ ] minutes" chooses that line`, await p.isChecked('input[name=scoins][value=every_minutes]'));
    const m = await fits(p, '#s-coins-min');
    check(`${w}px: 4 digits are visible in "Every [ ] minutes"`, m.ok, JSON.stringify(m));
    check(`${w}px: the summary says 9999 minutes is over the limit`, /Small payments\s*at most 1,440 minutes/.test(await p.textContent('#terms')));
    await p.fill('#s-coins-min', '1440');
    check(`${w}px: the summary shows every 1,440 minutes`, /Small payments\s*Every 1,440 minutes/.test(await p.textContent('#terms')));
    await p.fill('#s-coins-bids', '1234');
    check(`${w}px: typing in "Every [ ] bids" chooses that line`, await p.isChecked('input[name=scoins][value=every_bids]'));
    const b = await fits(p, '#s-coins-bids');
    check(`${w}px: 4 digits are visible in "Every [ ] bids"`, b.ok, JSON.stringify(b));
    const terms = (await p.textContent('#terms')).replace(/\s+/g, ' ');
    check(`${w}px: the summary says 1234 bids is over the limit`, /Small payments ?at most 1,000 bids/.test(terms), terms.slice(0, 260));
    await p.fill('#s-coins-bids', '1000');
    check(`${w}px: the summary shows every 1,000 bids`, /Small payments ?Every 1,000 bids, and at once near the cutoff/.test((await p.textContent('#terms')).replace(/\s+/g, ' ')));
    check(`${w}px: 4 digits are visible in "Every [ ] bids" (1000)`, (await fits(p, '#s-coins-bids')).ok);
    await p.check('input[name=scoins][value=at_once]');
    check(`${w}px: the summary follows a change back to at once`, /Small payments ?At once, one payment per bid/.test((await p.textContent('#terms')).replace(/\s+/g, ' ')));
    // the bidding window, live
    const terms2 = async () => (await p.textContent('#terms')).replace(/\s+/g, ' ');
    await p.fill('#deadline', '30'); await p.fill('#ticketk', '30');
    check(`${w}px: deadline 30 with ticket window 30: the summary says no blocks are left for deposits`, /Deposits accepted until ?only 0 block\(s\): too short, at least 10 are needed/.test(await terms2()), (await terms2()).match(/Deposits accepted until.{0,70}/)?.[0]);
    await p.fill('#ticketk', '10');
    const t3 = await terms2();
    check(`${w}px: with ticket window 10 the summary shows the last block for deposits and the time`, /Deposits accepted until ?(Block [\d,]+(, about [\d,]+ minutes from now)?|20 blocks from now)/.test(t3), t3.match(/Deposits accepted until.{0,60}/)?.[0]);
    // the timing: standard unless chosen
    check(`${w}px: the timing is standard by default`, await p.isChecked('input[name=stiming][value=standard]') && /Timing ?Standard/.test(t3));
    await p.check('input[name=stiming][value=quick]');
    check(`${w}px: choosing the quick test shows it in the summary`, /Timing ?Quick test: blocks every 20 to 40 seconds, bids open 10 minutes after the deadline/.test(await terms2()));
    await p.context().close();
  }

  // 1234 bids is over the rules' limit and refused on the page; 1000 creates the auction and the rules keep it
  const p = await (await browser.newContext()).newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  try {
    await p.goto(`${BASE}/setup.html`);
    await p.waitForSelector('#sealed-choice:not([hidden])', { timeout: 30000 });
    await p.check('input[name=mode][value=sealed_auction]');
    await p.fill('#campaign-name', 'Setup coins check');
    await p.fill('#s-items', '1');
    await p.fill('#s-tranches', '0.0003\n0.001');
    // a bidding window under 10 blocks: refused on the page, and by the host if asked directly, with nothing made
    const before = folders();
    await p.fill('#s-coins-bids', '1000');
    await p.fill('#deadline', '30');
    await p.fill('#ticketk', '30');
    await p.click('#create-btn');
    await p.waitForSelector('#setup-error:not([hidden])', { timeout: 10000 });
    const why = await p.textContent('#setup-error');
    check('deadline 30 with ticket window 30 is refused on the page, saying why', /This leaves 0 block\(s\) for deposits/.test(why) && /at least 40 blocks/.test(why) && p.url().endsWith('/setup.html'), why.slice(0, 160));
    const direct = await p.evaluate(async () => {
      const r = await fetch('/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify({ mode: 'sealed_auction', items: 1, tranches_zat: [30000, 100000], pricing: 'uniform', coin_sending: { mode: 'at_once' }, deadline_in: 30, ticket_k: 30 }) });
      return { status: r.status, body: await r.text() };
    });
    check('the host refuses it too when asked directly', direct.status >= 400 && /This leaves 0 block\(s\) for deposits/.test(direct.body), `${direct.status} ${direct.body.slice(0, 100)}`);
    check('  ... and no campaign folder or wallet was made', folders() === before, `${before} -> ${folders()}`);
    await p.check('input[name=stiming][value=quick]');
    await p.fill('#s-coins-bids', '1234');
    await p.fill('#deadline', '40');
    await p.fill('#ticketk', '10');
    await p.click('#create-btn');
    await p.waitForSelector('#setup-error:not([hidden])', { timeout: 10000 });
    const refusal = await p.textContent('#setup-error');
    check('1234 bids is refused on the page, before anything is made', /1 to 1,000 bids/.test(refusal) && p.url().endsWith('/setup.html'), refusal);
    await p.fill('#s-coins-bids', '1000');
    await p.click('#create-btn');
    await p.waitForURL(`${BASE}/`, { timeout: 600000 });
    const list = await p.evaluate(async () => (await fetch('/api/campaigns')).json());
    const c = list.campaigns.find((x) => x.name === 'Setup coins check');
    const s = await p.evaluate(async (id) => (await fetch(`/api/campaigns/${id}`, { cache: 'no-store' })).json(), c.id);
    check('the dashboard reports every 1000 bids for the auction made', JSON.stringify(s.sealed.coin_sending) === JSON.stringify({ mode: 'every_bids', n: 1000 }), JSON.stringify(s.sealed.coin_sending));
    const f = `${RELAY_DIR}/campaigns/${c.id}/rules.json`;
    const sending = fs.existsSync(f) && JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8'))).match(/"coin_sending":\{[^}]*\}/);
    check('the published rules keep every 1000 bids', !!sending && /"mode":"every_bids"/.test(sending[0]) && /"n":1000/.test(sending[0]), sending ? sending[0] : 'rules not found');
    const published = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    check('the published rules keep the quick test timing', published.sealed && published.sealed.timing === 'quick', JSON.stringify(published.sealed || {}).slice(0, 80));
    check('the dashboard reports the quick test timing', s.sealed.timing === 'quick', String(s.sealed.timing));

    // the dashboard's notes: each can be closed
    const dash = await (await browser.newContext()).newPage();
    dash.on('pageerror', (e) => errors.push(String(e)));
    const notes = () => dash.$$eval('#warning-list .notice', (xs) => xs.map((x) => ({ text: x.querySelector('p').textContent, x: !!x.querySelector('button.note-x'), bad: x.classList.contains('bad') })));
    const waitNotes = () => dash.waitForFunction(() => document.querySelectorAll('#warning-list .notice').length > 0, null, { timeout: 120000 });
    // a note that needs action, added to the dashboard's own answer in this browser (a real one means something went wrong)
    const MONEY = 'TEST: a contribution was spent by something else.';
    await dash.route(`${BASE}/api/campaigns/${c.id}`, async (route) => {
      const r = await route.fetch(); const j = await r.json();
      j.warnings = [{ level: 'bad', text: MONEY }, ...(j.warnings || [])];
      await route.fulfill({ response: r, json: j });
    });
    await dash.goto(`${BASE}/`);
    await waitNotes();
    await dash.waitForFunction(() => /Timing/.test(document.querySelector('#facts').textContent), null, { timeout: 120000 }).catch(() => {});
    check('the dashboard facts show the quick test timing', /Timing\s*Quick test/.test(await dash.textContent('#facts')));
    let n = await notes();
    const info = n.find((x) => !x.bad && /This is the test network/.test(x.text)); // a note that stays (not "Starting up", which ends by itself)
    check('every note on the dashboard has a close button', n.length >= 2 && n.every((x) => x.x), JSON.stringify(n.map((x) => [x.bad ? 'bad' : 'note', x.text.slice(0, 30), x.x])));
    await dash.click(`#warning-list .notice:has(p:text-is(${JSON.stringify(info.text)})) .note-x`);
    await dash.click(`#warning-list .notice:has(p:text-is(${JSON.stringify(MONEY)})) .note-x`);
    n = await notes();
    check('closing hides the note and the money warning at once', !n.some((x) => x.text === info.text) && !n.some((x) => x.text === MONEY), JSON.stringify(n.map((x) => x.text.slice(0, 30))));
    await dash.waitForTimeout(16000); // a refresh of the dashboard (every 15 s) keeps them closed
    n = await notes();
    check('  ... and a refresh keeps both closed', !n.some((x) => x.text === info.text) && !n.some((x) => x.text === MONEY));
    await dash.reload(); await waitNotes();
    n = await notes();
    check('after a reload the closed note stays closed, and the money warning is back', !n.some((x) => x.text === info.text) && n.some((x) => x.text === MONEY), JSON.stringify(n.map((x) => x.text.slice(0, 30))));
    // its message changes: the note may show again (the closed one was the old text)
    await dash.evaluate((t) => { const k = 'cb-dismissed-notes'; const l = JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(l.map((e) => e.replace(t, `${t} (an older wording)`)))); }, info.text);
    await dash.reload(); await waitNotes();
    check('a note whose message changed since it was closed shows again', (await notes()).some((x) => x.text === info.text));
    check('the close button is inside the note, on the right, centred on its text, labelled "Hide note"', await dash.$eval('#warning-list .notice .note-x', (x) => {
      const n = x.closest('.notice').getBoundingClientRect(), b = x.getBoundingClientRect(), p = x.closest('.notice').querySelector('p').getBoundingClientRect();
      return b.left >= n.left && b.right <= n.right - 4 && b.top >= n.top + 2 && b.bottom <= n.bottom - 2 && Math.abs((b.top + b.bottom) / 2 - (n.top + n.bottom) / 2) <= 2 && b.left >= p.right - 1 && x.getAttribute('aria-label') === 'Hide note';
    }));

    // "keep this program running" and the deposits count, with the dashboard's answers changed in this browser (a closed auction cannot
    // be made in a short test): the note only while this or another campaign still needs the host; the count never a bare 0
    const dash2 = await (await browser.newContext()).newPage();
    dash2.on('pageerror', (e) => errors.push(String(e)));
    const v = { self: 'closed', other: 'closed', deposits: 0, revealed: false };
    const OTHER = 'ff'.repeat(32);
    await dash2.route(`${BASE}/api/campaigns`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const r = await route.fetch(); const j = await r.json();
      j.campaigns = [...j.campaigns.map((x) => ({ ...x, phase: v.self })), { id: OTHER, short: 'ffffffff', name: 'Other', mode: 'sealed_auction', phase: v.other }];
      await route.fulfill({ response: r, json: j });
    });
    await dash2.route(`${BASE}/api/campaigns/${c.id}`, async (route) => {
      const r = await route.fetch(); const j = await r.json();
      j.phase = v.self; j.sealed.closed = v.self === 'closed'; j.sealed.deposits = v.deposits; j.sealed.revealed = v.revealed;
      await route.fulfill({ response: r, json: j });
    });
    const look = async () => {
      await dash2.goto(`${BASE}/`); await dash2.waitForFunction(() => document.querySelectorAll('#warning-list .notice').length > 0 && /Deposits/.test(document.querySelector('#dtiles').textContent), null, { timeout: 120000 });
      return { keep: (await dash2.$$eval('#warning-list .notice p', (xs) => xs.map((x) => x.textContent))).find((t) => /^Keep this program/.test(t)) || null, tile: (await dash2.textContent('#dtiles')).replace(/\s+/g, ' ') };
    };
    let l = await look();
    check('a closed campaign, and nothing else on the host needs it: no "keep this program running" note', l.keep === null, String(l.keep));
    check('  ... a closed auction with no deposits says so: "0 · nobody bid"', /Deposits ?0 · nobody bid/.test(l.tile), l.tile);
    v.other = 'deadline_passed'; v.deposits = 3; v.revealed = true;
    l = await look();
    check('a closed campaign while another waits to close: the note says the other campaign needs the host', /^Keep this program and this computer running: 1 other campaign\(s\) on this host are open or waiting to close/.test(l.keep || ''), String(l.keep));
    check('  ... a closed auction with its deposits paid out: "3 · all settled or refunded"', /Deposits ?3 · all settled or refunded/.test(l.tile), l.tile);
    v.self = 'open'; v.other = 'closed'; v.deposits = null;
    l = await look();
    check('an open campaign: the note as before', /^Keep this program and this computer running while the campaign is open/.test(l.keep || ''), String(l.keep));
    check('  ... before the first count of deposits: "counting…", never 0', /Deposits ?counting…/.test(l.tile), l.tile);
  } catch (e) {
    check('create', false, String(e).slice(0, 300));
  }
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
