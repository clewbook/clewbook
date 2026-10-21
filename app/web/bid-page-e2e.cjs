// The sealed bid page (app/web/www/bid.html) in a real browser, with the real relay serving the public lists of three auctions from the
// private regtest chain (app/web/testdata/bid-page: N, whose host never closed; U, closed with uniform price; an ordinary auction) and a
// stand in for the chain server that answers the light wallet calls the page makes from the same chain's data (tip and block times set
// by the test; N's coin transaction and note trees from app/web/testdata/sealed-late.json). No public network, no money.
// It checks: the contribute page sends a sealed auction to the bid page and keeps every other campaign; the bid form refuses an auction
// whose timing is no longer safe; the payment card; the states up to PROTECTED (ticket found, coin checked, late ticket checked against
// the chain, proof verified, signed); "take my money back" sends the early ticket; a coin that does not pay this page leaves the payer
// NOT PROTECTED with the button; after the late ticket block with no close, "send my late ticket" sends the signed late ticket; a closed
// auction shows the result. Run from the repository root with BIN=<folder with ll-relay>: node app/web/bid-page-e2e.cjs
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const BIN = process.env.BIN || 'app/target-sealed/release';
const WWW = process.env.WWW || 'app/web/www';
const WEB = 8812, RELAY = 18797, CHAIN = 18798;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const FX = JSON.parse(fs.readFileSync('app/web/testdata/bid-page/fixture.json', 'utf8'));
const LATE = JSON.parse(fs.readFileSync('app/web/testdata/sealed-late.json', 'utf8'));

// ---------- protobuf, just enough ----------
function varint(n) { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; }
const fv = (f, n) => [...varint((f << 3) | 0), ...varint(n)];
const fb = (f, bytes) => [...varint((f << 3) | 2), ...varint(bytes.length), ...bytes];
function fields(buf) { // field number -> list of values (numbers or byte arrays)
  const out = {}; let i = 0;
  const rv = () => { let v = 0n, s = 0n, b; do { b = buf[i++]; v |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); return v; };
  while (i < buf.length) {
    const k = Number(rv()), f = k >> 3, wt = k & 7;
    let v;
    if (wt === 0) v = Number(rv()); else if (wt === 2) { const n = Number(rv()); v = buf.subarray(i, i + n); i += n; } else break;
    (out[f] = out[f] || []).push(v);
  }
  return out;
}

// ---------- the stand in Noir extension, as in noir-e2e.cjs (cfg.flat: request on window.noirwallet itself; cfg.late: injected after a
// second with the init event; cfg.fail: the send throws) ----------
function stub(cfg) {
  const install = () => {
    window.__noirCalls = [];
    const request = async (r) => {
      window.__noirCalls.push(JSON.parse(JSON.stringify(r)));
      if (r.method === 'zcash_requestAccounts') return cfg.shape === 'pair' ? { transparent: 'tmTESTtransparent', shielded: cfg.address } : [{ address: cfg.address }];
      if (r.method === 'zcash_sendTransaction') {
        if (cfg.fail) { const e = new Error(cfg.fail.message); if (cfg.fail.code) e.code = cfg.fail.code; throw e; }
        return cfg.txid;
      }
      throw new Error('unknown method');
    };
    window.noirwallet = cfg.flat ? { isNoirWallet: true, request } : { isNoirWallet: true, zcash: { request } };
  };
  if (cfg.late) setTimeout(() => { install(); window.dispatchEvent(new Event('noirwallet#initialized')); }, 1000);
  else install();
}
const NOIR_TXID = 'ab'.repeat(32), TEST_ADDR = `utest1${'q'.repeat(100)}`, MAIN_ADDR = `u1${'q'.repeat(100)}`;

// ---------- the stand in chain ----------
const chain = { tip: 130, sent: [], coinGone: false, infoDown: false };
const timeOf = (h) => 1296688603 + h * 75;
const COIN_TXID = LATE.coin_entry.coin.txid;
function answer(method, req) {
  const F = fields(req);
  switch (method) {
    case 'GetLatestBlock': return { msgs: [fv(1, chain.tip)] };
    case 'GetBlockRange': {
      const s = fields(F[1][0])[1][0], e = fields(F[2][0])[1][0], msgs = [];
      for (let h = s; h <= e; h++) msgs.push([...fv(2, h), ...fv(5, timeOf(h))]);
      return { msgs };
    }
    case 'GetTransaction': {
      const hash = Buffer.from(F[3][0]).toString('hex'), rev = Buffer.from(F[3][0]).reverse().toString('hex');
      if ((hash !== COIN_TXID && rev !== COIN_TXID) || chain.coinGone) return { status: 5, msgs: [] };
      return { msgs: [[...fb(1, Buffer.from(LATE.coin_tx.hex, 'hex')), ...fv(2, LATE.coin_tx.height)]] };
    }
    case 'GetTreeState': {
      const h = fields(req)[1][0], t = LATE.ironwood_trees[String(h)];
      if (!t) return { status: 5, msgs: [] };
      return { msgs: [[...fv(2, h), ...fb(7, Buffer.from(t.state))]] };
    }
    // the network version and height (the page checks the tickets were built for the version in use now)
    case 'GetLightdInfo': return chain.infoDown ? { status: 14, msgs: [] } : { msgs: [[...fb(6, Buffer.from('77190ad9')), ...fv(7, chain.tip)]] };
    case 'SendTransaction': chain.sent.push(Buffer.from(F[1][0]).toString('hex')); return { msgs: [[...fv(1, 0), ...fb(2, Buffer.from('accepted'))]] };
    default: return { status: 12, msgs: [] };
  }
}
const chainServer = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-grpc-web,x-user-agent', 'access-control-expose-headers': 'grpc-status,grpc-message' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks), msg = body.subarray(5);
    const { msgs, status = 0 } = answer(req.url.split('/').pop(), msg);
    const frames = [];
    for (const m of msgs) { const b = Buffer.from(m), h = Buffer.alloc(5); h.writeUInt32BE(b.length, 1); frames.push(h, b); }
    const t = Buffer.from(`grpc-status:${status}\r\ngrpc-message:${status ? 'not found' : 'OK'}\r\n`), th = Buffer.alloc(5); th[0] = 0x80; th.writeUInt32BE(t.length, 1);
    frames.push(th, t);
    res.writeHead(200, { ...cors, 'content-type': 'application/grpc-web+proto' });
    res.end(Buffer.concat(frames));
  });
});

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bid-page-'));
  fs.cpSync('app/web/testdata/bid-page/relay', tmp, { recursive: true });
  const relay = spawn(`${BIN}/ll-relay`, ['serve', '--allow-regtest', '--dir', tmp, '--listen', `127.0.0.1:${RELAY}`], { stdio: 'ignore' });
  const web = spawn('python3', ['-m', 'http.server', String(WEB), '--bind', '127.0.0.1', '--directory', WWW], { stdio: 'ignore' });
  chainServer.listen(CHAIN, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 1500));
  let browser;
  try { browser = await chromium.launch(); } catch (e) { relay.kill(); web.kill(); chainServer.close(); fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  const link = (id) => `c=${id}&relay=http://127.0.0.1:${RELAY}&server=http://127.0.0.1:${CHAIN}`;
  const BASE = `http://127.0.0.1:${WEB}`;
  const errors = [];
  const fresh = async (noirCfg) => { const ctx = await browser.newContext(); if (noirCfg) await ctx.addInitScript(stub, noirCfg); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(String(e))); return { ctx, p }; };
  const text = (p, sel) => p.$eval(sel, (e) => (e.hidden ? '' : e.textContent));
  // the status line and what sits behind its "more" link
  const full = async (p) => `${await text(p, '#st-text')} ${await p.textContent('#st-more')}`;
  const waitTitle = (p, re, ms = 120000) => p.waitForFunction((r) => new RegExp(r).test(document.querySelector('#st-title').textContent), re.source, { timeout: ms });
  const withState = async (id, who, noirCfg) => {
    const { ctx, p } = await fresh(noirCfg);
    await p.goto(`${BASE}/brand.js`);
    await p.evaluate(({ id, s }) => localStorage.setItem(`ll:sealed:${id}`, JSON.stringify(s)), { id, s: who });
    await p.goto(`${BASE}/bid.html#${link(id)}`);
    return { ctx, p };
  };
  try {
    // the contribute page sends a sealed auction here and keeps the others
    let { ctx, p } = await fresh();
    await p.goto(`${BASE}/contribute.html#${link(FX.N)}`);
    await p.waitForURL(/bid\.html/, { timeout: 30000 }).catch(() => {});
    check('contribute.html sends a sealed auction to the bid page', /bid\.html/.test(p.url()));
    await p.goto(`${BASE}/contribute.html#${link(FX.ordinary)}`);
    await p.waitForTimeout(6000);
    check('contribute.html keeps an ordinary auction', /contribute\.html/.test(p.url()), p.url().slice(0, 60));
    await ctx.close();

    // the form: open before the last block for a deposit, closed after it
    chain.tip = 120;
    ({ ctx, p } = await fresh());
    await p.goto(`${BASE}/bid.html#${link(FX.N)}`);
    await p.waitForSelector('#form-card:not([hidden])', { timeout: 30000 });
    check('the bid form shows the deposit sizes', (await p.$$eval('#tranche option', (o) => o.length)) === 2);
    check('second review H1: before the payment the form says bids and refund addresses become public after the close (more: what the host sees)', /Bids and refund addresses become public after the close/.test(await text(p, '#public-note')) && /your refund address, never your bid/.test(await p.textContent('#public-more')), (await text(p, '#public-note')).slice(0, 120));
    // a private test chain's block times are not real, so the page judges only the last block for a deposit there (the real time check is
    // `Sealed::check_timing`, tested in cargo test -p ll-core)
    check('before the last block for a deposit the form is open', !(await p.$eval('#create', (b) => b.disabled)), (await text(p, '#bid-hint')).slice(0, 110));
    chain.tip = 130;
    await p.waitForFunction(() => /closed for new deposits/.test(document.querySelector('#bid-hint').textContent), null, { timeout: 30000 }).catch(() => {});
    check('after the last block for a deposit the form is closed', await p.$eval('#create', (b) => b.disabled) && /closed for new deposits/.test(await text(p, '#bid-hint')), (await text(p, '#bid-hint')).slice(0, 90));
    await ctx.close();

    // the payment card for a bid made but not yet ticketed
    ({ ctx, p } = await fresh());
    await p.goto(`${BASE}/brand.js`);
    const pay = await p.evaluate(async ({ id, refund }) => {
      const W = await import('/pkg/ll_web.js'); await W.default();
      const rules = await (await fetch(`http://127.0.0.1:18797/v1/campaigns/${id}`)).text();
      const seed = W.generate_seed(), p = JSON.parse(W.sealed_bid_payment(rules, seed, refund, 10000000, 7000000));
      const st = { seed, refund, tranche: 10000000, bid: 7000000, memo: p.memo, payTo: p.pay_to, pageKey: p.page_key, qrSvg: p.qr_svg, paidZat: null };
      localStorage.setItem(`ll:sealed:${id}`, JSON.stringify(st));
      return { ...p, st };
    }, { id: FX.N, refund: FX.refund_address });
    await p.goto(`${BASE}/bid.html#${link(FX.N)}`);
    await p.waitForSelector('#pay-card:not([hidden])', { timeout: 30000 });
    check('the payment card shows the version 3 memo and the deposit', (await text(p, '#memo')) === pay.memo && /0\.1/.test(await text(p, '#pay-amount')), (await text(p, '#pay-amount')));
    check('it waits for the deposit\'s ticket', /Waiting for your deposit/.test(await text(p, '#st-title')));
    await ctx.close();

    // Pay with Noir, with the stand in extension: without it nothing changes; with it the network is checked by the address prefix, exactly
    // the deposit address, amount and message shown are sent, the transaction ID is kept and the button is gone. This test's auctions are on
    // the private test chain, which the address check counts with the main network (as the contribute page does): u1 is the right prefix
    // here and utest1 the wrong one. A real send from Noir's test network build is not tried (it is expected to fail there).
    {
      const noirHidden = (p) => p.$eval('#noir-pay', (b) => b.hidden);
      ({ ctx, p } = await withState(FX.N, pay.st));
      await p.waitForSelector('#pay-card:not([hidden])', { timeout: 30000 });
      await p.waitForTimeout(3500);
      check('Noir: without the extension there is no Noir button', await noirHidden(p));
      await ctx.close();

      ({ ctx, p } = await withState(FX.N, pay.st, { address: TEST_ADDR, txid: NOIR_TXID }));
      await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 30000 });
      await p.click('#noir-pay');
      await p.waitForFunction(() => !document.querySelector('#noir-msg').hidden, null, { timeout: 15000 });
      let calls = await p.evaluate(() => window.__noirCalls);
      check('Noir: on the wrong network (by its address prefix) nothing is sent', /Nothing was sent/.test(await text(p, '#noir-msg')) && !calls.some((c) => c.method === 'zcash_sendTransaction') && !(await noirHidden(p)), await text(p, '#noir-msg'));
      await ctx.close();

      ({ ctx, p } = await withState(FX.N, pay.st, { address: MAIN_ADDR, txid: NOIR_TXID, shape: 'pair' }));
      await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 30000 });
      check('Noir: with the extension the button shows on the payment card', true);
      await p.click('#noir-pay');
      await p.waitForFunction(() => /Sent with Noir/.test(document.querySelector('#noir-msg').textContent), null, { timeout: 15000 });
      calls = await p.evaluate(() => window.__noirCalls);
      const sent = calls.find((c) => c.method === 'zcash_sendTransaction');
      const want = { to: await text(p, '#pay-to'), amount: await text(p, '#pay-amt'), memo: await text(p, '#memo') };
      check('Noir: it sends exactly the deposit address, amount and message shown', !!sent && JSON.stringify(sent.params) === JSON.stringify([want]) && want.to === pay.pay_to && want.amount === '0.1' && want.memo === pay.memo, JSON.stringify(sent && sent.params).slice(0, 120));
      const kept = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)).noirTxid, FX.N);
      check('Noir: the transaction ID is kept with the bid', kept === NOIR_TXID);
      check('Noir: the button hides itself after the send', await noirHidden(p));
      check('Noir: the page shows the transaction it waits for', (await text(p, '#st-facts')).includes(`Sent with Noir: transaction ${NOIR_TXID}`));
      await p.reload();
      await p.waitForSelector('#pay-card:not([hidden])', { timeout: 30000 });
      await p.waitForTimeout(1500);
      check('Noir: after a reload the button stays hidden (never twice)', await noirHidden(p));
      await ctx.close();

      ({ ctx, p } = await withState(FX.N, pay.st, { address: MAIN_ADDR, fail: { message: 'Transaction failed on this network' }, late: true, flat: true }));
      await p.waitForSelector('#noir-pay:not([hidden])', { timeout: 30000 });
      await p.click('#noir-pay');
      await p.waitForFunction(() => !document.querySelector('#noir-msg').hidden, null, { timeout: 15000 });
      const stored = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)), FX.N);
      check('Noir: a failed send (found late, on its init event) keeps the button and says to check before trying again', /could not complete/.test(await text(p, '#noir-msg')) && !(await noirHidden(p)) && !stored.noirTxid && !stored.noirSent, await text(p, '#noir-msg'));
      await ctx.close();
    }

    // n1 of N: ticket found, coin checked, late ticket checked and signed: PROTECTED
    chain.tip = 130;
    const n1 = { seed: FX.n1.seed, refund: FX.refund_address, tranche: FX.n1.tranche, bid: FX.n1.bid, memo: '', payTo: '', pageKey: null, paidZat: null };
    ({ ctx, p } = await fresh());
    await p.goto(`${BASE}/brand.js`);
    n1.pageKey = await p.evaluate(async (seed) => { const W = await import('/pkg/ll_web.js'); await W.default(); return W.page_key_hex(seed); }, n1.seed);
    await ctx.close();
    ({ ctx, p } = await withState(FX.N, n1));
    await waitTitle(p, /^PROTECTED$/);
    check('PROTECTED once the coin is in and the late ticket is checked and signed', true, (await text(p, '#st-text')).slice(0, 120));
    const late = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)).late, FX.N);
    check('the signed late ticket is kept, and is the one the list names', late && late.txid === LATE.coin_entry.late && late.signed_hex.length > 18000);
    check('the take my money back button is offered', !(await p.$eval('#take-back', (b) => b.hidden)));
    const before = chain.sent.length;
    await p.click('#take-back');
    await p.waitForFunction(() => /on its way back/.test(document.querySelector('#st-title').textContent), null, { timeout: 30000 });
    check('take my money back sends the early ticket', chain.sent.length === before + 1 && chain.sent[before].length > 1000);
    await ctx.close();

    // H4: before PROTECTED the page checks the early ticket and the signed refund in full: a ticket that does not pay this page's refund
    // address (as a cheating host would make it) is caught, and no take back button is offered for a ticket that does not check out
    {
      const other = JSON.parse(fs.readFileSync('app/web/testdata/bid-reject/fixture.json', 'utf8')).a3.refund;
      chain.tip = 130;
      ({ ctx, p } = await withState(FX.N, { ...n1, refund: other }));
      await waitTitle(p, /NOT PROTECTED: a ticket does not check out/, 180000);
      const t = await full(p);
      check('H4: an early ticket that does not pay this page\'s refund address is NOT PROTECTED, with no take back', /the early ticket/.test(t) && await p.$eval('#take-back', (b) => b.hidden), t.slice(0, 160));
      await ctx.close();
    }

    // L4: a page opened again checks the host's small payment is still on the chain (a reorganised chain can drop it)
    {
      chain.tip = 130;
      ({ ctx, p } = await withState(FX.N, n1));
      await waitTitle(p, /^PROTECTED$/);
      const saved = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)), FX.N);
      await ctx.close();
      chain.coinGone = true;
      ({ ctx, p } = await withState(FX.N, saved));
      await waitTitle(p, /NOT PROTECTED after the deadline/, 60000).catch(() => {});
      const t = await text(p, '#st-text');
      check('L4: reopened after the coin left the chain, PROTECTED becomes NOT PROTECTED, with the take back button', /gone from the chain/.test(t) && !(await p.$eval('#take-back', (b) => b.hidden)), t.slice(0, 140));
      chain.coinGone = false;
      await ctx.close();
    }

    // M3: before the host's small payment the page says plainly to keep it open until PROTECTED, and warns from 15 blocks before the
    // cutoff (the list shown without its coin entries: a valid signed list cut before them)
    for (const [at, re, what] of [[130, /Waiting for the host's small payment/, 'early on'], [140, /Not protected yet, and the cutoff is close/, '8 blocks before the cutoff']]) {
      chain.tip = at;
      const { ctx: c3, p: q } = await fresh();
      await c3.route(`http://127.0.0.1:${RELAY}/v1/campaigns/${FX.N}/ledger*`, async (route) => {
        const r = await route.fetch(); const l = await r.json(); const i = l.findIndex((e) => e.kind === 'coin');
        await route.fulfill({ response: r, body: JSON.stringify(i < 0 ? l : l.slice(0, i)) });
      });
      await q.goto(`${BASE}/brand.js`);
      await q.evaluate(({ id, s }) => localStorage.setItem(`ll:sealed:${id}`, JSON.stringify(s)), { id: FX.N, s: n1 });
      await q.goto(`${BASE}/bid.html#${link(FX.N)}`);
      await waitTitle(q, re, 180000).catch(() => {});
      const t = await text(q, '#st-text');
      check(`M3: ${what} the page says to keep it open until PROTECTED${at === 140 ? ', warns, and offers the take back' : ''}`, re.test(await text(q, '#st-title')) && /Keep this page open/.test(t) && (at !== 140 || !(await q.$eval('#take-back', (b) => b.hidden))), `${await text(q, '#st-title')}: ${t.slice(0, 120)}`);
      await c3.close();
    }
    chain.tip = 130;

    // item 3 of the owner's list: the page closed before the host's small payment arrives, opened again (same browser) after it is mined and
    // before the deadline: it checks and signs the late ticket by itself, with no tap
    {
      chain.tip = 118; // before the coin's block (120)
      const ctx3 = await browser.newContext(); ctx3.on('page', (pg) => pg.on('pageerror', (e) => errors.push(String(e))));
      const q = await ctx3.newPage();
      await q.goto(`${BASE}/brand.js`);
      await q.evaluate(({ id, s }) => localStorage.setItem(`ll:sealed:${id}`, JSON.stringify(s)), { id: FX.N, s: n1 });
      await q.goto(`${BASE}/bid.html#${link(FX.N)}`);
      await waitTitle(q, /Not protected after the deadline yet|Waiting for the host/, 120000).catch(() => {});
      const before = await q.textContent('#st-title');
      const lateBefore = await q.evaluate((id) => !!JSON.parse(localStorage.getItem(`ll:sealed:${id}`)).late, FX.N);
      await q.close(); // the person closes the page
      chain.tip = 130; // the coin is mined, the deadline (158) is ahead
      const q2 = await ctx3.newPage();
      let clicks = 0;
      await q2.exposeFunction('__click', () => { clicks += 1; });
      await q2.addInitScript(() => document.addEventListener('click', () => window.__click(), true));
      await q2.goto(`${BASE}/bid.html#${link(FX.N)}`);
      await waitTitle(q2, /^PROTECTED$/, 180000).catch(() => {});
      const late = await q2.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)).late, FX.N);
      check('item 3: closed before the coin, reopened after it is mined: the page signs the late ticket by itself (no tap) and says PROTECTED',
        !lateBefore && /^PROTECTED$/.test(await q2.textContent('#st-title')) && late && late.txid === LATE.coin_entry.late && clicks === 0, `before: ${before}; clicks ${clicks}`);
      await ctx3.close();
    }

    // second review L2: when the chain server cannot say which network version it runs, the page waits and asks again; it never saves that
    // as a failed ticket
    {
      chain.tip = 130; chain.infoDown = true;
      ({ ctx, p } = await withState(FX.N, n1));
      await p.waitForTimeout(20000);
      const t1 = await p.textContent('#st-title');
      const saved = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)).ticketsChecked || null, FX.N);
      chain.infoDown = false;
      await waitTitle(p, /^PROTECTED$/, 120000).catch(() => {});
      check('second review L2: with no answer on the network version the page keeps checking (nothing saved), then says PROTECTED once it can ask', /Checking your tickets/.test(t1) && saved === null && /^PROTECTED$/.test(await p.textContent('#st-title')), `${t1} → ${await p.textContent('#st-title')}`);
      await ctx.close();
    }

    // second review L3: a proof checker that cannot load answers no: the page says NOT PROTECTED instead of checking for ever
    {
      chain.tip = 130;
      const { ctx: c6, p: q } = await fresh();
      await c6.route('**/proof/ll_proofcheck*', (r) => r.fulfill({ status: 404, body: 'gone' }));
      await q.goto(`${BASE}/brand.js`);
      await q.evaluate(({ id, s }) => localStorage.setItem(`ll:sealed:${id}`, JSON.stringify(s)), { id: FX.N, s: n1 });
      await q.goto(`${BASE}/bid.html#${link(FX.N)}`);
      await waitTitle(q, /NOT PROTECTED/, 120000).catch(() => {});
      const more = await q.textContent('#st-more');
      check('second review L3: when the proof checker fails to load, the page says NOT PROTECTED (its proof does not verify) and does not wait for ever', /NOT PROTECTED/.test(await q.textContent('#st-title')) && /proof does not verify/.test(more), `${await q.textContent('#st-title')}: ${more.slice(0, 120)}`);
      await c6.close();
    }

    // second review M4: an auction whose rules say "regtest" opens only on the computer that runs that chain; from any other address the page
    // refuses it (so "regtest" cannot switch off the test network's checks)
    {
      const b2 = await chromium.launch({ args: ['--host-resolver-rules=MAP pages.example 127.0.0.1'] });
      const q = await (await b2.newContext()).newPage();
      await q.goto(`http://pages.example:${WEB}/bid.html#${link(FX.N)}`);
      await q.waitForFunction(() => document.querySelector('#banners').textContent.length > 0, null, { timeout: 60000 }).catch(() => {});
      const shown = await q.textContent('#banners');
      check('second review M4: a regtest auction opened from another address is refused, with the reason', /private test chain and opens only on the computer that runs it/.test(shown) && await q.$eval('#form-card', (e) => e.hidden), shown.slice(0, 140));
      await b2.close();
    }

    // second review L4: a crafted backup file whose payment code carries script; restoring it must run nothing
    {
      const hostile = path.join(tmp, 'hostile-backup.json');
      const evil = `<img src=x onerror="window.__pwned='img'"><svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwned='svg'"><script>window.__pwned='script'</script></svg>`;
      fs.writeFileSync(hostile, JSON.stringify({ kind: 'sealed-bid-backup', version: 1, campaign: FX.N, state: { seed: FX.n1.seed, refund: FX.refund_address, tranche: FX.n1.tranche, bid: FX.n1.bid, memo: 'LL3:x.y', payTo: 'zregtestpayto', pageKey: 'x', qrSvg: evil, paidZat: null } }));
      const { ctx: c4, p: q } = await fresh();
      await q.goto(`${BASE}/bid.html#${link(FX.N)}`);
      await q.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
      await q.setInputFiles('#restore', hostile);
      await q.waitForSelector('#pay-card:not([hidden])', { timeout: 30000 });
      await q.waitForTimeout(1500);
      const r = await q.evaluate(() => ({ pwned: window.__pwned || null, tags: [...document.querySelectorAll('#qr *')].map((e) => e.tagName) }));
      check('second review L4: a crafted backup file restores without running its script (the code is shown as an image)', r.pwned === null && r.tags.length === 1 && r.tags[0] === 'IMG', JSON.stringify(r));
      const bad = path.join(tmp, 'bad-backup.json');
      fs.writeFileSync(bad, JSON.stringify({ kind: 'sealed-bid-backup', version: 1, campaign: FX.N, state: { seed: '<b>x</b>', refund: FX.refund_address, memo: 'LL3:x' } }));
      const { ctx: c5, p: q2 } = await fresh();
      await q2.goto(`${BASE}/bid.html#${link(FX.N)}`);
      await q2.waitForSelector('#form-card:not([hidden])', { timeout: 60000 });
      await q2.setInputFiles('#restore', bad);
      await q2.waitForFunction(() => !document.querySelector('#restore-error').hidden, null, { timeout: 15000 }).catch(() => {});
      check('second review L4: a backup file with a malformed key is refused', /not a backup of a bid in this auction/.test(await q2.textContent('#restore-error')) && await q2.$eval('#pay-card', (e) => e.hidden));
      await c4.close(); await c5.close();
    }

    // a coin that does not pay this page: NOT PROTECTED, with the button
    ({ ctx, p } = await withState(FX.N, { ...n1, pageKey: `02${'33'.repeat(32)}` }));
    await waitTitle(p, /NOT PROTECTED/);
    check('a coin that does not pay this page leaves the payer not protected, with the button', !(await p.$eval('#take-back', (b) => b.hidden)), (await text(p, '#st-text')).slice(0, 110));
    await ctx.close();

    // a deposit mined after the coin cutoff: the page tells the person plainly to take the money back now
    {
      const rel = await fetch(`http://127.0.0.1:${RELAY}/v1/campaigns/${FX.N}/ledger?from=0`).then((r) => r.json());
      // this page's own deposit (the page opens and checks its tickets, so they must be sealed to it)
      const { ctx: c2, p: q } = await fresh();
      await q.goto(`${BASE}/brand.js`);
      const mine = await q.evaluate(async ({ issues, seed, relay, id }) => {
        const W = await import('/pkg/ll_web.js'); await W.default();
        for (const e of issues) {
          const b = new Uint8Array(await (await fetch(`${relay}/v1/campaigns/${id}/tickets/${e.contribution.nf}`)).arrayBuffer());
          if (W.blob_is_mine(seed, b)) return e.contribution.nf;
        }
        return null;
      }, { issues: rel.filter((e) => e.kind === 'issue'), seed: n1.seed, relay: `http://127.0.0.1:${RELAY}`, id: FX.N });
      await c2.close();
      const issue = rel.find((e) => e.kind === 'issue' && e.contribution.nf === mine);
      const rulesN = JSON.parse(fs.readFileSync(path.join(tmp, 'campaigns', FX.N, 'rules.json'), 'utf8'));
      const late = JSON.parse(JSON.stringify(issue));
      late.contribution.height = rulesN.deadline_height - rulesN.sealed.coin_cutoff + 1;
      const blob = Buffer.from(await (await fetch(`http://127.0.0.1:${RELAY}/v1/campaigns/${FX.N}/tickets/${issue.contribution.nf}`)).arrayBuffer()).toString('hex');
      chain.tip = 130;
      ({ ctx, p } = await withState(FX.N, { ...n1, pageKey: `02${'44'.repeat(32)}`, ticket: { nf: issue.contribution.nf, entry: late, blob_hex: blob } }));
      await waitTitle(p, /Take your money back now/, 180000);
      const t = await full(p);
      check('a deposit after the coin cutoff is told to take the money back now, with the button', /does not count/.test(t) && /no late ticket/.test(t) && !(await p.$eval('#take-back', (b) => b.hidden)), t.slice(0, 120));
      await ctx.close();
    }

    // after the late ticket block with no close: send the late ticket
    const hs = JSON.parse(fs.readFileSync(path.join(tmp, 'campaigns', FX.N, 'rules.json'), 'utf8')).sealed.claim_after;
    chain.tip = 130;
    ({ ctx, p } = await withState(FX.N, n1));
    await waitTitle(p, /^PROTECTED$/);
    chain.tip = hs + 2;
    await waitTitle(p, /did not finish/, 30000);
    check('after the late ticket block with no close the page offers the late ticket', !(await p.$eval('#send-late', (b) => b.hidden)));
    const b2 = chain.sent.length;
    await p.click('#send-late');
    await p.waitForFunction(() => /deposit is on its way back/.test(document.querySelector('#st-title').textContent), null, { timeout: 30000 });
    const sentLate = chain.sent[b2] || '';
    const kept = await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)).late.signed_hex, FX.N);
    check('send my late ticket sends the signed late ticket', sentLate === kept);
    await ctx.close();

    // the take back margin (L5): Zebra drops a transaction once the tip reaches its expiry height (deadline - 2 with 1 of safety), zcashd
    // refuses one whose next block + 3 passes its expiry (deadline - 4): the page offers it until block deadline - 4
    {
      const d = JSON.parse(fs.readFileSync(path.join(tmp, 'campaigns', FX.N, 'rules.json'), 'utf8')).deadline_height;
      chain.tip = d - 4;
      ({ ctx, p } = await withState(FX.N, n1));
      await waitTitle(p, /^PROTECTED$/);
      check('margin: at block deadline minus 4 the take back button is offered, with that block', !(await p.$eval('#take-back', (b) => b.hidden)) && new RegExp(`until block ${d - 4}`).test(await text(p, '#st-text')), (await text(p, '#st-text')).slice(0, 120));
      await ctx.close();
      chain.tip = d - 3;
      ({ ctx, p } = await withState(FX.N, n1));
      await waitTitle(p, /^PROTECTED$/);
      check('margin: at block deadline minus 3 it is gone, and the page no longer promises it', await p.$eval('#take-back', (b) => b.hidden) && !/early ticket until/.test(await text(p, '#st-text')), (await text(p, '#st-text')).slice(0, 140));
      await ctx.close();
      // an early ticket the network never mined: after the deadline the page says so, and the deposit is still in the auction
      chain.tip = d + 1;
      ({ ctx, p } = await withState(FX.N, { ...n1, earlySent: 'ee'.repeat(32) }));
      await p.waitForFunction(() => /not mined before it expired/.test(document.querySelector('#st-facts').textContent), null, { timeout: 60000 }).catch(() => {});
      check('an early ticket not mined by the deadline: the page says so and does not claim the money is back', /not mined before it expired/.test(await text(p, '#st-facts')) && !/on its way back|is back/.test(await text(p, '#st-title')), await text(p, '#st-title'));
      await ctx.close();
      // one the chain shows mined (the stand in chain knows one mined transaction, the coin's): the money is back
      chain.tip = d - 3;
      ({ ctx, p } = await withState(FX.N, { ...n1, earlySent: COIN_TXID }));
      await waitTitle(p, /Your money is back/, 60000).catch(() => {});
      check('an early ticket the chain shows mined: the page says the money is back', /Your money is back/.test(await text(p, '#st-title')), await text(p, '#st-title'));
      await ctx.close();
      chain.tip = 130;
    }

    // U, closed with uniform price: u1 won
    chain.tip = 200;
    ({ ctx, p } = await withState(FX.U, { seed: FX.u1.seed, refund: FX.refund_address, tranche: FX.u1.tranche, bid: FX.u1.bid, memo: '', payTo: '', pageKey: 'x', paidZat: null }));
    await waitTitle(p, /won|did not win/, 60000);
    check('a closed auction shows the result: u1 won and pays the uniform price', /won/.test(await text(p, '#st-title')) && /0\.08/.test(await text(p, '#st-text')), await text(p, '#st-text'));
    await ctx.close();
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  } catch (e) {
    check('run', false, String(e).slice(0, 300));
  } finally {
    await browser.close();
    relay.kill(); web.kill(); chainServer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
