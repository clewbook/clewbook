// Host dashboard: function only. It shows what the host program reports and sends the requests a host
// can make from here (close, submit for listing); setting up a campaign is on its own page (setup.html). It never sets
// styles: it only toggles the `hidden` attribute and class names, and every look lives in ui.css and dashboard.css.
import { setup, setNetwork, decorateAmounts, checkRow, chipHTML, etaText, statusBadgeHTML, outcomeWords, markReady } from './ui.js';
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
// design round 2: the four tiles at the top say the phase in two or three words (the full sentence stays in the Status details below)
const TILE_PHASE = { open: 'Open', deadline_passed: 'Deadline passed', closed: 'Closed', unknown: 'Starting up' };

/** A sealed bid auction's deposits in words: how many it had, and once closed whether they are all paid out; never a bare 0 before the
 *  count exists (the first check after a start), which would read as if nobody bid. */
function depositsText(s) {
  const z = s.sealed;
  if (z.deposits == null) return 'counting…';
  if (!z.closed) return String(z.deposits);
  if (z.deposits === 0) return '0 · nobody bid';
  // the viewing key is published only once every winner's settlement is mined and every other deposit is on its way back
  return `${z.deposits} · ${z.revealed ? 'all settled or refunded' : 'settling'}`;
}

/** Design round 2: the tiles (status, raised, goal or items, self-check), from the same report the details below show. */
function tiles(s) {
  const t = (k, v, cls = '') => { const d = document.createElement('div'); d.className = `dtile ${cls}`; const a = document.createElement('span'); a.className = 'tk'; a.textContent = k; const b = document.createElement('span'); b.className = 'tv'; b.textContent = v; d.append(a, b); return d; };
  const raised = s.counts.raised_zat;
  const res = s.self_check ? s.self_check.results : null;
  const fails = res ? res.filter((r) => !r.pass).length : 0;
  $('#dtiles').replaceChildren(
    t('Status', TILE_PHASE[s.phase] + (s.outcome ? ` · ${outcomeWords(s.outcome, s.mode === 'raise' && s.cap_zat != null)}` : ''), `ph-${s.phase}`),
    s.sealed ? t('Deposits', depositsText(s)) : t('Raised', `${coin(raised)} ${s.ticker}`),
    s.mode === 'raise'
      ? t(s.cap_zat == null ? 'Goal' : 'Soft cap', `${coin(s.goal_zat)} ${s.ticker}${raised >= s.goal_zat ? ' · met' : ''}`, raised >= s.goal_zat ? 'met' : '')
      : t('Items', String(s.items)),
    t('Self check', res ? (fails ? `${fails} ✕` : `${res.length} ✓`) : 'waiting', res ? (fails ? 'bad' : 'good') : ''),
  );
}
const CLASS = { bad: 'bad', warn: 'warn', info: 'info' };

/** The real next steps for the host, from what the program reports: nothing here is guessed. */
function todo(s) {
  const items = [];
  const bc = s.broadcasts || [];
  const waiting = bc.filter((b) => b.status !== 'confirmed' && b.status !== 'superseded');
  if (s.phase === 'unknown') items.push({ what: 'Wait for the first check of the network', state: 'starting up', cls: 'todo' });
  if (s.phase === 'open') {
    items.push({ what: 'Keep this program and this computer running', state: s.sealed ? 'until the bids are revealed' : `until the deadline (block ${s.deadline_height})`, cls: 'todo' });
    items.push({ what: 'Close the campaign', state: 'after the deadline', cls: 'todo' });
  }
  if (s.sealed && s.phase === 'open') items.push(s.sealed.coin_balance_zat ? { what: 'Keep the coin wallet funded', state: `${coin(s.sealed.coin_balance_zat)} ${s.ticker} left for the small payments`, cls: 'todo' } : { what: 'Fund the coin wallet from your own money', state: 'the small payments go out from it', cls: 'bad' });
  if (s.phase === 'deadline_passed') items.push(s.sealed
    ? { what: 'Close the auction', state: `once drand round ${s.sealed.round} is out, and before block ${s.sealed.claim_after + 1}`, cls: 'bad' }
    : { what: 'Close the campaign', state: 'now: you need an address for the money the campaign keeps', cls: 'bad' });
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
let campaignList = []; // every campaign on this host, with its phase (from the list the page refreshes)
let current = null; // the status last shown

// Closing a note: it stays hidden until its message changes (then it may show again). A note that needs action, the kind about money,
// is hidden for this page load only and comes back on the next.
const DISMISSED_KEY = 'cb-dismissed-notes';
const dismissedNow = new Set();
const dismissedSaved = (() => { try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); } catch { return new Set(); } })();
const noteKey = (w) => `${current && current.id}|${w.level}|${w.text}`; // per campaign (current is the status being drawn)
const isDismissed = (w) => dismissedNow.has(noteKey(w)) || (w.level !== 'bad' && dismissedSaved.has(noteKey(w)));
function dismissNote(w) {
  dismissedNow.add(noteKey(w));
  if (w.level !== 'bad') {
    dismissedSaved.add(noteKey(w));
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissedSaved].slice(-200))); } catch { /* hidden for this page load only */ }
  }
  if (current) render(current);
}

function render(s) {
  current = s;
  const ticker = s.ticker;
  $('#warnings-section').hidden = false;
  const wl = $('#warning-list');
  // "keep this program running": while this campaign is not closed, or while another campaign on this host still needs it
  const othersNeedHost = campaignList.filter((c) => c.id !== s.id && c.phase !== 'closed').length;
  const shown = s.warnings.flatMap((w) => {
    if (w.kind !== 'keep_running' || s.phase !== 'closed') return [w];
    return othersNeedHost ? [{ ...w, text: `Keep this program and this computer running: ${othersNeedHost} other campaign(s) on this host are open or waiting to close, and tickets are only issued while it runs.` }] : [];
  });
  wl.replaceChildren(...shown.filter((w) => !isDismissed(w)).map((w) => {
    const d = document.createElement('div');
    d.className = `notice closable ${CLASS[w.level] || 'info'} warn-${w.level}`;
    const k = document.createElement('div'); k.className = 'k'; k.textContent = KICKER[w.level] || 'Note';
    const p = document.createElement('p'); p.textContent = w.text;
    const x = Object.assign(document.createElement('button'), { type: 'button', className: 'note-x', textContent: '×', title: w.level === 'bad' ? 'Close (it comes back when the page is loaded again)' : 'Close (it comes back if its message changes)' });
    x.setAttribute('aria-label', 'Hide note');
    x.addEventListener('click', () => dismissNote(w));
    d.append(k, p, x);
    return d;
  }));
  $('#live').hidden = false; $('#dmore').hidden = false;
  tiles(s);
  const left = s.blocks_left;
  const leftText = left > 0 ? etaText(left, measured.secondsPerBlock) : null;
  const leftPhrase = left > 0 ? (leftText ? `${leftText} left` : `${left} blocks left; the length of a block has not been measured yet`) : '';
  const pendingBc = (s.broadcasts || []).some((b) => b.status !== 'confirmed' && b.status !== 'superseded');
  $('#status-chip').innerHTML = statusBadgeHTML({ phase: s.phase === 'deadline_passed' ? 'ended' : s.phase, outcome: s.outcome, refunding: s.phase === 'closed' && s.outcome === 'goal_missed' && pendingBc, soft: s.mode === 'raise' && s.cap_zat != null }); // a capped fundraiser says soft cap
  rows($('#facts'), [
    ['Campaign', s.name ? `${s.name} (${s.short}…)` : s.short + '…'],
    ['Type', s.mode === 'raise' ? 'Fundraiser' : 'Auction'],
    ['Status', PHASE[s.phase] + (s.outcome ? ` (${s.outcome.replace('_', ' ')})` : '')],
    ['Deadline', `block ${s.deadline_height}` + (leftPhrase ? ` (${leftPhrase})` : '')],
    ...(left > 0 && measured.secondsPerBlock ? [['Block time', `≈${Math.round(measured.secondsPerBlock)} seconds, measured over the last ${measured.spanBlocks} blocks`]] : []),
    // a fundraiser with a hard cap says "soft cap" and "hard cap"; one without keeps the word "goal"
    ...(s.mode !== 'raise' ? [['Items', String(s.items)]] : s.cap_zat == null ? [['Goal', `${coin(s.goal_zat)} ${ticker}`]] : [
      ['Soft cap', `${coin(s.goal_zat)} ${ticker}`],
      ['Hard cap', `${coin(s.cap_zat)} ${ticker}`],
      ...(s.over_cap ? [['Over the hard cap', `${coin(s.over_cap_zat)} ${ticker} in ${s.over_cap} payment(s), refunded by their own tickets at the close unless room frees up`]] : []),
    ]),
    ['Raised so far', `${coin(s.counts.raised_zat)} ${ticker}`],
    ['Ticket window', `${s.ticket_k} blocks`],
    ['Smallest contribution', `${coin(s.min_zat)} ${ticker}`],
    ['Network', s.network === 'main' ? 'Main network' : 'Testnet'],
    ['Last network check', s.last_check.seconds_ago == null ? 'not yet' : `${s.last_check.seconds_ago} seconds ago${s.last_check.ok ? '' : ' (failed)'}`],
  ]);
  const c = s.counts;
  const settle = (s.broadcasts || []).filter((b) => b.kind === 'settlement');
  rows($('#counts'), [
    ['Contributions received', String(c.contributions)],
    ['Refund tickets issued', `${c.tickets_issued}${c.reissues ? ` (${c.reissues} reissued after a network upgrade)` : ''}`],
    ['Contributions locked in the wallet', `${c.locks_held} of ${c.locks_expected}`],
    ['Taken back by contributors early', String(c.withdrawn)],
    [s.sealed ? 'Payments rejected (sent back on their own)' : 'Payments set aside (message could not be opened)', String(c.rejects)],
    ['Donations (no valid message)', String(c.donations)],
    ['Entries in the public list', String(c.ledger_entries)],
    ...(settle.length ? [['Settlements confirmed', `${settle.filter((b) => b.status === 'confirmed').length} of ${settle.length}`]] : []),
  ]);
  if (s.sealed) {
    const z = s.sealed, sending = z.coin_sending.mode === 'at_once' ? 'at once' : z.coin_sending.mode === 'every_bids' ? `every ${z.coin_sending.n} bids` : `every ${z.coin_sending.n} minutes`;
    const words = { uniform: 'everyone who wins pays the lowest winning bid', second: 'everyone who wins pays the highest losing bid', pay_your_bid: 'each winner pays their own bid' };
    rows($('#facts'), [
      ['Campaign', s.name ? `${s.name} (${s.short}…)` : s.short + '…'],
      ['Type', 'Blind bid auction'],
      ['Status', PHASE[s.phase] + (s.outcome ? ` (${s.outcome.replace('_', ' ')})` : '')],
      ['Items', String(z.items)],
      ['Deposit sizes', z.tranches_zat.map((t) => `${coin(t)} ${ticker}`).join(', ')],
      ['How winners pay', words[z.pricing]],
      ['Deadline', `block ${s.deadline_height}` + (leftPhrase ? ` (${leftPhrase})` : '')],
      ['Small payments', `${sending}; all by block ${z.cutoff}`],
      ['Bids open with', `drand round ${z.round} (${new Date(z.round_time * 1000).toUTCString()})`],
      ...(z.timing === 'quick' ? [['Timing', 'Quick test: blocks every 20 to 40 seconds, bids open 10 minutes after the deadline']] : []),
      ['Close before', `block ${z.claim_after + 1}: from then on everyone can take their deposit back with their late ticket`],
      ['Coin wallet', z.coin_address ? `${z.coin_address}` : 'unknown'],
      ['Coin wallet balance', z.coin_balance_zat == null ? 'not read yet' : `${coin(z.coin_balance_zat)} ${ticker} (as of its last check)`],
      ['Network', s.network === 'main' ? 'Main network' : s.network === 'regtest' ? 'Private test chain' : 'Testnet'],
      ['Last network check', s.last_check.seconds_ago == null ? 'not yet' : `${s.last_check.seconds_ago} seconds ago${s.last_check.ok ? '' : ' (failed)'}`],
    ]);
    rows($('#counts'), [
      ['Deposits', depositsText(s)],
      ['Taken back before the deadline', z.withdrawn == null ? 'counting…' : String(z.withdrawn)],
      ['Small payments sent', String(z.coins_sent)],
      ...(z.late_returns ? [['Too late to bid or without tickets, sent back', `${z.late_returns} (${z.late_returns_confirmed} confirmed)`]] : []),
      // payments without a bid message the auction can read: not bids, they stay in the auction wallet (the public recount flags them)
      ['Payments not in the auction', String((z.not_in_auction || []).length)],
      ...(z.not_in_auction || []).map((p) => [`Not in the auction (${p.reason})`, `${coin(p.value_zat)} ${ticker}, block ${p.height}, transaction ${p.txid}`]),
      ['Entries in the public list', String(s.counts.ledger_entries)],
      ...(z.closed ? [
        ['Result', z.outcome === 'void' ? 'void: every deposit goes back' : `${z.winners} winner(s)${z.price_zat != null ? `, price ${coin(z.price_zat)} ${ticker}` : ''}`],
        ['Settlements', `${z.settlements} written, ${z.settlements_confirmed} confirmed`],
        ['Signed refunds', `${z.refunds_sent} sent, ${z.refunds_confirmed} confirmed`],
        ['Viewing key', z.revealed ? 'published' : 'not yet: after every settlement is mined'],
      ] : []),
    ]);
  }
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
    explain.textContent = left.length ? `${s.cancelled ? 'Cancelled' : 'Closed'}, but ${left.join(', ')} did not finish yet.` : s.cancelled ? 'Cancelled. Every contributor gets their money back, minus the network fee.' : 'This campaign is closed.';
    $('#next-title').textContent = 'Closed';
    btn.hidden = !left.length; btn.disabled = s.closing; btn.textContent = 'Try again';
  } else if (s.phase === 'open' && s.can_close_early) {
    btn.textContent = 'Close early'; $('#next-title').textContent = 'Close early';
    explain.textContent = (s.cap_zat == null
      ? 'The goal is met, and this campaign\'s rules allow closing early. Closing now keeps the contributions and sends them to your address;'
      : 'The soft cap is met, and this campaign\'s rules allow closing early. Closing now keeps the contributions that fit under the hard cap and sends them to your address, and refunds any payment over it;') + ' contributors can no longer take theirs back, and payments after the close do not count.';
    btn.hidden = false; btn.disabled = s.closing;
  } else if (s.phase === 'open') {
    btn.textContent = 'Close the campaign'; $('#next-title').textContent = 'Close the campaign';
    explain.textContent = s.early_close && s.close_early_reason
      ? `This campaign may close early once its ${s.cap_zat == null ? 'goal' : 'soft cap'} is met. Not yet: ${s.close_early_reason}.`
      : `You can close the campaign after the deadline (block ${s.deadline_height}${leftPhrase ? `, ${leftPhrase}` : ''}).`;
    btn.hidden = false; btn.disabled = true;
  } else {
    btn.textContent = 'Close the campaign'; $('#next-title').textContent = 'Close the campaign';
    explain.textContent = s.mode === 'raise'
      ? (s.cap_zat == null
        ? 'If the goal was reached, the money is sent to your address and nothing else changes. If not, every contributor is refunded.'
        : 'If the soft cap was reached, the contributions that fit under the hard cap are sent to your address and any payment over it is refunded by its own ticket. If not, every contributor is refunded.')
      : s.pricing === 'uniform'
        ? 'Each winner pays the price into this campaign\'s treasury wallet (a folder whose name starts with treasury, inside the campaign folder) and gets the rest back; everyone else is refunded. The viewing key is revealed so anyone can check the result. No address is needed below.'
        : 'The winning bids are sent to your address and everyone else is refunded. The viewing key is revealed so anyone can check the result.';
    btn.hidden = false; btn.disabled = s.closing;
  }
  if (s.sealed && s.phase !== 'closed') {
    // the bids open at round R's time: until then the Close button stays off, and the page says when, in this computer's time
    const wait = s.sealed.round_time - Date.now() / 1000;
    const when = `${new Date(s.sealed.round_time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${wait > 0 ? `, in about ${Math.max(1, Math.ceil(wait / 60))} minute(s)` : ''}`;
    explain.textContent = s.phase === 'open'
      ? `You can close the auction after the deadline (block ${s.deadline_height}) once drand round ${s.sealed.round} is out, at ${when}, and before block ${s.sealed.claim_after + 1}.`
      : wait > 0
        ? `The bids open with drand round ${s.sealed.round} at ${when}. The Close button turns on then; close before block ${s.sealed.claim_after + 1}.`
        : `Closing fetches drand round ${s.sealed.round}, opens every bid, settles the winners into the auction's treasury and sends everyone else their signed refund. Once the settlements are mined the viewing key is published. No address is needed.`;
    if (s.phase === 'deadline_passed' && wait > 0) btn.disabled = true;
  } else if (s.sealed && !s.sealed.revealed) {
    explain.textContent = 'Closed. The program finishes on its own: settlements, refunds, then the viewing key once every settlement is mined.';
    btn.hidden = true;
  }
  // after the close of a blind bid auction: the prices wait in its treasury wallet; one line and a button send them on
  const tz = s.sealed && s.phase === 'closed' && s.self_check ? s.self_check.treasury_send_zat : 0;
  $('#treasury-send').hidden = !tz;
  if (tz) $('#treasury-line').textContent = `The treasury holds ${coin(s.self_check.treasury_zat)} ${s.ticker}. Send ${coin(tz)} ${s.ticker} (after the network fee) to your wallet:`;
  // the owner's request (22 Oct 2026): what is left in the coin wallet goes back to the host's own wallet, once the auction is closed or no bid
  // waits for its small payment (the host program refuses it otherwise and says why)
  const cz = s.sealed ? s.sealed.coins_back_zat || 0 : 0;
  $('#coins-send').hidden = !(cz || (s.sealed && s.phase === 'closed'));
  if (!cz) $('#coins-line').textContent = 'Send what is left in the coin wallet, after the network fee, to your wallet (the program reads the wallet again first):';
  else $('#coins-line').textContent = `The coin wallet holds ${coin(s.sealed.coin_balance_zat)} ${s.ticker}. ${s.phase === 'closed' ? 'The auction is closed, so it is no longer needed.' : 'Send it back only when no bid waits for its small payment; later bids before the coin cutoff would then get none.'} Send ${coin(cz)} ${s.ticker} (after the network fee) to your wallet:`;
  // cancel and refund everyone (a fundraiser that opted in, before its deadline): two steps, three on mainnet
  $('#cancel-box').hidden = !s.can_cancel;
  if (!s.can_cancel) $('#cancel-confirm').hidden = true;
  $('#cancel-mainnet-line').hidden = $('#cancel-mainnet-row').hidden = s.network !== 'main';
  list($('#close-log'), s.close_log || []);
  const words = { sent: 'sent, waiting', resent: 'resent, waiting', confirmed: 'confirmed', superseded: 'the coin was spent by another transaction', dead: 'could not be mined (network changed); being rebuilt' };
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
  renderListing(s);
  decorateAmounts(document.querySelector('main'));
}

const ISSUE = 'https://github.com/clewbook/clewbook/issues/new?title=Host%20with%20us';

/** The listing section: the last answer kept for this campaign, and what the request would hold (shown in the confirm box). */
function renderListing(s) {
  $('#listing-section').hidden = false;
  const l = s.listing;
  const box = $('#listing-result');
  box.hidden = !l;
  $('#listing-btn').textContent = l && l.state === 'sent' ? 'Send again' : 'Submit for listing';
  if (l) {
    const sent = l.state === 'sent';
    box.className = `notice ${sent ? 'info' : 'bad'}`;
    $('#listing-result-k').textContent = sent ? 'Sent' : 'Not listed';
    $('#listing-result-text').textContent = sent ? 'Sent, waiting for approval.' : l.message;
    const fp = $('#listing-result-fp');
    fp.hidden = !(sent && l.fingerprint);
    if (sent && l.fingerprint) {
      fp.replaceChildren('Your host fingerprint: ', Object.assign(document.createElement('b'), { textContent: l.fingerprint }), '. Send it to the Clewbook team ',
        Object.assign(document.createElement('a'), { href: ISSUE, textContent: 'with a short note about you', target: '_blank', rel: 'noopener' }), ' so they can approve it.');
    }
    $('#listing-result-mainnet').hidden = !(sent && l.network === 'main');
    $('#listing-result-more').textContent = `${sent ? `The listing server said: ${l.message}. ` : ''}${l.at ? `Sent ${new Date(l.at * 1000).toLocaleString()}.` : ''}${sent ? ' Sending again replaces the earlier request.' : ''}`;
    // the last answer to "Check status" (state and reason from the listing server's last pass)
    const c = l.checked;
    $('#listing-status').hidden = !c;
    if (c) {
      $('#listing-status-state').textContent = `Status: ${c.state}.`;
      $('#listing-status-reason').textContent = c.reason ? `${c.reason.charAt(0).toUpperCase()}${c.reason.slice(1)}.` : '';
      $('#listing-status-at').textContent = `Checked ${new Date(c.at * 1000).toLocaleString()}.`;
    }
  }
  $('#listing-mainnet-line').hidden = s.network !== 'main';
  if (config) $('#listing-url').textContent = config.listing_url;
  const fp = config && config.host_fingerprint;
  const item = (t) => { const li = document.createElement('li'); li.textContent = t; return li; };
  $('#listing-what').replaceChildren(
    item(`The campaign: ${s.id}`),
    item(`Its relays: ${s.relays.map((r) => r.url).join(', ')}`),
    item(fp ? `Your host public key, with its fingerprint ${fp}` : 'Your host public key and its fingerprint. The key is made on this computer the first time you send (the file host_key.json in this program\'s runs folder, readable only by you) and is used for all your campaigns.'),
    item('Two signatures: one by your host key, one by this campaign\'s own key'),
  );
}

async function onListingCheck() {
  const err = $('#listing-check-error'), btn = $('#listing-check');
  say(err, '');
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    await api(`campaigns/${selected}/listing-status`, {});
    await refresh();
  } catch (e) {
    say(err, e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Check status';
  }
}

async function onListingSend() {
  const err = $('#listing-error'), btn = $('#listing-yes');
  say(err, '');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    await api(`campaigns/${selected}/listing`, { confirm: true, label: $('#listing-label').value });
    $('#listing-confirm').hidden = true;
    try { config = await api('config'); } catch { /* the fingerprint shows on the next refresh */ }
    await refresh();
  } catch (e) {
    say(err, e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Send the request';
  }
}

async function refresh() {
  try {
    say($('#banner'), '');
    const { campaigns } = await api('campaigns');
    campaignList = campaigns;
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
    // the owner's rule (22 Oct 2026): the prices a closed blind bid auction collected should not sit in its treasury on this computer
    const waiting = campaigns.filter((c) => c.treasury_send_zat > 0);
    const rem = $('#treasury-reminder');
    rem.hidden = !waiting.length;
    if (waiting.length) rem.textContent = `Reminder: ${waiting.map((c) => `${coin(c.treasury_send_zat)} ${config ? config.ticker : ''} from ${c.name || c.short + '…'}`).join(', ')} ${waiting.length === 1 ? 'is' : 'are'} still in ${waiting.length === 1 ? 'its' : 'their'} treasury on this computer. Open ${waiting.length === 1 ? 'it' : 'each'} and press "Send to my wallet".`;
    if (selected && campaigns.some((c) => c.id === selected)) render(await api(`campaigns/${selected}`));
    else { $('#live').hidden = true; $('#dmore').hidden = true; $('#close-section').hidden = true; $('#warnings-section').hidden = true; $('#listing-section').hidden = true; }
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
  $('#deadline-hint').textContent = Number.isInteger(n) && n > 0 ? `That is ${eta(n)} from now (a block takes ≈${config?.seconds_per_block || 25} seconds).` : '';
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
  setup('Host dashboard', { netbar: false, host: true }); markReady(); // a page on this computer: nothing to wait for; the network is a small tag here (design round 2)
  $('#dh-host').textContent = `Your computer · ${location.host}`;
  try { config = await api('config'); } catch { /* shown by refresh */ }
  if (config) setNetwork(config.network); // no bar on the dashboard (it has the small tag); this sets the page's network flag, so amounts follow it
  if (config) { const tag = $('#net-tag'); tag.textContent = config.network === 'main' ? 'ZCASH MAINNET' : 'TESTNET'; tag.classList.add(config.network === 'main' ? 'main' : 'test'); tag.hidden = false; }
  if (config && config.network === 'main') { $('#mainnet-banner').hidden = false; $('#confirm-close-row').hidden = false; $('#close-mainnet-line').hidden = false; $('#close-yes').disabled = true; $('#confirm-mainnet-close').addEventListener('change', () => { $('#close-yes').disabled = !$('#confirm-mainnet-close').checked; }); }
  if (config) { if (config.network === 'main') $('#net-note').remove(); else $('#net-note').textContent = 'Test network: no real money.'; }
  const measure = async () => { const m = await measureBlocks(config ? config.network : 'test'); if (m.secondsPerBlock) { measured = m; } measuredAt = Date.now(); };
  measure().then(refresh);
  $('#campaign-select').addEventListener('change', (e) => { selected = e.target.value; $('#listing-confirm').hidden = true; say($('#listing-check-error'), ''); refresh(); });
  $('#treasury-btn').addEventListener('click', async () => {
    const btn = $('#treasury-btn'), out = $('#treasury-result');
    btn.disabled = true; say(out, 'Sending…');
    try {
      const r = await api(`campaigns/${selected}/treasury-send`, { address: $('#treasury-to').value });
      say(out, `Sent. Transaction ${r.txid}`);
    } catch (e) { say(out, e.message); }
    btn.disabled = false;
  });
  $('#coins-btn').addEventListener('click', async () => {
    const btn = $('#coins-btn'), out = $('#coins-result');
    btn.disabled = true; say(out, 'Sending…');
    try {
      const r = await api(`campaigns/${selected}/coins-send`, { address: $('#coins-to').value });
      say(out, `Sent. Transaction ${r.txid}`);
    } catch (e) { say(out, e.message); }
    btn.disabled = false;
  });
  $('#cancel-btn').addEventListener('click', () => { say($('#cancel-error'), ''); $('#cancel-mainnet').checked = false; $('#cancel-confirm').hidden = false; });
  $('#cancel-no').addEventListener('click', () => { $('#cancel-confirm').hidden = true; });
  $('#cancel-yes').addEventListener('click', async () => {
    const main = current && current.network === 'main';
    if (main && !$('#cancel-mainnet').checked) { say($('#cancel-error'), 'Tick the box first: on mainnet this sends real money back.'); return; }
    const btn = $('#cancel-yes'); btn.disabled = true; say($('#cancel-error'), '');
    try {
      await api(`campaigns/${selected}/cancel`, { confirm: true, confirm_mainnet: main });
      $('#cancel-confirm').hidden = true;
      await refresh();
    } catch (e) { say($('#cancel-error'), e.message); } finally { btn.disabled = false; }
  });
  $('#close-btn').addEventListener('click', () => {
    if (current && current.phase === 'closed') { onFinishClose(); return; } // "Try again": the address and the confirmation were given at the first close
    $('#close-confirm-text').textContent = current && current.sealed
      ? 'This cannot be undone. Closing opens every bid, records the result for everyone to see, pays the prices into the treasury and sends everyone else their refund.'
      : 'This cannot be undone. Closing records the result for everyone to see, sends the money the campaign keeps to the address below, and sends refunds to the others.';
    $('#sweep-to').hidden = !!(current && current.sealed);
    document.querySelector('label[for=sweep-to]').hidden = !!(current && current.sealed);
    $('#close-confirm').hidden = false;
  });
  $('#close-no').addEventListener('click', () => { $('#close-confirm').hidden = true; });
  $('#close-yes').addEventListener('click', onCloseNow);
  $('#export-btn').addEventListener('click', exportCopy);
  $('#listing-btn').addEventListener('click', () => { say($('#listing-error'), ''); $('#listing-confirm').hidden = false; });
  $('#listing-no').addEventListener('click', () => { $('#listing-confirm').hidden = true; });
  $('#listing-yes').addEventListener('click', onListingSend);
  $('#listing-check').addEventListener('click', onListingCheck);
  $('#copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#contribute-link').textContent); $('#copy-link').textContent = 'Copied'; } catch { $('#copy-link').textContent = 'Select the link and copy it'; }
  });
  await refresh();
  timer = setInterval(() => { if (Date.now() - measuredAt > 600000) measure(); refresh(); }, 5000);
}

main();
