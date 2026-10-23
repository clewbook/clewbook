// Level 4, the ticket's chain state (anchor), in a real browser against the two public test network chain servers: a real refund ticket
// (ticketcheck/src/testdata/ticket-v1.json, testnet, 6 Oct 2026) is found at a real block by both servers; a fake anchor is absent from every
// block of the range, which fails; a second server that does not answer, or that answers a different note tree, leaves a fake anchor "not
// checked" (never a failure), and a real anchor found by one server is a pass "with 1 of 2 servers"; the ticket checks turn each answer
// into pass, fail or not checked; and the bid page runs the check only before its tickets are checked, so a PROTECTED bid is never
// re-judged. Serves app/web/www itself; no money.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const fs = require('fs'), path = require('path'), http = require('http');
const WWW = path.join(__dirname, 'www'), ROOT = path.join(__dirname, '..');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  ' + extra : ''}`); if (!ok) failed++; };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const f = path.join(WWW, path.normalize(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'ticketcheck/src/testdata/ticket-v1.json'), 'utf8'));
const A = 'https://zjs.zec.rocks/testnet', B = 'https://zcash-testnet.chainsafe.dev', DEAD = 'http://127.0.0.1:9', TWISTED = 'https://twisted.chain.test';

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const p = await (await browser.newContext()).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  // a second server that answers every note tree question with the tree of a block 50,000 later (a different root): it disagrees
  await p.route(`${TWISTED}/**`, async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-grpc-web', 'access-control-allow-methods': 'POST' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    try {
    const body = Buffer.from(route.request().postDataBuffer());
    // the request is a BlockId { height = 1 } after the 5 byte frame header: read the height, ask for a much later block's tree instead
    let i = 6, h = 0, m = 1, x; do { x = body[i++]; h += (x & 0x7f) * m; m *= 128; } while (x & 0x80);
    const v = []; let n = h + 50000; while (n > 127) { v.push((n % 128) | 128); n = Math.floor(n / 128); } v.push(n);
    const req = Buffer.from([0, 0, 0, 0, v.length + 1, 0x08, ...v]);
    const res = await fetch(`${A}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTreeState`, { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' }, body: req });
    await route.fulfill({ status: 200, headers: { 'content-type': 'application/grpc-web+proto', ...cors }, body: Buffer.from(await res.arrayBuffer()) });
    } catch (e) { console.log('twisted server error:', String(e)); await route.abort(); }
  });
  await p.goto(`${BASE}/brand.js`);
  const r = await p.evaluate(async ({ fx, A, B, DEAD, TWISTED }) => {
    const W = await import('/pkg/ll_web.js'); await W.default();
    const { findAnchor } = await import('/anchor.js');
    const { grpcWeb } = await import('/recount.js');
    const [raw] = await grpcWeb(A, 'GetTransaction', W.tx_filter_request(fx.contribution_txid));
    let i = 0; const key = () => raw[i++];
    let height = null;
    while (i < raw.length) { const k = key(), f = k >> 3, wt = k & 7; if (wt === 2) { let len = 0, s = 0, b; do { b = raw[i++]; len |= (b & 0x7f) << s; s += 7; } while (b & 0x80); i += len; } else { let v = 0, m = 1, b; do { b = raw[i++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); if (f === 2) height = v; } }
    const real = () => W.ticket_anchor(fx.raw_hex), fake = () => 'ab'.repeat(32);
    const out = { height, anchor: real() };
    out.both = await findAnchor(W, [A, B], real, height, height + 3, height + 120);
    out.fakeBoth = await findAnchor(W, [A, B], fake, height, height + 3, height + 12);
    out.fakeDead = await findAnchor(W, [A, DEAD], fake, height, height + 3, height + 12);
    out.realDead = await findAnchor(W, [A, DEAD], real, height, height + 3, height + 120);
    out.fakeTwisted = await findAnchor(W, [A, TWISTED], fake, height, height + 3, height + 6);
    const rootAt = async (srv, h) => { try { const m = await grpcWeb(srv, 'GetTreeState', W.tree_state_request(h)); return W.ironwood_root(m[0]); } catch (e) { return 'ERR ' + String(e.message || e); } };
    out.twistedRoots = [await rootAt(A, height + 4), await rootAt(TWISTED, height + 4)];
    out.unreadable = await findAnchor(W, [A, B], () => W.ticket_anchor('00'), height, height, height + 2);
    out.tooMany = await findAnchor(W, [A, B], fake, height, height, height + 12, 5);
    const verify = (anchor) => JSON.parse(W.verify_ticket(JSON.stringify({ raw_hex: fx.raw_hex, expected_txid: fx.txid, ticket_branch: fx.branch, contribution_nf: fx.nf, fee_zat: 10000, current_branch: '77190ad9', known_txids: [fx.txid], anchor }))).checks.find((c) => c.id === 'anchor');
    out.v = { found: verify(out.both), absent: verify(out.fakeBoth), none: verify(out.fakeDead), one: verify(out.realDead) };
    return out;
  }, { fx, A, B, DEAD, TWISTED });
  console.log(`the payment of the fixture's ticket was mined in block ${r.height}; the ticket's anchor ${r.anchor.slice(0, 16)}…`);
  check('a real ticket: its anchor is the note tree of a real block, as both servers say', r.both && r.both.seen === 'found' && r.both.servers === 2 && r.both.height >= r.height, JSON.stringify(r.both));
  check('a fake anchor: absent from every block of the range, both servers answering every block', r.fakeBoth && r.fakeBoth.seen === 'absent' && r.fakeBoth.from === r.height && r.fakeBoth.to === r.height + 12, JSON.stringify(r.fakeBoth));
  check('a second server that does not answer: a fake anchor is not checked, never failed', r.fakeDead === null, JSON.stringify(r.fakeDead));
  check('a second server that does not answer: a real anchor is found "with 1 of 2 servers"', r.realDead && r.realDead.seen === 'found' && r.realDead.servers === 1 && r.realDead.height === r.both.height, JSON.stringify(r.realDead));
  check('a second server that answers other note trees: it does answer, with a different root', r.twistedRoots[1] && !/^ERR/.test(r.twistedRoots[1]) && r.twistedRoots[0] !== r.twistedRoots[1], JSON.stringify(r.twistedRoots));
  check('a second server that answers other note trees: the servers disagree, so a fake anchor is not checked', r.fakeTwisted === null, JSON.stringify(r.fakeTwisted));
  check('a ticket whose anchor cannot be read: not checked', r.unreadable === null);
  check('more blocks than the page may ask: not checked', r.tooMany === null);
  check('the ticket checks: found is a pass naming the block and both servers', r.v.found.status === 'pass' && r.v.found.detail.includes(`block ${r.both.height}`) && /both chain servers/.test(r.v.found.detail), r.v.found.detail);
  check('the ticket checks: absent is a fail naming the range', r.v.absent.status === 'fail' && r.v.absent.detail.includes(String(r.height)), r.v.absent.detail);
  check('the ticket checks: no sure answer is not checked', r.v.none.status === 'not_checked', r.v.none.detail);
  check('the ticket checks: found by one server is a pass "with 1 of 2 servers"', r.v.one.status === 'pass' && /1 of 2/.test(r.v.one.detail), r.v.one.detail);
  // the bid page: the check is part of the ticket checks that run once, before PROTECTED; a page whose tickets are checked never runs them again
  const bid = fs.readFileSync(path.join(WWW, 'bid.js'), 'utf8');
  const once = /if \(state && state\.ticket && !state\.ticketsChecked\) await checkTickets\(\);/.test(bid);
  const inside = bid.indexOf('findAnchor(') > bid.indexOf('async function checkTickets()') && bid.indexOf('findAnchor(') < bid.indexOf('state.ticketsChecked = {');
  check('the bid page asks for the anchor only inside its one time ticket checks, so an already PROTECTED bid is never re-judged', once && inside && (bid.match(/findAnchor\(/g) || []).length === 1);
  check('no page error', errors.length === 0, errors.join(' | '));
  await browser.close();
  server.close();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
