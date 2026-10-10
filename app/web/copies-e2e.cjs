// Copies of the list: the "Save a copy" buttons, what the browser remembers of a campaign between visits, and "Compare with my saved copy". Saved ledgers only
// (made by copies.sh from a real closed testnet campaign; a test-only build makes the fork and the big lists): the relay and the chain servers are stand-ins
// answered by this test, so no network and no money. Env: GOOD (host export with its signed record), FORK (same key, other close entry), BIG_SMALL (3000
// entries), BIG_LARGE (20000 entries), DIR (built static folder), PORT (8813), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8813', SHOTS = process.env.SHOTS || 'runs/design-shots';
const { GOOD, FORK, BIG_SMALL, BIG_LARGE } = process.env;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, RELAY = 'http://relay.test', MOCK = 'https://chain.mock.test/testnet';
const good = JSON.parse(fs.readFileSync(GOOD, 'utf8')), fork = JSON.parse(fs.readFileSync(FORK, 'utf8'));
const ID = good.campaign, RULES = JSON.stringify(good.rules), FINAL = good.final;
const copyOf = (ledger, withFinal = true) => ({ kind: 'ledger-export', version: 1, campaign: ID, rules: good.rules, ledger, challenges: [], final: withFinal ? FINAL : null });
const tmp = 'runs/copies-test'; fs.mkdirSync(tmp, { recursive: true });
const file = (name, obj) => { const f = `${tmp}/${name}.json`; fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
let served = good.ledger, finalServed = FINAL; // what the stand-in relay shows right now

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  const wire = async (page) => {
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route(`${RELAY}/**`, async (route) => {
      const u = route.request().url();
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (/\/ledger/.test(u)) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(served) });
      if (/\/challenges$/.test(u)) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '[]' });
      if (/\/final$/.test(u)) return finalServed ? route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(finalServed) }) : route.fulfill({ status: 404, headers: cors, body: '{"error":"no final record yet"}' });
      if (/\/(heartbeat|tickets)/.test(u)) return route.fulfill({ status: 404, headers: cors, body: '{}' });
      if (new RegExp(`/v1/campaigns/${ID}$`).test(u)) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: RULES });
      return route.fulfill({ status: 404, headers: cors, body: '{}' });
    });
    await page.route(`${MOCK}/**`, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(route.request().url()) ? frame(0, [0x08, ...varint(good.rules.start_height + 5)]) : Buffer.alloc(0);
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
  };
  const contribute = `${BASE}/contribute.html#c=${ID}&relay=${RELAY}&server=${encodeURIComponent(MOCK)}`;
  const recount = `${BASE}/recount.html#c=${ID}&relay=${RELAY}&endpoint=${encodeURIComponent(MOCK)}`;
  const t = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
  // one browser profile for the memory tests: its storage lives between visits
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const visit = async (ledger, url = recount, c = ctx) => {
    served = ledger;
    const p = await c.newPage(); await wire(p); await p.goto(url);
    // the contributor page shows a memory line only when something is wrong: wait for the page itself, then give the check a moment
    if (url === contribute) { await p.waitForSelector('#about:not([hidden])', { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(2000); }
    else await p.waitForSelector('#memory-note > *', { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(700);
    const st = await p.evaluate(() => { const n = document.querySelector('#memory-note').firstElementChild; return n ? { state: n.dataset.state, cls: n.className, text: n.textContent.replace(/\s+/g, ' ').trim() } : null; });
    return { p, st };
  };
  try {
    // ---------- memory (the recount page shows every state; the contributor page only a list that got shorter or changed) ----------
    let v = await visit(good.ledger, contribute);
    check('contributor page, first visit: no memory line (nothing to warn about), but the list is remembered', !v.st && JSON.parse(await v.p.evaluate((id) => localStorage.getItem(`cb:seen:${id}`), ID)).count === 2, JSON.stringify(v.st));
    await v.p.evaluate((id) => localStorage.removeItem(`cb:seen:${id}`), ID);
    await v.p.close();
    v = await visit(good.ledger);
    check('first visit: a quiet line says the page will remember the list', v.st && v.st.state === 'first' && !/notice/.test(v.st.cls) && /will remember this list \(2 entries\)/.test(v.st.text), JSON.stringify(v.st));
    await v.p.close();
    v = await visit(good.ledger);
    check('second visit, same list: "the same list as on your last visit", no warning', v.st && v.st.state === 'same' && !/notice/.test(v.st.cls), JSON.stringify(v.st));
    await v.p.close();
    v = await visit(fork.ledger);
    check('a different history signed with the same key: one plain grey line that entry 2 differs from what was seen', v.st && v.st.state === 'changed' && v.st.cls === 'warnline' && /^Entry 2 differs from what you saw on .*; compare a saved copy\.$/.test(v.st.text), JSON.stringify(v.st));
    await v.p.screenshot({ path: `${SHOTS}/memory-changed.png` });
    const mem = await v.p.evaluate((id) => JSON.parse(localStorage.getItem(`cb:seen:${id}`)), ID);
    check('  ... and the page did not overwrite what it remembered with the changed list', mem.count === 2);
    await v.p.close();
    v = await visit(good.ledger.slice(0, 1));
    check('a list cut off at the end: one plain grey line that it is shorter than before (2 entries then, 1 now)', v.st && v.st.state === 'cut_off' && v.st.cls === 'warnline' && /shorter than on .*: 2 entries then, 1 now/.test(v.st.text), JSON.stringify(v.st));
    await v.p.close();
    v = await visit([]);
    check('an empty list after a remembered one: also shortened (now 0)', v.st && v.st.state === 'cut_off' && /, 0 now/.test(v.st.text), JSON.stringify(v.st));
    await v.p.close();
    v = await visit(fork.ledger, contribute);
    check('contributor page, a changed list: the same one grey line', v.st && v.st.state === 'changed' && v.st.cls === 'warnline', JSON.stringify(v.st));
    await v.p.close();
    v = await visit(fork.ledger);
    await v.p.click('#memory-note button');
    check('"Remember this list instead" accepts it and the warning goes', await v.p.isHidden('#memory-note'));
    await v.p.close();
    v = await visit(fork.ledger);
    check('  ... and the next visit finds the list the same', v.st && v.st.state === 'same', JSON.stringify(v.st));
    await v.p.close();
    // an entry changed after signing: the list does not verify, so it is neither trusted nor remembered
    const tamper = JSON.parse(JSON.stringify(good.ledger)); tamper[0].contribution = { ...(tamper[0].contribution || {}), height: ((tamper[0].contribution || {}).height || 1) + 1 };
    v = await visit(tamper, contribute);
    const afterTamper = await v.p.evaluate((id) => localStorage.getItem(`cb:seen:${id}`), ID);
    check('an entry changed after it was signed: the list is ignored as not adding up, and no memory note claims anything', (!v.st || v.st.state === undefined) && /doesn.t add up|ignored|can.t be reached|can.t reach/i.test(await t(v.p, '#banners')), `${v.st ? JSON.stringify(v.st) : 'no note'} | ${(await t(v.p, '#banners')).slice(0, 120)}`);
    check('  ... and what was remembered is untouched', JSON.parse(afterTamper).count === fork.ledger.length, afterTamper);
    await v.p.close();
    // a first visit with an empty list, then entries arrive
    const c2 = await browser.newContext({ viewport: { width: 900, height: 900 } });
    v = await visit([], recount, c2);
    check('an empty list on a first visit is remembered as 0 entries', v.st && v.st.state === 'first' && /\(0 entries\)/.test(v.st.text), JSON.stringify(v.st));
    await v.p.close();
    v = await visit(good.ledger, recount, c2);
    check('  ... and a later visit says 2 new entries and that nothing seen before was changed', v.st && v.st.state === 'grew' && /^2 new entries since your last visit .*nothing you saw before changed\.$/.test(v.st.text), JSON.stringify(v.st));
    await v.p.close(); await c2.close();

    // ---------- blocked storage ----------
    const c3 = await browser.newContext({ viewport: { width: 900, height: 900 } });
    await c3.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
    v = await visit(good.ledger, contribute, c3);
    check('storage blocked, contributor page: the page still works (campaign details shown) and adds no memory line (the backup line says it once)', !v.st && (await v.p.isVisible('#about')), JSON.stringify(v.st));
    check('  ... and the Save a copy button is still there', await v.p.isVisible('#save-copy'));
    await v.p.fill('#amount', (Number(good.rules.min_contribution_zat) / 1e8 + 0.0001).toFixed(8)); await v.p.fill('#refund', good.rules.pay_to); await v.p.click('#create');
    await v.p.waitForSelector('#pay-card:not([hidden])', { timeout: 20000 }).catch(() => {});
    check('  ... and making a payment code still works, with a plain warning that this browser will not keep the secret (download the backup)', (await v.p.isVisible('#pay-card')) && (await t(v.p, '#banners')) === 'This browser cannot save your secret, so download your backup file now.', (await t(v.p, '#banners')).slice(0, 160));
    await v.p.close();
    v = await visit(good.ledger, recount, c3);
    check('storage blocked, recount page: one line that it cannot remember, and the page still gets its list', v.st && v.st.state === 'blocked' && /^This browser cannot remember this list/.test(v.st.text) && !(await v.p.isHidden('#copy-card')), JSON.stringify(v.st));
    await v.p.close(); await c3.close();

    // ---------- very large list ----------
    const small = JSON.parse(fs.readFileSync(BIG_SMALL, 'utf8'));
    const c4 = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const t0 = Date.now();
    v = await visit(small.ledger, contribute, c4);
    const dt = Date.now() - t0;
    const big = JSON.parse(await v.p.evaluate((id) => localStorage.getItem(`cb:seen:${id}`), ID) || '{}');
    check(`a ${small.ledger.length}-entry list: remembered on the first visit, in ${(dt / 1000).toFixed(1)} s`, big.count === small.ledger.length && dt < 40000, JSON.stringify(big));
    await v.p.close();
    v = await visit(small.ledger.slice(0, small.ledger.length - 1), contribute, c4);
    check(`  ... and the same list with its last entry cut off is noticed (${small.ledger.length} then, ${small.ledger.length - 1} now)`, v.st && v.st.state === 'cut_off', JSON.stringify(v.st));
    await v.p.close(); await c4.close();

    // ---------- the Save a copy button, on both pages ----------
    served = good.ledger; finalServed = FINAL;
    let p = await ctx.newPage(); await wire(p); await p.goto(contribute);
    await p.waitForSelector('#about:not([hidden])', { timeout: 30000 }); await p.waitForTimeout(1500);
    let dl = p.waitForEvent('download'); await p.click('#save-copy'); let d = await dl;
    let saved = JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
    check('contributor page: "Save a copy" downloads the full list as a saved copy that holds the signed record', saved.kind === 'ledger-export' && saved.campaign === ID && saved.ledger.length === 2 && saved.final && saved.final.sig === FINAL.sig && /^campaign-[0-9a-f]{8}-list-2-entries\.json$/.test(d.suggestedFilename()), d.suggestedFilename());
    check('  ... and it holds nothing private (rules, list, record only)', !/ledger_sk|payload_sk|amount_key|seed|wallet/i.test(JSON.stringify(saved).replace(/"note":"[^"]*"/, '')));
    await p.close();
    finalServed = null;
    p = await ctx.newPage(); await wire(p); await p.goto(contribute);
    await p.waitForSelector('#about:not([hidden])', { timeout: 30000 }); await p.waitForTimeout(1500);
    dl = p.waitForEvent('download'); await p.click('#save-copy'); d = await dl;
    saved = JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
    check('with no signed record anywhere, the copy is still saved (the record field is empty)', saved.ledger.length === 2 && saved.final === null);
    await p.close();
    finalServed = FINAL;
    p = await ctx.newPage(); await wire(p); await p.goto(recount);
    await p.waitForSelector('#copy-card:not([hidden])', { timeout: 60000 });
    dl = p.waitForEvent('download'); await p.click('#save-copy'); d = await dl;
    const saved2 = JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
    check('recount page: "Save a copy" downloads the same kind of file, with the record', saved2.kind === 'ledger-export' && saved2.ledger.length === 2 && saved2.final && saved2.final.sig === FINAL.sig);
    // round trip: the downloaded file is read by the saved-file recount
    const rt = await ctx.newPage(); await wire(rt); await rt.goto(`${BASE}/recount.html#c=${ID}&relay=http://127.0.0.1:9&endpoint=${encodeURIComponent(MOCK)}`);
    await rt.waitForFunction(() => document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 120000 });
    await rt.setInputFiles('#saved-file', await d.path());
    await rt.waitForFunction(() => /saved copy|fingerprint/i.test(document.querySelector('#verdict-title').textContent) || !document.querySelector('#fp-card').hidden, null, { timeout: 120000 });
    await rt.waitForFunction(() => !document.querySelector('#fp-card').hidden, null, { timeout: 60000 });
    check('the downloaded file loads in the saved-copy recount and matches the host\'s fingerprint', /exactly the one the host fixed/.test(await t(rt, '#fp-status')), await t(rt, '#fp-status'));
    await rt.close();

    // ---------- compare with my saved copy (recount page) ----------
    const compare = async (f) => { await p.setInputFiles('#compare-file', f); await p.waitForFunction(() => !document.querySelector('#compare-out').hidden || !document.querySelector('#compare-error').hidden, null, { timeout: 120000 }); return { out: await t(p, '#compare-out'), cls: await p.getAttribute('#compare-out', 'class'), err: await t(p, '#compare-error'), errHidden: await p.isHidden('#compare-error') }; };
    let r = await compare(file('same', copyOf(good.ledger)));
    check('a copy identical to the current list: "They are identical"', /Your saved copy has 2 entries; the current list has 2 entries\.\s*They are identical\./.test(r.out) && /good/.test(r.cls), r.out);
    r = await compare(file('older', copyOf(good.ledger.slice(0, 1), false)));
    check('a copy taken earlier (fewer entries): the extra entry in the current list is reported as normal, nothing missing', /Extra in the current list: 1 entry that your copy does not have \(number 2; close\)\. That is normal/.test(r.out) && !/Missing/.test(r.out) && /info/.test(r.cls), r.out);
    served = good.ledger.slice(0, 1); await p.reload(); await p.waitForSelector('#copy-card:not([hidden])', { timeout: 60000 });
    r = await compare(file('full', copyOf(good.ledger)));
    check('the current list was cut off at the end, the copy is complete: "Missing from the current list" the close entry, in red', /Missing from the current list: 1 entry that you have \(number 2; close\)/.test(r.out) && /bad/.test(r.cls), r.out);
    await p.screenshot({ path: `${SHOTS}/compare-missing.png`, fullPage: true });
    served = fork.ledger; await p.reload(); await p.waitForSelector('#copy-card:not([hidden])', { timeout: 60000 });
    r = await compare(file('full2', copyOf(good.ledger)));
    check('a different history signed with the same key: the entry that differs is reported as "Changed", in red', /Changed: 1 entry at number 2 are different/.test(r.out) && /bad/.test(r.cls), r.out);
    served = []; await p.reload(); await p.waitForSelector('#copy-card:not([hidden])', { timeout: 60000 });
    r = await compare(file('full3', copyOf(good.ledger)));
    check('the current list is empty: both entries of the copy are missing', /Missing from the current list: 2 entries that you have \(number 1 to 2;/.test(r.out) && /bad/.test(r.cls), r.out);
    served = good.ledger; await p.reload(); await p.waitForSelector('#copy-card:not([hidden])', { timeout: 60000 });
    r = await compare(file('emptycopy', copyOf([], false)));
    check('an empty saved copy against a full list: all entries are extra (nothing to compare), no alarm', /Your saved copy has 0 entries; the current list has 2 entries/.test(r.out) && /Extra in the current list: 2 entries/.test(r.out) && !/Missing|Changed/.test(r.out), r.out);
    r = await compare(file('wrongcamp', { ...copyOf(good.ledger), campaign: '1'.repeat(64) }));
    check('a copy of another campaign is refused', /different campaign/.test(r.err) && !r.errHidden, r.err);
    fs.writeFileSync(`${tmp}/notjson.json`, 'not a list');
    r = await compare(`${tmp}/notjson.json`);
    check('a file that is not a saved copy is refused', /not a saved copy/.test(r.err), r.err);
    const bad = JSON.parse(JSON.stringify(good.ledger)); bad[0].kind = 'reject';
    r = await compare(file('tampered', copyOf(bad)));
    check('a saved copy that does not itself verify is refused ("does not check out")', /does not check out/.test(r.err), r.err);
    check('the page says what a saved copy can and cannot show', /It can show/.test(await t(p, '#copy-card')) && /It cannot show/.test(await t(p, '#copy-card')) && /before the host cut/.test(await t(p, '#copy-card')) && /protects only the person who kept it/.test(await t(p, '#copy-card')));
    await p.close();

    // ---------- very large list, compared ----------
    const large = JSON.parse(fs.readFileSync(BIG_LARGE, 'utf8'));
    served = large.ledger;
    p = await ctx.newPage(); await wire(p);
    const t1 = Date.now(); await p.goto(recount); await p.waitForSelector('#copy-card:not([hidden])', { timeout: 120000 });
    const cutLarge = { ...large, ledger: large.ledger.slice(0, large.ledger.length - 5), final: null };
    r = await compare(file('large-cut', cutLarge));
    const dt2 = Date.now() - t1;
    check(`a ${large.ledger.length}-entry list against a copy missing its last 5 entries: reported in ${(dt2 / 1000).toFixed(1)} s`, /Extra in the current list: 5 entries/.test(r.out) && !/Missing/.test(r.out) && dt2 < 120000, r.out.slice(0, 200));
    const mid = JSON.parse(JSON.stringify(large)); mid.ledger.splice(1000, 1);
    r = await compare(file('large-gap', mid));
    check('a copy that itself has a hole in the middle is refused (it does not verify)', /does not check out/.test(r.err), r.err);
    await p.close();
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally { srv.kill(); await browser.close(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
