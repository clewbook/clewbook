// Shared by the campaign page and the recount page: reading a campaign's public list from its relays,
// and small formatting helpers. Link format: <page>.html#c=<campaign id>&relay=<url>&relay=<url>&endpoint=<url>&endpoint=<url>
import * as W from './pkg/ll_web.js';
import { grpcWeb } from './recount.js';
import { amountHTML, outcomeWords, decorateAmounts, OUTCOME_WORDS } from './ui.js';
import { firstMeasured } from './nu7.js';

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

/** The project's relay: the one a link means when it names none (short links name none). */
export const DEFAULT_RELAY = 'https://relay.clewbook.xyz';

export function linkParams() {
  const p = new URLSearchParams(location.hash.slice(1));
  const clean = (u) => u.replace(/\/$/, '');
  const relays = p.getAll('relay').map(clean), id = (p.get('c') || '').toLowerCase();
  return {
    id,
    // a link that names a campaign but no relay means the project's relay; one with no campaign at all stays empty (the recount page's own mode)
    relays: relays.length || !id ? relays : [DEFAULT_RELAY],
    endpoints: p.getAll('endpoint').map(clean),
    server: clean(p.get('server') || ''),
    // upto=<block>: the recount reads the chain only up to this block (a finished example checked at a fixed block, so it is quick)
    upto: /^[1-9][0-9]{0,9}$/.test(p.get('upto') || '') ? Number(p.get('upto')) : null,
  };
}

export const DEFAULT_ENDPOINTS = {
  test: ['https://zjs.zec.rocks/testnet', 'https://zcash-testnet.chainsafe.dev'],
  // Servers run by different people on different hosting come first; the last one is a spare.
  // The two that answer browsers directly are both served through Fly.io (see groupOf).
  main: ['https://zjs.zec.rocks/mainnet', `${location.origin}/grpc/zec.0xrpc.io`, `${location.origin}/grpc/z.ombie.cash`, 'https://zcash-mainnet.chainsafe.dev'],
};

export const coin = (zat) => (zat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';

/** Seconds per block, measured from the block times of the last 100 blocks at the first endpoint that answers (on `network`, only blocks
 *  after the next Zcash network upgrade once it has come: fewer than 20 of them give no estimate). null if none does. */
export async function observedBlockSeconds(endpoints, tip, network) {
  if (tip == null) return null;
  for (const e of endpoints) {
    try {
      const timeOf = async (h) => { const [b] = await grpcWeb(e, 'GetBlockRange', W.block_range_request(h, h), { timeoutMs: 12000 }); return varintField(b, 5); };
      const h0 = firstMeasured(network, tip, 100);
      if (tip - h0 < 20) return null;
      const t0 = await timeOf(h0), t1 = await timeOf(tip);
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
/** A campaign's short link, <this site>/c/<first 8 characters of its id>, when the listing (campaigns.json) names it and no other listed
 *  campaign begins with the same 8 characters; else null (the full link is the one to share then: an unlisted campaign has no short link). */
export async function shortLink(id) {
  try {
    const list = (await (await fetch(new URL('campaigns.json', pageDir()).href, { cache: 'no-store' })).json()).campaigns || [];
    const same = list.filter((c) => typeof c.id === 'string' && c.id.startsWith(id.slice(0, 8)));
    if (same.length === 1 && same[0].id === id) return new URL(`c/${id.slice(0, 8)}`, pageDir()).href;
  } catch { /* no listing: the full link */ }
  return null;
}

/** The Copy link button of the campaign and bid pages: copies the short link, or the full link when there is none, and says which. */
export function copyLinkButton(btn, id) {
  btn.addEventListener('click', async () => {
    const link = (await shortLink(id)) || location.href;
    try { await navigator.clipboard.writeText(link); btn.textContent = 'Link copied'; } catch { btn.textContent = 'Not copied'; }
    btn.title = link;
    setTimeout(() => { btn.textContent = 'Copy link'; }, 2500);
  });
}

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
  if (c.cancellable) rows.push({ k: 'Cancel', v: 'the host can refund everyone, minus the fee' });
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
  // a cancelled fundraiser: a payment that came after the cancel, sent back by the host, minus the fee (no amount on the list)
  if (!sealed && e.kind === 'late_return') { r.kind = 'Payment after the cancel'; r.result = 'Sent back'; r.what = 'Minus the network fee'; r.ref = e.refund || ref; return r; }
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
      r.result = won ? 'Won' : 'Not won';
      if (!won) r.what = 'Refunded';
      else if (st) { r.what = 'Paid'; r.price = zat(st.settle.price_zat); }
      else r.what = uniform ? 'Not settled yet' : 'Kept as payment';
    } else { r.result = 'Received'; r.what = r.amount == null ? 'Amount hidden until the close' : 'Ticket issued'; }
  } else if (e.kind === 'issue' || e.kind === 'withdraw') {
    r.kind = 'Contribution';
    if (e.kind === 'withdraw') { r.result = 'Taken back'; r.what = 'Refund by ticket'; }
    else if (outcome === 'goal_missed' || outcome === 'cancelled') { r.result = 'Refunded'; r.what = 'Refunded by ticket'; }
    else if (outcome === 'goal_met' && x && overCap.has(x.nf)) { r.result = 'Over the cap'; r.what = 'Refunded by ticket'; }
    else if (outcome === 'goal_met') { r.result = 'Counted'; r.what = 'Kept by the campaign'; }
    else { r.result = 'Ticket issued'; r.what = DASH; }
  } else if (e.kind === 'reissue') { r.kind = 'Reissue'; r.result = 'Reissued'; r.what = 'New refund ticket'; }
  else if (e.kind === 'reject') { r.kind = 'Set aside'; r.result = 'Not counted'; }
  else if (e.kind === 'close') {
    const at = e.close ? ` at block ${e.close.close_height.toLocaleString('en-US')}` : '';
    if (auction) r.summary = `Bids opened${at}${e.close && e.close.clearing_price_zat != null ? `; every winner pays ${zat(e.close.clearing_price_zat)}` : ''}.`;
    else r.summary = `Closed${at}: ${e.close ? outcomeWords(e.close.outcome, !!c.cap) : 'finished'}`;
  } else if (e.kind === 'settle' && e.settle) { r.kind = 'Settlement'; r.result = 'Sent'; r.what = sentBack(e.settle); r.price = zat(e.settle.price_zat); }
  else r.kind = e.kind;
  return r;
}

/** The Rules rows in the prototype's order and words, then the rule facts it has no row for (they change what a contributor may do). */
function designRuleRows(c, { status, closed, outcome }) {
  const amt = (x) => (x == null ? '' : `${x} ${c.ticker}`), net = c.network === 'main' ? 'Mainnet' : c.network === 'test' ? 'Testnet' : 'Unknown';
  const blk = (h) => `block ${h.toLocaleString('en-US')}`;
  if (c.sealed) {
    const s = c.sealed, pays = { uniform: 'one price for every winner', second: 'highest losing bid', pay_your_bid: 'pay your bid' };
    const rows = [{ k: 'Type', v: 'Blind bid auction' }, { k: 'How winners pay', v: pays[s.pricing] }, { k: 'Items', v: String(c.items) }];
    if (c.reserve) rows.push({ k: 'Reserve', v: amt(c.reserve) });
    rows.push({ k: 'Deposit sizes', v: s.tranches.map(amt).join(', '), sub: 'A bid is at most its deposit minus the refund fee; the deposit shows the size of a bid, never the bid.' },
      { k: 'Ties', v: 'chain order' }, { k: 'Refund fee', v: amt(c.fee) }, { k: 'Bids open with', v: `drand round ${s.round}` });
    if (s.timing === 'quick') rows.push({ k: 'Timing', v: 'Quick test (test network only)' });
    rows.push({ k: 'Take your deposit back', v: `until ${blk(c.deadline_height)}` }, { k: 'Late tickets', v: `from ${blk(s.claim_after + 1)}` }, { k: 'Status', v: closed ? 'settled' : status.toLowerCase() }, { k: 'Network', v: net });
    return rows;
  }
  if (c.mode === 'auction') {
    const uniform = c.pricing === 'uniform';
    const rows = [{ k: 'Type', v: 'Auction' }, { k: 'How winners pay', v: uniform ? 'one price for every winner' : 'pay your bid' }, { k: 'Items', v: String(c.items) }, { k: 'Ties', v: 'chain order' }];
    if (uniform) rows.push({ k: 'Reserve', v: amt(c.reserve) });
    rows.push({ k: 'Smallest bid', v: amt(c.min) }, { k: 'Refund fee', v: amt(c.fee) });
    if (uniform) rows.push({ k: 'Settlement window', v: `${c.settle_window} blocks`, sub: `the host must settle every winner by block ${c.settle_by}; after that winners can claim their own refund` });
    rows.push({ k: 'Status', v: closed ? 'settled' : status.toLowerCase() }, { k: 'Network', v: net });
    return rows;
  }
  const rows = [{ k: 'Type', v: 'Fundraiser' }];
  if (c.cap) rows.push({ k: 'Soft cap', v: amt(c.goal) }, { k: 'Hard cap', v: amt(c.cap) }, { k: 'Soft cap missed', v: 'everyone is refunded' });
  else rows.push({ k: 'Goal', v: amt(c.goal) }, { k: 'Goal missed', v: 'everyone is refunded' });
  rows.push({ k: 'Smallest contribution', v: amt(c.min) }, { k: 'Refund fee', v: amt(c.fee) }, { k: 'Deadline', v: blk(c.deadline_height) },
    { k: 'Ticket window', v: `${c.ticket_k} blocks`, sub: 'Your refund ticket arrives within this window; if the host has not closed by then, you can claim your own refund.' });
  if (c.early_close) rows.push({ k: 'Early close', v: 'allowed' });
  if (c.cancellable) rows.push({ k: 'Cancel', v: 'the host can refund everyone, minus the fee' });
  rows.push({ k: 'Network', v: net });
  return rows;
}

/** One of the campaign view's parts (the prototype's own markup, <template id="t-cv-…"> in the page), cloned. */
const part = (k) => { const t = document.getElementById(`t-cv-${k}`); return t ? t.content.firstElementChild.cloneNode(true) : el('div'); };
const shellOf = (k) => { const p = part(k); p.replaceChildren(); return p; };
/** A label and value row (the prototype's key and value line); `sub` is a smaller second line under the value. */
export function kvRow(k, v, { html = false, sub = '', id = '' } = {}) {
  const r = part('kv'), [kk, vv] = r.children, val = vv.firstElementChild;
  kk.textContent = k; if (html) val.innerHTML = v; else if (v instanceof Node) val.replaceChildren(v); else val.textContent = v;
  if (id) val.id = id;
  if (sub) vv.append(Object.assign(document.createElement('span'), { textContent: sub, style: 'font: 400 12px var(--fm); color: var(--mut); text-align: right;' }));
  return r;
}
/** A stat: label, the figure (with its unit set small after it), the line under it. */
function stat(label, value, unit, line, { html = false } = {}) {
  const s = part(unit ? 'stat' : 'stat-plain'), [k, b, l] = s.children;
  k.textContent = label;
  if (unit) { const u = b.lastElementChild; b.replaceChildren(); b.append(html ? value.replace(/<[^>]+>/g, '').replace(/\s*(TAZ|ZEC)\s*$/, '') : value); u.textContent = unit; b.append(u); }
  else b.textContent = value;
  l.textContent = line || ''; l.hidden = !line;
  return s;
}
function btn(kind, text, href, id, arrow = false) {
  const b = part(kind), a = document.createElement('a');
  for (const at of b.attributes) if (at.name !== 'type') a.setAttribute(at.name, at.value);
  if (kind === 'btn-primary') { const [t, ar] = b.children; t.textContent = text; a.append(t); if (arrow) a.append(ar); }
  else a.textContent = text;
  a.href = href; if (id) a.id = id; a.style.textDecoration = 'none';
  return a;
}
/** The status chips beside Back (open in the pass colour; every closed outcome neutral) and the network chip. */
export function statusChips(box, { phase, outcome = null, refunding = false, soft = false, network = null }) {
  const chip = (text, colour, kind = '') => { const s = document.createElement('span'); s.className = `cv-chip sbadge ${kind}`.trim(); s.style.cssText = `display: inline-flex; align-items: center; gap: 8px; font: 600 12px var(--fm); letter-spacing: .16em; text-transform: uppercase; color: ${colour}; white-space: nowrap;`;
    const d = document.createElement('span'); d.style.cssText = `width: 8px; height: 8px; flex: 0 0 auto; background: ${colour};`; s.append(d, text); return s; };
  const out = [];
  if (phase === 'open') out.push(chip('Open', 'var(--pass)', 'open'));
  else if (phase === 'ended') out.push(chip('Deadline passed', 'var(--mut)', 'ended'));
  else if (phase === 'closed') out.push(chip(outcome === 'cancelled' ? 'Cancelled' : OUTCOME_WORDS[outcome] ? `Closed · ${outcomeWords(outcome, soft)}` : 'Closed', 'var(--mut)', 'closed'));
  else out.push(chip('Checking', 'var(--mut)'));
  if (refunding) out.push(chip('Refunding', 'var(--mut)', 'refunding'));
  if (network === 'test') out.push(chip('Testnet', 'var(--warn)')); else if (network === 'main') out.push(chip('Mainnet', 'var(--ink)'));
  box.replaceChildren(...out);
}

/** This browser's own payment to the campaign, read from its saved state (the contribute page's ll:<id>, the bid page's ll:sealed:<id>): only what
 *  is stored is shown; the ticket checks run on the contribute page, so none is claimed here. */
function yoursCard(v, { closed, left, auction, winners, entries }) {
  let st = null, sealedSt = null;
  try { st = JSON.parse(localStorage.getItem(`ll:${v.id}`)); } catch { st = null; }
  try { sealedSt = JSON.parse(localStorage.getItem(`ll:sealed:${v.id}`)); } catch { sealedSt = null; }
  const s = st && (st.txid || st.ticket) ? st : null;
  if (!s && !(sealedSt && (sealedSt.paidZat || sealedSt.tranche))) return null;
  const card = part('yours'), [, , , , , k, fig, rows, go] = card.children;
  k.textContent = 'Yours · in this browser';
  const amount = s ? (s.paidZat != null ? s.paidZat : s.amountZat) : (sealedSt.paidZat || sealedSt.tranche);
  const u = fig.lastElementChild; fig.replaceChildren(); fig.insertAdjacentHTML('afterbegin', amountHTML(amount, '')); u.textContent = v.c.ticker; fig.append(u);
  const list = [];
  const nf = s && s.ticket ? s.ticket.nf : null;
  if (auction && winners && nf) {
    const won = winners.includes(nf), st2 = entries.find((e) => e.kind === 'settle' && e.settle && e.settle.nf === nf);
    list.push(kvRow('Result', won ? 'won 1 item' : 'not won'));
    if (won && st2) { list.push(kvRow('Paid', amountHTML(st2.settle.price_zat, v.c.ticker), { html: true })); list.push(kvRow('Coming back', amountHTML(st2.settle.excess_zat, v.c.ticker), { html: true })); }
  } else {
    if (s && s.paidHeight != null) list.push(kvRow('Paid in block', s.paidHeight.toLocaleString('en-US')));
    if (s && s.ticket && s.ticket.entry) list.push(kvRow('Refund ticket', `#${s.ticket.entry.seq}`));
    if (s && s.ticket && !closed && left != null && left > 0 && !auction) list.push(kvRow('Refund me until', `block ${v.c.deadline_height.toLocaleString('en-US')}`));
  }
  rows.replaceChildren(...list);
  const a = document.createElement('a'); for (const at of go.attributes) if (at.name !== 'type') a.setAttribute(at.name, at.value);
  a.textContent = 'Your ticket →'; a.href = (s ? v.links.contribute : v.links.contribute.replace('contribute.html', 'bid.html')) || '#'; a.id = 'yours-link'; a.style.textDecoration = 'none';
  go.replaceWith(a);
  card.id = 'yours-card';
  return card;
}

/** Draws the view into `box`. v: { c, id, entries, ok (relays that answered, with their entries), relays, single (only one relay gave a list),
 *  tip, secPerBlock, links: { recount, card, contribute }, mine }. The campaign page has its own head (name, status, id panel); the contribute
 *  page's closed view has none, so the name is drawn here then. */
export function campaignView(box, v) {
  const { c, entries } = v;
  const sealed = !!c.sealed, auction = c.mode === 'auction' || sealed, uniform = c.pricing === 'uniform';
  const closeE = entries.find((e) => e.kind === 'close');
  const closed = !!closeE, outcome = closeE && closeE.close ? closeE.close.outcome : null;
  const left = v.tip == null ? null : c.deadline_height - v.tip;
  const zat = (z) => amountHTML(z, c.ticker);
  const tleft = left != null && left > 0 ? shortEta(eta(left, v.secPerBlock)) : null;
  box.replaceChildren();
  const grid = shellOf('grid'), main = shellOf('main'); grid.id = 'cv-grid';
  if (!document.getElementById('display-name')) {
    const h1 = el('h1', 'cv-h cname', c.name || `${sealed ? 'Blind bid auction' : auction ? 'Auction' : 'Fundraiser'} ${v.id.slice(0, 8)}…`); h1.id = 'display-name';
    h1.style.cssText = 'margin: 0; font: var(--hw) clamp(34px, 5vw, 56px)/.95 var(--fd); letter-spacing: -.035em; text-transform: uppercase; overflow-wrap: anywhere;';
    const hosted = el('p', 'hostedby', ''); hosted.id = 'hosted-by';
    main.append(h1, hosted); fillHostedBy(hosted, v.id);
  }

  // the stats (the prototype's four figures): what the campaign is and where it stands, from the rules and the list only
  const issued = entries.filter((e) => e.kind === 'issue');
  const raisedZat = issued.reduce((t, e) => t + (e.contribution && e.contribution.value_zat != null ? e.contribution.value_zat : 0), 0);
  const tbox = shellOf('stats'); tbox.id = 'tiles';
  const stats = [];
  const span = () => { if (!(left > 0) || !v.secPerBlock) return null; const t = left * v.secPerBlock; if (t < 3600) return `${Math.max(1, Math.round(t / 60))} min`; if (t < 172800) { const hh = Math.floor(t / 3600), mm = Math.round((t % 3600) / 60); return `${hh}h ${String(mm).padStart(2, '0')}m`; } return `${Math.round(t / 86400)} days`; };
  const timeLeft = () => stat('Time left', span() || (tleft ? tleft.replace(/^~/, '') : left != null && left <= 0 ? 'passed' : DASH), '', left != null && left > 0 ? `about ${left.toLocaleString('en-US')} blocks` : `deadline block ${c.deadline_height.toLocaleString('en-US')}`);
  const count = (n, one, many) => stat('Entries', String(n), '', n === 1 ? one : many);
  if (sealed && v.didNotFinish) stats.push(stat('Outcome', 'Host did not finish', '', `everyone can take their deposit back with their late ticket from block ${c.sealed.claim_after + 1}`));
  if (closed) {
    stats.push(stat('Outcome', outcome === 'cancelled' ? 'Cancelled' : (OUTCOME_WORDS[outcome] ? outcomeWords(outcome, !!c.cap) : 'finished').replace('auction settled', 'settled').replace(/^./, (x) => x.toUpperCase()),
      '', closeE.close ? (auction && closeE.close.winners ? `${closeE.close.winners.length} ${closeE.close.winners.length === 1 ? 'winner' : 'winners'}, ${c.items} ${c.items === 1 ? 'item' : 'items'} · block ${closeE.close.close_height.toLocaleString('en-US')}` : `block ${closeE.close.close_height.toLocaleString('en-US')}`) : ''));
    if (auction) stats.push(stat('Terms', String(c.items), c.items === 1 ? 'item' : 'items', sealed ? metaLine(c).split(' · ').pop() : uniform ? 'one price for every winner' : 'pay your bid'));
    else stats.push(stat(c.cap ? 'Soft cap' : 'Goal', zat(c.goal_zat), c.ticker, c.cap ? `hard cap ${c.cap} ${c.ticker}` : '', { html: true }));
    if (auction && closeE.close && closeE.close.clearing_price_zat != null) stats.push(stat('Price', zat(closeE.close.clearing_price_zat), c.ticker, 'every winner pays it', { html: true }));
    else if (!auction) stats.push(stat('Raised', zat(raisedZat), c.ticker, `${issued.length} ${issued.length === 1 ? 'contribution' : 'contributions'}`, { html: true }));
    stats.push(stat('Network', c.network === 'main' ? 'Mainnet' : 'Testnet', '', `paid in ${c.ticker}`));
  } else if (sealed) {
    stats.push(stat('Items', String(c.items), '', 'one per winning bid'));
    stats.push(stat('Deposits', c.sealed.tranches.join(' · '), '', `${c.ticker} deposit sizes`));
    stats.push(timeLeft()); stats.push(count(issued.length, 'deposit', 'deposits'));
  } else if (auction) {
    stats.push(stat('Items', String(c.items), '', 'one per winning bid'));
    stats.push(uniform ? stat('Reserve', zat(c.reserve_zat), c.ticker, 'lowest price an item sells for', { html: true }) : stat('Smallest bid', zat(c.min_zat), c.ticker, '', { html: true }));
    stats.push(timeLeft()); stats.push(count(issued.length, 'bid', 'bids'));
  } else {
    const of = c.cap ? c.cap_zat : c.goal_zat, pct = of ? Math.min(100, Math.round(raisedZat / of * 100)) : 0;
    stats.push(stat('Raised', zat(raisedZat), c.ticker, `${pct}% of the ${c.cap ? 'hard cap' : 'goal'}`, { html: true }));
    if (c.cap) { stats.push(stat('Soft cap', zat(c.goal_zat), c.ticker, 'the least it must keep', { html: true })); stats.push(stat('Hard cap', zat(c.cap_zat), c.ticker, 'the most it keeps', { html: true })); }
    else stats.push(stat('Goal', zat(c.goal_zat), c.ticker, 'missed: everyone is refunded', { html: true }));
    stats.push(timeLeft()); if (!c.cap) stats.push(count(issued.length, 'contribution', 'contributions'));
  }
  tbox.append(...stats); main.append(tbox);
  // the meter, while a fundraiser is open: raised against the goal (with a hard cap, against the hard cap)
  if (!auction && !closed) {
    const of = c.cap ? c.cap_zat : c.goal_zat, pct = of ? Math.min(100, Math.round(raisedZat / of * 100)) : 0;
    const m = part('meter'), [track, labels] = m.children;
    track.children[1].style.width = `${pct}%`; track.lastElementChild.style.left = `calc(${pct}% - 4px)`;
    labels.children[0].textContent = `${pct}% of ${c.cap ? 'hard cap' : 'goal'}`; labels.children[1].textContent = `deadline block ${c.deadline_height.toLocaleString('en-US')}`;
    m.id = 'meter'; main.append(m);
  }

  // the closed line (or the note while open), then the actions: Contribute or Bid and ↻ Recount while it takes payments; ↻ Recount alone after
  const noteText = closed && outcome === 'cancelled' ? '■ Cancelled. Everyone refunded.'
    : closed ? `■ Closed: ${outcomeWords(outcome, !!c.cap)}. No new ${auction ? 'bids' : 'payments'}.`
    : c.cancellable && left != null && left > 0 ? 'The host can cancel and refund everyone, minus the network fee.'
    : left != null && left <= 0 ? 'This campaign is no longer taking contributions.'
      : sealed ? `Bids stay locked until drand round ${c.sealed.round}, after bidding closes: nobody, the host included, can read one before.`
        : auction ? 'Bid amounts stay off the public record until the auction closes; the host sees each bid as it arrives.' : '';
  if (noteText) { const n = part('closed-line'); n.textContent = noteText; n.classList.add('cv-note2', closed || (left != null && left <= 0) ? 'closed-note' : 'bid-note'); n.id = closed || (left != null && left <= 0) ? 'closed-note' : 'bid-note'; main.append(n); }
  const act = shellOf('actions'); act.id = 'links'; act.classList.add('cv-act', 'actions');
  const takes = !closed && left != null && left > 0 && v.links.contribute;
  if (takes) act.append(btn('btn-primary', auction ? 'Bid' : 'Contribute', v.links.contribute, 'contribute-link', true));
  const rc = takes ? btn('btn-outline', '↻ Recount', v.links.recount, 'recount-link') : btn('btn-primary', '↻ Recount', v.links.recount, 'recount-link', true);
  rc.classList.add('recount-btn'); act.append(rc);
  main.append(act);

  // 01 Public list, as published, newest first
  const list = shellOf('section'); list.id = 'public-list'; list.classList.add('cv-list', 'plist');
  const hd = part('section-head'), [title, hint] = hd.children;
  const tg = document.createElement('button'); tg.type = 'button'; tg.id = 'pl-toggle'; tg.className = 'cv-lt pl-toggle'; tg.setAttribute('aria-expanded', 'false'); tg.setAttribute('aria-controls', 'list-facts');
  tg.style.cssText = 'display: flex; gap: 14px; align-items: center; white-space: nowrap; background: none; border: 0; padding: 0; margin: 0; min-height: 0; font: inherit; color: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer;';
  tg.append(...title.childNodes); title.replaceWith(tg);
  tg.lastElementChild.textContent = 'Public list';
  hint.id = 'entries-hint'; hint.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} · as published`;
  list.append(hd);
  const cnt = (k) => entries.filter((e) => e.kind === k).length;
  const lf = el('dl', 'cv-lfacts lfacts'); lf.id = 'list-facts'; lf.hidden = true;
  for (const [label, note, value] of [['Entries listed', "everything on the host's public list", String(entries.length)], ['Refund tickets issued', auction ? 'one per bid' : 'one per contribution', String(cnt('issue'))],
    ['Tickets reissued', 'only after a network upgrade', String(cnt('reissue'))], ['Payments set aside', 'not counted', String(cnt('reject'))]]) lf.append(kvRow(`${label} (${note})`, value));
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
  const table = shellOf('table'); table.id = 'entries-card'; table.classList.add('cv-scroll', 'entries', auction ? 'auc' : 'fund');
  table.setAttribute('role', 'table'); table.setAttribute('aria-label', 'Public list, newest first');
  const th = part('thead'); th.setAttribute('role', 'row'); th.classList.add('lhead');
  [...th.children].forEach((s) => s.setAttribute('role', 'columnheader'));
  th.children[4].textContent = auction ? 'Price paid' : 'Amount';
  table.append(th);
  const body = el('div'); body.id = 'entries'; body.setAttribute('role', 'rowgroup'); body.style.cssText = 'display: flex; flex-direction: column;';
  for (const e of all) {
    const r = rowOf(c, entries, e, h);
    if (r.summary) { const s = part('more'); s.classList.add('sum'); s.dataset.seq = String(e.seq); s.setAttribute('role', 'row'); s.innerHTML = r.summary; body.append(s); continue; }
    const nf = (e.contribution && e.contribution.nf) || (e.settle && e.settle.nf) || (e.coin && e.coin.nf) || null;
    const mine = !!(v.mine && nf && v.mine.has(nf));
    const row = part(mine ? 'row-yours' : 'row'); row.dataset.seq = String(e.seq); row.setAttribute('role', 'row'); if (mine) row.classList.add('mine');
    const [k, res, what, blk, last] = row.children, [kind, ref, sumLine] = k.children;
    kind.firstChild.textContent = mine ? `${r.kind} ` : r.kind;
    ref.textContent = r.ref ? `${r.ref.slice(0, 8)}…${r.ref.slice(-5)}` : ''; if (r.ref) ref.title = r.ref;
    res.textContent = r.result; res.classList.add('res'); if (r.result === 'Won') res.classList.add('won'); else if (r.result === 'Not won') res.classList.add('lost');
    what.innerHTML = r.what; what.classList.add('what');
    blk.textContent = r.block != null ? r.block.toLocaleString('en-US') : DASH; blk.classList.add('blk'); if (r.block != null) blk.dataset.block = String(r.block);
    const lastVal = auction ? r.price : r.amount;
    if (lastVal != null) { last.innerHTML = lastVal; last.querySelectorAll('.u').forEach((u) => u.remove()); } else { last.textContent = DASH; last.classList.add('none'); }
    sumLine.textContent = [r.result, r.block != null ? `block ${r.block.toLocaleString('en-US')}` : ''].filter(Boolean).join(' · ');
    [k, res, what, blk, last].forEach((x) => x.setAttribute('role', 'cell'));
    body.append(row);
  }
  table.append(body); list.append(table);
  const more = part('more'); const mb = document.createElement('button'); mb.type = 'button'; mb.id = 'entries-more'; mb.className = 'cv-more-list pl-more';
  mb.style.cssText = 'background: none; border: 0; padding: 0; margin: 0; min-height: 0; font: inherit; color: inherit; letter-spacing: inherit; text-transform: none; cursor: pointer; text-align: left;';
  more.replaceChildren(mb); mb.setAttribute('aria-controls', 'entries'); mb.setAttribute('aria-expanded', 'false'); more.hidden = true;
  list.append(more);
  const empty = el('p', 'cv-empty pl-empty', 'No entries yet.'); empty.id = 'entries-empty'; empty.hidden = all.length > 0; list.append(empty);
  table.hidden = all.length === 0;
  const SHOWN = 5, rows = [...body.children];
  if (rows.length > SHOWN) {
    const fold = (open) => { rows.forEach((tr, i) => { tr.hidden = !open && i >= SHOWN; }); mb.textContent = open ? 'Show fewer' : `${rows.length - SHOWN} more ${rows.length - SHOWN === 1 ? 'entry' : 'entries'}, as published`; mb.setAttribute('aria-expanded', String(open)); };
    more.hidden = false; fold(false); mb.addEventListener('click', () => fold(mb.getAttribute('aria-expanded') !== 'true'));
  }
  main.append(list);

  // 02 Rules
  const status = closed ? 'Closed' : left == null ? 'Open (the chain height could not be read)' : left > 0 ? 'Open' : 'Deadline passed, not yet closed';
  const rules = shellOf('section'); rules.id = 'rules';
  const rh = part('section-head'); rh.children[0].children[0].textContent = '02'; rh.children[0].children[1].textContent = 'Rules'; rh.children[1].textContent = '';
  const dl = shellOf('kvs'); dl.id = 'facts'; dl.classList.add('cv-dl');
  for (const r of designRuleRows(c, { status, closed, outcome })) { const row = kvRow(r.k, r.v); if (r.sub) row.title = r.sub; dl.append(row); }
  rules.append(rh, dl);
  if (uniform) rules.append(Object.assign(el('p', 'cv-note rule-note', 'A bid must be at least the reserve plus the refund fee to win; if fewer bids reach it than there are items, every winner pays the reserve.'), { id: 'rule-note' }));
  main.append(rules);

  // the aside: this browser's own payment, the folds and links, and the relays
  const aside = shellOf('aside'); aside.classList.add('cv-side');
  const yours = yoursCard(v, { closed, left, auction, winners, entries }); if (yours) aside.append(yours);
  const links = part('links'), [who, cap, bk] = links.children;
  who.id = 'who-toggle'; who.setAttribute('aria-expanded', 'false'); who.setAttribute('aria-controls', 'take');
  const take = el('div', 'cv-fold fold'); take.id = 'take'; take.hidden = true; take.append(whoSeesWhat()); take.style.cssText = 'padding: 4px 0 12px; font: 400 13px/1.55 var(--fb); color: var(--mut);';
  who.addEventListener('click', () => { const o = who.getAttribute('aria-expanded') !== 'true'; who.setAttribute('aria-expanded', String(o)); take.hidden = !o; who.firstElementChild.textContent = `${o ? '▾' : '▸'} Who can see what`; });
  who.after(take);
  const asLink = (b, href, id, cls) => { const a = document.createElement('a'); for (const at of b.attributes) if (at.name !== 'type') a.setAttribute(at.name, at.value); a.append(...b.childNodes); a.href = href; a.id = id; a.classList.add(cls); a.style.textDecoration = 'none'; b.replaceWith(a); return a; };
  asLink(cap, v.links.card, 'card-link', 'card-link');
  asLink(bk, 'recount.html#ticket-box', 'bk-link', 'cv-bk');
  aside.append(links);
  const foot = part('foot'); foot.id = 'pl-foot'; foot.classList.add('cv-foot', 'pl-foot');
  const nOk = (v.ok || []).length, ent = (k) => `${k} ${k === 1 ? 'entry' : 'entries'}`;
  const live = el('span', '', v.single ? `${nOk} ${nOk === 1 ? 'relay' : 'relays'} answered. ${v.relays.length > 1 ? 'Only one relay gave a usable list.' : 'Only one relay was asked, so nothing here has been cross checked.'}` : `${nOk} ${nOk === 1 ? 'relay' : 'relays'} answered and their lists match.`);
  live.id = 'relay-live';
  const ol = el('ol', 'relays'); ol.id = 'relay-list'; ol.style.cssText = 'margin: 6px 0 0; padding: 0; list-style: none;';
  v.relays.forEach((url) => { const info = (v.ok || []).find((r) => r.url === url); ol.append(el('li', info ? '' : 'bad', `${hostOf(url)}: ${info ? ent(info.entries.length) : 'no usable answer'}`)); });
  foot.replaceChildren(live, ' Recount is the independent check.', ol);
  aside.append(foot);
  grid.append(main, aside);
  box.append(grid);
  decorateAmounts(box);
}
