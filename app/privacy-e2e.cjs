// Privacy leak test. For finished campaigns on the testnet it collects everything public (what the relays serve, what every page requests and
// shows, what the public viewing key decrypts on the chain) and FAILS if any of it contains a contributor's refund address, payer address,
// contributor secret, or a name. It also writes what the public data does reveal to runs/privacy/report.json.
// Env: CONFIG (json file made by app/privacy-test.sh), OUT (default runs/privacy).
const { chromium } = require('./vectors/js/node_modules/playwright');
const fs = require('fs');
const { spawnSync } = require('child_process');
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG, 'utf8'));
const OUT = process.env.OUT || 'runs/privacy';
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
// The names to look for are in an untracked local file (.local/forbidden-names.txt, or FORBIDDEN_NAMES_FILE), not in this script. Without it the test stops.
const NAMES_FILE = process.env.FORBIDDEN_NAMES_FILE || '.local/forbidden-names.txt';
if (!fs.existsSync(NAMES_FILE)) { console.error(`PRIVACY TEST ERROR: the list of forbidden names is missing: ${NAMES_FILE}. Create it (one "category: regex" per line; categories project, names, internal; see the comment at the top of app/audit.sh) or set FORBIDDEN_NAMES_FILE.`); process.exit(2); }
const NAME_RES = fs.readFileSync(NAMES_FILE, 'utf8').split('\n').map((l) => l.match(/^(project|names|internal|ids):\s*(.+)$/)).filter(Boolean).map((m) => Object.assign(new RegExp(m[2].trim(), 'i'), { category: m[1] }));
if (!NAME_RES.length) { console.error(`PRIVACY TEST ERROR: ${NAMES_FILE} has no project:, names: or internal: lines`); process.exit(2); }
const PAGES = ['campaign', 'recount', 'card', 'badge', 'contribute'];
const report = { subjects: {} };

/** Every forbidden value found in a buffer: strings as text, hex values as raw bytes and as text, in both cases. */
function scan(corpora, forbidden) {
  const hits = [];
  for (const c of corpora) {
    const text = c.buf.toString('latin1'), lower = text.toLowerCase();
    for (const f of forbidden) {
      for (const s of f.strings || []) if (s && (text.includes(s) || lower.includes(s.toLowerCase()))) hits.push({ in: c.label, what: f.label, as: 'text' });
      for (const h of f.hex || []) { if (h && (c.buf.includes(Buffer.from(h, 'hex')) || lower.includes(h.toLowerCase()))) hits.push({ in: c.label, what: f.label, as: 'bytes' }); }
    }
    for (const re of NAME_RES) if (!(c.allowIds && re.category === 'ids') && re.test(text)) hits.push({ in: c.label, what: `a forbidden name (list entry ${NAME_RES.indexOf(re) + 1})`, as: 'text' });
  }
  return hits;
}

(async () => {
  const browser = await chromium.launch();
  for (const s of cfg.subjects) {
    const rep = (report.subjects[s.name] = { id: s.id, kind: s.kind });
    const corpora = [];
    const add = (label, data, text = true) => corpora.push({ label, buf: Buffer.isBuffer(data) ? data : Buffer.from(String(data)), text });

    // 1. what the relays serve
    for (const r of s.relays) {
      const get = async (path) => { const res = await fetch(`${r}/v1/campaigns/${s.id}${path}`); return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) }; };
      const rules = await get(''); add(`${r} rules`, rules.buf);
      const led = await get('/ledger?from=0'); add(`${r} ledger`, led.buf);
      add(`${r} challenges`, (await get('/challenges')).buf);
      add(`${r} head`, (await get('/head')).buf);
      const entries = JSON.parse(led.buf.toString());
      if (r === s.relays[0]) {
        rep.rules_fields = Object.keys(JSON.parse(rules.buf.toString()));
        rep.entries = entries.length; rep.entry_kinds = [...new Set(entries.map((e) => e.kind))];
        rep.entry_fields = [...new Set(entries.flatMap((e) => Object.keys(e)))].sort();
        rep.contribution_fields = [...new Set(entries.filter((e) => e.contribution).flatMap((e) => Object.keys(e.contribution)))].sort();
        rep.amounts_public = entries.some((e) => e.contribution && e.contribution.value_zat != null);
        rep.txids = entries.filter((e) => e.contribution).map((e) => e.contribution.txid);
      }
      let blobs = 0;
      for (const e of entries.filter((x) => x.contribution)) { const t = await get(`/tickets/${e.contribution.nf}`); if (t.status === 200) { add(`${r} sealed ticket ${e.contribution.nf.slice(0, 8)}`, t.buf, false); blobs++; } }
      rep.sealed_tickets = blobs;
    }

    // 2. what every page requests, receives and shows (a visitor with no backup)
    rep.pages = {};
    for (const page of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      const p = await ctx.newPage();
      const reqs = [], tasks = [];
      p.on('request', (q) => { reqs.push(q.url()); if (q.postDataBuffer()) add(`${page} request body ${q.url().split('/').pop()}`, q.postDataBuffer(), false); });
      p.on('response', (res) => { tasks.push(res.body().then((b) => add(`${page} response ${res.url().split('?')[0].split('/').slice(-2).join('/')}`, b, /json|text|javascript|html|css/.test(res.headers()['content-type'] || '')), () => {})); });
      console.log(`   [${new Date().toISOString().slice(11, 19)}] ${s.name}: opening the ${page} page`);
      const url = `${cfg.base}/${page}.html#c=${s.id}${s.relays.map((r) => `&relay=${r}`).join('')}&server=${cfg.server}`;
      await p.goto(url);
      if (page === 'recount') await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind !== 'working', null, { timeout: 600000 });
      else if (page === 'campaign') await p.waitForSelector('#links:not([hidden])', { timeout: 90000 });
      else if (page === 'card') await p.waitForSelector('#card:not([hidden])', { timeout: 90000 });
      else if (page === 'badge') await p.waitForFunction(() => /…/.test(document.querySelector('#badge-name').textContent), null, { timeout: 30000 });
      else await p.waitForTimeout(8000);
      await p.waitForTimeout(1500);
      await Promise.all(tasks);
      add(`${page} page HTML`, await p.evaluate(() => document.documentElement.outerHTML));
      add(`${page} page text`, await p.evaluate(() => document.body.innerText));
      add(`${page} localStorage`, await p.evaluate(() => JSON.stringify({ ...localStorage })));
      add(`${page} URL`, p.url());
      rep.pages[page] = { requests: reqs.length, hosts: [...new Set(reqs.map((u) => new URL(u).host))] };
      if (page === 'recount') rep.recount_verdict = await p.getAttribute('#verdict', 'data-kind');
      if (page === 'campaign') rep.campaign_page_text = (await p.evaluate(() => document.querySelector('#entries').innerText)).split('\n').slice(0, 6).join(' | ').slice(0, 300);
      await ctx.close();
    }

    // 3. what the public viewing key decrypts on the chain
    const viewer = [];
    if (s.viewer && fs.existsSync(`${s.viewer}/data.sqlite`)) {
      const py = spawnSync('python3', ['-c', `
import sqlite3, json, sys
db = sqlite3.connect("file:${s.viewer}/data.sqlite?mode=ro", uri=True)
out = []
for pool in ("orchard", "ironwood", "sapling"):
    try: rows = db.execute(f"select n.value, n.memo, hex(t.txid), t.mined_height from {pool}_received_notes n join transactions t on t.id_tx = n.transaction_id").fetchall()
    except Exception: continue
    for v, m, tx, h in rows: out.append({"pool": pool, "value_zat": v, "memo_hex": (m or b"").hex(), "txid_hex_upper": tx, "height": h})
print(json.dumps(out))`], { encoding: 'utf8' });
      for (const n of JSON.parse(py.stdout || '[]')) viewer.push(n);
    }
    const memos = viewer.map((n) => Buffer.from(n.memo_hex, 'hex'));
    memos.forEach((m, i) => add(`viewing-key decrypted memo ${i}`, m, false));
    add('viewing-key decrypted notes (all fields)', JSON.stringify(viewer), true);
    rep.viewing_key = { notes: viewer.length, amounts_zat: viewer.map((n) => n.value_zat), memo_prefixes: [...new Set(memos.map((m) => m.toString('latin1').replace(/\0+$/, '').slice(0, 4)))], memo_lengths: [...new Set(memos.map((m) => m.toString('latin1').replace(/\0+$/, '').length))] };

    // everything the page server can hand out (the built modules, scripts, styles, fonts' names)
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'bundles' ? [] : walk(`${d}/${e.name}`)) : [`${d}/${e.name}`]));
    for (const f of walk(cfg.www)) add(`served file ${f.slice(cfg.www.length + 1)}`, fs.readFileSync(f), !/\.(wasm|woff2)$/.test(f));
    // The home page of the LIVE app server lists its campaigns from campaigns.json, which by design holds the real campaign numbers (they are public: the relay
    // gives them to everyone). That one file, in the live app server's folder only, is not held against the "ids" names. Nothing else is excused: every other
    // file of that folder, the upload folder (the hosted build, which includes the static demo), the examples and every subject's data are scanned for ids too.
    for (const c of corpora) if (c.label === 'served file campaigns.json') c.allowIds = true;
    // 4. the scan
    const forbidden = s.forbidden;
    const hits = scan(corpora, forbidden);
    rep.corpus = { items: corpora.length, bytes: corpora.reduce((a, c) => a + c.buf.length, 0) };
    check(`${s.name}: collected the relay data, five pages' traffic and the viewing-key decryption (${corpora.length} items, ${Math.round(rep.corpus.bytes / 1024)} KiB)`, corpora.length > 20 && rep.entries > 0);
    check(`${s.name}: the scan can see the data (every contribution's public transaction id is found in what was collected)`, rep.txids.length > 0 && rep.txids.every((t) => corpora.some((c) => c.buf.includes(t))));
    check(`${s.name}: the viewing key does decrypt the campaign's payments (${viewer.length} notes)`, viewer.length > 0 || s.viewer === null);
    // a positive control: the scanner must flag a planted address
    const planted = scan([...corpora, { label: 'planted', buf: Buffer.from(`xx ${forbidden.find((f) => f.strings && f.strings.length)?.strings[0]} yy`), text: true }], forbidden);
    check(`${s.name}: the scanner catches a planted contributor address (self-test)`, planted.some((h) => h.in === 'planted'));
    check(`${s.name}: NO contributor address, refund destination, payer address, contributor secret or name appears anywhere public`, hits.length === 0, JSON.stringify(hits.slice(0, 5)));
    check(`${s.name}: no page asked anything of a host other than this computer and the public chain servers`, Object.values(rep.pages).every((pg) => pg.hosts.every((h) => /^127\.0\.0\.1(:\d+)?$/.test(h) || /zec\.rocks|chainsafe\.dev/.test(h))), JSON.stringify([...new Set(Object.values(rep.pages).flatMap((pg) => pg.hosts))]));
    rep.forbidden_checked = forbidden.map((f) => ({ what: f.label, values: (f.strings || []).length + (f.hex || []).length }));
    rep.hits = hits;
  }
  if (process.env.UPLOAD_DIR) {
    // the folder that will be uploaded to a static host: every file (the browser modules as binary text too) against the forbidden names and ids, the
    // contributors' addresses and secrets of the test campaigns, and a few things that must never be in a public folder
    const up = process.env.UPLOAD_DIR;
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(`${d}/${x.name}`) : [`${d}/${x.name}`]));
    const files = walk(up);
    const corp = files.map((f) => ({ label: `upload ${f.slice(up.length + 1)}`, buf: fs.readFileSync(f), text: true }));
    const hits = scan(corp, cfg.examples_forbidden);
    check(`the upload folder (${files.length} files, ${Math.round(corp.reduce((a, c) => a + c.buf.length, 0) / 1024)} KiB) contains no forbidden name, mainnet id, contributor address, secret or name`, files.length > 0 && hits.length === 0, JSON.stringify(hits.slice(0, 5)));
    const bad = files.filter((f) => /\.(age|seed|sqlite|db|log|env|pem|key)$|(^|\/)(private|secrets|wallet[0-9]*|runs|\.local|\.git|node_modules)(\/|$)|backup\.json|secrets\.json/.test(f.slice(up.length + 1)));
    check('the upload folder holds no key, wallet, log, private folder or backup file', bad.length === 0, bad.slice(0, 5).join(' '));
    const paths = corp.filter((c) => /\/home\/|\/Users\/|C:\\Users|\/tmp\/[a-z]+-[0-9]+\/|runs\/(mainnet|pilot|static|polish)/.test(c.buf.toString('latin1')));
    check('the upload folder (including the built modules) carries no local folder path', paths.length === 0, paths.slice(0, 3).map((c) => c.label).join(' '));
    report.upload = { files: files.length, hits };
  }
  if (cfg.examples) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(`${d}/${x.name}`) : [`${d}/${x.name}`]));
    const files = walk(cfg.examples);
    const corp = files.map((f) => ({ label: `example ${f}`, buf: fs.readFileSync(f), text: true }));
    const hits = scan(corp, cfg.examples_forbidden);
    check(`the committed example data (${files.length} files, ${Math.round(corp.reduce((a, c) => a + c.buf.length, 0) / 1024)} KiB) contains no contributor address, secret or name`, files.length > 0 && hits.length === 0, JSON.stringify(hits.slice(0, 3)));
    report.examples = { files: files.length, hits };
  }
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
