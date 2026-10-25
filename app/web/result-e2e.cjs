// A person's own auction result in one line (result.js), in a real browser, without network or money.
// Part 1, the shared piece on made up lists: blind bid won and settled, not won, won but not settled yet (nothing said), void; open auction
// one price (change back) and pay your bid (nothing back); several bids in a many item auction ("You won 2 items"); no close yet; "came back"
// only when every transaction that brings money back is mined; the bids this browser holds, from the bid page and the contribute page.
// Part 2, the pages with the real public lists of two closed main network auctions (Apparition 69_, a blind bid auction; and a pay your bid
// auction of many items, named by OPEN_ID), a stand in relay serving those lists and a stand in chain server: the line at the top, its "more", and "Yours"
// on the person's rows. Env: RELAY_COPY (runs/result-relay: rules and lists of the two auctions), OPEN_ID (the
// pay your bid auction's campaign id, or its first characters; else read from the file open-id in RELAY_COPY), PORT (default 8976).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const PORT = Number(process.env.PORT || 8976), BASE = `http://127.0.0.1:${PORT}`, RELAY_COPY = process.env.RELAY_COPY, RELAY = 'https://relay.clewbook.xyz';
const APP = '5f40200a94bd98a655eb25c36b8b26b7b12c7d2240e7f3270e64b11c9e59c20d', APP_WIN = '045273bcc6724d195e99f830918e93c11519cd59c33de966d79c008bfa96e82b';
const APP_SETTLE = '40cdc44a10a501ce627517d2447e15267db5c3d4de04c53c059e0c8a3f333a47';
const OPEN_ID = (process.env.OPEN_ID || (() => { try { return fs.readFileSync(path.join(RELAY_COPY, 'open-id'), 'utf8'); } catch { return ''; } })()).trim();
if (!/^[0-9a-f]{8,64}$/.test(OPEN_ID)) { console.error('Set OPEN_ID, or put the file open-id in RELAY_COPY: the pay your bid auction\'s campaign id (or its first characters).'); process.exit(2); }
const OPEN = fs.readdirSync(path.join(RELAY_COPY, 'campaigns')).find((d) => d.startsWith(OPEN_ID));
const OPEN_WIN = 'a724c4130528c31da977de6ee60878f5c381c78de309e622f678c6f46a68af3d', OPEN_LOSE = 'd5bc382c5edcfcd7dfe967db23b67841e238f5352a1181ab48b3a623ad144338';
const OPEN_LOSE_TICKET = '2ef58e352f4acdc2298caf62979c086381fa790a41ba482599250f8e9421cc75';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  ' + extra : ''}`); if (!ok) failed++; };

const relayAnswer = (u) => {
  const m = /\/v1\/campaigns\/([0-9a-f]{64})(\/[a-z]+)?/.exec(u); if (!m) return null;
  const dir = path.join(RELAY_COPY, 'campaigns', m[1]); if (!fs.existsSync(dir)) return null;
  if (!m[2]) return fs.readFileSync(path.join(dir, 'rules.json'), 'utf8');
  if (m[2] === '/ledger') return `[${fs.readdirSync(path.join(dir, 'ledger')).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => fs.readFileSync(path.join(dir, 'ledger', f), 'utf8')).join(',')}]`;
  return m[2] === '/challenges' ? '[]' : null;
};
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frames = (msg, status = 0) => { const t = Buffer.from(`grpc-status:${status}\r\n`); return Buffer.concat([...(msg ? [Buffer.from([0, ...[24, 16, 8, 0].map((s) => (msg.length >>> s) & 255)]), Buffer.from(msg)] : []), Buffer.from([0x80, 0, 0, 0, t.length]), t]); };

(async () => {
  const srv = spawn('python3', ['-B', path.join(__dirname, 'serve.py'), String(PORT), '127.0.0.1'], { env: { ...process.env, SERVE_ROOT: path.join(__dirname, 'www') }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch();
  const errors = [];
  const fresh = async (mined) => {
    const ctx = await browser.newContext();
    // everything off this computer, and the page server's own forwarder to chain servers (/grpc/...), goes to the stand ins
    await ctx.route((url) => !url.href.startsWith(BASE) || url.pathname.startsWith('/grpc/'), async (route) => {
      const u = route.request().url();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-grpc-web', 'access-control-allow-methods': 'GET, POST' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (u.startsWith(RELAY)) { const b = relayAnswer(u); return b == null ? route.fulfill({ status: 404, headers: cors, body: '{}' }) : route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: b }); }
      const g = { ...cors, 'content-type': 'application/grpc-web+proto' };
      if (/\/GetLatestBlock$/.test(u)) return route.fulfill({ status: 200, headers: g, body: frames([0x08, ...varint(3529612)]) });
      if (/\/GetTransaction$/.test(u)) {
        const txid = Buffer.from(route.request().postDataBuffer().subarray(7, 39)).reverse().toString('hex');
        return route.fulfill({ status: 200, headers: g, body: mined.includes(txid) ? frames([0x0a, 1, 0, 0x10, ...varint(3529500)]) : frames(null, 5) });
      }
      return route.abort();
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    return { ctx, p };
  };
  try {
    // ---------- part 1: the shared piece ----------
    let { ctx, p } = await fresh([]);
    await p.goto(`${BASE}/about.html`);
    const r = await p.evaluate(async () => {
      const R = await import('/result.js');
      const nf = (n) => String(n).repeat(64).slice(0, 64);
      const issue = (n, extra = {}) => ({ kind: 'issue', contribution: { nf: nf(n), txid: 't'.repeat(64), action: 0, height: 10 }, ticket: { txid: `${n}`.repeat(64).slice(0, 64), issue_height: 11, branch_id: 'x' }, ...extra });
      const close = (winners, outcome = 'sealed_auction') => ({ kind: 'close', close: { close_height: 20, outcome, winners } });
      const settle = (n, price, excess) => ({ kind: 'settle', settle: { nf: nf(n), txid: 's'.repeat(64), price_zat: price, excess_zat: excess, fee_zat: 10000 } });
      const sealed = { sealed: { pricing: 'uniform' }, mode: 'sealed_auction', items: 1, fee_zat: 10000, ticker: 'ZEC' };
      const open1 = { mode: 'auction', pricing: 'uniform', items: 1, fee_zat: 10000, ticker: 'ZEC' };
      const openPay = { mode: 'auction', items: 3, fee_zat: 10000, ticker: 'ZEC' };
      const line = (c, e, b, a = true) => { const x = R.auctionResult(c, e, b); return x ? R.resultLine(x, a) : null; };
      const out = {};
      out.sealedWon = line(sealed, [issue(1, { refund: 'r'.repeat(64) }), close([nf(1)]), settle(1, 35000, 5000)], [{ nf: nf(1), paidZat: 50000 }]);
      out.sealedLost = line(sealed, [issue(1), issue(2, { refund: 'f'.repeat(64) }), close([nf(1)]), settle(1, 35000, 5000)], [{ nf: nf(2), paidZat: 50000 }]);
      out.sealedNotSettled = line(sealed, [issue(1), close([nf(1)])], [{ nf: nf(1), paidZat: 50000 }]);
      out.sealedVoid = line(sealed, [issue(1), close([], 'void')], [{ nf: nf(1), paidZat: 50000 }]);
      out.openUniform = line(open1, [issue(1), close([nf(1)], 'auction'), settle(1, 70000, 20000)], [{ nf: nf(1), paidZat: 100000 }]);
      out.openPay = line(openPay, [issue(1), close([nf(1)], 'auction')], [{ nf: nf(1), paidZat: 120000 }]);
      out.several = line(openPay, [issue(1), issue(2), issue(3), close([nf(1), nf(3)], 'auction')], [{ nf: nf(1), paidZat: 40000 }, { nf: nf(2), paidZat: 30000 }, { nf: nf(3), paidZat: 50000 }]);
      out.noClose = line(sealed, [issue(1)], [{ nf: nf(1), paidZat: 50000 }]);
      out.coming = line(sealed, [issue(1), close([nf(1)]), settle(1, 35000, 5000)], [{ nf: nf(1), paidZat: 50000 }], false);
      out.notMine = line(sealed, [issue(1), close([nf(1)]), settle(1, 35000, 5000)], [{ nf: nf(9), paidZat: 50000 }]);
      localStorage.setItem(`ll:sealed:${'a'.repeat(64)}`, JSON.stringify({ ticket: { nf: nf(1) }, paidZat: 50000 }));
      localStorage.setItem(`ll:${'a'.repeat(64)}`, JSON.stringify({ ticket: { nf: nf(2) }, amountZat: 30000 }));
      localStorage.setItem(`ll:${'a'.repeat(64)}:earlier`, JSON.stringify([{ ticket: { nf: nf(3) }, amountZat: 20000 }, { memo: 'a code never paid' }]));
      out.mine = R.myBids('a'.repeat(64));
      return out;
    });
    check('blind bid, won and settled: "You won. You paid X ZEC, Y ZEC came back to your wallet."', r.sealedWon === 'You won. You paid 0.00035 ZEC, 0.00005 ZEC came back to your wallet.', r.sealedWon);
    check('blind bid, not won: "Not won. Y ZEC came back to your wallet." (the deposit minus the fee)', r.sealedLost === 'Not won. 0.0004 ZEC came back to your wallet.', r.sealedLost);
    check('a winner not settled yet: nothing is said', r.sealedNotSettled === null);
    check('a void auction: not won, the deposit comes back minus the fee', r.sealedVoid === 'Not won. 0.0004 ZEC came back to your wallet.', r.sealedVoid);
    check('open auction, one price: the price paid and the change', r.openUniform === 'You won. You paid 0.0007 ZEC, 0.0002 ZEC came back to your wallet.', r.openUniform);
    check('open auction, pay your bid, many items: "You won 1 item. You paid X ZEC."', r.openPay === 'You won 1 item. You paid 0.0012 ZEC.', r.openPay);
    check('three bids in a many item auction, two won: "You won 2 items", both prices, the third bid back', r.several === 'You won 2 items. You paid 0.0009 ZEC, 0.0002 ZEC came back to your wallet.', r.several);
    check('no close yet: nothing is said', r.noClose === null);
    check('money not mined yet: "is coming back"', r.coming === 'You won. You paid 0.00035 ZEC, 0.00005 ZEC is coming back to your wallet.', r.coming);
    check('a bid that is not on the list: nothing is said', r.notMine === null);
    check('the bids this browser holds: the bid page\'s, the contribute page\'s and its earlier codes (a code never paid does not count)', JSON.stringify(r.mine.map((b) => [b.nf[0], b.paidZat])) === '[["1",50000],["2",30000],["3",20000]]', JSON.stringify(r.mine.map((b) => [b.nf[0], b.paidZat])));
    await ctx.close();

    // ---------- part 2: the pages, with the real lists ----------
    const hold = async (q, key, value) => q.addInitScript(([k, v]) => { localStorage.setItem(k, v); }, [key, JSON.stringify(value)]);
    const text = async (q, sel) => ((await q.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const appState = { ticket: { nf: APP_WIN, entry: { kind: 'issue', contribution: { nf: APP_WIN } } }, tranche: 50000, paidZat: 50000, ticketsChecked: { ok: true, earlyOk: true, problems: [] } };
    for (const [mined, word] of [[[APP_SETTLE], 'came back'], [[], 'is coming back']]) {
      ({ ctx, p } = await fresh(mined));
      await hold(ctx, `ll:sealed:${APP}`, appState);
      await p.goto(`${BASE}/campaign.html#c=${APP}&relay=${RELAY}`);
      await p.waitForSelector('#my-result:not([hidden])', { timeout: 30000 }).catch(() => {});
      const line = await text(p, '#my-result-line');
      check(`campaign page, Apparition 69_, the settlement ${mined.length ? 'mined' : 'not mined yet'}: "${line}"`, line === `You won. You paid 0.00035 ZEC, 0.00005 ZEC ${word} to your wallet.`);
      if (mined.length) {
        check('its "more": the bid, the price, the change and the settlement', /Bid 045273bc…: won, paid 0\.00035 ZEC, 0\.00005 ZEC back in transaction 40cdc44a…/.test(await text(p, '#my-result .my-result-more')) && (await p.$eval('#my-result .my-result-more summary', (s) => s.textContent)) === 'more');
        const yours = await p.$$eval('#entries tr.mine', (rows) => rows.map((tr) => tr.querySelector('.ek').textContent + ':' + (tr.querySelector('.yours') || {}).textContent));
        check('the public list marks the person\'s rows "Yours": the deposit, its small payment and its settlement', JSON.stringify(yours.sort()) === JSON.stringify(['Deposit:Yours', 'Settlement:Yours', 'Small payment:Yours']), JSON.stringify(yours));
        await ctx.close();
        ({ ctx, p } = await fresh(mined));
        await hold(ctx, `ll:sealed:${APP}`, appState);
        await p.goto(`${BASE}/bid.html#c=${APP}&relay=${RELAY}`);
        await p.waitForSelector('#my-result:not([hidden])', { timeout: 30000 }).catch(() => {});
        check('bid page, Apparition 69_: the same line at the top', (await text(p, '#my-result-line')) === 'You won. You paid 0.00035 ZEC, 0.00005 ZEC came back to your wallet.', await text(p, '#my-result-line'));
      }
      await ctx.close();
    }
    // the viewing key under "more" on the campaign page: shortened, Copy gives the whole key, one line; "Not published yet" before
    const REVEALED = JSON.parse(relayAnswer(`${RELAY}/v1/campaigns/${APP}/ledger`)).find((e) => e.kind === 'reveal').reveal.ufvk;
    ({ ctx, p } = await fresh([APP_SETTLE]));
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await p.goto(`${BASE}/campaign.html#c=${APP}&relay=${RELAY}`);
    await p.waitForSelector('#vk-row', { state: 'attached', timeout: 30000 }).catch(() => {});
    await p.click('#id-more summary');
    const vk = await p.evaluate(() => ({ short: document.querySelector('#vk-short')?.textContent, what: document.querySelector('#vk-row .vk-what')?.textContent, row: document.querySelector('#vk-row')?.textContent }));
    await p.click('#vk-copy'); await p.waitForTimeout(500);
    const copied = await p.evaluate(() => navigator.clipboard.readText());
    check('settled campaign page, under "more": the viewing key shortened, with a Copy button for the whole key', vk.short === `${REVEALED.slice(0, 12)}…${REVEALED.slice(-6)}` && copied === REVEALED && /^Viewing key /.test(vk.row), vk.short);
    check('and one line: "Lets anyone see the payments into this auction, not spend them."', vk.what === 'Lets anyone see the payments into this auction, not spend them.', vk.what);
    await ctx.close();
    const SKULL = fs.readdirSync(path.join(RELAY_COPY, 'campaigns')).find((d) => d.startsWith('7b018c43'));
    ({ ctx, p } = await fresh([]));
    await p.goto(`${BASE}/campaign.html#c=${SKULL}&relay=${RELAY}`);
    await p.waitForSelector('#vk-row', { state: 'attached', timeout: 30000 }).catch(() => {});
    check('an auction that has not published its key: "Not published yet"', (await text(p, '#vk-row')) === 'Viewing key Not published yet', await text(p, '#vk-row'));
    await ctx.close();
    // the recount page: the name from the rules, then the short id with its copy button, on both tabs (an unlisted auction too)
    for (const [id, name] of [[APP, 'Apparition 69_'], [SKULL, 'Skull of Icul (by Sam)']]) {
      ({ ctx, p } = await fresh([]));
      await p.goto(`${BASE}/recount.html#c=${id}&relay=${RELAY}`);
      await p.waitForFunction(() => !document.querySelector('#rc-name').hidden, null, { timeout: 30000 }).catch(() => {});
      const head = async () => p.evaluate(() => ({ name: document.querySelector('#rc-name').textContent, id: document.querySelector('#campaign-id').textContent, order: document.querySelector('#rc-name').compareDocumentPosition(document.querySelector('#cid-copy')) === 4, nameShown: !!document.querySelector('#rc-name').offsetParent }));
      const a = await head();
      await p.click('#tab-totals'); await p.waitForTimeout(300);
      const b = await head();
      check(`recount page, ${name}: the name, then the short id with its copy button, on the Recount and Totals tabs`, a.name === name && a.id === `${id.slice(0, 8)}…` && a.order && a.nameShown && b.nameShown && b.name === name, JSON.stringify(a));
      await ctx.close();
    }
    // a browser without any bid of this auction: no line, no "Yours"
    ({ ctx, p } = await fresh([APP_SETTLE]));
    await p.goto(`${BASE}/campaign.html#c=${APP}&relay=${RELAY}`);
    await p.waitForSelector('#entries tr', { state: 'attached', timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(1500);
    check('a browser that holds no bid of the auction: no line and no "Yours"', (await p.$eval('#my-result', (b) => b.hidden)) && (await p.$$('#entries .yours')).length === 0);
    await ctx.close();
    // the contribute page and the campaign page of the pay your bid auction, with one winning bid and one losing bid saved here
    for (const page of ['contribute', 'campaign']) {
      ({ ctx, p } = await fresh([OPEN_LOSE_TICKET]));
      await hold(ctx, `ll:${OPEN}`, { ticket: { nf: OPEN_WIN, entry: { kind: 'issue', contribution: { nf: OPEN_WIN }, ticket: { txid: 'fc58c010bcd8731dafbce444dac2308af46c0e12709ec3b66f97dd5d0f4defdb' } } }, amountZat: 30000 });
      await hold(ctx, `ll:${OPEN}:earlier`, [{ ticket: { nf: OPEN_LOSE, entry: { kind: 'issue', contribution: { nf: OPEN_LOSE } } }, amountZat: 50000 }]);
      await p.goto(`${BASE}/${page}.html#c=${OPEN}&relay=${RELAY}`);
      await p.waitForSelector('#my-result:not([hidden])', { timeout: 30000 }).catch(() => {});
      check(`${page} page, a pay your bid auction of many items, one bid won and one not: "${await text(p, '#my-result-line')}"`, (await text(p, '#my-result-line')) === 'You won 1 item. You paid 0.0003 ZEC, 0.0004 ZEC came back to your wallet.');
      await ctx.close();
    }
    check('no page error', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
