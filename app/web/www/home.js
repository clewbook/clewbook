// The home page: lists the campaigns named in campaigns.json (kept by hand: a list of campaign numbers and the relays that hold them) and reads each one's
// rules and signed list from its relay, checked the way every other page checks them, to say whether it is open or closed. The file is only a list of
// where to look; everything shown about a campaign comes from the relay's checked answer. It never shows a raw error.
// Presentation (Halide, 31 Oct 2026): the site home (eight sections, shown on the first visit and from the logo), then the Live campaigns page: a
// search box, a layout button and the Mainnet | Testnet switch, cards for open campaigns and a table for closed ones.
import init, * as W from './pkg/ll_web.js';
import { setup, markReady, useNetFilter, ledgerPlane } from './ui.js';
import { readRelay, judge, tipOf, observedBlockSeconds, sibling, DEFAULT_ENDPOINTS } from './public.js';

const $ = (s) => document.querySelector(s);
const INTRO_KEY = 'cb-intro-seen', VIEW_KEY = 'cb-view';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* the page works without it */ } };
const narrow = () => innerWidth < 640;
const motion = () => !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---- site home (from the design prototype) ----
// ---------- the site home (README §5): eight sections shown one at a time with Prev, Next and Skip intro; it plays on the first visit, then the
// Live campaigns page is the home. The words, the sample figures and the motion are the prototype's; nothing here reads or claims real data. ----------
const SECS = ['hero', 'problem', 'recount', 'tickets', 'run', 'blind', 'who', 'cta'];
const SEC_LABEL = ['Start', 'The problem', 'Recount', 'Refund tickets', 'What you can run', 'Blind bid auctions', 'Who sees what', 'Get started'];
const SEC_ALIAS = { start: 'hero', intro: 'hero', go: 'cta', how: 'problem', use: 'run' }; // #use: the former "How to use it", now inside What you can run
let secNow = 'hero', siteTick = 0;
const secEl = (k) => document.querySelector(`#site [data-sec="${k}"]`);
function siteShow(k) {
  secNow = SECS.includes(k) ? k : 'hero';
  const site = $('#site'), home = $('main.home');
  site.hidden = false; if (home) home.hidden = true;
  document.documentElement.classList.add('on-site');
  const navc = document.querySelector('.nav a[href="./#campaigns"]'); if (navc) navc.removeAttribute('aria-current'); // the site home is no nav page
  for (const s of SECS) { const el = secEl(s); if (el) el.hidden = s !== secNow; }
  const i = SECS.indexOf(secNow), pager = site.querySelector('[data-act="next"]').parentElement;
  const bar = pager.children[1];
  bar.children[0].firstElementChild.textContent = `${String(i).padStart(2, '0')} / ${String(SECS.length - 1).padStart(2, '0')} · ${SEC_LABEL[i]}`;
  bar.children[1].firstElementChild.style.width = `${Math.round(i / (SECS.length - 1) * 100)}%`;
  site.querySelector('[data-act="prev"]').style.opacity = i === 0 ? '.4' : '1';
  site.querySelector('[data-act="next"]').style.opacity = i === SECS.length - 1 ? '.4' : '1';
  lsSet(INTRO_KEY, '1'); // the intro plays once; the next visit opens on the campaigns
}
function campaignsShow() {
  const site = $('#site'), home = $('main.home');
  if (site) site.hidden = true; if (home) home.hidden = false;
  document.documentElement.classList.remove('on-site');
  const navc = document.querySelector('.nav a[href="./#campaigns"]'); if (navc) navc.setAttribute('aria-current', 'page');
  lsSet(INTRO_KEY, '1');
}
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  const k = SEC_ALIAS[h] || h;
  if (h === 'campaigns' || h === 'live' || h === 'mainnet') return campaignsShow(); // #live, #mainnet: the removed Live on mainnet section; its old links open the campaigns
  if (SECS.includes(k)) return siteShow(k);
  if (!lsGet(INTRO_KEY)) return siteShow('hero');
  return campaignsShow();
}
function step(d) { const i = SECS.indexOf(secNow) + d; if (i < 0 || i >= SECS.length) return; location.hash = SECS[i] === 'hero' ? 'start' : SECS[i]; scrollTo(0, 0); }

// 05 blind bids: seven steps, played every three seconds (the prototype's 750 ms tick, every fourth one) until a step is picked
const BB = { dep: ['1', '0.5', '0.5', '0.3', '0.5', '0.3'], bids: [0.82, 0.47, 0.41, 0.26, 0.38, 0.22], tm: ['14:02', '14:09', '15:31', '16:10', '17:44', '18:03'] };
BB.rank = BB.bids.map((b) => BB.bids.filter((x) => x > b).length);
const BT = [['The host sets the rules', 'Items, a deadline, and a few fixed deposit sizes called tranches.'], ['You pick a deposit size', 'Your real bid travels inside the payment, locked with drand’s timelock.'], ['The host sees a sealed bid', 'That a bid came in, when, its deposit size and refund address. Never the bid.'], ['You hold two refund tickets', 'Early takes the deposit back any time before the deadline. Late takes it back after a wait if the host never settles.'], ['Bidding closes. Every bid opens.', 'Shortly after, drand publishes the key and anyone can open every bid at once.'], ['Winners settle, the rest are refunded', 'Losing bids become public after the close, so anyone can check the winner.'], ['Anyone runs Recount', 'It checks the winners, the price, the refunds and the tickets.']];
const CD = [['CLOSES IN', '~6 days'], ['CLOSES IN', '~6 days'], ['CLOSES IN', '~4 days'], ['CLOSES IN', '~2 days'], ['BIDDING', 'closed, bids open'], ['BIDDING', 'settled'], ['RECOUNT', '✓ checked']];
let bbStep = 1, bbPlay = true, bbParts = null;
function bbFind() {
  const sec = secEl('blind'); if (!sec) return null;
  const steps = sec.querySelector('[aria-label="Auction steps"]');
  const firstHost = [...sec.querySelectorAll('span')].find((s) => /^host sees/.test(s.textContent));
  const envs = [...firstHost.parentElement.parentElement.children];
  const big = [...sec.querySelectorAll('span')].find((s) => s.textContent === '04' && s.parentElement.tagName === 'DIV' && s.parentElement.children.length === 2);
  const info = big.parentElement.children[1];
  const leaf = (t) => [...sec.querySelectorAll('span')].find((s) => s.textContent === t && !s.firstElementChild);
  const cd = leaf('CLOSES IN').parentElement.parentElement;
  const prices = [...sec.querySelectorAll('[role="tablist"]')].find((t) => t !== steps);
  return { steps, play: steps.nextElementSibling, envs, big, title: info.children[0], line: info.children[1], tranche: info.children[2], cd, prices };
}
function bbRender() {
  const P = bbParts || (bbParts = bbFind()); if (!P) return;
  const s = bbStep;
  P.envs.forEach((w, i) => {
    const win = s >= 6 && BB.rank[i] < 2, [host, box, , chips] = w.children, [body, flap, seal] = box.children, res = chips.children[2];
    w.style.opacity = s >= 2 ? '1' : '0'; w.style.transform = s >= 2 ? 'none' : 'translateY(-30px) rotate(-6deg)';
    host.firstElementChild.textContent = s >= 3 && s < 5 ? `host sees ${BB.tm[i]}` : (win ? 'winner' : ''); host.style.opacity = (s >= 3 && s < 5) || win ? '1' : '0';
    flap.style.transform = s >= 5 ? 'rotateX(180deg)' : 'rotateX(0deg)'; seal.style.opacity = s >= 5 ? '0' : '1';
    body.style.borderColor = win ? 'var(--pass)' : (s === 3 ? 'var(--accT)' : 'var(--line2)');
    const bid = body.firstElementChild; bid.firstElementChild.textContent = BB.bids[i].toFixed(2); bid.style.opacity = s >= 5 ? '1' : '0'; bid.style.color = win ? 'var(--pass)' : 'var(--ink)';
    chips.style.opacity = s >= 4 ? '1' : '0';
    chips.children[0].style.display = chips.children[1].style.display = s >= 4 && s < 6 ? 'inline-flex' : 'none';
    res.style.display = s >= 6 ? 'inline-flex' : 'none'; res.firstElementChild.textContent = win ? 'WON' : 'REFUNDED';
    res.style.background = win ? 'var(--pass)' : 'var(--line)'; res.style.color = win ? 'var(--bg)' : 'var(--ink)';
  });
  P.big.firstElementChild ? (P.big.firstElementChild.textContent = `0${s}`) : (P.big.textContent = `0${s}`);
  P.title.firstElementChild.textContent = BT[s - 1][0]; P.line.firstElementChild.textContent = BT[s - 1][1];
  P.tranche.style.display = s === 1 ? 'flex' : 'none';
  P.cd.children[0].firstElementChild.textContent = CD[s - 1][0]; P.cd.children[1].firstElementChild.textContent = CD[s - 1][1]; P.cd.children[1].style.color = s >= 5 ? 'var(--pass)' : 'var(--ink)';
  [...P.steps.children].forEach((b, k) => {
    const i = k + 1, on = i === s;
    b.setAttribute('aria-selected', String(on)); b.style.background = on ? 'var(--acc)' : 'transparent'; b.style.color = on ? 'var(--aink)' : i < s ? 'var(--ink)' : 'var(--mut)'; b.style.borderColor = on ? 'var(--acc)' : 'var(--line2)';
  });
  P.play.firstElementChild.textContent = bbPlay ? '❚❚ Pause' : '▶ Play';
}
let price = 'uniform';
function priceRender() {
  const P = bbParts || (bbParts = bbFind()); if (!P) return;
  const [u, pyb] = P.prices.children;
  for (const [b, on] of [[u, price === 'uniform'], [pyb, price === 'pyb']]) { b.setAttribute('aria-selected', String(on)); b.style.background = on ? 'var(--ink)' : 'transparent'; b.style.color = on ? 'var(--bg)' : 'var(--ink)'; b.style.borderColor = on ? 'var(--ink)' : 'var(--line2)'; }
  const line = P.prices.nextElementSibling, grid = line.nextElementSibling;
  line.firstElementChild.textContent = price === 'pyb' ? 'Each winner pays what they bid.' : 'Every winner pays the same price: the lowest winning bid, at least the reserve.';
  grid.children[0].children[1].firstElementChild.textContent = price === 'pyb' ? '0.82 ZEC' : '0.47 ZEC';
  grid.children[1].children[1].firstElementChild.textContent = '0.47 ZEC';
}

// 02 recount: a sample report that reads nine checks in turn (170 ms each); three samples: honest, cheating, limited
const R0 = [['R1', 'Rules', 'The rules shown are the ones the campaign committed to.'], ['R2', 'List integrity', 'Signed, in order, nothing removed.'], ['R3', 'Entries real', 'Every entry is a real payment to the campaign.'], ['R4', 'Tickets issued', 'Every contribution got its refund ticket.'], ['R4b', 'Ticket timing', 'Each ticket came in time, by the host’s record.'], ['R5', 'No early spend', 'No contribution was spent early.'], ['R6', 'Refunds by ticket', 'Money not kept left only as refunds.'], ['R7', 'Outcome', 'The declared result is what the rules give.'], ['R8', 'Rejects justified', 'Every set aside payment has a reason.']];
let rcMode = 'pass', rcRun = 9, rcTimer = 0, rcParts = null;
function rcFind() {
  const sec = secEl('recount'); if (!sec) return null;
  const tabs = sec.querySelector('[aria-label="Sample report"]');
  const verdict = tabs.parentElement.nextElementSibling, rows = verdict.nextElementSibling;
  // the note itself (no child elements): its card around it holds the same words, and hiding the card left the column empty
  const note = [...sec.querySelectorAll('span, div, p')].find((e) => /relays reachable/.test(e.textContent) && !e.children.length);
  return { tabs, again: tabs.nextElementSibling, verdict, rows: [...rows.children], note };
}
function rcRender() {
  const P = rcParts || (rcParts = rcFind()); if (!P) return;
  const run = rcRun < 9;
  [...P.tabs.children].forEach((b, k) => { const on = ['pass', 'fail', 'limited'][k] === rcMode; b.setAttribute('aria-selected', String(on)); b.style.background = on ? 'var(--ink)' : 'transparent'; b.style.color = on ? 'var(--bg)' : 'var(--ink)'; b.style.borderColor = on ? 'var(--ink)' : 'var(--line2)'; });
  P.rows.forEach((row, i) => {
    const r = R0[i], done = i < rcRun, fail = rcMode === 'fail' && r[0] === 'R5', lim = rcMode === 'limited' && (r[0] === 'R4b' || r[0] === 'R8');
    const [, txt, chip] = row.children, line = txt.children[1];
    line.firstElementChild.textContent = fail && done ? 'A ticketed payment was spent before the deadline · tx 3f9a…c21e' : (lim && done ? 'Could not run this time.' : r[2]);
    line.style.color = fail && done ? 'var(--fail)' : 'var(--mut)'; row.style.opacity = done ? '1' : '.35';
    chip.firstElementChild.textContent = !done ? (i === rcRun ? '… READING' : 'WAIT') : fail ? '✕ FAIL' : lim ? '◐ LIMITED' : '✓ PASS';
    chip.style.background = !done ? 'transparent' : fail ? 'var(--fail)' : lim ? 'var(--line)' : 'transparent';
    chip.style.color = !done ? 'var(--mut)' : fail ? 'var(--bg)' : lim ? 'var(--ink)' : 'var(--pass)';
  });
  const rv = run ? { chip: '○ RECOUNTING', title: 'Reading the ledger', line: `Check ${Math.min(9, rcRun + 1)} of 9, against the Zcash chain.`, big: `${rcRun} / 9`, bg: 'var(--bg2)', ink: 'var(--ink)', note: 'none' }
    : rcMode === 'fail' ? { chip: '✕ FAIL', title: 'Some checks fail', line: 'A cheating host. The failing check names the transaction.', big: '8 of 9', bg: 'var(--fail)', ink: 'var(--bg)', note: 'none' }
    : rcMode === 'limited' ? { chip: '◐ LIMITED', title: 'Some checks could not run', line: 'The rest pass. Grey checks could not run this time.', big: '7 of 9', bg: 'var(--line)', ink: 'var(--ink)', note: 'block' }
    : { chip: '✓ PASS', title: 'All checks pass', line: 'An honest host. The ledger matches the chain.', big: '9 of 9', bg: 'var(--pass)', ink: 'var(--bg)', note: 'none' };
  const [left, big] = P.verdict.children;
  P.verdict.style.background = rv.bg; P.verdict.style.color = rv.ink;
  left.children[0].firstElementChild.textContent = rv.chip; left.children[1].firstElementChild.textContent = rv.title; left.children[2].firstElementChild.textContent = rv.line;
  big.firstElementChild.textContent = rv.big;
  if (P.note) P.note.style.display = rv.note;
}
function runSiteRc() {
  clearInterval(rcTimer);
  if (!motion()) { rcRun = 9; rcRender(); return; }
  rcRun = 0; rcRender();
  rcTimer = setInterval(() => { rcRun += 1; rcRender(); if (rcRun >= 9) clearInterval(rcTimer); }, 170);
}

// 03 refund tickets: "Check this ticket" runs twelve sample checks (140 ms each); a sample, nothing is read
let tk = { st: 'idle', n: 0 }, tkTimer = 0, tkParts = null;
function tkFind() {
  const sec = secEl('tickets'); if (!sec) return null;
  const btn = [...sec.querySelectorAll('button')].find((b) => /Check this ticket/.test(b.textContent));
  const stub = [...sec.querySelectorAll('span')].find((s) => s.textContent === 'NOT CHECKED YET' && !s.firstElementChild).parentElement.parentElement;
  return { btn, n: btn.nextElementSibling, bar: btn.parentElement.nextElementSibling.firstElementChild, mark: stub.children[0], chip: stub.children[1] };
}
function tkRender() {
  const P = tkParts || (tkParts = tkFind()); if (!P) return;
  const v = tk.st === 'checking' ? { mark: '…', chip: 'CHECKING', ink: 'var(--warn)', btn: 'Checking…', n: `${tk.n} of 12 checks`, w: `${Math.round(tk.n / 12 * 100)}%` }
    : tk.st === 'ok' ? { mark: '✓', chip: 'CHECKED · 12 OF 12', ink: 'var(--pass)', btn: 'Check again', n: 'The ticket checks out. Sample.', w: '100%' }
    : { mark: '○', chip: 'NOT CHECKED YET', ink: 'var(--mut)', btn: 'Check this ticket', n: '12 checks, in your browser', w: '0%' };
  P.mark.firstElementChild.textContent = v.mark; P.chip.firstElementChild.textContent = v.chip; P.mark.style.color = P.chip.style.color = v.ink;
  P.btn.firstElementChild.textContent = v.btn; P.n.firstElementChild.textContent = v.n; P.bar.style.width = v.w;
}
function tkCheck() {
  if (tk.st === 'checking') return;
  if (tk.st === 'ok') { tk = { st: 'idle', n: 0 }; tkRender(); return; }
  clearInterval(tkTimer); tk = { st: 'checking', n: 0 }; tkRender();
  tkTimer = setInterval(() => { tk.n += 1; if (tk.n >= 12) { clearInterval(tkTimer); tk = { st: 'ok', n: 12 }; } tkRender(); }, 140);
}

// the ledger rows of the hero (the prototype's tilted plane): ui.js ledgerPlane tilts it toward the pointer and lights the rows
function heroRows() {
  const sec = secEl('hero'); if (!sec) return [];
  const first = [...sec.querySelectorAll('span')].find((s) => s.textContent === '#001 payment');
  return first ? [...first.parentElement.parentElement.children].filter((r) => r.children.length === 4 && /^#0/.test(r.children[0].textContent)) : [];
}

function siteSetup() {
  const site = $('#site'); if (!site) return;
  site.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (a) { const act = a.dataset.act; if (act === 'prev') step(-1); else if (act === 'next') step(1); else if (act === 'skip') { lsSet(INTRO_KEY, '1'); location.hash = 'campaigns'; scrollTo(0, 0); } return; }
    const P = bbParts || (bbParts = bbFind());
    const tab = e.target.closest('[role="tab"]');
    if (P && tab && tab.parentElement === P.steps) { bbStep = [...P.steps.children].indexOf(tab) + 1; bbPlay = false; bbRender(); return; }
    if (P && tab && tab.parentElement === P.prices) { price = tab === P.prices.children[0] ? 'uniform' : 'pyb'; priceRender(); return; }
    if (P && e.target.closest('button') === P.play) { bbPlay = !bbPlay; bbRender(); return; }
    const R = rcParts || (rcParts = rcFind());
    if (R && tab && tab.parentElement === R.tabs) { rcMode = ['pass', 'fail', 'limited'][[...R.tabs.children].indexOf(tab)]; runSiteRc(); return; }
    if (R && e.target.closest('button') === R.again) { runSiteRc(); return; }
    const T = tkParts || (tkParts = tkFind());
    if (T && e.target.closest('button') === T.btn) tkCheck();
  });
  addEventListener('keydown', (e) => {
    if ($('#site').hidden || /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
    if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1);
  });
  addEventListener('hashchange', route);
  bbRender(); priceRender(); rcRender(); tkRender();
  const hero = secEl('hero'); if (hero) ledgerPlane(hero, hero.querySelector('.s0x2'), heroRows());
  if (motion()) setInterval(() => {
    if ($('#site').hidden || document.hidden) return;
    siteTick += 1;
    if (bbPlay && siteTick % 4 === 0) { bbStep = bbStep % 7 + 1; bbRender(); }
  }, 750);
  route();
}

// ---- /site home ----
// ---------- layout (README §6): 4×4 → 5×5 → List on a wide screen, 2 → 3 → List on a phone, kept in this browser (cb-view) ----------
const CYCLE = { wide: { 4: '5', 5: 'list', list: '4' }, narrow: { 2: '3', 3: 'list', list: '2' } };
const ICON = { 2: '▦', 3: '▦', 4: '▦', 5: '▦', list: '☰' };
const NAME = { 2: '2 columns', 3: '3 columns', 4: '4×4', 5: '5×5', list: 'List' };
function currentView() {
  const v = lsGet(VIEW_KEY);
  if (narrow()) return ['2', '3', 'list'].includes(v) ? v : '2';
  return ['4', '5', 'list'].includes(v === 'grid' ? '4' : v) ? (v === 'grid' ? '4' : v) : '4'; // "grid" (the earlier pages' word) is 4×4
}
function applyView() {
  const v = currentView(), live = $('#live'), btn = $('#layout-btn');
  live.classList.remove('v2', 'v3', 'v4', 'v5', 'vlist'); live.classList.add(`v${v}`);
  btn.querySelector('span span').textContent = ICON[v];
  btn.setAttribute('aria-label', `Change layout, now ${NAME[v]}`);
  if (shownAll) draw();
}

// ---------- the cards, the list rows and the closed table: the prototype's own parts (<template>s in index.html), filled with real data ----------
const typeWord = (info) => (info && info.sealed ? 'Blind bid' : info && info.mode === 'auction' ? 'Auction' : 'Fundraiser');
const kindOf = (info) => (!info ? 'raise' : info.sealed ? 'blind' : info.mode === 'auction' ? 'auction' : info.cap ? 'cap' : 'raise');
const nameOf = (item, info) => (info && info.name) || null;
const ZAT = 1e8;
const coinTxt = (zat) => { const f = String(zat % ZAT).padStart(8, '0').replace(/0+$/, ''); return `${Math.floor(zat / ZAT)}${f ? '.' + f : ''}`; };
const raisedOf = (entries) => entries.filter((e) => e.kind === 'issue').reduce((t, e) => t + (e.contribution && e.contribution.value_zat != null ? e.contribution.value_zat : 0), 0);
const fromT = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);
/** The campaign's name as the prototype sets it: its own name, or the type and the short id (the id not in capitals). */
function setName(el, item, info) {
  const named = nameOf(item, info);
  if (named) { el.textContent = named; return; }
  el.replaceChildren(`${info ? typeWord(info) : 'Campaign'} `, Object.assign(document.createElement('span'), { textContent: `${item.id.slice(0, 8)}…` }));
  el.lastChild.style.textTransform = 'none';
}
function ctaOf(a, s) {
  a.href = sibling('contribute', { id: s.item.id, relays: s.item.relays, endpoints: [], server: '' });
  a.firstElementChild.textContent = s.info && (s.info.sealed || s.info.mode === 'auction') ? 'Bid' : 'Contribute';
}
function card(s, list) {
  const { item, info, entries } = s, k = kindOf(info), el = fromT(`t-${list ? 'row' : 'card'}-${k}`);
  el.classList.add('lc-camp'); el.dataset.search = `${nameOf(item, info) || typeWord(info)} ${item.id}`.toLowerCase();
  if (info && info.network) el.dataset.net = info.network;
  const t = info ? info.ticker : '';
  const raised = raisedOf(entries);
  if (!list) {
    const [top, body] = [...el.children].slice(4);
    s.parts = { no: top.children[0], left: top.children[1] };
    body.children[0].textContent = info ? (info.mode === 'auction' && !info.sealed ? `Auction · ${info.items} ${info.items === 1 ? 'item' : 'items'}` : typeWord(info)) : 'Campaign';
    setName(body.children[1], item, info);
    const [tk, tv] = body.children[2].children, [fig, fu] = body.children[3].children;
    if (k === 'blind') { tk.textContent = 'Bids open'; tv.textContent = 'at the close'; fig.textContent = info.sealed.tranches.join(' · '); fu.textContent = `${t} deposit sizes`; }
    else if (k === 'auction') { tk.textContent = 'Reserve'; tv.textContent = info.pricing === 'uniform' ? `${info.reserve} ${t}` : 'none'; fig.textContent = String(entries.filter((e) => e.kind === 'issue').length); fu.textContent = 'entries'; }
    else {
      if (k === 'cap') { tk.textContent = 'Soft cap/Hard cap'; tv.textContent = `${info.goal}/${info.cap} ${t}`; } else { tk.textContent = 'Goal'; tv.textContent = info ? `${info.goal} ${t}` : '·'; }
      fig.textContent = coinTxt(raised); fu.textContent = `${t} raised`;
      // the meter: raised against the goal (with a hard cap, against the hard cap, as the prototype's 42% of 0.5)
      const of = info ? (k === 'cap' ? info.cap_zat : info.goal_zat) : 0, pct = of ? Math.min(100, Math.round(raised / of * 100)) : 0;
      const meter = body.children[4], track = meter.children[0];
      track.children[1].style.width = `${pct}%`; track.lastElementChild.style.left = `calc(${pct}% - 4px)`;
      meter.children[1].children[0].textContent = `${pct}%`;
    }
    ctaOf(body.lastElementChild.querySelector('[data-f="cta"]'), s);
  } else {
    const [lead, left, fig, go] = el.children;
    s.parts = { no: lead.children[0], left: left.children[0] };
    setName(lead.children[1].children[0], item, info);
    lead.children[1].children[1].textContent = typeWord(info);
    const [fv, fl] = fig.children;
    if (k === 'blind') { fv.textContent = info.sealed.tranches.join(' · '); fl.textContent = `${t} deposit sizes`; }
    else if (k === 'auction') { fv.textContent = String(entries.filter((e) => e.kind === 'issue').length); fl.textContent = 'entries'; }
    else { fv.textContent = coinTxt(raised); fl.textContent = `${t} raised`; }
    ctaOf(go.querySelector('[data-f="cta"]'), s);
  }
  paintLeft(s);
  return el;
}
/** Time left, filled once a chain server has answered (the cards never wait for it). */
function paintLeft(s) {
  const left = s.parts && s.parts.left; if (!left) return;
  const dot = left.firstElementChild;
  left.replaceChildren(dot, s.leftText || 'Open');
  left.style.color = dot.style.background = s.ended ? 'var(--mut)' : 'var(--pass)';
}
// the result in the closed table, in the short words of the prototype's table (owner, 31 Oct 2026: the real outcome, never "Failed")
const RESULT_WORD = { goal_met: 'Goal met', goal_missed: 'Goal missed', cancelled: 'Cancelled, everyone refunded', auction: 'Settled', sealed_auction: 'Settled', void: 'Void, all deposits back' };
const RESULT = (info, entries) => {
  const c = entries.find((e) => e.kind === 'close'), o = c && c.close && c.close.outcome;
  const w = RESULT_WORD[o] || 'Closed'; return info && info.cap ? w.replace('Goal', 'Soft cap') : w;
};
function closedRow(s) {
  const { item, info, entries } = s, el = fromT('t-closed-row');
  el.classList.add('lc-crow'); el.href = sibling('campaign', { id: item.id, relays: item.relays, endpoints: [], server: '' });
  el.dataset.search = `${nameOf(item, info) || typeWord(info)} ${item.id}`.toLowerCase();
  if (info && info.network) el.dataset.net = info.network;
  const close = entries.find((e) => e.kind === 'close'), h = close && close.close ? close.close.close_height : null;
  const [c1, c2, c3, c4, c5] = el.children, res = RESULT(info, entries), blk = h != null ? h.toLocaleString('en-US') : '·';
  setName(c1.children[0], item, info);
  c1.children[1].textContent = `${typeWord(info)} · ${res} · block ${blk}`;
  c2.textContent = typeWord(info); c3.textContent = res; c4.textContent = blk;
  // an auction has no amount raised (owner, 31 Oct 2026): a plain dash in the Raised column, never the fundraiser total
  c5.textContent = info && (info.sealed || info.mode === 'auction') ? '–' : coinTxt(raisedOf(entries));
  return el;
}
function emptyCard() {
  const el = fromT('t-empty'), b = el.querySelector('button');
  const a = document.createElement('a'); for (const at of b.attributes) a.setAttribute(at.name, at.value); a.removeAttribute('type'); a.href = 'host.html'; a.append(...b.childNodes);
  b.replaceWith(a); el.classList.add('lc-empty');
  return el;
}

// ---------- search, the network switch and paging ----------
let closedAll = false, closedOpen = true, net = 'main', listed = false, shownAll = null;
function draw() {
  const live = $('#live'), list = currentView() === 'list';
  live.replaceChildren();
  for (const s of shownAll.filter((x) => !(x.info && x.closed))) { s.el = card(s, list); live.append(s.el); }
  filter();
}
function filter() {
  const q = $('#search').value.trim().toLowerCase();
  // a campaign whose rules could not be read, or on a private chain (only on a developer's computer), is shown on both sides rather than lost
  const onNet = (el) => !['main', 'test'].includes(el.dataset.net) || el.dataset.net === net;
  const match = (el) => onNet(el) && (!q || el.dataset.search.includes(q));
  const cards = [...document.querySelectorAll('#live .lc-camp')];
  let n = 0;
  for (const c of cards) { c.hidden = !match(c); if (!c.hidden && shownAll) { const s = shownAll.find((x) => x.el === c); if (s && s.parts) s.parts.no.textContent = `No. ${String(++n).padStart(2, '0')}`; } }
  const rows = [...document.querySelectorAll('#closed .lc-crow')].filter((r) => { const ok = onNet(r); if (!ok) r.hidden = true; return ok; });
  const hits = rows.filter(match);
  rows.forEach((r) => { r.hidden = true; });
  hits.slice(0, closedAll ? hits.length : 5).forEach((r) => { r.hidden = false; });
  $('#closed-more').hidden = closedAll || hits.length <= 5;
  $('#closed-none').hidden = !rows.length || hits.length > 0;
  $('#closed-card').hidden = !rows.length;
  const head = $('#closed-table').firstElementChild; head.lastElementChild.textContent = `Raised ${net === 'test' ? 'TAZ' : 'ZEC'}`;
  // nothing open on this network: the prototype's empty card
  const old = $('#live .lc-empty'); if (old) old.remove();
  const open = cards.filter(onNet).length;
  $('#live').classList.toggle('none', listed && !open);
  if (listed && !open) $('#live').append(emptyCard());
}

async function main() {
  setup('Campaigns');
  net = useNetFilter();
  addEventListener('cb-net', (e) => { net = e.detail; closedAll = false; filter(); });
  siteSetup();
  applyView();
  $('#layout-btn').addEventListener('click', () => { const v = currentView(); lsSet(VIEW_KEY, CYCLE[narrow() ? 'narrow' : 'wide'][v]); applyView(); });
  let wasNarrow = narrow();
  addEventListener('resize', () => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); applyView(); } });
  $('#search').addEventListener('input', filter);
  $('#closed-more').addEventListener('click', () => { closedAll = true; filter(); });
  const tog = $('#closed-toggle');
  tog.parentElement.style.cursor = 'pointer'; tog.parentElement.setAttribute('role', 'button'); tog.parentElement.tabIndex = 0;
  const flip = () => { closedOpen = !closedOpen; $('#closed-table').hidden = !closedOpen; tog.textContent = closedOpen ? '▾ Hide' : '▸ Show'; tog.parentElement.setAttribute('aria-expanded', String(closedOpen)); };
  tog.parentElement.addEventListener('click', flip);
  tog.parentElement.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });

  let list = [];
  try {
    const r = await fetch('campaigns.json', { cache: 'no-store' });
    if (r.ok) list = ((await r.json()).campaigns || []).filter((c) => /^[0-9a-f]{64}$/.test(String(c.id || '')) && Array.isArray(c.relays) && c.relays.length);
  } catch { /* no list: said below */ }
  markReady();
  $('#loading').remove();
  if (!list.length) { $('#live').classList.add('none'); $('#live').append(emptyCard()); return; }
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
  shownAll = shown;
  // closed campaigns newest first (by the block they closed at), so "Show older" means older; the relays answer in any order
  const closedAt = (s) => { const c = s.entries.find((e) => e.kind === 'close'); return c && c.close ? c.close.close_height : -1; };
  for (const s of shown.filter((x) => x.info && x.closed).sort((a, b) => closedAt(b) - closedAt(a))) { s.row = closedRow(s); $('#closed').append(s.row); }
  listed = true;
  draw();
  // the chain height, once per network
  for (const n of new Set(shown.filter((s) => s.info && !s.closed).map((s) => s.info.network))) {
    (async () => {
      for (const e of DEFAULT_ENDPOINTS[n] || []) {
        const t = await tipOf(e, 8000);
        if (t == null) continue;
        const spb = await observedBlockSeconds([e], t, n);
        for (const s of shown.filter((x) => x.info && !x.closed && x.info.network === n)) {
          if (t > s.info.deadline_height) { s.leftText = 'deadline passed'; s.ended = true; } else s.leftText = shortEta(s.info.deadline_height - t, spb) || 'Open';
          paintLeft(s);
        }
        return;
      }
    })();
  }
}

/** "~6 days", "~9 hours", "~2h 05m", "~40 min" from a number of blocks and the measured block time (the prototype's forms). */
function shortEta(blocks, spb) {
  if (!spb) return null;
  const s = blocks * spb;
  if (s < 90) return '<1 min';
  if (s < 3600) return `~${Math.round(s / 60)} min`;
  if (s < 10800) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return `~${h}h ${String(m).padStart(2, '0')}m`; }
  if (s < 172800) return `~${Math.round(s / 3600)} hours`;
  return `~${Math.round(s / 86400)} days`;
}

main().catch((e) => { console.error(e); const l = $('#live'); if (l) l.textContent = 'Something went wrong while loading this page. Please reload it.'; });
