// Shared by the campaign page and the recount page: reading a campaign's public list from its relays,
// and small formatting helpers. Link format: <page>.html#c=<campaign id>&relay=<url>&relay=<url>&endpoint=<url>&endpoint=<url>
import * as W from './pkg/ll_web.js';
import { grpcWeb } from './recount.js';
import { amountHTML, outcomeWords, decorateAmounts } from './ui.js';

export const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

// ---------- "Hosted by <label>" (owner decisions 16 Oct) ----------
// Only on an opened campaign (campaign page, contribute page), never on the home page. The label comes only from this site's own
// campaigns.json: the host object the listing job writes for an approved host, looked up by the campaign id; never from the link, a relay,
// the rules or anything the host sends. Campaigns of the hand kept list have no host object, so they show nothing.
const MAX_LABEL = 60;
/** The campaign name rules (as ll_core::rules::check_name): 1 to 60 characters, ordinary spaces only, no control, invisible or direction
 *  changing characters, no < or >. A label that breaks them is not shown. */
export function labelOk(s) {
  if (typeof s !== 'string') return false;
  const n = [...s].length;
  if (n === 0 || n > MAX_LABEL || s !== s.trim() || s.includes('  ')) return false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const invisible = cp === 0xAD || cp === 0x34F || cp === 0x61C || cp === 0x115F || cp === 0x1160 || cp === 0x17B4 || cp === 0x17B5 || (cp >= 0x180B && cp <= 0x180E)
      || (cp >= 0x200B && cp <= 0x200F) || (cp >= 0x2028 && cp <= 0x202E) || (cp >= 0x2060 && cp <= 0x206F) || cp === 0x3164 || (cp >= 0xFE00 && cp <= 0xFE0F)
      || cp === 0xFEFF || cp === 0xFFA0 || (cp >= 0xFFF9 && cp <= 0xFFFB) || (cp >= 0xE0000 && cp <= 0xE0FFF);
    if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F) || invisible || ch === '<' || ch === '>' || (/\s/.test(ch) && ch !== ' ')) return false;
  }
  return true;
}
let hostLabels = null; // read once per page: campaign id -> label
async function loadHostLabels() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000); // never holds anything up: the page does not wait for it
  try {
    const r = await fetch('campaigns.json', { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) return new Map();
    const j = await r.json();
    const m = new Map();
    for (const c of j && Array.isArray(j.campaigns) ? j.campaigns : []) {
      const label = c && c.host && c.host.label;
      if (typeof c.id === 'string' && /^[0-9a-f]{64}$/.test(c.id) && labelOk(label)) m.set(c.id, label);
    }
    return m;
  } catch { return new Map(); } finally { clearTimeout(t); }
}
/** The approved host's label for a campaign, or null. */
export function hostLabel(id) {
  if (!hostLabels) hostLabels = loadHostLabels();
  return hostLabels.then((m) => m.get(id) || null);
}
/** Fills a "Hosted by" line (plain text only) once the label is known; it stays hidden when there is none. */
export function fillHostedBy(line, id) {
  line.hidden = true;
  hostLabel(id).then((label) => {
    if (!label || !line.isConnected) return;
    line.textContent = `Hosted by ${label}`;
    line.title = 'Name given by Clewbook to an approved host.';
    line.hidden = false;
  });
}

export function linkParams() {
  const p = new URLSearchParams(location.hash.slice(1));
  const clean = (u) => u.replace(/\/$/, '');
  return {
    id: (p.get('c') || '').toLowerCase(),
    relays: p.getAll('relay').map(clean),
    endpoints: p.getAll('endpoint').map(clean),
    server: clean(p.get('server') || ''),
  };
}

export const DEFAULT_ENDPOINTS = {
  test: ['https://zjs.zec.rocks/testnet', 'https://zcash-testnet.chainsafe.dev'],
  // Servers run by different people on different hosting come first; the last one is a spare.
  // The two that answer browsers directly are both served through Fly.io (see groupOf).
  main: ['https://zjs.zec.rocks/mainnet', `${location.origin}/grpc/zec.0xrpc.io`, `${location.origin}/grpc/z.ombie.cash`, 'https://zcash-mainnet.chainsafe.dev'],
};

export const coin = (zat) => (zat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';

/** Seconds per block, measured from the block times of the last 100 blocks at the first endpoint that answers. null if none does. */
export async function observedBlockSeconds(endpoints, tip) {
  if (tip == null) return null;
  for (const e of endpoints) {
    try {
      const timeOf = async (h) => { const [b] = await grpcWeb(e, 'GetBlockRange', W.block_range_request(h, h), { timeoutMs: 12000 }); return varintField(b, 5); };
      const h0 = Math.max(1, tip - 100), t0 = await timeOf(h0), t1 = await timeOf(tip);
      if (t0 != null && t1 != null && tip - h0 >= 20 && t1 > t0) return (t1 - t0) / (tip - h0);
    } catch { /* try the next endpoint */ }
  }
  return null;
}

/** "≈3 hours" from a number of blocks and a measured seconds-per-block; null when it was not measured (no guessed constant). */
export function eta(blocks, secondsPerBlock) {
  if (!secondsPerBlock) return null;
  const sec = blocks * secondsPerBlock;
  if (sec < 90) return '≈1 minute';
  if (sec < 5400) return `≈${Math.round(sec / 60)} minutes`;
  if (sec < 172800) return `≈${Math.round(sec / 3600)} hours`;
  return `≈${Math.round(sec / 86400)} days`;
}

async function getText(url) {
  // A request that never comes back (a dropped connection somewhere on the way) must not keep a page waiting: it is given 12 s, then asked once more for 20 s.
  let r;
  try { r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12000) }); }
  catch { r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) }); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** Reads rules, ledger and challenges from one relay and checks what it can: the rules must hash to the
 *  campaign id, and the ledger must be signed, chained and with no gaps. */
export async function readRelay(url, id) {
  try {
    const rules = await getText(`${url}/v1/campaigns/${id}`);
    W.campaign_summary(rules, id);
    const ledgerText = await getText(`${url}/v1/campaigns/${id}/ledger?from=0`);
    const problems = JSON.parse(W.check_ledger(rules, id, ledgerText));
    let challenges = [];
    try { challenges = JSON.parse(await getText(`${url}/v1/campaigns/${id}/challenges`)); } catch { /* optional */ }
    return { url, rules, entries: JSON.parse(ledgerText), challenges, problems, error: null };
  } catch (e) {
    return { url, rules: null, entries: [], challenges: [], problems: [], error: String(e.message || e) };
  }
}

/** A saved copy of the public list (the host's export or backup: rules + signed list), checked the way a relay's copy is: the rules must hash to the
 *  campaign id and the list must be signed, chained and with no gaps. Returns the same shape as `judge`, as a single source marked `fromFile`; throws a plain
 *  message when the file is not usable. */
export function fromSavedCopy(text, id) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('That file is not a saved copy of a campaign list (it could not be read as JSON).'); }
  if (!d || d.kind !== 'ledger-export' || !Array.isArray(d.ledger) || !d.rules) throw new Error('That file is not a saved copy of a campaign list (it is not an export made by the host program).');
  if (String(d.campaign || '').toLowerCase() !== id) throw new Error('That saved copy is for a different campaign. Nothing was checked.');
  const rules = typeof d.rules === 'string' ? d.rules : JSON.stringify(d.rules);
  try { W.campaign_summary(rules, id); } catch (e) { throw new Error(`The saved copy does not check out: its rules do not match the campaign (${e.message || e}). It was ignored.`); }
  const problems = JSON.parse(W.check_ledger(rules, id, JSON.stringify(d.ledger)));
  if (problems.length) throw new Error(`The saved copy does not check out: ${problems[0]} It was ignored, so no verdict is given from it.`);
  const challenges = Array.isArray(d.challenges) ? d.challenges : [];
  return { kind: 'single', fromFile: true, entries: d.ledger, challenges, notes: [], rules, final: d.final ? JSON.stringify(d.final) : '', ok: [{ url: 'saved copy', entries: d.ledger }] };
}

/** kind: agree | single | disagree | none. A disagreement is never blamed on the host. */
export function judge(reads) {
  const notes = [];
  for (const r of reads) {
    if (r.error) notes.push(`${hostOf(r.url)} could not be reached (${r.error}).`);
    else if (r.problems.length) notes.push(`${hostOf(r.url)} shows a list that does not add up (${r.problems[0]}), so it is ignored.`);
  }
  const ok = reads.filter((r) => !r.error && r.problems.length === 0);
  const rules = (ok[0] || reads.find((r) => r.rules) || {}).rules || null;
  if (!ok.length) return { kind: 'none', entries: [], challenges: [], notes, rules, ok };
  const best = ok.reduce((a, b) => (b.entries.length > a.entries.length ? b : a));
  const same = ok.every((r) => JSON.stringify(r.entries) === JSON.stringify(ok[0].entries));
  const seen = new Map();
  for (const r of ok) for (const c of r.challenges) seen.set(JSON.stringify(c), c);
  const challenges = [...seen.values()];
  if (ok.length > 1 && !same) {
    notes.push('The relays do not show the same list: ' + ok.map((r) => `${hostOf(r.url)} has ${r.entries.length} entries`).join(', ') + '. A relay can be behind, down or dishonest, so this says nothing about the host.');
    return { kind: 'disagree', entries: best.entries, challenges, notes, rules, ok };
  }
  return { kind: ok.length > 1 ? 'agree' : 'single', entries: best.entries, challenges, notes, rules, ok };
}

export async function readAllRelays(id, relays) {
  return judge(await Promise.all(relays.map((u) => readRelay(u, id))));
}

function varintField(bytes, field) {
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++], f = tag >> 3, t = tag & 7;
    if (t === 0) { let v = 0, s = 0, b; do { b = bytes[i++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); if (f === field) return v; }
    else if (t === 2) { let len = 0, s = 0, b; do { b = bytes[i++]; len += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); i += len; }
    else if (t === 1) i += 8; else if (t === 5) i += 4; else break;
  }
  return null;
}

/** Chain height from one endpoint, or null if it does not answer in time. */
export async function tipOf(endpoint, timeoutMs = 12000) {
  try { const [m] = await grpcWeb(endpoint, 'GetLatestBlock', new Uint8Array(), { timeoutMs }); return varintField(m, 1); } catch { return null; }
}

const pageDir = () => new URL('.', location.href.split('#')[0]).href; // the folder this page is in (the link's #part may contain slashes)

// Opened from the demo's "Tested milestones" page: its links carry #from=proofs with the selection (mt the type, mr the result); a link one
// step further carries #via=proofs. Used only inside the demo (its header marks it as the current place) and on the test site where its
// sealed bid auctions live; anywhere else the marker is ignored and every back link stays as it was.
const MILESTONES_FROM_TEST_SITE = 'https://clewbook.xyz/demo/proofs';
export function milestones() {
  const p = new URLSearchParams(location.hash.slice(1));
  const how = p.get('from') === 'proofs' ? 'from' : p.get('via') === 'proofs' ? 'via' : '';
  if (!how) return null;
  const home = document.querySelector('.demo-link.cur') ? new URL('proofs/', pageDir()).href : location.hostname === 'app-test.clewbook.xyz' ? MILESTONES_FROM_TEST_SITE : '';
  if (!home) return null;
  const mt = /^(all|raise|auction|sealed)$/.test(p.get('mt') || '') ? p.get('mt') : 'all';
  const mr = /^(all|pass|fail)$/.test(p.get('mr') || '') ? p.get('mr') : 'all';
  const id = (p.get('c') || '').toLowerCase();
  const sel = `mt=${mt}&mr=${mr}`;
  return {
    direct: how === 'from', // opened from the milestones page itself
    href: `${home}#${sel}${/^[0-9a-f]{64}$/.test(id) ? `&at=${id}` : ''}`,
    onward: (href) => `${href}&via=proofs&${sel}`, // a link to the next page keeps the way back
  };
}
/** A top left back link that returns to the Tested milestones page with the same selection. */
export function backToMilestones(a, ms) { a.href = ms.href; a.textContent = '← Tested milestones'; }

/** Contribute / recount / campaign links that keep the same relays and endpoints. */
export function sibling(page, { id, relays, endpoints, server }) {
  const base = pageDir();
  const q = [`c=${id}`, ...relays.map((r) => `relay=${r}`), ...endpoints.map((e) => `endpoint=${e}`), ...(server ? [`server=${server}`] : [])];
  return `${base}${page}.html#${q.join('&')}`;
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The badge a host pastes into their own page: a small iframe of badge.html (this site draws it, so it carries our fonts and look). It claims
 *  nothing: it names the campaign and links to the live recount. Inside the iframe a plain link is the fallback. */
export function badgeSrc(recountLink) { return recountLink.replace('recount.html#', 'badge.html#'); }
export function badgeSnippet(links) {
  return `<iframe src="${escAttr(badgeSrc(links.recount))}" title="Recount badge for this campaign" width="300" height="160" loading="lazy" style="border:0;max-width:100%">\n  <a href="${escAttr(links.recount)}">Recount this campaign yourself</a>\n</iframe>`;
}

/** Which hosting a server appears to run on, from what we could observe (response headers and addresses).
 *  Two servers in the same group are not independent evidence. Unknown servers count as their own group. */
/** The server's own name: for a call forwarded by this computer's page server (/grpc/<host>) it is that host. */
export function serverName(url) {
  try { const u = new URL(url); const m = u.pathname.match(/^\/grpc\/([^/]+)/); return m ? m[1] : u.host; } catch { return url; }
}

export function groupOf(url) {
  const h = serverName(url);
  if (/(^|\.)zec\.rocks$/.test(h) || /(^|\.)chainsafe\.dev$/.test(h)) return 'Fly.io, the zec.rocks network';
  return h;
}

// ---------- the campaign view (design round 12, handoff "contribute" 3.7): the campaign page in every state and the contribute page's closed page
// draw this same view, so they are identical. Reading only. Facts, rows and words follow the campaign page as it was (only the look changed).
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const DASH = '–'; // an empty cell (the wording rules allow no em dash)
const shortEta = (s) => (s ? s.replace(/^≈/, '~').replace(/ minutes$/, ' min').replace(/ hours$/, ' h') : s);

/** The line beside the status pill: type, terms and (where asked) the short id. */
export function metaLine(c, { id = '', withId = false, closed = false } = {}) {
  const SEALED_PAYS = { uniform: 'one price for every winner', second: 'highest losing bid', pay_your_bid: 'pay your bid' };
  if (c.sealed) return ['Blind bid auction', ...(closed ? [] : [`${c.items} ${c.items === 1 ? 'item' : 'items'}`]), SEALED_PAYS[c.sealed.pricing], ...(withId && id ? [`${id.slice(0, 8)}…`] : [])].join(' · ');
  const auction = c.mode === 'auction', pays = c.pricing === 'uniform' ? 'one price for every winner' : 'pay your bid';
  const parts = auction ? ['Auction', ...(closed ? [] : [`${c.items} ${c.items === 1 ? 'item' : 'items'}`]), pays]
    : ['Fundraiser', ...(c.cap ? [`soft cap ${c.goal} ${c.ticker}`, `hard cap ${c.cap} ${c.ticker}`] : [`goal ${c.goal} ${c.ticker}`])];
  if (withId && id) parts.push(`${id.slice(0, 8)}…`);
  return parts.join(' · ');
}

/** "Who can see what": the campaign page's three zones, word for word. */
export function whoSeesWhat() {
  const z = el('div', 'cv-zones');
  for (const [b, p] of [['Public, on the signed list', 'Transaction id, block height and ticket data; the amount in a fundraiser, and every bid once an auction closes. No names, no refund addresses.'],
    ['Sealed to the campaign', 'Your refund address, inside the payment message. The host can open every message, so it can see which payments share a refund address.'],
    ['Only on your device', 'Your one time secret and the backup file you download. Relays keep only a sealed copy of your refund ticket.']]) { const q = el('p'); q.append(el('b', '', b), ` ${p}`); z.append(q); }
  return z;
}

/** The Rules card: RULES, label and value rows (a row with an explanation shows its value and a ▾ that opens it), the two folds, then `tail`.
 *  rows: { k, v, html, sub, dim, link: { href, text, id } }. */
export function rulesCard({ id = 'facts', rows, note = '', tail = [], notChecked = [], folds = true }) {
  const card = el('aside', 'cv-rules rules');
  card.append(el('span', 'cv-rk', 'RULES'));
  const dl = el('dl', 'cv-dl'); dl.id = id;
  rows.forEach((r, i) => {
    const row = el('div', `cv-row${r.sub ? ' sub' : ''}`);
    const dt = el('dt', '', r.k), dd = el('dd');
    if (r.link) { const a = el('a', '', r.link.text); a.href = r.link.href; if (r.link.id) a.id = r.link.id; dd.append(a); }
    else if (r.html) dd.innerHTML = r.v; else dd.textContent = r.v;
    if (r.dim) dd.append(' ', el('span', 'dim', r.dim));
    row.append(dt, dd);
    if (r.sub) {
      const b = el('button', 'cv-more'); b.type = 'button'; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', `${r.k}: what it means`);
      const sid = `${id}-sub-${i}`; b.setAttribute('aria-controls', sid);
      b.append(el('span', 'cv-chev', '▾'));
      dd.append(b);
      const s = el('dd', 'cv-sub', r.sub); s.id = sid; s.hidden = true;
      row.append(s);
      const toggle = () => { const o = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', String(o)); s.hidden = !o; row.classList.toggle('open', o); };
      b.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
      row.addEventListener('click', (e) => { if (!e.target.closest('a, button')) toggle(); });
    }
    dl.append(row);
  });
  card.append(dl);
  const fold = (title, body, fid) => { const d = el('details', 'cv-fold fold'); if (fid) d.id = fid; d.append(el('summary', '', `▸ ${title}`), body); card.append(d); };
  if (folds) fold('Who can see what', whoSeesWhat(), id === 'facts' ? 'take' : `${id}-take`);
  // round 13: no "Not checked by a recount" on the campaign pages (the recount page lists what it does not check); the contribute questions show it in their own row
  if (folds && notChecked.length) {
    const nc = el('ul', 'cv-nc nclist'); if (id === 'facts') nc.id = 'nc-list'; for (const [what, why] of notChecked) nc.append(el('li', '', `${what}: ${why}`));
    fold('Not checked by a recount', nc, id === 'facts' ? 'nc-fold' : `${id}-nc`);
  }
  if (note) { const n = el('p', 'cv-note rule-note', note); if (id === 'facts') n.id = 'rule-note'; card.append(n); }
  if (tail.length) { const t = el('div', 'cv-tail'); t.append(...tail); card.append(t); }
  return card;
}

/** The rules rows of a campaign, as the campaign page has always listed them. */
export function campaignRuleRows(c, { status, left, secPerBlock }) {
  if (c.sealed) {
    const s = c.sealed, amt = (x) => `${x} ${c.ticker}`;
    const pays = { uniform: 'one price: the lowest winning bid', second: 'one price: the highest losing bid', pay_your_bid: 'each pays their own bid' };
    const rows = [{ k: 'Type', v: 'Blind bid auction' }, { k: 'How winners pay', v: pays[s.pricing] }];
    if (c.reserve) rows.push({ k: 'Reserve', v: amt(c.reserve) });
    rows.push({ k: 'Deposit sizes', v: s.tranches.map(amt).join(', '), sub: 'A bid is at most its deposit minus the refund fee; the deposit shows the size of a bid, never the bid.' });
    rows.push({ k: 'Ties', v: 'earlier in the chain wins' }, { k: 'Refund fee', v: amt(c.fee) });
    rows.push({ k: 'Bids open with', v: `drand round ${s.round}`, sub: 'after bidding closes; nobody, the host included, can read a bid before' });
    if (s.timing === 'quick') rows.push({ k: 'Timing', v: 'Quick test (test network only)', sub: 'allows for blocks every 20 to 40 seconds; the bids open 10 minutes after the deadline' });
    rows.push({ k: 'Status', v: status });
    rows.push({ k: 'Take your deposit back', v: `until block ${c.deadline_height}`, sub: 'with your early ticket, any time before the deadline' });
    rows.push({ k: 'Late tickets', v: `from block ${s.claim_after + 1}`, sub: 'if the host has not finished the auction by then, everyone can take their deposit back on their own' });
    return rows;
  }
  const auction = c.mode === 'auction', uniform = c.pricing === 'uniform', amt = (x) => (x == null ? '' : `${x} ${c.ticker}`);
  const rows = [{ k: 'Type', v: auction ? 'Auction' : 'Fundraiser' }];
  if (auction) {
    rows.push({ k: 'How winners pay', v: uniform ? 'one price: the lowest winning bid' : 'each pays their own bid' });
    if (uniform) rows.push({ k: 'Reserve', v: amt(c.reserve) });
    rows.push({ k: 'Ties', v: 'earlier in the chain wins' }, { k: 'Each bid', v: 'for one item' }, { k: 'Smallest bid', v: amt(c.min) });
  } else {
    if (c.cap) rows.push({ k: 'Soft cap', v: amt(c.goal) }, { k: 'Hard cap', v: amt(c.cap) });
    rows.push({ k: c.cap ? 'Soft cap missed' : 'Goal missed', v: 'all refunded' }, { k: 'Smallest', v: amt(c.min) });
  }
  rows.push({ k: 'Refund fee', v: amt(c.fee) });
  if (auction) rows.push({ k: 'Bid amounts', v: 'public at the close' });
  rows.push({ k: 'Status', v: status });
  if (left != null && left > 0 && secPerBlock) rows.push({ k: 'Block time', v: `≈${Math.round(secPerBlock)} seconds` });
  rows.push({ k: 'Ticket window', v: `${c.ticket_k} blocks${eta(c.ticket_k, secPerBlock) ? ` (${eta(c.ticket_k, secPerBlock)})` : ''}`, sub: 'Your refund ticket arrives within this window; if the host has not closed by then, you can claim your own refund.' });
  if (uniform) rows.push({ k: 'Settlement window', v: `${c.settle_window} blocks`, sub: `the host must settle every winner by block ${c.settle_by}; after that winners can claim their own refund` });
  if (c.early_close) rows.push({ k: 'Early close', v: 'allowed' });
  rows.push({ k: 'Refund promise', v: 'a signed ticket' });
  return rows;
}

/** The public list, as published, newest first: one row per entry (kind with its short id beneath, result, amount on fundraisers, what happened,
 *  block, price paid); the close as one summary band. Amounts only where the list gives them. */
function rowOf(c, entries, e, h) {
  const { auction, uniform, outcome, winners, overCap, zat, sealed } = h;
  const settleOf = (nf) => entries.find((x) => x.kind === 'settle' && x.settle && x.settle.nf === nf);
  const sentBack = (s) => (s.excess_zat > 0 ? `${zat(s.excess_zat)} sent back` : 'Nothing sent back');
  const x = e.contribution;
  const ref = (x && x.txid) || (e.settle && e.settle.txid) || (e.ticket && e.ticket.txid) || null;
  const r = { kind: '', ref, result: DASH, amount: x && x.value_zat != null ? zat(x.value_zat) : null, what: DASH, block: x ? x.height : null, price: null };
  if (sealed && e.kind === 'coin') { r.kind = 'Small payment'; r.result = 'Sent'; r.what = 'For the late ticket'; r.ref = e.coin ? e.coin.txid : null; return r; }
  if (sealed && e.kind === 'reveal') { r.kind = 'Viewing key'; r.result = 'Published'; r.what = 'After every settlement'; return r; }
  if (sealed && e.kind === 'close') {
    const at = e.close ? ` at block ${e.close.close_height.toLocaleString('en-US')}` : '';
    r.summary = e.close && e.close.outcome === 'void' ? `Void${at}: round R came too early, every deposit goes back`
      : `Bids opened${at}${e.close && e.close.clearing_price_zat != null ? `; every winner pays ${zat(e.close.clearing_price_zat)}` : ''}`;
    return r;
  }
  if (e.kind === 'issue' && auction) {
    r.kind = sealed ? 'Deposit' : 'Bid';
    if (winners && x && x.nf) {
      const won = winners.includes(x.nf), st = won ? settleOf(x.nf) : null;
      r.result = won ? 'Won' : 'Lost';
      if (!won) r.what = sealed ? 'Refunded' : 'Refunded by ticket';
      else if (st) { r.what = sentBack(st.settle); r.price = zat(st.settle.price_zat); }
      else r.what = uniform ? 'Not settled yet' : 'Kept as payment';
    } else { r.result = 'Received'; r.what = r.amount == null ? 'Amount hidden until the close' : 'Ticket issued'; }
  } else if (e.kind === 'issue' || e.kind === 'withdraw') {
    r.kind = 'Contribution';
    if (e.kind === 'withdraw') { r.result = 'Withdrawn'; r.what = 'Taken back'; }
    else if (outcome === 'goal_missed') { r.result = 'Refunded'; r.what = 'Refunded by ticket'; }
    else if (outcome === 'goal_met' && x && overCap.has(x.nf)) { r.result = 'Over the cap'; r.what = 'Refunded by ticket'; }
    else if (outcome === 'goal_met') { r.result = 'Counted'; r.what = 'Kept by the campaign'; }
    else { r.result = 'Received'; r.what = 'Ticket issued'; }
  } else if (e.kind === 'reissue') { r.kind = 'Reissue'; r.result = 'Reissued'; r.what = 'New refund ticket'; }
  else if (e.kind === 'reject') { r.kind = 'Set aside'; r.result = 'Not counted'; }
  else if (e.kind === 'close') {
    const at = e.close ? ` at block ${e.close.close_height.toLocaleString('en-US')}` : '';
    if (auction) r.summary = `Auction settled${at}${e.close && e.close.clearing_price_zat != null ? ` for ${zat(e.close.clearing_price_zat)}` : ''}`;
    else r.summary = `Closed${at}: ${e.close ? outcomeWords(e.close.outcome, !!c.cap) : 'finished'}`;
  } else if (e.kind === 'settle' && e.settle) { r.kind = 'Settlement'; r.result = 'Settled'; r.what = sentBack(e.settle); r.price = zat(e.settle.price_zat); }
  else r.kind = e.kind;
  return r;
}

/** Draws the view into `box`. v: { c, id, entries, ok (relays that answered, with their entries), relays, single (only one relay gave a list),
 *  tip, secPerBlock, links: { recount, card, contribute } }. Returns { tableRows } for the page's own use. */
export function campaignView(box, v) {
  const { c, entries } = v;
  const sealed = !!c.sealed, auction = c.mode === 'auction' || sealed, uniform = c.pricing === 'uniform';
  const closeE = entries.find((e) => e.kind === 'close');
  const closed = !!closeE, outcome = closeE && closeE.close ? closeE.close.outcome : null;
  const left = v.tip == null ? null : c.deadline_height - v.tip;
  const zat = (z) => amountHTML(z, c.ticker);
  const tleft = left != null && left > 0 ? shortEta(eta(left, v.secPerBlock)) : null;
  box.replaceChildren();
  const grid = el('div', 'cv'), main = el('div', 'cmain cv-main');
  const h1 = el('h1', 'cv-h cname', c.name || `${sealed ? 'Blind bid auction' : auction ? 'Auction' : 'Fundraiser'} ${v.id.slice(0, 8)}…`); h1.id = 'display-name';
  const hosted = el('p', 'hostedby', ''); hosted.id = 'hosted-by';
  main.append(h1, hosted);
  fillHostedBy(hosted, v.id);

  // the facts: closed, outcome, terms and network; otherwise the campaign page's open cards
  const facts = [];
  if (sealed && v.didNotFinish) facts.push(['OUTCOME', 'Host did not finish', `everyone can take their deposit back with their late ticket from block ${c.sealed.claim_after + 1}`]);
  if (sealed && !closed) {
    facts.push(['ITEMS', String(c.items), 'one per winning bid']);
    facts.push(['DEPOSITS', c.sealed.tranches.join(', '), c.ticker]);
    facts.push(['DEADLINE', tleft || (left != null && left <= 0 ? 'passed' : DASH), `block ${c.deadline_height.toLocaleString('en-US')}`]);
  } else if (closed) {
    facts.push(['OUTCOME', outcomeWords(outcome, !!c.cap).replace('auction settled', 'settled'), closeE.close ? `block ${closeE.close.close_height.toLocaleString('en-US')}` : '']);
    if (sealed) facts.push(['TERMS', `${c.items} ${c.items === 1 ? 'item' : 'items'}`, metaLine(c).split(' · ').pop()]);
    else if (auction) facts.push(['TERMS', `${c.items} ${c.items === 1 ? 'item' : 'items'}`, uniform ? 'one price for every winner' : 'pay your bid']);
    else if (c.cap) facts.push(['TERMS', `Soft cap ${c.goal}`, `hard cap ${c.cap} ${c.ticker}`]);
    else facts.push(['TERMS', `Goal ${c.goal} ${c.ticker}`, '']);
    facts.push(['NETWORK', c.network === 'main' ? 'Mainnet' : 'Testnet', '']);
  } else {
    const raisedZat = entries.filter((e) => e.kind === 'issue').reduce((t, e) => t + (e.contribution && e.contribution.value_zat != null ? e.contribution.value_zat : 0), 0);
    if (auction) { facts.push(['ITEMS', String(c.items), 'one per winning bid']); facts.push(uniform ? ['RESERVE', zat(c.reserve_zat), 'lowest price an item sells for', true] : ['SMALLEST BID', zat(c.min_zat), '', true]); }
    else if (c.cap) { facts.push(['SOFT CAP', zat(c.goal_zat), 'the least it must keep', true]); facts.push(['HARD CAP', zat(c.cap_zat), 'the most it keeps', true]); }
    else { facts.push(['GOAL', zat(c.goal_zat), '', true]); facts.push(['RAISED', zat(raisedZat), '', true]); }
    facts.push(['DEADLINE', tleft || (left != null && left <= 0 ? 'passed' : DASH), `block ${c.deadline_height.toLocaleString('en-US')}`]);
  }
  const fbox = el('div', 'cv-facts tiles'); fbox.id = 'tiles';
  for (const [k, val, sub, html] of facts) {
    const f = el('div', 'cv-fact tile'); f.append(el('span', 'cv-fk tk', k));
    const right = el('span', 'cv-fr'); const b = el('b', 'cv-fv tv'); if (html) b.innerHTML = val; else b.textContent = val;
    right.append(b); if (sub) right.append(el('span', 'cv-fs tu', sub)); f.append(right); fbox.append(f);
  }
  main.append(fbox);

  // the actions: Contribute or Bid and ↻ Recount while it takes payments; ↻ Recount alone after that, with the closed line on the same line
  const act = el('div', 'cv-act actions'); act.id = 'links';
  const takes = !closed && left != null && left > 0 && v.links.contribute;
  if (takes) { const a = el('a', 'cprimary', auction ? 'Bid' : 'Contribute'); a.href = v.links.contribute; a.id = 'contribute-link'; act.append(a); }
  const rc = el('a', takes ? 'coutline recount-btn' : 'cprimary recount-btn', '↻ Recount'); rc.href = v.links.recount; rc.id = 'recount-link'; act.append(rc);
  const noteText = closed ? `■ Closed: ${outcomeWords(outcome, !!c.cap)}. No new ${auction ? 'bids' : 'payments'}.`
    : left != null && left <= 0 ? 'This campaign is no longer taking contributions.'
      : sealed ? `Bids stay locked until drand round ${c.sealed.round}, after bidding closes: nobody, the host included, can read one before.`
        : auction ? 'Bid amounts stay off the public record until the auction closes; the host sees each bid as it arrives.' : '';
  if (noteText) { const n = el('span', `cv-note2 ${closed ? 'closed-note' : left != null && left <= 0 ? 'closed-note' : 'bid-note'}`, noteText); n.id = closed || (left != null && left <= 0) ? 'closed-note' : 'bid-note'; act.append(n); }
  main.append(act);

  // the public list
  const list = el('section', 'cv-list plist'); list.id = 'public-list';
  const hd = el('div', 'cv-lhd plhd');
  const tg = el('button', 'cv-lt pl-toggle'); tg.type = 'button'; tg.id = 'pl-toggle'; tg.setAttribute('aria-expanded', 'false'); tg.setAttribute('aria-controls', 'list-facts');
  tg.append('Public list ', el('sup', '', '1'));
  const hint = el('span', 'cv-hint t-label', 'AS PUBLISHED'); hint.id = 'entries-hint';
  hd.append(tg, hint); list.append(hd);
  // the counts behind "Public list" (closed at first), as before
  const count = (k) => entries.filter((e) => e.kind === k).length;
  const lf = el('dl', 'cv-lfacts lfacts'); lf.id = 'list-facts'; lf.hidden = true;
  for (const [label, note, value] of [['Entries listed', "everything on the host's public list", String(entries.length)], ['Refund tickets issued', auction ? 'one per bid' : 'one per contribution', String(count('issue'))],
    ['Tickets reissued', 'only after a network upgrade', String(count('reissue'))], ['Payments set aside', 'not counted', String(count('reject'))]]) {
    const d = el('div', 'stat'); const dt = el('dt', '', label); dt.append(el('small', '', note)); d.append(dt, el('dd', '', value)); lf.append(d);
  }
  tg.addEventListener('click', () => { const o = tg.getAttribute('aria-expanded') !== 'true'; tg.setAttribute('aria-expanded', String(o)); lf.hidden = !o; });
  list.append(lf);
  const winners = closeE && closeE.close && Array.isArray(closeE.close.winners) ? closeE.close.winners : null;
  const overCap = new Set();
  if (!auction && outcome === 'goal_met' && c.cap_zat != null) {
    let room = c.cap_zat; const seen = new Set();
    for (const e of entries) { const x = e.contribution; if (!e.ticket || !x || x.value_zat == null || seen.has(x.nf)) continue; seen.add(x.nf); if (x.value_zat <= room) room -= x.value_zat; else overCap.add(x.nf); }
  }
  const h = { auction, uniform, outcome, winners, overCap, zat, sealed };
  const all = entries.slice().reverse();
  const card = el('div', 'cv-scroll'); card.id = 'entries-card';
  const table = el('table', `ledger entries ${auction ? 'auc' : 'fund'}`); table.setAttribute('role', 'table'); table.setAttribute('aria-label', 'Public list, newest first');
  const thead = el('thead', 'lhead'); thead.setAttribute('role', 'rowgroup'); const htr = el('tr'); htr.setAttribute('role', 'row');
  for (const [t, label, cls] of [['Entry', 'Entry and short id', ''], ['Result', '', ''], ...(auction ? [] : [['Amount', '', 'r']]), ['Action', 'Action: what happened to the money', ''], ['Block', '', ''], ['Price paid', '', 'r']]) {
    const th = el('th', cls, t); th.scope = 'col'; th.setAttribute('role', 'columnheader'); if (label) th.setAttribute('aria-label', label); htr.append(th);
  }
  thead.append(htr); table.append(thead);
  const body = el('tbody'); body.id = 'entries'; body.setAttribute('role', 'rowgroup');
  for (const e of all) {
    const r = rowOf(c, entries, e, h);
    const tr = el('tr'); tr.setAttribute('role', 'row'); tr.dataset.seq = String(e.seq);
    const td = (cls) => { const d = el('td', cls); d.setAttribute('role', 'cell'); tr.append(d); return d; };
    if (r.summary) { tr.className = 'sum'; const d = td('sum'); d.colSpan = auction ? 5 : 6; d.innerHTML = r.summary; body.append(tr); continue; }
    const k = td('k'); k.append(el('span', 'ek', r.kind));
    if (r.ref) { const s = el('span', 'ref', `${r.ref.slice(0, 8)}…${r.ref.slice(-5)}`); s.title = r.ref; k.append(s); }
    const res = td(`res${r.result === 'Won' ? ' won' : r.result === 'Lost' ? ' lost' : ''}`); res.textContent = r.result;
    if (!auction) { const a = td('am r'); if (r.amount != null) a.innerHTML = r.amount; else { a.textContent = DASH; a.classList.add('none'); } }
    td('what').innerHTML = r.what;
    const bl = td('blk'); bl.textContent = r.block != null ? r.block.toLocaleString('en-US') : DASH; if (r.block != null) bl.dataset.block = String(r.block);
    const pr = td('pr r'); if (r.price != null) pr.innerHTML = r.price; else { pr.textContent = DASH; pr.classList.add('none'); }
    body.append(tr);
  }
  table.append(body); card.append(table); list.append(card);
  const more = el('button', 'coutline cv-more-list pl-more'); more.type = 'button'; more.id = 'entries-more'; more.setAttribute('aria-controls', 'entries'); more.setAttribute('aria-expanded', 'false'); more.hidden = true;
  list.append(more);
  const empty = el('p', 'cv-empty pl-empty', 'No entries yet.'); empty.id = 'entries-empty'; empty.hidden = all.length > 0; list.append(empty);
  card.hidden = all.length === 0;
  const SHOWN = 5, rows = [...body.children];
  if (rows.length > SHOWN) {
    const fold = (open) => { rows.forEach((tr, i) => { tr.hidden = !open && i >= SHOWN; }); more.textContent = open ? 'Show fewer' : `Show older (${rows.length - SHOWN})`; more.setAttribute('aria-expanded', String(open)); hint.textContent = open ? 'AS PUBLISHED' : `AS PUBLISHED · ${SHOWN} OF ${rows.length}`; };
    more.hidden = false; fold(false); more.addEventListener('click', () => fold(more.getAttribute('aria-expanded') !== 'true'));
  }
  main.append(list);

  // the footnote: which relays answered and how many entries each gave; a list from one relay says so here
  const n = (k) => `${k} ${k === 1 ? 'entry' : 'entries'}`;
  const foot = el('p', 'cv-foot pl-foot'); foot.id = 'pl-foot';
  const live = el('span', '', `${(v.ok || []).length} ${(v.ok || []).length === 1 ? 'relay' : 'relays'} live.`); live.id = 'relay-live';
  foot.append(el('sup', '', '1'), ' ', live);
  if (v.single) foot.append(` ${v.relays.length > 1 ? 'Only one relay gave a usable list.' : 'Only one relay was asked, so nothing here has been cross checked.'}`);
  foot.append(' Recount is the independent check. Read from ');
  const ol = el('ol', 'cv-relays relays'); ol.id = 'relay-list';
  v.relays.forEach((url, i) => { const info = (v.ok || []).find((r) => r.url === url); const li = el('li', info ? '' : 'bad', `${hostOf(url)}: ${info ? n(info.entries.length) : 'no usable answer'}${i === v.relays.length - 1 ? '.' : ';'}`); ol.append(li); });
  foot.append(ol);
  // round 13: the footnote is its own part of the view, pinned to the bottom of the content (under the list's column on a wide screen, last on a phone)

  // RULES
  const status = closed ? 'Closed' : left == null ? 'Open (the chain height could not be read)' : left > 0 ? 'Open' : 'Deadline passed, not yet closed';
  const card2 = el('a', 'cv-card card-link', 'Capability card →'); card2.href = v.links.card; card2.id = 'card-link';
  const bk = el('p', 'bk-link'); const bka = el('a', 'cv-bk', 'Have a ticket backup file? Open it here'); bka.href = 'recount.html#ticket-box'; bk.append(bka);
  const aside = rulesCard({ rows: campaignRuleRows(c, { status, left, secPerBlock: v.secPerBlock }), notChecked: v.notChecked || [],
    note: uniform ? 'A bid must be at least the reserve plus the refund fee to win; if fewer bids reach it than there are items, every winner pays the reserve.' : '', tail: [card2, bk] });
  grid.append(main, aside, foot);
  box.append(grid);
  decorateAmounts(box);
}
