// The report hash: canonical JSON is the same whatever order the keys come in, and two recounts of the same campaign at the same
// chain height give the same hash. Env: LINK (recount link), LINK2 (a second campaign, optional: a different campaign gives a different hash).
const { chromium } = require('./../vectors/js/node_modules/playwright');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
(async () => {
  const browser = await chromium.launch();
  const open = async (url) => {
    const p = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
    await p.goto(url);
    await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 300000 });
    await p.click('#tab-totals'); // design round 2: the sources (with the report hash) are on the TOTALS tab
    await p.waitForSelector('#rf-hash .h-s', { timeout: 30000 });
    return p;
  };
  const read = async (p) => ({ h: await p.getAttribute('#rf-hash .hash, #rf-hash', 'data-h'), height: (await p.textContent('#rf-height')).trim(), kind: await p.getAttribute('#verdict', 'data-kind') });

  // 1. canonical JSON itself
  const p0 = await (await browser.newContext()).newPage();
  await p0.goto(process.env.LINK);
  const u = await p0.evaluate(async () => {
    const { canonicalJson, sha256hex, reportEnvelope } = await import('./canon.js');
    const a = { b: 1, a: [3, { y: 'é"', x: null }], c: true, d: 2.5, e: -0, f: 1e21 };
    const b = { f: 1e21, e: -0, d: 2.5, c: true, a: [3, { x: null, y: 'é"' }], b: 1 };
    let threw = false; try { canonicalJson({ n: NaN }); } catch { threw = true; }
    return { sa: canonicalJson(a), sb: canonicalJson(b), threw, empty: sha256hex && await sha256hex(''), env: reportEnvelope('ab', 7, { z: 1, a: 2 }) };
  });
  check('canonical JSON: the same value gives the same text whatever the key order', u.sa === u.sb, u.sa);
  check('canonical JSON: sorted keys, no spaces, whole numbers plain, other numbers with 8 places', /^\{"a":\[3,\{"x":null,"y":"é\\""\}\],"b":1,"c":true,"d":2\.50000000,/.test(u.sa));
  check('canonical JSON: a number that is not finite is refused', u.threw);
  check('canonical JSON: a very large whole number is written in plain decimal, not with an exponent', /"f":1000000000000000000000}$/.test(u.sa), u.sa);
  check('SHA-256 of the empty text is the known value', u.empty === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  check('the envelope has the version, the campaign, the height and the report, sorted', u.env === '{"end_height":7,"report":{"a":2,"z":1},"rules_id":"ab","v":1}', u.env);
  await p0.close();

  // 2. two recounts of the same campaign at the same height
  let same = false, last = '';
  for (let i = 0; i < 6 && !same; i++) {
    const [p1, p2] = await Promise.all([open(process.env.LINK), open(process.env.LINK)]);
    const [r1, r2] = [await read(p1), await read(p2)];
    last = `${r1.height}/${r2.height} ${String(r1.h).slice(0, 12)}/${String(r2.h).slice(0, 12)}`;
    if (r1.height === r2.height) { check('two recounts of the same campaign at the same height give the same hash', r1.h && r1.h === r2.h && /^[0-9a-f]{64}$/.test(r1.h), last); same = true;
      // 3. running it again on the same page, at the same height, keeps the hash
      await p1.click('#tab-recount'); // design round 2: "Run it again" is on the RECOUNT tab
      await p1.click('#again'); await p1.waitForFunction(() => document.querySelector('#verdict').dataset.kind === 'working', null, { timeout: 20000 }).catch(() => {});
      await p1.waitForFunction(() => document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 300000 });
      await p1.waitForTimeout(1000); const r3 = await read(p1);
      if (r3.height === r1.height) check('"Run it again" at the same height keeps the hash', r3.h === r1.h, r3.h?.slice(0, 12));
      else console.log(`   (chain moved to ${r3.height} before the rerun: hash for a new height is expected to differ)`);
      check('the page says how the hash is made, in one line', /canonical JSON/.test(await p1.textContent('#run-facts')) && /SPEC section 5/.test(await p1.textContent('#run-facts')));
    }
    await p1.close(); await p2.close();
  }
  if (!same) check('two recounts at the same height were compared', false, `heights never matched in 6 tries: ${last}`);
  if (process.env.LINK2) { const pa = await open(process.env.LINK), pb = await open(process.env.LINK2); check('a different campaign gives a different hash', (await read(pa)).h !== (await read(pb)).h); }
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
