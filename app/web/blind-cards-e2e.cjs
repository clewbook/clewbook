// Blind bid auctions where a campaign's type or goal is shown (the owner's bug of 21 Oct 2026: the home card said FUNDRAISER and "Goal null"),
// in a headless browser against the real relay serving app/web/testdata/bid-page (private chain data, no network): an open Blind bid auction,
// a closed one, and an ordinary auction that must look as before. Checks the home card and the closed list row, the campaign page's status and
// outcome, the bid page's back link and the recount page's facts.
// Run from the repository root with BIN=<folder with ll-relay>: node app/web/blind-cards-e2e.cjs
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const BIN = process.env.BIN || 'app/target-review/release';
const WEB = 8817, RELAY = 18797, R = `http://127.0.0.1:${RELAY}`;
const OPEN = '704e2910a0b57876256ec55fb0a0599bb4a54750889bd673f16a6e009d3cfab6', CLOSED = '720bdb00', AUCTION = '0e2fb4e0';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-cards-'));
  execSync(`cp -r app/web/testdata/bid-page/relay/. ${tmp}/`);
  const ids = fs.readdirSync(path.join(tmp, 'campaigns'));
  const full = (p) => ids.find((i) => i.startsWith(p));
  const relay = spawn(`${BIN}/ll-relay`, ['serve', '--allow-regtest', '--dir', tmp, '--listen', `127.0.0.1:${RELAY}`], { stdio: 'ignore' });
  const web = spawn('python3', ['-m', 'http.server', String(WEB), '--bind', '127.0.0.1', '--directory', 'app/web/www'], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const errors = [];
  const page = async () => { const p = await (await browser.newContext()).newPage(); p.on('pageerror', (e) => errors.push(String(e))); return p; };
  try {
    await sleep(1500);
    // the home page, its list replaced by the three test campaigns
    const home = await page();
    await home.route('**/campaigns.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ campaigns: [OPEN, full(CLOSED), full(AUCTION)].map((id) => ({ id, relays: [R] })) }) }));
    await home.addInitScript(() => { try { localStorage.setItem('cb-intro-seen', '1'); } catch { /* ignore */ } });
    await home.goto(`http://127.0.0.1:${WEB}/`);
    await home.waitForSelector('#live .camp', { timeout: 60000 });
    await home.waitForTimeout(1500);
    const cards = await home.$$eval('#live .camp', (cs) => cs.map((c) => ({ type: c.querySelector('.c-type').textContent, terms: c.querySelector('.c-terms').textContent, href: c.href })));
    const blind = cards.find((c) => c.href.includes(OPEN)), auc = cards.find((c) => c.href.includes(full(AUCTION)));
    check('home card: a Blind bid auction says BLIND BID', blind && blind.type === 'BLIND BID', JSON.stringify(blind));
    check('home card: items and deposit sizes, no goal', blind && /^2 items · deposits [\d.]+ \/ [\d.]+ \S+$/.test(blind.terms) && !/goal|null/i.test(blind.terms), blind && blind.terms);
    check('home card: an ordinary auction is unchanged', auc && auc.type === 'AUCTION' && /^1 item/.test(auc.terms), JSON.stringify(auc));
    const row = await home.$eval('#closed .crow', (r) => ({ kind: r.querySelector('.cr-kind').textContent, terms: r.querySelector('.cr-terms').textContent, out: r.querySelector('.cr-out').textContent }));
    check('home closed list: Blind bid, deposit sizes, auction settled', row.kind === 'Blind bid' && /deposits [\d.]+ \/ [\d.]+/.test(row.terms) && !/goal|null/i.test(row.terms) && /auction settled/.test(row.out), JSON.stringify(row));
    // the campaign page of the closed auction: its status and outcome name the settled auction
    const cp = await page();
    await cp.goto(`http://127.0.0.1:${WEB}/campaign.html#c=${full(CLOSED)}&relay=${R}`);
    await cp.waitForFunction(() => /CLOSED/.test(document.querySelector('#status-chip').textContent), null, { timeout: 60000 });
    await cp.waitForTimeout(1500);
    const chip = await cp.textContent('#status-chip'), main = (await cp.textContent('main')).replace(/\s+/g, ' ');
    check('campaign page: CLOSED · AUCTION SETTLED', /CLOSED · AUCTION SETTLED/.test(chip), chip);
    const odd = main.replace(/the amount in a fundraiser/g, '').match(/.{0,40}(Closed: finished|OUTCOME\s*finished|fundraiser|goal).{0,40}/gi);
    check('campaign page: the outcome and the closed note say settled', /OUTCOME\s*settled/i.test(main) && /Closed: auction settled/.test(main) && !odd, odd ? odd.join(' || ') : '');
    // the bid page's back link names the type
    const bp = await page();
    await bp.goto(`http://127.0.0.1:${WEB}/bid.html#c=${OPEN}&relay=${R}`);
    check('bid page: back link as the design handoff has it', (await bp.textContent('#flow-back')).trim() === '← Auction');
    // the recount page counts the checks of a Blind bid auction too
    const rp = await page();
    await rp.goto(`http://127.0.0.1:${WEB}/recount.html`);
    check('recount page: 10 checks for a blind bid auction', /10 for a blind bid auction/.test(await rp.textContent('.rfacts')));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('the test ran to the end', false, String(e).slice(0, 300));
  } finally {
    await browser.close();
    relay.kill(); web.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
})();
