// Campaign page: what the campaign has published (rules and public list, read from its relays), with
// links to contribute and to the recount, and a badge snippet. Reading only; it keeps no secrets.
import init, * as W from './pkg/ll_web.js';
import { linkParams, readAllRelays, hostOf, eta, tipOf, observedBlockSeconds, sibling, badgeSnippet, badgeSrc, DEFAULT_ENDPOINTS } from './public.js';
import { setNetwork, setup, decorateAmounts, amountHTML, mountHash, setCampaignLabel, markReady } from './ui.js';

const $ = (s) => document.querySelector(s);
const cfg = linkParams();

function banner(kind, text) {
  const d = document.createElement('div');
  d.className = `notice ${kind}`;
  d.textContent = text;
  return d;
}
function fact(dl, label, value) {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = value;
  dl.append(dt, dd);
}

async function main() {
  setup('Campaign');
  $('#campaign-id').textContent = cfg.id ? `${cfg.id.slice(0, 8)}…` : '';
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
  if (j.kind === 'single') $('#banners').append(banner('info', cfg.relays.length > 1 ? 'Only one relay gave a usable list.' : 'Only one relay was asked, so nothing here has been cross-checked.'));

  let tip = null;
  for (const e of [cfg.server, ...endpoints].filter(Boolean)) { tip = await tipOf(e); if (tip != null) break; }
  const secPerBlock = await observedBlockSeconds([cfg.server, ...endpoints].filter(Boolean), tip);
  const closed = j.entries.some((e) => e.kind === 'close');
  const left = tip == null ? null : c.deadline_height - tip;
  const status = closed ? 'Closed' : left == null ? 'Open (the chain height could not be read)' : left > 0 ? 'Open for contributions' : 'Deadline passed, not yet closed';

  const facts = $('#facts');
  fact(facts, 'Type', c.mode === 'auction' ? 'Auction' : 'Fundraiser');
  if (c.goal) fact(facts, 'Goal', `${c.goal} ${c.ticker}`);
  if (c.items) fact(facts, 'Items for sale', String(c.items));
  fact(facts, 'Smallest contribution', `${c.min} ${c.ticker}`);
  fact(facts, 'Status', status);
  fact(facts, 'Deadline', left != null && left > 0 ? `block ${c.deadline_height} (${eta(left, secPerBlock) ? `${eta(left, secPerBlock)} left` : `${left} blocks left; the length of a block could not be measured`})` : `block ${c.deadline_height}`);
  if (left != null && left > 0 && secPerBlock) fact(facts, 'Block time', `about ${Math.round(secPerBlock)} seconds, measured over the last 100 blocks`);
  if (c.pricing === 'uniform') {
    fact(facts, 'Pricing', `Every winner pays the same price: the lowest winning bid, at least ${c.reserve} ${c.ticker}`);
    fact(facts, 'Settlement', `the host must settle every winner by block ${c.settle_by} (${c.settle_window} blocks after the deadline); after that winners can claim their own refund`);
  }
  fact(facts, 'Ticket window', `${c.ticket_k} blocks${eta(c.ticket_k, secPerBlock) ? ` (${eta(c.ticket_k, secPerBlock)})` : ''}: each contribution gets its refund ticket within this window, and if the host has not closed this long after the deadline, contributors may claim their own refunds`);
  fact(facts, 'Refund promise', 'Every contribution comes with a signed refund ticket that never expires.');
  $('#about').hidden = false;
  $('#title').textContent = c.mode === 'auction' ? 'Auction' : 'Fundraiser';
  $('#status-line').hidden = false;
  $('#status-chip').innerHTML = closed ? '<span class="chip closed">Closed</span>' : left == null ? '<span class="chip warn">Unknown</span>' : left > 0 ? '<span class="chip open">Open</span>' : '<span class="chip warn">Wrapping up</span>';
  $('#status-text').textContent = c.goal ? `Goal ${c.goal} ${c.ticker}` : `${c.items} ${c.items === 1 ? 'item' : 'items'} for sale`;

  const count = (k) => j.entries.filter((e) => e.kind === k).length;
  const lf = $('#list-facts');
  fact(lf, 'Entries in the public list', String(j.entries.length));
  fact(lf, 'Refund tickets issued', String(count('issue')));
  fact(lf, 'Tickets re-issued', String(count('reissue')));
  fact(lf, 'Payments set aside', String(count('reject')));
  const ul = $('#relay-list');
  for (const url of cfg.relays) {
    const li = document.createElement('li');
    const info = j.ok.find((r) => r.url === url);
    li.textContent = `${hostOf(url)}: ${info ? `${info.entries.length} entries` : 'no usable answer'}`;
    if (!info) li.style.background = 'var(--fail-bg)';
    ul.append(li);
  }
  $('#public-list').hidden = false;

  // the latest entries of the signed list, as a ledger (amounts only where the list shows them: never in a sealed-bid auction)
  const KIND = { issue: 'Contribution', reissue: 'Ticket re-issued', reject: 'Set aside', close: 'Closed', settle: 'Settled', withdraw: 'Withdrawn' };
  const latest = j.entries.slice(-10).reverse();
  if (latest.length) {
    const body = $('#entries'), narrow = $('#entries-narrow');
    for (const e of latest) {
      const ref = (e.contribution && e.contribution.txid) || (e.settle && e.settle.txid) || (e.ticket && e.ticket.txid) || null;
      const zat = e.contribution && e.contribution.value_zat != null ? e.contribution.value_zat : e.settle ? e.settle.price_zat : null;
      const height = e.contribution ? e.contribution.height : null;
      const tr = document.createElement('tr');
      const cells = [['n', String(e.seq)], ['kind', KIND[e.kind] || e.kind], ['', height != null ? height.toLocaleString('en-US') : ''], ['r', null], ['', null]];
      for (const [cls, text] of cells) { const td = document.createElement('td'); if (cls) td.className = cls; if (text != null) td.textContent = text; tr.append(td); }
      tr.children[3].innerHTML = zat != null ? amountHTML(zat, c.ticker) : '<span class="dim">hidden or none</span>';
      if (ref) mountHash(tr.children[4].appendChild(document.createElement('span')), ref, 6);
      body.append(tr);
      const row = document.createElement('div'); row.className = 'lrow';
      const l = document.createElement('span'); l.textContent = `No. ${e.seq} ${KIND[e.kind] || e.kind}${height != null ? ` / block ${height.toLocaleString('en-US')}` : ''}`;
      const a = document.createElement('span'); a.className = 'a'; a.innerHTML = zat != null ? amountHTML(zat, c.ticker) : '<span class="dim">hidden or none</span>';
      row.append(l, a);
      if (ref) { const h = document.createElement('span'); h.style.gridColumn = '1 / -1'; mountHash(h, ref, 6); row.append(h); }
      narrow.append(row);
    }
    $('#entries-hint').textContent = `${latest.length} of ${j.entries.length}`;
    $('#entries-card').hidden = false;
  }

  const base = { id: cfg.id, relays: cfg.relays, endpoints: cfg.endpoints, server: cfg.server };
  const links = { contribute: sibling('contribute', { ...base, endpoints: [] }), recount: sibling('recount', base) };
  $('#contribute-link').href = links.contribute;
  $('#card-link').href = sibling('card', base);
  $('#recount-link').href = links.recount; $('#nav-recount').href = links.recount;
  if (closed || left != null && left <= 0) $('#contribute-link').classList.add('off');
  $('#links').hidden = false;

  const snippet = badgeSnippet(links);
  $('#badge-code').textContent = snippet;
  const preview = document.createElement('iframe');
  preview.src = badgeSrc(links.recount); preview.title = 'Recount badge preview'; preview.width = '300'; preview.height = '160'; preview.className = 'badge-frame';
  $('#badge-preview').replaceChildren(preview);
  $('#badge-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(snippet); $('#badge-copy').textContent = 'Copied'; } catch { $('#badge-copy').textContent = 'Select the text and copy it'; }
  });
  $('#badge-card').hidden = false;
  decorateAmounts(document.querySelector('main'));
}

main().catch((e) => { $('#banners').append(banner('bad', `Something went wrong: ${e.message || e}`)); });
