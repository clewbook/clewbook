// The final fingerprint on the recount page: the host's closed campaign, its saved copy and its signed record. Files made by final-copy.sh from a real closed
// testnet campaign: GOOD (the host's export, with the record), CUT (the last entry removed, record kept), CUT_NOREC (the last entry removed AND the record
// removed), FORK (a different close entry signed with the campaign's own key, record kept). Also reading from a relay that holds the list and the record.
// Env: ID, GOOD, CUT, CUT_NOREC, FORK, RELAY (optional), DIR (built static folder), PORT (8812), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8812', SHOTS = process.env.SHOTS || 'runs/design-shots';
const { ID, GOOD, CUT, CUT_NOREC, FORK, RELAY } = process.env;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, DEAD = 'http://127.0.0.1:9';
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  const t = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
  const load = async (file, relay = DEAD) => {
    const p = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${BASE}/recount.html#c=${ID}&relay=${relay}`);
    await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 120000 });
    if (file) {
      await p.setInputFiles('#saved-file', file);
      await p.waitForFunction(() => /saved copy|fingerprint/i.test(document.querySelector('#verdict-title').textContent), null, { timeout: 900000 });
    }
    await p.waitForFunction(() => !document.querySelector('#fp-card').hidden, null, { timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(800);
    return p;
  };
  const good = JSON.parse(fs.readFileSync(GOOD, 'utf8'));
  const rec = good.final;
  try {
    check('the host\'s saved copy carries a signed final record', !!rec && !!rec.sig && rec.entries === good.ledger.length, rec && `${rec.entries} entries`);
    let p = await load(GOOD);
    const line = await t(p, '#fp-line');
    check('the page shows the list\'s own fingerprint: the number of entries and the hash of the last one', new RegExp(`^${good.ledger.length} entries, last entry [0-9a-f]{64}$`).test(line), line);
    check('the full copy matches the host\'s record, in plain words', /exactly the one the host fixed/.test(await t(p, '#fp-status')) && (await p.getAttribute('#fp-status', 'class')).includes('good'), await t(p, '#fp-status'));
    check('  ... and the verdict is still the limited pass', /All checks pass for the saved copy/.test(await t(p, '#verdict-title')));
    check('the page says what the fingerprint can and cannot show', /It can show/.test(await t(p, '#fp-card')) && /It cannot show/.test(await t(p, '#fp-card')) && /not be the one others saw|others saw/.test(await t(p, '#fp-card')));
    await p.fill('#fp-given', line);
    check('a fingerprint line you were given that is the same: "matches"', /matches this list exactly/.test(await t(p, '#fp-given-status')));
    await p.fill('#fp-given', line.replace(/^\d+/, (n) => String(Number(n) + 1)));
    check('one that differs (another number of entries): "does NOT match"', /does NOT match/.test(await t(p, '#fp-given-status')));
    await p.screenshot({ path: `${SHOTS}/final-fp-match.png`, fullPage: true });
    await p.context().close();

    p = await load(CUT);
    const cut = await t(p, '#fp-status');
    check('a copy with the end cut off (record kept): the page says the end of the list is missing', (await p.getAttribute('#fp-status', 'class')).includes('bad') && new RegExp(`has ${good.ledger.length - 1} entries but the host fixed ${good.ledger.length}`).test(cut), cut);
    check('  ... and the verdict is a failure, not a pass', (await p.getAttribute('#verdict', 'data-kind')) === 'fail' && /does not match the host.s final fingerprint/.test(await t(p, '#verdict-title')), await t(p, '#verdict-title'));
    await p.screenshot({ path: `${SHOTS}/final-fp-cut.png`, fullPage: true });
    await p.context().close();

    p = await load(CUT_NOREC);
    check('the same cut copy with the record also removed: the checks pass as before and the page says no fingerprint was available (this is what a fingerprint cannot do alone)', (await t(p, '#fp-status')) === 'No fingerprint published for this list.' && (await p.getAttribute('#verdict', 'data-kind')) === 'partial', await t(p, '#fp-status'));
    await p.context().close();

    p = await load(FORK);
    const fork = await t(p, '#fp-status');
    check('a different history signed with the same key (record kept): "NOT the one the host fixed"', (await p.getAttribute('#fp-status', 'class')).includes('bad') && /NOT the one the host fixed/.test(fork), fork);
    check('  ... and the verdict is a failure', (await p.getAttribute('#verdict', 'data-kind')) === 'fail');
    await p.context().close();

    // a record that is not the campaign's: the copy with a changed record is ignored, never trusted
    const bad = JSON.parse(JSON.stringify(good)); bad.final.entries += 3; fs.writeFileSync('runs/final-test/bad-record.json', JSON.stringify(bad));
    p = await load('runs/final-test/bad-record.json');
    check('a record changed after signing is ignored and said to be', /not signed by the campaign.s key, so it was ignored/.test(await t(p, '#fp-status')) && (await p.getAttribute('#verdict', 'data-kind')) === 'partial', await t(p, '#fp-status'));
    await p.context().close();

    if (RELAY) {
      p = await load(null, RELAY);
      check('read from a relay that holds the list and the record: the same "exactly the one the host fixed"', /exactly the one the host fixed/.test(await t(p, '#fp-status')), await t(p, '#fp-status'));
      await p.context().close();
    }
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  } finally { srv.kill(); await browser.close(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
