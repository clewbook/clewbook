// The whole sealed bid auction, end to end, in a headless browser on a private regtest chain (started by app/regtest/check-e2e.sh, which
// sets RUN, CHAIN and BIN): four auctions made on the host's set up page (U uniform price, S second price, P pay your bid, N whose host
// never closes); four people bid on each from the bid page (A 0.25 in the 0.3 deposit, B 0.08, C 0.05 and D 0.02 in the 0.1 deposit), the
// host's wallet program pays each deposit from the payment the page shows; every page reaches PROTECTED; D takes the deposit back in U;
// the host closes U, S and P from the dashboard; the pages show the results; the recount page passes U, S and P from the chain; N's
// people send their late tickets after the late ticket block and N's recount says the host did not finish.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { execSync } = require('child_process');
const { RUN, CHAIN, BIN } = process.env;
const DASH = 'http://127.0.0.1:8790', WEB = 'http://127.0.0.1:8813', RELAY = 'http://127.0.0.1:18787', BRIDGE = 'http://127.0.0.1:18799', LWD = '127.0.0.1:19067';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 900000, shell: '/bin/bash' }).trim();
const mine = (n) => sh(`${CHAIN} mine ${n}`);
const tip = () => Number(sh(`${CHAIN} tip`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(to, zat, memo) {
  sh(`timeout 600 ${BIN}/zcash-devtool wallet -w ${RUN}/w/funder sync -s ${LWD} >/dev/null 2>&1 || true`);
  return sh(`timeout 600 ${BIN}/zcash-devtool wallet -w ${RUN}/w/funder send -i ${RUN}/w/funder.age --address '${to}' --value ${zat} ${memo ? `--memo '${memo}'` : ''} -s ${LWD} 2>/dev/null | tail -1`);
}
const KINDS = { U: 'uniform', S: 'second', P: 'pay_your_bid', N: 'uniform' };
const PEOPLE = [['A', 0.3, '0.25'], ['B', 0.1, '0.08'], ['C', 0.1, '0.05'], ['D', 0.1, '0.02']];

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async () => { const p = await (await browser.newContext()).newPage(); p.on('pageerror', (e) => errors.push(String(e))); return p; };
  const dash = await newPage();
  await dash.goto(`${DASH}/`);
  const api = (path, body) => dash.evaluate(async ({ path, body }) => {
    const r = await fetch(`/api/${path}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) });
    return r.json();
  }, { path, body });
  const until = async (what, f, ms = 600000, every = 5000, tick = null) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await f(); if (last) return last; if (tick) tick(); await sleep(every); }
    throw new Error(`timed out: ${what}`);
  };
  const ids = {};
  const pages = {}; // X -> person -> page
  try {
    // 1. four auctions from the set up page
    for (const x of ['U', 'S', 'P', 'N']) {
      const p = await newPage();
      await p.goto(`${DASH}/setup.html`);
      await p.waitForSelector('#sealed-choice:not([hidden])', { timeout: 60000 });
      await p.check('input[name=mode][value=sealed_auction]');
      await p.fill('#campaign-name', `Sealed ${x}`);
      await p.fill('#s-items', '2');
      await p.fill('#s-tranches', '0.1\n0.3');
      await p.check(`input[name=spricing][value=${KINDS[x]}]`);
      await p.check('input[name=scoins][value=at_once]');
      await p.fill('#deadline', '50');
      await p.fill('#ticketk', '20');
      await p.click('#create-btn');
      await p.waitForURL(`${DASH}/`, { timeout: 900000 });
      const list = await api('campaigns');
      ids[x] = list.campaigns.find((c) => c.name === `Sealed ${x}`).id;
      await p.context().close();
    }
    check('four sealed auctions made on the set up page, one per pricing type and one more', Object.keys(ids).length === 4, JSON.stringify(ids).slice(0, 120));
    const st = {};
    for (const x of Object.keys(ids)) st[x] = (await until(`${x} first check`, async () => { const s = await api(`campaigns/${ids[x]}`); return s.sealed && s.tip != null ? s : null; }, 300000));
    for (const x of Object.keys(ids)) check(`${x}: its coin wallet funded by the host`, /^[0-9a-f]{64}$/.test(send(st[x].sealed.coin_address, 1000000)));
    mine(2);

    // 2. sixteen bids from the bid page
    for (const x of Object.keys(ids)) {
      pages[x] = {};
      for (const [who, tranche, bid] of PEOPLE) {
        const p = await newPage();
        await p.goto(`${WEB}/bid.html#c=${ids[x]}&relay=${RELAY}&server=${BRIDGE}`);
        await p.waitForSelector('#form-card:not([hidden])', { timeout: 120000 });
        await p.waitForFunction(() => !document.querySelector('#create').disabled, null, { timeout: 60000 });
        await p.selectOption('#tranche', String(Math.round(tranche * 1e8)));
        await p.fill('#bid', bid);
        await p.fill('#refund', sh(`cat ${RUN}/w/payer.address`));
        await p.click('#create');
        await p.waitForSelector('#pay-card:not([hidden])', { timeout: 60000 });
        const memo = await p.textContent('#memo'), payTo = await p.textContent('#pay-to');
        const txid = send(payTo, Math.round(tranche * 1e8), memo);
        if (!/^[0-9a-f]{64}$/.test(txid)) check(`${x} ${who}: deposit paid`, false, txid);
        pages[x][who] = p;
      }
    }
    mine(1);
    check('sixteen deposits paid from the payment each bid page showed', true);
    // every page: ticket, small payment, late ticket checked and signed
    const title = (p) => p.textContent('#st-title');
    await until('every bid page PROTECTED', async () => {
      const t = await Promise.all(Object.values(pages).flatMap((m) => Object.values(m)).map(title));
      return t.every((x) => x === 'PROTECTED');
    }, 900000, 15000, () => { if (tip() < st.U.sealed.cutoff - 2) mine(1); });
    check('all sixteen bid pages say PROTECTED (coin in, late ticket checked against the chain, proof verified, signed)', true, `tip ${tip()}`);

    // 3. D takes the deposit back in U
    await pages.U.D.click('#take-back');
    await pages.U.D.waitForFunction(() => /on its way back/.test(document.querySelector('#st-title').textContent), null, { timeout: 60000 });
    mine(1);
    check('U: D took the deposit back with the early ticket', true);

    // 4. after the deadline: U, S and P closed from the dashboard
    mine(Math.max(0, st.U.deadline_height + 1 - tip()));
    for (const x of ['U', 'S', 'P']) {
      await until(`${x} deadline passed on the dashboard`, async () => (await api(`campaigns/${ids[x]}`)).phase === 'deadline_passed', 300000);
      const r = await api(`campaigns/${ids[x]}/close`, {});
      check(`${x}: closed from the dashboard`, r.ok === true, (r.log || [r.error]).join(' | ').slice(0, 160));
    }
    for (let i = 0; i < 3; i++) { mine(1); await sleep(20000); }
    for (const x of ['U', 'S', 'P']) {
      const s = await until(`${x} viewing key`, async () => { const s = await api(`campaigns/${ids[x]}`); return s.sealed.revealed && s.self_check && s.self_check.all_pass ? s : null; }, 600000, 10000, () => mine(1));
      check(`${x}: settled, refunded, viewing key published, the host's self check passes`, true, `price ${s.sealed.price_zat}, settlements ${s.sealed.settlements}, refunds ${s.sealed.refunds_sent}`);
    }

    // 5. the results on the bid pages
    const want = { U: { A: /won.*0\.08/, B: /won.*0\.08/, C: /did not win/, D: /Your money is back.*early ticket was mined in block/ }, S: { A: /won.*0\.05/, B: /won.*0\.05/, C: /did not win/, D: /did not win/ },
      P: { A: /won.*0\.25/, B: /won.*0\.08/, C: /did not win/, D: /did not win/ } };
    for (const x of ['U', 'S', 'P']) {
      for (const who of ['A', 'B', 'C', 'D']) {
        const p = pages[x][who];
        const ok = await until(`${x} ${who} result`, async () => { const t = `${await p.textContent('#st-title')} ${await p.textContent('#st-text')} ${await p.textContent('#st-more')}`; return want[x][who].test(t) ? t : null; }, 180000).catch(() => null);
        check(`${x} ${who}: the bid page shows the result`, !!ok, ok ? ok.slice(0, 160) : await p.textContent('#st-title'));
      }
    }

    // 6. the recount page from the chain
    for (const x of ['U', 'S', 'P']) {
      const p = await newPage();
      await p.goto(`${WEB}/recount.html#c=${ids[x]}&relay=${RELAY}&endpoint=${BRIDGE}`);
      await p.waitForFunction(() => !/Working|Reading/.test(document.querySelector('#verdict-title').textContent), null, { timeout: 600000 });
      check(`${x}: the recount page passes from the chain`, /All checks pass/.test(await p.textContent('#verdict-title')), (await p.textContent('#sealed-card')).replace(/\s+/g, ' ').slice(0, 160));
      await p.context().close();
    }

    // 7. N: its host never closes; after the late ticket block every page sends its late ticket
    mine(Math.max(0, st.N.sealed.claim_after + 1 - tip()));
    for (const who of ['A', 'B', 'C', 'D']) {
      const p = pages.N[who];
      await p.waitForSelector('#send-late:not([hidden])', { timeout: 120000 });
      await p.click('#send-late');
      await p.waitForFunction(() => /deposit is on its way back/.test(document.querySelector('#st-title').textContent), null, { timeout: 60000 });
    }
    mine(2);
    check('N: all four late tickets sent from the bid pages after the late ticket block', true);
    const p = await newPage();
    await p.goto(`${WEB}/recount.html#c=${ids.N}&relay=${RELAY}&endpoint=${BRIDGE}`);
    await p.waitForFunction(() => !/Working|Reading/.test(document.querySelector('#verdict-title').textContent), null, { timeout: 600000 });
    check('N: the recount page says the host did not finish', /did not finish/.test(await p.textContent('#verdict-title')));
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } catch (e) {
    check('run', false, String(e).slice(0, 300));
  } finally {
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})();
