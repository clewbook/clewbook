// The one short testnet check of "cancel and refund all" (SPEC §4.4), through the real pages: a fundraiser that opted in, made on the
// testnet host's dashboard, with three contributions made on app.clewbook.xyz's contribute page and paid from a test wallet; a fourth
// payment code made before the cancel and paid after it. The host cancels; the check waits until the three refunds are mined and the late
// payment has come back on its own, then runs the recount in the browser and reads the pages. Test network only, play money.
// State in <DIR>/state.json, log in <DIR>/run.log; each step is kept, so a rerun goes on from where it stopped and never pays twice.
// Env: DASH (the dashboard, default http://127.0.0.1:8789), APP, RELAY, DEVTOOL, PAYER_WALLET, PAYER_IDENTITY, DIR, CAMPAIGN_NAME.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');
const E = process.env;
const DASH = E.DASH || 'http://127.0.0.1:8789', APP = E.APP || 'https://app.clewbook.xyz', RELAY = E.RELAY || 'https://relay.clewbook.xyz';
// the campaign's public name: CAMPAIGN_NAME only (never NAME, which a shell may set to the computer's name)
const DIR = E.DIR || 'runs/cancel-check', STATE = `${DIR}/state.json`, NAME = E.CAMPAIGN_NAME || 'Cancel and refund test';
fs.mkdirSync(`${DIR}/profiles`, { recursive: true });
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); fs.appendFileSync(`${DIR}/run.log`, `${line}\n`); };
const sh = (cmd, t = 900000) => execSync(cmd, { encoding: 'utf8', timeout: t, shell: '/bin/bash' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, f, ms, every = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await f().catch(() => null); if (v) return v; await sleep(every); }
  throw new Error(`timed out after ${Math.round(ms / 60000)} min: ${what}`);
}
const pay = (c) => {
  let last = '';
  for (let i = 0; i < 20; i += 1) {
    let out = '';
    try { out = sh(`PAYER_WALLET=${E.PAYER_WALLET} PAYER_IDENTITY=${E.PAYER_IDENTITY} DEVTOOL=${E.DEVTOOL} app/web/pay-test-deposit.sh '${c.to}' ${c.amount} '${c.memo}'`); } catch (e) { out = String(e.stdout || e.message || e); }
    const txid = (out.match(/^[0-9a-f]{64}$/m) || [])[0];
    if (txid) return txid;
    last = out.slice(-300);
    execSync('sleep 30');
  }
  throw new Error(`payment not sent: ${last}`);
};
const WHO = ['A', 'B', 'C', 'Late'];
const AMOUNT = { A: '0.0005', B: '0.0004', C: '0.0003', Late: '0.0003' };

(async () => {
  const browser = await chromium.launch();
  const dash = await (await browser.newContext()).newPage();
  await dash.goto(`${DASH}/`);
  const api = (p, body) => dash.evaluate(async ({ p, body }) => (await fetch(`/api/${p}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) })).json(), { p, body });
  const status = () => api(`campaigns/${st.id}`);
  const link = () => `c=${st.id}&relay=${RELAY}`;
  const text = async (url, sel, wait = 20000) => {
    const p = await (await browser.newContext()).newPage();
    try { await p.goto(url); await p.waitForTimeout(wait); return ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim(); } finally { await p.context().close(); }
  };
  try {
    if (!st.id) {
      const r = await api('campaigns', { mode: 'raise', goal_zat: 100000, deadline_in: Number(E.DEADLINE_IN || 300), min_contribution_zat: 20000, ticket_k: 10, relays: [RELAY], name: NAME, cancellable: true });
      if (!r.ok) throw new Error(`create: ${r.error}`);
      st.id = (await api('campaigns')).campaigns.find((c) => c.name === NAME).id; save();
      const s = await until('first check', async () => { const s = await status(); return s.tip != null ? s : null; }, 600000, 10000);
      st.deadline = s.deadline_height; save();
      log(`created ${st.id}: cancellable ${s.cancellable}, can cancel ${s.can_cancel}, tip ${s.tip}, deadline ${s.deadline_height}`);
    }
    // the campaign page says so, before anyone pays
    if (!st.optin_line) {
      st.optin_line = await text(`${APP}/campaign.html#${link()}`, 'main');
      st.optin_line = /The host can cancel and refund everyone, minus the network fee\./.test(st.optin_line) ? 'shown' : `MISSING: ${st.optin_line.slice(0, 200)}`;
      log(`campaign page opt in line: ${st.optin_line}`); save();
    }
    // four payment codes on the contribute page, made now; three are paid before the cancel, the last one after it
    if (!st.codes) {
      const refund = sh(`${E.DEVTOOL} wallet -w ${E.PAYER_WALLET} list-addresses 2>/dev/null | sed -n 's/.*Default Address: //p' | head -1`);
      st.codes = {};
      for (const who of WHO) {
        const ctx = await chromium.launchPersistentContext(path.resolve(`${DIR}/profiles/${who}`), { headless: true });
        try {
          const p = ctx.pages()[0] || await ctx.newPage();
          await p.goto(`${APP}/contribute.html#${link()}`);
          await p.waitForSelector('#amount', { state: 'visible', timeout: 120000 });
          await p.fill('#amount', AMOUNT[who]);
          await p.waitForFunction(() => !document.querySelector('#to-addr').disabled, null, { timeout: 60000 });
          await p.click('#to-addr'); await p.waitForSelector('#refund', { state: 'visible', timeout: 30000 });
          await p.fill('#refund', refund); await p.click('#create');
          await p.waitForSelector('#pay-card:not([hidden])', { timeout: 60000 });
          st.codes[who] = { to: (await p.textContent('#pay-to')).trim(), amount: AMOUNT[who], memo: (await p.textContent('#memo')).trim() };
        } finally { await ctx.close(); }
      }
      log('four payment codes made on the contribute page'); save();
    }
    for (const who of ['A', 'B', 'C']) { if (!st.codes[who].tx) { st.codes[who].tx = pay(st.codes[who]); log(`${who} paid ${AMOUNT[who]} TAZ: ${st.codes[who].tx}`); save(); } }
    if (!st.ticketed) {
      const s = await until('three tickets', async () => { const s = await status(); return s.counts && s.counts.tickets_issued >= 3 ? s : null; }, 1500000);
      st.ticketed = { tip: s.tip, raised: s.counts.raised_zat }; log(`3 tickets issued by block ${s.tip}, ${s.counts.raised_zat} zatoshis raised (goal 100000 met)`); save();
    }
    if (!st.cancel) {
      const r = await api(`campaigns/${st.id}/cancel`, { confirm: true });
      if (!r.ok) throw new Error(`cancel: ${r.error}`);
      const s = await status();
      st.cancel = { tip: s.tip, log: r.log, cancelled: s.cancelled, outcome: s.outcome }; log(`cancelled at block ${s.tip}: ${r.log.join(' | ')}`); save();
    }
    if (!st.codes.Late.tx) {
      // the payment after the cancel: the page would not take it any more, so its code was made before
      await until('a block after the cancel', async () => (await status()).tip > st.cancel.tip, 900000, 10000);
      st.codes.Late.tx = pay(st.codes.Late); log(`Late paid ${AMOUNT.Late} TAZ after the cancel: ${st.codes.Late.tx}`); save();
    }
    if (!st.refunds) {
      const s = await until('three refunds mined', async () => { const s = await status(); const rf = (s.broadcasts || []).filter((b) => b.kind === 'refund'); return rf.length >= 3 && rf.every((b) => b.status === 'confirmed') ? s : null; }, 1500000);
      st.refunds = (s.broadcasts || []).filter((b) => b.kind === 'refund').map((b) => ({ txid: b.txid, block: b.mined_height })); log(`refunds mined: ${JSON.stringify(st.refunds)}`); save();
    }
    if (!st.returned) {
      const s = await until('the late payment sent back and mined', async () => { const s = await status(); const lr = (s.broadcasts || []).filter((b) => b.kind === 'late_return'); return lr.length >= 1 && lr.every((b) => b.status === 'confirmed') ? s : null; }, 1800000);
      st.returned = (s.broadcasts || []).filter((b) => b.kind === 'late_return').map((b) => ({ txid: b.txid, block: b.mined_height })); log(`payment after the cancel sent back: ${JSON.stringify(st.returned)}`); save();
    }
    // the recount in the browser, and the pages
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${APP}/recount.html#${link()}`);
    await p.waitForFunction(() => !/Working|Reading/.test(document.querySelector('#verdict-title').textContent), null, { timeout: 900000 });
    st.recount = { verdict: (await p.textContent('#verdict-title')).trim(), totals: ((await p.textContent('#totals').catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 600), rules: ((await p.textContent('#rules')) || '').replace(/\s+/g, ' ').slice(0, 1500) };
    log(`recount: ${st.recount.verdict} | ${st.recount.totals}`);
    st.pages = {
      campaign: await text(`${APP}/campaign.html#${link()}`, 'main'),
      contribute_chip: await text(`${APP}/contribute.html#${link()}`, '#status-chip'),
    };
    const home = await (await browser.newContext()).newPage();
    await home.route('**/campaigns.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ campaigns: [{ id: st.id, relays: [RELAY] }] }) }));
    await home.addInitScript(() => { try { localStorage.setItem('cb-intro-seen', '1'); } catch { /* ignore */ } });
    await home.goto(`${APP}/`); await home.waitForTimeout(15000);
    st.pages.home_row = ((await home.textContent('#closed').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    log(`campaign page: ${(st.pages.campaign.match(/CANCELLED|Cancelled.{0,60}/g) || []).join(' || ')}`);
    log(`contribute page chip: ${st.pages.contribute_chip} | home closed row: ${st.pages.home_row}`);
    st.finished_at = new Date().toISOString(); save();
  } catch (e) {
    log(`STOPPED: ${String(e).slice(0, 600)}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
