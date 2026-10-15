// Set-up page: sends the same request the dashboard always sent (mode, goal or items, deadline, smallest contribution, relays) and then
// goes to the dashboard. Function only: the look is in ui.css and setup.css. Every refusal is a calm notice, never a raw error.
import { setup, setNetwork, decorateAmounts, amountHTML, etaText, markReady } from './ui.js';
import { measureBlocks } from './blocktime.js';

const $ = (s) => document.querySelector(s);
let config = null, measured = { tip: null, secondsPerBlock: null, spanBlocks: 0 };

async function api(path, body) {
  const init = body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) };
  const res = await fetch(`/api/${path}`, init);
  const data = await res.json().catch(() => ({ ok: false, error: 'The host program sent an answer that could not be read.' }));
  if (!data.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function say(el, text) { el.textContent = text; el.hidden = !text; if (text && el.classList.contains('notice')) el.prepend(Object.assign(document.createElement('div'), { className: 'k', textContent: 'Check this' })); }

/** "0.01" -> 1000000 (zatoshis) without floating point; throws a plain message. */
function toZat(text, what) {
  const t = String(text).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error(`Please enter ${what} as a number like 0.05.`);
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 1e8 + Number(frac.padEnd(8, '0'));
}
const mode = () => document.querySelector('input[name=mode]:checked').value;
const pricing = () => document.querySelector('input[name=pricing]:checked').value;

function renderTerms() {
  const ticker = config ? config.ticker : 'TAZ';
  const n = Number($('#deadline').value);
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  let goal = '';
  try { goal = mode() === 'raise' ? ($('#goal').value.trim() ? amountHTML(toZat($('#goal').value, 'the goal'), ticker) : '<span class="dim">not entered yet</span>') : `${Number($('#items').value) || '<span class="dim">not entered yet</span>'}`; } catch { goal = '<span class="dim">not a number yet</span>'; }
  // an optional hard cap: the goal is then shown as the soft cap
  let cap = null;
  try { cap = mode() === 'raise' && !$('#cap-row').hidden && $('#cap').value.trim() ? toZat($('#cap').value, 'the hard cap') : null; } catch { cap = null; }
  let min = '';
  try { min = amountHTML(toZat($('#minimum').value, 'the smallest contribution'), ticker); } catch { min = '<span class="dim">not a number yet</span>'; }
  const time = Number.isInteger(n) && n > 0 ? (etaText(n, measured.secondsPerBlock) || 'the length of a block could not be measured') : '';
  $('#terms').innerHTML = [
    row('Type', mode() === 'raise' ? 'Fundraiser' : 'Auction'),
    row(mode() === 'raise' ? (cap != null ? 'Soft cap' : 'Goal') : 'Items for sale', goal),
    ...(cap != null ? [row('Hard cap', amountHTML(cap, ticker))] : []),
    ...(mode() === 'raise' ? [row('Early close', $('#early-close').checked ? 'Allowed once the goal is met' : 'Not allowed: the campaign closes after the deadline')] : []),
    ...(mode() === 'auction' ? [row('How winners pay', pricing() === 'uniform' ? 'Everyone who wins pays the same price (the lowest winning bid); the rest comes back' : 'Each winner pays their own bid')] : []),
    row('Smallest contribution', min),
    row('Deadline', Number.isInteger(n) && n > 0 ? `${measured.tip != null ? `about block ${(measured.tip + n).toLocaleString('en-US')} (now ${measured.tip.toLocaleString('en-US')}, plus ${n.toLocaleString('en-US')})` : `${n.toLocaleString('en-US')} blocks from now`}${time ? `, ${time} from now` : ''}` : '<span class="dim">not entered yet</span>'),
    row('Ticket window', Number.isInteger(Number($('#ticketk').value)) && Number($('#ticketk').value) > 0 ? `${Number($('#ticketk').value).toLocaleString('en-US')} blocks${etaText(Number($('#ticketk').value), measured.secondsPerBlock) ? `, ${etaText(Number($('#ticketk').value), measured.secondsPerBlock)}` : ''}` : '<span class="dim">not entered yet</span>'),
    row('Network', config ? (config.network === 'main' ? 'Main network (real money)' : 'Test network (no real money)') : ''),
  ].join('');
  decorateAmounts($('#terms'));
}

/** The hard cap's warning, as the program gives it: allowed, but with little room above the goal the campaign can miss its goal. */
function capWarn() {
  let goal = null, cap = null;
  try { goal = toZat($('#goal').value, 'the goal'); cap = $('#cap').value.trim() ? toZat($('#cap').value, 'the hard cap') : null; } catch { /* not numbers yet */ }
  const w = $('#cap-warn');
  w.textContent = cap == null || goal == null ? ''
    : cap < goal ? 'The hard cap must be at least the goal.'
      : cap < 2 * goal ? 'The hard cap is less than twice the soft cap: a payment that does not fit under the hard cap is refunded, so the campaign can miss its soft cap even when enough was paid in.' : '';
  w.hidden = !w.textContent;
}

function deadlineHint() {
  const n = Number($('#deadline').value);
  const t = Number.isInteger(n) && n > 0 ? etaText(n, measured.secondsPerBlock) : null;
  $('#deadline-hint').textContent = !(Number.isInteger(n) && n > 0) ? 'At least 20 blocks.'
    : t ? `That is ${t} from now (a block takes about ${Math.round(measured.secondsPerBlock)} seconds, measured over the last ${measured.spanBlocks} blocks).`
      : 'The length of a block could not be measured just now, so no time estimate is shown.';
}

function ticketHint() {
  const k = Number($('#ticketk').value);
  const t = Number.isInteger(k) && k > 0 ? etaText(k, measured.secondsPerBlock) : null;
  $('#ticketk-hint').textContent = `Every contribution must get its refund ticket within this many blocks (the recount flags a late one), and after the deadline you have this many blocks to close before contributors may claim their own refunds. A longer window gives you more slack and contributors a longer wait. Whole number, 10 to 1000.${t ? ` ${k} blocks is ${t}.` : ''}`;
}

function modeChanged() {
  const raise = mode() === 'raise';
  $('#goal-row').hidden = !raise;
  $('#items-row').hidden = raise;
  renderTerms();
}

async function onCreate(ev) {
  ev.preventDefault();
  const err = $('#setup-error');
  err.replaceChildren(); say(err, '');
  const btn = $('#create-btn');
  try {
    const m = mode();
    const body = {
      mode: m,
      deadline_in: Number($('#deadline').value),
      min_contribution_zat: toZat($('#minimum').value, 'the smallest contribution'),
      ticket_k: Number($('#ticketk').value),
      relays: $('#relays').value.split('\n').map((x) => x.trim()).filter(Boolean),
    };
    const nm = $('#campaign-name').value.trim();
    if (nm) body.name = nm;
    if (m === 'raise') {
      body.goal_zat = toZat($('#goal').value, 'the goal');
      if ($('#early-close').checked) body.early_close = true;
      if (!$('#cap-row').hidden && $('#cap').value.trim()) body.cap_zat = toZat($('#cap').value, 'the hard cap');
    }
    else {
      body.items = Number($('#items').value);
      body.pricing = pricing();
      if (body.pricing === 'uniform' && $('#reserve').value.trim()) body.reserve_zat = toZat($('#reserve').value, 'the reserve price'); // empty: the program says what is missing, after the items
    }
    btn.disabled = true; btn.textContent = 'Creating… this can take a minute';
    if (config && config.network === 'main') body.confirm_mainnet = $('#confirm-mainnet').checked;
    await api('campaigns', body);
    location.href = '/';
  } catch (e) {
    err.replaceChildren(); say(err, e.message);
    btn.disabled = config && config.network === 'main' && !$('#confirm-mainnet').checked; btn.textContent = 'Create campaign';
  }
}

async function main() {
  setup('New campaign', { host: true }); markReady(); // a page on this computer: no intro to replay
  try {
    config = await api('config');
  } catch {
    $('#banner').textContent = "This page can't reach the host program right now. Start it with: cb-host serve";
    $('#banner').hidden = false;
    $('#create-btn').disabled = true;
    setNetwork('unknown'); // design round 2: the network bar says it cannot tell, instead of checking for ever
    return;
  }
  setNetwork(config.network); // design round 2: the TESTNET bar from the network the host program reported (on main the bar hides; the MAINNET banner below stays)
  for (const el of document.querySelectorAll('.ticker')) el.textContent = config.ticker;
  // the hard cap field only when this host program knows the hard cap (an older one would ignore it and make a campaign without one)
  $('#cap-row').hidden = config.hard_cap !== true;
  if (config.network === 'main') {
    $('#mainnet-banner').hidden = false; $('#confirm-row').hidden = false; $('#create-btn').disabled = true;
    $('#nu7-note').textContent = config.nu7_mainnet_height
      ? `The NU7 network upgrade activates at block ${config.nu7_mainnet_height.toLocaleString('en-US')}. A campaign that could still be running then is refused: refund tickets signed before the upgrade stop working after it.`
      : 'The NU7 network upgrade is announced for 5 November 2026 and its block height is not published yet (expected 20 October). Until it is given, a campaign must be over a week before that date, and a longer one is refused.';
    $('#confirm-mainnet').addEventListener('change', () => { $('#create-btn').disabled = !$('#confirm-mainnet').checked; });
  }
  $('#net-note').textContent = config.network === 'main' ? 'Main network: real money.' : 'Test network: no real money.';
  $('#minimum-hint').textContent = `At least ${(config.min_floor_zat / 1e8).toFixed(8)} ${config.ticker}, which is twice the refund fee.`;
  if (config.relays && config.relays.length) $('#relays').placeholder = config.relays.join('\n');
  $('#setup-form').addEventListener('submit', onCreate);
  for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', modeChanged);
  $('#early-close').addEventListener('change', renderTerms);
  for (const r of document.querySelectorAll('input[name=pricing]')) r.addEventListener('change', () => { $('#reserve-row').hidden = pricing() !== 'uniform'; renderTerms(); });
  for (const id of ['#goal', '#cap']) $(id).addEventListener('input', capWarn);
  for (const id of ['#goal', '#cap', '#items', '#minimum', '#deadline', '#ticketk']) $(id).addEventListener('input', () => { deadlineHint(); ticketHint(); renderTerms(); });
  modeChanged(); deadlineHint(); ticketHint(); decorateAmounts(document.querySelector('main'));
  measured = await measureBlocks(config.network);
  deadlineHint(); ticketHint(); renderTerms(); decorateAmounts(document.querySelector('main'));
}

main().catch(() => { $('#banner').textContent = 'Something went wrong while loading this page. Please reload it.'; $('#banner').hidden = false; });
