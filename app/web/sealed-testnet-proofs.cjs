// The four sealed bid auction proofs on the public test network (P1 uniform price, P2 second price, P3 pay your bid, P4 a host that never
// closes), through the real pages: the sealed host's set up page and dashboard (127.0.0.1:8786), the bid page and recount page on
// app-test.clewbook.xyz, the test relay relay-test.clewbook.xyz, public testnet chain servers and live drand quicknet. Testnet coins only.
// Run in stages; state is kept in runs/testnet-proofs/state.json and each bid page keeps its own browser profile (its keys stay there):
//   node app/web/sealed-testnet-proofs.cjs create | bid | protected | close | results | late | status
// Env: PAYER_DEVTOOL, PAYER_WALLET, PAYER_IDENTITY (the testnet payer wallet), HOST_DEVTOOL, HOST_WALLET, HOST_IDENTITY (the host funds wallet).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');
const DIR = 'runs/testnet-proofs', STATE = `${DIR}/state.json`;
const DASH = 'http://127.0.0.1:8786', APP = 'https://app-test.clewbook.xyz', RELAY = 'https://relay-test.clewbook.xyz';
const E = process.env;
const L = E.RUN_LABEL ? ` ${E.RUN_LABEL}` : '';
const AUCTIONS = { P1: [`Sealed proof P1, uniform price${L}`, 'uniform'], P2: [`Sealed proof P2, second price${L}`, 'second'], P3: [`Sealed proof P3, pay your bid${L}`, 'pay_your_bid'], P4: [`Sealed proof P4, host never closes${L}`, 'uniform'] };
// person, deposit (TAZ), bid (TAZ): with 2 items, A and B win
// (a bid is at most its deposit minus the 0.0001 refund fee)
const PEOPLE = [['A', '0.001', '0.0008'], ['B', '0.0003', '0.00018'], ['C', '0.0003', '0.00012']];
const zat = (taz) => Math.round(Number(taz) * 1e8);
fs.mkdirSync(`${DIR}/profiles`, { recursive: true });
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {});
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); fs.appendFileSync(`${DIR}/proofs.log`, `${line}\n`); };
const sh = (cmd, t = 900000) => execSync(cmd, { encoding: 'utf8', timeout: t, shell: '/bin/bash' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the wallet tool asks "Continue? [y/n]" before it pays a payment request: the run answers yes
const payer = (args) => sh(`echo y | ${E.PAYER_DEVTOOL} wallet -w ${E.PAYER_WALLET} ${args}`);
const host = (args) => sh(`echo y | ${E.HOST_DEVTOOL} wallet -w ${E.HOST_WALLET} ${args}`);
async function until(what, f, ms, every = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await f().catch(() => null); if (v) return v; await sleep(every); }
  throw new Error(`timed out after ${Math.round(ms / 60000)} min: ${what}`);
}

(async () => {
  const stage = process.argv[2];
  const st = load();
  const browser = await chromium.launch();
  const dash = await (await browser.newContext()).newPage();
  await dash.goto(`${DASH}/`);
  const api = (p, body) => dash.evaluate(async ({ p, body }) => (await fetch(`/api/${p}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) })).json(), { p, body });
  const status = (x) => api(`campaigns/${st.ids[x]}`);
  const profile = (x, who) => chromium.launchPersistentContext(path.resolve(`${DIR}/profiles/${x}-${who}`), { headless: true });
  const bidLink = (x) => `${APP}/bid.html#c=${st.ids[x]}&relay=${RELAY}&server=https://zjs.zec.rocks/testnet`;
  const recountLink = (x) => `${APP}/recount.html#c=${st.ids[x]}&relay=${RELAY}`;
  try {
    if (stage === 'create') {
      // all four together: four set up pages submitted 3 s apart (a new campaign's folder is named after the second it was made in)
      const created = await Promise.all(Object.entries(AUCTIONS).map(async ([x, [name, pricing]], i) => {
        await sleep(i * 3000);
        const p = await (await browser.newContext()).newPage();
        await p.goto(`${DASH}/setup.html`);
        await p.waitForSelector('#sealed-choice:not([hidden])', { timeout: 60000 });
        await p.check('input[name=mode][value=sealed_auction]');
        await p.fill('#campaign-name', name);
        await p.fill('#s-items', '2');
        await p.fill('#s-tranches', '0.0003\n0.001');
        await p.check(`input[name=spricing][value=${pricing}]`);
        await p.check('input[name=scoins][value=at_once]');
        await p.fill('#deadline', '30');
        await p.fill('#ticketk', '10');
        await p.click('#create-btn');
        await p.waitForURL(`${DASH}/`, { timeout: 900000 }).catch(async () => { throw new Error(`${x}: ${await p.textContent('#setup-error')}`); });
        log(`${x} created on the set up page`);
        return x;
      }));
      const list = (await api('campaigns')).campaigns;
      st.ids = {}; st.at = new Date().toISOString();
      for (const x of created) st.ids[x] = list.find((c) => c.name === AUCTIONS[x][0]).id;
      st.rules = {};
      for (const x of created) {
        const s = await until(`${x} first check`, async () => { const s = await status(x); return s.sealed && s.tip != null ? s : null; }, 600000);
        st.rules[x] = { deadline: s.deadline_height, cutoff: s.sealed.cutoff, round: s.sealed.round, round_time: s.sealed.round_time, claim_after: s.sealed.claim_after, coin_address: s.sealed.coin_address, link: s.contribute_link, tip: s.tip };
        log(`${x} ${st.ids[x]} deadline ${s.deadline_height} cutoff ${s.sealed.cutoff} round ${s.sealed.round} (${new Date(s.sealed.round_time * 1000).toISOString()}) late tickets after ${s.sealed.claim_after}`);
      }
      save(st);
      // the host funds every coin wallet from its own money: one payment request, four outputs of 0.001 TAZ
      host(`sync >/dev/null 2>&1 || true`);
      const uri = 'zcash:?' + Object.keys(st.ids).map((x, i) => `${i ? `address.${i}` : 'address'}=${st.rules[x].coin_address}&${i ? `amount.${i}` : 'amount'}=0.001`).join('&');
      st.coin_funding = host(`pay -i ${E.HOST_IDENTITY} --payment-uri '${uri}' 2>/dev/null | tail -1`);
      log(`coin wallets funded by the host funds wallet: ${st.coin_funding}`);
      save(st);
    }
    if (stage === 'bid') {
      // twelve bids through the real bid page (the link the dashboard gives); each page keeps its keys in its own browser profile
      const refund = payer(`list-addresses 2>/dev/null | sed -n 's/.*Default Address: //p'`);
      st.bids = {};
      await Promise.all(Object.keys(st.ids).flatMap((x) => PEOPLE.map(async ([who, deposit, bid]) => {
          const ctx = await profile(x, who);
          const p = ctx.pages()[0] || await ctx.newPage();
          await p.goto(st.rules[x].link);
          await p.waitForURL(/bid\.html/, { timeout: 60000 });
          await p.waitForSelector('#form-card:not([hidden])', { timeout: 120000 });
          await p.waitForFunction(() => !document.querySelector('#create').disabled, null, { timeout: 60000 }).catch(async () => { throw new Error(`${x} ${who}: ${await p.textContent('#bid-hint')}`); });
          await p.selectOption('#tranche', String(zat(deposit)));
          await p.fill('#bid', bid);
          await p.fill('#refund', refund);
          for (let tries = 1; ; tries++) {
            await p.click('#create');
            const shown = await p.waitForSelector('#pay-card:not([hidden])', { timeout: 20000 }).then(() => true).catch(() => false);
            if (shown) break;
            const err = await p.textContent('#form-error');
            log(`${x}-${who}: no payment yet (${err || 'no message'}), try ${tries}`);
            if (tries >= 3) throw new Error(`${x}-${who}: the bid page made no payment: ${err}`);
            await p.reload(); await p.waitForSelector('#form-card:not([hidden])', { timeout: 120000 });
            await p.selectOption('#tranche', String(zat(deposit))); await p.fill('#bid', bid); await p.fill('#refund', refund);
          }
          st.bids[`${x}-${who}`] = { memo: await p.textContent('#memo'), pay_to: await p.textContent('#pay-to'), deposit, bid };
          await ctx.close();
      })));
      log(`twelve bid pages made their payments`);
      // one payment request from the payer wallet with all twelve deposits, each with the memo its bid page made
      const entries = Object.values(st.bids);
      const uri = 'zcash:?' + entries.map((b, i) => { const n = i ? `.${i}` : ''; return `address${n}=${b.pay_to}&amount${n}=${b.deposit}&memo${n}=${Buffer.from(b.memo).toString('base64url')}`; }).join('&');
      payer(`sync >/dev/null 2>&1 || true`);
      st.deposits_tx = payer(`pay -i ${E.PAYER_IDENTITY} --payment-uri '${uri}' 2>/dev/null | tail -1`);
      log(`twelve deposits paid in ${st.deposits_tx}`);
      save(st);
    }
    if (stage === 'protected' || stage === 'status') {
      // every bid page: ticket, the host's coin, the late ticket checked against the chain and signed
      const want = stage === 'protected' ? 'PROTECTED' : null;
      const titles = {};
      await until('every bid page PROTECTED', async () => {
        for (const k of Object.keys(st.bids)) {
          if (titles[k] === 'PROTECTED' && want) continue;
          const [x, who] = k.split('-');
          const ctx = await profile(x, who);
          const p = ctx.pages()[0] || await ctx.newPage();
          await p.goto(bidLink(x));
          await p.waitForFunction(() => document.querySelector('#st-title') && document.querySelector('#st-title').textContent, null, { timeout: 60000 }).catch(() => {});
          if (want) await p.waitForFunction(() => /^PROTECTED$|NOT PROTECTED|Take your money/.test(document.querySelector('#st-title').textContent), null, { timeout: 120000 }).catch(() => {});
          titles[k] = (await p.textContent('#st-title')) || '';
          const text = (await p.textContent('#st-text')) || '';
          if (/NOT PROTECTED|Take your money back now/.test(titles[k])) throw new Error(`${k}: ${titles[k]}: ${text}`);
          if (!want) log(`${k}: ${titles[k]} ${text}`);
          await ctx.close();
        }
        log(`bid pages: ${Object.entries(titles).map(([k, t]) => `${k} ${t}`).join(', ')}`);
        return !want || Object.values(titles).every((t) => t === 'PROTECTED');
      }, want ? 1800000 : 120000, 20000);
      if (want) { st.protected_at = new Date().toISOString(); save(st); log('all twelve bid pages PROTECTED'); }
    }
    if (stage === 'close') {
      // P1 to P3, after round R: closed from the dashboard; then settlements, refunds and the viewing key
      for (const x of ['P1', 'P2', 'P3']) {
        await until(`${x} round R out`, async () => Date.now() / 1000 > st.rules[x].round_time + 20, 3600000, 30000);
        const r = await api(`campaigns/${st.ids[x]}/close`, {});
        if (!r.ok) throw new Error(`${x} close: ${r.error}`);
        log(`${x} closed: ${r.log.join(' | ')}`);
        st[`close_${x}`] = r.log;
      }
      save(st);
      for (const x of ['P1', 'P2', 'P3']) {
        const s = await until(`${x} viewing key published and the host's self check passing`, async () => { const s = await status(x); return s.sealed.revealed && s.self_check && s.self_check.all_pass ? s : null; }, 2400000, 20000);
        st[`result_${x}`] = { price_zat: s.sealed.price_zat, winners: s.sealed.winners, settlements: s.sealed.settlements, refunds: s.sealed.refunds_sent, broadcasts: s.broadcasts };
        log(`${x}: price ${s.sealed.price_zat}, ${s.sealed.winners} winners, ${s.sealed.settlements} settlements, ${s.sealed.refunds_sent} refunds, viewing key published, self check PASS`);
      }
      save(st);
    }
    if (stage === 'results') {
      for (const x of ['P1', 'P2', 'P3']) {
        for (const [who] of PEOPLE) {
          const ctx = await profile(x, who);
          const p = ctx.pages()[0] || await ctx.newPage();
          await p.goto(bidLink(x));
          await p.waitForFunction(() => /won|did not win/.test(document.querySelector('#st-title').textContent), null, { timeout: 180000 }).catch(() => {});
          log(`${x}-${who} bid page: ${await p.textContent('#st-title')}: ${await p.textContent('#st-text')}`);
          await ctx.close();
        }
        const p = await (await browser.newContext()).newPage();
        await p.goto(recountLink(x));
        await p.waitForFunction(() => !/Working|Reading/.test(document.querySelector('#verdict-title').textContent), null, { timeout: 900000 });
        st[`recount_${x}`] = { verdict: await p.textContent('#verdict-title'), sources: await p.textContent('#sources'), sealed: (await p.textContent('#sealed-card')).replace(/\s+/g, ' ') };
        log(`${x} recount in the browser: ${st[`recount_${x}`].verdict} | ${st[`recount_${x}`].sources} | ${st[`recount_${x}`].sealed}`);
        await p.context().close();
      }
      save(st);
    }
    if (stage === 'late') {
      // P4: its host never closes; after the late ticket block each bid page sends its own late ticket
      const ctxTip = async () => (await status('P4')).tip;
      await until('P4 late ticket block passed', async () => (await ctxTip()) > st.rules.P4.claim_after, 3600000, 30000);
      for (const [who] of PEOPLE) {
        const ctx = await profile('P4', who);
        const p = ctx.pages()[0] || await ctx.newPage();
        await p.goto(bidLink('P4'));
        await p.waitForSelector('#send-late:not([hidden])', { timeout: 180000 });
        await p.click('#send-late');
        await p.waitForFunction(() => /deposit is on its way back/.test(document.querySelector('#st-title').textContent), null, { timeout: 120000 });
        log(`P4-${who}: ${await p.textContent('#send-msg')}`);
        await ctx.close();
      }
      await sleep(120000);
      const p = await (await browser.newContext()).newPage();
      await p.goto(recountLink('P4'));
      await p.waitForFunction(() => !/Working|Reading/.test(document.querySelector('#verdict-title').textContent), null, { timeout: 900000 });
      st.recount_P4 = { verdict: await p.textContent('#verdict-title'), text: await p.textContent('#verdict-text') };
      log(`P4 recount in the browser: ${st.recount_P4.verdict}: ${st.recount_P4.text}`);
      save(st);
    }
  } catch (e) {
    log(`STOPPED: ${String(e).slice(0, 500)}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
