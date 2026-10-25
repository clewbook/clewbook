// Recount page: reads the campaign's public list from its relays, scans the chain from two independent
// public servers with the WebAssembly recount, and shows every rule as PASS or FAIL with its evidence.
// It never passes quietly when relays or servers disagree.
import init, * as W from './pkg/ll_web.js';
import { crossCheck } from './recount.js';
import { sha256hex, reportEnvelope } from './canon.js';
import { NOT_CHECKED } from './capabilities.js';
import { setNetwork, setup, decorateAmounts, mountHash, setCampaignLabel, markReady, CHECKS } from './ui.js';
import { buildCopy, downloadCopy, fetchFinal, checkMemory, remember, forget, memoryWords, compareLists, describeComparison, hashesOf } from './copies.js';
import { linkParams, readAllRelays, readRelay, judge, fromSavedCopy, hostOf, coin, sibling, groupOf, serverName, tipOf, DEFAULT_ENDPOINTS, milestones, backToMilestones } from './public.js';

const $ = (s) => document.querySelector(s);
const cfg = linkParams();
let running = false;
let network = null;
let addedServer = null; // a chain server the person added with "Add and run again"

function banner(kind, text) {
  const d = document.createElement('div');
  if (kind === 'bad') { d.className = 'notice bad'; d.textContent = text; return d; }
  // a grey advisory note (round 11): its own ✕ removes it for this run only; "Run it again" or a reload brings it back
  d.className = 'rnote'; d.setAttribute('role', 'note'); d.dataset.kind = kind; d.textContent = text;
  const x = document.createElement('button'); x.type = 'button'; x.className = 'rnote-x'; x.setAttribute('aria-label', 'Dismiss this note'); x.textContent = '✕';
  x.addEventListener('click', () => d.remove());
  d.append(x);
  return d;
}
function fact(dl, label, value) {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = value;
  if (/^(Goal|Soft cap)$/.test(label) && /: missed$/.test(value)) dd.className = 'missed'; // a missed goal in the fail colour
  dl.append(dt, dd);
}
function verdict(kind, title, text, limitedFail = false) {
  const v = $('#verdict');
  v.className = `verdict ${kind}`; // pass | fail | cannot | partial | working
  $('#verdict-title').textContent = title;
  $('#verdict-text').textContent = text; // empty for a plain pass or fail: the heading and the tags say it (round 10); the empty line takes no room
  v.dataset.kind = kind;
  // the tags of the verdict card: a word and a mark each, never colour alone. LIMITED: a pass that could not be cross checked (kind partial), or a
  // fail that could not be (limitedFail), as the notes below the card explain
  const limited = kind === 'partial' || limitedFail;
  const tags = kind === 'pass' ? [['pass', '✓ PASS']] : kind === 'partial' ? [['pass', '✓ PASS'], ['limited', '△ LIMITED']]
    : kind === 'fail' ? [['fail', '✕ FAIL'], ...(limited ? [['limited', '△ LIMITED']] : [])]
    : kind === 'cannot' ? [['wait', /^Not yet possible/.test(title) ? '◷ WAIT' : '◷ CANNOT CONCLUDE']] : [['nc', 'WORKING']];
  $('#verdict-kicker').replaceChildren(...tags.map(([c, t]) => Object.assign(document.createElement('span'), { className: `spill vtag ${c}`, textContent: t })));
}
const progress = (t) => { $('#progress').textContent = t; };
const warn = (kind, text) => $('#banners').append(banner(kind, text));

function showTotals(r, ticker, final) {
  const dl = $('#totals');
  dl.replaceChildren();
  const t = r.totals, z = (n) => `${coin(n)} ${ticker}`;
  fact(dl, 'Raised', z(t.raised_zat));
  fact(dl, 'Contributions', String(t.contributions));
  fact(dl, 'Taken back by contributors early', z(t.withdrawn_zat));
  fact(dl, 'Refunded', z(t.refunded_zat));
  fact(dl, 'Kept by the campaign', z(t.kept_zat));
  fact(dl, 'Still pending', z(t.pending_zat));
  fact(dl, 'Donations (no valid message, or set aside)', `${z(t.donations_zat)} in ${t.donations} payment(s)`);
  const unclaimed = (r.sealed && r.sealed.not_in_auction) || [];
  if (unclaimed.length) { // a blind bid auction: each payment no entry names, with its transaction id (flagged in the checks too)
    fact(dl, 'Payments not in the auction', '');
    dl.lastChild.replaceChildren(...unclaimed.map((p) => Object.assign(document.createElement('span'), { className: 'na-tx', textContent: `${z(p.value_zat)}, ${p.reason}, block ${p.height.toLocaleString('en-US')}, transaction ${p.txid}${p.spent_txid ? `, spent by transaction ${p.spent_txid}` : ''}` })));
  }
  if (r.auction) {
    const a = r.auction;
    fact(dl, 'Clearing price (every winner pays this)', `${z(a.price_zat)} (reserve ${z(a.reserve_zat)})`);
    fact(dl, 'Settlement deadline', `block ${a.settle_by} (${a.settle_window} blocks after the auction deadline)`);
    fact(dl, 'Winners', `${a.winners}; settled ${a.settled}${a.awaiting ? `, waiting ${a.awaiting}` : ''}${a.defaulted.length ? `, defaulted ${a.defaulted.length} (item unsold)` : ''}`);
    fact(dl, 'Received by the treasury', z(a.treasury_total_zat));
    fact(dl, 'Sent back to winners as excess', z(a.excess_zat));
    fact(dl, 'Winners who proved their excess was paid back', `${a.proofs_ok} of ${a.settled}${a.complaints ? `; ${a.complaints} unverified complaint(s)` : ''}`);
  }
  // a fundraiser with a hard cap says "soft cap" and "hard cap" (the soft cap counts only what fits under the hard cap); one without keeps "goal"
  if (r.cancelled) fact(dl, 'Outcome', 'Cancelled. Everyone refunded.');
  else if (r.goal_zat != null && r.goal_met != null) fact(dl, r.cap_zat != null ? 'Soft cap' : 'Goal', `${z(r.goal_zat)}: ${final ? (r.goal_met ? 'met' : 'missed') : (r.goal_met ? 'reached so far' : 'not reached yet')} ${final ? '' : '(the deadline has not passed)'}`.trim());
  if (r.cap_zat != null) {
    fact(dl, 'Hard cap', z(r.cap_zat));
    fact(dl, 'Over the hard cap', `${z(r.over_cap_zat)} in ${r.over_cap} payment(s), ${final ? 'refunded by their own tickets' : 'refunded by their own tickets at the close unless room frees up'}`);
  }
  if (r.winners) fact(dl, 'Winners (best first)', r.winners.join(', ') || 'none');
  $('#totals-card').hidden = false;
  decorateAmounts($('#totals'));
}

const PRICING_WORDS = { uniform: 'everyone who wins pays the lowest winning bid', second: 'everyone who wins pays the highest losing bid', pay_your_bid: 'each winner pays their own bid' };

/** A sealed bid auction: its timing, the bids as they opened with round R, the winners and what each pays. */
function showSealed(r, rules, ticker) {
  const z = (n) => `${coin(n)} ${ticker}`, s = rules.sealed, o = r.sealed;
  const dl = $('#sealed-facts');
  dl.replaceChildren();
  fact(dl, 'Deposit sizes', s.tranches_zat.map(z).join(', '));
  fact(dl, 'How winners pay', PRICING_WORDS[s.pricing]);
  fact(dl, 'Bids open with', `drand round ${s.drand_round}`);
  if (s.timing === 'quick') fact(dl, 'Timing', 'Quick test: blocks every 20 to 40 seconds, bids open 10 minutes after the deadline');
  fact(dl, 'The host\'s small payments by', `block ${rules.deadline_height - s.coin_cutoff}`);
  fact(dl, 'Late tickets work from', `block ${s.claim_after + 1}`);
  if (r.did_not_finish) fact(dl, 'Result', 'The host did not finish this auction');
  else if (o && o.void) fact(dl, 'Result', 'Void: round R came too early for this deadline, so every deposit goes back');
  else if (o && o.opened && !o.winners.length) fact(dl, 'Result', 'No winners: every deposit goes back');
  else if (o && o.opened) fact(dl, 'Result', `${o.winners.length} winner(s)${o.price_zat != null ? `, each pays ${z(o.price_zat)}` : ', each pays their own bid'}`);
  else fact(dl, 'Result', 'The bids have not opened yet');
  const ol = $('#sealed-bids');
  ol.replaceChildren(...((o && o.deposits) || []).map((d) => {
    const li = document.createElement('li');
    const what = d.withdrawn ? 'taken back before the deadline'
      : d.bid_zat != null && !d.no_bid ? `bid ${z(d.bid_zat)}${d.winner ? `, WINS, pays ${z(d.price_zat)}` : ''}`
        : d.no_bid ? `no bid: ${d.no_bid}` : 'not opened yet';
    li.append(Object.assign(document.createElement('span'), { textContent: `Deposit ${d.nf.slice(0, 10)}… of ${z(d.tranche_zat)} (paid ${z(d.value_zat)}, block ${d.height}): ${what}` }));
    if (d.winner) li.className = 'done';
    return li;
  }));
  $('#sealed-card').hidden = false;
  decorateAmounts($('#sealed-card'));
}

/** The checks as one table (round 11, "Table and filters"): every row a button that opens the check's description and the evidence the engine wrote.
 *  FAIL rows start open, PASS and WAIT rows closed; every run starts from these defaults. The filters show all, the failed or the passed rows. */
let filter = 'all';
function showRules(r, ticker) {
  const box = $('#rules');
  box.replaceChildren();
  const nFail = r.rules.filter((x) => !x.waiting && !x.pass).length, nPass = r.rules.filter((x) => !x.waiting && x.pass).length;
  $('#f-all').textContent = `All ${r.rules.length}`; $('#f-bad').textContent = `Problems ${nFail}`; $('#f-ok').textContent = `Matched ${nPass}`;
  // a blind bid auction whose bids have opened: the payments no entry names (not listed, rejected or returned), flagged, never a failure
  const na = (r.sealed && r.sealed.not_in_auction) || [];
  const flagged = r.sealed && r.sealed.opened ? [{ id: '⚑', title: 'Payments not in the auction', flag: na.length > 0, pass: true,
    desc: 'Payments into the auction address in the bidding window that no entry on the list names. Each counts as a donation and stays in the auction wallet unless the host sends it back by hand. Flagged, not failed.',
    details: na.length ? na.map((p) => `Transaction ${p.txid}, block ${p.height.toLocaleString('en-US')}, ${coin(p.value_zat)} ${ticker}: ${p.reason}. ${p.spent_txid ? `Spent by transaction ${p.spent_txid}.` : 'Still in the auction wallet.'}`) : ['None.'] }] : [];
  for (const x of [...r.rules, ...flagged]) {
    // a check that cannot run yet (an auction before its close) shows WAIT, in the neutral look
    const st = x.flag ? 'flag' : x.waiting ? 'wait' : x.pass ? 'pass' : 'fail';
    const word = x.flag ? '⚑ FLAGGED' : x.waiting ? '◷ WAIT' : x.pass ? (x.desc ? '✓ NONE' : '✓ PASS') : '✕ FAIL';
    const row = document.createElement('div'); row.className = `rrow ${st}`; row.dataset.id = x.id; row.dataset.st = st;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'rr-btn';
    const panelId = `rr-${x.id}`;
    b.setAttribute('aria-controls', panelId);
    const id = Object.assign(document.createElement('span'), { className: 'rr-id', textContent: x.id });
    const name = (CHECKS[x.id] || [x.title])[0];
    const nm = document.createElement('span'); nm.className = 'rr-name';
    const m = name.match(/^(.*?)( \(.*\))$/); // a bracketed qualifier goes under the name on a phone
    if (m) nm.append(Object.assign(document.createElement('span'), { textContent: m[1] }), Object.assign(document.createElement('span'), { className: 'rr-sub', textContent: m[2] }));
    else nm.textContent = name;
    const pill = Object.assign(document.createElement('span'), { className: `spill ${st === 'wait' ? 'nc' : st === 'flag' ? 'limited' : st}`, textContent: word }); // a check that waits looks neutral, as before
    const chev = Object.assign(document.createElement('span'), { className: 'rr-chev', textContent: '▾' }); chev.setAttribute('aria-hidden', 'true');
    b.append(id, nm, pill, chev);
    b.setAttribute('aria-label', `${x.id} ${name}: ${word.slice(2)}`);
    const panel = document.createElement('div'); panel.className = 'rr-panel'; panel.id = panelId;
    panel.append(Object.assign(document.createElement('p'), { className: 'rr-desc', textContent: x.desc || (CHECKS[x.id] ? CHECKS[x.id][1] : x.title) }));
    if (x.details.length) {
      const ev = document.createElement('div'); ev.className = 'rr-ev';
      for (const t of x.details) ev.append(Object.assign(document.createElement('p'), { textContent: t }));
      panel.append(ev);
    }
    const setOpen = (o) => { b.setAttribute('aria-expanded', String(o)); panel.hidden = !o; row.classList.toggle('open', o); };
    setOpen(st === 'fail' || st === 'flag');
    b.addEventListener('click', () => setOpen(b.getAttribute('aria-expanded') !== 'true'));
    row.append(b, panel);
    box.append(row);
  }
  applyFilter('all');
  $('#rules-card').hidden = false;
}
function applyFilter(f) {
  filter = f;
  for (const c of document.querySelectorAll('.rchip')) c.setAttribute('aria-pressed', String(c.dataset.f === f));
  for (const row of document.querySelectorAll('#rules .rrow')) row.hidden = (f === 'bad' && row.dataset.st !== 'fail' && row.dataset.st !== 'flag') || (f === 'ok' && row.dataset.st !== 'pass');
}

/** The coverage line and what a recount does not check. "Not checked" lists what this run could not see, each with its reason as text. */
function showSummary(r, { partial, oneRelay, fromFile, servers, hostings, relays, sameAsLast }) {
  const notChecked = [...NOT_CHECKED];
  if (partial) notChecked.push(['agreement between servers', 'only one public server answered']);
  if (oneRelay) notChecked.push(fromFile ? ['agreement with what relays show', 'the list came from a saved file, not from a relay'] : ['agreement between relays', 'only one relay gave a usable list']);
  $('#nc-count').textContent = String(notChecked.length);
  const nc = $('#notchecked-line'); nc.replaceChildren();
  for (const [what, why] of notChecked) { // one ruled row each: a short bold lead-in in sentence case, then the reason as text
    const row = document.createElement('span'); row.className = 'ncrow';
    const lead = document.createElement('b'); lead.textContent = `${what.charAt(0).toUpperCase()}${what.slice(1)}:`;
    row.append(lead, ` ${why}.`); nc.append(row);
  }
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  $('#coverage-line').textContent = [pl(servers, 'server'), pl(hostings, 'apparent hosting'), pl(relays, 'relay'), ...(sameAsLast ? ['same list as your last visit'] : [])].join(' · ');
  $('#summary').hidden = false;
}

async function run() {
  if (running) return;
  running = true;
  $('#again').hidden = $('#again-tab').hidden = true;
  $('#banners').replaceChildren(); $('#sources').replaceChildren();
  for (const id of ['#totals-card', '#rules-card', '#sources-card', '#summary', '#saved-card']) $(id).hidden = true;
  sameAsLast = false;
  verdict('working', 'Working…', 'Reading the public list.');
  lastJ = null;
  $('#fp-card').hidden = true;
  $('#copy-card').hidden = true;
  try { await recount(); await fingerprintStep(); } catch (e) {
    verdict('cannot', 'Cannot conclude', `The recount could not finish: ${e.message || e} Nothing was concluded.`);
  } finally { running = false; $('#again').hidden = $('#again-tab').hidden = false; progress(''); }
}

let lastJ = null; // the list the last run used, for the fingerprint step
let sameAsLast = false; // this browser saw exactly this list on its last visit (said in the coverage line)
let saved = null; // the text of a saved copy the person loaded; when set, it is used instead of the relays

async function recount() {
  let j;
  if (saved) {
    try { j = fromSavedCopy(saved, cfg.id); } catch (e) { markReady(); $('#saved-card').hidden = false; $('#saved-using').hidden = false; return verdict('cannot', 'Cannot conclude from the saved copy', e.message); }
    $('#saved-card').hidden = false; $('#saved-using').hidden = false;
    warn('warn', 'This result comes from a saved copy of the list that you loaded, not from a relay. The copy was checked (the rules match this campaign, every entry is signed, in order and without gaps), but nothing shows whether it is the list the host showed to others. The ticket and payment checks against the chain are made as usual.');
  } else {
    j = await readAllRelays(cfg.id, cfg.relays);
    $('#saved-using').hidden = true;
  }
  markReady();
  lastJ = j;
  for (const n of j.notes) warn('warn', n);
  if (j.kind === 'none') { showSavedCard(j); }
  if (j.kind === 'none') return verdict('cannot', 'Cannot conclude', 'No relay could give an intact, signed list. A relay that drops or damages entries could make anyone look guilty, so no verdict is given. Ask the host for its own copy or try other relays.');
  if (j.kind === 'disagree') return verdict('cannot', 'RELAYS DISAGREE, CANNOT CONCLUDE', 'The relays do not show the same list. This says nothing about the host: a relay can be behind, down or dishonest. Ask the host for its own copy, or try other relays, and run this again.');
  const c = JSON.parse(W.campaign_summary(j.rules, cfg.id));
  // the name from the checked rules (so a campaign that is not listed has it too), then the short id with its copy button; on both tabs
  setCampaignLabel(cfg.id, '');
  $('#campaign-id').title = '';
  $('#rc-name').textContent = c.name || ''; $('#rc-name').hidden = !c.name; if (c.name) $('#rc-name').title = c.name;
  const rules = JSON.parse(j.rules);
  copyStep(j);
  setNetwork(c.network);
  const closeEntry = j.entries.find((e) => e.kind === 'close');
  // a sealed bid auction publishes its viewing key in a reveal entry, once every winner is settled
  const revealEntry = j.entries.find((e) => e.kind === 'reveal');
  const ufvk = rules.campaign_ufvk || closeEntry?.close?.ufvk || revealEntry?.reveal?.ufvk;
  if (!ufvk && rules.sealed) {
    // R1 and R2 run, the other checks wait; with the chain height, whether the host did not finish (no chain data is needed for that)
    const eps = cfg.endpoints.length ? cfg.endpoints : DEFAULT_ENDPOINTS[c.network] || [];
    let tip = 0;
    for (const u of eps) { tip = (await tipOf(u)) || 0; if (tip) break; }
    const s = JSON.parse(W.report_sealed_at(j.rules, cfg.id, JSON.stringify(j.entries), tip));
    showRules(s);
    for (const w of s.warnings) warn('bad', w);
    showSealed({ did_not_finish: s.did_not_finish, sealed: null }, rules, c.ticker);
    if (s.did_not_finish) return verdict('fail', 'The host did not finish', `This blind bid auction was not finished by its host in time${tip ? ` (chain height ${tip})` : ''}. Everyone can take their deposit back with their late ticket. The other checks wait for the viewing key, which the host has not published.`);
    return s.all_pass
      ? verdict('cannot', 'Not yet possible', 'This is a blind bid auction whose viewing key is not published yet. R1 and R2 pass: the rules match the auction and the signed list is intact. The other checks wait for the viewing key, which the host publishes once every winner is settled.')
      : verdict('fail', 'Some checks FAIL', 'This is a blind bid auction whose viewing key is not published yet, and R1 or R2 fails: see the evidence under the check.');
  }
  if (!ufvk) {
    // an auction before its close: its viewing key is sealed, so R1 and R2 run and every other check waits, as the command line shows them
    const s = JSON.parse(W.report_sealed(j.rules, cfg.id, JSON.stringify(j.entries)));
    showRules(s);
    return s.all_pass
      ? verdict('cannot', 'Not yet possible', 'This is an auction that has not closed. R1 and R2 pass: the rules match the campaign and the signed list is intact. The other checks wait for the viewing key, which is published at the close. Come back after it closes.')
      : verdict('fail', 'Some checks FAIL', 'This is an auction that has not closed, and R1 or R2 fails: see the evidence under the check. The other checks wait for the viewing key, which is published at the close.');
  }

  // servers named in the link replace the defaults; adding a server below keeps the defaults and puts the new one first
  network = c.network;
  const endpoints = cfg.endpoints.length ? cfg.endpoints : DEFAULT_ENDPOINTS[c.network] || [];
  if (!endpoints.length) return verdict('cannot', 'Cannot conclude', 'No public servers are configured for this network.');
  verdict('working', 'Working…', 'Scanning the chain from up to three public servers. This can take a minute.');
  const out = await crossCheck(endpoints, { network: c.network, ufvk, start: rules.start_height, rules, rules_id: cfg.id, ledger: j.entries, challenges: j.challenges, treasury_ufvk: rules.treasury_ufvk }, { onStatus: progress });

  const good = out.sources.filter((s) => s.ok);
  const sl = $('#sources');
  for (const s of out.sources) {
    const li = document.createElement('li');
    li.textContent = s.ok
      ? `${serverName(s.endpoint)}${groupOf(s.endpoint) !== serverName(s.endpoint) ? ` (${groupOf(s.endpoint)})` : ''}: read blocks ${rules.start_height}..${out.end} (${s.stats.blocks} blocks, ${s.stats.actions} actions, ${s.stats.full_txs} messages opened)`
      : `${serverName(s.endpoint)}: ${s.unreachable ? 'did not answer' : 'failed'} (${s.error})`;
    if (!s.ok) li.className = 'bad';
    sl.append(li);
  }
  // a server the person added that gave nothing: say why it may have failed, here and only now
  const added = out.sources.find((s) => s.endpoint === addedServer && !s.ok);
  if (added) { const e = $('#server-error'); e.textContent = `${serverName(addedServer)} did not answer. A server only works here if it allows requests from web pages.`; e.hidden = false; }
  const rl = document.createElement('li');
  rl.textContent = `Public list: ${j.entries.length} entries from ${j.ok.map((r) => hostOf(r.url)).join(', ')}${j.challenges.length ? `; ${j.challenges.length} published challenge(s)` : ''}`;
  sl.append(rl);
  $('#sources-card').hidden = false;
  $('#sources-sum').textContent = `· ${j.ok ? j.ok.length : 1} ${(j.ok ? j.ok.length : 1) === 1 ? 'relay' : 'relays'} · ${good.length} ${good.length === 1 ? 'server' : 'servers'}`;

  if (!good.length) return verdict('cannot', 'Cannot conclude', 'None of the public servers could give the blocks. Nothing was concluded; try again in a minute.');
  const r = good[0].report;

  if (good.length >= 2 && out.agree === false) {
    warn('bad', 'The servers did not show the same chain data for the same blocks. ' + good.map((s) => `${serverName(s.endpoint)}: ${coin(s.report.totals.raised_zat)} raised in ${s.report.totals.contributions} contribution(s)`).join('; ') + '. A server can leave blocks out, so no result is given.');
    return verdict('cannot', 'SERVERS DISAGREE, CANNOT CONCLUDE', `Of ${good.length} public servers, some showed different data for the same blocks. That says nothing about the campaign. Try again later or add another server below.`);
  }

  showTotals(r, c.ticker, out.end > rules.deadline_height);
  if (rules.sealed) showSealed(r, rules, c.ticker);
  // when the campaign's list ends, in blocks: the deadline always, and the close when the host closed it
  const nf = (n) => Number(n).toLocaleString('en-US');
  $('#tl-deadline').textContent = `block ${nf(rules.deadline_height)}`;
  const closedAt = closeEntry && closeEntry.close ? closeEntry.close.close_height : null;
  $('#tl-closed-t').hidden = $('#tl-closed').hidden = closedAt == null;
  if (closedAt != null) {
    const after = closedAt - rules.deadline_height;
    $('#tl-closed').textContent = `block ${nf(closedAt)} (${after > 0 ? `${nf(after)} block${after === 1 ? '' : 's'} after the deadline` : `${nf(-after)} block${after === -1 ? '' : 's'} before the deadline`})${after <= 0 && rules.early_close ? '. Closed early, which this campaign\'s rules allow once the goal is met: payments after this block do not count, and contributions could be taken back only until it' : ''}`;
  }
  showRules(r, c.ticker);
  // past the deadline and never closed: say so, as a rule of the campaign (the recount does not check that any refund was claimed)
  const openNote = $('#open-note');
  const pastDeadline = out.end > rules.deadline_height, isClosed = j.entries.some((e) => e.kind === 'close');
  openNote.hidden = !(pastDeadline && !isClosed);
  if (!openNote.hidden) {
    // the notice (round 11): the same facts as the paragraph it replaces. The window ends at deadline + K; refunds are open only once the chain is past it
    const windowEnd = rules.sealed ? rules.sealed.claim_after : rules.deadline_height + rules.ticket_k, open = out.end > windowEnd;
    const k = Object.assign(document.createElement('span'), { className: 'rn-k', textContent: open ? 'NOTICE · REFUNDS OPEN' : 'NOTICE' });
    const grid = document.createElement('div'); grid.className = 'rn-grid';
    for (const [l, v] of [['Status', 'Past deadline. Not closed by the host.'],
      ['Ticket window', `${open ? 'Ended' : 'Ends'} at block ${nf(windowEnd)}`],
      ['Refunds', open ? 'Contributors may now claim with their own tickets.' : `By the campaign's rules, contributors may claim refunds with their own tickets after block ${nf(windowEnd)}.`]]) {
      grid.append(Object.assign(document.createElement('span'), { className: 'rn-l', textContent: l }), Object.assign(document.createElement('span'), { className: 'rn-v', textContent: v }));
    }
    const foot = Object.assign(document.createElement('span'), { className: 'rn-f', textContent: 'This recount does not check whether any refunds were claimed.' });
    openNote.replaceChildren(k, grid, foot);
  }
  $('#rf-height').textContent = Number(out.end).toLocaleString('en-US');
  $('#rf-time').textContent = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  mountHash($('#rf-hash'), await sha256hex(reportEnvelope(cfg.id, out.end, r)), 8);
  for (const w of r.warnings) warn('warn', w);

  const partial = good.length < 2;
  const n = good.length, groups = new Set(good.map((s) => groupOf(s.endpoint)));
  if (!partial && groups.size < 2) warn('warn', `The ${n} servers that answered all appear to run on the same hosting (${[...groups][0]}), so they are not independent evidence of each other. Add a server run by someone else below.`);
  else if (!partial) warn('info', `${n} servers answered, on ${groups.size} apparently separate hostings. We can only see hosting from the outside, so this is not a proof of independence.`);
  const oneRelay = j.kind === 'single';
  showSummary(r, { partial, oneRelay, fromFile: !!j.fromFile, servers: n, hostings: groups.size, relays: j.ok.length, sameAsLast });
  if (partial) warn('warn', 'Only one public server answered. A single server could leave blocks out, so this is not a cross check.');
  if (oneRelay && !j.fromFile) warn('info', cfg.relays.length > 1 ? 'Only one relay gave a usable list.' : 'Only one relay was asked, so the list has not been cross checked.');
  if (r.sealed && r.sealed.cannot_conclude && r.rules.every((x) => x.pass || x.waiting)) {
    // set 1, L2: a sealed bid auction whose block times around the deadline could not be read: whether it is void is not known
    verdict('cannot', 'Cannot conclude', `Nothing was concluded: ${r.sealed.cannot_conclude}. Try again later or add another server below.`);
  } else if (r.all_pass) {
    // a saved copy keeps its one line: what a result from a file can and cannot show is said nowhere else
    if (j.fromFile) verdict('partial', 'All checks pass for the saved copy', 'This result comes from a file, not from a relay: it shows the file is internally sound and matches the chain, not that it is the list the host showed to others.');
    else if (partial || oneRelay) verdict('partial', 'All checks pass', '');
    else verdict('pass', 'All checks pass', '');
  } else if (j.fromFile) {
    verdict('fail', 'Some checks FAIL for the saved copy', 'This result comes from a file, not from a relay: the failure may be in the file (for example, entries cut off its end) or in the campaign.', true);
  } else if (partial || oneRelay) {
    verdict('fail', 'Some checks FAIL', '', true);
  } else {
    verdict('fail', 'Some checks FAIL', '');
  }
}

/** The note about what this browser last saw, the button that saves the list, and the comparison with a saved copy. Only reads. */
function copyStep(j) {
  const hashes = hashesOf(j.entries);
  const note = $('#memory-note');
  if (!j.fromFile && (j.kind === 'single' || j.kind === 'agree')) {
    const r = checkMemory(cfg.id, hashes);
    const w = r.state === 'same' ? null : memoryWords(r); // the same list as last time is said in the coverage line
    sameAsLast = r.state === 'same';
    note.hidden = !w;
    note.replaceChildren();
    if (w) {
      const d = document.createElement('div');
      d.className = w.kind === 'hint' ? 'hint' : 'warnline';
      d.dataset.state = r.state;
      d.textContent = w.text;
      note.append(d);
      if (r.state === 'cut_off' || r.state === 'changed') {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = 'Remember this list instead';
        b.onclick = () => { remember(cfg.id, hashes); note.hidden = true; };
        note.append(b);
      }
    }
    if (r.state === 'first' || r.state === 'same' || r.state === 'grew') remember(cfg.id, hashes);
  } else note.hidden = true;
  $('#copy-card').hidden = false;
  $('#compare-box').hidden = !!j.fromFile; // from a file there is no separate current list to compare with
  $('#save-copy-note').textContent = `${j.entries.length} ${j.entries.length === 1 ? 'entry' : 'entries'}`;
  $('#save-copy').onclick = async () => {
    const finalText = j.fromFile ? j.final || '' : await fetchFinal((j.ok || []).map((r) => r.url), cfg.id);
    downloadCopy(buildCopy({ rulesText: j.rules, id: cfg.id, entries: j.entries, finalText, challenges: j.challenges }));
  };
  const input = $('#compare-file');
  input.onchange = async () => {
    const out = $('#compare-out'), err = $('#compare-error');
    out.hidden = true; err.hidden = true;
    const f = input.files[0];
    if (!f) return;
    try {
      let d;
      try { d = JSON.parse(await f.text()); } catch { throw new Error('That file is not a saved copy (it could not be read as JSON).'); }
      if (!d || d.kind !== 'ledger-export' || !Array.isArray(d.ledger)) throw new Error('That file is not a saved copy of a campaign list.');
      if (String(d.campaign || '').toLowerCase() !== cfg.id) throw new Error('That saved copy is for a different campaign.');
      // the saved copy must itself be an intact list, or it proves nothing
      const problems = JSON.parse(W.check_ledger(j.rules, cfg.id, JSON.stringify(d.ledger)));
      if (problems.length) throw new Error(`Your saved copy does not check out (${problems[0]}), so it cannot be used for a comparison.`);
      const cmp = compareLists(d.ledger, hashesOf(d.ledger), j.entries, hashes);
      const words = describeComparison(cmp, d.ledger, j.entries);
      out.replaceChildren(...words.lines.map((t) => { const p = document.createElement('p'); p.textContent = t; return p; }));
      out.className = `notice ${words.same ? 'good' : cmp.missing.length || cmp.changed.length ? 'bad' : 'info'}`;
      out.dataset.same = words.same ? '1' : '0';
      out.hidden = false;
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    input.value = '';
  };
}

/** The final fingerprint: the list's own line, compared with the host's signed record (from a saved copy, or from a relay), and with a line the person was given. */
async function fingerprintStep() {
  const j = lastJ;
  if (!j || !j.rules || !j.entries || j.kind === 'none' || j.kind === 'disagree') return;
  let record = j.final || '';
  if (!j.fromFile) {
    // ask every relay that gave the list; keep the record that covers the most
    let best = null;
    await Promise.all((j.ok || []).map(async (r) => {
      try {
        const res = await fetch(`${r.url}/v1/campaigns/${cfg.id}/final`, { cache: 'no-store' });
        const text = await res.text();
        if (!res.ok) return;
        const n = JSON.parse(text).entries || 0;
        if (!best || n > best.n) best = { n, text };
      } catch { /* none from this relay */ }
    }));
    record = best ? best.text : '';
  }
  const out = JSON.parse(W.final_check(j.rules, cfg.id, JSON.stringify(j.entries), record));
  $('#fp-card').hidden = false;
  $('#fp-line').textContent = out.line;
  const st = $('#fp-status');
  st.hidden = false;
  const MSG = {
    match: ['good', `This list is exactly the one the host fixed when it closed the campaign (${out.fixed} entries, signed by the campaign's key).`],
    none: ['info', 'No fingerprint published for this list.'],
    invalid: ['warn', 'A fingerprint record came with this list but it is not signed by the campaign\'s key, so it was ignored.'],
    cut_off: ['bad', `This list has ${out.has} entries but the host fixed ${out.fixed} when it closed the campaign: the end of the list is missing.`],
    different: ['bad', `This list is NOT the one the host fixed: its entry number ${out.fixed} is not the entry the host's fingerprint names. It may be a different history signed with the same key.`],
    extra: ['bad', `This list has entries after the host's fingerprint (${out.has} against ${out.fixed}) that are not settlements; the host's record does not cover them.`],
  };
  const [cls, text] = MSG[out.state] || MSG.none;
  st.className = `notice ${cls}`;
  st.textContent = text;
  if (['cut_off', 'different', 'extra'].includes(out.state)) {
    verdict('fail', 'The list does not match the host\'s final fingerprint', `${text} The checks below still show what this list contains; it cannot be treated as the campaign's complete, final list.`);
  }
  const given = $('#fp-given'), gs = $('#fp-given-status');
  const compare = () => {
    const g = given.value.trim().replace(/\s+/g, ' ');
    gs.hidden = !g;
    if (!g) return;
    const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
    gs.textContent = norm(g) === norm(out.line) ? 'It matches this list exactly.' : 'It does NOT match this list.';
  };
  given.oninput = compare; compare();
}

/** No relay gave the list: name every address that was tried, and offer to load a saved copy. */
function showSavedCard(j) {
  $('#saved-card').hidden = false;
  const box = $('#saved-tried');
  box.hidden = false;
  box.replaceChildren();
  const t = document.createElement('p'); t.textContent = 'No relay could give the list. These addresses were tried:'; box.append(t);
  const ul = document.createElement('ul');
  for (const url of cfg.relays) {
    const li = document.createElement('li');
    const why = j.notes.find((n) => n.startsWith(hostOf(url) + ' ')) || 'no usable answer';
    li.textContent = `${url}: ${why.slice(hostOf(url).length + 1).replace(/\.$/, '')}`;
    ul.append(li);
  }
  box.append(ul);
}

// ---------- the search box (owner, 22 Oct 2026): a campaign's name, id or link, with suggestions from the listed campaigns ----------
const DEFAULT_RELAY = 'https://relay.clewbook.xyz';
const relayOk = (u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u);
/** The campaigns on the home page's list, each with the name, type and network its relay's checked rules give (by id when they cannot be read). */
async function listedCampaigns() {
  let list = [];
  try {
    const r = await fetch('campaigns.json', { cache: 'no-store' });
    if (r.ok) list = ((await r.json()).campaigns || []).filter((c) => /^[0-9a-f]{64}$/.test(String(c.id || '')) && Array.isArray(c.relays) && c.relays.length);
  } catch { /* no list: only links and whole ids work */ }
  return Promise.all(list.map(async (c) => {
    const relays = c.relays.map((u) => String(u).replace(/\/$/, ''));
    const out = { id: c.id, relays, name: null, kind: 'Campaign', net: '' };
    try {
      const j = judge(await Promise.all(relays.map((u) => readRelay(u, c.id))));
      if (j.rules) {
        const info = JSON.parse(W.campaign_summary(j.rules, c.id));
        out.name = info.name || null;
        out.kind = info.sealed ? 'Blind bid' : info.mode === 'auction' ? 'Auction' : 'Fundraiser';
        out.net = info.network === 'main' ? 'mainnet' : info.network === 'test' ? 'testnet' : '';
      }
    } catch { /* shown by its id */ }
    return out;
  }));
}
function openRecount(id, relays) {
  location.hash = `c=${id}${relays.map((r) => `&relay=${r}`).join('')}`;
  location.reload();
}
/** What was typed or pasted: a link that names a campaign (with its relays), or a whole campaign id. Anything else is looked up by name. */
function parseFind(text, list) {
  const t = text.trim();
  const m = t.match(/[#?&]c=([0-9a-f]{64})(?![0-9a-f])/i);
  const id = (m ? m[1] : /^[0-9a-f]{64}$/i.test(t) ? t : '').toLowerCase();
  if (!id) return null;
  const given = m ? new URLSearchParams(t.slice(t.search(/[#?]/) + 1)).getAll('relay').map((u) => u.replace(/\/$/, '')).filter(relayOk) : [];
  const known = list.find((c) => c.id === id);
  return { id, relays: given.length ? given : known ? known.relays : [DEFAULT_RELAY] };
}
function findMatches(text, list) {
  const q = text.trim().toLowerCase();
  if (!q) return list.slice(0, 8);
  return list.filter((c) => (c.name || '').toLowerCase().includes(q) || c.id.startsWith(q)).slice(0, 8);
}
function wireFind() {
  const form = $('#find'), input = $('#find-q'), ul = $('#find-list'), err = $('#find-error');
  const NONE = 'No listed campaign matches. Paste a campaign link or its whole id.';
  let list = [], loading = null, items = [], active = -1;
  const load = () => loading || (loading = listedCampaigns().then((l) => { list = l; return l; }));
  const close = () => { ul.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const paint = () => {
    [...ul.querySelectorAll('[role=option]')].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) input.setAttribute('aria-activedescendant', `find-o${active}`); else input.removeAttribute('aria-activedescendant');
  };
  const show = () => {
    if (document.activeElement !== input) return;
    items = parseFind(input.value, list) ? [] : findMatches(input.value, list);
    ul.replaceChildren(...items.map((c, i) => {
      const li = document.createElement('li'); li.id = `find-o${i}`; li.setAttribute('role', 'option');
      li.append(Object.assign(document.createElement('span'), { className: 'rf-name', textContent: c.name || `${c.kind} ${c.id.slice(0, 8)}…` }),
        Object.assign(document.createElement('span'), { className: 'rf-meta', textContent: [c.kind, c.net, `${c.id.slice(0, 8)}…`].filter(Boolean).join(' · ') }));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); openRecount(c.id, c.relays); });
      return li;
    }));
    if (!items.length && input.value.trim() && !parseFind(input.value, list)) ul.append(Object.assign(document.createElement('li'), { className: 'rf-none', textContent: NONE }));
    active = items.length && input.value.trim() ? 0 : -1;
    paint();
    ul.hidden = !ul.children.length;
    input.setAttribute('aria-expanded', String(!ul.hidden));
  };
  input.addEventListener('focus', () => { load().then(show); });
  input.addEventListener('input', () => { err.hidden = true; load().then(show); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === 'Escape') close();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await load();
    const direct = parseFind(input.value, list);
    if (direct) { openRecount(direct.id, direct.relays); return; }
    const pick = (active >= 0 && items[active]) || findMatches(input.value, list)[0];
    if (pick && input.value.trim()) { openRecount(pick.id, pick.relays); return; }
    err.textContent = input.value.trim() ? NONE : 'Type a campaign name, or paste its id or link.';
    err.hidden = false;
  });
}

/** The page opened with no campaign at all: it asks for a saved copy and takes the campaign (its number and rules) from that file. Nothing is asked of
 *  any relay; the chain servers are the defaults of the network the file's rules name. Returns once a usable file was loaded. */
async function uploadMode() {
  $('#frame').hidden = true; $('#empty').hidden = false;
  $('#upload-card').hidden = false;
  // "Import ticket backup file" belongs to this state only (no campaign in the address); the home and campaign pages link to it here
  $('#ticket-box').hidden = false;
  if (location.hash === '#ticket-box') $('#ticket-box').scrollIntoView({ block: 'start' });
  $('#nav-campaign').hidden = true;
  markReady();
  await init();
  wireFind();
  await new Promise((done) => {
    $('#upload-file').addEventListener('change', async (ev) => {
      const f = ev.target.files[0];
      const err = $('#upload-error');
      err.hidden = true;
      if (!f) return;
      const fail = (t) => { err.textContent = t; err.hidden = false; ev.target.value = ''; };
      if (f.size > 50 * 1024 * 1024) return fail('That file is too large to be a saved copy.');
      let text, d;
      try { text = await f.text(); d = JSON.parse(text); } catch { return fail('That is not a saved copy: the file is not readable JSON.'); }
      if (!d || d.kind !== 'ledger-export' || !/^[0-9a-f]{64}$/.test(String(d.campaign || '')) || !Array.isArray(d.ledger)) return fail('That is not a saved copy of a campaign list (it should be a "ledger-export" file).');
      cfg.id = d.campaign; saved = text;
      $('#upload-card').hidden = true; $('#ticket-box').hidden = true; $('#empty').hidden = true; $('#frame').hidden = false;
      $('#campaign-id').textContent = `${cfg.id.slice(0, 8)}…`; $('#cid-copy').setAttribute('aria-label', `Copy campaign id ${cfg.id.slice(0, 8)}`);
      $('#saved-clear').hidden = true; // no relay to ask instead
      done();
    });
  });
}

/** RECOUNT and TOTALS: two views of the same run (Totals and Sources on TOTALS; the checks and the three actions on RECOUNT). The tab lives in the
 *  address as ?tab=totals, so it can be shared; a link without it opens RECOUNT. The #c=… part of every older link is left as it is. */
function setTab(which, write = true) {
  const totals = which === 'totals';
  $('#panel-recount').hidden = totals; $('#panel-totals').hidden = !totals;
  for (const [id, on] of [['#tab-recount', !totals], ['#tab-totals', totals], ['#etab-recount', !totals], ['#etab-totals', totals]]) { const b = $(id); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
  document.body.dataset.tab = totals ? 'totals' : 'recount';
  if (write) {
    const q = new URLSearchParams(location.search);
    if (totals) q.set('tab', 'totals'); else q.delete('tab');
    const qs = q.toString();
    history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  }
}
function wireTabs() {
  for (const pre of ['tab', 'etab']) {
    $(`#${pre}-recount`).addEventListener('click', () => setTab('recount'));
    $(`#${pre}-totals`).addEventListener('click', () => setTab('totals'));
  }
  for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const pre = b.id.split('-')[0], to = b.id.endsWith('recount') ? 'totals' : 'recount'; setTab(to); $(`#${pre}-${to}`).focus();
  });
  setTab(new URLSearchParams(location.search).get('tab') === 'totals' ? 'totals' : 'recount', false);
  for (const c of document.querySelectorAll('.rchip')) c.addEventListener('click', () => applyFilter(c.dataset.f));
  // the three actions open the existing tools, one at a time; an action shows only once its tool is there
  const acts = [['#act-server', '#add-server-card'], ['#act-copy', '#copy-card'], ['#act-fp', '#fp-card']];
  const sync = () => {
    let any = false;
    for (const [a, c] of acts) { const avail = !$(c).hidden; $(a).hidden = !avail; any ||= avail; if (!avail) { $(c).classList.remove('open'); $(a).setAttribute('aria-expanded', 'false'); } }
    $('#actions').hidden = !any;
  };
  for (const [a, c] of acts) {
    new MutationObserver(sync).observe($(c), { attributes: true, attributeFilter: ['hidden'] });
    $(a).addEventListener('click', () => {
      const open = !$(c).classList.contains('open');
      for (const [a2, c2] of acts) { $(c2).classList.toggle('open', open && c2 === c); $(a2).setAttribute('aria-expanded', String(open && a2 === a)); }
      if (open) $(c).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
  sync();
  // the campaign id: one button that copies the full id; the icon becomes a green tick for 1.6 s
  $('#cid-copy').addEventListener('click', async () => {
    if (!cfg.id) return;
    try { await navigator.clipboard.writeText(cfg.id); } catch { return; }
    $('.rcid-ic').hidden = true; $('.rcid-ok').hidden = false;
    setTimeout(() => { $('.rcid-ic').hidden = false; $('.rcid-ok').hidden = true; }, 1600);
  });
  // a native file chooser under each "Choose file": the chosen file's name beside it
  for (const [i, n] of [['#ticket-file', '#ticket-fname'], ['#upload-file', '#upload-fname']]) $(i).addEventListener('change', () => { const f = $(i).files[0]; if (f) { $(n).textContent = f.name; $(n).classList.add('set'); } });
}

// ---------- "Import ticket backup file": a contributor's backup file opens its own campaign's contribute page ----------
// The file is read here and nowhere else. The campaign is loaded from the relays the file names, with the same checks as any campaign link
// (the rules must hash to the campaign id), and shown before anything is saved. "Open my ticket" hands the file to the contribute page through
// this tab's session storage, which that page reads once and deletes; the secret never goes into an address. A browser that already holds a
// payment for the campaign is never overwritten: the button then just opens that payment.
const HANDOVER = (id) => `cb-handover:${id}`;
const webUrl = (u) => { try { return ['https:', 'http:'].includes(new URL(u).protocol); } catch { return false; } };
const NOT_BACKUP = 'That is not a Clewbook backup file.';
function wireTicketBox() {
  const input = $('#ticket-file'), err = $('#ticket-error'), out = $('#ticket-result');
  const line = (cls, text) => Object.assign(document.createElement('p'), { className: cls, textContent: text });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.value = '';
    err.hidden = true; err.replaceChildren(); out.hidden = true; out.replaceChildren();
    if (!f) return;
    const say = (...parts) => { err.replaceChildren(...parts); err.hidden = false; };
    let text, b;
    try { if (f.size > 1024 * 1024) throw new Error('too large'); text = await f.text(); b = JSON.parse(text); } catch { return say(NOT_BACKUP); }
    if (b && b.kind === 'ledger-export') {
      const a = Object.assign(document.createElement('a'), { href: 'recount.html#upload-card', textContent: 'Check a saved copy' });
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const box = $('#upload-card');
        if (box && !box.hidden) { box.scrollIntoView({ block: 'start' }); $('#upload-file').focus(); } else { location.href = 'recount.html#upload-card'; location.reload(); }
      });
      return say('That is a saved campaign list, not a ticket backup. Use ', a, ' for it.');
    }
    const id = b && typeof b.campaign === 'string' ? b.campaign.toLowerCase() : '';
    const relays = b && Array.isArray(b.relays) ? b.relays.filter((r) => typeof r === 'string' && webUrl(r)).map((r) => r.replace(/\/$/, '')) : [];
    if (!b || b.kind !== 'contribution-backup' || !/^[0-9a-f]{64}$/.test(id) || !relays.length || typeof b.seed !== 'string') return say(NOT_BACKUP);
    const server = typeof b.server === 'string' && webUrl(b.server) ? b.server.replace(/\/$/, '') : '';
    out.replaceChildren(line('tb-note', 'Looking for the campaign…')); out.hidden = false;
    await init();
    const reads = await Promise.all(relays.map((u) => readRelay(u, id)));
    const j = judge(reads);
    const hosts = relays.map(hostOf).join(', ');
    if (!j.ok.length) {
      // a relay that answers but has no such campaign (or only rules that are not this campaign's) has lost it; anything else is "could not reach"
      const unreachable = (e) => /fetch|network|timed? ?out|abort|load failed|HTTP (5\d\d|408|429)/i.test(e || '');
      const missing = reads.every((r) => r.error && !unreachable(r.error));
      const broken = reads.some((r) => !r.error && r.problems.length);
      out.replaceChildren(line('tb-line', missing ? 'This relay no longer has this campaign.'
        : broken ? `This campaign's relay (${hosts}) shows a list that does not check out. Try again later.`
          : `We could not reach this campaign's relay (${hosts}). Try again later.`));
      return;
    }
    const c = JSON.parse(W.campaign_summary(j.rules, id));
    const closed = j.entries.some((e) => e.kind === 'close');
    const held = (() => { try { return localStorage.getItem(`ll:${id}`) !== null; } catch { return false; } })();
    const head = document.createElement('div'); head.className = 'tb-head';
    head.append(Object.assign(document.createElement('span'), { className: 'tb-name', textContent: c.name || `${c.sealed ? 'Blind bid auction' : c.mode === 'raise' ? 'Fundraiser' : 'Auction'} ${id.slice(0, 8)}…` }),
      Object.assign(document.createElement('span'), { className: `tb-net ${c.network === 'test' ? 'test' : 'main'}`, textContent: c.network === 'test' ? 'TESTNET' : 'MAINNET' }));
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: 'Open my ticket' });
    btn.id = 'ticket-open';
    const note = line('tb-note', held ? '' : 'Opening it saves the file in this browser.');
    note.hidden = held;
    const go = () => { location.href = sibling('contribute', { id, relays, endpoints: [], server }); };
    btn.addEventListener('click', () => {
      if (held) { note.textContent = 'This browser already has a payment for this campaign. Opening it.'; note.hidden = false; btn.disabled = true; setTimeout(go, 900); return; }
      try { sessionStorage.setItem(HANDOVER(id), text); } catch {
        note.textContent = 'This browser does not let the page keep the file for a moment, so it cannot be opened from here. Open the campaign and use "I have a backup file" there.';
        return;
      }
      go();
    });
    const state = line('tb-line', closed ? 'This campaign is closed. Your ticket is still here.' : 'Open');
    out.replaceChildren(head, state, btn, note);
    // an open card asks the chain height afterwards, the way the campaign page does (tipOf): past the deadline and not closed, it says so. The card
    // is shown first and never waits; a lookup that fails or is slow leaves "Open"; a later file replaces the card and the late answer is dropped
    if (!closed) {
      (async () => {
        for (const e of [server, ...(DEFAULT_ENDPOINTS[c.network] || [])].filter(Boolean)) {
          const tip = await tipOf(e, 8000);
          if (tip == null) continue;
          if (tip > c.deadline_height && out.contains(state)) state.textContent = 'Deadline passed, waiting to be closed';
          return;
        }
      })();
    }
  });
}

async function main() {
  wireTabs();
  wireTicketBox();
  setup('Recount');
  $('#campaign-id').textContent = cfg.id ? `${cfg.id.slice(0, 8)}…` : '';
  $('#cid-copy').setAttribute('aria-label', `Copy campaign id ${cfg.id.slice(0, 8)}`);
  const upload = cfg.id === '' && cfg.relays.length === 0;
  if (!upload) $('#frame').hidden = false;
  if (upload) await uploadMode();
  else if (!/^[0-9a-f]{64}$/.test(cfg.id) || cfg.relays.length === 0) {
    verdict('cannot', 'Incomplete link', 'This link is incomplete. Please ask whoever sent it for the full recount link.');
    return;
  }
  if (!upload) {
    // opened from the demo's Tested milestones page, the top left link returns there; one step further it keeps the way back
    const ms = milestones();
    if (ms && ms.direct) backToMilestones($('#nav-campaign'), ms);
    else $('#nav-campaign').href = ms ? ms.onward(sibling('campaign', cfg)) : sibling('campaign', cfg);
  }
  if (!upload) await init();
  $('#again').addEventListener('click', run); $('#again-tab').addEventListener('click', run);
  $('#saved-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const err = $('#saved-error');
    err.hidden = true;
    if (f.size > 50 * 1024 * 1024) { err.textContent = 'That file is too large to be a saved copy.'; err.hidden = false; return; }
    saved = await f.text();
    ev.target.value = '';
    run();
  });
  $('#saved-clear').addEventListener('click', () => { saved = null; run(); });
  $('#add-server-card').hidden = false;
  $('#add-server').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const u = $('#server-url').value.trim().replace(/\/$/, '');
    const err = $('#server-error');
    let ok = false;
    try { const x = new URL(u); ok = x.protocol === 'https:' || x.hostname === '127.0.0.1' || x.hostname === 'localhost'; } catch { /* not a URL */ }
    err.hidden = ok; err.textContent = ok ? '' : 'Please enter a full web address that starts with https://';
    if (!ok) return;
    if (!cfg.endpoints.length) cfg.endpoints = [...(DEFAULT_ENDPOINTS[network] || [])];
    cfg.endpoints.unshift(u); addedServer = u;
    const q = new URLSearchParams(location.hash.slice(1));
    q.delete('endpoint');
    for (const e of cfg.endpoints) q.append('endpoint', e);
    history.replaceState(null, '', '#' + q.toString().replace(/%3A/g, ':').replace(/%2F/g, '/'));
    $('#server-url').value = '';
    run();
  });
  await run();
}

main().catch((e) => verdict('cannot', 'Cannot conclude', `Something went wrong: ${e.message || e}`));
