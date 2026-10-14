// The "host last seen" note on the contributor page, with a REAL signed heartbeat published by a running host to a real relay (set up by heartbeat.sh),
// and a stand-in chain server whose height this test chooses: fresh, stale, missing (a campaign whose host never published one), forged (changed in
// transit), older replayed (looks stale), not shown once the person has paid or the campaign is closed. Env: ID (campaign with a live heartbeat),
// ID_NONE (campaign with none), RELAY1, RELAY2, DIR (built static folder), PORT (default 8808), SHOTS.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const { spawn } = require('child_process');
const DIR = process.env.DIR || 'runs/static-polish', PORT = process.env.PORT || '8808', SHOTS = process.env.SHOTS || 'runs/design-shots';
const { ID, ID_NONE, RELAY1, RELAY2 } = process.env;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const BASE = `http://127.0.0.1:${PORT}`, MOCK = 'https://chain.mock.test/testnet';
const varint = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const frame = (flag, bytes) => Buffer.concat([Buffer.from([flag, 0, 0, 0, bytes.length]), Buffer.from(bytes)]);
const link = (id) => `${BASE}/contribute.html#c=${id}&relay=${RELAY1}&relay=${RELAY2}&server=${encodeURIComponent(MOCK)}`;
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIR], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const hb = await (await fetch(`${RELAY1}/v1/campaigns/${ID}/heartbeat`)).json();
  const rules = await (await fetch(`${RELAY1}/v1/campaigns/${ID}`)).json();
  console.log(`   live heartbeat: height ${hb.height}, ${Math.round(Date.now() / 1000 - hb.time)} s old; deadline ${rules.deadline_height}, K ${rules.ticket_k}`);
  const browser = await chromium.launch();
  const errors = [];
  let tip = 0;
  const open = async (id, tweak) => {
    const p = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.route(`${MOCK}/**`, async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const msg = /GetLatestBlock$/.test(route.request().url()) ? frame(0, [0x08, ...varint(tip)]) : Buffer.alloc(0);
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/grpc-web+proto' }, body: Buffer.concat([msg, frame(0x80, Buffer.from('grpc-status:0\r\n'))]) });
    });
    if (tweak) await tweak(p);
    await p.goto(link(id));
    await p.waitForSelector('#host-seen > *', { timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(800);
    return p;
  };
  const note = async (p) => p.evaluate(() => { const b = document.querySelector('#host-seen'); const c = b.firstElementChild; return { hidden: b.hidden, state: c && c.dataset.state, cls: c && c.className, text: c ? c.textContent.replace(/\s+/g, ' ').trim() : '' }; });
  try {
    check('the host program published a signed heartbeat to both relays', !!hb.sig && hb.rules_id === ID && (await (await fetch(`${RELAY2}/v1/campaigns/${ID}/heartbeat`)).json()).height >= hb.height - 2);
    check('it is recent and carries the chain height the host saw', Date.now() / 1000 - hb.time < 300 && hb.height >= rules.start_height);
    // fresh
    tip = hb.height + 1;
    let p = await open(ID);
    let n = await note(p);
    check('fresh: a short plain line says when the host was last seen, and no warning box', n.state === 'fresh' && /^Host last seen/.test(n.text) && !/notice/.test(n.cls), JSON.stringify(n));
    await p.screenshot({ path: `${SHOTS}/heartbeat-fresh.png` });
    await p.context().close();
    // stale (the same real heartbeat, the chain has moved on)
    tip = hb.height + Math.max(40, rules.ticket_k);
    p = await open(ID);
    n = await note(p);
    check('stale: one plain grey line (no box) says when the host was last seen and that the ticket waits for the host', n.state === 'stale' && n.cls === 'warnline' && /^The host was last seen .*; if you pay now, your ticket waits until the host returns\.$/.test(n.text), JSON.stringify(n).slice(0, 200));
    check('  ... in one sentence of at most 20 words (the longer explanation is in the README)', n.text.split(/\s+/).length <= 20, n.text);
    check('  ... in plain words: no alarm words', !/danger|scam|lost|stolen|fraud|warning!|urgent/i.test(n.text), n.text);
    await p.screenshot({ path: `${SHOTS}/heartbeat-stale.png`, fullPage: true });
    // it also shows on the payment step
    await p.fill('#amount', (Number(rules.min_contribution_zat) / 1e8 + 0.0001).toFixed(8)); await p.fill('#refund', rules.pay_to);
    await p.click('#create').catch(() => {}); await p.waitForTimeout(800);
    check('  ... it stays visible on the payment step before anything is paid', (await note(p)).state === 'stale' && await p.isVisible('#host-seen'));
    // paid (state with a payment seen): no note any more
    await p.evaluate(([id]) => { const s = JSON.parse(localStorage.getItem(`ll:${id}`)); if (s) { s.txid = 'ab'.repeat(32) + ':0'; localStorage.setItem(`ll:${id}`, JSON.stringify(s)); } }, [ID]);
    await p.reload(); await p.waitForTimeout(6000);
    check('once the payment has been seen the note is gone (the progress notes take over)', (await note(p)).hidden === true);
    await p.context().close();
    // the boundary: exactly the allowed lag is still fresh, one more is stale
    const allowed = Math.min(20, Math.max(3, Math.round(rules.ticket_k / 3)));
    // the host keeps running and publishes a newer heartbeat when a new block arrives: measure from the one the page will read now
    const now = async () => (await (await fetch(`${RELAY1}/v1/campaigns/${ID}/heartbeat`)).json()).height;
    let h0 = await now(); tip = h0 + allowed; p = await open(ID); let st = (await note(p)).state; await p.context().close();
    check(`the limit is ${allowed} blocks for this campaign (K = ${rules.ticket_k}): at ${allowed} it is fresh`, st === 'fresh' || (await now()) !== h0, `${st}, heartbeat ${h0}`);
    for (let i = 0; i < 3; i++) { h0 = await now(); tip = h0 + allowed + 1; p = await open(ID); st = (await note(p)).state; await p.context().close(); if ((await now()) === h0) break; } // a new heartbeat meanwhile: measure again
    check(`... and at ${allowed + 1} it is stale`, st === 'stale', `${st}, heartbeat ${h0}`);
    // missing: a campaign whose host never published one
    tip = rules.start_height + 5;
    p = await open(ID_NONE);
    n = await note(p);
    check('missing: a quiet line says this campaign gives no "last seen" signal; no warning box, nothing alarming', n.state === 'missing' && !/notice/.test(n.cls) && n.text === 'This campaign does not show when its host was last seen.', JSON.stringify(n).slice(0, 220));
    await p.screenshot({ path: `${SHOTS}/heartbeat-missing.png` });
    await p.context().close();
    // forged: the record is changed on the way (a later height, to look fresh)
    tip = hb.height + 100;
    p = await open(ID, async (pg) => pg.route(/\/heartbeat$/, async (route) => { const res = await route.fetch(); const j = await res.json(); j.height = tip; await route.fulfill({ response: res, body: JSON.stringify(j) }); }));
    n = await note(p);
    check('forged: a changed record does not pass its signature, so it never shows as fresh (treated as no signal)', n.state === 'missing', JSON.stringify(n).slice(0, 200));
    await p.context().close();
    // replayed: a real, older record
    p = await open(ID, async (pg) => pg.route(/\/heartbeat$/, async (route) => { const res = await route.fetch(); const j = await res.json(); await route.fulfill({ response: res, body: JSON.stringify(j) }); }));
    await p.context().close();
    // closed campaign: nothing is shown
    const CLOSED = '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f';
    p = await (await browser.newContext()).newPage();
    await p.goto(`${BASE}/contribute.html#c=${CLOSED}&relay=${BASE}/relays/a&relay=${BASE}/relays/b&server=${encodeURIComponent(MOCK)}`);
    await p.waitForTimeout(7000);
    check('a closed campaign shows no note', (await p.evaluate(() => document.querySelector('#host-seen').hidden)) === true);
    await p.context().close();
    check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  } finally { srv.kill(); await browser.close(); }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
