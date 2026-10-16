// The public list on the campaign page as one table: every entry one row, six columns in a fixed order (kind with its short id beneath, result,
// amount, what happened to the money, block, price paid); the newest 5 with "Show older (N)" for the rest; testnet amounts trimmed (no trailing
// zeros); at 390 wide each row is two lines and nothing scrolls sideways. Plain files from app/web/make-static.sh (default runs/static-polish) on a
// spare port; every other request is refused, so no network and no money are involved. Env: DIR, PORT (default 8931), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8931', SHOTS = process.env.SHOTS || 'runs/design-shots';
const BASE = `http://127.0.0.1:${PORT}`;
const AUCTION = 'f8b2bc9f0b9e17666b8b87dd0eeb0b19a17ab8e95d154d63ff1b8d2849980501'; // closed, one price, 6 bids (3 won), 3 settlements
const CAPPED = '0e87fe135cb3dd2486efa0809534718bf62ebd3df733d903008550c4c202aef5'; // closed fundraiser, soft cap met, one payment over the hard cap
const OPEN = '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da'; // a fundraiser with 40 contributions, never closed
const MISSED = '80fc0eb3081ac58d91ac95fec1fe92286c49d000d5bdd24befe5c53153ed025d'; // goal missed, with payments set aside
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const link = (id) => `${BASE}/campaign.html#c=${id}&relay=${BASE}/relays/a&relay=${BASE}/relays/b`;
const rowsOf = (p) => p.$$eval('#entries tr', (trs) => trs.map((tr) => ({
  seq: tr.dataset.seq, shown: !tr.hidden && tr.getClientRects().length > 0,
  cells: [tr.querySelector('.ek').textContent, (tr.querySelector('.ref') || { textContent: '' }).textContent, ...[...tr.querySelectorAll('td')].slice(1).map((td) => td.textContent)],
  classes: [...tr.querySelectorAll('td')].map((td) => td.className.split(' ')[0]),
})));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const errors = [];
  const open = async (id, width, theme = 'light') => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
    await p.goto(link(id));
    await p.waitForSelector('#links:not([hidden])', { timeout: 90000 });
    return p;
  };
  try {
    // ---------- 1. a closed auction: won and lost bids, settlements, the close; 10 entries, so 5 shown ----------
    let p = await open(AUCTION, 1280);
    let rows = await rowsOf(p);
    check('auction: all 10 entries are rows of one table, newest first (the order of the list kept)', rows.length === 10 && same(rows.map((r) => r.seq), ['9', '8', '7', '6', '5', '4', '3', '2', '1', '0']), rows.map((r) => r.seq).join(','));
    check('auction: every row has the six cells in order: kind and id, result, amount, what happened, block, price paid', rows.every((r) => same(r.classes, ['k', 'res', 'am', 'what', 'blk', 'pr'])));
    const won = rows.find((r) => r.seq === '1'), lost = rows.find((r) => r.seq === '5');
    check('a won bid: Bid, its short id beneath, Won, no amount in the data (a dash), 0.002 TAZ sent back, its block, the price 0.0029 TAZ', same(won.cells, ['Bid', 'd3d2dbea…0fa27', 'Won', '—', '0.002 TAZ sent back', '4,498,797', '0.0029 TAZ']), JSON.stringify(won.cells));
    check('a lost bid: Bid, its short id beneath, Lost, a dash, Refunded by ticket, its block, a dash for the price', same(lost.cells, ['Bid', '1837c09a…f9685', 'Lost', '—', 'Refunded by ticket', '4,498,813', '—']), JSON.stringify(lost.cells));
    check('the lowest winning bid: Won, Nothing sent back, the price', same(rows.find((r) => r.seq === '3').cells, ['Bid', '0ada1546…43350', 'Won', '—', 'Nothing sent back', '4,498,806', '0.0029 TAZ']), JSON.stringify(rows.find((r) => r.seq === '3').cells));
    check('a settlement: Settlement, its id, Settled, what came back, no block in the data (a dash), the price', same(rows[1].cells, ['Settlement', 'c307f8f2…289b9', 'Settled', '—', '0.0015 TAZ sent back', '—', '0.0029 TAZ']), JSON.stringify(rows[1].cells));
    check('the close: Closed, Auction settled, the close block, the clearing price', same(rows[3].cells, ['Closed', '', 'Auction settled', '—', '—', '4,498,865', '0.0029 TAZ']), JSON.stringify(rows[3].cells));
    const geo = await p.$$eval('#entries tr:not([hidden])', (trs) => trs.map((tr) => {
      const k = tr.querySelector('.ek').getBoundingClientRect(), ref = tr.querySelector('.ref');
      return { lefts: [...tr.querySelectorAll('td')].map((td) => Math.round(td.getBoundingClientRect().left)), idBelow: ref ? ref.getBoundingClientRect().top >= k.bottom - 1 : true };
    }));
    check('at 1280 the columns run left to right in that order and line up from row to row; the id sits beneath the kind', geo.every((g) => g.lefts.every((x, i) => i === 0 || x > g.lefts[i - 1])) && geo.every((g) => same(g.lefts, geo[0].lefts)) && geo.every((g) => g.idBelow), JSON.stringify(geo[0]));
    check('screen readers get six column headers, the table keeps its roles', same(await p.$$eval('.entries thead th', (t) => t.map((x) => x.textContent)), ['Entry and short id', 'Result', 'Amount', 'What happened to the money', 'Block', 'Price paid']) && (await p.getAttribute('.entries', 'role')) === 'table' && (await p.$$eval('#entries td[role=cell]', (t) => t.length)) === 60);
    check('the column headers are not shown', await p.$eval('.entries thead', (t) => { const r = t.getBoundingClientRect(); return r.right < 0 || r.bottom < 0; }));
    // ---------- 2. Show older ----------
    const btn = async () => ({ shown: await p.isVisible('#entries-more'), text: (await p.textContent('#entries-more')).trim(), exp: await p.getAttribute('#entries-more', 'aria-expanded'), hint: (await p.textContent('#entries-hint')).trim(), rows: (await rowsOf(p)).filter((r) => r.shown).map((r) => r.seq).join(',') });
    let b = await btn();
    check('more than 5 entries: the newest 5 are shown and "Show older (5)" is under the list', b.shown && b.text === 'Show older (5)' && b.exp === 'false' && b.rows === '9,8,7,6,5' && b.hint === 'AS PUBLISHED · 5 OF 10', JSON.stringify(b));
    check('  ... the button sits under the list', await p.evaluate(() => document.querySelector('#entries-more').getBoundingClientRect().top >= document.querySelector('.entries').getBoundingClientRect().bottom - 1));
    await p.click('#entries-more'); b = await btn();
    check('"Show older" reveals the rest, in the same order, and becomes "Show fewer"', b.text === 'Show fewer' && b.exp === 'true' && b.rows === '9,8,7,6,5,4,3,2,1,0' && b.hint === 'AS PUBLISHED', JSON.stringify(b));
    await p.click('#entries-more'); b = await btn();
    check('"Show fewer" goes back to the newest 5', b.text === 'Show older (5)' && b.rows === '9,8,7,6,5', JSON.stringify(b));
    // ---------- 3. trimmed testnet amounts ----------
    const rule = async (label) => p.$eval('#facts', (dl, l) => { const dt = [...dl.querySelectorAll('dt')].find((d) => d.textContent === l); return dt ? dt.nextElementSibling.textContent : null; }, label);
    check('rules table: Smallest bid 0.0002 TAZ, Refund fee 0.0001 TAZ, Reserve 0.001 TAZ (trimmed, never rounded)', (await rule('Smallest bid')) === '0.0002 TAZ' && (await rule('Refund fee')) === '0.0001 TAZ' && (await rule('Reserve')) === '0.001 TAZ', [await rule('Smallest bid'), await rule('Refund fee'), await rule('Reserve')].join(' | '));
    const zeros = (pg) => pg.evaluate(() => ({ text: (document.querySelector('main').innerText.match(/\d\.\d*0 (TAZ|ZEC)\b/g) || []), dim: document.querySelectorAll('.amt .z, .amt .g').length }));
    let z = await zeros(p);
    check('auction page: no amount with trailing zeros, and no dimmed digits', z.text.length === 0 && z.dim === 0, JSON.stringify(z));
    await p.context().close();

    // ---------- 4. fundraisers ----------
    p = await open(CAPPED, 1280);
    rows = await rowsOf(p);
    check('capped fundraiser, 4 entries: no "Show older", every row shown', !(await p.isVisible('#entries-more')) && rows.length === 4 && rows.every((r) => r.shown) && (await p.textContent('#entries-hint')).trim() === 'AS PUBLISHED');
    check('a counted contribution: Contribution, its id beneath, Counted, 0.0015 TAZ, Kept by the campaign, its block, a dash', same(rows[2].cells, ['Contribution', 'f82faee7…03c47', 'Counted', '0.0015 TAZ', 'Kept by the campaign', '4,500,977', '—']), JSON.stringify(rows[2].cells));
    check('the payment over the hard cap: Over the cap, Refunded by ticket', same(rows[1].cells, ['Contribution', 'abeb3fa3…08a23', 'Over the cap', '0.0015 TAZ', 'Refunded by ticket', '4,500,980', '—']), JSON.stringify(rows[1].cells));
    check('its close: Closed, Soft cap met, the close block', same(rows[0].cells, ['Closed', '', 'Soft cap met', '—', '—', '4,501,065', '—']), JSON.stringify(rows[0].cells));
    z = await zeros(p);
    check('capped fundraiser page: no amount with trailing zeros, and no dimmed digits', z.text.length === 0 && z.dim === 0, JSON.stringify(z));
    await p.context().close();
    p = await open(MISSED, 1280);
    rows = await rowsOf(p);
    await p.click('#entries-more');
    rows = await rowsOf(p);
    const refunded = rows.find((r) => r.cells[0] === 'Contribution'), aside = rows.find((r) => r.cells[0] === 'Set aside');
    check('goal missed: a contribution reads Refunded, Refunded by ticket', refunded && refunded.cells[2] === 'Refunded' && refunded.cells[4] === 'Refunded by ticket' && /^0\.\d*[1-9] TAZ$/.test(refunded.cells[3]), refunded && JSON.stringify(refunded.cells));
    check('a payment set aside: Set aside, its id, Not counted, its amount, the rest dashes but the block', aside && aside.cells[2] === 'Not counted' && /^0\.\d*[1-9] TAZ$/.test(aside.cells[3]) && aside.cells[4] === '—' && /^[\d,]+$/.test(aside.cells[5]) && aside.cells[6] === '—', aside && JSON.stringify(aside.cells));
    await p.context().close();
    p = await open(OPEN, 1280);
    rows = await rowsOf(p);
    check('an open fundraiser with 40 entries: 5 shown, "Show older (35)", a contribution reads Received, Ticket issued', rows.length === 40 && rows.filter((r) => r.shown).length === 5 && (await p.textContent('#entries-more')).trim() === 'Show older (35)' && rows[0].cells[2] === 'Received' && rows[0].cells[4] === 'Ticket issued', JSON.stringify(rows[0].cells));
    await p.context().close();

    // ---------- 5. phone width: two lines a row, no sideways scroll; light and dark ----------
    for (const theme of ['light', 'dark']) {
      for (const id of [AUCTION, CAPPED, OPEN]) {
        p = await open(id, 390, theme);
        await p.click('#entries-more').catch(() => {}); // the longest list there is
        const m = await p.evaluate(() => {
          const lines = [...document.querySelectorAll('#entries tr')].filter((tr) => !tr.hidden).map((tr) => {
            const top = (el) => (el && el.getClientRects().length ? Math.round(el.getBoundingClientRect().top) : null);
            const one = [top(tr.querySelector('.ek')), top(tr.querySelector('.res')), top(tr.querySelector('.am:not(.none)') || tr.querySelector('.pr:not(.none)'))].filter((x) => x != null);
            const two = [top(tr.querySelector('.ref')), top(tr.querySelector('.blk')), top(tr.querySelector('.what'))].filter((x) => x != null);
            return { one: Math.max(...one) - Math.min(...one) <= 3, two: two.every((t) => t > Math.max(...one)), right: Math.max(...[...tr.querySelectorAll('td, .ek, .ref')].map((e) => e.getBoundingClientRect().right)) };
          });
          return { wide: document.documentElement.scrollWidth <= window.innerWidth, lines, vw: window.innerWidth, theme: document.documentElement.dataset.theme };
        });
        check(`390 ${theme} ${id.slice(0, 8)}: no sideways scroll; each row is two lines (kind, result, amounts / id, block, what happened) inside the page`, m.wide && m.theme === theme && m.lines.length > 0 && m.lines.every((l) => l.one && l.two && l.right <= m.vw - 15), JSON.stringify({ wide: m.wide, theme: m.theme, bad: m.lines.filter((l) => !(l.one && l.two && l.right <= m.vw - 15)).slice(0, 2) }));
        if (theme === 'light' && id === AUCTION) await p.screenshot({ path: `${SHOTS}/list-table-390.png`, fullPage: true });
        await p.context().close();
      }
    }
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally { await browser.close(); srv.kill(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
