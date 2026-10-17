// The demo's "Tested milestones" page (design round 14, handoff "testnet demo"): the thirteen finished test campaigns, the result chips (All, Passed,
// Failed), the type segment (All, Fundraisers, Auctions), list or grid (kept in this browser as cb-proofs-view). Copied by make-static.sh to
// proofs/examples.js. The links are built exactly as before.
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
// the demo folder is the one that holds proofs/ (at the site's root on a plain static host, under /demo/ on the page server)
const base = `${location.origin}${location.pathname.replace(/proofs(\/(index\.html)?)?$/, '')}`;
const q = (id) => `c=${id}&relay=${base}relays/a&relay=${base}relays/b`;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const VIEW_KEY = 'cb-proofs-view';
let res = 'all', type = 'all', view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } })();

function actions(id) {
  const box = el('div', 'pacts');
  for (const [name, page, cls] of [['↻ Recount', 'recount', 'prc'], ['Campaign', 'campaign', 'plk'], ['Capability card', 'card', 'plk']]) { const a = el('a', cls, name); a.href = `${base}${page}.html#${q(id)}`; box.append(a); }
  return box;
}
const expect = (text, r) => el('span', `pexp ${r}`, text);

function render() {
  const shown = items.map((it, i) => [it, String(i + 1).padStart(2, '0')]).filter(([[, , , t, , r]]) => (res === 'all' || r === res) && (type === 'all' || t === type));
  const out = $('#list'); out.replaceChildren(); out.className = view === 'grid' ? 'pgrid' : 'plist';
  for (const [[title, desc, id, t, exp, r], n] of shown) {
    if (view === 'grid') {
      const c = el('div', 'pcard dp-item');
      const head = el('div', 'pchead'); head.append(el('b', 'pn', n), el('span', 'ptype', t));
      c.append(head, el('b', '', title), el('span', 'pdesc', desc), expect(exp, r), actions(id)); out.append(c);
    } else {
      const row = el('div', 'prow dp-item');
      const main = el('div', 'pmain'); const tl = el('div', 'ptl'); tl.append(el('b', '', title), el('span', 'ptype', t));
      main.append(tl, el('span', 'pdesc', desc), expect(exp, r));
      row.append(el('b', 'pn', n), main, actions(id)); out.append(row);
    }
  }
  out.hidden = shown.length === 0;
  $('#none').hidden = shown.length > 0;
  for (const b of document.querySelectorAll('.pchip')) b.setAttribute('aria-pressed', String(b.dataset.res === res));
  for (const b of document.querySelectorAll('.pseg button')) b.setAttribute('aria-pressed', String(b.dataset.type === type));
  const v = $('#view'); const toGrid = view === 'list';
  v.setAttribute('aria-label', toGrid ? 'Show as grid' : 'Show as list'); v.title = v.getAttribute('aria-label');
  $('#ic-grid').style.display = toGrid ? '' : 'none'; $('#ic-list').style.display = toGrid ? 'none' : '';
}
for (const b of document.querySelectorAll('.pchip')) b.addEventListener('click', () => { if (res !== b.dataset.res) { res = b.dataset.res; render(); } });
for (const b of document.querySelectorAll('.pseg button')) b.addEventListener('click', () => { type = b.dataset.type; render(); });
$('#view').addEventListener('click', () => { view = view === 'list' ? 'grid' : 'list'; try { localStorage.setItem(VIEW_KEY, view); } catch { /* the choice holds for this page only */ } render(); });
render();
for (const e of document.querySelectorAll('[data-brand]')) e.textContent = 'Clewbook';
