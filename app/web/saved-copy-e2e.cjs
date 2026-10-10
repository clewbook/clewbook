// The recount page when no relay can give the list: it names the addresses it tried and lets the person load a saved copy (the host's export). The file
// is checked as a relay's copy is (rules match the campaign number, signatures, chain, no gaps); the result says it comes from a file. Tampered files are
// refused. Plain files (default runs/static-polish) on a spare port, the public test-network servers for the chain checks.
// Env: GOOD (an export of the campaign ID, made by the host program), ID, DIR, PORT (default 8807), SHOTS; EXTRA (optional: another export, of another
// campaign, whose id is in EXTRA_ID, loaded with the same checks).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8807', SHOTS = process.env.SHOTS || 'runs/design-shots';
const ID = process.env.ID, GOOD = process.env.GOOD;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, DEAD = 'http://127.0.0.1:9';
const good = JSON.parse(fs.readFileSync(GOOD, 'utf8'));
const tmp = `${process.env.TMP_DIR || 'runs/saved-copy-test'}`; fs.mkdirSync(tmp, { recursive: true });
const write = (name, obj) => { const f = `${tmp}/${name}.json`; fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const clone = () => JSON.parse(JSON.stringify(good));
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  const open = async (relays = [DEAD]) => {
    const p = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${BASE}/recount.html#c=${ID}${relays.map((r) => `&relay=${r}`).join('')}`);
    return p;
  };
  const settle = (p) => p.waitForFunction(() => { const k = document.querySelector('#verdict').dataset.kind; return k && k !== 'working'; }, null, { timeout: 600000 });
  const t = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
  try {
    // 1. nothing answers, no file
    let p = await open([DEAD, 'http://127.0.0.1:8']);
    await settle(p);
    check('no relay answers: the verdict is "cannot conclude", never a pass', (await p.getAttribute('#verdict', 'data-kind')) === 'cannot' && (await p.locator('#n-pass').isHidden() || (await t(p, '#n-pass')) === '0'));
    const tried = await t(p, '#saved-tried');
    check('it names every relay address it tried, with the reason', await p.isVisible('#saved-card') && tried.includes(DEAD) && tried.includes('http://127.0.0.1:8') && /Failed to fetch|could not be reached/.test(tried), tried.slice(0, 200));
    check('and offers to load a saved copy', await p.isVisible('#saved-file'));
    await p.screenshot({ path: `${SHOTS}/saved-copy-offer.png`, fullPage: true });
    // 2. the good file
    await p.setInputFiles('#saved-file', GOOD);
    await settle(p); await p.waitForFunction(() => /saved copy/i.test(document.querySelector('#verdict-title').textContent), null, { timeout: 600000 });
    const title = await t(p, '#verdict-title'), banners = await t(p, '#banners');
    check('the host\'s export gives "All checks pass for the saved copy (limited check)", every check passing', (await p.getAttribute('#verdict', 'data-kind')) === 'partial' && /All checks pass for the saved copy/.test(title) && Number(await t(p, '#n-fail')) === 0 && Number(await t(p, '#n-pass')) >= 8, `${title} pass=${await t(p, '#n-pass')}`);
    check('the page says plainly that the result comes from a file, not from a relay', /comes from a saved copy of the list that you loaded, not from a relay/.test(banners) && /not from a relay/.test(await t(p, '#verdict-text')) && await p.isVisible('#saved-using'), banners.slice(0, 160));
    check('"Not checked" names the missing agreement with relays', /came from a saved file/.test(await t(p, '#notchecked-line')));
    await p.screenshot({ path: `${SHOTS}/saved-copy-result.png`, fullPage: true });
    // 3. back to the relays
    await p.click('#saved-clear'); await settle(p);
    await p.waitForFunction(() => !/saved copy/i.test(document.querySelector('#verdict-title').textContent), null, { timeout: 60000 });
    check('"Ask the relays again" leaves the saved copy', (await p.getAttribute('#verdict', 'data-kind')) === 'cannot' && await p.isHidden('#saved-using'));
    // 4. files that must be refused
    const entries = good.ledger;
    const cases = [];
    { const d = clone(); d.ledger[0].seq = d.ledger[0].seq; const e = d.ledger.find((x) => x.ticket); if (e) { e.ticket.issue_height += 1; cases.push(['an entry changed after it was signed (ticket height + 1)', d]); } else { const c = d.ledger[0]; c.rules_id = '0'.repeat(64); cases.push(['an entry changed after it was signed (campaign number)', d]); } }
    { const d = clone(); const e = d.ledger.find((x) => x.sig); const s = e.sig; e.sig = (s[0] === '0' ? '1' : '0') + s.slice(1); cases.push(['a signature with one character changed', d]); }
    if (entries.length > 1) { const d = clone(); d.ledger.splice(0, 1); cases.push(['the first entry removed (a gap and a broken chain)', d]); }
    if (entries.length > 1) { const d = clone(); d.ledger.reverse(); cases.push(['entries in the wrong order', d]); }
    { const d = clone(); d.ledger = [...d.ledger, d.ledger[d.ledger.length - 1]]; cases.push(['an entry repeated', d]); }
    { const d = clone(); d.rules.deadline_height += 1; cases.push(['the rules changed (deadline + 1): they no longer match the campaign number', d]); }
    { const d = clone(); d.campaign = '1'.repeat(64); cases.push(['a copy that says it is for another campaign', d]); }
    cases.push(['a file that is not JSON', 'this is not a ledger']);
    cases.push(['JSON that is not an export', '{"hello": 1}']);
    for (const [label, body] of cases) {
      p = await open();
      await p.setInputFiles('#saved-file', write('bad', body));
      await p.waitForFunction(() => /saved copy/i.test(document.querySelector('#verdict-title').textContent) || document.querySelector('#verdict-text').textContent.includes('saved copy') || document.querySelector('#verdict-title').textContent.includes('Cannot'), null, { timeout: 120000 });
      await p.waitForTimeout(1500);
      const kind = await p.getAttribute('#verdict', 'data-kind'), vt = await t(p, '#verdict-text'), vh = await t(p, '#verdict-title');
      check(`refused, and no pass: ${label}`, kind === 'cannot' && !/All checks pass/.test(vh) && (await p.locator('#rules .chk.pass').count()) === 0 && /saved copy|not a saved copy|does not check out/.test(vh + ' ' + vt), `${kind} | ${vh} | ${vt.slice(0, 150)}`);
      await p.context().close();
    }
    // 5. a second export (from another campaign), when given
    if (process.env.EXTRA && process.env.EXTRA_ID) {
      p = await (await browser.newContext()).newPage();
      await p.goto(`${BASE}/recount.html#c=${process.env.EXTRA_ID}&relay=${DEAD}`);
      await p.setInputFiles('#saved-file', process.env.EXTRA);
      await p.waitForFunction(() => /saved copy/i.test(document.querySelector('#verdict-title').textContent), null, { timeout: 600000 });
      check('an export made by the host program for a second campaign also recounts', Number(await t(p, '#n-fail')) === 0 && Number(await t(p, '#n-pass')) >= 8, await t(p, '#verdict-title'));
      await p.context().close();
    }
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  } finally { srv.kill(); await browser.close(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
