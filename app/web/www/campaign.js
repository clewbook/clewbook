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
const shortEta = (s) => (s ? s.replace(/^about /, '~').replace(/ minutes$/, ' min').replace(/ hours$/, ' h') : s);

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
  const status = closed ? 'Closed' : left == null ? 'Open (the chain height could not be read)' : left > 0 ? 'Open for contributions' : 'Deadline passed, not yet closed';

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
    tile('Raised', zat(raisedZat), `${issued.length} ${issued.length === 1 ? 'contribution' : 'contributions'} as published`, true);
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
      fact(facts, 'Soft cap', amt(c.goal), 'the least it must keep at the deadline, or everyone is refunded');
      fact(facts, 'Hard cap', amt(c.cap), 'the most it keeps; at the close, a payment that does not fit is refunded whole by its own ticket, minus the fee');
    }
    fact(facts, c.cap ? 'Soft cap missed' : 'Goal missed', 'all refunded');
    fact(facts, 'Smallest', amt(c.min));
  }
  fact(facts, 'Refund fee', amt(c.fee));
  fact(facts, auction ? 'Bid amounts' : 'Amounts', auction ? 'public at the close' : 'public');
  fact(facts, 'Who paid', 'off the record');
  fact(facts, 'Status', status);
  if (left != null && left > 0 && secPerBlock) fact(facts, 'Block time', `about ${Math.round(secPerBlock)} seconds`, 'measured over the last 100 blocks');
  fact(facts, 'Ticket window', `${c.ticket_k} blocks${eta(c.ticket_k, secPerBlock) ? ` (${eta(c.ticket_k, secPerBlock)})` : ''}`, 'each contribution gets its refund ticket within this window, and if the host has not closed this long after the deadline, contributors may claim their own refunds');
  if (uniform) fact(facts, 'Settlement window', `${c.settle_window} blocks`, `the host must settle every winner by block ${c.settle_by}; after that winners can claim their own refund`);
  if (c.early_close) fact(facts, 'Early close', 'allowed', 'the host may close this fundraiser before the deadline once the ' + (c.cap ? 'soft cap' : 'goal') + ' is met. Contributions can be taken back with their tickets only until it closes, and payments after the close do not count. The close height is the host\'s own statement.');
  fact(facts, 'Refund promise', 'a signed ticket', 'every contribution gets a refund ticket with no expiry height. It works without the host while the contribution is unspent: until the deadline, and afterwards unless the contribution is kept.');
  if (uniform) { $('#rule-note').textContent = 'A bid must be at least the reserve plus the refund fee to win; if fewer bids reach it than there are items, every winner pays the reserve.'; $('#rule-note').hidden = false; }
  for (const [what, why] of NOT_CHECKED) { const li = document.createElement('li'); li.textContent = `– ${what}: ${why}`; $('#nc-list').append(li); }
  $('#about').hidden = false;
  if (closed) { $('#closed-note').textContent = `■ Closed: ${outcomeWords(outcome, !!c.cap)}. No new ${auction ? 'bids' : 'payments'}.`; $('#closed-note').hidden = false; }
  else if (auction) $('#bid-note').hidden = false;
  $('#contribute-link').textContent = auction ? 'Bid' : 'Contribute';

  const count = (k) => j.entries.filter((e) => e.kind === k).length;
  const lf = $('#list-facts');
  const stat = (label, value) => { const d = document.createElement('div'); d.className = 'stat'; fact(d, label, value); lf.append(d); };
  stat('Entries in the public list', String(j.entries.length));
  stat('Refund tickets issued', String(count('issue')));
  stat('Tickets reissued', String(count('reissue')));
  stat('Payments set aside', String(count('reject')));
  const ul = $('#relay-list');
  for (const url of cfg.relays) {
    const li = document.createElement('li');
    const info = j.ok.find((r) => r.url === url);
    li.textContent = `${hostOf(url)}: ${info ? `${info.entries.length} entries` : 'no usable answer'}`;
    if (!info) li.className = 'bad';
    ul.append(li);
  }
  $('#relay-live').textContent = `${j.ok.length} ${j.ok.length === 1 ? 'relay' : 'relays'} live.`;
  $('#public-list').hidden = false;

  // the latest entries of the signed list, as published (amounts only where the list shows them: never a bid before the close)
  const KIND = { issue: auction ? 'Bid received' : 'Contribution', reissue: 'Ticket reissued', reject: 'Set aside', close: 'Closed', settle: 'Settlement', withdraw: 'Withdrawn' };
  const winners = closeE && closeE.close && Array.isArray(closeE.close.winners) ? closeE.close.winners : null;
  const settleOf = (nf) => j.entries.find((e) => e.kind === 'settle' && e.settle && e.settle.nf === nf);
  const latest = j.entries.slice(-10).reverse();
  if (latest.length) {
    const body = $('#entries'), narrow = $('#entries-narrow');
    for (const e of latest) {
      const ref = (e.contribution && e.contribution.txid) || (e.settle && e.settle.txid) || (e.ticket && e.ticket.txid) || null;
      let zatv = e.contribution && e.contribution.value_zat != null ? e.contribution.value_zat : e.settle ? e.settle.price_zat : null;
      const height = e.contribution ? e.contribution.height : null;
      let kind = KIND[e.kind] || e.kind, note = '';
      // a closed auction: each bid entry is a winner or not (the close names the winners by nullifier); a winner's settlement gives the price and what came back
      if (auction && e.kind === 'issue' && winners && e.contribution && e.contribution.nf) {
        const won = winners.includes(e.contribution.nf), st = won ? settleOf(e.contribution.nf) : null;
        kind = won ? 'Bid · won' : 'Bid · did not win';
        if (st) { zatv = st.settle.price_zat; note = st.settle.excess_zat > 0 ? 'back' : ''; }
        else if (!won) note = 'refunded by ticket';
      }
      const tr = document.createElement('tr');
      const cells = [['n', `#${e.seq}`], ['kind', kind], ['blk', height != null ? `block ${height.toLocaleString('en-US')}` : ''], ['r', null], ['', null]];
      for (const [cls, text] of cells) { const td = document.createElement('td'); if (cls) td.className = cls; if (text != null) td.textContent = text; tr.append(td); }
      tr.children[3].innerHTML = zatv != null ? zat(zatv) : `<span class="dim">${note || (auction && e.kind === 'issue' ? 'amount hidden until the close' : '')}</span>`;
      if (zatv != null && note === 'back' && e.contribution) { const st = settleOf(e.contribution.nf); tr.children[1].insertAdjacentHTML('beforeend', `<small class="enote">the settlement lists ${zat(st.settle.excess_zat)} sent back</small>`); }
      if (ref) { const r = document.createElement('span'); r.className = 'ref'; r.title = ref; r.textContent = `${ref.slice(0, 8)}…${ref.slice(-5)}`; tr.children[1].append(' ', r); }
      body.append(tr);
      const row = document.createElement('div'); row.className = 'lrow';
      const l = document.createElement('span'); l.textContent = `No. ${e.seq} ${kind}${height != null ? ` / block ${height.toLocaleString('en-US')}` : ''}`;
      const a = document.createElement('span'); a.className = 'a'; a.innerHTML = tr.children[3].innerHTML;
      row.append(l, a);
      narrow.append(row);
    }
    $('#entries-hint').textContent = latest.length < j.entries.length ? `AS PUBLISHED · ${latest.length} OF ${j.entries.length}` : 'AS PUBLISHED';
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
