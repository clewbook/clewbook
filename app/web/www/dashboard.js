// Host dashboard: function only. It shows what the host program reports and sends the two requests a host
// can make from here (watch, close); setting up a campaign is on its own page (setup.html). It never sets
// styles: it only toggles the `hidden` attribute and class names, and every look lives in ui.css and dashboard.css.
import { setup, decorateAmounts, checkRow, chipHTML, etaText, statusBadgeHTML, markReady } from './ui.js';
import { measureBlocks } from './blocktime.js';

const $ = (s) => document.querySelector(s);
let config = null;
let selected = null;
let timer = null;
let measured = { secondsPerBlock: null, spanBlocks: 0 }, measuredAt = 0;

async function api(path, body) {
  const init = body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body),
  };
  const res = await fetch(`/api/${path}`, init);
  const data = await res.json().catch(() => ({ ok: false, error: 'The host program sent an answer that could not be read.' }));
  if (!data.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function say(el, text) { el.textContent = text; el.hidden = !text; }

function coin(zat) {
  if (zat == null) return '';
  const whole = Math.floor(zat / 1e8), frac = zat % 1e8;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(8, '0')}`.replace(/0+$/, '');
}

function rows(dl, pairs) {
  dl.replaceChildren();
  for (const [k, v] of pairs) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v;
    dl.append(dt, dd);
  }
}

function list(ul, items, cls) {
  ul.replaceChildren();
  for (const it of items) {
    const li = document.createElement('li');
    li.textContent = typeof it === 'string' ? it : it.text;
    if (cls) li.className = cls(it);
    ul.append(li);
  }
}

const PHASE = {
  open: 'Open for contributions', deadline_passed: 'The deadline has passed; close the campaign',
  closed: 'Closed', unknown: 'Starting up',
};
const KICKER = { bad: 'Needs action', warn: 'Needs attention', info: 'Note' };
const CLASS = { bad: 'bad', warn: 'warn', info: 'info' };

/** The real next steps for the host, from what the program reports: nothing here is guessed. */
function todo(s) {
  const items = [];
  const bc = s.broadcasts || [];
  const waiting = bc.filter((b) => b.status !== 'confirmed' && b.status !== 'superseded');
  if (s.phase === 'unknown') items.push({ what: 'Wait for the first check of the network', state: 'starting up', cls: 'todo' });
  if (s.phase === 'open') {
    items.push({ what: 'Keep this program and this computer running', state: `until the deadline (block ${s.deadline_height})`, cls: 'todo' });
    items.push({ what: 'Close the campaign', state: 'after the deadline', cls: 'todo' });
  }
  if (s.phase === 'deadline_passed') items.push({ what: 'Close the campaign', state: 'now: you need an address for the money the campaign keeps', cls: 'bad' });
  if (s.phase === 'closed') {
    items.push({ what: 'Close the campaign', state: `done${s.outcome ? ` (${s.outcome.replace('_', ' ')})` : ''}`, cls: 'done' });
    if ((s.close_unfinished || []).length) items.push({ what: 'Finish the close', state: 'press Try again below', cls: 'bad' });
    items.push(waiting.length
      ? { what: `Wait for ${waiting.length} transaction${waiting.length === 1 ? '' : 's'} to be mined`, state: 'the program sends them again if a server drops one', cls: 'todo' }
      : { what: 'Every transaction the program sent is confirmed', state: bc.length ? 'done' : 'none were needed', cls: 'done' });
    items.push({ what: 'Share the recount link', state: 'so anyone can check the books', cls: 'todo' });
  }
  return items;
}

let currentId = null;
let current = null; // the status last shown

function render(s) {
  current = s;
  const ticker = s.ticker;
  $('#warnings-section').hidden = false;
  const wl = $('#warning-list');
  wl.replaceChildren(...s.warnings.map((w) => {
    const d = document.createElement('div');
    d.className = `notice ${CLASS[w.level] || 'info'} warn-${w.level}`;
    const k = document.createElement('div'); k.className = 'k'; k.textContent = KICKER[w.level] || 'Note';
    const p = document.createElement('p'); p.textContent = w.text;
    d.append(k, p);
    return d;
  }));
  $('#live').hidden = false;
  const left = s.blocks_left;
  const leftText = left > 0 ? etaText(left, measured.secondsPerBlock) : null;
  const leftPhrase = left > 0 ? (leftText ? `${leftText} left` : `${left} blocks left; the length of a block has not been measured yet`) : '';
  const pendingBc = (s.broadcasts || []).some((b) => b.status !== 'confirmed' && b.status !== 'superseded');
  $('#status-chip').innerHTML = statusBadgeHTML({ phase: s.phase === 'deadline_passed' ? 'ended' : s.phase, outcome: s.outcome, refunding: s.phase === 'closed' && s.outcome === 'goal_missed' && pendingBc });
  rows($('#facts'), [
    ['Campaign', s.name ? `${s.name} (${s.short}…)` : s.short + '…'],
    ['Type', s.mode === 'raise' ? 'Fundraiser' : 'Auction'],
    ['Status', PHASE[s.phase] + (s.outcome ? ` (${s.outcome.replace('_', ' ')})` : '')],
    ['Deadline', `block ${s.deadline_height}` + (leftPhrase ? ` (${leftPhrase})` : '')],
    ...(left > 0 && measured.secondsPerBlock ? [['Block time', `about ${Math.round(measured.secondsPerBlock)} seconds, measured over the last ${measured.spanBlocks} blocks`]] : []),
    // a fundraiser with a hard cap says "soft cap" and "hard cap"; one without keeps the word "goal"
    ...(s.mode !== 'raise' ? [['Items', String(s.items)]] : s.cap_zat == null ? [['Goal', `${coin(s.goal_zat)} ${ticker}`]] : [
      ['Soft cap', `${coin(s.goal_zat)} ${ticker}`],
      ['Hard cap', `${coin(s.cap_zat)} ${ticker}`],
      ...(s.over_cap ? [['Over the hard cap', `${coin(s.over_cap_zat)} ${ticker} in ${s.over_cap} payment(s), refunded by their own tickets at the close unless room frees up`]] : []),
    ]),
    ['Raised so far', `${coin(s.counts.raised_zat)} ${ticker}`],
    ['Ticket window', `${s.ticket_k} blocks`],
    ['Smallest contribution', `${coin(s.min_zat)} ${ticker}`],
    ['Network', s.network === 'main' ? 'Main network' : 'Test network (no real money)'],
    ['Last network check', s.last_check.seconds_ago == null ? 'not yet' : `${s.last_check.seconds_ago} seconds ago${s.last_check.ok ? '' : ' (failed)'}`],
  ]);
  const c = s.counts;
  const settle = (s.broadcasts || []).filter((b) => b.kind === 'settlement');
  rows($('#counts'), [
    ['Contributions received', String(c.contributions)],
    ['Refund tickets issued', `${c.tickets_issued}${c.reissues ? ` (${c.reissues} re-issued after a network upgrade)` : ''}`],
    ['Contributions locked in the wallet', `${c.locks_held} of ${c.locks_expected}`],
    ['Taken back by contributors early', String(c.withdrawn)],
    ['Payments set aside (message could not be opened)', String(c.rejects)],
    ['Donations (no valid message)', String(c.donations)],
    ['Entries in the public list', String(c.ledger_entries)],
    ...(settle.length ? [['Settlements confirmed', `${settle.filter((b) => b.status === 'confirmed').length} of ${settle.length}`]] : []),
  ]);
  const rl = $('#relay-list');
  rl.replaceChildren(...s.relays.map((r) => { const li = document.createElement('li'); li.textContent = `${r.url}: ${r.status}`; if (!/up to date|not checked yet/.test(r.status)) li.className = 'bad'; return li; }));
  if (s.self_check) {
    $('#check-list').replaceChildren(...s.self_check.results.map((r) => checkRow({ id: r.id, name: r.title, detail: r.pass ? '' : r.details.join('; '), status: r.pass ? 'pass' : 'fail' })));
  } else $('#check-list').textContent = 'Waiting for the first network check.';
  $('#contribute-link').textContent = s.contribute_link;
  currentId = s.id;
  $('#final-section').hidden = !s.final;
  if (s.final) $('#final-line').textContent = s.final.line;
  $('#recount-link').href = s.contribute_link.replace('/contribute.html#', '/recount.html#');
  $('#todo-list').replaceChildren(...todo(s).map((t) => {
    const li = document.createElement('li'); li.className = t.cls;
    const dot = document.createElement('span'); dot.className = 'dot';
    const what = document.createElement('span'); what.className = 'what'; what.textContent = t.what;
    const st = document.createElement('span'); st.className = 'state'; st.textContent = t.state;
    li.append(dot, what, st);
    return li;
  }));

  // closing
  const section = $('#close-section');
  section.hidden = s.phase === 'unknown';
  const explain = $('#close-explain');
  const btn = $('#close-btn');
  if (s.phase === 'closed') {
    const left = s.close_unfinished || [];
    // a close whose later steps did not all finish: one sentence, and the same button finishes them (nothing is sent twice)
    explain.textContent = left.length ? `Closed, but ${left.join(', ')} did not finish yet.` : 'This campaign is closed.';
    btn.hidden = !left.length; btn.disabled = s.closing; btn.textContent = 'Try again';
  } else if (s.phase === 'open' && s.can_close_early) {
    btn.textContent = 'Close early';
    explain.textContent = (s.cap_zat == null
      ? 'The goal is met, and this campaign\'s rules allow closing early. Closing now keeps the contributions and sends them to your address;'
      : 'The soft cap is met, and this campaign\'s rules allow closing early. Closing now keeps the contributions that fit under the hard cap and sends them to your address, and refunds any payment over it;') + ' contributors can no longer take theirs back, and payments after the close do not count.';
    btn.hidden = false; btn.disabled = s.closing;
  } else if (s.phase === 'open') {
    btn.textContent = 'Close the campaign';
    explain.textContent = s.early_close && s.close_early_reason
      ? `This campaign may close early once its ${s.cap_zat == null ? 'goal' : 'soft cap'} is met. Not yet: ${s.close_early_reason}.`
      : `You can close the campaign after the deadline (block ${s.deadline_height}${leftPhrase ? `, ${leftPhrase}` : ''}).`;
    btn.hidden = false; btn.disabled = true;
  } else {
    btn.textContent = 'Close the campaign';
    explain.textContent = s.mode === 'raise'
      ? (s.cap_zat == null
        ? 'If the goal was reached, the money is sent to your address and nothing else changes. If not, every contributor is refunded.'
        : 'If the soft cap was reached, the contributions that fit under the hard cap are sent to your address and any payment over it is refunded by its own ticket. If not, every contributor is refunded.')
      : s.pricing === 'uniform'
        ? 'Each winner pays the price into this campaign\'s treasury wallet (a folder whose name starts with treasury, inside the campaign folder) and gets the rest back; everyone else is refunded. The viewing key is revealed so anyone can check the result. No address is needed below.'
        : 'The winning bids are sent to your address and everyone else is refunded. The viewing key is revealed so anyone can check the result.';
    btn.hidden = false; btn.disabled = s.closing;
  }
  list($('#close-log'), s.close_log || []);
  const words = { sent: 'sent, waiting', resent: 're-sent, waiting', confirmed: 'confirmed', superseded: 'the coin was spent by another transaction', dead: 'could not be mined (network changed); being rebuilt' };
  const bl = $('#broadcast-list');
  bl.replaceChildren(...(s.broadcasts || []).map((b) => {
    const li = document.createElement('li');
    li.className = `bc-${b.status}${b.status === 'confirmed' ? ' done' : b.status === 'dead' || b.status === 'superseded' ? ' bad' : ''}`;
    const dot = document.createElement('span'); dot.className = 'dot';
    const what = document.createElement('span'); what.className = 'what'; what.textContent = b.label;
    const st = document.createElement('span'); st.className = 'state';
    st.textContent = `${b.status === 'confirmed' ? `confirmed in block ${b.mined_height}` : words[b.status] || b.status}${b.sends > 1 && b.status !== 'resent' ? ` (sent ${b.sends} times)` : ''}${b.status === 'resent' ? ` (sent ${b.sends} times)` : ''}`;
    li.append(dot, what, st);
    return li;
  }));
  decorateAmounts(document.querySelector('main'));
}

async function refresh() {
  try {
    say($('#banner'), '');
    const { campaigns } = await api('campaigns');
    const sel = $('#campaign-select');
    $('#no-campaigns').hidden = campaigns.length > 0;
    sel.hidden = campaigns.length === 0;
    if (!selected && campaigns.length) selected = campaigns[0].id;
    sel.replaceChildren(...campaigns.map((c) => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = `${c.name || c.short + '…'} (${c.mode === 'raise' ? 'fundraiser' : 'auction'}, ${c.phase.replace('_', ' ')})`;
      o.selected = c.id === selected;
      return o;
    }));
    if (selected && campaigns.some((c) => c.id === selected)) render(await api(`campaigns/${selected}`));
    else { $('#live').hidden = true; $('#close-section').hidden = true; $('#warnings-section').hidden = true; }
  } catch (e) {
    const b = $('#banner');
    say(b, "The dashboard can't reach the host program right now. Start it with: cb-host serve");
  }
}

function modeChanged() {
  const raise = document.querySelector('input[name=mode]:checked').value === 'raise';
  $('#goal-row').hidden = !raise;
  $('#items-row').hidden = raise;
}

function deadlineHint() {
  const n = Number($('#deadline').value);
  $('#deadline-hint').textContent = Number.isInteger(n) && n > 0 ? `That is ${eta(n)} from now (a block takes about ${config?.seconds_per_block || 25} seconds).` : '';
}

async function onCreate(ev) {
  ev.preventDefault();
  const err = $('#setup-error');
  say(err, '');
  const btn = $('#create-btn');
  try {
    const mode = document.querySelector('input[name=mode]:checked').value;
    const body = {
      mode,
      deadline_in: Number($('#deadline').value),
      min_contribution_zat: toZat($('#minimum').value, 'the smallest contribution'),
      relays: $('#relays').value.split('\n').map((x) => x.trim()).filter(Boolean),
    };
    if (mode === 'raise') body.goal_zat = toZat($('#goal').value, 'the goal');
    else body.items = Number($('#items').value);
    btn.disabled = true; btn.textContent = 'Creating… this can take a minute';
    const r = await api('campaigns', body);
    selected = r.id;
    $('#setup').hidden = true; $('#setup-form').reset();
    await refresh();
  } catch (e) {
    say(err, e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Create campaign';
  }
}

async function onCloseNow() {
  const err = $('#close-error');
  say(err, '');
  const btn = $('#close-yes');
  btn.disabled = true; btn.textContent = 'Closing… this can take a few minutes';
  try {
    const r = await api(`campaigns/${selected}/close`, { sweep_to: $('#sweep-to').value, confirm_mainnet: config && config.network === 'main' ? $('#confirm-mainnet-close').checked : undefined });
    list($('#close-log'), r.log);
    $('#close-confirm').hidden = true;
    await refresh();
  } catch (e) {
    say(err, e.message);
  } finally {
    btn.disabled = config && config.network === 'main' && !$('#confirm-mainnet-close').checked; btn.textContent = 'Close now';
  }
}

/** Finishes a close whose later steps did not all finish. */
async function onFinishClose() {
  const err = $('#close-error'), btn = $('#close-btn');
  btn.disabled = true; btn.textContent = 'Finishing…';
  try {
    const r = await api(`campaigns/${selected}/close`, {});
    list($('#close-log'), r.log);
    say($('#close-finish-error'), '');
  } catch (e) {
    say($('#close-finish-error'), e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Try again';
    say(err, '');
    await refresh();
  }
}

/** Downloads the campaign's public copy (rules + signed list) as one file, for the recount page's "saved copy" option. */
async function exportCopy() {
  const err = $('#export-error'); err.hidden = true;
  try {
    const res = await fetch(`api/campaigns/${currentId}/export`, { headers: { 'x-dashboard': '1' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`The program answered ${res.status}.`);
    const blob = new Blob([await res.text()], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `campaign-${currentId.slice(0, 8)}-public-copy.json`;
    document.body.append(a); a.click(); a.remove();
  } catch (e) { err.textContent = `The copy could not be made: ${e.message || e}`; err.hidden = false; }
}

async function main() {
  setup('Host dashboard'); markReady(); // a page on this computer: nothing to wait for
  try { config = await api('config'); } catch { /* shown by refresh */ }
  if (config && config.network === 'main') { $('#mainnet-banner').hidden = false; $('#confirm-close-row').hidden = false; $('#close-yes').disabled = true; $('#confirm-mainnet-close').addEventListener('change', () => { $('#close-yes').disabled = !$('#confirm-mainnet-close').checked; }); }
  if (config) { if (config.network === 'main') $('#net-note').remove(); else $('#net-note').textContent = 'Test network: no real money.'; }
  const measure = async () => { const m = await measureBlocks(config ? config.network : 'test'); if (m.secondsPerBlock) { measured = m; } measuredAt = Date.now(); };
  measure().then(refresh);
  $('#campaign-select').addEventListener('change', (e) => { selected = e.target.value; refresh(); });
  $('#close-btn').addEventListener('click', () => {
    if (current && current.phase === 'closed') { onFinishClose(); return; } // "Try again": the address and the confirmation were given at the first close
    $('#close-confirm-text').textContent = 'This cannot be undone. Closing records the result for everyone to see, sends the money the campaign keeps to the address below, and sends refunds to the others.';
    $('#close-confirm').hidden = false;
  });
  $('#close-no').addEventListener('click', () => { $('#close-confirm').hidden = true; });
  $('#close-yes').addEventListener('click', onCloseNow);
  $('#export-btn').addEventListener('click', exportCopy);
  $('#copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#contribute-link').textContent); $('#copy-link').textContent = 'Copied'; } catch { $('#copy-link').textContent = 'Select the link and copy it'; }
  });
  await refresh();
  timer = setInterval(() => { if (Date.now() - measuredAt > 600000) measure(); refresh(); }, 5000);
}

main();
