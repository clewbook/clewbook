// Shared page components (see ui.css): amounts with dimmed zeros, hashes with expand and copy, check ids with a tooltip,
// chips and check rows. Presentation only; nothing here decides anything about a campaign.
import { PRODUCT_NAME } from './brand.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- brand and sprite ----------
const SPRITE = `<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">
  <symbol id="i-pass" viewBox="0 0 12 12"><path d="M2 6.5 4.8 9.2 10 3"/></symbol>
  <symbol id="i-fail" viewBox="0 0 12 12"><path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5"/></symbol>
  <symbol id="i-nc" viewBox="0 0 12 12"><path d="M2.5 6h7"/></symbol></svg>`;

export function setup(title, { netbar = true } = {}) {
  document.documentElement.dataset.started = '1'; // the page's scripts loaded and ran (loadguard.js looks at this)
  if (!document.getElementById('i-pass')) document.body.insertAdjacentHTML('afterbegin', SPRITE);
  for (const el of document.querySelectorAll('[data-brand]')) el.textContent = PRODUCT_NAME;
  if (netbar && !document.getElementById('netbar')) document.body.insertAdjacentHTML('afterbegin', '<div id="netbar" class="netbar checking" role="status">Checking network…</div>');
  document.title = title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const o of document.querySelectorAll('.cid.open')) o.classList.remove('open'); });
  document.addEventListener('click', (e) => { for (const o of document.querySelectorAll('.cid.open')) if (!o.contains(e.target)) o.classList.remove('open'); });
}

// ---------- the network bar: the same on every page of a campaign, so the real network and the test network cannot be mistaken for each other ----------
// It starts neutral grey ("Checking network…", no amounts) and changes only when the campaign's checked rules name the network. Anything other than
// 'test' or 'main' is "unknown", which no page treats as either.
const NETBAR = {
  test: ['test', 'TEST MONEY ONLY', 'Test network: TAZ has no value.'],
  main: ['main', 'ZCASH MAINNET', 'Real ZEC.'],
  unknown: ['unknown', 'NETWORK UNKNOWN', 'This page cannot tell which network this is.'],
};
// `short`: only the network word (the campaign page, which shows no money-moving form; every amount there carries its ticker). The page that takes a
// payment keeps the full sentence, and an unknown network always keeps its sentence.
const SHORT = { test: 'ZCASH TESTNET', main: 'ZCASH MAINNET' };
export function setNetwork(network, { short = false } = {}) {
  const kind = network === 'test' || network === 'main' ? network : 'unknown';
  const [cls, head0, tail] = NETBAR[kind];
  const word = short && SHORT[kind] ? SHORT[kind] : null;
  const head = word || head0;
  document.documentElement.dataset.net = kind;
  const bar = document.getElementById('netbar');
  if (!bar) return kind;
  bar.className = `netbar ${cls}`;
  bar.replaceChildren();
  const b = document.createElement('b'); b.textContent = head;
  if (word) bar.append(b); else bar.append(b, ` · ${tail}`);
  return kind;
}

/** The page has what it needs to show something (its first answer from the relays, or nothing to wait for): loadguard.js stops watching. */
export function markReady() { document.documentElement.dataset.ready = '1'; }

/** The label at the top right of every page: the campaign's own name when it has one (always set as plain text), else the short id.
 *  `name` must come from rules that were checked against the campaign id (campaign_summary does that); the full id is in the tooltip. */
export function setCampaignLabel(id, name, prefix = '') {
  const el = document.getElementById('campaign-id');
  if (!el || !id) return;
  el.textContent = name || `${prefix}${id.slice(0, 8)}…`;
  el.title = name ? `Campaign ${id}` : '';
}

// ---------- chips and markers (shape + word, never colour alone) ----------
const ICON = { pass: 'i-pass', fail: 'i-fail', nc: 'i-nc' };
const WORD = { pass: 'Pass', fail: 'Fail', nc: 'Not checked' };
export const statusOf = (s) => (s === 'not_checked' ? 'nc' : s);
export function chipHTML(status, word) {
  const s = statusOf(status);
  return `<span class="chip ${s}"><svg aria-hidden="true"><use href="#${ICON[s]}"/></svg>${esc(word || WORD[s])}</span>`;
}
export function markerHTML(status) {
  const s = statusOf(status);
  return `<span class="mk ${s}" aria-hidden="true"><svg><use href="#${ICON[s]}"/></svg></span>`;
}

// ---------- amounts: all 8 decimals, trailing zeros dimmed (at least two decimals bright), never rounded ----------
export function amountHTML(zat, unit) {
  const neg = zat < 0; const a = Math.abs(zat);
  return amountParts(String(Math.floor(a / 1e8)), String(a % 1e8).padStart(8, '0'), unit, neg);
}
function amountParts(whole, frac8, unit, neg = false) {
  const digits = frac8.split('');
  let z = digits.length; while (z > 0 && digits[z - 1] === '0') z--; // digits from index z on are trailing zeros
  z = Math.max(z, 2); // at least two decimals stay bright (40.00 then the dimmed tail)
  const cell = (from, to) => { let out = ''; for (let i = from; i < to; i++) out += i >= z ? `<span class="z">${digits[i]}</span>` : digits[i]; return out; };
  return `<span class="amt">${neg ? '−' : ''}${esc(whole)}.${cell(0, 4)}<span class="g">${cell(4, 8)}</span>${unit ? `<span class="u"> ${esc(unit)}</span>` : ''}</span>`;
}
const AMOUNT_IN_TEXT = /(\d[\d,]*)(?:\.(\d{1,8}))?( (?:TAZ|ZEC)\b)/g;
/** Re-draws every "<number> TAZ|ZEC" in the text under `root` as an 8-decimal amount with dimmed zeros. The words stay the same. */
export function decorateAmounts(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !n.parentElement.closest('.amt, script, style, textarea, input, pre, code') && /(?:TAZ|ZEC)\b/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = []; for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const n of nodes) {
    const t = n.nodeValue; AMOUNT_IN_TEXT.lastIndex = 0;
    if (!AMOUNT_IN_TEXT.test(t)) continue;
    const span = document.createElement('span');
    span.innerHTML = esc(t).replace(AMOUNT_IN_TEXT, (_, whole, frac = '', unit) => amountParts(whole.replace(/,/g, ''), frac.padEnd(8, '0'), unit.trim()));
    n.replaceWith(...span.childNodes);
  }
}

// ---------- hash and address: short form, expand in 8-character groups, copy the raw string ----------
const rm = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function mountHash(el, hex, n = 6) {
  const h = String(hex); el.classList.add('hash'); el.classList.toggle('addr', h.length > 80); el.dataset.h = h;
  const short = h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h;
  const groups = (h.match(/.{1,8}/g) || []).map((g) => `<span>${esc(g)}</span>`).join('');
  el.innerHTML = `<code class="h-s" title="${esc(h)}">${esc(short)}</code><button type="button" class="h-b h-x" aria-expanded="false">Expand</button><button type="button" class="h-b h-c">Copy</button><code class="h-f" hidden>${groups}</code>`;
  const f = el.querySelector('.h-f'), x = el.querySelector('.h-x'), c = el.querySelector('.h-c');
  x.addEventListener('click', () => { f.hidden = !f.hidden; x.textContent = f.hidden ? 'Expand' : 'Collapse'; x.setAttribute('aria-expanded', String(!f.hidden)); });
  c.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(h); c.textContent = 'Copied'; } catch { c.textContent = 'Not copied'; }
    setTimeout(() => { c.textContent = 'Copy'; }, rm() ? 1500 : 1500);
  });
  return el;
}
export function hashEl(hex, n = 6) { return mountHash(document.createElement('span'), hex, n); }

// ---------- check ids with a tooltip: name and one sentence (the reason a check did not run is always printed as text too) ----------
export const CHECKS = {
  // the contributor's ticket
  readable: ['Readable', 'The ticket could be opened with your secret and read.'],
  matches_list: ['Matches the signed list', "The ticket's transaction id equals the one in the campaign's signed list."],
  shape: ['Shape', 'The refund has the expected form: two Ironwood actions and nothing else.'],
  signatures: ['Signatures', 'Every signature in the refund transaction verifies.'],
  network_version: ['Network version', 'The ticket was made for the network version in use now; an older one is refused by the network.'],
  no_expiry: ['No expiry', 'The refund never expires, so it can be sent at any time.'],
  fee: ['Fee', 'The fee equals the one the campaign rules state.'],
  spends_your_coin: ['Spends your coin', 'The refund spends your contribution and nothing else.'],
  your_amount: ['Your amount', 'The public list shows at least the amount you meant to pay; paying more is fine.'],
  coin_unspent: ['Coin unspent', 'Nothing else has used your contribution, so the refund can still be sent.'],
  coin_used_by_list: ['Coin used by the list', 'Your coin was used only by a transaction the campaign’s signed list names.'],
  pays_you: ['Pays you', 'The refund output pays the address you gave.'],
  proof: ['Proof', 'The zero-knowledge proof inside the refund verifies (run only when you ask).'],
  anchor: ['Chain state', 'Whether the refund’s chain state (anchor) is a real one; this check is not available yet.'],
  // the recount
  R1: ['Rules', 'The published rules (and, for an auction, the revealed key) match what the campaign committed to.'],
  R2: ['List integrity', 'The public list is signed, chained, gap-free, and closed at most once, after the deadline.'],
  R3: ['Entries are real', 'Every entry in the public list is a real payment to the campaign.'],
  R4: ['Tickets issued', 'Every contribution has a refund ticket within the allowed number of blocks.'],
  R5: ['No early spend', 'No contribution was spent before the deadline except by its own ticket.'],
  R6: ['Refunds only by ticket', 'Contributions that are not kept left the campaign only through their tickets.'],
  R7: ['Outcome', 'The declared outcome (in an auction, the winners and the price) is what the rules select.'],
  R8: ['Rejects are justified', 'No published challenge opens a valid payment for a payment the campaign set aside.'],
  R9: ['Settlements', 'Each winner paid exactly the clearing price into the treasury, with the exact fee.'],
  R10: ['Treasury total', 'The treasury received exactly the sum of the clearing prices.'],
  R11: ['Nothing diverted', 'Settlements returned no value to the campaign account and have no other outputs.'],
  R12: ['Delivery proofs', 'The proofs winners published that their excess arrived hold.'],
};
let tipSeq = 0;
export function cidEl(id, text) {
  const info = CHECKS[id];
  const el = document.createElement('span'); el.className = 'cid'; el.textContent = text || id;
  if (!info) return el;
  el.tabIndex = 0; el.setAttribute('role', 'button');
  const tip = document.createElement('span'); tip.className = 'tip'; tip.id = `tip${++tipSeq}`; tip.setAttribute('role', 'tooltip');
  tip.innerHTML = `<b>${esc(info[0])}</b>${esc(info[1])}`; el.append(tip); el.setAttribute('aria-describedby', tip.id);
  const place = () => { tip.classList.remove('right'); const r = tip.getBoundingClientRect(); if (r.right > innerWidth - 8) tip.classList.add('right'); };
  el.addEventListener('mouseenter', place); el.addEventListener('focus', place);
  el.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); const was = el.classList.contains('open'); for (const o of document.querySelectorAll('.cid.open')) o.classList.remove('open'); if (!was) { el.classList.add('open'); place(); } });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
  return el;
}

// ---------- a check row: id | name and the reason in text | chip ----------
export function checkRow({ id, name, detail, status, cls }) {
  const s = statusOf(status);
  const li = document.createElement('div'); li.className = `chk ${s}${cls ? ' ' + cls : ''}${/^R\d+$/.test(id) ? '' : ' stack'}`;
  const row = document.createElement('div'); row.className = 'row';
  const idCell = document.createElement('span'); idCell.className = 'id'; idCell.append(cidEl(id));
  const nm = document.createElement('span'); nm.className = 'nm'; nm.append(document.createTextNode(name));
  if (detail) { const sm = document.createElement('small'); sm.textContent = detail; nm.append(sm); }
  const chip = document.createElement('span'); chip.innerHTML = chipHTML(s);
  row.append(idCell, nm, chip.firstChild); li.append(row);
  return li;
}

/** "about 12 days" from a number of blocks and a measured seconds per block; null if the block time was not measured. */
export function etaText(blocks, secondsPerBlock) {
  if (!secondsPerBlock) return null;
  const s = blocks * secondsPerBlock;
  if (s < 90) return 'less than a minute';
  if (s < 5400) return `about ${Math.round(s / 60)} minutes`;
  if (s < 172800) return `about ${Math.round(s / 3600)} hours`;
  return `about ${Math.round(s / 86400)} days`;
}

/** The status badge: the word is always there (OPEN, CLOSED, ...), the colour only adds to it.
 *  phase: 'open' | 'ended' (deadline passed, not closed) | 'closed' | anything else = checking.
 *  After a close, `outcome` ('goal_met' | 'auction' | 'goal_missed') adds SUCCEEDED or FAILED, and `refunding` adds REFUNDING. */
export function statusBadgeHTML({ phase, outcome = null, refunding = false }) {
  const pill = (cls, word, dot = false) => `<span class="sbadge ${cls}">${dot ? '<i class="sdot" aria-hidden="true"></i>' : ''}${word}</span>`;
  if (phase === 'open') return pill('open', 'OPEN', true);
  if (phase === 'ended') return pill('ended', 'DEADLINE PASSED');
  if (phase !== 'closed') return pill('unknown', 'CHECKING');
  let html = pill('closed', 'CLOSED');
  if (outcome === 'goal_met' || outcome === 'auction') html += pill('succeeded', 'SUCCEEDED');
  else if (outcome === 'goal_missed') html += pill('failed', 'FAILED');
  if (refunding) html += pill('refunding', 'REFUNDING');
  return html;
}
