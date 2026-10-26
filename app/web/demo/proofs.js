// The demo's "Tested milestones" page (design round 14, handoff "testnet demo"): the thirteen finished test campaigns, the result chips (All, Passed,
// Failed), the type segment (All, Fundraisers, Auctions, Sealed bids), list or grid (kept in this browser as cb-proofs-view). Copied by
// make-static.sh to proofs/examples.js. The links are built as before, plus a marker and the selection, so the page opened can come back here.
document.documentElement.dataset.started = "1"; document.documentElement.dataset.ready = "1";
const items = [ // [title, one sentence, campaign id, type, expected result, pass or fail]
  ['Uniform price auction', 'A finished auction: every winner pays the same price, the lowest winning bid.', '5eda2e8a7cff9e282c4ca67d1938ea85535f9df40349e73c1ceb8864a26431eb', 'Auction', '✓ Expect: all 13 checks pass', 'pass'],
  ['Closed and refunded', 'A fundraiser that closed and refunded every contribution by its own ticket.', '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f', 'Fundraiser', '✓ Expect: all 9 checks pass', 'pass'],
  ['40 contributions', 'A busy fundraiser: forty contributions, each with its own refund ticket.', '47751309982e515bfb23989030eeac353ccfdc2bda0a0bed56ff2d943c5605da', 'Fundraiser', '✓ Expect: all 9 checks pass', 'pass'],
  ['With a name', 'A fundraiser with a name chosen by its host, closed and refunded.', 'f6737fbc462e75508d424f0612a1ce5ea3df24c5cc1b550074821ccdea5e237a', 'Fundraiser', '✓ Expect: all 9 checks pass', 'pass'],
  ['Late settlement', 'A test fixture where the winners were settled after the deadline.', '32ea71afc470d77909a1b7b4a1fdaba36f0612df3a973df0ce1410c5ca16467a', 'Auction', '✕ Expect: R9 fails', 'fail'],
  ['6 bids for 3 items', 'Two winners get their excess back, a tie goes to the earlier bid, one bid was taken back, one was too low.', 'f8b2bc9f0b9e17666b8b87dd0eeb0b19a17ab8e95d154d63ff1b8d2849980501', 'Auction', '✓ Expect: all 13 checks pass', 'pass'],
  ['Caught', 'A host that spent two contributions itself, one before the deadline and one after.', '3c34b9ff18656a9fad2e81ea91e803320917eced570ba5f69dde1a10dbba4004', 'Fundraiser', '✕ Expect: R5 and R6 fail', 'fail'],
  ['Late host', 'The same auction with the host offline for a while, so one ticket came one block late.', '65f3dd513ee88895804f2135a947ee9ac2e1b5d85b405e3d10c10168324b7ac6', 'Auction', '✕ Expect: R4b fails', 'fail'],
  ['Odd payments', '19 hand made odd payments: the host rejects or ignores each, and nothing blocks the close.', '80fc0eb3081ac58d91ac95fec1fe92286c49d000d5bdd24befe5c53153ed025d', 'Fundraiser', '✓ Expect: all 9 checks pass', 'pass'],
  ['Closed early', 'Goal met, closed 196 blocks early as its rules allow. A later payment does not count.', 'd119ba4b6b032cacf5d5838eef8aa9ec5903a224b9c6d9f6cca9362f70d49671', 'Fundraiser', '✓ Expect: all 9 checks pass', 'pass'],
  ['Caught', 'A host that closed early when the rules do not allow it.', '36a5178294cc8643929b654ea4f25df1dad7145527a311848dd5f526430d5897', 'Fundraiser', '✕ Expect: R2 and R5 fail', 'fail'],
  ['Hard cap', 'Soft cap 0.002, hard cap 0.004 TAZ. Three payments of 0.0015: the third did not fit and was refunded whole.', '0e87fe135cb3dd2486efa0809534718bf62ebd3df733d903008550c4c202aef5', 'Fundraiser', '✓ Expect: all 9 checks pass', 'pass'],
  ['Caught', 'A host that kept a payment over the hard cap instead of refunding it.', 'bc66ccca21ec5a3059e03326ec7abbf54fa55c45102a6037cf27f600273addb1', 'Fundraiser', '✕ Expect: R6 fails', 'fail'],
];
// Sealed bid auctions (SPEC §9): their own tab, prepared and hidden. Filled with the testnet sealed auctions once the owner says "ship" and
// they have run (with their lists in the demo's relays); while this list is empty the tab stays hidden and the page is as before.
const SEALED = [ // blind bid auctions on the test network, on their own test site (app-test, relay-test)
  ['Blind bids, uniform price', 'Three blind bids for two items, opened only after bidding closed: the two highest win and each pays the lowest winning bid, 0.00018 TAZ.', '4bbdc3d44705c615ca2d6de3338312685bc19376222817154a94d8cd70cdf6e5', 'Blind bid auction', '✓ Expect: all 10 checks pass', 'pass', 1],
  ['Blind bids, second price', 'The same three bids: the two highest win and each pays the highest losing bid, 0.00012 TAZ.', 'c74cd5cac444019cb4ced354fb7023ff1d8c20e5ae18175aa50538781b5dbc5b', 'Blind bid auction', '✓ Expect: all 10 checks pass', 'pass', 1],
  ['Blind bids, pay your bid', 'The same three bids: each winner pays their own bid, 0.0008 and 0.00018 TAZ.', 'f7fb6f3cc771b74c8e26ac98f0722e7839cdcf1c7ba49cb32646ceea167760d8', 'Blind bid auction', '✓ Expect: all 10 checks pass', 'pass', 1],
  ['Host never closed', 'The host never opened the bids: after the late ticket block everyone took their deposit back with their own late ticket.', '18ef5077cc4a06beaf84b691bd26e9643b5c6ca2ff8819992ab5c997757afb51', 'Blind bid auction', '✕ Expect: the host did not finish', 'fail', 1],
];
items.push(...SEALED);
if (SEALED.length) { const b = document.querySelector('#seg-sealed'); if (b) b.hidden = false; }
// the demo folder is the one that holds proofs/ (at the site's root on a plain static host, under /demo/ on the page server)
const base = `${location.origin}${location.pathname.replace(/proofs(\/(index\.html)?)?$/, '')}`;
const q = (id) => `c=${id}&relay=${base}relays/a&relay=${base}relays/b`;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const VIEW_KEY = 'cb-proofs-view';
// the selection travels in the links (#from=proofs&mt=<type>&mr=<result>) so a page opened from here can come back to it (#mt, #mr, #at)
const TYPE_CODE = { all: 'all', Fundraiser: 'raise', Auction: 'auction', 'Blind bid auction': 'sealed' };
const CODE_TYPE = Object.fromEntries(Object.entries(TYPE_CODE).map(([k, v]) => [v, k]));
const back = new URLSearchParams(location.hash.slice(1));
let res = ['all', 'pass', 'fail'].includes(back.get('mr')) ? back.get('mr') : 'all', type = CODE_TYPE[back.get('mt')] || 'all', view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } })();

// a sealed bid auction lives on its own test site, with its own relay
const TEST_SITE = 'https://app-test.clewbook.xyz/', TEST_RELAY = 'https://relay-test.clewbook.xyz';
function actions(id, onTest) {
  const box = el('div', 'pacts');
  const mark = `&from=proofs&mt=${TYPE_CODE[type]}&mr=${res}`;
  for (const [name, page, cls] of [['↻ Recount', 'recount', 'prc'], ['Campaign', 'campaign', 'plk'], ['Capability card', 'card', 'plk']]) { const a = el('a', cls, name); a.href = `${onTest ? `${TEST_SITE}${page}.html#c=${id}&relay=${TEST_RELAY}` : `${base}${page}.html#${q(id)}`}${page === 'recount' && UPTO[id] ? `&upto=${UPTO[id]}` : ''}${mark}`; box.append(a); }
  return box;
}
// finished campaigns checked at a fixed block, so their recount reads only a few hundred blocks (seconds, not minutes); each block is after
// the campaign's last event on the chain, and the result there is the same as up to today (checked on 26 Oct 2026). The page links to the
// check up to today.
const UPTO = { '48b3137b7bf59e4cb15f9c3c4b637b7caaa205ebf4ad92f5ed1b0e152133615f': 4477500, '3c34b9ff18656a9fad2e81ea91e803320917eced570ba5f69dde1a10dbba4004': 4498800 };
const expect = (text, r) => el('span', `pexp ${r}`, text);

function render() {
  const shown = items.map((it, i) => [it, String(i + 1).padStart(2, '0')]).filter(([[, , , t, , r]]) => (res === 'all' || r === res) && (type === 'all' || t === type));
  const out = $('#list'); out.replaceChildren(); out.className = view === 'grid' ? 'pgrid' : 'plist';
  for (const [[title, desc, id, t, exp, r, onTest], n] of shown) {
    if (view === 'grid') {
      const c = el('div', 'pcard dp-item'); c.dataset.id = id;
      const head = el('div', 'pchead'); head.append(el('b', 'pn', n), el('span', 'ptype', t));
      c.append(head, el('b', '', title), el('span', 'pdesc', desc), expect(exp, r), actions(id, onTest)); out.append(c);
    } else {
      const row = el('div', 'prow dp-item'); row.dataset.id = id;
      const main = el('div', 'pmain'); const tl = el('div', 'ptl'); tl.append(el('b', '', title), el('span', 'ptype', t));
      main.append(tl, el('span', 'pdesc', desc), expect(exp, r));
      row.append(el('b', 'pn', n), main, actions(id, onTest)); out.append(row);
    }
  }
  out.hidden = shown.length === 0;
  $('#none').hidden = shown.length > 0;
  for (const b of document.querySelectorAll('.pchip')) b.setAttribute('aria-pressed', String(b.dataset.res === res));
  for (const b of document.querySelectorAll('.pseg button')) b.setAttribute('aria-pressed', String(b.dataset.type === type));
  const v = $('#view'); const toGrid = view === 'list';
  v.setAttribute('aria-label', toGrid ? 'Show as grid' : 'Show as list'); v.title = v.getAttribute('aria-label');
  $('#ic-grid').style.display = toGrid ? '' : 'none'; $('#ic-list').style.display = toGrid ? 'none' : '';
  // the address keeps the selection, so the browser's Back returns to it too (replaced, not a new history step)
  try { history.replaceState(history.state, '', `${location.pathname}${location.search}${type === 'all' && res === 'all' ? '' : `#mt=${TYPE_CODE[type]}&mr=${res}`}`); } catch { /* the selection holds for this visit */ }
}
for (const b of document.querySelectorAll('.pchip')) b.addEventListener('click', () => { if (res !== b.dataset.res) { res = b.dataset.res; render(); } });
for (const b of document.querySelectorAll('.pseg button')) b.addEventListener('click', () => { type = b.dataset.type; render(); });
$('#view').addEventListener('click', () => { view = view === 'list' ? 'grid' : 'list'; try { localStorage.setItem(VIEW_KEY, view); } catch { /* the choice holds for this page only */ } render(); });
render();
// back from a page opened here: show the item that was opened
{ const at = back.get('at'); const it = at && /^[0-9a-f]{64}$/.test(at) && document.querySelector(`[data-id="${at}"]`); if (it) it.scrollIntoView({ block: 'center' }); }
for (const e of document.querySelectorAll('[data-brand]')) e.textContent = 'Clewbook';
