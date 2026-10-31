// The capability card: reads the campaign's rules from a relay, lets the WebAssembly module check them against the campaign id, and prints what
// they say (see capabilities.js). Nothing here is typed in by hand except the descriptions of the engine's own checks.
import init, * as W from './pkg/ll_web.js';
import { linkParams, readRelay, sibling, observedBlockSeconds, badgeSnippet, badgeSrc, DEFAULT_ENDPOINTS, milestones, backToMilestones } from './public.js';
import { setNetwork, showPageNet, setup, decorateAmounts, amountHTML, mountHash, cidEl, CHECKS, etaText, setCampaignLabel, markReady } from './ui.js';
import { cardModel } from './capabilities.js';

const $ = (s) => document.querySelector(s);
const cfg = linkParams();

// a status line (prototype): a red pip for a problem, a grey one for a note; on a problem the lead line goes, as the design draws it
function banner(kind, text) {
  const d = document.createElement('div'); d.className = `cp-status ${kind}`; d.setAttribute('role', 'status');
  d.append(Object.assign(document.createElement('span'), { className: 'pip', textContent: kind === 'bad' ? '✕' : '△' }), Object.assign(document.createElement('span'), { textContent: text }));
  d.firstChild.setAttribute('aria-hidden', 'true');
  $('#banners').append(d);
  if (kind === 'bad') { $('#cp').classList.add('err'); showPageNet(); } // no campaign to read: the page follows the browser's network
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

async function main() {
  setup('Capability card');
  $('#campaign-id').textContent = cfg.id ? `${cfg.id.slice(0, 8)}…` : '';
  if (!/^[0-9a-f]{64}$/.test(cfg.id) || cfg.relays.length === 0) { banner('bad', 'This link is incomplete. Please ask whoever sent it for the full link.'); return; }
  await init();
  let rulesText = null;
  const answers = await Promise.all(cfg.relays.map((u) => readRelay(u, cfg.id)));
  for (const r of answers) if (r.rules) { rulesText = r.rules; break; }
  markReady();
  if (!rulesText) {
    // the design: each relay named with what it answered, then the one red line
    for (const r of answers) { let host = r.url; try { host = new URL(r.url).host; } catch { /* as given */ } banner('note', `${host} could not be reached (${r.error || 'no answer'}).`); }
    banner('bad', 'No relay could give the campaign details, so there is nothing to show yet. Try again in a minute.'); return;
  }
  let summary;
  try { summary = JSON.parse(W.campaign_summary(rulesText, cfg.id)); } catch (e) { banner('bad', String(e.message || e)); return; }
  setCampaignLabel(cfg.id, summary.name);
  setNetwork(summary.network);
  const ms = milestones(), on = (h) => (ms ? ms.onward(h) : h); // opened from the demo's Tested milestones page
  { const rb = document.querySelector('#recount-btn'); rb.href = on(sibling('recount', { id: cfg.id, relays: cfg.relays, endpoints: cfg.endpoints, server: cfg.server })); rb.hidden = false; }
  const rules = JSON.parse(rulesText);
  const endpoints = cfg.endpoints.length ? cfg.endpoints : DEFAULT_ENDPOINTS[summary.network] || [];
  const spb = await observedBlockSeconds([cfg.server, ...endpoints].filter(Boolean), (await tipFrom([cfg.server, ...endpoints].filter(Boolean))), summary.network);
  const m = cardModel(summary, rules, spb);

  $('#net-label').textContent = m.net.label;
  const dl = $('#terms');
  for (const [k, v] of m.terms) {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); // one row each (prototype): the label, then the value
    dt.textContent = k;
    if (typeof v === 'string') dd.textContent = v;
    else if (v.amount != null) dd.innerHTML = amountHTML(v.amount, v.ticker);
    else if (v.block != null) dd.textContent = `block ${v.block.toLocaleString('en-US')}`;
    else dd.textContent = `${v.blocks.toLocaleString('en-US')} blocks${v.seconds ? `, ${etaText(v.blocks, v.seconds / v.blocks)}` : ' (the length of a block could not be measured)'}`;
    dl.append(dt, dd);
  }
  mountHash($('#rules-id'), cfg.id, 8);
  $('#auction-note').hidden = rules.mode !== 'auction';
  $('#checks-label').textContent = m.sealed ? 'R1, R2 and S1 to S8' : m.uniform ? 'R1 to R12, with R4b' : 'R1 to R8, with R4b';
  // the rows (prototype): the check id, then its name and what it means in one line (a blind bid check whose meaning is its name says it once)
  $('#checks').replaceChildren(...m.checks.map((id) => { const li = el('li'); const [nm, d] = CHECKS[id]; const t = el('span', 'cp-t'); t.append(el('b', null, `${nm}.`), ...(d && d !== `${nm}.` ? [` ${d}`] : [])); li.append(el('span', 'cp-id', id), t); return li; }));
  $('#not-checked').replaceChildren(...m.notChecked.map(([what, why]) => { const li = el('li'); const t = el('span', 'cp-t'); t.append(el('b', null, what[0].toUpperCase() + what.slice(1)), el('span', 'cp-why', why)); li.append(el('span', 'cp-mark'), t); li.firstChild.setAttribute('aria-hidden', 'true'); return li; }));
  $('#levels').replaceChildren(...m.levels.map((l) => {
    const li = el('li'), body = el('span', 'cp-lv');
    const chips = el('span', 'cp-chips');
    const word = l.chip === 'nc' ? 'Not built' : l.level === 3 ? 'On request' : 'Automatic';
    chips.append(el('span', `cp-mode ${l.chip === 'nc' ? 'nc' : l.level === 3 ? 'req' : 'auto'}`, word), ...l.ids.map((x) => { const c = cidEl(x, x); c.classList.add('cp-chip'); return c; }));
    body.append(el('span', 'cp-t', l.what), el('span', 'cp-runs', `Runs: ${l.when}`), chips);
    li.append(el('span', 'cp-id', `L${l.level}`), body);
    return li;
  }));
  const base = { id: cfg.id, relays: cfg.relays, endpoints: cfg.endpoints, server: cfg.server };
  $('#campaign-link').href = $('#nav-campaign').href = on(sibling('campaign', base));
  $('#recount-link').href = $('#nav-recount').href = on(sibling('recount', base));
  if (ms && ms.direct) backToMilestones($('#nav-campaign'), ms);
  // the badge box (moved here from the campaign page in design round 2, owner decision): the snippet a host pastes, and a preview
  const links = { contribute: sibling('contribute', { ...base, endpoints: [] }), recount: sibling('recount', base) };
  const snippet = badgeSnippet(links);
  $('#badge-code').textContent = snippet;
  const preview = document.createElement('iframe');
  preview.src = badgeSrc(links.recount); preview.title = 'Recount badge preview'; preview.width = '300'; preview.height = '160'; preview.className = 'badge-frame';
  $('#badge-preview').replaceChildren(preview);
  $('#badge-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(snippet); $('#badge-copy').textContent = '✓ Copied'; setTimeout(() => { $('#badge-copy').textContent = 'Copy'; }, 1600); } catch { $('#badge-copy').textContent = 'Select the text and copy it'; }
  });
  $('#badge-card').hidden = false;
  $('#card').hidden = false;
  decorateAmounts(document.querySelector('main'));
}

async function tipFrom(endpoints) {
  const { tipOf } = await import('./public.js');
  for (const e of endpoints) { const t = await tipOf(e); if (t != null) return t; }
  return null;
}

main().catch((e) => banner('bad', `Something went wrong: ${e.message || e}`));
