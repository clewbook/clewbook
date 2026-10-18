// The refund amount check on the contributor page, for auctions as well as fundraisers. Runs the real ticket check of the browser module
// (pkg/ll_web.js, verify_ticket) on a real version 2 ticket (app/ticketcheck/src/testdata/ticket-v2.json: a 1,000,000 zatoshi contribution
// refunded as 990,000) with the page's own rule for the expected refund (ui.js expectedRefundZat). A ticket that pays back less than the
// bid minus the fee must fail "pays you"; a correct one and an overpaid bid pass; the fundraiser path is unchanged.
// Plain files from app/web/www on a spare port; no chain server, no relay, no money. Env: PORT (default 8808).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const PORT = process.env.PORT || '8808', BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const T = JSON.parse(fs.readFileSync('app/ticketcheck/src/testdata/ticket-v2.json', 'utf8'));

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', 'app/web/www'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  const browser = await chromium.launch();
  const p = await (await browser.newContext()).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  try {
    await p.goto(`${BASE}/brand.js`); // any file of this origin, so the modules below load from it
    const run = (c) => p.evaluate(async ({ t, c }) => {
      const W = await import('/pkg/ll_web.js');
      await W.default();
      const { expectedRefundZat } = await import('/ui.js');
      const opening = { action: t.action, value_zat: t.value_zat, rseed: t.rseed };
      const expected = expectedRefundZat(c.listed, c.intended, opening.value_zat, t.fee_zat);
      const out = JSON.parse(W.verify_ticket(JSON.stringify({
        raw_hex: t.raw_hex, expected_txid: t.txid, ticket_branch: t.branch, contribution_nf: t.nf, fee_zat: t.fee_zat,
        current_branch: t.branch, scanned_to: 4471000, spent: null, known_txids: [t.txid],
        listed_contribution_zat: c.listed, intended_contribution_zat: c.intended, paid_zat: null,
        opening, refund_receiver_hex: t.receiver_hex, expected_value_zat: expected,
      })));
      const pays = out.checks.find((x) => x.id === 'pays_you');
      return { expected, verdict: out.verdict, pays: pays.status, detail: pays.detail };
    }, { t: T, c });

    // auction: the list hides the amount; the page knows the amount it asked the contributor to pay
    let r = await run({ listed: null, intended: 1_000_000 });
    check('auction, a correct ticket (bid 1,000,000, refund 990,000): passes', r.verdict === 'pass' && r.pays === 'pass' && r.expected === 990000, JSON.stringify(r));
    r = await run({ listed: null, intended: 1_500_000 });
    check('auction, a ticket that pays back less than the bid minus the fee (bid 1,500,000, refund 990,000): fails "pays you"',
      r.verdict === 'fail' && r.pays === 'fail' && /pays you 990000 zatoshi but your contribution minus the fee is 1490000/.test(r.detail), JSON.stringify(r));
    r = await run({ listed: null, intended: 1_000_001 });
    check('auction, one zatoshi short: fails', r.verdict === 'fail' && r.pays === 'fail', JSON.stringify(r));
    r = await run({ listed: null, intended: 900_000 });
    check('auction, the contributor paid more than asked (asked 900,000, refund 990,000): passes, the whole payment is refunded', r.verdict === 'pass' && r.pays === 'pass' && r.expected === 990000, JSON.stringify(r));
    r = await run({ listed: null, intended: null });
    check('auction, the amount is not known on this device: not compared, as before', r.verdict === 'pass' && r.pays === 'pass' && r.expected === null, JSON.stringify(r));
    // fundraiser: unchanged, exactly the listed contribution minus the fee
    r = await run({ listed: 1_000_000, intended: 1_000_000 });
    check('fundraiser, a correct ticket: passes (unchanged)', r.verdict === 'pass' && r.pays === 'pass' && r.expected === 990000, JSON.stringify(r));
    r = await run({ listed: 1_100_000, intended: 1_100_000 });
    check('fundraiser, the list shows more than the ticket refunds: fails (unchanged)', r.verdict === 'fail' && r.pays === 'fail', JSON.stringify(r));
  } catch (e) {
    console.log('TEST ERROR', e);
    failed++;
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  srv.kill();
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
