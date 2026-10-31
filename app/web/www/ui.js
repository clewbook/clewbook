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

export function setup(title, { themeControl = true, host = false } = {}) {
  document.documentElement.dataset.started = '1'; // the page's scripts loaded and ran (loadguard.js looks at this)
  if (themeControl) mountTheme(); else applyTheme(themeChoice());
  if (themeControl) mountChrome({ host });
  if (!document.getElementById('i-pass')) document.body.insertAdjacentHTML('afterbegin', SPRITE);
  for (const el of document.querySelectorAll('[data-brand]')) el.textContent = PRODUCT_NAME;
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

// ---------- the approximately sign: the Geist files have no ≈, so each one is drawn in a monospace font that has it ----------
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
// the page follows the device, also when it changes while the page is open. The ◐ button in the header cycles System → Light → Dark (README §4);
// the phone menu has the same three as a Theme row. The choice is kept in this browser when it allows it. Only colours change (ui.css).
const THEME_KEY = 'cb-theme';
const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const darkQuery = () => (window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);
export function themeChoice() {
  try { const c = localStorage.getItem(THEME_KEY); return c === 'light' || c === 'dark' ? c : 'system'; } catch { return 'system'; }
}
const THEME_ICON = {
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor"/></svg>',
};
export function applyTheme(choice) {
  const q = darkQuery();
  const dark = choice === 'dark' || (choice === 'system' && !!q && q.matches);
  const root = document.documentElement;
  root.dataset.themeChoice = choice;
  root.dataset.theme = dark ? 'dark' : 'light';
  for (const b of document.querySelectorAll('.theme-seg button')) b.setAttribute('aria-pressed', String(b.dataset.theme === choice));
  const label = `Appearance: ${THEMES.find(([v]) => v === choice)[1]}. Click to change.`;
  for (const b of document.querySelectorAll('.theme-btn')) { b.innerHTML = THEME_ICON[choice]; b.setAttribute('aria-label', label); b.title = label; b.dataset.choice = choice; }
}
function chooseTheme(c) {
  try { localStorage.setItem(THEME_KEY, c); } catch { /* storage blocked: the choice holds for this page only */ }
  applyTheme(c);
}
let themeWatching = false;
/** The ◐ appearance button in the header (made once). */
export function mountTheme() {
  applyTheme(themeChoice());
  const q = darkQuery();
  if (q && !themeWatching) {
    themeWatching = true;
    const follow = () => { if (document.documentElement.dataset.themeChoice === 'system') applyTheme('system'); };
    if (q.addEventListener) q.addEventListener('change', follow); else if (q.addListener) q.addListener(follow);
  }
  const bar = document.querySelector('header.bar');
  if (bar && !bar.querySelector('.theme-btn')) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'theme-btn'; b.id = 'theme-ctl';
    b.addEventListener('click', () => { const order = THEMES.map(([v]) => v); chooseTheme(order[(order.indexOf(themeChoice()) + 1) % order.length]); });
    bar.append(b);
  }
  applyTheme(themeChoice());
}
/** System, Light and Dark as three pressed buttons in one pill (the phone menu's Theme row). */
function themeSeg() {
  const seg = document.createElement('span'); seg.className = 'theme-seg'; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Theme');
  for (const [v, t] of THEMES) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.theme = v; b.textContent = t; b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => chooseTheme(v));
    seg.append(b);
  }
  return seg;
}

// ---------- the frame: header (logo, network badge, nav, ◐, menu) and footer (README §4) ----------
// Inside the testnet demo (clewbook.xyz/demo, or a page the demo build marked) the site links point back to the main site.
const APP = 'https://app.clewbook.xyz/';
const REPO = 'https://github.com/clewbook/clewbook';
const isDemo = () => location.hostname === 'clewbook.xyz' || !!document.querySelector('.demo-link.cur') || document.documentElement.dataset.demo === '1';
const MARK = '<svg viewBox="1 6 44 33" aria-hidden="true" focusable="false"><path d="M16 12H32A6 6 0 0 1 32 24H12A6 6 0 0 0 12 36H41" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="12" r="3"/></svg>';
function footerHTML(host) {
  const site = host || isDemo() ? APP : './';
  const cols = [
    ['Product', [['Campaigns', `${site}#campaigns`], ['Recount', host ? `${APP}recount.html` : 'recount.html'], ['Testnet demo', 'https://clewbook.xyz/demo/'], ['Tested milestones', 'https://clewbook.xyz/demo/proofs/']]],
    ['Learn', [['Blind bid auctions', `${site}#blind`], ['Refund tickets', `${site}#tickets`], ['Who sees what', `${site}#who`], ['Fundraisers and presales', `${host || isDemo() ? APP : ''}host.html#fundraisers`], ['Auctions', `${host || isDemo() ? APP : ''}host.html#auctions`]]],
    ['Hosting', [['Host with us', `${REPO}/issues/new?title=Host%20with%20us`], ['Host it yourself', `${REPO}/blob/main/docs/HOSTING.md`], ['Docs', `${REPO}/tree/main/docs`]]],
    ['Project', [['GitHub', REPO], ['About', `${host || isDemo() ? APP : ''}about.html`]]],
  ];
  const esc2 = (t) => esc(t);
  // the prototype's tilted ledger behind the columns (its sample rows are a picture, not data); row #006 lit, as the prototype first draws it
  const plane = '<div class="fp"><div class="fp-hd"><span>ENTRY</span><span>AMOUNT</span><span>BLOCK</span><span>CHECK</span></div>'
    + [['#001 payment', '0.0010 ZEC', '3,524,301'], ['#002 payment', '0.0250 ZEC', '3,524,302'], ['#003 ticket', 'issued', '3,524,302'], ['#004 payment', '0.5000 ZEC', '3,524,305'],
      ['#005 ticket', 'issued', '3,524,306'], ['#006 payment', '0.0040 ZEC', '3,524,310'], ['#007 ticket', 'issued', '3,524,311'], ['#008 close', 'goal met', '3,524,355']]
      .map(([e, a, b], i) => `<div class="fp-row${i === 5 ? ' on' : ''}"><span>${e}</span><span>${a}</span><span>${b}</span><span${i < 6 ? ' class="ok"' : ''}><span>${i < 6 ? '✓' : '·'}</span></span></div>`).join('') + '</div>';
  return `<div class="foot-plane" aria-hidden="true">${plane}</div><div class="foot-in">`
    + `<div class="foot-col foot-brand"><a class="foot-logo" href="${host ? APP : isDemo() ? APP : './#start'}" aria-label="clewbook home">${MARK}<span>clewbook</span></a><span class="foot-tag">Private markets. Public accounting. Refund tickets.</span></div>`
    + cols.map(([k, links]) => `<nav class="foot-col" aria-label="${esc2(k)}"><span class="foot-k">${esc2(k)}</span>${links.map(([t, h]) => `<a href="${esc2(h)}"${/^https:\/\/(github|clewbook\.xyz)/.test(h) ? ' rel="noopener"' : ''}>${esc2(t)}</a>`).join('')}</nav>`).join('')
    + '</div>';
}
// ---------- the tilted ledger (prototype: the home hero and the footer) ----------
// The plane turns a little toward the pointer: rotateX(52 - y*10) rotateZ(-30 + x*10), x and y the pointer's place over `area` from -0.5 to 0.5
// in steps of 0.05 (the prototype's planeMove). The row nearest the pointer is lit and the rows above it are checked; with no pointer over
// `area`, one more row is checked every 750 ms (the prototype's tick), going on from the last lit row. Touch has no hover, so a phone gets the
// tick only; a narrow window keeps the plane's own CSS tilt. With reduced motion nothing moves and the rows stay as drawn.
export function ledgerPlane(area, plane, rows, { start = 0 } = {}) {
  if (!area || !plane || !rows.length) return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const narrow = () => innerWidth < 640, step = (v) => Math.round(Math.max(-0.5, Math.min(0.5, v)) * 20) / 20;
  let tick = start, over = false;
  const paint = (hl) => rows.forEach((r, i) => {
    const m = r.children[3]; (m.firstElementChild || m).textContent = i < hl ? '✓' : '·'; m.style.color = i < hl ? 'var(--pass)' : 'var(--mut)';
    r.style.color = i === hl - 1 ? 'var(--ink)' : 'var(--mut)'; r.style.background = i === hl - 1 ? 'rgba(var(--ov),.08)' : 'transparent';
  });
  area.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || narrow()) { over = false; plane.style.transform = ''; return; }
    over = true;
    const b = area.getBoundingClientRect(), x = step((e.clientX - b.left) / b.width - 0.5), y = step((e.clientY - b.top) / b.height - 0.5);
    plane.style.transform = `rotateX(${52 - y * 10}deg) rotateZ(${-30 + x * 10}deg)`;
    let near = 0, best = Infinity;
    rows.forEach((r, i) => { const q = r.getBoundingClientRect(), d = Math.hypot(q.left + q.width / 2 - e.clientX, q.top + q.height / 2 - e.clientY); if (d < best) { best = d; near = i; } });
    tick = near + 1; paint(tick);
  });
  area.addEventListener('pointerleave', () => { over = false; plane.style.transform = ''; });
  addEventListener('resize', () => { if (narrow()) plane.style.transform = ''; });
  setInterval(() => { if (over || document.hidden || area.closest('[hidden]')) return; tick += 1; paint(tick % 10); }, 750);
}

function mountChrome({ host }) {
  // the footer: one per page, the same everywhere
  let foot = document.querySelector('footer.sitefoot');
  if (!foot) { foot = document.createElement('footer'); foot.className = 'sitefoot'; document.body.append(foot); }
  if (!foot.dataset.built) {
    foot.dataset.built = '1'; foot.innerHTML = footerHTML(host);
    const fp = foot.querySelector('.fp'); ledgerPlane(foot, fp, [...fp.querySelectorAll('.fp-row')], { start: 6 });
  }
  const bar = document.querySelector('header.bar'), nav = bar && bar.querySelector('nav.nav');
  if (!bar) return;
  // the logo is the site home (the intro); a spacer pushes nav, ◐ and the menu button to the right
  const word = bar.querySelector('.word');
  if (word && !host && !isDemo()) word.setAttribute('href', './#start');
  if (!bar.querySelector('.bar-gap')) { const g = document.createElement('span'); g.className = 'bar-gap'; (bar.querySelector('.tagline') || word || bar.firstChild).after(g); }
  const theme = bar.querySelector('.theme-btn');
  if (!nav || bar.querySelector('.menu-btn')) return;
  if (theme) nav.after(theme);
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'menu-btn'; btn.setAttribute('aria-label', 'Menu'); btn.setAttribute('aria-expanded', 'false'); btn.textContent = '☰';
  bar.append(btn);
  let panel = null;
  const close = () => { if (!panel) return; panel.remove(); panel = null; btn.setAttribute('aria-expanded', 'false'); btn.textContent = '☰'; };
  const open = () => {
    panel = document.createElement('div'); panel.className = 'menu-panel';
    for (const a of nav.querySelectorAll('a:not(.demo-link)')) { const c = a.cloneNode(true); c.removeAttribute('id'); panel.append(c); }
    const row = document.createElement('div'); row.className = 'theme-row'; const t = document.createElement('span'); t.textContent = 'Theme'; t.setAttribute('aria-hidden', 'true'); row.append(t, themeSeg()); panel.append(row);
    bar.append(panel); btn.setAttribute('aria-expanded', 'true'); btn.textContent = '✕';
    applyTheme(themeChoice());
    panel.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (panel) close(); else open(); });
  document.addEventListener('click', (e) => { if (panel && !panel.contains(e.target) && e.target !== btn) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel) { close(); btn.focus(); } });
  addEventListener('resize', () => { if (innerWidth >= 1000) close(); });
}

// ---------- the network: html[data-net] on every page, and the network button on the Live campaigns page ----------
// The button (owner, 31 Oct 2026) sits in the site header just left of the theme button, only while the Live campaigns list shows: MAIN or TEST
// in short mono letters, and a click shows the other network; it filters the list and the page hears 'cb-net'. The logo carries no network chip
// (owner, 31 Oct 2026): a page with money on it names its network in its own chip or label.
const NET_KEY = 'cb-net';
let switchNet = null;
/** The network the home page shows: ?net= in the address, else the last one chosen in this browser, else the main network. */
export function chosenNet() {
  const q = new URLSearchParams(location.search).get('net');
  if (q === 'main' || q === 'test') return q;
  try { const v = localStorage.getItem(NET_KEY); if (v === 'main' || v === 'test') return v; } catch { /* the page works without it */ }
  return 'main';
}
const pageNet = () => (isDemo() ? 'test' : chosenNet());
/** A page that can show no campaign (the recount with nothing to recount): html[data-net] follows the network this browser last chose. */
export function showPageNet() { return setNetwork(pageNet()); }
/** The 404 page (its own design): the approved footer and the logo, no nav and no other control. */
export function mountNotFound() { mountChrome({ host: false }); }
const NET_NAME = { main: 'Mainnet', test: 'Testnet' };
function buildNetButton() {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'net-btn'; b.id = 'net-btn';
  b.addEventListener('click', () => chooseNet(switchNet === 'main' ? 'test' : 'main'));
  paintNetButton(b);
  return b;
}
function paintNetButton(b) {
  const other = switchNet === 'main' ? 'test' : 'main', say = `Network: ${NET_NAME[switchNet]}. Click to switch to ${NET_NAME[other]}`;
  b.textContent = switchNet === 'main' ? 'MAIN' : 'TEST'; b.dataset.net = switchNet;
  b.title = say; b.setAttribute('aria-label', say); b.setAttribute('aria-pressed', String(switchNet === 'test')); // pressed: the test network is shown
}
/** The Live campaigns page: the network button in the header, left of the theme button. Returns the network shown first. */
export function useNetFilter() {
  switchNet = chosenNet();
  const bar = document.querySelector('header.bar'), theme = bar && bar.querySelector('.theme-btn');
  if (bar && !bar.querySelector('.net-btn')) { const b = buildNetButton(); if (theme) theme.before(b); else bar.append(b); }
  return switchNet;
}
function chooseNet(net) {
  switchNet = net;
  try { localStorage.setItem(NET_KEY, net); } catch { /* the page works without it */ }
  const u = new URL(location.href); u.searchParams.set('net', net); history.replaceState(history.state, '', u);
  for (const b of document.querySelectorAll('.net-btn')) paintNetButton(b);
  dispatchEvent(new CustomEvent('cb-net', { detail: net }));
}

/** The frame on a page that has no other script work (the demo's start pages): the ◐ button, the menu and the footer. */
export function mountFrame() { mountTheme(); mountChrome({ host: false }); if (!document.getElementById('i-pass')) document.body.insertAdjacentHTML('afterbegin', SPRITE); }

/** The page's network, from the campaign's checked rules: html[data-net] lets amounts and styles follow it; each page names the network in
 *  its own chip or label (the logo carries no network chip, owner 31 Oct 2026). Anything other than 'test' or 'main' is "unknown", which no
 *  page treats as either. */
export function setNetwork(network) {
  const kind = network === 'test' || network === 'main' ? network : 'unknown';
  document.documentElement.dataset.net = kind;
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
  coin_used_by_list: ['Coin used by your ticket', 'Your coin was used only by one of your own tickets or its settlement.'],
  reissue_opens: ['New ticket opens', 'Any newer ticket the list names for your contribution opens with your secret.'],
  pays_you: ['Pays you', 'The refund output pays the address you gave. A re-issued ticket must pass this check.'],
  proof: ['Proof', 'The zero knowledge proof inside the refund verifies (run only when you ask).'],
  anchor: ['Chain state', 'The refund’s chain state (anchor) is the note tree of a real block, as the chain servers say.'],
  // the recount
  R1: ['Rules', 'The published rules (and, for an auction, the revealed key) match what the campaign committed to.'],
  R2: ['List integrity', 'The public list is signed, chained, gap free, and closed at most once, after the deadline. A payment gets a new ticket only as a re-issue after a network upgrade, before the close.'],
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
  // the blind bid auction's recount (app/core/src/sealed_recount.rs, S_TITLES); the flagged row is the recount page's own
  S1: ['Every list entry is a real deposit', 'Every list entry is a real deposit.'],
  S2: ['Every deposit got its tickets within K blocks (host reported block)', 'Every deposit got its tickets within K blocks (host reported block).'],
  S3: ["Every deposit got its coin in time, from outside the campaign's funds", "Every deposit got its coin in time, from outside the campaign's funds."],
  S4: ['No deposit left before the deadline except by its early ticket', 'No deposit left before the deadline except by its early ticket.'],
  S5: ['The bids open with round R, and the outcome is what they give', 'The bids open with round R, and the outcome is what they give.'],
  S6: ['Every winner was settled before the late tickets became valid', 'Every winner was settled before the late tickets became valid.'],
  S7: ['Every other deposit went back to the person who paid it', 'Every other deposit went back to the person who paid it.'],
  S8: ['The viewing key was published only after every settlement was mined', 'The viewing key was published only after every settlement was mined.'],
  '⚑': ['Payments not in the auction', 'Payments into the auction address in the bidding window that no entry on the list names. Each counts as a donation and stays in the auction wallet unless the host sends it back by hand. Flagged, not failed.'],
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
// a fundraiser that opted in can be cancelled by its host before the deadline: everyone is refunded by their ticket
export const OUTCOME_WORDS = { goal_met: 'goal met', goal_missed: 'goal missed', cancelled: 'cancelled, everyone refunded', auction: 'auction settled', sealed_auction: 'auction settled', void: 'void, all deposits back' };
export function outcomeWords(outcome, soft = false) {
  const w = OUTCOME_WORDS[outcome];
  return w ? (soft ? w.replace('goal', 'soft cap') : w) : 'finished';
}
export function statusBadgeHTML({ phase, outcome = null, refunding = false, soft = false }) {
  const pill = (cls, word, dot = false) => `<span class="sbadge ${cls}">${dot ? '<i class="sdot" aria-hidden="true"></i>' : ''}${word}</span>`;
  if (phase === 'open') return pill('open', 'OPEN', true);
  if (phase === 'ended') return pill('ended', 'DEADLINE PASSED');
  if (phase !== 'closed') return pill('unknown', 'CHECKING');
  let html = outcome === 'cancelled' ? pill('closed', 'CANCELLED') : pill('closed', OUTCOME_WORDS[outcome] ? `CLOSED · ${outcomeWords(outcome, soft).toUpperCase()}` : 'CLOSED');
  if (refunding) html += pill('refunding', 'REFUNDING');
  return html;
}
