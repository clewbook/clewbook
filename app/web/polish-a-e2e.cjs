// Polish stage A, on the contributor page and the shared badge: status badge states, heading and labels by campaign type, the boxed pre-payment
// notice, going back / starting over (and the list of left payment codes), and the "ticket has not arrived" notice (only when true).
// Plain files from app/web/make-static.sh (default runs/static-polish) on a spare port; the chain server is a stand-in answered by this test, so no
// network and no money are involved. Env: DIR, PORT (default 8802), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8802', SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, MOCK = 'https://chain.mock.test/testnet';
const RAISE = { id: '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da', deadline: 4477610, k: 30, pay: 'utest12jhk6f4xh2ddn0' }; // open-able fundraiser (no close entry)
const MISSED = { id: '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f', deadline: 4477369 }; // closed, goal missed
const AUCTION = { id: '5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb', deadline: 4472149 }; // closed, uniform auction
const link = (c) => `${BASE}/contribute.html#c=${c.id}&relay=${BASE}/relays/a&relay=${BASE}/relays/b&server=${encodeURIComponent(MOCK)}`;

// the answer of a chain server, in the gRPC-web framing the pages read
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  let tip = 0;
  const newPage = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, ...opts });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.route(`${MOCK}/**`, async (route) => {
      const url = route.request().url();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(url) ? frame(0, [0x08, ...varint(tip)]) : Buffer.alloc(0);
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
    return p;
  };
  const text = async (p, sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();
  try {
    // ---------- 1. status badge ----------
    let p = await newPage();
    tip = RAISE.deadline - 100;
    await p.goto(link(RAISE));
    await p.waitForSelector('#status-chip .sbadge', { timeout: 60000 });
    check('badge, open: the word OPEN', (await text(p, '#status-chip')) === 'OPEN');
    const open = await p.evaluate(() => { const b = document.querySelector('#status-chip .sbadge'), d = b.querySelector('.sdot'); return { color: getComputedStyle(b).color, anim: getComputedStyle(d).animationName, g: getComputedStyle(b).color }; });
    check('badge, open: green and pulsing (motion allowed)', open.anim === 'cb-pulse' && /^rgb\(28, 122, 74\)$/.test(open.color), JSON.stringify(open));
    await p.screenshot({ path: `${SHOTS}/polish-a-open.png` });
    await p.context().close();

    p = await newPage({ reducedMotion: 'reduce' });
    await p.goto(link(RAISE));
    await p.waitForSelector('#status-chip .sbadge', { timeout: 60000 });
    check('badge, open: does not blink when the person asked for reduced motion (the word OPEN stays)', (await p.evaluate(() => getComputedStyle(document.querySelector('#status-chip .sdot')).animationName)) === 'none' && (await text(p, '#status-chip')) === 'OPEN');
    await p.context().close();

    p = await newPage();
    tip = RAISE.deadline + 5;
    await p.goto(link(RAISE));
    await p.waitForFunction(() => /DEADLINE PASSED/.test(document.querySelector('#status-chip').textContent), null, { timeout: 60000 });
    check('badge, deadline passed and not closed: its own state, static', (await p.evaluate(() => document.querySelector('#status-chip .sdot'))) === null);
    await p.context().close();

    p = await newPage();
    tip = MISSED.deadline + 5;
    await p.goto(link(MISSED));
    await p.waitForFunction(() => /CLOSED/.test(document.querySelector('#status-chip').textContent), null, { timeout: 60000 });
    const closed = await p.evaluate(() => ({ words: document.querySelector('#status-chip').textContent, red: getComputedStyle(document.querySelector('#status-chip .sbadge.closed')).color, still: document.querySelector('#status-chip .sdot') === null }));
    check('badge, closed: the word CLOSED, static, in neutral grey (decision 4)', /CLOSED/.test(closed.words) && closed.red === 'rgb(82, 90, 104)' && closed.still, JSON.stringify(closed));
    check('badge, closed with the goal missed: GOAL MISSED, not FAILED (decision 4)', /GOAL MISSED/.test(closed.words) && !/FAILED|SUCCEEDED/.test(closed.words));
    await p.context().close();

    p = await newPage();
    tip = AUCTION.deadline + 5;
    await p.goto(link(AUCTION));
    await p.waitForFunction(() => /CLOSED/.test(document.querySelector('#status-chip').textContent), null, { timeout: 60000 });
    check('badge, closed auction: CLOSED · AUCTION SETTLED', /CLOSED · AUCTION SETTLED/.test(await text(p, '#status-chip')));
    const states = await p.evaluate(async () => {
      const m = await import('./ui.js');
      return ['open', 'ended', 'closed', 'x'].map((k) => m.statusBadgeHTML({ phase: k })).concat([m.statusBadgeHTML({ phase: 'closed', outcome: 'goal_missed', refunding: true }), m.statusBadgeHTML({ phase: 'closed', outcome: 'goal_met' })]);
    });
    const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    check('badge states: refunding, goal missed, goal met each have their own words', strip(states[4]) === 'CLOSED · GOAL MISSED REFUNDING' && strip(states[5]) === 'CLOSED · GOAL MET' && strip(states[0]) === 'OPEN' && strip(states[1]) === 'DEADLINE PASSED', states.map(strip).join(' | '));
    // the dashboard uses the very same function (its page needs a live host, so that is covered by dashboard-view-e2e)
    check('the host dashboard draws its status with the same badge function', /statusBadgeHTML/.test(require('fs').readFileSync(`${DIR}/ui.js`, 'utf8')) && /statusBadgeHTML/.test(require('fs').readFileSync('app/web/www/dashboard.js', 'utf8')));

    // ---------- 2. heading and labels by type ----------
    check('auction page: the heading is just "Auction"', (await text(p, '#page-title')) === 'Auction' && (await text(p, '#crumb')) === 'Auction' && /^Auction ·/.test(await p.title()), await p.title());
    const lab = [await text(p, '#amount-label'), await text(p, '#received-what'), await text(p, '#about-facts'), await text(p, '#form-intro')];
    check('auction page: labels say bid', /Your bid/.test(lab[0]) && /Bid received/.test(lab[1]) && /SmallestbidSmallest bid|Smallest bid/.test(lab[2]) , lab.map((x) => x.slice(0, 60)).join(' | '));
    check('auction page does not say "contribution" in its form labels', !/contribution/i.test(await text(p, '#form-card .hd')) && !/contribution/i.test(await text(p, '#amount-label')));
    await p.context().close();
    p = await newPage();
    tip = AUCTION.deadline - 100; // before the deadline the form is the bid form
    await p.goto(link(AUCTION));
    await p.waitForSelector('#form-title', { timeout: 60000 });
    await p.waitForFunction(() => /Your bid/.test(document.querySelector('#form-title').textContent), null, { timeout: 60000 });
    check('auction page, open: the form says "Your bid" and that bid amounts stay off the public record', /off the public record/.test(await text(p, '#form-intro')) && /Your bid/.test(await text(p, '#form-title')));
    await p.context().close();

    p = await newPage();
    tip = RAISE.deadline - 100;
    await p.goto(link(RAISE));
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    check('fundraiser page: the heading is just "Fundraiser" and labels say contribution', (await text(p, '#page-title')) === 'Fundraiser' && /^Fundraiser ·/.test(await p.title()) && /Your contribution/.test(await text(p, '#form-title')) && /Amount/.test(await text(p, '#amount-label')) && /Contribution received/.test(await text(p, '#received-what')));
    const amountBack = await p.evaluate((id) => { const a = document.querySelector('#flow-back'), u = new URL(a.href); return u.pathname.endsWith('/campaign.html') && new URLSearchParams(u.hash.slice(1)).get('c') === id && new URLSearchParams(u.hash.slice(1)).getAll('relay').length === 2 && !!a.offsetParent; }, RAISE.id);
    check('amount step: the top left link goes to this campaign\'s own page with the same relays (not the recount)', amountBack);
    check('no page title or heading is the bare word "Contribute"', (await text(p, '#page-title')) !== 'Contribute' && (await p.title()) !== 'Contribute · ' + (await p.title()).split(' · ').pop());

    // ---------- 3. the boxed notice ----------
    const addr = (await p.evaluate(async (id) => (await (await fetch(`/relays/a/v1/campaigns/${id}`)).json()).pay_to, RAISE.id));
    // ---------- 2b. an amount below the campaign's smallest contribution makes no payment code ----------
    const amountState = () => p.evaluate(() => { const e = document.querySelector('#amount-error'), box = document.querySelector('.amountbox'), cs = getComputedStyle(box), inp = document.querySelector('#amount');
      return { shown: !e.hidden, text: e.textContent, under: box.nextElementSibling === e, hintHidden: document.querySelector('#amount-hint').hidden, bad: box.classList.contains('bad'), border: cs.borderTopColor, ring: cs.boxShadow, inv: inp.getAttribute('aria-invalid'), desc: inp.getAttribute('aria-describedby'), live: e.getAttribute('aria-live'), addrMsg: document.querySelector('#form-error').hidden ? '' : document.querySelector('#form-error').textContent, focus: document.activeElement && document.activeElement.id }; });
    await p.fill('#amount', '0.0001'); // typing only, no click
    let am = await amountState();
    check('typing an amount below the minimum: at once a red edge and ring on the amount box and the message directly under it, in place of the hint', am.shown && am.under && am.hintHidden && am.bad && /^The smallest amount this campaign accepts is 0\.0002 TAZ\.$/.test(am.text) && am.border === 'rgb(179, 38, 30)' && /3px/.test(am.ring) && am.inv === 'true' && am.desc === 'amount-error' && am.live === 'polite' && am.addrMsg === '', JSON.stringify(am));
    await p.fill('#refund', addr); await p.click('#create');
    am = await amountState();
    check('below the smallest contribution: no payment code, the message stays under the amount box, nothing about the amount under the address, focus on the amount', /smallest amount this campaign accepts is 0\.0002 TAZ/.test(am.text) && am.shown && am.addrMsg === '' && am.focus === 'amount' && (await p.isHidden('#pay-card')) && (await p.evaluate((id) => localStorage.getItem(`ll:${id}`), RAISE.id)) === null, JSON.stringify(am));
    await p.fill('#amount', '0.00019999'); await p.click('#create');
    check('one unit below the minimum is refused too', /0\.0002 TAZ/.test(await text(p, '#amount-error')) && (await p.isHidden('#pay-card')));
    await p.fill('#amount', '');
    am = await amountState();
    check('emptying the amount clears the red edge and the message at once, and the grey hint comes back', !am.shown && !am.bad && !am.hintHidden && am.inv === null && am.desc === 'amount-hint', JSON.stringify(am));
    await p.fill('#amount', '0.0002'); await p.fill('#refund', ''); await p.click('#create');
    am = await amountState();
    check('a blank refund address: its message under the address box, nothing under the amount', /enter the address where your refund should go/i.test(am.addrMsg) && !am.shown && (await p.isHidden('#pay-card')), JSON.stringify(am));
    await p.fill('#refund', 'not an address'); await p.click('#create');
    am = await amountState();
    check('a wrong refund address: its message under the address box, nothing under the amount', /valid refund address/i.test(am.addrMsg) && !am.shown && (await p.isHidden('#pay-card')), JSON.stringify(am));
    await p.fill('#amount', '0.0001'); await p.click('#create');
    am = await amountState();
    check('a wrong amount and a wrong address together: each message under its own box (never an amount message under the address), focus on the amount', am.shown && /smallest amount/.test(am.text) && /valid refund address/i.test(am.addrMsg) && !/amount/i.test(am.addrMsg) && am.focus === 'amount', JSON.stringify(am));
    await p.fill('#refund', addr);
    await p.fill('#amount', '0.0002'); await p.click('#create'); await p.waitForSelector('#pay-card:not([hidden])', { timeout: 10000 });
    check('exactly the minimum is accepted', (await text(p, '#pay-min')).startsWith('0.0002'));
    const backLink = () => p.evaluate((id) => { const a = document.querySelector('#flow-back'), u = new URL(a.href); return { ok: !!a.offsetParent && u.pathname.endsWith('/campaign.html') && new URLSearchParams(u.hash.slice(1)).get('c') === id, href: a.getAttribute('href').slice(0, 40), stage: document.querySelector('#cflow').dataset.stage }; }, RAISE.id);
    let bl = await backLink();
    check('backup step: the top left link goes to this campaign\'s own page (not the recount)', bl.ok && bl.stage === 'backup', JSON.stringify(bl));
    await p.evaluate((id) => localStorage.removeItem(`ll:${id}`), RAISE.id); await p.reload(); await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    const create = async (amount) => { await p.fill('#amount', amount); await p.fill('#refund', addr); await p.click('#create'); await p.waitForSelector('#pay-card:not([hidden])'); if (await p.isVisible('#to-pay')) await p.click('#to-pay'); }; // design round 2: Continue to pay after the Backup step
    await create('0.01');
    bl = await backLink();
    check('pay step: the top left link goes to this campaign\'s own page (not the recount)', bl.ok && bl.stage === 'pay', JSON.stringify(bl));
    await p.setViewportSize({ width: 1280, height: 900 }); await p.waitForTimeout(300);
    const row = await p.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const ids = ['change-amount', 'start-over', 'backup2'];
      return { tops: ids.map((i) => Math.round(r(i).top)), heights: ids.map((i) => Math.round(r(i).height)), lefts: ids.map((i) => Math.round(r(i).left)), parent: ids.every((i) => document.getElementById(i).parentElement === document.getElementById('change-amount').parentElement),
        downloads: [...document.querySelectorAll('#cflow button')].filter((b) => b.offsetParent && b.textContent.trim() === 'Download backup file').length }; });
    check('pay step at 1280: Download backup file in the same row as Back to the amount and Start over, same height, one of it only', row.parent && new Set(row.tops).size === 1 && new Set(row.heights).size === 1 && row.lefts[0] < row.lefts[1] && row.lefts[1] < row.lefts[2] && row.downloads === 1, JSON.stringify(row));
    await p.setViewportSize({ width: 1000, height: 900 }); await p.waitForTimeout(300);
    check('the footer pill reads "Try the testnet demo →", with no triangle', (await p.textContent('.sitefoot .demo-pill')) === 'Try the testnet demo →' && !/▲/.test(await p.textContent('.sitefoot')));
    check('pay step: "Where things stand" is shown, "About this campaign" is not', (await p.isVisible('.stand-k')) && (await p.isVisible('#s-ticket')) && (await p.isHidden('#about')));
    const box = await p.evaluate(() => {
      const w = document.querySelector('#pay-warning'), cs = getComputedStyle(w), qr = document.querySelector('#qr');
      return { border: parseFloat(cs.borderTopWidth), color: cs.color, before: !!(w.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING), text: w.textContent.replace(/\s+/g, ' ').trim(), why: document.querySelector('#pay-why').open, whyText: document.querySelector('#pay-why p').textContent };
    });
    check('pre-payment line: one plain sentence in ink (no box), above the code, with the amount and where to pay from', box.border === 0 && box.color === 'rgb(18, 21, 26)' && box.before && /^Pay exactly 0\.01(0+)? TAZ once, from a shielded address\.$/.test(box.text), `${box.text.slice(0, 120)} ${box.color}`);
    check('pre-payment line: the reasons sit behind a closed "Why?" (one sentence about a smaller or second payment)', box.why === false && /smaller or second payment is not refunded/.test(box.whyText));
    const wl = await p.evaluate(() => { const m = document.querySelector('#manual'); m.open = true; const a = document.querySelector('#paylink'), n = m.querySelector('.wallet-note'); const r = (e) => e.getBoundingClientRect();
      const out = { note: n ? n.innerText.trim() : null, below: !!n && r(n).top >= r(a).bottom, old: /works with some wallets only|most reliable way/.test(m.innerText), link: a.textContent, wide: document.documentElement.scrollWidth <= innerWidth + 1 }; m.open = false; return out; });
    check('pay step: "(Connects with Vizor, Noir coming soon)" on its own line under "Open in my wallet app", and the old sentence is gone', wl.note === '(Connects with Vizor, Noir coming soon)' && wl.below && !wl.old && wl.link === 'Open in my wallet app' && wl.wide, JSON.stringify(wl));
    await p.screenshot({ path: `${SHOTS}/polish-a-warning.png`, fullPage: true });
    const first = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:${id}`)), RAISE.id);

    // ---------- 4. back and start over ----------
    check('the payment step offers "Back to the amount" and "Start over"', (await p.isVisible('#change-amount')) && (await p.isVisible('#start-over')));
    const headTop = await p.evaluate(() => Math.round(document.querySelector('#pay-warning').getBoundingClientRect().top + scrollY));
    await p.click('#change-amount');
    const lv = await p.evaluate((before) => { const box = document.querySelector('#leave-confirm'), row = document.querySelector('#leave-box .btns'), h = document.querySelector('#pay-warning');
      return { after: !!(row.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING), below: box.getBoundingClientRect().top >= row.getBoundingClientRect().bottom, notAbove: !(box.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING), headSame: Math.round(h.getBoundingClientRect().top + scrollY) === before }; }, headTop);
    check('the leave question sits right under the button row that asked it, not above the heading, and the heading does not move', lv.after && lv.below && lv.notAbove && lv.headSame, JSON.stringify(lv));
    check('leaving asks first, in one sentence: stay if you already paid, otherwise nothing is lost and the code is kept', await p.isVisible('#leave-confirm') && (await text(p, '#leave-text')) === 'If you already paid with this code, stay; if not, leaving loses nothing and the code is kept.');
    await p.click('#leave-no');
    check('"Keep it" keeps the payment step', (await p.isHidden('#leave-confirm')) && (await p.isVisible('#pay-card')));
    await p.click('#change-amount'); await p.click('#leave-yes');
    await p.waitForSelector('#form-card:not([hidden])');
    check('back to the amount: the form comes back with the amount and the refund address filled in', (await p.inputValue('#amount')) === '0.01' && (await p.inputValue('#refund')) === addr && (await p.isHidden('#pay-card')));
    let st = await p.evaluate((id) => ({ cur: localStorage.getItem(`ll:${id}`), earlier: JSON.parse(localStorage.getItem(`ll:${id}:earlier`) || '[]') }), RAISE.id);
    check('the left code is kept, not deleted, and the page says it may still be a live contribution', st.cur === null && st.earlier.length === 1 && st.earlier[0].memo === first.memo && (await p.isVisible('#earlier')) && /each still counts if you paid it/.test(await text(p, '#earlier')));
    check('the left code can be followed again', await p.isVisible('#earlier button:has-text("Follow it again")'));

    // a code whose payment was seen: the warning is stronger, and starting over still never leaves a silent second contribution
    await p.click('#earlier button:has-text("Follow it again")');
    await p.waitForSelector('#pay-card:not([hidden])');
    check('following it again brings back the very same payment code', (await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:${id}`)).memo, RAISE.id)) === first.memo && (await p.isHidden('#earlier')));
    await p.evaluate((id) => { const s = JSON.parse(localStorage.getItem(`ll:${id}`)); s.txid = 'ab'.repeat(32) + ':0'; s.paidZat = 1000000; localStorage.setItem(`ll:${id}`, JSON.stringify(s)); }, RAISE.id);
    await p.reload();
    await p.waitForSelector('#pay-card:not([hidden])', { timeout: 60000 });
    await p.click('#start-over');
    const strong = await text(p, '#leave-text');
    check('starting over after a payment was seen says a new code would make a second contribution', strong === 'This payment was seen, so paying again with a new code makes a second contribution; download your backup first.', strong.slice(0, 80));
    await p.click('#leave-yes');
    await p.waitForSelector('#form-card:not([hidden])');
    check('start over: the form is empty and the earlier code is listed as "payment seen on the network"', (await p.inputValue('#amount')) === '' && /payment seen on the network/.test(await text(p, '#earlier')));
    await create('0.02');
    check('a new code beside an earlier one: the notice stays on the payment step too', (await p.isVisible('#earlier')) && !(await p.isVisible('#earlier button:has-text("Follow it again")')));
    const second = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:${id}`)), RAISE.id);
    check('the new code is a different payment code', second.memo !== first.memo);
    await p.screenshot({ path: `${SHOTS}/polish-a-earlier.png`, fullPage: true });

    // ---------- 5. the ticket-has-not-arrived notice ----------
    const H = RAISE.deadline - 500;
    const setPaid = (extra) => p.evaluate(([id, h, extra]) => { const s = JSON.parse(localStorage.getItem(`ll:${id}`)); Object.assign(s, { txid: 'cd'.repeat(32) + ':0', paidZat: 2000000, paidHeight: h }, extra); localStorage.setItem(`ll:${id}`, JSON.stringify(s)); }, [RAISE.id, H, extra || {}]);
    const lateShown = async (t) => { tip = t; await p.reload(); await p.waitForSelector('#progress-card:not([hidden])', { timeout: 60000 }); await p.waitForFunction(() => document.querySelector('#status-chip .sbadge'), null, { timeout: 60000 }); await p.waitForTimeout(500); return p.isVisible('#ticket-late'); };
    await setPaid();
    check('late notice: not shown inside the ticket window', !(await lateShown(H + RAISE.k)));
    const shown = await lateShown(H + RAISE.k + 1);
    check('late notice: shown once the window has passed with no ticket', shown);
    const note = await text(p, '#ticket-late');
    check('late notice: the words, and it names the block', /^Your refund ticket has not arrived\. Do not rely on this payment until it does\./.test(note) && note.includes(String(H)), note.slice(0, 160));
    await p.screenshot({ path: `${SHOTS}/polish-a-late.png`, fullPage: true });
    await setPaid({ paidHeight: null });
    check('late notice: not shown when the block of the payment is not known', !(await lateShown(H + 500)));
    await setPaid({ paidZat: 1000 });
    check('late notice: not shown for an underpaid payment (that has its own, different notice)', !(await lateShown(H + 500)));
    await setPaid({ ticket: { nf: 'x', entry: { seq: 0, contribution: { height: H } } }, paidZat: 2000000, paidHeight: H });
    check('late notice: not shown once a ticket is held', !(await lateShown(H + 500)));
    bl = await backLink();
    check('ticket step: the top left link goes to this campaign\'s own page (not the recount)', bl.ok && bl.stage === 'ticket', JSON.stringify(bl));
    const tk = await p.evaluate(() => ({ stage: document.querySelector('#cflow').dataset.stage, about: !!document.querySelector('#about').offsetParent, stand: !!document.querySelector('.stand-k').offsetParent || !!document.querySelector('#s-ticket').offsetParent,
      open: [...document.querySelectorAll('#progress-card details')].filter((d) => d.open).map((d) => d.id || d.querySelector('summary').textContent), n: document.querySelectorAll('#progress-card details').length }));
    check('ticket step: no "About this campaign", no "Where things stand", and every disclosure closed on load', tk.stage === 'ticket' && !tk.about && !tk.stand && tk.open.length === 0 && tk.n >= 4, JSON.stringify(tk));
    await p.context().close();

    // ---------- narrow phone width ----------
    p = await newPage({ viewport: { width: 390, height: 844 } });
    tip = RAISE.deadline - 100;
    await p.goto(link(RAISE));
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
    await p.fill('#amount', '0.01'); await p.fill('#refund', addr); await p.click('#create');
    await p.waitForSelector('#pay-card:not([hidden])'); await p.click('#to-pay');
    check('390 px wide: no sideways scrolling, notice and buttons fit', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('#pay-warning, #leave-box')].every((e) => e.getBoundingClientRect().right <= innerWidth)));
    await p.screenshot({ path: `${SHOTS}/polish-a-390.png`, fullPage: true });
    await p.context().close();

    // ---------- the Theme control: System, Light, Dark ----------
    p = await newPage({ colorScheme: 'dark' });
    tip = RAISE.deadline - 100;
    await p.goto(link(RAISE));
    await p.waitForSelector('footer .theme-seg button', { timeout: 60000 });
    const th = () => p.evaluate(() => ({ theme: document.documentElement.dataset.theme, pressed: [...document.querySelectorAll('footer .theme-seg button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent).join(','), labels: [...document.querySelectorAll('footer .theme-seg button')].map((b) => b.textContent).join(' | '), stored: localStorage.getItem('cb-theme') }));
    let t0 = await th();
    check('theme: the control reads System | Light | Dark, and a first visit shows System and follows the device (dark)', t0.labels === 'System | Light | Dark' && t0.pressed === 'System' && t0.theme === 'dark' && t0.stored === null, JSON.stringify(t0));
    await p.emulateMedia({ colorScheme: 'light' }); await p.waitForTimeout(200); t0 = await th();
    check('theme: with System, the device switching to light switches the page at once', t0.theme === 'light' && t0.pressed === 'System', JSON.stringify(t0));
    await p.click('footer .theme-seg button[data-theme="dark"]'); await p.emulateMedia({ colorScheme: 'light' }); await p.waitForTimeout(200); t0 = await th();
    check('theme: Dark chosen stays dark whatever the device says, and is stored', t0.theme === 'dark' && t0.pressed === 'Dark' && t0.stored === 'dark', JSON.stringify(t0));
    await p.reload(); await p.waitForSelector('footer .theme-seg button', { timeout: 60000 }); t0 = await th();
    check('theme: Dark survives a reload', t0.theme === 'dark' && t0.pressed === 'Dark', JSON.stringify(t0));
    await p.click('footer .theme-seg button[data-theme="light"]'); await p.click('footer .theme-seg button[data-theme="system"]'); await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(200); t0 = await th();
    check('theme: Light then System returns to following the device (now dark)', t0.theme === 'dark' && t0.pressed === 'System' && t0.stored === 'system', JSON.stringify(t0));
    await p.reload(); await p.waitForSelector('footer .theme-seg button', { timeout: 60000 }); await p.emulateMedia({ colorScheme: 'light' }); await p.waitForTimeout(200); t0 = await th();
    check('theme: System survives a reload and keeps following the device (now light)', t0.theme === 'light' && t0.pressed === 'System', JSON.stringify(t0));
    await p.context().close();

    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    srv.kill();
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
