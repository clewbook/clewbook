// Start page: finds the current demo campaign and says in plain words whether it is still open.
// It must never show a raw error: every failure becomes a calm sentence.
import { grpcWeb } from './recount.js';
import { setup, etaText, decorateAmounts, markReady } from './ui.js';
import { measureBlocks } from './blocktime.js';

const $ = (s) => document.querySelector(s);

function varintField(bytes, field) {
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++], f = tag >> 3, t = tag & 7;
    if (t === 0) { let v = 0, s = 0, b; do { b = bytes[i++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); if (f === field) return v; }
    else if (t === 2) { let n = 0, s = 0, b; do { b = bytes[i++]; n += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); i += n; }
    else if (t === 1) i += 8; else if (t === 5) i += 4; else break;
  }
  return null;
}

async function main() {
  setup('Start'); markReady();
  // The dashboard lives on the same computer, next to this page.
  $('#dashboard-link').href = `${location.protocol}//${location.hostname}:8780/`;
  let cur;
  try {
    const r = await fetch('current.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('none');
    cur = await r.json();
  } catch {
    $('#contribute-text').textContent = 'There is no demo campaign yet. Start one from the terminal with app/web/demo.sh, then reload this page.';
    return;
  }
  const a = $('#contribute-link');
  a.href = cur.link; a.classList.remove('off'); a.classList.add('btn');
  const tail = cur.link.slice(cur.link.indexOf('#'));
  for (const [id, page] of [['#campaign-link', 'campaign'], ['#recount-link', 'recount']]) {
    $(id).href = `${page}.html${tail}`; $(id).classList.remove('off');
  }
  $('#contribute-text').textContent = `Demo campaign ${cur.id.slice(0, 8)}…`;
  const st = $('#contribute-status');
  try {
    const [msg] = await grpcWeb(cur.server, 'GetLatestBlock', new Uint8Array());
    const tip = varintField(msg, 1);
    let closed = false;
    for (const relay of cur.relays) {
      try {
        const ledger = await (await fetch(`${relay}/v1/campaigns/${cur.id}/ledger?from=0`, { cache: 'no-store' })).json();
        closed = ledger.some((e) => e.kind === 'close');
        break;
      } catch { /* try the next list */ }
    }
    if (closed) { st.textContent = 'This campaign has closed.'; st.className = 'status ended'; $('#status-chip').innerHTML = '<span class="chip closed">Closed</span>'; }
    else if (tip <= cur.deadline_height) { const m = await measureBlocks(cur.network || 'test'); const e = etaText(cur.deadline_height - tip, m.secondsPerBlock); st.textContent = e ? `Open: ${e} left.` : `Open: ${cur.deadline_height - tip} blocks left (the length of a block could not be measured).`; st.className = 'status open'; $('#status-chip').innerHTML = '<span class="chip open">Open</span>'; }
    else { st.textContent = 'The deadline has passed; the host is wrapping up.'; st.className = 'status ended'; }
  } catch {
    st.textContent = "Can't tell right now whether it is still open.";
  }
}

main().catch(() => { $('#contribute-text').textContent = 'Something went wrong while loading this page. Please reload it.'; });
