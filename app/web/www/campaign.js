// Campaign page: what the campaign has published (rules and public list, read from its relays), with
// links to contribute and to the recount. Reading only; it keeps no secrets. Nothing here is checked: the recount is the independent check.
import init, * as W from './pkg/ll_web.js';
import { linkParams, readAllRelays, hostOf, eta, tipOf, observedBlockSeconds, sibling, DEFAULT_ENDPOINTS } from './public.js';
import { setNetwork, setup, decorateAmounts, amountHTML, setCampaignLabel, markReady, statusBadgeHTML, outcomeWords } from './ui.js';
import { NOT_CHECKED } from './capabilities.js';

const $ = (s) => document.querySelector(s);
const cfg = linkParams();

function banner(kind, text) {
  const d = document.createElement('div');
  d.className = `notice ${kind}`;
  d.textContent = text;
  return d;
}
function fact(dl, label, value, sub = '') {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = value;
  if (sub) { const sm = document.createElement('small'); sm.textContent = sub; dd.append(sm); }
  dl.append(dt, dd);
}
/** A stat tile: a label, a value (text or amount HTML) and a small line under it. */
function tile(label, value, sub = '', html = false) {
  const d = document.createElement('div'); d.className = 'tile';
  const k = document.createElement('div'); k.className = 'tk'; k.textContent = label;
  const v = document.createElement('div'); v.className = 'tv'; if (html) v.innerHTML = value; else v.textContent = value;
  const u = document.createElement('div'); u.className = 'tu'; u.textContent = sub;
  d.append(k, v, u); $('#tiles').append(d);
}
const shortEta = (s) => (s ? s.replace(/^≈/, '~').replace(/ minutes$/, ' min').replace(/ hours$/, ' h') : s);

async function main() {
  setup('Campaign');
  $('#campaign-id').textContent = cfg.id ? `${cfg.id.slice(0, 8)}…` : '';
  $('#short-id').textContent = /^[0-9a-f]{64}$/.test(cfg.id) ? `${cfg.id.slice(0, 8)}…` : '';
  if (!/^[0-9a-f]{64}$/.test(cfg.id) || cfg.relays.length === 0) {
    $('#banners').append(banner('bad', 'This link is incomplete. Please ask whoever sent it for the full campaign link.'));
    return;
  }
  await init();
  const j = await readAllRelays(cfg.id, cfg.relays);
  markReady();
  for (const n of j.notes) $('#banners').append(banner('warn', n));
  if (!j.rules) {
    $('#banners').append(banner('bad', 'No relay could give the campaign details, so there is nothing to show yet. Try again in a minute.'));
    return;
  }
  const c = JSON.parse(W.campaign_summary(j.rules, cfg.id));
  setCampaignLabel(cfg.id, c.name);
  const endpoints = cfg.endpoints.length ? cfg.endpoints : DEFAULT_ENDPOINTS[c.network] || [];
  setNetwork(c.network);
  if (j.kind === 'disagree') $('#banners').append(banner('bad', 'RELAYS DISAGREE, CANNOT CONCLUDE. What is shown below comes from the relay with the longest list. Run the recount for a fuller check.'));
  if (j.kind === 'single') $('#banners').append(banner('info', cfg.relays.length > 1 ? 'Only one relay gave a usable list.' : 'Only one relay was asked, so nothing here has been cross checked.'));

  let tip = null;
  for (const e of [cfg.server, ...endpoints].filter(Boolean)) { tip = await tipOf(e); if (tip != null) break; }
  const secPerBlock = await observedBlockSeconds([cfg.server, ...endpoints].filter(Boolean), tip);
  const closed = j.entries.some((e) => e.kind === 'close');
  const left = tip == null ? null : c.deadline_height - tip;
  const status = closed ? 'Closed' : left == null ? 'Open (the chain height could not be read)' : left > 0 ? 'Open' : 'Deadline passed, not yet closed';

  const auction = c.mode === 'auction', uniform = c.pricing === 'uniform';
  const closeE = j.entries.find((e) => e.kind === 'close');
  const outcome = closeE && closeE.close ? closeE.close.outcome : null;
  const amt = (v) => (v == null ? '' : `${v} ${c.ticker}`);
  const zat = (z) => amountHTML(z, c.ticker);
  const tleft = left != null && left > 0 ? shortEta(eta(left, secPerBlock)) : null;

  // the header: status pill (decision 4: every closed outcome in the same neutral style), type and short id, the name
  const phase = closed ? 'closed' : left == null ? 'unknown' : left > 0 ? 'open' : 'ended';
  $('#status-chip').innerHTML = statusBadgeHTML({ phase, outcome, soft: !!c.cap });
  if (phase === 'open' && tleft) $('#status-chip .sbadge').append(` · ${tleft}`);
  $('#title').textContent = auction ? (uniform ? 'AUCTION · ONE PRICE FOR EVERY WINNER' : 'AUCTION · EACH WINNER PAYS THEIR BID') : 'FUNDRAISER';
  $('#display-name').textContent = c.name || `${auction ? 'Auction' : 'Fundraiser'} ${cfg.id.slice(0, 8)}…`;
  $('#display-name').hidden = false;
  $('#status-text').textContent = c.goal ? (c.cap ? `Soft cap ${c.goal} ${c.ticker}, hard cap ${c.cap} ${c.ticker}` : `Goal ${c.goal} ${c.ticker}`) : `${c.items} ${c.items === 1 ? 'item' : 'items'} for sale`;
  $('#status-line').hidden = false;

  // the stat tiles: what the rules say, and what the published list shows (as published, not checked)
  const issued = j.entries.filter((e) => e.kind === 'issue');
  const raisedZat = issued.reduce((t, e) => t + (e.contribution && e.contribution.value_zat != null ? e.contribution.value_zat : 0), 0);
  const deadlineTile = () => tile('Deadline', tleft || (left != null && left <= 0 ? 'passed' : '—'), `block ${c.deadline_height.toLocaleString('en-US')}`);
  if (closed) {
    tile('Outcome', outcomeWords(outcome, !!c.cap).replace('auction settled', 'settled'));
    // the first part of the terms is the value, the rest goes on the small line (Round 4, 09 §2)
    if (auction) tile('Terms', `${c.items} ${c.items === 1 ? 'item' : 'items'}`, uniform ? 'one price for every winner' : 'pay your bid');
    else if (c.cap) tile('Terms', `Soft cap ${c.goal}`, `hard cap ${c.cap} ${c.ticker}`);
    else tile('Terms', `Goal ${c.goal} ${c.ticker}`);
    tile('Network', c.network === 'main' ? 'Zcash Mainnet' : 'Testnet');
  } else if (auction) {
    tile('Items', String(c.items), 'one per winning bid');
    if (uniform) tile('Reserve', zat(c.reserve_zat), 'lowest price an item sells for', true);
    else tile('Smallest bid', zat(c.min_zat), '', true);
    deadlineTile();
  } else if (c.cap) {
    tile('Soft cap', zat(c.goal_zat), 'the least it must keep', true);
    tile('Hard cap', zat(c.cap_zat), 'the most it keeps', true);
    deadlineTile();
  } else {
    tile('Goal', zat(c.goal_zat), '', true);
    tile('Raised', zat(raisedZat), '', true);
    deadlineTile();
  }

  // RULES: the design's short rows, plus the facts this page always gave (status, ticket window, early close, refund promise)
  const facts = $('#facts');
  fact(facts, 'Type', auction ? 'Auction' : 'Fundraiser');
  if (auction) {
    fact(facts, 'How winners pay', uniform ? 'one price: the lowest winning bid' : 'each pays their own bid');
    if (uniform) fact(facts, 'Reserve', amt(c.reserve));
    fact(facts, 'Ties', 'earlier in the chain wins');
    fact(facts, 'Each bid', 'for one item');
    fact(facts, 'Smallest bid', amt(c.min));
  } else {
    if (c.cap) {
      fact(facts, 'Soft cap', amt(c.goal));
      fact(facts, 'Hard cap', amt(c.cap));
    }
    fact(facts, c.cap ? 'Soft cap missed' : 'Goal missed', 'all refunded');
    fact(facts, 'Smallest', amt(c.min));
  }
  fact(facts, 'Refund fee', amt(c.fee));
  if (auction) fact(facts, 'Bid amounts', 'public at the close');
  fact(facts, 'Status', status);
  if (left != null && left > 0 && secPerBlock) fact(facts, 'Block time', `≈${Math.round(secPerBlock)} seconds`);
  fact(facts, 'Ticket window', `${c.ticket_k} blocks${eta(c.ticket_k, secPerBlock) ? ` (${eta(c.ticket_k, secPerBlock)})` : ''}`, 'Your refund ticket arrives within this window; if the host has not closed by then, you can claim your own refund.');
  if (uniform) fact(facts, 'Settlement window', `${c.settle_window} blocks`, `the host must settle every winner by block ${c.settle_by}; after that winners can claim their own refund`);
  if (c.early_close) fact(facts, 'Early close', 'allowed');
  fact(facts, 'Refund promise', 'a signed ticket');
  if (uniform) { $('#rule-note').textContent = 'A bid must be at least the reserve plus the refund fee to win; if fewer bids reach it than there are items, every winner pays the reserve.'; $('#rule-note').hidden = false; }
  for (const [what, why] of NOT_CHECKED) { const li = document.createElement('li'); li.textContent = `– ${what}: ${why}`; $('#nc-list').append(li); }
  $('#about').hidden = false;
  if (closed) { $('#closed-note').textContent = `■ Closed: ${outcomeWords(outcome, !!c.cap)}. No new ${auction ? 'bids' : 'payments'}.`; $('#closed-note').hidden = false; }
  else if (auction) $('#bid-note').hidden = false;
  $('#contribute-link').textContent = auction ? 'Bid' : 'Contribute';

  // the counts of the public list, one per line behind the "Public list" heading (closed at first; they stay in the page either way)
  const count = (k) => j.entries.filter((e) => e.kind === k).length;
  const lf = $('#list-facts');
  const stat = (label, note, value) => {
    const d = document.createElement('div'); d.className = 'stat';
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dt.append(Object.assign(document.createElement('small'), { textContent: note })); dd.textContent = value;
    d.append(dt, dd); lf.append(d);
  };
  stat('Entries listed', "everything on the host's public list", String(j.entries.length));
  stat('Refund tickets issued', auction ? 'one per bid' : 'one per contribution', String(count('issue')));
  stat('Tickets reissued', 'only after a network upgrade', String(count('reissue')));
  stat('Payments set aside', 'not counted', String(count('reject')));
  const tg = $('#pl-toggle');
  tg.addEventListener('click', () => { const open = tg.getAttribute('aria-expanded') !== 'true'; tg.setAttribute('aria-expanded', String(open)); lf.hidden = !open; });
  // the footnote at the end of the page: which relays answered, and how many entries each one gave
  const ul = $('#relay-list');
  const n = (k) => `${k} ${k === 1 ? 'entry' : 'entries'}`;
  cfg.relays.forEach((url, i) => {
    const li = document.createElement('li');
    const info = j.ok.find((r) => r.url === url);
    li.textContent = `${hostOf(url)}: ${info ? n(info.entries.length) : 'no usable answer'}${i === cfg.relays.length - 1 ? '.' : ';'}`;
    if (!info) li.className = 'bad';
    ul.append(li);
  });
  $('#relay-live').textContent = `${j.ok.length} ${j.ok.length === 1 ? 'relay' : 'relays'} live.`;
  $('#public-list').hidden = false; $('#pl-foot').hidden = false;

  // the signed list, as published, newest first: one row per entry with the same six columns (kind with its short id beneath, result, amount,
  // what happened to the money, block, price paid). Amounts only where the list gives them: never a bid before the close, and nothing computed.
  const winners = closeE && closeE.close && Array.isArray(closeE.close.winners) ? closeE.close.winners : null;
  const settleOf = (nf) => j.entries.find((e) => e.kind === 'settle' && e.settle && e.settle.nf === nf);
  // a capped fundraiser that met its soft cap: the list replayed in its order (as on the contribute page); a contribution that fits even counting
  // every listed payment is kept, any other is over the cap and refunded by its ticket
  const overCap = new Set();
  if (!auction && outcome === 'goal_met' && c.cap_zat != null) {
    let room = c.cap_zat; const seen = new Set();
    for (const e of j.entries) {
      const x = e.contribution;
      if (!e.ticket || !x || x.value_zat == null || seen.has(x.nf)) continue;
      seen.add(x.nf);
      if (x.value_zat <= room) room -= x.value_zat; else overCap.add(x.nf);
    }
  }
  const DASH = '—';
  const sentBack = (s) => (s.excess_zat > 0 ? `${zat(s.excess_zat)} sent back` : 'Nothing sent back');
  /** One entry as its six cells: [kind, id, result, amount, what happened, block, price]; amounts are HTML, the rest plain text. */
  function rowOf(e) {
    const x = e.contribution;
    const ref = (x && x.txid) || (e.settle && e.settle.txid) || (e.ticket && e.ticket.txid) || null;
    const r = { kind: '', ref, result: DASH, amount: x && x.value_zat != null ? zat(x.value_zat) : null, what: DASH, block: x ? x.height : null, price: null };
    if (e.kind === 'issue' && auction) {
      r.kind = 'Bid';
      if (winners && x && x.nf) {
        const won = winners.includes(x.nf), st = won ? settleOf(x.nf) : null;
        r.result = won ? 'Won' : 'Lost';
        if (!won) r.what = 'Refunded by ticket';
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
      r.kind = 'Closed';
      const w = e.close ? outcomeWords(e.close.outcome, !!c.cap) : 'finished';
      r.result = w.charAt(0).toUpperCase() + w.slice(1);
      r.block = e.close ? e.close.close_height : null;
      if (e.close && e.close.clearing_price_zat != null) r.price = zat(e.close.clearing_price_zat);
    } else if (e.kind === 'settle' && e.settle) { r.kind = 'Settlement'; r.result = 'Settled'; r.what = sentBack(e.settle); r.price = zat(e.settle.price_zat); }
    else r.kind = e.kind;
    return r;
  }
  const all = j.entries.slice().reverse();
  if (all.length) {
    const body = $('#entries');
    for (const e of all) {
      const r = rowOf(e);
      const tr = document.createElement('tr'); tr.setAttribute('role', 'row'); tr.dataset.seq = String(e.seq);
      const td = (cls) => { const d = document.createElement('td'); d.className = cls; d.setAttribute('role', 'cell'); tr.append(d); return d; };
      const k = td('k');
      k.append(Object.assign(document.createElement('span'), { className: 'ek', textContent: r.kind }));
      if (r.ref) { const s = document.createElement('span'); s.className = 'ref'; s.title = r.ref; s.textContent = `${r.ref.slice(0, 8)}…${r.ref.slice(-5)}`; k.append(s); }
      td('res').textContent = r.result;
      const a = td('am r'); if (r.amount != null) a.innerHTML = r.amount; else { a.textContent = DASH; a.classList.add('none'); }
      td('what').innerHTML = r.what;
      td('blk').textContent = r.block != null ? r.block.toLocaleString('en-US') : DASH;
      const pr = td('pr r'); if (r.price != null) pr.innerHTML = r.price; else { pr.textContent = DASH; pr.classList.add('none'); }
      body.append(tr);
    }
    // the newest 5, and the rest behind "Show older (N)"
    const SHOWN = 5, rows = [...body.children], more = $('#entries-more'), hint = $('#entries-hint');
    const fold = (open) => {
      rows.forEach((tr, i) => { tr.hidden = !open && i >= SHOWN; });
      more.textContent = open ? 'Show fewer' : `Show older (${rows.length - SHOWN})`;
      more.setAttribute('aria-expanded', String(open));
      hint.textContent = open ? 'AS PUBLISHED' : `AS PUBLISHED · ${SHOWN} OF ${rows.length}`;
    };
    if (rows.length > SHOWN) { more.hidden = false; fold(false); more.addEventListener('click', () => fold(more.getAttribute('aria-expanded') !== 'true')); }
    $('#entries-card').hidden = false;
  } else $('#entries-empty').hidden = false;

  const base = { id: cfg.id, relays: cfg.relays, endpoints: cfg.endpoints, server: cfg.server };
  const links = { contribute: sibling('contribute', { ...base, endpoints: [] }), recount: sibling('recount', base) };
  $('#contribute-link').href = links.contribute;
  $('#card-link').href = $('#nav-card').href = sibling('card', base); // the capability card is linked from the RULES column; the old nav item stays hidden
  $('#recount-link').href = links.recount; $('#nav-recount').href = links.recount;
  if (closed || left != null && left <= 0) { $('#contribute-link').classList.add('off'); $('#contribute-link').hidden = true; }
  $('#links').hidden = false;

  decorateAmounts(document.querySelector('main'));
}

main().catch((e) => { $('#banners').append(banner('bad', `Something went wrong: ${e.message || e}`)); });
