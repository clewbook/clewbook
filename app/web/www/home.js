// The home page: lists the campaigns named in campaigns.json (kept by hand: a list of campaign numbers and the relays that hold them) and reads each one's
// rules and signed list from its relay, checked the way every other page checks them, to say whether it is open or closed. The file is only a list of
// where to look; everything shown about a campaign comes from the relay's checked answer. It never shows a raw error.
import init, * as W from './pkg/ll_web.js';
import { setup, markReady, etaText, decorateAmounts } from './ui.js';
import { readRelay, judge, tipOf, observedBlockSeconds, sibling, DEFAULT_ENDPOINTS } from './public.js';

const $ = (s) => document.querySelector(s);

function chip(network) {
  const c = document.createElement('span');
  c.className = `netchip ${network === 'main' ? 'main' : network === 'test' ? 'test' : 'unknown'}`;
  c.textContent = network === 'main' ? 'ZCASH MAINNET' : network === 'test' ? 'TEST MONEY ONLY' : 'NETWORK UNKNOWN';
  return c;
}

function card(item, info, status) {
  const d = document.createElement('div');
  d.className = 'card';
  const head = document.createElement('div'); head.className = 'card-head';
  const title = document.createElement('strong');
  title.textContent = info ? (info.name || `${info.mode === 'auction' ? 'Auction' : 'Fundraiser'} ${item.id.slice(0, 8)}…`) : `Campaign ${item.id.slice(0, 8)}…`;
  head.append(title);
  if (info) head.append(chip(info.network));
  d.append(head);
  const what = document.createElement('p'); what.className = 'muted';
  what.textContent = info ? `${info.mode === 'auction' ? `Auction, ${info.items} ${info.items === 1 ? 'item' : 'items'}` : `Fundraiser, goal ${info.goal} ${info.ticker}`}` : '';
  if (info) d.append(what);
  const st = document.createElement('p'); st.className = 'status'; st.textContent = status; d.append(st);
  const base = { id: item.id, relays: item.relays, endpoints: [], server: '' };
  const btns = document.createElement('div'); btns.className = 'btns';
  const link = (text, page, cls) => { const a = document.createElement('a'); a.className = `btn ${cls}`; a.textContent = text; a.href = sibling(page, base); return a; };
  btns.append(link('Open', 'campaign', 'sec'));
  if (info && !status.startsWith('Closed') && !status.startsWith('The deadline has passed')) btns.append(link(info.mode === 'auction' ? 'Bid' : 'Contribute', 'contribute', ''));
  btns.append(link('Recount this campaign', 'recount', 'sec'));
  d.append(btns);
  return d;
}

async function main() {
  setup('Home', { netbar: false });
  let list = [];
  try {
    const r = await fetch('campaigns.json', { cache: 'no-store' });
    if (r.ok) list = ((await r.json()).campaigns || []).filter((c) => /^[0-9a-f]{64}$/.test(String(c.id || '')) && Array.isArray(c.relays) && c.relays.length);
  } catch { /* no list: said below */ }
  markReady();
  $('#loading').remove();
  if (!list.length) { $('#live').innerHTML = '<p class="muted">No campaigns are listed yet.</p>'; return; }
  try { await init(); } catch { $('#live').textContent = 'This page could not start. Please reload it.'; return; }
  const shown = [];
  await Promise.all(list.map(async (item) => {
    item.relays = item.relays.map((u) => String(u).replace(/\/$/, ''));
    const j = judge(await Promise.all(item.relays.map((u) => readRelay(u, item.id))));
    let info = null, closed = false;
    if (j.rules) { try { info = JSON.parse(W.campaign_summary(j.rules, item.id)); closed = j.entries.some((e) => e.kind === 'close'); } catch { info = null; } }
    shown.push({ item, info, closed, entries: j.entries, kind: j.kind });
  }));
  // The cards are drawn at once, from the relay's answer; the deadline ("open for about ...") is filled in when a chain server has answered, so a slow
  // chain server never keeps the page empty.
  const order = (s) => (s.info && s.info.network === 'main' ? 0 : 1);
  shown.sort((a, b) => order(a) - order(b));
  const closedText = (s) => `Closed: ${({ goal_met: 'goal met', goal_missed: 'goal missed', auction: 'auction settled' }[s.entries.find((e) => e.kind === 'close').close.outcome] || 'finished')}.`;
  let live = 0, closed = 0;
  for (const s of shown) {
    const isClosed = !!(s.info && s.closed);
    s.status = !s.info ? "Can't be read right now." : isClosed ? closedText(s) : 'Open.';
    s.el = card(s.item, s.info, s.status);
    (isClosed ? $('#closed') : $('#live')).append(s.el);
    if (isClosed) closed++; else live++;
  }
  if (!live) $('#live').innerHTML = '<p class="muted">No campaign is open right now.</p>';
  $('#closed-card').hidden = !closed;
  decorateAmounts(document.querySelector('main'));
  // the chain height, once per network
  for (const n of new Set(shown.filter((s) => s.info && !s.closed).map((s) => s.info.network))) {
    (async () => {
      for (const e of DEFAULT_ENDPOINTS[n] || []) {
        const t = await tipOf(e, 8000);
        if (t == null) continue;
        const spb = await observedBlockSeconds([e], t);
        for (const s of shown.filter((x) => x.info && !x.closed && x.info.network === n)) {
          let status;
          if (t > s.info.deadline_height) status = 'The deadline has passed; the host is wrapping up.';
          else { const eta = etaText(s.info.deadline_height - t, spb); status = eta ? `Open: ${eta} left.` : 'Open.'; }
          s.el.querySelector('.status').textContent = status;
          if (t > s.info.deadline_height) for (const a of s.el.querySelectorAll('a.btn')) if (/^(Bid|Contribute)$/.test(a.textContent)) a.remove();
        }
        return;
      }
    })();
  }

}

main().catch(() => { const l = $('#live'); if (l) l.textContent = 'Something went wrong while loading this page. Please reload it.'; });
