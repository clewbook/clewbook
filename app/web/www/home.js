// The home page: lists the campaigns named in campaigns.json (kept by hand: a list of campaign numbers and the relays that hold them) and reads each one's
// rules and signed list from its relay, checked the way every other page checks them, to say whether it is open or closed. The file is only a list of
// where to look; everything shown about a campaign comes from the relay's checked answer. It never shows a raw error.
// Presentation (design round 2): a first visit intro, a search box and a layout button (both kept in this browser only), cards for open campaigns
// and a table for closed ones.
import init, * as W from './pkg/ll_web.js';
import { setup, markReady, decorateAmounts, outcomeWords, amountHTML, useNetFilter } from './ui.js';
import { readRelay, judge, tipOf, observedBlockSeconds, sibling, DEFAULT_ENDPOINTS } from './public.js';

const $ = (s) => document.querySelector(s);
const INTRO_KEY = 'cb-intro-seen', VIEW_KEY = 'cb-view';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* the page works without it */ } };
const narrow = () => innerWidth < 640;
const motion = () => !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---------- intro: three scenes on the first visit (and after "Replay intro"); shown until the visitor reaches the list ----------
// the three background layers (round 5, "living scenes"): decorative only, never read from or about real campaigns. A crowd of soft dots behind
// scene 1, rings behind scene 2, and sample ledger rows behind scene 3; only drawn when motion is allowed. They loop with transform and opacity.
function sceneLayers(box) {
  const crowd = box.querySelector('.bg.crowd'), rings = box.querySelector('.bg.rings'), ledger = box.querySelector('.bg.ledger');
  for (let j = 0; j < 22; j++) {
    const d = document.createElement('i'), z = 6 + (j * 7) % 22;
    Object.assign(d.style, { left: `${(j * 37 + 7) % 96}%`, top: `${(j * 53 + 11) % 90}%`, width: `${z}px`, height: `${z}px`, filter: `blur(${3 + (j % 4) * 3}px)`,
      animationDuration: `${9 + (j % 5) * 2.4}s`, animationDelay: `${-(j % 7) * 1.3}s` });
    crowd.append(d);
  }
  for (const delay of [0, -3, -6]) { const r = document.createElement('i'); r.style.animationDelay = `${delay}s`; rings.append(r); }
  const roll = document.createElement('div'); roll.className = 'roll';
  for (let j = 0; j < 56; j++) { // 28 sample rows, twice, so the loop has no visible jump
    const h = (((j % 28) * 2654435761) >>> 0).toString(16).padStart(8, '0');
    const row = document.createElement('div'); row.className = 'row';
    for (const t of [String(3524300 + (j % 28) * 7), `${h}…${h.slice(0, 4)}`, j % 3 ? '✓ match' : '✓ sum', '•••• ZEC']) row.append(Object.assign(document.createElement('span'), { textContent: t }));
    roll.append(row);
  }
  ledger.append(roll);
  document.addEventListener('visibilitychange', () => box.classList.toggle('paused', document.hidden)); // no loops while the tab is hidden
}

function intro() {
  const box = $('#intro');
  if (location.hash === '#intro') { lsSet(INTRO_KEY, null); history.replaceState(null, '', location.pathname + location.search); }
  if (lsGet(INTRO_KEY)) return;
  box.hidden = false;
  document.documentElement.classList.add('with-intro');
  const scenes = [...box.querySelectorAll('.scene')];
  if (!motion() || !('IntersectionObserver' in window)) scenes.forEach((s) => s.classList.add('seen')); // reduced motion: the final state at once, no backgrounds
  else {
    sceneLayers(box);
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); } }, { threshold: 0.35 });
    scenes.forEach((s) => io.observe(s));
  }
  // reaching the list ends the intro for later visits
  const list = $('#live-card');
  if ('IntersectionObserver' in window) {
    const done = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { lsSet(INTRO_KEY, '1'); done.disconnect(); } }, { threshold: 0.15 });
    done.observe(list);
  } else lsSet(INTRO_KEY, '1');
}
function replayLink() {
  const r = document.getElementById('replay-intro');
  if (r) r.addEventListener('click', (e) => { e.preventDefault(); lsSet(INTRO_KEY, null); location.hash = 'intro'; location.reload(); });
}

// ---------- layout: 4 columns, 5 columns, list (desktop); 2, 3, list (phone) ----------
const CYCLE = { wide: { 4: '5', 5: 'list', list: '4' }, narrow: { 2: '3', 3: 'list', list: '2' } };
const ICON = { 2: '▦', 3: '⊞', 4: '▦', 5: '⊞', list: '☰' };
const NAME = { 2: '2 columns', 3: '3 columns', 4: '4 columns', 5: '5 columns', list: 'list' };
function currentView() {
  const v = lsGet(VIEW_KEY);
  if (narrow()) return ['2', '3', 'list'].includes(v) ? v : '2';
  return ['4', '5', 'list'].includes(v) ? v : '4';
}
function applyView() {
  const v = currentView(), live = $('#live'), btn = $('#layout-btn');
  live.classList.remove('v2', 'v3', 'v4', 'v5', 'vlist'); live.classList.add(`v${v}`);
  btn.textContent = ICON[v];
  const label = `Layout: ${NAME[v]}. Tap to change.`; btn.setAttribute('aria-label', label); btn.title = label;
}

// ---------- the cards ----------
const typeWord = (info) => (info && info.sealed ? 'Blind bid' : info && info.mode === 'auction' ? 'Auction' : 'Fundraiser');
const terms = (info) => {
  if (!info) return "Can't be read right now.";
  // a blind bid auction has no goal: its items and its fixed deposit sizes
  if (info.sealed) return `${info.items} ${info.items === 1 ? 'item' : 'items'} · deposits ${info.sealed.tranches.join(' / ')} ${info.ticker}`;
  if (info.mode === 'auction') return `${info.items} ${info.items === 1 ? 'item' : 'items'}${info.pricing === 'uniform' ? '' : ' · pay your bid'}`;
  // round 5: both caps as one label, the numbers on a second line in the grid (white-space: pre-line) and on the same line in the list
  return info.cap ? `Soft cap/Hard cap\n${info.goal}/${info.cap} ${info.ticker}` : `Goal ${info.goal} ${info.ticker}`;
};
/** The terms into an element: both cap numbers drawn as 8-decimal amounts (the text helper only reaches the number before the ticker). */
function setTerms(e, info) {
  // every deposit size drawn as an amount (the text helper only reaches the number before the ticker)
  if (info && info.sealed) {
    const t = info.sealed.tranches_zat;
    e.innerHTML = `${info.items} ${info.items === 1 ? 'item' : 'items'} · deposits ${t.map((z, i) => amountHTML(z, i === t.length - 1 ? info.ticker : '', info.network === 'main')).join(' / ')}`;
  } else if (info && info.mode === 'raise' && info.cap) e.innerHTML = `Soft cap/Hard cap\n${amountHTML(info.goal_zat, '', info.network === 'main')}/${amountHTML(info.cap_zat, info.ticker, info.network === 'main')}`;
  else e.textContent = terms(info);
  return e;
}
const nameOf = (item, info) => (info && info.name) || null;

function openCard(item, info) {
  const a = document.createElement('a');
  a.className = `card camp${info && info.network === 'test' ? ' test' : ''}`;
  if (info && info.network) a.dataset.net = info.network; // amounts on this card follow its own network (mainnet: trimmed)
  a.href = sibling('campaign', { id: item.id, relays: item.relays, endpoints: [], server: '' });
  const name = nameOf(item, info) || `${info ? typeWord(info) : 'Campaign'} ${item.id.slice(0, 8)}…`;
  a.dataset.search = `${name} ${item.id}`.toLowerCase();
  const el = (cls, text, tag = 'span') => { const e = document.createElement(tag); e.className = cls; if (text != null) e.textContent = text; return e; };
  // the top row (testnet tag and type on the left, time left on the right) wraps when the card is narrow; the list layout lays the parts out
  // on its own grid (start.css)
  const top = el('c-top', null), tl = el('c-tl', null);
  if (info && info.network === 'test') tl.append(el('tn-tag', 'TESTNET'));
  tl.append(el('c-type', info ? typeWord(info).toUpperCase() : 'CAMPAIGN'));
  const left = el('c-left status', info ? 'Open' : '');
  if (info) left.prepend(el('live-dot', null));
  top.append(tl, left);
  a.append(top, el('c-name', name, 'strong'), setTerms(el('c-terms', null), info), el('c-open', 'Open →'));
  a._parts = { left };
  return a;
}

function closedRow(item, info, entries) {
  const a = document.createElement('a');
  a.className = 'card crow';
  if (info && info.network) a.dataset.net = info.network;
  a.href = sibling('campaign', { id: item.id, relays: item.relays, endpoints: [], server: '' });
  const named = nameOf(item, info);
  const c1 = document.createElement('span'); c1.className = 'cr-name';
  if (named) c1.textContent = named;
  else { c1.append('Unnamed '); const id = document.createElement('span'); id.className = 'cr-id'; id.textContent = `${item.id.slice(0, 8)}…`; c1.append(id); }
  a.dataset.search = `${named || 'unnamed'} ${item.id}`.toLowerCase();
  const c2 = document.createElement('span'); c2.className = 'cr-kind'; const k = document.createElement('span'); k.className = 'kind'; k.textContent = typeWord(info); c2.append(k);
  const c3 = document.createElement('span'); c3.className = 'cr-terms'; setTerms(c3, info);
  const close = entries.find((e) => e.kind === 'close');
  const c4 = document.createElement('span'); c4.className = 'cr-out status';
  c4.append(Object.assign(document.createElement('span'), { className: 'odot' }), outcomeWords(close && close.close && close.close.outcome, !!(info && info.cap)));
  const c5 = document.createElement('span'); c5.className = 'cr-go'; c5.textContent = '→'; c5.setAttribute('aria-hidden', 'true');
  a.append(c1, c2, c3, c4, c5);
  return a;
}

/** "~6 days", "~16 h", "~40 min" from a number of blocks and the measured block time. */
function shortEta(blocks, spb) {
  if (!spb) return null;
  const s = blocks * spb;
  if (s < 90) return '<1 min';
  if (s < 5400) return `~${Math.round(s / 60)} min`;
  if (s < 172800) return `~${Math.round(s / 3600)} h`;
  return `~${Math.round(s / 86400)} days`;
}

function emptyCard(text) {
  const d = document.createElement('div'); d.className = 'empty-card';
  const t = document.createElement('p'); t.className = 'e-t'; t.textContent = text;
  const l = document.createElement('p'); l.className = 'e-l'; l.textContent = 'To try it with test money, open the testnet demo.';
  const b = document.createElement('div'); b.className = 'btns';
  const demo = document.createElement('a'); demo.className = 'demo-pill big'; demo.href = 'https://clewbook.xyz/demo/'; demo.textContent = 'Try the testnet demo →';
  const host = document.createElement('a'); host.className = 'btn neutral'; host.href = 'host.html'; host.textContent = 'Host a campaign';
  b.append(demo, host); d.append(t, l, b);
  return d;
}

// ---------- search, the network switch and paging ----------
let closedAll = false, net = 'main', listed = false;
const NET_WORD = { main: 'mainnet', test: 'testnet' };
function filter() {
  const q = $('#search').value.trim().toLowerCase();
  // a campaign whose rules could not be read, or on a private chain (only on a developer's computer), is shown on both sides rather than lost
  const onNet = (el) => !['main', 'test'].includes(el.dataset.net) || el.dataset.net === net;
  const match = (el) => onNet(el) && (!q || el.dataset.search.includes(q));
  const cards = [...document.querySelectorAll('#live .camp')];
  for (const c of cards) c.hidden = !match(c);
  const rows = [...document.querySelectorAll('#closed .crow')].filter((r) => { const ok = onNet(r); if (!ok) r.hidden = true; return ok; });
  const hits = rows.filter(match);
  rows.forEach((r) => { r.hidden = true; });
  hits.slice(0, closedAll ? hits.length : 6).forEach((r) => { r.hidden = false; });
  $('#closed-more').hidden = closedAll || hits.length <= 6;
  $('#closed-none').hidden = !rows.length || hits.length > 0;
  $('#closed-card').hidden = !rows.length;
  $('#closed-count').textContent = String(rows.length);
  // nothing open on this network: one plain card, as before for an empty list
  const old = $('#live .empty-card'); if (old) old.remove();
  const open = cards.filter(onNet).length;
  $('#live').classList.toggle('none', listed && !open);
  if (listed && !open) $('#live').append(emptyCard(`No ${NET_WORD[net]} campaign is open right now.`));
  $('#demo-under').hidden = net !== 'test';
}

async function main() {
  setup('Campaigns', { netbar: false });
  net = useNetFilter();
  addEventListener('cb-net', (e) => { net = e.detail; closedAll = false; filter(); });
  $('#demo-under').hidden = net !== 'test';
  intro(); replayLink();
  applyView();
  $('#layout-btn').addEventListener('click', () => { const v = currentView(); lsSet(VIEW_KEY, CYCLE[narrow() ? 'narrow' : 'wide'][v]); applyView(); });
  let wasNarrow = narrow();
  addEventListener('resize', () => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); applyView(); } });
  $('#search').addEventListener('input', filter);
  $('#closed-more').addEventListener('click', () => { closedAll = true; filter(); });

  let list = [];
  try {
    const r = await fetch('campaigns.json', { cache: 'no-store' });
    if (r.ok) list = ((await r.json()).campaigns || []).filter((c) => /^[0-9a-f]{64}$/.test(String(c.id || '')) && Array.isArray(c.relays) && c.relays.length);
  } catch { /* no list: said below */ }
  markReady();
  $('#loading').remove();
  if (!list.length) { $('#live').classList.add('none'); $('#live').append(emptyCard('No campaigns are listed yet.')); $('#demo-under').hidden = true; return; }
  try { await init(); } catch { $('#live').textContent = 'This page could not start. Please reload it.'; return; }
  const shown = [];
  await Promise.all(list.map(async (item) => {
    item.relays = item.relays.map((u) => String(u).replace(/\/$/, ''));
    const j = judge(await Promise.all(item.relays.map((u) => readRelay(u, item.id))));
    let info = null, closed = false;
    if (j.rules) { try { info = JSON.parse(W.campaign_summary(j.rules, item.id)); closed = j.entries.some((e) => e.kind === 'close'); } catch { info = null; } }
    shown.push({ item, info, closed, entries: j.entries, kind: j.kind });
  }));
  // The cards are drawn at once, from the relay's answer; the time left is filled in when a chain server has answered, so a slow chain server
  // never keeps the page empty. Main network campaigns come first, as before.
  const order = (s) => (s.info && s.info.network === 'main' ? 0 : 1);
  shown.sort((a, b) => order(a) - order(b));
  for (const s of shown) {
    const isClosed = !!(s.info && s.closed);
    s.el = isClosed ? closedRow(s.item, s.info, s.entries) : openCard(s.item, s.info);
    (isClosed ? $('#closed') : $('#live')).append(s.el);
  }
  listed = true;
  filter();
  decorateAmounts(document.querySelector('main'));
  // the chain height, once per network
  for (const n of new Set(shown.filter((s) => s.info && !s.closed).map((s) => s.info.network))) {
    (async () => {
      for (const e of DEFAULT_ENDPOINTS[n] || []) {
        const t = await tipOf(e, 8000);
        if (t == null) continue;
        const spb = await observedBlockSeconds([e], t, n);
        for (const s of shown.filter((x) => x.info && !x.closed && x.info.network === n)) {
          const left = s.el._parts.left;
          if (t > s.info.deadline_height) { left.replaceChildren('deadline passed'); left.classList.add('ended'); }
          else { const eta = shortEta(s.info.deadline_height - t, spb); left.replaceChildren(Object.assign(document.createElement('span'), { className: 'live-dot' }), eta || 'Open'); }
        }
        return;
      }
    })();
  }
}

main().catch(() => { const l = $('#live'); if (l) l.textContent = 'Something went wrong while loading this page. Please reload it.'; });
