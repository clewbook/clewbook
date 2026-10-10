// The capability card: reads the campaign's rules from a relay, lets the WebAssembly module check them against the campaign id, and prints what
// they say (see capabilities.js). Nothing here is typed in by hand except the descriptions of the engine's own checks.
import init, * as W from './pkg/ll_web.js';
import { linkParams, readRelay, sibling, observedBlockSeconds, DEFAULT_ENDPOINTS } from './public.js';
import { setNetwork, setup, decorateAmounts, amountHTML, mountHash, cidEl, chipHTML, CHECKS, etaText, setCampaignLabel, markReady } from './ui.js';
import { cardModel } from './capabilities.js';

const $ = (s) => document.querySelector(s);
const cfg = linkParams();

function banner(kind, text) {
  const d = document.createElement('div'); d.className = `notice ${kind}`; d.textContent = text; $('#banners').append(d);
}
const row = ({ id, name, small, chip, word, body, idsLine }) => {
  const d = document.createElement('div'); d.className = `chk ${chip === 'nc' ? 'nc' : ''}`;
  const r = document.createElement('div'); r.className = 'row';
  const idc = document.createElement('span'); idc.className = 'id'; if (id) idc.append(typeof id === 'string' ? document.createTextNode(id) : id);
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = name;
  if (small) { const s = document.createElement('small'); s.textContent = small; nm.append(s); }
  const c = document.createElement('span'); c.innerHTML = chip === 'nc' ? chipHTML('nc', word) : `<span class="chip open">${word || 'Yes'}</span>`;
  r.append(idc, nm, c.firstChild); d.append(r);
  if (body || idsLine) {
    const b = document.createElement('div'); b.className = 'body';
    if (body) { const p = document.createElement('p'); p.textContent = body; b.append(p); }
    if (idsLine) { const l = document.createElement('div'); l.className = 'ids'; for (const x of idsLine) l.append(cidEl(x, x)); b.append(l); }
    d.append(b);
  }
  return d;
};

async function main() {
  setup('Capability card');
  $('#campaign-id').textContent = cfg.id ? `${cfg.id.slice(0, 8)}…` : '';
  if (!/^[0-9a-f]{64}$/.test(cfg.id) || cfg.relays.length === 0) { banner('bad', 'This link is incomplete. Please ask whoever sent it for the full link.'); return; }
  await init();
  let rulesText = null;
  for (const r of await Promise.all(cfg.relays.map((u) => readRelay(u, cfg.id)))) if (r.rules) { rulesText = r.rules; break; }
  markReady();
  if (!rulesText) { banner('bad', 'No relay could give the campaign details, so there is nothing to show yet. Try again in a minute.'); return; }
  let summary;
  try { summary = JSON.parse(W.campaign_summary(rulesText, cfg.id)); } catch (e) { banner('bad', String(e.message || e)); return; }
  setCampaignLabel(cfg.id, summary.name);
  setNetwork(summary.network);
  { const rb = document.querySelector('#recount-btn'); rb.href = sibling('recount', { id: cfg.id, relays: cfg.relays, endpoints: cfg.endpoints, server: cfg.server }); rb.hidden = false; }
  const rules = JSON.parse(rulesText);
  const endpoints = cfg.endpoints.length ? cfg.endpoints : DEFAULT_ENDPOINTS[summary.network] || [];
  const spb = await observedBlockSeconds([cfg.server, ...endpoints].filter(Boolean), (await tipFrom([cfg.server, ...endpoints].filter(Boolean))));
  const m = cardModel(summary, rules, spb);

  $('#net-label').textContent = m.net.label;
  const dl = $('#terms');
  for (const [k, v] of m.terms) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k;
    if (typeof v === 'string') dd.textContent = v;
    else if (v.amount != null) dd.innerHTML = amountHTML(v.amount, v.ticker);
    else if (v.block != null) dd.textContent = `block ${v.block.toLocaleString('en-US')}`;
    else dd.textContent = `${v.blocks.toLocaleString('en-US')} blocks${v.seconds ? `, ${etaText(v.blocks, v.seconds / v.blocks)}` : ' (the length of a block could not be measured)'}`;
    dl.append(dt, dd);
  }
  mountHash($('#rules-id'), cfg.id, 8);
  $('#auction-note').hidden = rules.mode !== 'auction';
  $('#checks-label').textContent = m.uniform ? 'R1 to R12' : 'R1 to R8';
  $('#checks').replaceChildren(...m.checks.map((id) => row({ id: cidEl(id), name: CHECKS[id][0], small: CHECKS[id][1], chip: 'yes', word: 'Every recount' })));
  $('#not-checked').replaceChildren(...m.notChecked.map(([what, why]) => row({ name: what[0].toUpperCase() + what.slice(1), small: why, chip: 'nc', word: 'Not checked' })));
  $('#levels').replaceChildren(...m.levels.map((l) => row({ id: `L${l.level}`, name: l.what, small: `Runs: ${l.when}`, chip: l.chip === 'nc' ? 'nc' : 'yes', word: l.chip === 'nc' ? 'Not built' : l.level === 3 ? 'On request' : 'Automatic', idsLine: l.ids })));
  const base = { id: cfg.id, relays: cfg.relays, endpoints: cfg.endpoints, server: cfg.server };
  $('#campaign-link').href = $('#nav-campaign').href = sibling('campaign', base);
  $('#recount-link').href = $('#nav-recount').href = sibling('recount', base);
  $('#card').hidden = false;
  decorateAmounts(document.querySelector('main'));
}

async function tipFrom(endpoints) {
  const { tipOf } = await import('./public.js');
  for (const e of endpoints) { const t = await tipOf(e); if (t != null) return t; }
  return null;
}

main().catch((e) => banner('bad', `Something went wrong: ${e.message || e}`));
