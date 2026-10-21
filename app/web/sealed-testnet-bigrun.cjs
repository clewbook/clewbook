// The big sealed bid auction run on the public test network, with the quick test timing, through the real pages: the sealed host's set up
// page and dashboard (127.0.0.1:8786), the bid page and recount page on app-test.clewbook.xyz, the test relay, public testnet chain
// servers and live drand quicknet. Testnet coins only. Four auctions at the same time (deadline 55 blocks, ticket window 10):
//   B1 uniform price, 5 items, coins every 5 bids, 15 bids in three groups of five (B8: one winner's page closed and opened again);
//   B2 second price, 3 items, coins every 5 minutes, 8 bids (B6: a winner sends both tickets in the settlement window; B7: a bid above
//      its tranche and a copied memo);
//   B3 pay your bid, 3 items, coins at once, 8 bids (B4: one deposit paid after the coin cutoff, then taken back);
//   B5 uniform price, 1 item, coins at once, its coin wallet funded for one small payment only, 5 bids.
// State in runs/testnet-bigrun/state.json, log in runs/testnet-bigrun/run.log; each bid page keeps its own browser profile.
//   node app/web/sealed-testnet-bigrun.cjs run      (everything, in order, each step with a time limit)
//   node app/web/sealed-testnet-bigrun.cjs <step>   (one step again: create fund pages deposits watch b6 close results)
// Env: DEVTOOL (wallet tool), PAYER_WALLET, PAYER_IDENTITY, HOST_WALLET, HOST_IDENTITY, CONTRIB (ll-contrib).
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');
const DIR = 'runs/testnet-bigrun', STATE = `${DIR}/state.json`;
const DASH = 'http://127.0.0.1:8786', APP = 'https://app-test.clewbook.xyz', RELAY = 'https://relay-test.clewbook.xyz', CHAIN = 'https://zjs.zec.rocks/testnet';
const E = process.env;
const DEADLINE = 55, TICKET_K = 10;
// x: [name, pricing, items, tranches (TAZ), coins choice, coin wallet funding (TAZ)]
const AUCTIONS = {
  B1: ['Sealed big run B1, uniform price', 'uniform', 5, ['0.0002', '0.0004', '0.0008'], ['every_bids', 5], '0.002'],
  B2: ['Sealed big run B2, second price', 'second', 3, ['0.0002', '0.0004'], ['every_minutes', 5], '0.0015'],
  B3: ['Sealed big run B3, pay your bid', 'pay_your_bid', 3, ['0.0002', '0.0004'], ['at_once'], '0.0012'],
  B5: ['Sealed big run B5, coin wallet short', 'uniform', 1, ['0.0002'], ['at_once'], '0.0002'],
};
// x -> [person, deposit, bid, group]: group is when the deposit is paid (see the deposits step)
const PEOPLE = {
  B1: [['A1', '0.0008', '0.0007', 1], ['A2', '0.0008', '0.00065', 2], ['A3', '0.0008', '0.0006', 3], ['A4', '0.0008', '0.00055', 1], ['A5', '0.0008', '0.0005', 2],
    ['M1', '0.0004', '0.0003', 3], ['M2', '0.0004', '0.00028', 1], ['M3', '0.0004', '0.00026', 2], ['M4', '0.0004', '0.00024', 3], ['M5', '0.0004', '0.00022', 1],
    ['C1', '0.0002', '0.0001', 2], ['C2', '0.0002', '0.00009', 3], ['C3', '0.0002', '0.00008', 1], ['C4', '0.0002', '0.00007', 2], ['C5', '0.0002', '0.00006', 3]],
  B2: [['D1', '0.0004', '0.0003', 1], ['D2', '0.0004', '0.00027', 1], ['D3', '0.0004', '0.00024', 1], ['D4', '0.0004', '0.00021', 1],
    ['E1', '0.0002', '0.0001', 1], ['E2', '0.0002', '0.00008', 1], ['E3', '0.0002', '0.00006', 1], ['E4', '0.0002', '0.00004', 1]],
  B3: [['F1', '0.0004', '0.0003', 1], ['F2', '0.0004', '0.00025', 1], ['F3', '0.0004', '0.0002', 1], ['F4', '0.0004', '0.00015', 1],
    ['G1', '0.0002', '0.0001', 1], ['G2', '0.0002', '0.00008', 1], ['G3', '0.0002', '0.00006', 1], ['G4', '0.0002', '0.00004', 1],
    ['H1', '0.0002', '0.00009', 'late']],
  B5: [['K1', '0.0002', '0.0001', 1], ['K2', '0.0002', '0.00009', 'after_coin'], ['K3', '0.0002', '0.00008', 'after_coin'], ['K4', '0.0002', '0.00007', 'after_coin'], ['K5', '0.0002', '0.00006', 'after_coin']],
};
const zat = (taz) => Math.round(Number(taz) * 1e8);
fs.mkdirSync(`${DIR}/profiles`, { recursive: true });
const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {});
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); fs.appendFileSync(`${DIR}/run.log`, `${line}\n`); };
const sh = (cmd, t = 900000) => execSync(cmd, { encoding: 'utf8', timeout: t, shell: '/bin/bash' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the wallet tool asks "Continue? [y/n]" before it pays a payment request: the run answers yes
const wallet = (w, args, t) => sh(`echo y | ${E.DEVTOOL} wallet -w ${w} ${args}`, t);
const sync = (w) => { try { wallet(w, 'sync -s testnet.zec.rocks:443 >/dev/null 2>&1', 600000); } catch { /* the payment below says if it matters */ } };
const payUri = (w, id, entries) => {
  const uri = 'zcash:?' + entries.map((b, i) => { const n = i ? `.${i}` : ''; return `address${n}=${b.to}&amount${n}=${b.amount}${b.memo ? `&memo${n}=${Buffer.from(b.memo).toString('base64url')}` : ''}`; }).join('&');
  sync(w);
  // change from the run's own earlier payments becomes spendable after 3 confirmations: while the wallet has too little, wait and try
  // again, for at most 6 minutes
  for (let tries = 1; ; tries++) {
    const out = wallet(w, `pay -i ${id} --payment-uri '${uri}' -s testnet.zec.rocks:443 2>&1 | tail -2`);
    const txid = (out.match(/^[0-9a-f]{64}$/m) || [])[0];
    if (txid) return txid;
    if (!/Insufficient balance/.test(out) || tries >= 12) throw new Error(`payment not sent: ${out.slice(-300)}`);
    log(`payment waits for spendable funds (${out.split('\n').pop().slice(0, 120)}), try ${tries}`);
    execSync('sleep 30');
    sync(w);
  }
};
async function until(what, f, ms, every = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await f().catch(() => null); if (v) return v; await sleep(every); }
  throw new Error(`timed out after ${Math.round(ms / 60000)} min: ${what}`);
}
async function pool(items, n, f) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]); } })); return out; }

(async () => {
  const step = process.argv[2];
  const st = load();
  const browser = await chromium.launch();
  const dash = await (await browser.newContext()).newPage();
  await dash.goto(`${DASH}/`);
  const api = (p, body) => dash.evaluate(async ({ p, body }) => (await fetch(`/api/${p}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) })).json(), { p, body });
  const status = (x) => api(`campaigns/${st.ids[x]}`);
  const profile = (x, who) => chromium.launchPersistentContext(path.resolve(`${DIR}/profiles/${x}-${who}`), { headless: true });
  const bidLink = (x) => `${APP}/bid.html#c=${st.ids[x]}&relay=${RELAY}&server=${CHAIN}`;
  const recountLink = (x) => `${APP}/recount.html#c=${st.ids[x]}&relay=${RELAY}`;
  const tip = async () => (await status('B1')).tip;
  // a bid page's title and text, opened from its own profile
  const look = async (x, who, wait) => {
    const ctx = await profile(x, who);
    try {
      const p = ctx.pages()[0] || await ctx.newPage();
      await p.goto(bidLink(x));
      await p.waitForFunction((re) => document.querySelector('#st-title') && new RegExp(re).test(document.querySelector('#st-title').textContent), wait || '.', { timeout: wait ? 150000 : 90000 }).catch(() => {});
      return { title: (await p.textContent('#st-title')) || '', text: (await p.textContent('#st-text')) || '' };
    } finally { await ctx.close(); }
  };
  const click = async (x, who, button, done) => {
    const ctx = await profile(x, who);
    try {
      const p = ctx.pages()[0] || await ctx.newPage();
      await p.goto(bidLink(x));
      await p.waitForSelector(`${button}:not([hidden])`, { timeout: 150000 });
      await p.click(button);
      await p.waitForFunction((re) => new RegExp(re).test(document.querySelector('#st-title').textContent), done, { timeout: 120000 });
      return { title: await p.textContent('#st-title'), msg: await p.textContent('#send-msg'), state: await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)), st.ids[x]) };
    } finally { await ctx.close(); }
  };
  const steps = {
    async create() {
      const created = await Promise.all(Object.entries(AUCTIONS).map(async ([x, [name, pricing, items, tranches, coins]], i) => {
        await sleep(i * 3000); // a new campaign's folder is named after the second it was made in
        const p = await (await browser.newContext()).newPage();
        await p.goto(`${DASH}/setup.html`);
        await p.waitForSelector('#sealed-choice:not([hidden])', { timeout: 60000 });
        await p.check('input[name=mode][value=sealed_auction]');
        await p.fill('#campaign-name', name);
        await p.fill('#s-items', String(items));
        await p.fill('#s-tranches', tranches.join('\n'));
        await p.check(`input[name=spricing][value=${pricing}]`);
        if (coins[0] === 'every_bids') await p.fill('#s-coins-bids', String(coins[1]));
        else if (coins[0] === 'every_minutes') await p.fill('#s-coins-min', String(coins[1]));
        else await p.check('input[name=scoins][value=at_once]');
        await p.waitForSelector('#s-timing:not([hidden])', { timeout: 10000 });
        await p.check('input[name=stiming][value=quick]');
        await p.fill('#deadline', String(DEADLINE));
        await p.fill('#ticketk', String(TICKET_K));
        const terms = (await p.textContent('#terms')).replace(/\s+/g, ' ');
        await p.click('#create-btn');
        await p.waitForURL(`${DASH}/`, { timeout: 900000 }).catch(async () => { throw new Error(`${x}: ${await p.textContent('#setup-error')}`); });
        log(`${x} created on the set up page; summary: ${terms.slice(0, 400)}`);
        return x;
      }));
      const list = (await api('campaigns')).campaigns;
      st.ids = {}; st.created_at = new Date().toISOString();
      for (const x of created) st.ids[x] = list.find((c) => c.name === AUCTIONS[x][0]).id;
      st.rules = {};
      for (const x of created) {
        const s = await until(`${x} first check`, async () => { const s = await status(x); return s.sealed && s.tip != null ? s : null; }, 600000);
        st.rules[x] = { deadline: s.deadline_height, start: s.start_height, cutoff: s.sealed.cutoff, round: s.sealed.round, round_time: s.sealed.round_time, claim_after: s.sealed.claim_after, coin_address: s.sealed.coin_address, pay_to: s.pay_to, timing: s.sealed.timing, tip: s.tip };
        log(`${x} ${st.ids[x]} timing ${s.sealed.timing}, deadline ${s.deadline_height}, cutoff ${s.sealed.cutoff}, round ${s.sealed.round} (${new Date(s.sealed.round_time * 1000).toISOString()}), late tickets after ${s.sealed.claim_after}`);
      }
      save(st);
    },
    async fund() {
      // the host funds every coin wallet from its own money, one payment request; B5's only enough for one small payment
      st.coin_funding = payUri(E.HOST_WALLET, E.HOST_IDENTITY, Object.keys(st.ids).map((x) => ({ to: st.rules[x].coin_address, amount: AUCTIONS[x][5] })));
      log(`coin wallets funded: ${Object.keys(st.ids).map((x) => `${x} ${AUCTIONS[x][5]}`).join(', ')} TAZ in ${st.coin_funding}`);
      save(st);
    },
    async pages() {
      // every bid made on the real bid page (each in its own browser profile): the page shows the address, amount and message to pay
      const refund = sh(`${E.DEVTOOL} wallet -w ${E.PAYER_WALLET} list-addresses 2>/dev/null | sed -n 's/.*Default Address: //p' | head -1`);
      st.bids = st.bids || {};
      const todo = Object.entries(PEOPLE).flatMap(([x, ps]) => ps.map(([who, deposit, bid, group]) => ({ x, who, deposit, bid, group }))).filter((b) => !st.bids[`${b.x}-${b.who}`]);
      await pool(todo, 6, async ({ x, who, deposit, bid, group }) => {
        const ctx = await profile(x, who);
        try {
          const p = ctx.pages()[0] || await ctx.newPage();
          for (let tries = 1; ; tries++) {
            await p.goto(bidLink(x));
            await p.waitForSelector('#form-card:not([hidden])', { timeout: 150000 });
            await p.waitForFunction(() => !document.querySelector('#create').disabled, null, { timeout: 90000 }).catch(async () => { throw new Error(`${x}-${who}: ${await p.textContent('#bid-hint')}`); });
            await p.selectOption('#tranche', String(zat(deposit)));
            await p.fill('#bid', bid);
            await p.fill('#refund', refund);
            await p.click('#create');
            if (await p.waitForSelector('#pay-card:not([hidden])', { timeout: 30000 }).then(() => true).catch(() => false)) break;
            const err = await p.textContent('#form-error');
            if (tries >= 3) throw new Error(`${x}-${who}: the bid page made no payment: ${err}`);
            log(`${x}-${who}: no payment yet (${err || 'no message'}), try ${tries}`);
          }
          st.bids[`${x}-${who}`] = { x, who, memo: await p.textContent('#memo'), to: await p.textContent('#pay-to'), amount: await p.textContent('#pay-amt'), deposit, bid, group };
          if (st.bids[`${x}-${who}`].amount !== deposit) throw new Error(`${x}-${who}: the page asks for ${st.bids[`${x}-${who}`].amount}, not ${deposit}`);
        } finally { await ctx.close(); }
      });
      log(`${Object.keys(st.bids).length} bid pages made their payments`);
      save(st);
    },
    async deposits() {
      st.deposit_txs = st.deposit_txs || {};
      const group = (g) => Object.values(st.bids).filter((b) => b.group === g);
      const pay = (label, entries) => { if (st.deposit_txs[label]) return; st.deposit_txs[label] = payUri(E.PAYER_WALLET, E.PAYER_IDENTITY, entries); save(st); log(`deposits ${label} (${entries.map((b) => `${b.x}-${b.who}`).join(' ')}) paid in ${st.deposit_txs[label]}`); };
      // group 1: B1's first five, all of B2 and B3 (but H1), and B5's first
      pay('group 1', group(1));
      // B1 two minutes apart, so its "every 5 bids" small payments go out per group
      await sleep(120000); pay('group 2', group(2));
      await sleep(120000); pay('group 3', group(3));
      // B5: the others once the first has its small payment (the coin wallet then holds too little for another)
      await until('B5 first small payment', async () => (await status('B5')).sealed.coins_sent >= 1, 1200000, 20000);
      pay('B5 after its coin', Object.values(st.bids).filter((b) => b.group === 'after_coin'));
      // B7 in B2: a bid above its tranche (made with the contributor tool's test only switch) and a copy of E4's memo, after E4's deposit
      if (!st.b7) {
        const rules = `${DIR}/B2-rules.json`;
        fs.writeFileSync(rules, await (await fetch(`${RELAY}/v1/campaigns/${st.ids.B2}`)).text());
        sh(`[ -f ${DIR}/b7-over.seed ] || ${E.CONTRIB} keygen --out ${DIR}/b7-over.seed`);
        const refund = sh(`${E.DEVTOOL} wallet -w ${E.PAYER_WALLET} list-addresses 2>/dev/null | sed -n 's/.*Default Address: //p' | head -1`);
        const over = sh(`${E.CONTRIB} bid-memo --rules ${rules} --seed ${DIR}/b7-over.seed --refund-address '${refund}' --tranche-zat 20000 --bid-zat 15000 --test-over-tranche 2>/dev/null`);
        await until('E4 deposit ticketed in B2', async () => (await status('B2')).counts.tickets_issued >= 8, 900000, 20000);
        st.b7 = { over_memo_start: over.slice(0, 12), copy_of: 'B2-E4' };
        st.b7.over_tx = payUri(E.PAYER_WALLET, E.PAYER_IDENTITY, [{ to: st.rules.B2.pay_to, amount: '0.0002', memo: over }]);
        st.b7.copy_tx = payUri(E.PAYER_WALLET, E.PAYER_IDENTITY, [{ to: st.rules.B2.pay_to, amount: '0.0002', memo: st.bids['B2-E4'].memo }]);
        log(`B7: a 0.00015 bid in the 0.0002 tranche paid in ${st.b7.over_tx}; a copy of E4's memo paid in ${st.b7.copy_tx}`);
        save(st);
      }
    },
    async watch() {
      // until the deadline: small payments by each choice, B5's warning, B8, B4 and B5's take backs
      st.watch = st.watch || { coins: {}, b5: {}, b8: {}, b4: {} };
      const R = st.rules;
      const seen = {};
      await until('the deadline of every auction', async () => {
        const t = await tip();
        for (const x of Object.keys(st.ids)) {
          const s = await status(x);
          const key = `${s.sealed.deposits}/${s.sealed.coins_sent}`;
          if (seen[x] !== key) { seen[x] = key; log(`${x} at block ${t}: deposits ${s.sealed.deposits}, small payments ${s.sealed.coins_sent}, coin wallet ${s.sealed.coin_balance_zat} zat`); st.watch.coins[x] = (st.watch.coins[x] || []).concat([{ t, deposits: s.sealed.deposits, coins: s.sealed.coins_sent, balance: s.sealed.coin_balance_zat, at: new Date().toISOString() }]); }
          if (x === 'B5' && !st.watch.b5.warning) {
            const w = s.warnings.find((w) => w.level === 'bad' && /coin wallet could not pay/.test(w.text));
            if (w) { st.watch.b5.warning = { t, text: w.text }; log(`B5 dashboard: Needs action: ${w.text}`); }
          }
        }
        // B8: A3 of B1, once PROTECTED: its page closed; opened again ten minutes later
        if (!st.watch.b8.closed_at) {
          const l = await look('B1', 'A3', '^PROTECTED$');
          if (l.title === 'PROTECTED') { st.watch.b8.closed_at = new Date().toISOString(); st.watch.b8.before = l; log(`B8: B1-A3 PROTECTED, page closed`); }
        } else if (!st.watch.b8.reopened && Date.now() - Date.parse(st.watch.b8.closed_at) > 600000) {
          st.watch.b8.reopened = { at: new Date().toISOString(), ...(await look('B1', 'A3', '^PROTECTED$')) };
          log(`B8: B1-A3 opened again: ${st.watch.b8.reopened.title}`);
        }
        // B5: once its cutoff passes, the pages without a small payment say NOT PROTECTED and take their money back
        if (t >= R.B5.cutoff && !st.watch.b5.done) {
          st.watch.b5.pages = {};
          for (const who of ['K2', 'K3', 'K4', 'K5']) {
            const l = await look('B5', who, 'NOT PROTECTED|on its way back');
            st.watch.b5.pages[who] = l;
            log(`B5-${who} page: ${l.title}: ${l.text}`);
            if (/NOT PROTECTED/.test(l.title)) { const c = await click('B5', who, '#take-back', 'on its way back'); st.watch.b5.pages[who].took_back = c.state.earlySent; log(`B5-${who}: ${c.msg} (${c.state.earlySent})`); }
          }
          st.watch.b5.k1 = await look('B5', 'K1', '^PROTECTED$');
          st.watch.b5.done = true;
        }
        // B4: H1 of B3 pays after the coin cutoff (from the test deposit helper), is told to take it back, and does
        if (t > R.B3.cutoff && !st.watch.b4.paid) {
          const b = st.bids['B3-H1'];
          const out = sh(`PAYER_WALLET=${E.PAYER_WALLET} PAYER_IDENTITY=${E.PAYER_IDENTITY} DEVTOOL=${E.DEVTOOL} app/web/pay-test-deposit.sh '${b.to}' ${b.amount} '${b.memo}'`);
          st.watch.b4.paid = { t, out: out.split('\n').slice(-1)[0] };
          log(`B4: B3-H1 paid after the cutoff (block ${t}, cutoff ${R.B3.cutoff}): ${out.split('\n').slice(-1)[0]}`);
        }
        if (st.watch.b4.paid && !st.watch.b4.told) {
          const l = await look('B3', 'H1', 'Take your money back now');
          if (/Take your money back now/.test(l.title)) {
            st.watch.b4.told = l; log(`B4: B3-H1 page: ${l.title}: ${l.text}`);
            const c = await click('B3', 'H1', '#take-back', 'on its way back');
            st.watch.b4.took_back = c.state.earlySent; log(`B4: B3-H1 ${c.msg} (${c.state.earlySent})`);
          }
        }
        save(st);
        return t > Math.max(...Object.values(R).map((r) => r.deadline)) ? t : null;
      }, 3600000, 30000);
      // every other page: PROTECTED at the deadline (B5's first, B1 to B3 but H1)
      st.watch.protected = {};
      const want = Object.values(st.bids).filter((b) => !['after_coin', 'late'].includes(b.group));
      await pool(want, 4, async (b) => { st.watch.protected[`${b.x}-${b.who}`] = (await look(b.x, b.who, '^PROTECTED$|Bidding has closed')).title; });
      log(`bid pages at the deadline: ${Object.entries(st.watch.protected).map(([k, t]) => `${k} ${t}`).join(', ')}`);
      save(st);
    },
    async b6() {
      // B6: D1 of B2 (a winner) sends its early ticket and its late ticket in the settlement window; both must be refused
      const ctx = await profile('B2', 'D1');
      try {
        const p = ctx.pages()[0] || await ctx.newPage();
        await p.goto(bidLink('B2'));
        await p.waitForFunction(() => document.querySelector('#st-title').textContent.length > 0, null, { timeout: 120000 });
        // the page checks and signs its late ticket once the host's small payment is in: give it the time that takes
        await p.waitForFunction((id) => { const s = JSON.parse(localStorage.getItem(`ll:sealed:${id}`) || '{}'); return s.late || s.lateProblem; }, st.ids.B2, { timeout: 300000, polling: 2000 });
        const raw = await p.evaluate(async (id) => {
          const W = await import('/pkg/ll_web.js'); await W.default();
          const s = JSON.parse(localStorage.getItem(`ll:sealed:${id}`));
          const hex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
          const early = JSON.parse(W.open_ticket(s.seed, JSON.stringify(s.ticket.entry), hex(s.ticket.blob_hex)));
          return { early: early.raw_hex, early_txid: early.txid, late: s.late.signed_hex, late_txid: s.late.txid };
        }, st.ids.B2);
        const t = await tip();
        st.b6 = { t, deadline: st.rules.B2.deadline, claim_after: st.rules.B2.claim_after, early_txid: raw.early_txid, late_txid: raw.late_txid };
        for (const k of ['early', 'late']) {
          fs.writeFileSync(`${DIR}/b6-${k}.hex`, raw[k]);
          let out;
          try { out = sh(`${E.CONTRIB} broadcast --raw ${DIR}/b6-${k}.hex --server https://testnet.zec.rocks:443 2>&1`, 180000); } catch (e) { out = String(e.stdout || '') + String(e.stderr || '') || String(e); }
          st.b6[k] = out.slice(-400);
          log(`B6: B2-D1 sends its ${k} ticket at block ${t} (deadline ${st.rules.B2.deadline}, late tickets after ${st.rules.B2.claim_after}): ${out.slice(-300)}`);
        }
      } finally { await ctx.close(); }
      save(st);
    },
    async close() {
      for (const x of Object.keys(st.ids)) {
        await until(`${x} round R out`, async () => Date.now() / 1000 > st.rules[x].round_time + 20, 3600000, 20000);
        const r = await api(`campaigns/${st.ids[x]}/close`, {});
        if (!r.ok) throw new Error(`${x} close: ${r.error}`);
        st[`close_${x}`] = r.log;
        log(`${x} closed: ${r.log.join(' | ')}`);
        save(st);
      }
      for (const x of Object.keys(st.ids)) {
        const s = await until(`${x} viewing key published`, async () => { const s = await status(x); return s.sealed.revealed ? s : null; }, 1800000, 20000);
        st[`result_${x}`] = { price_zat: s.sealed.price_zat, winners: s.sealed.winners, settlements: s.sealed.settlements, refunds: s.sealed.refunds_sent, self_check: s.self_check && s.self_check.results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.details.join('; ')}`), broadcasts: s.broadcasts };
        log(`${x}: price ${s.sealed.price_zat}, ${s.sealed.winners} winners, ${s.sealed.settlements} settlements, ${s.sealed.refunds_sent} refunds, viewing key published; self check fails: ${JSON.stringify(st[`result_${x}`].self_check)}`);
        save(st);
      }
    },
    async results() {
      st.pages_after = {};
      await pool(Object.values(st.bids), 4, async (b) => { const l = await look(b.x, b.who, 'won|did not win|on its way back'); st.pages_after[`${b.x}-${b.who}`] = l; });
      for (const [k, l] of Object.entries(st.pages_after)) log(`${k} after the close: ${l.title}: ${l.text}`);
      save(st);
      for (const x of Object.keys(st.ids)) {
        const p = await (await browser.newContext()).newPage();
        await p.goto(recountLink(x));
        await p.waitForFunction(() => !/Working|Reading/.test(document.querySelector('#verdict-title').textContent), null, { timeout: 900000 });
        st[`recount_${x}`] = { verdict: await p.textContent('#verdict-title'), text: await p.textContent('#verdict-text'), sources: (await p.textContent('#sources')).replace(/\s+/g, ' '), sealed: (await p.textContent('#sealed-card')).replace(/\s+/g, ' '), rules: (await p.textContent('#rules')).replace(/\s+/g, ' ') };
        log(`${x} recount in the browser: ${st[`recount_${x}`].verdict}: ${st[`recount_${x}`].text} | ${st[`recount_${x}`].sources.slice(0, 300)} | ${st[`recount_${x}`].sealed.slice(0, 900)}`);
        await p.context().close();
        save(st);
      }
      st.finished_at = new Date().toISOString();
      save(st);
    },
  };
  try {
    const order = ['create', 'fund', 'pages', 'deposits', 'watch', 'b6', 'close', 'results'];
    // "run" does every step; "from <step>" goes on from that step to the end
    const todo = step === 'run' ? order : step === 'from' ? order.slice(order.indexOf(process.argv[3])) : [step];
    for (const s of todo) {
      if (!steps[s]) throw new Error(`no step ${s}`);
      log(`--- step ${s}`);
      await steps[s]();
    }
  } catch (e) {
    log(`STOPPED: ${String(e).slice(0, 600)}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
