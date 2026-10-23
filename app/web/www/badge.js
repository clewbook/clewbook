// The recount badge: a small card that names the campaign and sends the reader to the live recount page. It shows no outcome: nothing is
// checked here, so it says "Not yet recounted". It reads only the campaign's rules from a relay, for the type of campaign and its short id.
import init, * as W from './pkg/ll_web.js';
import { setup, markReady } from './ui.js';

const $ = (s) => document.querySelector(s);
const p = new URLSearchParams(location.hash.slice(1));
const id = (p.get('c') || '').toLowerCase(), named = p.getAll('relay').map((u) => u.replace(/\/$/, '')), relays = named.length ? named : ['https://relay.clewbook.xyz']; // none named: the project's relay

async function main() {
  setup('Recount badge', { netbar: false, themeControl: false }); // a badge shown inside other sites: it follows the theme, without its own control
  if (!/^[0-9a-f]{64}$/.test(id)) { $('#badge-name').textContent = 'Campaign (incomplete link)'; return; }
  // the recount page that sits next to this badge, with the same campaign, relays and servers
  const q = [`c=${id}`, ...relays.map((r) => `relay=${r}`), ...p.getAll('endpoint').map((e) => `endpoint=${e}`), ...(p.get('server') ? [`server=${p.get('server')}`] : [])];
  $('#badge').href = `${new URL('.', location.href).href}recount.html#${q.join('&')}`;
  // the name is shown only when the rules hash to the campaign id (checked by the same module the other pages use); otherwise the badge shows the short id
  let kind = 'Campaign', name = null;
  try { await init(); } catch { /* without the module the badge still shows the type and the short id */ }
  for (const r of relays) {
    try {
      const res = await fetch(`${r}/v1/campaigns/${id}`, { cache: 'no-store' });
      if (!res.ok) continue;
      const text = await res.text();
      const s = JSON.parse(W.campaign_summary(text, id));
      kind = s.mode === 'auction' ? 'Auction' : s.mode === 'raise' ? 'Fundraiser' : 'Campaign';
      name = s.name || null;
      break;
    } catch { /* the badge still works without it */ }
  }
  markReady();
  $('#badge-name').textContent = name || `${kind} ${id.slice(0, 8)}…`;
  if (name) $('#badge-name').title = `${kind} ${id}`;
}
main();
