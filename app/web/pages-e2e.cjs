// Drives the campaign page and the recount page against a real testnet campaign and local relays.
// Env: LINK (contribute link of the campaign), SHOTS. Optional: STOP_RELAY_PORT to test a down relay is not needed here.
const { chromium } = require('./../vectors/js/node_modules/playwright');
const fs = require('fs');
const SHOTS = process.env.SHOTS || 'runs/page/shots';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const tail = process.env.LINK.slice(process.env.LINK.indexOf('#'));
const base = process.env.LINK.slice(0, process.env.LINK.indexOf('contribute.html'));
const txt = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();

(async () => {
  // wait (with a limit) until both relays show the same list: a relay that was just restarted catches up on the host's next pass
  const rid = process.env.LINK.match(/#c=([0-9a-f]{64})/)[1];
  for (let i = 0; i < 60; i++) {
    const lists = await Promise.all(['8787', '8788'].map((p) => fetch(`http://127.0.0.1:${p}/v1/campaigns/${rid}/ledger?from=0`).then((r) => r.text()).catch(() => null)));
    if (lists[0] && lists[0] === lists[1] && lists[0].length > 2) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const errors = [];
  const open = async (url) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text())); await p.goto(url); return p; };

  // ---- campaign page ----
  let p = await open(`${base}campaign.html${tail}`);
  await p.waitForSelector('#links:not([hidden])', { timeout: 60000 });
  const facts = await txt(p, '#facts');
  check('campaign page shows type, goal, status, deadline', /Fundraiser/.test(facts) && /Goal/.test(facts) && /Status/.test(facts) && /Deadline/.test(facts), facts.slice(0, 120));
  check('campaign page shows the ticket window in blocks, with what it means', /Ticket window\d+ blocks/.test(facts) && /claim their own refunds/.test(facts), facts.slice(facts.indexOf('Ticket window'), facts.indexOf('Ticket window') + 120));
  const lf = await txt(p, '#list-facts');
  check('campaign page counts the public list and tickets', /Entries in the public list\s*[1-9]/.test(lf) && /Refund tickets issued\s*[1-9]/.test(lf), lf);
  check('campaign page links to contribute and recount', /contribute\.html#c=/.test(await p.getAttribute('#contribute-link', 'href')) && /recount\.html#c=/.test(await p.getAttribute('#recount-link', 'href')));
  const snippet = await txt(p, '#badge-code');
  check('badge snippet is a small iframe of the badge page, with a plain link to the recount as its fallback, and claims nothing', /<iframe src="[^"]*badge\.html#c=/.test(snippet) && /recount\.html#c=/.test(snippet) && !/verified|secure|audited/i.test(snippet), snippet.slice(0, 160));
  check('badge preview is the badge page', /badge\.html#c=/.test(await p.getAttribute('#badge-preview iframe', 'src')));
  check('no horizontal scrolling on a phone (campaign page)', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await p.screenshot({ path: `${SHOTS}/30-campaign.png`, fullPage: true });
  const recountHref = await p.getAttribute('#recount-link', 'href');

  // ---- recount page, normal ----
  p = await open(recountHref);
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 240000 });
  const kind = await p.getAttribute('#verdict', 'data-kind');
  check('recount: all checks pass with two servers and two relays', kind === 'pass', `${kind}: ${await txt(p, '#verdict-title')}`);
  check('recount wording: "Checked against N servers", no claim of independence', /Checked against 2 servers/.test(await txt(p, '#verdict-text')) && !/independent servers/i.test(await txt(p, '#verdict')));
  check('recount notes that both testnet servers share hosting', /same hosting/.test(await txt(p, '#banners')));
  const rules = await txt(p, '#rules');
  const rows = await p.evaluate(() => [...document.querySelectorAll('#rules .chk')].map((d) => ({ id: d.querySelector('.id').textContent.replace(/\s+/g, ' ').trim().split(' ')[0], pass: d.classList.contains('pass'), chip: d.querySelector('.chip').textContent.trim() })));
  check('recount: R1 to R8 and R4b each shown as PASS', ['R1', 'R2', 'R3', 'R4', 'R4b', 'R5', 'R6', 'R7', 'R8'].every((r) => rows.some((x) => x.id.startsWith(r) && x.pass && /PASS/.test(x.chip))), rules.slice(0, 100));
  check('recount: R9 to R12 (auction checks) are not shown for a fundraiser', !rows.some((x) => /^R(9|10|11|12)/.test(x.id)), JSON.stringify(rows.map((x) => x.id)));
  check('recount: the Checked / Not checked lines, the run log and the report hash are shown', /R1/.test(await txt(p, '#checked-line')) && /one-time secret/.test(await txt(p, '#notchecked-line')) && /Checked against 2 servers on \d+ apparent hosting/.test(await txt(p, '#coverage-line')) && (await p.locator('#rf-hash .h-s').textContent()).length > 10 && /\d/.test(await txt(p, '#rf-height')));
  await p.click('#rules .chk:first-child .cid'); await p.waitForTimeout(200);
  check('recount: tapping a check id shows its name and a sentence, and does not open the row', /Rules/.test(await txt(p, '#rules .chk:first-child .tip')) && await p.isVisible('#rules .chk:first-child .tip') && !(await p.evaluate(() => document.querySelector('#rules .chk:first-child').open)));
  // the recount page's presentation: Not checked as ruled rows with a bold lead-in, an unambiguous time, plain copyable amounts, a note for a campaign past its deadline and not closed
  const ncRows = await p.evaluate(() => [...document.querySelectorAll('#notchecked-line .ncrow')].map((r) => ({ bold: r.querySelector('b') && r.querySelector('b').textContent, text: r.textContent })));
  check('recount: "Not checked" is one ruled row per item, each with a short bold lead-in in sentence case', ncRows.length >= 4 && ncRows.every((r) => r.bold && /^[A-Z]/.test(r.bold) && r.text.length > r.bold.length + 10), JSON.stringify(ncRows.map((r) => r.bold)));
  check('recount: "Ran at" is an unambiguous date and time with the zone (2026-10-08 15:45:22 UTC)', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(await txt(p, '#rf-time')), await txt(p, '#rf-time'));
  check('recount: the gap inside an amount is only visual: the text of an amount is a plain number', /Raised\s*\d+\.\d{8} TAZ/.test(await txt(p, '#totals')) && !/\d \d/.test((await txt(p, '#totals')).replace(/\d+\.\d{8} TAZ/g, '')) , (await txt(p, '#totals')).slice(0, 60));
  check('recount: server hosting is written "Fly.io, the zec.rocks network" (no parentheses inside the parentheses)', /\(Fly\.io, the zec\.rocks network\)/.test(await txt(p, '#sources')) && !/Fly\.io \(/.test(await txt(p, '#sources')), (await txt(p, '#sources')).slice(0, 120));
  {
    const idq = tail.match(/c=([0-9a-f]{64})/)[1];
    const led = await (await fetch(`http://127.0.0.1:8787/v1/campaigns/${idq}/ledger?from=0`)).json(), rl = await (await fetch(`http://127.0.0.1:8787/v1/campaigns/${idq}`)).json();
    const end = Number((await txt(p, '#rf-height')).replace(/,/g, ''));
    const expectNote = end > rl.deadline_height && !led.some((e) => e.kind === 'close');
    const note = await txt(p, '#open-note');
    check(`recount: a campaign past its deadline and not closed gets a plain note (expected here: ${expectNote ? 'yes' : 'no'}), which claims no check`, (await p.isVisible('#open-note')) === expectNote && (!expectNote || (/not been closed/.test(note) && /claim refunds with their own tickets/.test(note) && /does not check whether any were claimed/.test(note) && !/verified|checked that/.test(note))), note.slice(0, 120));
  }
  const totals = await txt(p, '#totals');
  check('recount: totals show contributions and amounts', /Contributions\s*[1-9]/.test(totals) && /Raised/.test(totals), totals.slice(0, 140));
  const sources = await txt(p, '#sources');
  check('recount: lists both servers and the relays used', (sources.match(/read blocks/g) || []).length === 2 && /Public list: [1-9]/.test(sources), sources.slice(0, 200));
  await p.screenshot({ path: `${SHOTS}/31-recount.png`, fullPage: true });

  // ---- one server stalls or is wrong: failover to the spare, never a silent pass ----
  const spare = 'https://zcash-testnet.chainsafe.dev';
  p = await open(recountHref.replace(/&endpoint=[^&]*/g, '') + '&endpoint=http://127.0.0.1:9&endpoint=https://zjs.zec.rocks/testnet&endpoint=' + spare);
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 240000 });
  const k2 = await p.getAttribute('#verdict', 'data-kind');
  const s2 = await txt(p, '#sources');
  check('recount: a dead endpoint is replaced by a spare and noted', k2 === 'pass' && /127\.0\.0\.1:9: did not answer/.test(s2), `${k2}; ${s2.slice(0, 160)}`);

  // ---- only one server answers: limited check, plainly said ----
  p = await open(recountHref.replace(/&endpoint=[^&]*/g, '') + '&endpoint=http://127.0.0.1:9&endpoint=https://zjs.zec.rocks/testnet');
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 240000 });
  const k3 = await p.getAttribute('#verdict', 'data-kind');
  check('recount: with one server the result is marked as limited, not a full pass', k3 === 'partial' && /Only one public server/.test(await txt(p, '#banners')), k3);

  // ---- relays disagree is never a pass ----
  const bad = tail.replace(/relay=[^&]*8788/, 'relay=http://127.0.0.1:8799'); // a relay that is not there
  p = await open(`${base}recount.html${bad}`);
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 240000 });
  const k4 = await p.getAttribute('#verdict', 'data-kind');
  check('recount: with one relay unreachable the result is limited and says so', k4 === 'partial' && /could not be reached/.test(await txt(p, '#banners')), k4);

  // ---- a user-supplied server ----
  p = await open(recountHref.replace(/&endpoint=[^&]*/g, ''));
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 240000 });
  await p.fill('#server-url', 'not a url'); await p.click('#add-server button');
  check('recount: a server address that is not a web address is refused plainly', await p.isVisible('#server-error'));
  await p.fill('#server-url', 'https://zcash-testnet.chainsafe.dev'); await p.click('#add-server button');
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind === 'working', null, { timeout: 20000 }).catch(() => {});
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 240000 });
  check('recount: adding a server runs the recount again with it in the link', (await p.evaluate(() => location.hash)).includes('endpoint=https://zcash-testnet.chainsafe.dev') && (await p.getAttribute('#verdict', 'data-kind')) === 'pass');
  // ---- contribute page label ----
  p = await open(process.env.LINK);
  await p.waitForSelector('#about-facts dt', { timeout: 60000 }); await p.waitForTimeout(3000);
  const about = await txt(p, '#about-facts');
  check('contribute page: the count is labelled "on the public list, including any taken back" with a link to the recount', /On the public list, including any taken back/.test(about) && !/Listed so far/.test(about) && /recount\.html#c=/.test(await p.getAttribute('#about-facts a', 'href')), about.slice(0, 160));

  // ---- relays disagree: one relay is behind (shorter list) -> cannot conclude, never a pass ----
  const { spawn, spawnSync } = require('child_process');
  const id = tail.match(/c=([0-9a-f]{64})/)[1];
  spawnSync('bash', ['-c', `rm -rf runs/page/relay-short && mkdir -p runs/page/relay-short/campaigns && cp -r runs/page/relay1/campaigns/${id} runs/page/relay-short/campaigns/ && rm -f runs/page/relay-short/campaigns/${id}/ledger/* runs/page/relay-short/campaigns/${id}/blobs/*`]);
  const shortRelay = spawn('./app/target/release/ll-relay', ['serve', '--dir', 'runs/page/relay-short', '--listen', '127.0.0.1:8791'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  p = await open(`${base}recount.html${tail.replace(/relay=[^&]*8788/, 'relay=http://127.0.0.1:8791')}`);
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 120000 });
  const k5 = await p.getAttribute('#verdict', 'data-kind');
  check('recount: relays that disagree give "cannot conclude", no rules table, no pass', k5 === 'cannot' && /RELAYS DISAGREE/.test(await txt(p, '#verdict-title')) && (await p.isHidden('#rules-card')), k5);
  await p.screenshot({ path: `${SHOTS}/32-recount-relays-disagree.png`, fullPage: true });
  p = await open(`${base}campaign.html${tail.replace(/relay=[^&]*8788/, 'relay=http://127.0.0.1:8791')}`);
  await p.waitForSelector('#links:not([hidden])', { timeout: 60000 });
  check('campaign page also warns when relays disagree', /RELAYS DISAGREE/.test(await txt(p, '#banners')));
  shortRelay.kill();

  // ---- servers disagree: one server leaves out the block with the payment -> cannot conclude ----
  const http = require('http');
  const ledger = await (await fetch(`http://127.0.0.1:8787/v1/campaigns/${id}/ledger?from=0`)).json();
  const payHeight = ledger[0].contribution.height;
  const varint = (b, field) => { let i = 0; while (i < b.length) { const tag = b[i++], f = tag >> 3, t = tag & 7; if (t === 0) { let v = 0, sh = 0, x; do { x = b[i++]; v += (x & 0x7f) * 2 ** sh; sh += 7; } while (x & 0x80); if (f === field) return v; } else if (t === 2) { let n = 0, sh = 0, x; do { x = b[i++]; n += (x & 0x7f) * 2 ** sh; sh += 7; } while (x & 0x80); i += n; } else if (t === 1) i += 8; else if (t === 5) i += 4; else break; } return null; };
  const proxy = http.createServer(async (req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const up = await fetch('https://zjs.zec.rocks/testnet' + req.url, { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' }, body: Buffer.concat(chunks) });
    let buf = new Uint8Array(await up.arrayBuffer());
    if (/GetBlockRange/.test(req.url)) { // drop the block that holds the payment
      const out = []; for (let i = 0; i < buf.length; ) { const flag = buf[i], len = new DataView(buf.buffer, buf.byteOffset + i + 1, 4).getUint32(0); const frame = buf.subarray(i, i + 5 + len); i += 5 + len; if (!(flag === 0 && varint(frame.subarray(5), 2) === payHeight)) out.push(frame); }
      buf = Buffer.concat(out);
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/grpc-web+proto' }); res.end(Buffer.from(buf));
  }).listen(9911);
  p = await open(recountHref.replace(/&endpoint=[^&]*/g, '') + '&endpoint=http://127.0.0.1:9911&endpoint=https://zcash-testnet.chainsafe.dev');
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 240000 });
  const k6 = await p.getAttribute('#verdict', 'data-kind');
  check('recount: servers that show different blocks give "cannot conclude", never a pass', k6 === 'cannot' && /SERVERS DISAGREE/.test(await txt(p, '#verdict-title')) && (await p.isHidden('#rules-card')), `${k6}; ${(await txt(p, '#banners')).slice(0, 200)}`);
  await p.screenshot({ path: `${SHOTS}/33-recount-servers-disagree.png`, fullPage: true });
  // the same single bad server alone: the page cannot tell, and must not claim a full pass
  p = await open(recountHref.replace(/&endpoint=[^&]*/g, '') + '&endpoint=http://127.0.0.1:9911');
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind && document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 240000 });
  const k7 = await p.getAttribute('#verdict', 'data-kind');
  check('recount: one server that hides a block is shown as a limited result (not a full pass)', k7 !== 'pass', k7 + ': ' + await txt(p, '#verdict-title'));
  proxy.close();

  // ---- incomplete link ----
  p = await open(`${base}recount.html#c=abc`);
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind === 'cannot', null, { timeout: 20000 });
  check('recount: an incomplete link gives a plain message', /incomplete/i.test(await txt(p, '#verdict-text')));

  check('no errors in the browser console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
