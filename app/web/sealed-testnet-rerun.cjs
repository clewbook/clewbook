// The short rerun of B4 and B8 on the public test network, with the quick test timing, plus a deposit mined after the deadline (B9), through
// the real pages (set up page and dashboard on 127.0.0.1:8786, bid and recount pages on app-test.clewbook.xyz, the test relay, public
// chain servers, live drand quicknet). One auction: uniform price, 1 item, small payments at once, deadline 30 blocks, ticket window 10.
//   X, Y, Z1, Z2 and Z3 bid at once, and each of their pages is kept open after its small payment until it says PROTECTED, before the deadline; X's page (B8) is closed once PROTECTED and opened again before the deadline: still PROTECTED, and right after the close.
//   H (B4) pays the moment the coin cutoff has passed, so the deposit is mined after it and before the deadline: its bid does not count, its page
//   says to take the money back now with the early ticket, and it does, before the deadline.
//   L (B9) pays after the deadline: the host sends it back on its own, minus the network fee, names it on the list, and the recount checks it.
// State <RERUN_DIR>/state.json, log <RERUN_DIR>/run.log (default runs/testnet-rerun). Env: DEVTOOL, PAYER_WALLET, PAYER_IDENTITY, HOST_WALLET,
// HOST_IDENTITY; RERUN_DIR, RERUN_NAME, B4_AFTER (blocks after the cutoff for H's payment, default 1).
// PEOPLE_ONLY=X,Y,Z1 keeps only those bids (B4 runs only with H, B9 only with L); NO_B8=1 skips B8. TREASURY_TO: after the recount, the
// dashboard's "Send to my wallet" sends the treasury there, and the run waits for that payment to be mined.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');
const DIR = process.env.RERUN_DIR || 'runs/testnet-rerun', STATE = `${DIR}/state.json`;
const E = process.env;
// DASH, APP and RELAY can be set: the check of the review fixes runs its own dashboard, pages and relay on this machine
const DASH = E.DASH || 'http://127.0.0.1:8786', APP = E.APP || 'https://app-test.clewbook.xyz', RELAY = E.RELAY || 'https://relay-test.clewbook.xyz', CHAIN = 'https://zjs.zec.rocks/testnet';
const NAME = E.RERUN_NAME || 'Sealed rerun B4 B8 B9';
// B4 pays this many blocks after the coin cutoff (the deposit must still be mined at least 3 blocks before the deadline)
const B4_AFTER = Number(E.B4_AFTER || 1);
const ONLY = E.PEOPLE_ONLY ? E.PEOPLE_ONLY.split(',') : null;
const PEOPLE = [['X', '0.0004', '0.0003'], ['Y', '0.0002', '0.0001'], ['Z1', '0.0004', '0.00025'], ['Z2', '0.0002', '0.00007'], ['Z3', '0.0002', '0.00005'],
  ['H', '0.0002', '0.00009'], ['L', '0.0002', '0.00008']].filter(([who]) => !ONLY || ONLY.includes(who));
const ORDINARY = ['X', 'Y', 'Z1', 'Z2', 'Z3'].filter((who) => !ONLY || ONLY.includes(who)); // every one of these pages must be seen PROTECTED before the deadline
const HAS = (who) => PEOPLE.some(([w]) => w === who), DO_B8 = HAS('X') && !E.NO_B8;
const COIN_FUNDING = E.COIN_FUNDING || '0.0015', COIN_EACH_WORST = 15000; // a 5000 zatoshi coin and a 10000 zatoshi fee, if each goes alone
fs.mkdirSync(`${DIR}/profiles`, { recursive: true });
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); fs.appendFileSync(`${DIR}/run.log`, `${line}\n`); };
const sh = (cmd, t = 900000) => execSync(cmd, { encoding: 'utf8', timeout: t, shell: '/bin/bash' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, f, ms, every = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await f().catch(() => null); if (v) return v; await sleep(every); }
  throw new Error(`timed out after ${Math.round(ms / 60000)} min: ${what}`);
}
// the test payer's notes can all be change from the last payment, waiting for a confirmation: try again for up to 10 minutes
const payDeposit = (b) => {
  let last = '';
  for (let i = 0; i < 20; i += 1) {
    let out = '';
    try { out = sh(`PAYER_WALLET=${E.PAYER_WALLET} PAYER_IDENTITY=${E.PAYER_IDENTITY} DEVTOOL=${E.DEVTOOL} app/web/pay-test-deposit.sh '${b.to}' ${b.amount} '${b.memo}'`); } catch (e) { out = String(e.stdout || e.message || e); }
    const txid = (out.match(/^[0-9a-f]{64}$/m) || [])[0];
    if (txid) return txid;
    last = out.slice(-300);
    execSync('sleep 30');
  }
  throw new Error(`payment not sent: ${last}`);
};

(async () => {
  const browser = await chromium.launch();
  const dash = await (await browser.newContext()).newPage();
  await dash.goto(`${DASH}/`);
  const api = (p, body) => dash.evaluate(async ({ p, body }) => (await fetch(`/api/${p}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) })).json(), { p, body });
  const status = () => api(`campaigns/${st.id}`);
  const tip = async () => (await status()).tip;
  const profile = (who) => chromium.launchPersistentContext(path.resolve(`${DIR}/profiles/${who}`), { headless: true });
  const bidLink = () => `${APP}/bid.html#c=${st.id}&relay=${RELAY}&server=${CHAIN}`;
  // a bid page, opened from its own profile, kept open until its title matches (the page checks and signs its late ticket meanwhile)
  const look = async (who, re, ms = 300000) => {
    const ctx = await profile(who);
    try {
      const p = ctx.pages()[0] || await ctx.newPage();
      await p.goto(bidLink());
      await p.waitForFunction((r) => new RegExp(r).test(document.querySelector('#st-title').textContent), re, { timeout: ms }).catch(() => {});
      return { title: await p.textContent('#st-title'), text: `${await p.textContent('#st-text')} ${await p.textContent('#st-more').catch(() => '')}`, state: await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)), st.id) };
    } finally { await ctx.close(); }
  };
  const takeBack = async (who) => {
    const ctx = await profile(who);
    try {
      const p = ctx.pages()[0] || await ctx.newPage();
      await p.goto(bidLink());
      await p.waitForSelector('#take-back:not([hidden])', { timeout: 300000 });
      await p.click('#take-back');
      await p.click('#take-yes'); // the page asks once more
      await p.waitForFunction(() => /on its way back/.test(document.querySelector('#st-title').textContent), null, { timeout: 120000 });
      return { msg: await p.textContent('#send-msg'), txid: await p.evaluate((id) => JSON.parse(localStorage.getItem(`ll:sealed:${id}`)).earlySent, st.id) };
    } finally { await ctx.close(); }
  };
  try {
    if (!st.id) {
      const p = await (await browser.newContext()).newPage();
      await p.goto(`${DASH}/setup.html`);
      await p.waitForSelector('#sealed-choice:not([hidden])', { timeout: 60000 });
      await p.check('input[name=mode][value=sealed_auction]');
      await p.fill('#campaign-name', NAME);
      await p.fill('#s-items', '1');
      await p.fill('#s-tranches', '0.0002\n0.0004');
      await p.check('input[name=spricing][value=uniform]');
      await p.check('input[name=scoins][value=at_once]');
      await p.check('input[name=stiming][value=quick]');
      await p.fill('#deadline', E.DEADLINE_IN || '30');
      await p.fill('#ticketk', '10');
      log(`set up page summary: ${(await p.textContent('#terms')).replace(/\s+/g, ' ').slice(0, 500)}`);
      await p.click('#create-btn');
      await p.waitForURL(`${DASH}/`, { timeout: 900000 }).catch(async () => { throw new Error(await p.textContent('#setup-error')); });
      st.id = (await api('campaigns')).campaigns.find((c) => c.name === NAME).id;
      st.created_at = new Date().toISOString();
      const s = await until('first check', async () => { const s = await status(); return s.sealed && s.tip != null ? s : null; }, 600000);
      st.r = { deadline: s.deadline_height, cutoff: s.sealed.cutoff, round: s.sealed.round, round_time: s.sealed.round_time, claim_after: s.sealed.claim_after, coin_address: s.sealed.coin_address, timing: s.sealed.timing, tip: s.tip };
      log(`created ${st.id}: timing ${s.sealed.timing}, tip ${s.tip}, cutoff ${s.sealed.cutoff}, deadline ${s.deadline_height}, round ${s.sealed.round} at ${new Date(s.sealed.round_time * 1000).toISOString()}, late tickets after ${s.sealed.claim_after}`);
      save();
      const out = sh(`echo y | ${E.DEVTOOL} wallet -w ${E.HOST_WALLET} sync -s testnet.zec.rocks:443 >/dev/null 2>&1; echo y | ${E.DEVTOOL} wallet -w ${E.HOST_WALLET} pay -i ${E.HOST_IDENTITY} --payment-uri 'zcash:${st.r.coin_address}?amount=${COIN_FUNDING}' -s testnet.zec.rocks:443 2>&1 | tail -1`);
      st.coin_funding = out; log(`coin wallet funded with ${COIN_FUNDING} TAZ: ${out}`); save();
    }
    // enough for every bid's small payment before any deposit: the worst case is one batch per bid (a coin and a fee each)
    if (!st.coin_checked) {
      const need = ORDINARY.length * COIN_EACH_WORST;
      const s = await until(`the coin wallet holds ${need} zatoshis`, async () => { const s = await status(); return s.sealed.coin_balance_zat >= need ? s : null; }, 900000, 15000)
        .catch(async () => { throw new Error(`the coin wallet holds ${(await status()).sealed.coin_balance_zat} zatoshis, less than the ${need} the bids need`); });
      st.coin_checked = { need, have: s.sealed.coin_balance_zat }; log(`coin wallet holds ${s.sealed.coin_balance_zat} zatoshis, enough for ${ORDINARY.length} bids (${need})`); save();
    }
    if (!st.bids) {
      const refund = sh(`${E.DEVTOOL} wallet -w ${E.PAYER_WALLET} list-addresses 2>/dev/null | sed -n 's/.*Default Address: //p' | head -1`);
      st.bids = {};
      for (const [who, deposit, bid] of PEOPLE) {
        const ctx = await profile(who);
        try {
          const p = ctx.pages()[0] || await ctx.newPage();
          await p.goto(bidLink());
          await p.waitForSelector('#form-card:not([hidden])', { timeout: 150000 });
          await p.click(`#tranche [data-zat="${Math.round(Number(deposit) * 1e8)}"]`);
          await p.fill('#bid', bid); await p.fill('#refund', refund);
          // the button waits for a good bid and address, and for the auction to take deposits
          await p.waitForFunction(() => !document.querySelector('#create').disabled, null, { timeout: 180000 })
            .catch(async () => { throw new Error(`${who}: the bid form stayed closed: ${await p.textContent('#bid-hint')} ${await p.textContent('#bid-error')} ${await p.textContent('#refund-msg')}`); });
          await p.click('#create');
          await p.waitForSelector('#pay-card:not([hidden])', { timeout: 60000 });
          const full = (sel) => p.$eval(sel, (e) => e.dataset.full || e.textContent);
          st.bids[who] = { memo: await full('#memo'), to: await full('#pay-to'), amount: await full('#pay-amt'), deposit, bid };
        } finally { await ctx.close(); }
      }
      log(`${PEOPLE.length} bid pages made their payments`);
      save();
    }
    // each payment is saved as it is made, so a retry pays only what is still unpaid
    for (const who of ORDINARY) { if (st.bids[who].tx) continue; st.bids[who].tx = payDeposit(st.bids[who]); log(`${who} paid: ${st.bids[who].tx}`); save(); }
    // B8 and B4 at the same time (each has its own moment), then B9
    const b8 = async () => {
    // B8: X once PROTECTED (late ticket checked and signed): page closed, opened again three minutes later, before the deadline
    if (!st.b8) {
      const a = await until('X PROTECTED', async () => { const l = await look('X', '^PROTECTED$'); return l.title === 'PROTECTED' ? l : null; }, 1500000, 5000);
      const closedAt = await tip();
      log(`B8: X PROTECTED at block ${closedAt} (late ticket ${a.state.late && a.state.late.txid}); page closed`);
      await sleep(180000);
      const b = await look('X', '^PROTECTED$', 120000);
      const t = await tip();
      st.b8 = { closed: { t: closedAt, title: a.title, text: a.text }, reopened: { t, title: b.title, text: b.text, same_late: !!(b.state.late && a.state.late && b.state.late.txid === a.state.late.txid) }, deadline: st.r.deadline };
      log(`B8: X opened again at block ${t} (deadline ${st.r.deadline}): ${b.title}: ${b.text}`);
      save();
    }
    };
    // each step of B4 and B9 is kept in the state, so a retry goes on from where it stopped and never pays twice
    const b4 = async () => {
      st.b4 = st.b4 || {};
      if (!st.b4.tx) {
        // B4: H pays B4_AFTER blocks after the coin cutoff
        await until(`${B4_AFTER} block(s) after the coin cutoff`, async () => (await tip()) >= st.r.cutoff + B4_AFTER, 1800000, 5000);
        st.b4.paid_at = await tip();
        st.b4.tx = payDeposit(st.bids.H);
        log(`B4: H paid at block ${st.b4.paid_at} (cutoff ${st.r.cutoff}, deadline ${st.r.deadline}): ${st.b4.tx}`);
        save();
      }
      if (!st.b4.told) {
        const l = await until('H told to take its money back', async () => { const l = await look('H', 'Your bid does not count', 60000); return /Your bid does not count/.test(l.title) ? l : null; }, 900000, 5000);
        st.b4.told = { t: await tip(), title: l.title, text: l.text, mined: l.state.ticket && l.state.ticket.entry && l.state.ticket.entry.contribution.height };
        log(`B4: H page at block ${st.b4.told.t}: ${l.title}: ${l.text}`);
        save();
      }
      if (!st.b4.took_back) {
        const c = await takeBack('H');
        st.b4.took_back = { t: await tip(), ...c };
        log(`B4: H ${c.msg} (${c.txid})`);
        save();
      }
      if (!st.b4.back) {
        // the early ticket must be mined by the deadline: the page says so once the chain shows it
        const back = await until('H early ticket mined', async () => { const l = await look('H', 'Your money is back', 90000); return /Your money is back/.test(l.title) ? l : null; }, 900000, 10000);
        st.b4.back = { t: await tip(), title: back.title, text: back.text, mined: back.state.earlyMined, deadline: st.r.deadline };
        log(`B4: H page at block ${st.b4.back.t}: ${back.title}: ${back.text}`);
        save();
        if (!(back.state.earlyMined <= st.r.deadline)) throw new Error(`B4: H's early ticket mined in block ${back.state.earlyMined}, after the deadline ${st.r.deadline}`);
      }
    };
    const b9 = async () => {
      st.b9 = st.b9 || {};
      if (!st.b9.tx) {
        // B9: L pays after the deadline
        await until('the deadline passed', async () => (await tip()) > st.r.deadline, 1800000, 5000);
        st.b9.paid_at = await tip();
        st.b9.tx = payDeposit(st.bids.L);
        log(`B9: L paid at block ${st.b9.paid_at} (deadline ${st.r.deadline}): ${st.b9.tx}`);
        save();
      }
      if (!st.b9.returned) {
        const s = await until('the host sends L back', async () => { const s = await status(); return s.sealed.late_returns >= 1 ? s : null; }, 1200000, 10000);
        st.b9.returned = { t: s.tip, broadcasts: s.broadcasts.filter((b) => b.kind === 'late_return'), note: s.warnings.find((w) => /too late to bid/.test(w.text)) };
        log(`B9: the host sent L back at block ${s.tip}: ${JSON.stringify(st.b9.returned).slice(0, 500)}`);
        save();
      }
      if (!st.b9.page) {
        const l = await until('L page shows the return', async () => { const l = await look('L', 'came too late', 90000); return /came too late/.test(l.title) ? l : null; }, 900000, 15000);
        st.b9.page = { title: l.title, text: l.text }; log(`B9: L page: ${l.title}: ${l.text}`);
        save();
      }
    };
    // every ordinary page but X (whose page B8 opens): seen PROTECTED before the deadline
    const protectedAll = async () => {
      st.protected = st.protected || {};
      await Promise.all(ORDINARY.filter((w) => (w !== 'X' || !DO_B8) && !st.protected[w]).map(async (who) => {
        const l = await until(`${who} PROTECTED`, async () => { const l = await look(who, '^PROTECTED$'); return l.title === 'PROTECTED' ? l : null; }, 1500000, 5000);
        const t = await tip();
        st.protected[who] = { t, before_deadline: t <= st.r.deadline, title: l.title, text: l.text, late: l.state.late && l.state.late.txid };
        log(`${who} PROTECTED at block ${t} (deadline ${st.r.deadline}), late ticket ${st.protected[who].late}`);
        save();
      }));
    };
    const once = (name, f) => f().catch(async (e) => { log(`${name} failed (${String(e).slice(0, 200)}); trying it once more`); st.retried = (st.retried || []).concat(name); save(); return f(); });
    await Promise.all([DO_B8 && once('B8', b8), once('PROTECTED', protectedAll), (async () => { if (HAS('H')) await once('B4', b4); if (HAS('L')) await once('B9', b9); })()]);
    // the close after round R, then the pages and the recount
    if (!st.closed) {
      // the Close button stays off until round R is out
      const p = await (await browser.newContext()).newPage();
      await p.goto(`${DASH}/`); await p.selectOption('#campaign-select', st.id).catch(() => {});
      await p.waitForTimeout(4000);
      st.close_button_before = { disabled: await p.$eval('#close-btn', (b) => b.disabled), text: (await p.textContent('#close-explain')).replace(/\s+/g, ' ') };
      log(`before round R: Close button disabled ${st.close_button_before.disabled}: ${st.close_button_before.text}`);
      await until('round R out', async () => Date.now() / 1000 > st.r.round_time + 20, 3600000, 15000);
      const r = await api(`campaigns/${st.id}/close`, {});
      if (!r.ok) throw new Error(`close: ${r.error}`);
      st.close_log = r.log; log(`closed: ${r.log.join(' | ')}`);
      st.closed = true; save();
    }
    const s = await until('viewing key published', async () => { const s = await status(); return s.sealed.revealed ? s : null; }, 1800000, 15000);
    st.result = { price_zat: s.sealed.price_zat, winners: s.sealed.winners, settlements: s.sealed.settlements, refunds: s.sealed.refunds_sent, late_returns: s.sealed.late_returns, self_check: s.self_check && s.self_check.results.map((x) => `${x.id} ${x.pass ? 'PASS' : 'FAIL'}${x.details.length ? `: ${x.details.join('; ')}` : ''}`) };
    log(`result: ${JSON.stringify(st.result).slice(0, 1500)}`);
    st.pages_after = {};
    for (const [who] of PEOPLE) { const l = await look(who, 'won|did not win|on its way back', 120000); st.pages_after[who] = { title: l.title, text: l.text }; log(`${who} after the close: ${l.title}: ${l.text}`); }
    // C1 and H2: with open payouts every page that is paid by the host (a refund, a winner's change) opens that payment on the chain with its
    // own key once it is mined, and says it pays its refund address
    if (E.CHECK_PAYOUTS) {
      st.payouts = {};
      for (const who of ORDINARY) {
        const l = await until(`${who} checks its payment on the chain`, async () => { const l = await look(who, 'Checked on the chain|does not pay you', 90000); return /Checked on the chain|does not pay you/.test(l.text + l.title) ? l : null; }, 1200000, 15000).catch(() => null);
        st.payouts[who] = l ? { title: l.title, text: l.text, payout: l.state.payout } : { missing: true };
        log(`${who} payout check: ${l ? `${l.title}: ${l.text}` : 'not seen in 20 minutes'}`);
      }
      save();
    }
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${APP}/recount.html#c=${st.id}&relay=${RELAY}`);
    await p.waitForFunction(() => !/Working|Reading/.test(document.querySelector('#verdict-title').textContent), null, { timeout: 900000 });
    st.recount = { verdict: await p.textContent('#verdict-title'), rules: (await p.textContent('#rules')).replace(/\s+/g, ' '), sources: (await p.textContent('#sources')).replace(/\s+/g, ' ') };
    log(`recount in the browser: ${st.recount.verdict} | ${st.recount.sources.slice(0, 300)} | ${st.recount.rules.slice(0, 1500)}`);
    if (E.TREASURY_TO && !st.treasury) {
      const s = await until('the treasury balance shows', async () => { const s = await status(); return s.self_check && s.self_check.treasury_send_zat > 0 ? s : null; }, 900000, 15000);
      const r = await api(`campaigns/${st.id}/treasury-send`, { address: E.TREASURY_TO });
      if (!r.ok) throw new Error(`treasury send: ${r.error}`);
      st.treasury = { held: s.self_check.treasury_zat, sent: s.self_check.treasury_send_zat, txid: r.txid }; log(`treasury: held ${st.treasury.held}, sent ${st.treasury.sent} zatoshis: ${r.txid}`); save();
      const after = await until('the treasury payment mined', async () => { const s = await status(); return s.self_check && s.self_check.treasury_zat === 0 ? s : null; }, 1200000, 15000);
      st.treasury.after = { tip: after.tip, all_pass: after.self_check.all_pass }; log(`treasury empty at block ${after.tip}; self check still passes: ${after.self_check.all_pass}`); save();
    }
    st.finished_at = new Date().toISOString(); save();
  } catch (e) {
    log(`STOPPED: ${String(e).slice(0, 600)}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
