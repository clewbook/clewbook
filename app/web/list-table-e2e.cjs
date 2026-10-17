// The public list on the campaign page as one table: every entry one row, columns in a fixed order (kind with its short id beneath, result,
// amount (fundraisers only), what happened to the money, block, price paid), the close as one summary line on a band; the newest 5 with
// "Show older (N)" for the rest; testnet amounts trimmed (no trailing zeros); "what happened" on one line at 1280 and 1440; at 390 wide each row
// is two lines and nothing scrolls sideways. Plain files from app/web/make-static.sh (default runs/static-polish) on a
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
  cells: tr.classList.contains('sum') ? [tr.textContent] : [tr.querySelector('.ek').textContent, (tr.querySelector('.ref') || { textContent: '' }).textContent, ...[...tr.querySelectorAll('td')].slice(1).map((td) => td.textContent)],
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
    check('auction: every entry row has five cells in order: kind and id, result, what happened, block, price paid (no amount column); the close is one summary cell', rows.every((r) => (r.seq === '6' ? same(r.classes, ['sum']) : same(r.classes, ['k', 'res', 'what', 'blk', 'pr']))));
    const won = rows.find((r) => r.seq === '1'), lost = rows.find((r) => r.seq === '5');
    check('a won bid: Bid, its short id beneath, Won, 0.002 TAZ sent back, its block, the price 0.0029 TAZ', same(won.cells, ['Bid', 'd3d2dbea…0fa27', 'Won', '0.002 TAZ sent back', '4,498,797', '0.0029 TAZ']), JSON.stringify(won.cells));
    check('a lost bid: Bid, its short id beneath, Lost, Refunded by ticket, its block, an en dash for the price (round 12: the wording rules allow no em dash)', same(lost.cells, ['Bid', '1837c09a…f9685', 'Lost', 'Refunded by ticket', '4,498,813', '–']), JSON.stringify(lost.cells));
    check('the lowest winning bid: Won, Nothing sent back, the price', same(rows.find((r) => r.seq === '3').cells, ['Bid', '0ada1546…43350', 'Won', 'Nothing sent back', '4,498,806', '0.0029 TAZ']), JSON.stringify(rows.find((r) => r.seq === '3').cells));
    check('a settlement: Settlement, its id, Settled, what came back, no block in the data (a dash), the price', same(rows[1].cells, ['Settlement', 'c307f8f2…289b9', 'Settled', '0.0015 TAZ sent back', '–', '0.0029 TAZ']), JSON.stringify(rows[1].cells));
    check('the close of a one-price auction: one line, "Auction settled at block 4,498,865 for 0.0029 TAZ"', same(rows[3].cells, ['Auction settled at block 4,498,865 for 0.0029 TAZ']), JSON.stringify(rows[3].cells));
    const band = await p.evaluate(() => {
      const tr = document.querySelector('#entries tr.sum'), td = tr.querySelector('td'), cs = getComputedStyle(td), t = document.querySelector('.entries').getBoundingClientRect(), r = td.getBoundingClientRect();
      return { cells: tr.children.length, span: td.colSpan, full: Math.abs(r.left - t.left) < 1 && Math.abs(r.right - t.right) < 1, weight: cs.fontWeight, style: cs.fontStyle, family: cs.fontFamily.split(',')[0].replace(/"/g, ''), band: cs.backgroundColor !== getComputedStyle(document.body).backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)', dash: /—/.test(td.textContent), amtWeight: getComputedStyle(td.querySelector('.amt')).fontWeight };
    });
    check('  ... one cell across the full width, Chivo Mono 600 (not italic), on a band of its own, no dashes', band.cells === 1 && band.span === 5 && band.full && band.weight === '600' && band.amtWeight === '600' && band.style === 'normal' && band.family === 'Chivo Mono' && band.band && !band.dash, JSON.stringify(band));
    const geo = await p.$$eval('#entries tr:not([hidden]):not(.sum)', (trs) => trs.map((tr) => {
      const k = tr.querySelector('.ek').getBoundingClientRect(), ref = tr.querySelector('.ref');
      return { lefts: [...tr.querySelectorAll('td')].map((td) => Math.round(td.getBoundingClientRect().left)), idBelow: ref ? ref.getBoundingClientRect().top >= k.bottom - 1 : true };
    }));
    check('at 1280 the columns run left to right in that order and line up from row to row; the id sits beneath the kind', geo.every((g) => g.lefts.every((x, i) => i === 0 || x > g.lefts[i - 1])) && geo.every((g) => same(g.lefts, geo[0].lefts)) && geo.every((g) => g.idBelow), JSON.stringify(geo[0]));
    check('five column headers on an auction (no Amount), short on screen and full for screen readers, the table keeps its roles', same(await p.$$eval('.entries thead th', (t) => t.map((x) => x.textContent)), ['Entry', 'Result', 'What happened', 'Block', 'Price paid']) && same(await p.$$eval('.entries thead th', (t) => t.map((x) => x.getAttribute('aria-label') || x.textContent)), ['Entry and short id', 'Result', 'What happened to the money', 'Block', 'Price paid']) && (await p.getAttribute('.entries', 'role')) === 'table' && (await p.$$eval('#entries td[role=cell]', (t) => t.length)) === 46);
    // round 8: at 1280 one quiet header row names the columns, so a bare number reads as a block; each label sits over its own column
    const hd = await p.evaluate(() => {
      const ths = [...document.querySelectorAll('.entries thead th')], tr = document.querySelector('#entries tr:not(.sum):not([hidden])'), tds = [...tr.querySelectorAll('td')];
      const cs = getComputedStyle(ths[0]), cell = getComputedStyle(tds[0]);
      return { shown: ths.every((t) => { const r = t.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.top >= 0; }), above: ths.every((t) => t.getBoundingClientRect().bottom <= tr.getBoundingClientRect().top + 1),
        lined: ths.every((t, i) => Math.abs(t.getBoundingClientRect().left - tds[i].getBoundingClientRect().left) <= 1), blockOverBlock: ths[3].textContent === 'Block' && tds[3].className.startsWith('blk'),
        size: parseFloat(cs.fontSize), cellSize: parseFloat(cell.fontSize), quiet: cs.color !== cell.color, upper: cs.textTransform === 'uppercase', oneRow: new Set(ths.map((t) => Math.round(t.getBoundingClientRect().bottom))).size === 1 };
    });
    check('1280: the column headers are shown in one quiet row above the entries (smaller and lighter than the cells, upper case, bottoms in line), each over its own column, "Block" over the block numbers', hd.shown && hd.above && hd.lined && hd.blockOverBlock && hd.size < hd.cellSize && hd.quiet && hd.upper && hd.oneRow, JSON.stringify(hd));
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
    check('a counted contribution: Contribution, its id beneath, Counted, 0.0015 TAZ, Kept by the campaign, its block, a dash', same(rows[2].cells, ['Contribution', 'f82faee7…03c47', 'Counted', '0.0015 TAZ', 'Kept by the campaign', '4,500,977', '–']), JSON.stringify(rows[2].cells));
    check('the payment over the hard cap: Over the cap, Refunded by ticket', same(rows[1].cells, ['Contribution', 'abeb3fa3…08a23', 'Over the cap', '0.0015 TAZ', 'Refunded by ticket', '4,500,980', '–']), JSON.stringify(rows[1].cells));
    check('its close: one line, "Closed at block 4,501,065: soft cap met", across all six columns', same(rows[0].cells, ['Closed at block 4,501,065: soft cap met']) && (await p.$eval('#entries tr.sum td', (d) => d.colSpan)) === 6, JSON.stringify(rows[0].cells));
    check('a fundraiser keeps the amount column: six headers, six cells a row', same(await p.$$eval('.entries thead th', (t) => t.map((x) => x.textContent)), ['Entry', 'Result', 'Amount', 'What happened', 'Block', 'Price paid']) && rows.slice(1).every((r) => same(r.classes, ['k', 'res', 'am', 'what', 'blk', 'pr'])));
    z = await zeros(p);
    check('capped fundraiser page: no amount with trailing zeros, and no dimmed digits', z.text.length === 0 && z.dim === 0, JSON.stringify(z));
    await p.context().close();
    p = await open(MISSED, 1280);
    rows = await rowsOf(p);
    await p.click('#entries-more');
    rows = await rowsOf(p);
    const refunded = rows.find((r) => r.cells[0] === 'Contribution'), aside = rows.find((r) => r.cells[0] === 'Set aside');
    check('goal missed: the close reads "Closed at block 4,499,121: goal missed"', same(rows[0].cells, ['Closed at block 4,499,121: goal missed']), JSON.stringify(rows[0].cells));
    check('goal missed: a contribution reads Refunded, Refunded by ticket', refunded && refunded.cells[2] === 'Refunded' && refunded.cells[4] === 'Refunded by ticket' && /^0\.\d*[1-9] TAZ$/.test(refunded.cells[3]), refunded && JSON.stringify(refunded.cells));
    check('a payment set aside: Set aside, its id, Not counted, its amount, the rest dashes but the block', aside && aside.cells[2] === 'Not counted' && /^0\.\d*[1-9] TAZ$/.test(aside.cells[3]) && aside.cells[4] === '–' && /^[\d,]+$/.test(aside.cells[5]) && aside.cells[6] === '–', aside && JSON.stringify(aside.cells));
    await p.context().close();
    p = await open(OPEN, 1280);
    rows = await rowsOf(p);
    check('an open fundraiser with 40 entries: 5 shown, "Show older (35)", a contribution reads Received, Ticket issued', rows.length === 40 && rows.filter((r) => r.shown).length === 5 && (await p.textContent('#entries-more')).trim() === 'Show older (35)' && rows[0].cells[2] === 'Received' && rows[0].cells[4] === 'Ticket issued', JSON.stringify(rows[0].cells));
    await p.context().close();

    // ---------- 5. "what happened" on one line at 1280 and 1440, nothing past the list's column ----------
    for (const w of [1280, 1440]) {
      for (const id of [AUCTION, CAPPED, MISSED, OPEN]) {
        p = await open(id, w);
        await p.click('#entries-more').catch(() => {});
        const m = await p.evaluate(() => {
          const col = document.querySelector('.cmain').getBoundingClientRect(), t = document.querySelector('.entries').getBoundingClientRect();
          const range = document.createRange(); const lines = [...document.querySelectorAll('#entries tr:not(.sum) td.what')].filter((td) => { range.selectNodeContents(td); const tops = [...range.getClientRects()].map((r) => r.top); return Math.max(...tops) - Math.min(...tops) > parseFloat(getComputedStyle(td).lineHeight) / 2; }).map((td) => td.textContent);
          return { inside: t.right <= col.right + 0.5, wide: document.documentElement.scrollWidth <= innerWidth, lines, tableW: Math.round(t.width), colW: Math.round(col.width) };
        });
        check(`${w} ${id.slice(0, 8)}: "what happened" stays on one line in every row, the table fits its column, no sideways scroll`, m.inside && m.wide && m.lines.length === 0, JSON.stringify(m));
        await p.context().close();
      }
    }

    // ---------- 6. phone width (round 12, handoff 3.7): the table keeps its columns and header row and scrolls sideways inside its own box (at least
    // 600 px wide); the page itself never scrolls sideways; each entry stays one row; the close band spans the table; light and dark ----------
    for (const theme of ['light', 'dark']) {
      for (const id of [AUCTION, CAPPED, OPEN]) {
        p = await open(id, 390, theme);
        await p.click('#entries-more').catch(() => {}); // the longest list there is
        const m = await p.evaluate(() => {
          const t = document.querySelector('.entries'), box = t.parentElement, head = t.querySelector('thead').getBoundingClientRect();
          const sums = [...document.querySelectorAll('#entries tr.sum')].map((tr) => Math.abs(tr.querySelector('td').getBoundingClientRect().width - t.getBoundingClientRect().width) < 1);
          const rows = [...document.querySelectorAll('#entries tr:not(.sum)')].filter((tr) => !tr.hidden).map((tr) => { const tops = [...tr.querySelectorAll('td')].map((td) => Math.round(td.getBoundingClientRect().top)); return Math.max(...tops) - Math.min(...tops) <= 1; });
          return { wide: document.documentElement.scrollWidth <= window.innerWidth, scrolls: getComputedStyle(box).overflowX === 'auto' && box.scrollWidth > box.clientWidth, tableW: Math.round(t.getBoundingClientRect().width), headShown: head.height > 0 && head.top < t.querySelector('tbody').getBoundingClientRect().top,
            rows: rows.length, oneRow: rows.every(Boolean), sums, theme: document.documentElement.dataset.theme };
        });
        check(`390 ${theme} ${id.slice(0, 8)}: no sideways page scroll; the table (at least 600 px) scrolls inside its box with its header row; each entry one row; the close band spans the table`, m.wide && m.scrolls && m.tableW >= 600 && m.headShown && m.rows > 0 && m.oneRow && m.sums.every(Boolean) && m.theme === theme, JSON.stringify(m));
        if (theme === 'light' && id === AUCTION) await p.screenshot({ path: `${SHOTS}/list-table-390.png`, fullPage: true });
        await p.context().close();
      }
    }
    // round 12: the header row is shown on a phone too (the handoff keeps the table's columns), so a block number stays a bare number under BLOCK
    for (const theme of ['light', 'dark']) {
      p = await open(AUCTION, 390, theme);
      await p.click('#entries-more').catch(() => {});
      const ph = await p.evaluate(() => {
        const cells = [...document.querySelectorAll('#entries tr:not(.sum):not([hidden]) td.blk')], ths = [...document.querySelectorAll('.entries thead th')];
        const lab = (td) => getComputedStyle(td, '::before').content;
        const withN = cells.filter((td) => /^[0-9,]+$/.test(td.textContent)), dash = cells.filter((td) => !/^[0-9,]+$/.test(td.textContent));
        const bh = ths.find((th) => th.textContent === 'Block').getBoundingClientRect(), c0 = withN[0].getBoundingClientRect();
        return { n: withN.length, bare: cells.every((td) => lab(td) === 'none' || lab(td) === 'normal'), dashes: dash.length, text: withN[0].textContent, under: Math.abs(bh.left - c0.left) < 2, wide: document.documentElement.scrollWidth <= innerWidth };
      });
      check(`390 ${theme}: the BLOCK header sits over the block numbers; each block number is the bare number and a dash stays a dash`, ph.n > 0 && ph.bare && ph.dashes > 0 && /^4,49\d,\d{3}$/.test(ph.text) && ph.under && ph.wide, JSON.stringify(ph));
      await p.context().close();
    }
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally { await browser.close(); srv.kill(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
