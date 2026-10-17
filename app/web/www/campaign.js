// Campaign page: what the campaign has published (rules and public list, read from its relays), with
// links to contribute and to the recount. Reading only; it keeps no secrets. Nothing here is checked: the recount is the independent check.
// Design round 12: the page is drawn by the shared campaign view (public.js), the same one the contribute page shows when a campaign is closed.
import init, * as W from './pkg/ll_web.js';
import { linkParams, readAllRelays, tipOf, observedBlockSeconds, sibling, DEFAULT_ENDPOINTS, campaignView, metaLine } from './public.js';
import { setNetwork, setup, setCampaignLabel, markReady, statusBadgeHTML } from './ui.js';

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
  const secPerBlock = await observedBlockSeconds([cfg.server, ...endpoints].filter(Boolean), tip);
  const closeE = j.entries.find((e) => e.kind === 'close');
  const closed = !!closeE, left = tip == null ? null : c.deadline_height - tip;
  const outcome = closeE && closeE.close ? closeE.close.outcome : null;
  // the header: status pill (every closed outcome in the same neutral style) and the line beside it
  const phase = closed ? 'closed' : left == null ? 'unknown' : left > 0 ? 'open' : 'ended';
  $('#status-chip').innerHTML = statusBadgeHTML({ phase, outcome, soft: !!c.cap });
  $('#status-text').textContent = metaLine(c, { id: cfg.id, withId: true, closed });
  $('#title').textContent = c.mode === 'auction' ? (c.pricing === 'uniform' ? 'AUCTION · ONE PRICE FOR EVERY WINNER' : 'AUCTION · EACH WINNER PAYS THEIR BID') : 'FUNDRAISER';

  const base = { id: cfg.id, relays: cfg.relays, endpoints: cfg.endpoints, server: cfg.server };
  const links = { contribute: sibling('contribute', { ...base, endpoints: [] }), recount: sibling('recount', base), card: sibling('card', base) };
  campaignView($('#view'), { c, id: cfg.id, entries: j.entries, ok: j.ok, relays: cfg.relays, single: j.kind === 'single', tip, secPerBlock, links }); // round 13: no "Not checked by a recount" here (the recount page lists it)
  $('#nav-card').href = links.card; $('#nav-recount').href = links.recount;
}

main().catch((e) => { $('#banners').append(banner('bad', `Something went wrong: ${e.message || e}`)); });
