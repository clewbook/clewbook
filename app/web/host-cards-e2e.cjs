// The Host page's cards, in a real browser at 1280 and 390, light and dark: the Blind bid auction card says it is live on mainnet, keeps the NU7
// limit as one line, has a WORKS WITH row and a NEW tag; the NEW tags go by date (host.js, one place): Hard cap until 14 Nov 2026 (one month after
// it shipped on 14 Oct), Blind bid auction until 23 Nov 2026, each through the end of that day (UTC). Text with no hyphens. Serves app/web/www
// itself; every other request is refused, so no network and no money. Env: PORT (default 8966).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.PORT || '8966', BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  ' + extra : ''}`); if (!ok) failed++; };

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', path.join(__dirname, 'www')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const errors = [];
  const open = async (when, w = 1280, theme = 'light') => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: theme });
    await ctx.clock.setFixedTime(new Date(when));
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
    await p.goto(`${BASE}/host.html`);
    await p.waitForSelector('.htc-t');
    const cards = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('article.htc')].map((a) => {
      const tag = a.querySelector('.hbadge.new');
      return [a.querySelector('.htc-t').textContent, {
        isNew: !!tag && !tag.hidden && tag.offsetParent !== null,
        lines: [...a.querySelectorAll('.htc-b li')].map((l) => l.textContent),
        note: a.querySelector('.htc-note')?.textContent || '',
        chipsLabel: a.querySelector('.htc-k')?.textContent || '',
        chips: [...a.querySelectorAll('.hchip')].map((c) => c.textContent),
        inside: (() => { const b = a.getBoundingClientRect(); return [...a.querySelectorAll('.hchip, .hbadge')].every((c) => { const r = c.getBoundingClientRect(); return r.width === 0 || (r.left >= b.left - 0.5 && r.right <= b.right + 0.5); }); })(),
      }];
    })));
    const wide = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    await ctx.close();
    return { cards, wide };
  };
  try {
    for (const [w, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
      const { cards, wide } = await open('2026-10-24T12:00:00Z', w, theme);
      const bb = cards['Blind bid auction'];
      check(`${w} ${theme}: the Blind bid auction card says it is live on mainnet and keeps the NU7 limit as one line`, bb && bb.lines.includes('Live on mainnet now.') && bb.note === 'On mainnet, must end before NU7 for now.' && !bb.lines.some((l) => /only if it ends before/.test(l)), JSON.stringify(bb && { lines: bb.lines, note: bb.note }));
      check(`${w} ${theme}: it has a WORKS WITH row like the other cards`, bb && bb.chipsLabel === 'WORKS WITH' && bb.chips.join('|') === 'Uniform price|Second price|Pay your bid' && bb.inside, JSON.stringify(bb && bb.chips));
      check(`${w} ${theme}: on 24 Oct 2026 the NEW tag shows on Blind bid auction and on Soft cap + hard cap, and on no other card`, Object.entries(cards).filter(([, c]) => c.isNew).map(([t]) => t).sort().join('|') === 'Blind bid auction|Soft cap + hard cap', Object.entries(cards).filter(([, c]) => c.isNew).map(([t]) => t).join('|'));
      check(`${w} ${theme}: no sideways scroll`, wide);
    }
    const at = async (when) => Object.entries((await open(when)).cards).filter(([, c]) => c.isNew).map(([t]) => t).sort().join('|');
    check('14 Nov 2026, 23:59 UTC: both tags still show', (await at('2026-11-14T23:59:00Z')) === 'Blind bid auction|Soft cap + hard cap');
    check('15 Nov 2026: the Soft cap + hard cap tag is gone, the Blind bid auction tag stays', (await at('2026-11-15T00:00:00Z')) === 'Blind bid auction');
    check('23 Nov 2026, 23:59 UTC: the Blind bid auction tag still shows', (await at('2026-11-23T23:59:00Z')) === 'Blind bid auction');
    check('24 Nov 2026: no NEW tag left', (await at('2026-11-24T00:00:00Z')) === '');
    const text = require('fs').readFileSync(path.join(__dirname, 'www/host.html'), 'utf8').replace(/<[^>]*>/g, ' ');
    check('the cards\' text uses no hyphen as a dash', !/[A-Za-z] - [A-Za-z]|—|–/.test(text));
    check('no page error', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
