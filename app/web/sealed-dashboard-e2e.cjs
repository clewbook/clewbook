// The host's set up page and dashboard for a sealed bid auction, in a headless browser against the host dashboard running on a private
// regtest chain (started by app/regtest/check-dashboard.sh, which sets RUN, CHAIN and BIN). It creates the auction on the set up page,
// funds the coin wallet the dashboard shows, places two bids, waits for the deposits and their small payments on the dashboard, closes the
// auction from the dashboard after the deadline, and waits for the settlement, the refund and the viewing key, with the self check passing.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const { RUN, CHAIN, BIN } = process.env;
const BASE = 'http://127.0.0.1:8790', LWD = '127.0.0.1:19067';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 900000, shell: '/bin/bash' }).trim();
const mine = (n) => sh(`${CHAIN} mine ${n}`);
const tip = () => Number(sh(`${CHAIN} tip`));
function send(to, zat, memo) {
  sh(`timeout 600 ${BIN}/zcash-devtool wallet -w ${RUN}/w/funder sync -s ${LWD} >/dev/null 2>&1 || true`);
  return sh(`timeout 600 ${BIN}/zcash-devtool wallet -w ${RUN}/w/funder send -i ${RUN}/w/funder.age --address '${to}' --value ${zat} ${memo ? `--memo '${memo}'` : ''} -s ${LWD} 2>/dev/null | tail -1`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const p = await (await browser.newContext()).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  const status = async (id) => p.evaluate(async (id) => (await fetch(`/api/campaigns/${id}`, { cache: 'no-store' })).json(), id);
  const until = async (what, id, test, ms = 600000) => {
    const end = Date.now() + ms;
    let s = null;
    while (Date.now() < end) { s = await status(id); if (test(s)) return s; await sleep(5000); }
    check(what, false, `timed out; last status: ${JSON.stringify(s && s.sealed).slice(0, 300)}`);
    throw new Error(`timed out: ${what}`);
  };
  try {
    // 1. the set up page offers the sealed bid auction (not on mainnet) and creates one
    await p.goto(`${BASE}/setup.html`);
    await p.waitForSelector('#sealed-choice:not([hidden])', { timeout: 30000 });
    check('the set up page offers a sealed bid auction', true);
    await p.check('input[name=mode][value=sealed_auction]');
    check('its own fields replace the auction and smallest contribution fields', await p.$eval('#sealed-row', (e) => !e.hidden) && await p.$eval('#minimum-row', (e) => e.hidden) && await p.$eval('#items-row', (e) => e.hidden));
    await p.fill('#s-items', '1');
    await p.fill('#s-tranches', '0.3\n0.1');
    await p.fill('#deadline', '45');
    await p.fill('#ticketk', '20');
    await p.click('#create-btn');
    await p.waitForSelector('#setup-error:not([hidden])', { timeout: 10000 });
    check('there is no default for the small payments: creating without a choice is refused', /choose when the small payments go out/.test(await p.textContent('#setup-error')));
    await p.check('input[name=scoins][value=at_once]');
    const terms = await p.textContent('#terms');
    check('the terms show the type, the deposit sizes in order and the pricing', /Blind bid auction/.test(terms) && /0\.1.*0\.3/.test(terms.replace(/\s+/g, ' ')) && /lowest winning bid/.test(terms), terms.replace(/\s+/g, ' ').slice(0, 160));
    await p.click('#create-btn');
    await p.waitForURL(`${BASE}/`, { timeout: 900000 });
    const list = await p.evaluate(async () => (await fetch('/api/campaigns')).json());
    const id = list.campaigns[0] && list.campaigns[0].id;
    check('the auction was created', /^[0-9a-f]{64}$/.test(id), id);

    // 2. the dashboard: type, round, late ticket block, coin wallet to fund
    let s = await until('the first check of the network', id, (x) => x.sealed && x.tip != null, 300000);
    await p.goto(`${BASE}/`);
    await p.waitForFunction(() => /Blind bid auction/.test(document.querySelector('#facts') ? document.querySelector('#facts').textContent : ''), null, { timeout: 120000 });
    const facts = await p.textContent('#facts');
    check('the dashboard shows round R, the close before block and the coin wallet', /drand round 33187201/.test(facts) && new RegExp(`block ${s.sealed.claim_after + 1}`).test(facts) && facts.includes(s.sealed.coin_address), `R ${s.sealed.round}, H_s ${s.sealed.claim_after}, cutoff ${s.sealed.cutoff}`);
    check('its next steps ask to fund the coin wallet', /Fund the coin wallet/.test(await p.textContent('#todo-list')));
    const tx = send(s.sealed.coin_address, 1000000);
    check('the host funds its coin wallet from its own money', /^[0-9a-f]{64}$/.test(tx));
    mine(2);

    // 3. two bids: 0.25 in the 0.3 deposit, 0.05 in the 0.1 deposit
    const rules = JSON.stringify(JSON.parse(fs.readFileSync(`${RUN}/relay/campaigns/${id}/rules.json`, 'utf8')));
    fs.writeFileSync(`${RUN}/rules.json`, rules);
    const payTo = s.pay_to;
    for (const [name, tranche, bid] of [['a', 30000000, 25000000], ['b', 10000000, 5000000]]) {
      sh(`${BIN}/ll-contrib keygen --out ${RUN}/${name}.seed`);
      const memo = sh(`${BIN}/ll-contrib bid-memo --rules ${RUN}/rules.json --seed ${RUN}/${name}.seed --refund-address "$(cat ${RUN}/w/payer.address)" --tranche-zat ${tranche} --bid-zat ${bid}`);
      check(`bid ${name} paid`, /^[0-9a-f]{64}$/.test(send(payTo, tranche, memo)));
    }
    mine(1);
    s = await until('two deposits and their small payments', id, (x) => x.sealed.deposits === 2 && x.sealed.coins_sent === 2);
    check('the dashboard counts 2 deposits and 2 small payments sent', true, `coin wallet ${s.sealed.coin_balance_zat} left`);
    await p.reload();
    await p.waitForFunction(() => /Small payments sent\s*2/.test(document.querySelector('#counts').textContent), null, { timeout: 60000 });
    check('the counts on the page say so', true);

    // 4. after the deadline: close from the dashboard
    mine(Math.max(0, s.deadline_height + 1 - tip()));
    await until('the dashboard sees the deadline pass', id, (x) => x.phase === 'deadline_passed');
    await p.reload();
    await p.waitForSelector('#close-btn:not([disabled])', { timeout: 120000 });
    check('the close explains what it does, with no address to give', /opens every bid/.test(await p.textContent('#close-explain')));
    await p.click('#close-btn');
    check('the confirm box hides the address field', await p.$eval('#sweep-to', (e) => e.hidden));
    await p.click('#close-yes');
    await p.waitForFunction(() => /close entry/.test(document.querySelector('#close-log').textContent), null, { timeout: 600000 });
    const log = await p.textContent('#close-log');
    check('the close log shows round R, the winning bid and the close entry', /signature from http:\/\/127\.0\.0\.1:18791/.test(log) && /WINS/.test(log), log.replace(/\s+/g, ' ').slice(0, 200));
    mine(2);
    s = await until('the settlement mined and the viewing key published', id, (x) => x.sealed.revealed, 600000);
    mine(1);
    s = await until('the self check passes with the treasury', id, (x) => x.self_check && x.self_check.all_pass, 300000);
    check('settlement, refund and viewing key; the self check passes', s.sealed.settlements === 1 && s.sealed.refunds_sent === 1 && s.sealed.revealed, `price ${s.sealed.price_zat}`);
    check('the price is the uniform price: with one item, the winning bid', s.sealed.price_zat === 25000000);
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  } catch (e) {
    check('run', false, String(e).slice(0, 300));
  } finally {
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
