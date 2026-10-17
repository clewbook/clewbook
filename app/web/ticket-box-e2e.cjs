// The Recount page's "Import ticket backup file" box (round 8: shown only with no campaign in the address), with made up backup files (invented secrets) for the example testnet campaigns:
// found open, found closed, an unreachable relay, a relay without the campaign, a saved campaign list given instead, a junk file, the hand over
// to the contribute page (read once, then gone), a payment already in this browser left untouched, and the secret never in an address or on the
// page. Plain files from app/web/make-static.sh (default runs/static-polish) on a spare port; the chain server is a stand in answered here, so no
// network and no money are involved. Env: DIR, PORT (default 8926), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const crypto = require('crypto');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8926', SHOTS = process.env.SHOTS || 'runs/design-shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, MOCK = 'https://chain.mock.test/testnet';
const OPEN = { id: '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da', deadline: 4477610 }; // fundraiser, no close entry
const CLOSED = { id: '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f' }; // closed, goal missed
const RELAYS = [`${BASE}/relays/a`, `${BASE}/relays/b`];
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);
const NAMED = 'f6737fbc462e75508d424f0612a1ce5ea3df24c5cc1b550074821ccdea5e237a'; // "Community radio mast (demo)", closed
// round 11 (handoff "recount v2", copy deck section 2): the empty state's heading and supporting line, word for word
const H1 = "Don't trust the host. Recount it.", SUB = "Check a campaign's books yourself, in your browser, against the Zcash chain.";
const invented = (id, relays, refund) => ({ kind: 'contribution-backup', version: 1, campaign: id, relays, server: MOCK, seed: crypto.randomBytes(32).toString('hex'),
  refundAddress: refund, amountZat: 1000000, memo: 'LL1:invented', payment: null, ticket: null, savedAt: new Date().toISOString(), note: 'made up for a test' });

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // round 9: the stand-in chain's height can be switched: before the deadline, past it, failing, or slow (and then failing)
    let tipMode = 'open';
    const mock = async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const isTip = /GetLatestBlock$/.test(route.request().url());
      if (isTip && tipMode === 'fail') return route.abort();
      if (isTip && tipMode === 'slow') { await new Promise((r) => setTimeout(r, 4000)); return route.abort(); }
      const msg = isTip ? frame(0, [0x08, ...varint(tipMode === 'past' ? OPEN.deadline + 50 : OPEN.deadline - 100)]) : Buffer.alloc(0);
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    };
    await ctx.route(`${MOCK}/**`, mock);
    // the public testnet servers are never asked in this test (a failed lookup falls back to them; here they fail too)
    await ctx.route(/zec\.rocks|chainsafe\.dev/, (route) => route.abort());
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${BASE}/recount.html#ticket-box`);
    await p.waitForSelector('#ticket-box');
    const refund = await p.evaluate(async (id) => (await (await fetch(`/relays/a/v1/campaigns/${id}`)).json()).pay_to, OPEN.id);
    const give = async (name, body) => { await p.setInputFiles('#ticket-file', { name, mimeType: 'application/json', buffer: Buffer.from(body) }); };
    const settle = () => p.waitForFunction(() => { const r = document.querySelector('#ticket-result'), e = document.querySelector('#ticket-error'); return !e.hidden || (!r.hidden && !/Looking for the campaign/.test(r.textContent)); }, null, { timeout: 60000 });
    const seen = () => p.evaluate(() => ({ err: document.querySelector('#ticket-error').hidden ? '' : document.querySelector('#ticket-error').innerText.trim(), out: document.querySelector('#ticket-result').hidden ? '' : document.querySelector('#ticket-result').innerText.replace(/\s+/g, ' ').trim(), button: !!document.querySelector('#ticket-open') }));

    const a = await p.evaluate(() => ({ title: document.querySelector('#ticket-box h2').textContent, box: !document.querySelector('#ticket-box').hidden && document.querySelector('#ticket-box').getClientRects().length > 0,
      saved: !document.querySelector('#upload-card').hidden && document.querySelector('#upload-card h2').textContent, savedText: document.querySelector('#upload-card .ec-p').textContent, h1: document.querySelector('.rh1').textContent, sub: document.querySelector('.rsub').textContent, old: document.body.innerText.includes('I have a ticket backup file'),
      boxTop: Math.round(document.querySelector('#ticket-box').getBoundingClientRect().top), leadBottom: Math.round(document.querySelector('.etabs').getBoundingClientRect().bottom),
      labels: [...document.querySelectorAll('.ec-k')].map((x) => x.textContent), choosers: [...document.querySelectorAll('.ecard .filebtn')].map((l) => [l.textContent.trim(), l.querySelector('input[type=file]').getAttribute('aria-label')]) }));
    check('state (a), no campaign in the address: "Import ticket backup file" and "Check a saved copy" are both shown, under the tabs; the old title is gone', a.title === 'Import ticket backup file' && a.box && a.saved === 'Check a saved copy' && a.boxTop >= a.leadBottom && !a.old, JSON.stringify(a));
    check('state (a): the heading and the supporting line, word for word', a.h1 === H1 && a.sub === SUB, `${a.h1} | ${a.sub}`);
    check('state (a): the two card labels, and both choosers are native file inputs under "↑ Choose file", named "Import ticket backup file" and "Check a saved copy"', JSON.stringify(a.labels) === JSON.stringify(['YOUR CONTRIBUTION OR BID', "A CAMPAIGN'S LIST"]) && JSON.stringify(a.choosers) === JSON.stringify([['↑Choose file', 'Import ticket backup file'], ['↑Choose file', 'Check a saved copy']]), JSON.stringify([a.labels, a.choosers]));
    check('state (a): "Check a saved copy" says what the file is, what the page does with it and that it stays on the device, word for word', a.savedText === 'Saved a campaign\'s list before? Choose the file and your browser checks it against the Zcash chain. It never leaves your device. Get one from the host, or with "Keep a copy" after a recount.', a.savedText);
    check('the box is on the Recount page with its title and line', /^Import ticket backup file$/.test(await p.textContent('#ticket-box h2')) && /Opens your contribution or bid\. The file is read in this browser and is not sent anywhere\./.test(await p.textContent('#ticket-box')));

    // found, open
    const openFile = invented(OPEN.id, RELAYS, refund);
    await give('backup.json', JSON.stringify(openFile)); await settle();
    let s = await seen();
    check('found, open: the campaign name, TESTNET, "Open", the button and the line about saving', /TESTNET/.test(s.out) && /\bOpen\b/.test(s.out) && /Open my ticket/.test(s.out) && /Opening it saves the file in this browser\./.test(s.out) && s.button && !s.err, JSON.stringify(s));
    const leak = await p.evaluate((f) => [f.seed, f.refundAddress, f.memo].some((x) => document.body.innerText.includes(x) || location.href.includes(x)), openFile);
    check('the secret, the refund address and the memo are on neither the page nor the address', !leak);
    check('nothing is saved before the button is pressed', (await p.evaluate((id) => [localStorage.getItem(`ll:${id}`), sessionStorage.getItem(`cb-handover:${id}`)], OPEN.id)).every((x) => x === null));

    // round 9: the card's state line, from the chain height looked up after the card is shown
    const stateLine = () => p.evaluate(() => (document.querySelector('#ticket-result .tb-line') || {}).textContent || '');
    await p.waitForTimeout(1500);
    check('open, before the deadline: the card still says "Open" once the chain height is known', (await stateLine()) === 'Open', await stateLine());
    tipMode = 'past';
    await give('backup.json', JSON.stringify(openFile)); await settle();
    await p.waitForFunction(() => /Deadline passed, waiting to be closed/.test(document.querySelector('#ticket-result').textContent), null, { timeout: 15000 }).catch(() => {});
    s = await seen();
    check('past the deadline and not closed: "Deadline passed, waiting to be closed", the button still there', (await stateLine()) === 'Deadline passed, waiting to be closed' && s.button, JSON.stringify(s));
    tipMode = 'fail';
    await give('backup.json', JSON.stringify(openFile)); await settle(); await p.waitForTimeout(1500);
    check('the height lookup fails: the card keeps "Open" and its button', (await stateLine()) === 'Open' && (await seen()).button, await stateLine());
    tipMode = 'slow';
    const t0 = Date.now();
    await give('backup.json', JSON.stringify(openFile)); await settle();
    const shownAfter = Date.now() - t0, early = await stateLine();
    check('a slow lookup never delays the card: shown with "Open" and its button before the height answers', shownAfter < 3500 && early === 'Open' && (await seen()).button, `${shownAfter} ms, ${early}`);
    await p.waitForTimeout(5000);
    check('  ... and after the slow lookup gives up, it still says "Open"', (await stateLine()) === 'Open', await stateLine());
    tipMode = 'past';

    // found, closed
    await give('backup.json', JSON.stringify(invented(CLOSED.id, RELAYS, refund))); await settle();
    s = await seen();
    await p.waitForTimeout(1500);
    s = await seen();
    check('found, closed: "This campaign is closed. Your ticket is still here." and the button, even with the chain past the deadline', /This campaign is closed\. Your ticket is still here\./.test(s.out) && !/Deadline passed/.test(s.out) && s.button, JSON.stringify(s));
    tipMode = 'open';

    // unreachable relay, and a relay without the campaign
    await give('backup.json', JSON.stringify(invented(OPEN.id, ['http://127.0.0.1:9'], refund))); await settle();
    s = await seen();
    check('relay unreachable: names its host, says try again later, no button', s.out === 'We could not reach this campaign\'s relay (127.0.0.1:9). Try again later.' && !s.button, JSON.stringify(s));
    await give('backup.json', JSON.stringify(invented('ab'.repeat(32), [RELAYS[0]], refund))); await settle();
    s = await seen();
    check('relay without the campaign: "This relay no longer has this campaign.", no button', s.out === 'This relay no longer has this campaign.' && !s.button, JSON.stringify(s));

    // wrong kinds of file
    await give('list.json', JSON.stringify({ kind: 'ledger-export', campaign: OPEN.id, ledger: [] })); await settle();
    s = await seen();
    check('a saved campaign list: says so and points to Check a saved copy', s.err === 'That is a saved campaign list, not a ticket backup. Use Check a saved copy for it.' && (await p.getAttribute('#ticket-error a', 'href')) === 'recount.html#upload-card' && !s.out, JSON.stringify(s));
    await give('junk.json', 'not json at all'); await settle();
    s = await seen();
    check('a junk file: "That is not a Clewbook backup file."', s.err === 'That is not a Clewbook backup file.' && !s.out, JSON.stringify(s));
    await give('other.json', JSON.stringify({ kind: 'something-else', campaign: OPEN.id })); await settle();
    check('another JSON file: the same plain message', (await seen()).err === 'That is not a Clewbook backup file.');

    // the hand over: read once on the contribute page, then gone; the secret never in an address
    await give('backup.json', JSON.stringify(openFile)); await settle();
    await Promise.all([p.waitForURL(/contribute\.html#c=/, { timeout: 30000 }), p.click('#ticket-open')]);
    await p.waitForSelector('#pay-card:not([hidden]), #progress-card:not([hidden])', { timeout: 60000 }); await p.waitForTimeout(1500);
    const after = await p.evaluate(([id, f]) => { const st = JSON.parse(localStorage.getItem(`ll:${id}`) || 'null'); return { restored: !!st && st.seed === f.seed && st.refund === f.refundAddress, handover: sessionStorage.getItem(`cb-handover:${id}`), url: [f.seed, f.refundAddress, f.memo].some((x) => location.href.includes(x)), stage: document.querySelector('#cflow').dataset.stage }; }, [OPEN.id, openFile]);
    check('"Open my ticket": the contribute page restores the file (the ordinary restore), the handed file is gone, nothing secret in the address', after.restored && after.handover === null && !after.url && after.stage !== 'amount', JSON.stringify(after));
    await p.screenshot({ path: `${SHOTS}/ticket-box-handover.png` });

    // a payment already in this browser is never overwritten
    const before = await p.evaluate((id) => localStorage.getItem(`ll:${id}`), OPEN.id);
    await p.goto('about:blank'); await p.goto(`${BASE}/recount.html#ticket-box`); await p.waitForSelector('#ticket-box');
    const second = invented(OPEN.id, RELAYS, refund);
    await give('backup.json', JSON.stringify(second)); await settle();
    s = await seen();
    check('a payment already here: the card does not say it will save the file', s.button && !/Opening it saves the file/.test(s.out), JSON.stringify(s));
    await p.click('#ticket-open');
    const said = await p.evaluate(() => document.querySelector('#ticket-result').innerText);
    await p.waitForURL(/contribute\.html#c=/, { timeout: 30000 }); await p.waitForTimeout(2500);
    const kept = await p.evaluate(([id, seed]) => ({ same: localStorage.getItem(`ll:${id}`), handover: sessionStorage.getItem(`cb-handover:${id}`), second: (localStorage.getItem(`ll:${id}`) || '').includes(seed) }), [OPEN.id, second.seed]);
    check('... it says "This browser already has a payment for this campaign. Opening it." and opens that payment without writing', /This browser already has a payment for this campaign\. Opening it\./.test(said) && kept.same === before && kept.handover === null && !kept.second, JSON.stringify({ said: said.slice(-80), handover: kept.handover, second: kept.second }));

    // state (b): a campaign in the address. No ticket backup box, no saved-copy box; the same line under the tabs; the campaign id bold and readable,
    // its name (from the rules the page already read) in a smaller line above; at 1280 and 390, light and dark
    for (const [w, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
      const cb = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: theme });
      await cb.route(`${MOCK}/**`, mock);
      const q = await cb.newPage(); q.on('pageerror', (e) => errors.push(String(e)));
      await q.goto(`${BASE}/recount.html#c=${NAMED}&relay=${RELAYS[0]}&relay=${RELAYS[1]}&endpoint=${encodeURIComponent(MOCK)}`);
      await q.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 60000 });
      const b = await q.evaluate(() => {
        const id = document.querySelector('#campaign-id'), btn = document.querySelector('#cid-copy'), cs = getComputedStyle(id), body = getComputedStyle(document.body);
        const r = id.getBoundingClientRect(), tabs = document.querySelector('.rtabs').getBoundingClientRect();
        const apart = (x, y) => x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top;
        const tb = document.querySelector('#ticket-box');
        return { box: !tb.hidden || tb.getClientRects().length > 0, boxWords: document.body.innerText.includes('Import ticket backup file'), saved: document.querySelector('#upload-card').hidden,
          hero: !!document.querySelector('.rh1') && document.querySelector('.rh1').getClientRects().length > 0, id: id.textContent, label: btn.querySelector('.rcid-k').textContent, icon: btn.querySelector('.rcid-ic').getClientRects().length > 0, aria: btn.getAttribute('aria-label'),
          noName: !document.querySelector('#rname'), weight: Number(cs.fontWeight), size: parseFloat(cs.fontSize),
          family: cs.fontFamily.split(',')[0].replace(/"/g, ''), color: cs.color, ink: body.color, oneLine: r.height < parseFloat(cs.fontSize) * 2, clear: apart(r, tabs), inView: r.left >= 0 && r.right <= innerWidth, wide: document.documentElement.scrollWidth <= innerWidth,
          theme: document.documentElement.dataset.theme };
      });
      check(`state (b) ${w} ${theme}: no "Import ticket backup file" box, no "Check a saved copy" box and no empty state heading above the result`, !b.box && !b.boxWords && b.saved && !b.hero && b.theme === theme, JSON.stringify(b));
      check(`state (b) ${w} ${theme}: "CAMPAIGN" then the id "f6737fbc…" in Chivo Mono 600 15px, in the ink colour, on one line, clear of the tabs, with the copy icon only; the button named "Copy campaign id f6737fbc"; no name line (round 11)`, b.id === 'f6737fbc…' && b.label === 'CAMPAIGN' && b.icon && b.aria === 'Copy campaign id f6737fbc' && b.noName && b.weight === 600 && b.size === 15 && b.family === 'Chivo Mono' && b.color === b.ink && b.oneLine && b.clear && b.inView && b.wide, JSON.stringify(b));
      if (w === 1280 && theme === 'light') {
        await q.goto(`${BASE}/recount.html#c=${OPEN.id}&relay=${RELAYS[0]}&relay=${RELAYS[1]}&endpoint=${encodeURIComponent(MOCK)}`); await q.reload();
        await q.waitForFunction(() => document.querySelector('#campaign-id').textContent.length > 0, null, { timeout: 60000 }); await q.waitForTimeout(1500);
        const u = await q.evaluate(() => ({ id: document.querySelector('#campaign-id').textContent, name: !document.querySelector('#rname'), weight: getComputedStyle(document.querySelector('#campaign-id')).fontWeight }));
        check('state (b), a campaign without a name: the bold id alone, no name line', u.id === '47751309…' && u.name && Number(u.weight) >= 600, JSON.stringify(u));
      }
      await cb.close();
    }

    // the quiet links
    await p.goto(`${BASE}/campaign.html#c=${OPEN.id}&relay=${RELAYS[0]}&server=${encodeURIComponent(MOCK)}`); await p.waitForSelector('.bk-link a', { state: 'attached' });
    check('the campaign page links to the box', (await p.getAttribute('.bk-link a', 'href')) === 'recount.html#ticket-box' && (await p.textContent('.bk-link a')) === 'Have a ticket backup file? Open it here');
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
    await ctx.close();
  } finally {
    srv.kill();
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
