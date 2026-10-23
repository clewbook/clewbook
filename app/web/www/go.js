// A short campaign link, /c/<first 8 characters of the campaign id> (the page server and the hosted site send it here as go.html?p=<them>):
// the full id is found in the listing (campaigns.json, the home page's list). One match opens the campaign page with the relays the listing
// gives (else the project's relay); none says "Campaign not found"; two or more show a short pick list, the oldest first, each with its full
// id, its title and the date it was made, so a copy made to look like a real campaign is easy to spot.
import init, * as W from './pkg/ll_web.js';
import { grpcWeb } from './recount.js';
import { sibling, DEFAULT_ENDPOINTS, DEFAULT_RELAY } from './public.js';
import { setup, markReady } from './ui.js';

const $ = (s) => document.querySelector(s);
const prefix = (new URLSearchParams(location.search).get('p') || '').toLowerCase();

function say(title, line) {
  $('#go-title').textContent = title;
  $('#go-line').textContent = line || '';
  document.title = title;
}

/** The time (unix seconds) of a block, from its compact block (field 5), at the first server that answers; null if none does. */
async function blockTime(network, height) {
  for (const s of DEFAULT_ENDPOINTS[network] || []) {
    try {
      const [b] = await grpcWeb(s, 'GetBlockRange', W.block_range_request(height, height), { timeoutMs: 12000 });
      for (let i = 0; b && i < b.length;) {
        let key = 0, sh = 0, x;
        do { x = b[i++]; key |= (x & 0x7f) << sh; sh += 7; } while (x & 0x80);
        const f = key >>> 3, wt = key & 7;
        if (wt === 0) { let v = 0, m = 1; do { x = b[i++]; v += (x & 0x7f) * m; m *= 128; } while (x & 0x80); if (f === 5) return v; }
        else if (wt === 2) { let n = 0, s2 = 0; do { x = b[i++]; n |= (x & 0x7f) << s2; s2 += 7; } while (x & 0x80); i += n; }
        else if (wt === 5) i += 4; else if (wt === 1) i += 8; else break;
      }
    } catch { /* the next server */ }
  }
  return null;
}

const linkOf = (item) => sibling('campaign', { id: item.id, relays: item.relays && item.relays.length ? item.relays : [DEFAULT_RELAY], endpoints: [], server: '' });

/** One candidate's details, read from its first relay that answers and checked against its id: name, network, start block and its date. */
async function details(item) {
  for (const r of item.relays && item.relays.length ? item.relays : [DEFAULT_RELAY]) {
    try {
      const res = await fetch(`${r.replace(/\/$/, '')}/v1/campaigns/${item.id}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const c = JSON.parse(W.campaign_summary(await res.text(), item.id));
      const kind = c.sealed ? 'Blind bid auction' : c.mode === 'auction' ? 'Auction' : 'Fundraiser';
      return { ...item, title: c.name || `${kind} ${item.id.slice(0, 8)}…`, network: c.network, start: c.start_height, time: await blockTime(c.network, c.start_height) };
    } catch { /* the next relay */ }
  }
  return { ...item, title: null };
}

async function main() {
  setup('Campaign link', { netbar: false });
  markReady();
  if (!/^[0-9a-f]{8,64}$/.test(prefix)) { say('Campaign not found', ''); return; }
  let listed = [];
  try { listed = (await (await fetch('campaigns.json', { cache: 'no-store' })).json()).campaigns || []; } catch { /* none */ }
  const hits = listed.filter((c) => typeof c.id === 'string' && /^[0-9a-f]{64}$/.test(c.id) && c.id.startsWith(prefix));
  if (!hits.length) { say('Campaign not found', ''); return; }
  if (hits.length === 1) { location.replace(linkOf(hits[0])); return; }
  // two or more campaigns begin with the same 8 characters: never pick one; show each, the oldest first
  say('More than one campaign has this link', 'Check the full id with whoever sent you the link. The oldest is first.');
  await init();
  const all = await Promise.all(hits.map(details));
  all.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || (a.start ?? Infinity) - (b.start ?? Infinity));
  const list = $('#go-list');
  list.replaceChildren(...all.map((c) => {
    const li = document.createElement('li');
    const a = document.createElement('a'); a.href = linkOf(c); a.textContent = c.title || 'Details could not be read';
    const id = document.createElement('code'); id.textContent = c.id;
    const made = document.createElement('span');
    made.textContent = c.time ? `Made ${new Date(c.time * 1000).toUTCString().replace(/ GMT$/, ' UTC')}, block ${c.start.toLocaleString('en-US')}, ${c.network === 'main' ? 'mainnet' : 'testnet'}` : c.start != null ? `Made at block ${c.start.toLocaleString('en-US')}, ${c.network === 'main' ? 'mainnet' : 'testnet'}` : 'Date not known';
    li.append(a, document.createElement('br'), id, document.createElement('br'), made);
    return li;
  }));
  list.hidden = false;
}

main().catch(() => say('Campaign not found', 'The listing could not be read. Try again in a minute.'));
