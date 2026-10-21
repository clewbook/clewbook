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
const sealedPricing = () => document.querySelector('input[name=spricing]:checked').value;
const sealedTiming = () => ($('#s-timing').hidden ? 'standard' : (document.querySelector('input[name=stiming]:checked') || { value: 'standard' }).value);
// deposits are taken until the earlier of the ticket window and the 10 block cutoff for the host's small payment, before the deadline
// (the same rule as the host's check, MIN_BID_WINDOW_BLOCKS in the core)
const COIN_CUTOFF_BLOCKS = 10, MIN_BID_WINDOW = 10;
const bidWindow = (deadlineIn, k) => deadlineIn - Math.max(k, COIN_CUTOFF_BLOCKS);
function bidWindowError(deadlineIn, k) {
  const w = bidWindow(deadlineIn, k), before = Math.max(k, COIN_CUTOFF_BLOCKS);
  return w >= MIN_BID_WINDOW ? null : `This leaves ${Math.max(w, 0)} block(s) for deposits: a deposit must be made at least ${before} blocks before the deadline (the ticket window, or the ${COIN_CUTOFF_BLOCKS} block cutoff for the host's small payment if larger). Make the deadline at least ${before + MIN_BID_WINDOW} blocks, or the ticket window smaller.`;
}
/** The bidding window in words, for the summary. */
function bidWindowText(n) {
  const k = Number($('#ticketk').value);
  if (!(Number.isInteger(n) && n > 0 && Number.isInteger(k) && k > 0)) return '<span class="dim">not entered yet</span>';
  const w = bidWindow(n, k);
  if (w < MIN_BID_WINDOW) return `<span class="dim">only ${Math.max(w, 0)} block(s): too short, at least ${MIN_BID_WINDOW} are needed</span>`;
  const mins = measured.secondsPerBlock ? `, about ${Math.round((w * measured.secondsPerBlock) / 60).toLocaleString('en-US')} minutes from now` : '';
  return measured.tip != null ? `Block ${(measured.tip + w).toLocaleString('en-US')}${mins}` : `${w.toLocaleString('en-US')} blocks from now${mins}`;
}
const SEALED_PRICING = { uniform: 'Everyone who wins pays the lowest winning bid', second: 'Everyone who wins pays the highest losing bid', pay_your_bid: 'Each winner pays their own bid' };
/** The deposit sizes, smallest first, in zatoshis; throws a plain message. */
function tranches() {
  const t = $('#s-tranches').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean).map((x) => toZat(x, 'each deposit size'));
  if (t.length < 1 || t.length > 10) throw new Error('Please give 1 to 10 deposit sizes.');
  return [...new Set(t)].sort((a, b) => a - b);
}
function coinSending() {
  const c = document.querySelector('input[name=scoins]:checked');
  if (!c) throw new Error('Please choose when the small payments go out: at once, every few bids, or every few minutes.');
  if (c.value === 'at_once') return { mode: 'at_once' };
  const n = Number(c.value === 'every_bids' ? $('#s-coins-bids').value : $('#s-coins-min').value);
  if (!Number.isInteger(n) || n < 1) throw new Error('Please enter a whole number for the small payments.');
  // the same limits as the rules (1 to 1000 bids, 1 to 1440 minutes): refused here, before any wallet is made
  const most = c.value === 'every_bids' ? 1000 : 1440;
  if (n > most) throw new Error(c.value === 'every_bids' ? 'Please choose 1 to 1,000 bids for the small payments.' : 'Please choose 1 to 1,440 minutes (one day) for the small payments.');
  return { mode: c.value, n };
}

/** The coin sending choice in words, for the summary. */
function coinSendingText() {
  const c = document.querySelector('input[name=scoins]:checked');
  if (!c) return '<span class="dim">not chosen yet</span>';
  if (c.value === 'at_once') return 'At once, one payment per bid';
  const n = Number(c.value === 'every_bids' ? $('#s-coins-bids').value : $('#s-coins-min').value);
  if (!Number.isInteger(n) || n < 1) return '<span class="dim">not a whole number yet</span>';
  if (n > (c.value === 'every_bids' ? 1000 : 1440)) return `<span class="dim">${c.value === 'every_bids' ? 'at most 1,000 bids' : 'at most 1,440 minutes'}</span>`;
  return `Every ${n.toLocaleString('en-US')} ${c.value === 'every_bids' ? (n === 1 ? 'bid' : 'bids') : (n === 1 ? 'minute' : 'minutes')}, and at once near the cutoff`;
}

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
  if (mode() === 'sealed_auction') {
    let ts = '<span class="dim">not entered yet</span>';
    try { ts = tranches().map((t) => amountHTML(t, ticker)).join(', '); } catch { /* not numbers yet */ }
    $('#terms').innerHTML = [
      row('Type', 'Blind bid auction'),
      row('Items for sale', `${Number($('#s-items').value) || '<span class="dim">not entered yet</span>'}`),
      row('Deposit sizes', ts),
      row('How winners pay', SEALED_PRICING[sealedPricing()]),
      row('Small payments', coinSendingText()),
      row('Timing', sealedTiming() === 'quick' ? 'Quick test: blocks every 20 to 40 seconds, bids open 10 minutes after the deadline' : 'Standard'),
      row('Deadline', Number.isInteger(n) && n > 0 ? `${measured.tip != null ? `about block ${(measured.tip + n).toLocaleString('en-US')}` : `${n.toLocaleString('en-US')} blocks from now`}${time ? `, ${time} from now` : ''}` : '<span class="dim">not entered yet</span>'),
      row('Deposits accepted until', bidWindowText(n)),
      row('When bids open', 'The drand round is chosen from the chain when the auction is made: after the deadline, with room for slow blocks'),
      row('Network', config ? (config.network === 'main' ? 'Zcash Mainnet' : 'Testnet') : ''),
    ].join('');
    decorateAmounts($('#terms'));
    return;
  }
  $('#terms').innerHTML = [
    row('Type', mode() === 'raise' ? 'Fundraiser' : 'Auction'),
    row(mode() === 'raise' ? (cap != null ? 'Soft cap' : 'Goal') : 'Items for sale', goal),
    ...(cap != null ? [row('Hard cap', amountHTML(cap, ticker))] : []),
    ...(mode() === 'raise' ? [row('Early close', $('#early-close').checked ? 'Allowed once the goal is met' : 'Not allowed: the campaign closes after the deadline')] : []),
    ...(mode() === 'auction' ? [row('How winners pay', pricing() === 'uniform' ? 'Everyone who wins pays the same price (the lowest winning bid); the rest comes back' : 'Each winner pays their own bid')] : []),
    row('Smallest contribution', min),
    row('Deadline', Number.isInteger(n) && n > 0 ? `${measured.tip != null ? `about block ${(measured.tip + n).toLocaleString('en-US')} (now ${measured.tip.toLocaleString('en-US')}, plus ${n.toLocaleString('en-US')})` : `${n.toLocaleString('en-US')} blocks from now`}${time ? `, ${time} from now` : ''}` : '<span class="dim">not entered yet</span>'),
    row('Ticket window', Number.isInteger(Number($('#ticketk').value)) && Number($('#ticketk').value) > 0 ? `${Number($('#ticketk').value).toLocaleString('en-US')} blocks${etaText(Number($('#ticketk').value), measured.secondsPerBlock) ? `, ${etaText(Number($('#ticketk').value), measured.secondsPerBlock)}` : ''}` : '<span class="dim">not entered yet</span>'),
    row('Network', config ? (config.network === 'main' ? 'Zcash Mainnet' : 'Testnet') : ''),
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
    : t ? `That is ${t} from now (a block takes ≈${Math.round(measured.secondsPerBlock)} seconds, measured over the last ${measured.spanBlocks} blocks).`
      : 'The length of a block could not be measured just now, so no time estimate is shown.';
}

function ticketHint() {
  const k = Number($('#ticketk').value);
  const t = Number.isInteger(k) && k > 0 ? etaText(k, measured.secondsPerBlock) : null;
  if (mode() === 'sealed_auction') { $('#ticketk-hint').textContent = 'Each deposit must get its tickets within this many blocks; the recount flags a late one.'; return; }
  $('#ticketk-hint').textContent = `Every contribution must get its refund ticket within this many blocks (the recount flags a late one), and after the deadline you have this many blocks to close before contributors may claim their own refunds. A longer window gives you more slack and contributors a longer wait. Whole number, 10 to 1000.${t ? ` ${k} blocks is ${t}.` : ''}`;
}

function modeChanged() {
  ticketHint();
  const raise = mode() === 'raise', sealed = mode() === 'sealed_auction';
  $('#goal-row').hidden = !raise;
  $('#items-row').hidden = raise || sealed;
  $('#sealed-row').hidden = !sealed;
  $('#minimum-row').hidden = sealed;
  renderTerms();
}

async function onCreate(ev) {
  ev.preventDefault();
  const err = $('#setup-error');
  err.replaceChildren(); say(err, '');
  const btn = $('#create-btn');
  try {
    const m = mode();
    if (m === 'sealed_auction') {
      const windowError = bidWindowError(Number($('#deadline').value), Number($('#ticketk').value));
      if (windowError) throw new Error(windowError);
      const body = {
        mode: m, items: Number($('#s-items').value), tranches_zat: tranches(), pricing: sealedPricing(), coin_sending: coinSending(), timing: sealedTiming(),
        deadline_in: Number($('#deadline').value), ticket_k: Number($('#ticketk').value),
        relays: $('#relays').value.split('\n').map((x) => x.trim()).filter(Boolean),
      };
      if ($('#s-reserve').value.trim()) body.reserve_zat = toZat($('#s-reserve').value, 'the reserve price');
      const nm = $('#campaign-name').value.trim();
      if (nm) body.name = nm;
      btn.disabled = true; btn.textContent = 'Creating… this can take a few minutes';
      await api('campaigns', body);
      location.href = '/';
      return;
    }
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
  // the sealed bid auction only when this host program offers it (test network only for now)
  $('#sealed-choice').hidden = config.sealed !== true;
  // the quick test timing: test network only, and only from a host program that knows it (an older one would make a standard auction)
  $('#s-timing').hidden = config.network === 'main' || config.sealed_quick_timing !== true;
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
  for (const id of ['#goal', '#cap', '#items', '#minimum', '#deadline', '#ticketk', '#s-items', '#s-tranches']) $(id).addEventListener('input', () => { deadlineHint(); ticketHint(); renderTerms(); });
  for (const r of document.querySelectorAll('input[name=spricing]')) r.addEventListener('change', renderTerms);
  for (const r of document.querySelectorAll('input[name=scoins], input[name=stiming]')) r.addEventListener('change', renderTerms);
  // typing a number chooses its line
  for (const [id, v] of [['#s-coins-bids', 'every_bids'], ['#s-coins-min', 'every_minutes']]) {
    const pick = () => { document.querySelector(`input[name=scoins][value=${v}]`).checked = true; renderTerms(); };
    $(id).addEventListener('focus', pick);
    $(id).addEventListener('input', pick);
  }
  modeChanged(); deadlineHint(); ticketHint(); decorateAmounts(document.querySelector('main'));
  measured = await measureBlocks(config.network);
  deadlineHint(); ticketHint(); renderTerms(); decorateAmounts(document.querySelector('main'));
}

main().catch(() => { $('#banner').textContent = 'Something went wrong while loading this page. Please reload it.'; $('#banner').hidden = false; });
