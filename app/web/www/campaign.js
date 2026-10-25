// Campaign page: what the campaign has published (rules and public list, read from its relays), with
// links to contribute and to the recount. Reading only; it keeps no secrets. Nothing here is checked: the recount is the independent check.
// Design round 12: the page is drawn by the shared campaign view (public.js), the same one the contribute page shows when a campaign is closed.
import init, * as W from './pkg/ll_web.js';
import { linkParams, readAllRelays, tipOf, observedBlockSeconds, sibling, DEFAULT_ENDPOINTS, campaignView, metaLine, milestones, backToMilestones, copyLinkButton } from './public.js';
import { setNetwork, setup, setCampaignLabel, markReady, statusBadgeHTML } from './ui.js';
import { myBids, showResult } from './result.js';

const $ = (s) => document.querySelector(s);
const cfg = linkParams();

function banner(kind, text) {
  const d = document.createElement('div');
  d.className = `notice ${kind}`;
  d.textContent = text;
  return d;
}

async function main() {
  setup('Campaign');
  { const ms = milestones(); if (ms) backToMilestones($('.ctop .cback'), ms); } // opened from the demo's Tested milestones page
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
  // a list from one relay is said in the footnote under the list (round 12), word for word

  let tip = null;
  for (const e of [cfg.server, ...endpoints].filter(Boolean)) { tip = await tipOf(e); if (tip != null) break; }
  const secPerBlock = await observedBlockSeconds([cfg.server, ...endpoints].filter(Boolean), tip, c.network);
  const closeE = j.entries.find((e) => e.kind === 'close');
  const closed = !!closeE, left = tip == null ? null : c.deadline_height - tip;
  const outcome = closeE && closeE.close ? closeE.close.outcome : null;
  // the header: status pill (every closed outcome in the same neutral style) and the line beside it
  const phase = closed ? 'closed' : left == null ? 'unknown' : left > 0 ? 'open' : 'ended';
  $('#status-chip').innerHTML = statusBadgeHTML({ phase, outcome, soft: !!c.cap });
  $('#status-text').textContent = metaLine(c, { id: cfg.id, withId: true, closed });
  const SEALED_TITLE = { uniform: 'BLIND BID AUCTION · ONE PRICE FOR EVERY WINNER', second: 'BLIND BID AUCTION · HIGHEST LOSING BID', pay_your_bid: 'BLIND BID AUCTION · EACH WINNER PAYS THEIR BID' };
  // a sealed bid auction: whether its host did not finish needs only the list and the chain height
  let didNotFinish = false;
  if (c.sealed && tip != null) { try { didNotFinish = JSON.parse(W.report_sealed_at(j.rules, cfg.id, JSON.stringify(j.entries), tip)).did_not_finish; } catch { /* not shown */ } }
  $('#title').textContent = c.sealed ? SEALED_TITLE[c.sealed.pricing] : c.mode === 'auction' ? (c.pricing === 'uniform' ? 'AUCTION · ONE PRICE FOR EVERY WINNER' : 'AUCTION · EACH WINNER PAYS THEIR BID') : 'FUNDRAISER';

  const base = { id: cfg.id, relays: cfg.relays, endpoints: cfg.endpoints, server: cfg.server };
  const ms = milestones(), on = (h) => (ms ? ms.onward(h) : h);
  const links = { contribute: on(sibling('contribute', { ...base, endpoints: [] })), recount: on(sibling('recount', base)), card: on(sibling('card', base)) };
  // this browser's own bids: their rows marked Yours, and once the auction has settled, the one line result above the page
  const mine = new Set(myBids(cfg.id).map((b) => b.nf));
  campaignView($('#view'), { c, id: cfg.id, entries: j.entries, ok: j.ok, relays: cfg.relays, single: j.kind === 'single', tip, secPerBlock, links, didNotFinish, mine });
  showResult($('#my-result'), { c, entries: j.entries, id: cfg.id, W, servers: [cfg.server, ...endpoints].filter(Boolean) }).catch(() => {}); // round 13: no "Not checked by a recount" here (the recount page lists it)
  $('#nav-card').href = links.card; $('#nav-recount').href = links.recount;
  // the link to share: the short one when the listing names this campaign (else the full one); the full id stays under "more"
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'coutline'; copy.id = 'copy-link'; copy.textContent = 'Copy link';
  $('#links').append(copy);
  copyLinkButton(copy, cfg.id);
  const more = document.createElement('details'); more.className = 'cid-more'; more.id = 'id-more';
  const sum = document.createElement('summary'); sum.textContent = 'more';
  const full = document.createElement('code'); full.id = 'full-id'; full.textContent = cfg.id;
  const idRow = document.createElement('div'); idRow.className = 'cid-row'; idRow.append('Campaign id ', full);
  more.append(sum, idRow, viewingKeyRow(c, j.entries));
  $('#status-line').after(more);
}

/** The "Viewing key" row under "more": the key that lets anyone see the payments into the campaign (a blind bid auction publishes it after
 *  every settlement, an open auction at its close, a fundraiser in its rules from the start), shortened, with a Copy button for the whole key. */
function viewingKeyRow(c, entries) {
  const auction = !!c.sealed || c.mode === 'auction';
  const reveal = entries.find((e) => e.kind === 'reveal' && e.reveal && e.reveal.ufvk);
  const close = entries.find((e) => e.kind === 'close' && e.close && e.close.ufvk);
  const key = c.sealed ? reveal && reveal.reveal.ufvk : auction ? close && close.close.ufvk : c.campaign_ufvk;
  const row = document.createElement('div'); row.className = 'vk-row'; row.id = 'vk-row';
  row.append('Viewing key ');
  if (!key) { row.append(Object.assign(document.createElement('span'), { id: 'vk-none', textContent: 'Not published yet' })); return row; }
  const code = Object.assign(document.createElement('code'), { id: 'vk-short', textContent: `${key.slice(0, 12)}…${key.slice(-6)}`, title: key });
  const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'vk-copy', id: 'vk-copy', textContent: 'Copy' });
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(key); copy.textContent = 'Copied'; } catch { copy.textContent = 'Not copied'; } setTimeout(() => { copy.textContent = 'Copy'; }, 2500); });
  const what = Object.assign(document.createElement('p'), { className: 'vk-what', textContent: `Lets anyone see the payments into this ${auction ? 'auction' : 'fundraiser'}, not spend them.` });
  row.append(code, ' ', copy, what);
  return row;
}

main().catch((e) => { $('#banners').append(banner('bad', `Something went wrong: ${e.message || e}`)); });
