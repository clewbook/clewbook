// Copy of page fixes round 8 outside the recount and campaign pages. The "How to host" page's auction cards: the "Uniform price" card lists what it
// FITS with "NFT auctions" first, then "Token allocations", "Editions" and "Access slots"; the tags wrap inside the card at 1280 and at 390, in light
// and dark, and no other card gained the tag. The NEW badge's text reaches 4.5 to 1 on its gold in both themes (round 9). The home page's first intro scene says "Pay privately on Zcash." and no page text says "anonymous". The "Ledger anchoring" line (capability card and recount page) matches the fingerprint feature (round 9).
// Serves app/web/www on a spare port; every other request is refused, so no network and no money are involved. Env: PORT (default 8936), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.PORT || '8936', SHOTS = process.env.SHOTS || 'runs/design-shots';
const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', path.join(__dirname, 'www')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const errors = [];
  try {
    for (const [w, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: theme });
      await ctx.clock.setFixedTime(new Date('2026-10-24T12:00:00Z')); // the NEW tags show until their dates (host.js): a day when they show
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
      await p.goto(`${BASE}/host.html`);
      await p.waitForSelector('.htc-t');
      const m = await p.evaluate(() => {
        const card = [...document.querySelectorAll('article.htc')].find((a) => a.querySelector('.htc-t').textContent === 'Uniform price');
        const box = card.getBoundingClientRect(), row = card.querySelector('.htc-chips');
        const chips = [...row.querySelectorAll('.hchip')], r = chips.map((c) => c.getBoundingClientRect());
        const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
        return {
          label: row.querySelector('.htc-k').textContent, tags: chips.map((c) => c.textContent),
          firstAfterLabel: row.children[1] === chips[0],
          inside: r.every((x) => x.left >= box.left - 0.5 && x.right <= box.right + 0.5),
          noOverlap: r.every((a, i) => r.every((b, j) => i === j || apart(a, b))),
          oneLineEach: r.every((x) => x.height < 40),
          nftCount: [...document.querySelectorAll('.hchip')].filter((c) => c.textContent === 'NFT auctions').length,
          wide: document.documentElement.scrollWidth <= innerWidth, theme: document.documentElement.dataset.theme,
        };
      });
      // round 9: the NEW badge's small text against its gold, computed from what the browser draws
      const nb = await p.evaluate(() => {
        const el = document.querySelector('.hbadge.new'), cs = getComputedStyle(el);
        const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
        const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
        const [a, b] = [lum(rgb(cs.color)), lum(rgb(cs.backgroundColor))].sort((x, y) => y - x);
        return { text: el.textContent, fg: cs.color, bg: cs.backgroundColor, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100, size: cs.fontSize };
      });
      check(`${w} ${theme}: the NEW badge keeps its gold and its small text reaches at least 4.5 to 1`, nb.text === 'NEW' && nb.ratio >= 4.5 && nb.bg === (theme === 'light' ? 'rgb(122, 86, 0)' : 'rgb(245, 196, 81)'), JSON.stringify(nb));
      check(`${w} ${theme}: the Uniform price card FITS "NFT auctions" first, then Token allocations, Editions, Access slots; the tags wrap inside the card, apart, each on one line; no other card has the tag; no sideways scroll`,
        m.label === 'FITS' && same(m.tags, ['NFT auctions', 'Token allocations', 'Editions', 'Access slots']) && m.firstAfterLabel && m.inside && m.noOverlap && m.oneLineEach && m.nftCount === 1 && m.wide && m.theme === theme, JSON.stringify(m));
      if (theme === 'light') await p.locator('article.htc', { hasText: 'Uniform price' }).screenshot({ path: `${SHOTS}/host-uniform-${w}.png` }).catch(() => {});
      await ctx.close();
    }
    // the home page's intro, scene 1
    const hc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const h = await hc.newPage(); h.on('pageerror', (e) => errors.push(String(e)));
    await h.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
    await h.goto(`${BASE}/`); await h.waitForSelector('.d');
    const intro = await h.evaluate(() => ({ first: document.querySelector('.d').textContent, anon: /anonymous/i.test(document.documentElement.outerHTML) }));
    check('home intro scene 1 says "Pay privately on Zcash." and nothing on the page says anonymous', intro.first === 'Pay privately on Zcash.' && !intro.anon, JSON.stringify(intro));
    await hc.close();
    // round 9: the "Ledger anchoring" line the capability card and the recount page both show, from the module they both load
    const mc = await browser.newContext(); const m = await mc.newPage();
    await m.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
    await m.goto(`${BASE}/host.html`);
    const nc = await m.evaluate(async () => (await import('/capabilities.js')).NOT_CHECKED.find(([k]) => k === 'Ledger anchoring'));
    check('the "Ledger anchoring" line matches the fingerprint feature: signed once the campaign is closed, entries and the hash of the last one, not anchored on a public ledger', JSON.stringify(nc) === JSON.stringify(['Ledger anchoring', "once the campaign is closed, the host signs the list\'s fingerprint (the number of entries and the hash of the last one), but it is not anchored on any public ledger"]) && !/not yet published/.test(nc[1]), JSON.stringify(nc));
    await mc.close();
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally { await browser.close(); srv.kill(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
