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

export function setup(title, { netbar = true, themeControl = true, host = false } = {}) {
  document.documentElement.dataset.started = '1'; // the page's scripts loaded and ran (loadguard.js looks at this)
  if (themeControl) mountTheme(); else applyTheme(themeChoice());
  if (themeControl) mountChrome({ host });
  if (!document.getElementById('i-pass')) document.body.insertAdjacentHTML('afterbegin', SPRITE);
  for (const el of document.querySelectorAll('[data-brand]')) el.textContent = PRODUCT_NAME;
  if (netbar && !document.getElementById('netbar')) document.body.insertAdjacentHTML('afterbegin', '<div id="netbar" class="netbar checking" role="status">Checking network…</div>');
  document.title = title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const o of document.querySelectorAll('.cid.open')) o.classList.remove('open'); });
  markApprox(document.body);
  if (window.MutationObserver) new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'characterData') { if (m.target.data.includes('≈')) markApprox(m.target.parentNode); continue; }
      for (const n of m.addedNodes) if (n.nodeType === 1) markApprox(n); else if (n.nodeType === 3 && n.data.includes('≈')) markApprox(n.parentNode);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener('click', (e) => { for (const o of document.querySelectorAll('.cid.open')) if (!o.contains(e.target)) o.classList.remove('open'); });
}

// ---------- the approximately sign: Chivo Mono's files have no ≈, so each one is drawn in the system's monospace font ----------
const APPROX_SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'OPTION', 'SELECT', 'TITLE']);
function markApprox(root) {
  if (!root || root.nodeType !== 1 || !root.textContent.includes('≈')) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), found = [];
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    const el = t.parentNode;
    if (t.data.includes('≈') && el && !el.closest('.approx') && !APPROX_SKIP.has(el.nodeName) && el.namespaceURI === 'http://www.w3.org/1999/xhtml') found.push(t);
  }
  for (const t of found) {
    const parts = t.data.split('≈'), frag = document.createDocumentFragment();
    parts.forEach((p, i) => { if (i) frag.append(Object.assign(document.createElement('span'), { className: 'approx', textContent: '≈' })); if (p) frag.append(p); });
    t.replaceWith(frag);
  }
}

// ---------- theme: System (follows the device), Light or Dark ----------
// The small script in every page's head applies the saved choice before the page is drawn (no flash). With no saved choice, or "system" saved,
// the page follows the device, also when it changes while the page is open, and the control shows System. The choice is kept in this browser
// when it allows it. Only colours change (ui.css, :root[data-theme="dark"]).
const THEME_KEY = 'cb-theme';
const darkQuery = () => (window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);
export function themeChoice() {
  try { const c = localStorage.getItem(THEME_KEY); return c === 'light' || c === 'dark' ? c : 'system'; } catch { return 'system'; }
}
export function applyTheme(choice) {
  const q = darkQuery();
  const dark = choice === 'dark' || (choice === 'system' && !!q && q.matches);
  const root = document.documentElement;
  root.dataset.themeChoice = choice;
  root.dataset.theme = dark ? 'dark' : 'light';
  // the Theme controls (footer, phone menu) show the choice: System, Light or Dark
  for (const b of document.querySelectorAll('.theme-seg button')) b.setAttribute('aria-pressed', String(b.dataset.theme === choice));
}
function chooseTheme(c) {
  try { localStorage.setItem(THEME_KEY, c); } catch { /* storage blocked: the choice holds for this page only */ }
  applyTheme(c);
}
let themeWatching = false;
/** The Theme control, always in the same place: the footer line at the bottom of the page (made when the page has none). */
export function mountTheme() {
  applyTheme(themeChoice());
  const q = darkQuery();
  if (q && !themeWatching) {
    themeWatching = true;
    const follow = () => { if (document.documentElement.dataset.themeChoice === 'system') applyTheme('system'); };
    if (q.addEventListener) q.addEventListener('change', follow); else if (q.addListener) q.addListener(follow);
  }
  if (document.getElementById('theme-ctl')) return;
  let foot = document.querySelector('footer.sitefoot');
  if (!foot) { foot = document.createElement('footer'); foot.className = 'sitefoot'; document.body.append(foot); }
  const label = document.createElement('span'); label.textContent = 'Theme'; label.setAttribute('aria-hidden', 'true');
  const wrap = document.createElement('span'); wrap.className = 'theme-ctl'; wrap.id = 'theme-ctl'; wrap.append(label, themeSeg());
  let ctl = foot.querySelector('.foot-ctl');
  if (!ctl) { ctl = document.createElement('span'); ctl.className = 'foot-ctl'; foot.append(ctl); }
  ctl.append(wrap);
  applyTheme(themeChoice());
}
/** System, Light and Dark as three pressed buttons in one pill; the one chosen is filled. */
function themeSeg() {
  const seg = document.createElement('span'); seg.className = 'theme-seg'; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Theme');
  for (const [v, t] of THEMES) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.theme = v; b.textContent = t; b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => chooseTheme(v));
    seg.append(b);
  }
  return seg;
}
const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

// ---------- the frame: footer controls (replay intro) and the phone menu ----------
// The header's last nav item is "Testnet demo": a neutral outlined link, or inside the demo the amber "you are here" item (the demo build writes that one).
// Under 720 px the nav folds into the menu, where the demo is the first row; Replay intro and the Theme control follow a hairline there (owner rule M1),
// and the phone footer shows only its line.
function mountChrome({ host }) {
  const foot = document.querySelector('footer.sitefoot');
  const ctl = foot && foot.querySelector('.foot-ctl');
  if (ctl && !host && !ctl.querySelector('#replay-intro')) {
    const replay = document.createElement('a'); replay.className = 'foot-link'; replay.href = './#intro'; replay.textContent = 'Replay intro'; replay.id = 'replay-intro';
    ctl.prepend(replay);
  }
  const bar = document.querySelector('header.bar'), nav = bar && bar.querySelector('nav.nav');
  if (!bar || !nav || bar.querySelector('.menu-btn')) return;
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'menu-btn'; btn.setAttribute('aria-label', 'Menu'); btn.setAttribute('aria-expanded', 'false'); btn.textContent = '☰';
  nav.before(btn);
  let panel = null;
  const close = () => { if (!panel) return; panel.remove(); panel = null; btn.setAttribute('aria-expanded', 'false'); btn.textContent = '☰'; };
  const open = () => {
    panel = document.createElement('div'); panel.className = 'menu-panel';
    // first row: the testnet demo (a gold link), or inside the demo the place you are
    const demo = nav.querySelector('.demo-link');
    if (demo && demo.matches('[aria-current]')) {
      const cur = document.createElement('span'); cur.className = 'demo-row cur'; cur.setAttribute('aria-current', 'page');
      cur.append(Object.assign(document.createElement('i'), { className: 'demo-dot' }), 'Testnet demo · you are here');
      cur.firstChild.setAttribute('aria-hidden', 'true');
      panel.append(cur);
    } else if (demo) {
      const a = document.createElement('a'); a.className = 'demo-row'; a.href = demo.getAttribute('href'); a.title = demo.title; a.setAttribute('aria-label', demo.getAttribute('aria-label') || demo.title);
      a.append('Testnet demo', Object.assign(document.createElement('span'), { textContent: 'no real money' }));
      panel.append(a);
    }
    for (const a of nav.querySelectorAll('a:not(.demo-link)')) { const c = a.cloneNode(true); c.removeAttribute('id'); panel.append(c); }
    // owner rule M1: Replay intro and the Theme control, after a hairline (the phone footer no longer shows them)
    const replay = document.getElementById('replay-intro');
    if (replay || document.getElementById('theme-ctl')) panel.append(Object.assign(document.createElement('hr'), { className: 'menu-div' }));
    if (replay) { const r = document.createElement('a'); r.className = 'replay'; r.href = replay.getAttribute('href'); r.textContent = 'Replay intro'; r.addEventListener('click', (e) => { e.preventDefault(); close(); replay.click(); }); panel.append(r); }
    if (document.getElementById('theme-ctl')) { const row = document.createElement('div'); row.className = 'theme-row'; const t = document.createElement('span'); t.textContent = 'Theme'; t.setAttribute('aria-hidden', 'true'); row.append(t, themeSeg()); panel.append(row); }
    bar.append(panel); btn.setAttribute('aria-expanded', 'true'); btn.textContent = '✕';
    applyTheme(themeChoice());
    panel.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (panel) close(); else open(); });
  document.addEventListener('click', (e) => { if (panel && !panel.contains(e.target) && e.target !== btn) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel) { close(); btn.focus(); } });
  addEventListener('resize', () => { if (innerWidth >= 720) close(); });
}
/** The frame on a page that has no other script work (the demo's start pages): the Theme control and the phone menu, no Replay intro. */
export function mountFrame() { mountTheme(); mountChrome({ host: true }); }

// ---------- the network bar: the same on every page of a campaign, so the real network and the test network cannot be mistaken for each other ----------
// It starts neutral grey ("Checking network…", no amounts) and changes only when the campaign's checked rules name the network. Anything other than
// 'test' or 'main' is "unknown", which no page treats as either.
// The test network gets the striped TESTNET bar on every page of a campaign. The main network has no bar (the bar element stays, empty and hidden,
// so the page keeps one place for it). An unknown network always says so.
const NETBAR = {
  test: ['test', 'TESTNET', 'TAZ has no value.'],
  main: ['main', '', ''],
  unknown: ['unknown', 'NETWORK UNKNOWN', 'This page cannot tell which network this is.'],
};
export function setNetwork(network) {
  const kind = network === 'test' || network === 'main' ? network : 'unknown';
  const [cls, head, tail] = NETBAR[kind];
  document.documentElement.dataset.net = kind;
  const bar = document.getElementById('netbar');
  if (!bar) return kind;
  bar.className = `netbar ${cls}`;
  bar.replaceChildren();
  bar.hidden = kind === 'main';
  if (head) { const b = document.createElement('b'); b.textContent = head; bar.append(b, ` · ${tail}`); }
  return kind;
}

/** The page has what it needs to show something (its first answer from the relays, or nothing to wait for): loadguard.js stops watching. */
export function markReady() { document.documentElement.dataset.ready = '1'; }

/** The refund a ticket must pay back, for the ticket check's "pays you" line (zatoshis), or null when nothing can be compared.
 *  Fundraiser: the list shows the contribution, so the refund must be exactly that minus the fee.
 *  Auction: the list hides the amount, so the page uses the amount it asked this contributor to pay. A ticket that pays back less than that
 *  minus the fee fails. A larger payment counts in full and its ticket refunds more, so a refund of at least that much is expected
 *  exactly as the ticket's own opening states it (the check then confirms that opening against the ticket's commitment). */
export function expectedRefundZat(listedZat, intendedZat, openingZat, feeZat) {
  if (listedZat != null) return listedZat - feeZat;
  if (intendedZat == null) return null;
  const least = intendedZat - feeZat;
  return openingZat != null && openingZat >= least ? openingZat : least;
}

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

// ---------- amounts: never rounded. On every network: trimmed, no trailing zeros and no decimal point for a whole amount (0.0002, 1). Display
// only: stored, compared, hashed and signed amounts are not touched. The third argument of amountHTML (mainnet or not) is accepted and no longer used.
/** The display text of an amount in zatoshis on mainnet: trimmed, never rounded (0.00012345, 0.0002, 1). */
export function trimmedAmount(zat) {
  const neg = zat < 0; const a = Math.abs(zat); const frac = String(a % 1e8).padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '−' : ''}${Math.floor(a / 1e8)}${frac ? '.' + frac : ''}`;
}
export function amountHTML(zat, unit) {
  const neg = zat < 0; const a = Math.abs(zat);
  return amountParts(String(Math.floor(a / 1e8)), String(a % 1e8).padStart(8, '0'), unit, neg);
}
function amountParts(whole, frac8, unit, neg = false) {
  const f = frac8.replace(/0+$/, '');
  return `<span class="amt">${neg ? '−' : ''}${esc(whole)}${f ? '.' + f : ''}${unit ? `<span class="u"> ${esc(unit)}</span>` : ''}</span>`;
}
const AMOUNT_IN_TEXT = /(\d[\d,]*)(?:\.(\d{1,8}))?( (?:TAZ|ZEC)\b)/g;
/** Re-draws every "<number> TAZ|ZEC" in the text under `root` as a trimmed amount (no trailing zeros). The words stay the same. */
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
  no_expiry: ['No expiry', 'The refund has no expiry height. It can be sent at any time while your contribution is unspent and the network version is the same.'],
  fee: ['Fee', 'The fee equals the one the campaign rules state.'],
  spends_your_coin: ['Spends your coin', 'The refund spends your contribution and nothing else.'],
  your_amount: ['Your amount', 'The public list shows at least the amount you meant to pay; paying more is fine.'],
  coin_unspent: ['Coin unspent', 'Nothing else has used your contribution, so the refund can still be sent.'],
  coin_used_by_list: ['Coin used by the list', 'Your coin was used only by a transaction the campaign’s signed list names.'],
  pays_you: ['Pays you', 'The refund output pays the address you gave.'],
  proof: ['Proof', 'The zero knowledge proof inside the refund verifies (run only when you ask).'],
  anchor: ['Chain state', 'Whether the refund’s chain state (anchor) is a real one; this check is not available yet.'],
  // the recount
  R1: ['Rules', 'The published rules (and, for an auction, the revealed key) match what the campaign committed to.'],
  R2: ['List integrity', 'The public list is signed, chained, gap free, and closed at most once, after the deadline.'],
  R3: ['Entries are real', 'Every entry in the public list is a real payment to the campaign.'],
  R4: ['Tickets issued', 'Every contribution has a refund ticket on the list once the allowed number of blocks has passed.'],
  R4b: ['Ticket timing (host reported)', 'Each ticket was issued within the allowed number of blocks, going by the height the host itself wrote. The recount cannot check that height.'],
  R5: ['No early spend', 'No contribution was spent before the deadline except by its own ticket.'],
  R6: ['Refunds only by ticket', 'Contributions that are not kept left the campaign only through their tickets.'],
  R7: ['Outcome', 'The declared outcome (in an auction, the winners and the price) is what the rules select.'],
  R8: ['Rejects are justified', 'No published challenge opens a valid payment for a payment the campaign set aside.'],
  R9: ['Settlements', 'Each winner paid exactly the clearing price into the treasury, with the exact fee.'],
  R10: ['Treasury total', 'The treasury received exactly the sum of the clearing prices.'],
  R11: ['Nothing diverted', 'Settlements returned no value to the campaign account and have no other outputs.'],
  R12: ['Excess paid back (optional proof)', 'For each winner who chose to publish a proof: the money owed back to them above the price arrived. This is about money, not the auctioned item.'],
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

/** "≈12 days" from a number of blocks and a measured seconds per block; null if the block time was not measured. */
export function etaText(blocks, secondsPerBlock) {
  if (!secondsPerBlock) return null;
  const s = blocks * secondsPerBlock;
  if (s < 90) return 'less than a minute';
  if (s < 5400) return `≈${Math.round(s / 60)} minutes`;
  if (s < 172800) return `≈${Math.round(s / 3600)} hours`;
  return `≈${Math.round(s / 86400)} days`;
}

/** The status badge: the word is always there (OPEN, CLOSED · GOAL MISSED, ...), the colour only adds to it.
 *  phase: 'open' | 'ended' (deadline passed, not closed) | 'closed' | anything else = checking.
 *  After a close the outcome is named on the pill (`goal_met`, `goal_missed`, `auction`; `soft` when the fundraiser has a hard cap, so its goal is the
 *  soft cap). Every closed outcome is neutral grey: a missed goal that refunded everyone is not a failure. `refunding` adds REFUNDING. */
// a blind bid auction closes as sealed_auction (settled) or void (round R came too early: every deposit goes back)
export const OUTCOME_WORDS = { goal_met: 'goal met', goal_missed: 'goal missed', auction: 'auction settled', sealed_auction: 'auction settled', void: 'void, all deposits back' };
export function outcomeWords(outcome, soft = false) {
  const w = OUTCOME_WORDS[outcome];
  return w ? (soft ? w.replace('goal', 'soft cap') : w) : 'finished';
}
export function statusBadgeHTML({ phase, outcome = null, refunding = false, soft = false }) {
  const pill = (cls, word, dot = false) => `<span class="sbadge ${cls}">${dot ? '<i class="sdot" aria-hidden="true"></i>' : ''}${word}</span>`;
  if (phase === 'open') return pill('open', 'OPEN', true);
  if (phase === 'ended') return pill('ended', 'DEADLINE PASSED');
  if (phase !== 'closed') return pill('unknown', 'CHECKING');
  let html = pill('closed', OUTCOME_WORDS[outcome] ? `CLOSED · ${outcomeWords(outcome, soft).toUpperCase()}` : 'CLOSED');
  if (refunding) html += pill('refunding', 'REFUNDING');
  return html;
}
