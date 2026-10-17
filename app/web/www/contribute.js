// The contribute page. Everything that touches keys, memos or tickets runs in the WebAssembly
// module, in this browser; the page talks only to the campaign's relays (public list) and to a
// public network server (to see the chain height, find the payment, and send a refund).
//
// Link: contribute.html#c=<campaign id>&relay=<url>&relay=<url>&server=<url>

import init, * as W from './pkg/ll_web.js';
import { grpcWeb } from './recount.js';
import { buildCopy, downloadCopy, fetchFinal, checkMemory, remember, memoryWords, hashesOf } from './copies.js';
import { setup, setNetwork, decorateAmounts, amountHTML, checkRow, etaText, statusBadgeHTML, setCampaignLabel, markReady } from './ui.js';
import { NOT_CHECKED } from './capabilities.js';
import { campaignView, metaLine, rulesCard, whoSeesWhat } from './public.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.hash.slice(1));
const cfg = {
  id: (params.get('c') || '').toLowerCase(),
  relays: params.getAll('relay').map((u) => u.replace(/\/$/, '')),
  // The chain server is never guessed: if the link names none, it comes from the campaign's own (checked) rules once they are read, and if the
  // rules name no known network the page refuses to go on (see applyNetwork). It is empty until then.
  server: (params.get('server') || '').replace(/\/$/, ''),
};
const DEFAULT_SERVER = { test: 'https://zjs.zec.rocks/testnet', main: 'https://zjs.zec.rocks/mainnet' };
let refused = null; // set when this page must not take a payment: the sentence that says why
const POLL_MS = 5000;
let flowBackHref = '#'; // the campaign's own page, for the Back of question 1

const storeKey = `ll:${cfg.id}`;
const load = () => { try { return JSON.parse(localStorage.getItem(storeKey)); } catch { return null; } };
let storageOk = true; // false once this browser has refused to keep something (blocked storage, a private window)
const save = () => { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch { storageOk = false; } };
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { storageOk = false; return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { storageOk = false; } };
let state = load(); // this device's contribution to this campaign, if any
let campaign = null; // summary of the campaign (from the committed rules)
let rulesJson = null;
let view = { kind: 'none', entries: [], notes: [] };
let tip = null;
let busy = false;

// ---------- small helpers ----------
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const say = (el, text) => { el.textContent = text; el.hidden = !text; };

/** A plain caution line (no box): the page's calm grey. */
function line(text) {
  const p = document.createElement('p');
  p.className = 'warnline';
  p.textContent = text;
  return p;
}

function banner(kind, text) {
  const d = document.createElement('div');
  d.className = `notice ${kind}`;
  d.textContent = text;
  return d;
}

/** "0.01" -> 1000000 (zatoshis), without floating point. Throws a plain message. */
function parseAmount(text) {
  const t = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error('Please enter an amount like 0.01');
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 1e8 + Number(frac.padEnd(8, '0'));
}

/** A fundraiser with a hard cap: the room left under it, replaying the close's rule over the public list in its order (each payment that fits
 *  uses up room; one that does not is set aside). Payments taken back are not visible here, so the real room can only be larger. */
function capRoom() {
  if (!campaign || campaign.cap_zat == null) return null;
  let room = campaign.cap_zat;
  const seen = new Set();
  for (const e of view.entries) {
    const c = e.contribution;
    if (!e.ticket || !c || c.value_zat == null || seen.has(c.nf)) continue;
    seen.add(c.nf);
    if (c.value_zat <= room) room -= c.value_zat;
  }
  return room;
}

/** An amount with all eight decimals, as the rules' amounts are shown (goal, cap, fee). */
const zat8 = (zat) => `${Math.floor(zat / 1e8)}.${String(zat % 1e8).padStart(8, '0')}`;

function coin(zat) {
  const whole = Math.floor(zat / 1e8), frac = zat % 1e8;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(8, '0')}`.replace(/0+$/, '');
}

function readVarintField(bytes, field) {
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++], f = tag >> 3, t = tag & 7;
    if (t === 0) {
      let v = 0, shift = 0, b;
      do { b = bytes[i++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
      if (f === field) return v;
    } else if (t === 2) {
      let len = 0, shift = 0, b;
      do { b = bytes[i++]; len += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
      i += len;
    } else if (t === 1) i += 8;
    else if (t === 5) i += 4;
    else break;
  }
  return null;
}

// ---------- reading the campaign's public list from every relay ----------
async function getText(url) {
  // a request that never comes back (a dropped connection on the way) is given 12 s, then asked once more for 20 s: the page never waits for good
  let r;
  try { r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12000) }); }
  catch { r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) }); }
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
}

async function readRelay(url) {
  try {
    const rules = await getText(`${url}/v1/campaigns/${cfg.id}`);
    W.campaign_summary(rules, cfg.id); // throws if these are not the campaign's committed details
    const ledgerText = await getText(`${url}/v1/campaigns/${cfg.id}/ledger?from=0`);
    const problems = JSON.parse(W.check_ledger(rules, cfg.id, ledgerText));
    return { url, rules, entries: JSON.parse(ledgerText), problems, error: null };
  } catch (e) {
    return { url, rules: null, entries: [], problems: [], error: String(e.message || e) };
  }
}

/** Agree / single / disagree / none, in plain words. A disagreement never blames anyone. */
function judge(reads) {
  const notes = [];
  for (const r of reads) {
    if (r.error) notes.push(`${hostOf(r.url)} can't be reached right now.`);
    else if (r.problems.length) notes.push(`${hostOf(r.url)} shows a list that doesn't add up, so it is being ignored.`);
  }
  const ok = reads.filter((r) => !r.error && r.problems.length === 0);
  const rules = (ok[0] || reads.find((r) => r.rules) || {}).rules || null;
  if (!ok.length) return { kind: 'none', entries: [], notes, rules };
  const best = ok.reduce((a, b) => (b.entries.length > a.entries.length ? b : a));
  const same = ok.every((r) => JSON.stringify(r.entries) === JSON.stringify(ok[0].entries));
  if (ok.length > 1 && !same) {
    notes.push("The list servers don't show the same list right now; we can't tell why, and your saved ticket still works.");
    return { kind: 'disagree', entries: best.entries, notes, rules, ok };
  }
  return { kind: ok.length > 1 ? 'agree' : 'single', entries: best.entries, notes, rules, ok };
}

// Seconds per block, measured from the block times of the last 100 blocks (never a fixed number). null until measured.
let secPerBlock = null, blockTimeAt = 0, blockTimeSpan = 0;
async function measureBlockTime() {
  if (tip == null || (secPerBlock != null && Date.now() - blockTimeAt < 600000)) return;
  blockTimeAt = Date.now();
  try {
    const timeOf = async (h) => { const [b] = await grpcWeb(cfg.server, 'GetBlockRange', W.block_range_request(h, h)); return readVarintField(b, 5); };
    const h0 = Math.max(1, tip - 100), [t0, t1] = [await timeOf(h0), await timeOf(tip)];
    if (t0 != null && t1 != null && tip - h0 >= 20 && t1 > t0) { secPerBlock = (t1 - t0) / (tip - h0); blockTimeSpan = tip - h0; }
  } catch { /* stays as it was: no estimate is shown without a measurement */ }
}

/** Once the campaign's rules are known: shows the network bar, picks the chain server, and refuses to continue when the network is not known
 *  (not test, not main) or the server named in the link belongs to the other network. A page that cannot tell the network never takes a payment. */
function applyNetwork() {
  if (!campaign || refused) return;
  const kind = setNetwork(campaign.network);
  if (kind === 'unknown') { refused = 'This page cannot tell which network this campaign is on, so it will not take a payment.'; return; }
  if (!cfg.server) cfg.server = DEFAULT_SERVER[kind];
  else if ((kind === 'main' && /testnet/i.test(cfg.server)) || (kind === 'test' && /mainnet/i.test(cfg.server))) {
    refused = `The server in this link is for the other network, so this page will not take a payment; ask for a new link.`;
  }
}

async function getTip() {
  const [msg] = await grpcWeb(cfg.server, 'GetLatestBlock', new Uint8Array());
  return readVarintField(msg, 1);
}

// ---------- what this browser last saw of the list, and a copy to keep ----------
let memKey = '';
function memoryStep() {
  const note = $('#memory-note');
  if (!(view.kind === 'single' || view.kind === 'agree')) { note.hidden = true; return; }
  const key = `${view.entries.length}`;
  if (key === memKey) return; // the same list as the last time round: nothing new to say or remember
  memKey = key;
  let hashes;
  try { hashes = hashesOf(view.entries); } catch { return; }
  const r = checkMemory(cfg.id, hashes);
  // on this page only a list that got shorter or changed is worth a line; the recount page says the rest
  const w = r.state === 'cut_off' || r.state === 'changed' ? memoryWords(r) : null;
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
}

function wireSaveCopy() {
  if (!$('#save-copy')) return; // round 13: the contribute page has no Save a copy button (the recount page's "Keep a copy" saves the same file)
  $('#save-copy').addEventListener('click', async () => {
    if (!rulesJson || !view.entries) return;
    downloadCopy(buildCopy({ rulesText: rulesJson, id: cfg.id, entries: view.entries, finalText: await fetchFinal(cfg.relays, cfg.id), challenges: [] }));
  });
}

// ---------- is the host looking at the campaign right now? ----------
// The host publishes a small signed "last seen" record to the relays (SPEC §6). It is read here and checked against the campaign's own key (a relay cannot
// invent one); an old one just means the host has not been seen lately.
let hostSeen = null; // { height, time } of the newest valid record, or null
let hostSeenAsked = false; // at least one answer round has finished
async function readHostSeen() {
  if (!rulesJson) return;
  let best = null;
  await Promise.all(cfg.relays.map(async (r) => {
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(`${r}/v1/campaigns/${cfg.id}/heartbeat`, { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      const body = await res.text(); // always read the answer to the end, so the connection is finished with
      if (!res.ok) return;
      const v = JSON.parse(W.verify_heartbeat(rulesJson, cfg.id, body));
      if (!best || v.height > best.height || (v.height === best.height && v.time > best.time)) best = v;
    } catch { /* not there, not valid, or the relay is down: it counts as no record from that relay */ }
  }));
  hostSeen = best; hostSeenAsked = true;
}

/** The note above the form and the payment steps: only while the campaign is open and this person has not paid yet. */
function renderHostSeen() {
  const box = $('#host-seen');
  const closed = view.entries.some((e) => e.kind === 'close');
  const show = campaign && hostSeenAsked && tip != null && !closed && tip <= campaign.deadline_height && !(state && (state.ticket || state.txid));
  if (!show) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const staleAfter = Math.min(20, Math.max(3, Math.round(campaign.ticket_k / 3))); // blocks
  const ago = (n) => (n <= 1 ? 'a moment ago' : eta(n) ? `${eta(n)} ago` : `${n} blocks ago`);
  const el = document.createElement('div');
  if (!hostSeen) {
    el.className = 'hint';
    el.textContent = 'This campaign does not show when its host was last seen.';
    el.dataset.state = 'missing';
  } else {
    const lag = Math.max(0, tip - hostSeen.height);
    if (lag <= staleAfter) {
      el.className = 'hint';
      el.textContent = `Host last seen ${ago(lag)} (block ${hostSeen.height}).`;
      el.dataset.state = 'fresh';
    } else {
      el.className = 'warnline';
      el.dataset.state = 'stale';
      el.textContent = `The host was last seen ${ago(lag)}; if you pay now, your ticket waits until the host returns.`;
    }
  }
  box.replaceChildren(el);
}

// ---------- finding my ticket and my payment ----------
const tested = new Set();
async function fetchBlob(nf) {
  for (const r of cfg.relays) {
    try {
      const res = await fetch(`${r}/v1/campaigns/${cfg.id}/tickets/${nf}`, { cache: 'no-store' });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch { /* try the next relay */ }
  }
  return null;
}

async function detectTicket() {
  // Every ticket blob the page has not looked at yet is fetched, in random order, and the page does not stop at its own: a relay sees the same
  // requests from every visitor and cannot tell which ticket is theirs. Each blob is fetched once per page load (a few kilobytes each).
  const latest = new Map();
  for (const e of view.entries) if (e.ticket && e.contribution) latest.set(e.contribution.nf, e);
  const todo = [...latest].filter(([nf, entry]) => !tested.has(`${nf}:${entry.blob_hash}`));
  for (let i = todo.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [todo[i], todo[k]] = [todo[k], todo[i]]; }
  let found = null;
  for (const [nf, entry] of todo) {
    const blob = await fetchBlob(nf);
    if (!state) return; // the person left this payment code meanwhile
    if (!blob) continue; // not uploaded yet: look again next time
    tested.add(`${nf}:${entry.blob_hash}`);
    if (found) continue;
    const mine = state.ticket && state.ticket.nf === nf;
    if (mine && entry.seq <= state.ticket.entry.seq) continue;
    if (!mine && state.ticket) continue;
    if (!mine && !W.blob_is_mine(state.seed, blob)) continue;
    try {
      W.open_ticket(state.seed, JSON.stringify(entry), blob); // checks it against the signed entry
    } catch { continue; }
    found = { nf, entry, blob };
  }
  if (found) {
    state.ticket = { nf: found.nf, entry: found.entry, blob_hex: bytesToHex(found.blob) };
    state.txid = `${found.entry.contribution.txid}:${found.entry.contribution.action}`;
    save();
  }
}

let rc = null, scannedTo = 0;
const memoFetched = new Set();
async function detectPayment() {
  if (state.txid || !campaign.campaign_ufvk || tip == null) return;
  if (!rc) { rc = new W.Recount(campaign.network, campaign.campaign_ufvk); scannedTo = state.startHeight - 1; }
  for (let h = scannedTo + 1; h <= tip; h += 100) {
    const to = Math.min(h + 99, tip);
    for (const b of await grpcWeb(cfg.server, 'GetBlockRange', W.block_range_request(h, to))) rc.scan_block(b);
    scannedTo = to;
  }
  for (const txid of rc.txids_needing_memos()) {
    if (memoFetched.has(txid)) continue;
    memoFetched.add(txid);
    const [raw] = await grpcWeb(cfg.server, 'GetTransaction', W.tx_filter_request(txid));
    rc.add_raw_transaction(raw);
  }
  const found = rc.find_payment(state.memo);
  if (found) {
    state.txid = found; state.paidZat = rc.find_payment_value(state.memo);
    // the height the payment was mined at, so the ticket window can be counted from it
    try { const n = JSON.parse(rc.notes_json()).find((x) => !x.change && `${x.txid}:${x.action}` === found); if (n && n.height != null) state.paidHeight = n.height; } catch { /* no height: no late notice */ }
    save();
  }
}

/** Whether the ticket's transaction is already known to the network (so a refund was already sent). */
async function ticketAlreadySent() {
  try {
    const msgs = await grpcWeb(cfg.server, 'GetTransaction', W.tx_filter_request(state.ticket.entry.ticket.txid));
    return msgs.length > 0 && msgs[0].length > 0;
  } catch { return false; } // not found: it has not been sent
}

// ---------- rejects: publish proof automatically ----------
function myReject() {
  const id = state.txid || (state.manualTxid ? `${state.manualTxid}:` : null);
  if (!id) return null;
  const [txid, action] = id.split(':');
  return view.entries.find((e) => e.kind === 'reject' && e.contribution.txid === txid && (action === '' || String(e.contribution.action) === action)) || null;
}

async function publishChallenge() {
  const rej = myReject();
  if (!rej) return;
  const sent = state.challenge || { ok: [], txid: rej.contribution.txid, action: rej.contribution.action };
  const body = W.challenge_json(state.seed, rej.contribution.txid, rej.contribution.action);
  for (const r of cfg.relays) {
    if (sent.ok.includes(r)) continue;
    try {
      const res = await fetch(`${r}/v1/campaigns/${cfg.id}/challenges`, { method: 'PUT', body });
      if (res.ok) sent.ok.push(r);
    } catch { /* retry next time */ }
  }
  state.challenge = sent;
  save();
}

// ---------- when a refund is allowed ----------
function refundMode() {
  if (!state || !state.ticket || state.refundSentAt || tip == null) return null;
  const closed = view.entries.some((e) => e.kind === 'close');
  if (tip <= campaign.deadline_height && !closed) return 'withdraw'; // a fundraiser closed early keeps what was contributed
  if (!closed && tip > campaign.deadline_height + campaign.ticket_k) return 'silent';
  const coinUnspent = state.coin && state.coin.scanned != null && state.coin.scanned >= tip - 1 && !state.coin.spent;
  // uniform auction: a winner the host has not settled by the settlement deadline may claim their own refund
  if (closed && campaign.pricing === 'uniform' && tip > campaign.settle_by && coinUnspent) return 'silent';
  // the close says this contribution is refunded, but no refund appeared within the ticket window after it: the contributor may send their own
  // ticket. The campaign's refund is this very ticket (the same presigned transaction), so the two cannot both pay out.
  if (closed && owedRefund() && tip > closeHeight() + campaign.ticket_k && coinUnspent) return 'late';
  return null;
}

function closeEntry() { return view.entries.find((e) => e.kind === 'close') || null; }
function closeHeight() { const c = closeEntry(); return c && c.close ? c.close.close_height : Infinity; }
/** Whether the close entry says this contribution is refunded: a fundraiser that missed its goal, or a bid that did not win. With a hard cap,
 *  also a contribution that does not fit under it: the public list is replayed in its order, and one that fits even counting every listed
 *  payment is certainly kept (a payment taken back only frees room); any other is treated as owed a refund (sending its ticket is then
 *  harmless: the network refuses it if the payment was kept). */
function owedRefund() {
  const c = closeEntry();
  if (!c || !c.close || !state.ticket) return false;
  if (campaign.mode === 'raise' && c.close.outcome === 'goal_met' && campaign.cap_zat != null) {
    let room = campaign.cap_zat;
    const seen = new Set();
    for (const e of view.entries) {
      const x = e.contribution;
      if (!e.ticket || !x || x.value_zat == null || seen.has(x.nf)) continue;
      seen.add(x.nf);
      const fits = x.value_zat <= room;
      if (fits) room -= x.value_zat;
      if (x.nf === state.ticket.nf) return !fits;
    }
    return true;
  }
  if (campaign.mode === 'raise') return c.close.outcome === 'goal_missed';
  return !(c.close.winners || []).includes(state.ticket.nf);
}

// ---------- rendering ----------
const eta = (blocks) => etaText(blocks, secPerBlock);

function fact(label, value) {
  const dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = value;
  return [dt, dd];
}

/** The campaign's own name (from the checked rules), else its type and short id. */
const campaignName = () => campaign.name || `${campaign.mode === 'raise' ? 'Fundraiser' : 'Auction'} ${cfg.id.slice(0, 8)}…`;

function renderAbout() {
  if (!campaign) return;
  setCampaignLabel(cfg.id, campaign.name, 'Campaign ');
  const raise = campaign.mode === 'raise';
  // a fundraiser with a hard cap says "soft cap" and "hard cap"; one without keeps the word "goal"
  const capped = raise && campaign.cap_zat != null, gw = capped ? 'soft cap' : 'goal', room = capRoom();
  const early = campaign.early_close ? `The host may close this campaign early once the ${gw} is met.` : '';
  $('#contrib-name').textContent = campaignName();
  $('#contrib-to').hidden = $('#contrib-name').hidden = false;
  // the words follow the campaign type: a fundraiser takes contributions, an auction takes bids
  $('#crumb').textContent = $('#page-title').textContent = raise ? 'Fundraiser' : 'Auction';
  document.title = `${raise ? 'Fundraiser' : 'Auction'} · ${document.title.split(' · ').pop()}`;
  // question 1 (round 11): the heading names the step; one helper line; the rules in a small box (the campaign page's own rows)
  $('#form-title').textContent = raise ? 'Contribute' : 'Bid';
  $('#q-back-label').textContent = raise ? 'Contribute' : 'Bid';
  $('#form-intro').textContent = raise ? `If the ${gw} is missed, everyone is refunded.` : "The whole amount you send is your bid. If you don't win, you are refunded.";
  const qr = raise ? [[capped ? 'Soft cap missed' : 'Goal missed', 'all refunded'], ['Smallest', `${campaign.min} ${campaign.ticker}`], ['Refund fee', `${campaign.fee} ${campaign.ticker}`]]
    : [['How winners pay', campaign.pricing === 'uniform' ? 'one price: the lowest winning bid' : 'each pays their own bid'], ['Ties', 'earlier in the chain wins'], ['Bid amounts', 'public at the close'], ['Refund fee', `${campaign.fee} ${campaign.ticker}`]];
  $('#q-rules').replaceChildren(...qr.map(([k, v]) => { const d = document.createElement('div'); d.append(Object.assign(document.createElement('span'), { textContent: k }), Object.assign(document.createElement('b'), { textContent: v })); return d; }));
  $('#addr-prefix').textContent = campaign.network === 'test' ? 'utest1' : 'u1';
  $('#cname').textContent = campaignName(); $('#cname').hidden = false;
  $('#amount-label').innerHTML = `${raise ? 'Amount' : 'Your bid'} (<span class="ticker">${campaign.ticker}</span>)`;
  $('#received-what').textContent = raise ? 'Contribution received' : 'Bid received';
  const closed = view.entries.some((e) => e.kind === 'close');
  let status = 'Checking…', left = '';
  if (tip != null) {
    if (closed) status = closedEarlyAt() != null ? `Closed early at block ${closedEarlyAt()}, once the ${gw} was met. Contributions until then are kept${capped ? ' up to the hard cap' : ''}; payments after it do not count.` : 'Closed';
    else if (tip <= campaign.deadline_height) { status = 'Open'; left = eta(campaign.deadline_height - tip) ? `${eta(campaign.deadline_height - tip)} left (block ${campaign.deadline_height})` : `${campaign.deadline_height - tip} blocks left (block ${campaign.deadline_height}); the length of a block has not been measured yet`; }
    else status = 'The deadline has passed; the campaign is wrapping up';
  }
  $('#status-line').hidden = tip == null;
  if (tip != null) {
    const closeE = view.entries.find((e) => e.kind === 'close');
    const rt = state && state.refundTrack;
    const refunding = !!closeE && closeE.close && closeE.close.outcome === 'goal_missed' && !!state && !!state.refundSentAt && !(rt && (rt.status === 'confirmed' || rt.status === 'other'));
    $('#status-chip').innerHTML = statusBadgeHTML({ phase: closed ? 'closed' : tip <= campaign.deadline_height ? 'open' : 'ended', outcome: closeE && closeE.close ? closeE.close.outcome : null, refunding, soft: campaign.mode === 'raise' && campaign.cap_zat != null }); // a capped fundraiser says soft cap, as on the campaign page
    // the same line as the campaign page (public.js metaLine); the short id once the page is the closed page
    $('#status-text').textContent = metaLine(campaign, { id: cfg.id, withId: closedView(), closed });
  }
  // the facts beside the two questions (round 12): the campaign page's Rules card, with this page's own live facts; a fact with a longer
  // explanation shows its value and a ▾ that opens the page's own sentence for it
  const t = campaign.ticker, dl_ = campaign.deadline_height.toLocaleString('en-US');
  const rows = [{ k: 'Type', v: raise ? 'Fundraiser' : 'Auction' }];
  if (raise) {
    if (capped) rows.push({ k: 'Soft cap', v: `${campaign.goal} ${t}` }, { k: 'Hard cap', v: `${campaign.cap} ${t}`, sub: 'At the close, contributions are counted in the order they reached the chain. A payment that would go over the hard cap is refunded whole by its own ticket, minus the refund fee.' }, { k: 'Room left under the hard cap', v: `${zat8(room)} ${t}` });
    else rows.push({ k: 'Goal', v: `${campaign.goal} ${t}` });
  } else {
    const uniform = campaign.pricing === 'uniform';
    rows.push({ k: 'Items', v: String(campaign.items) });
    rows.push({ k: 'How winners pay', v: uniform ? 'one price: the lowest winning bid' : 'each pays their own bid', sub: uniform ? `Everyone who wins pays the same price: the lowest winning bid. Anything extra you sent comes back to your refund address. Example: 3 items, and bids of 1.0, 0.8, 0.6 and 0.5 ${t}. The three highest win, so the price is 0.6 ${t}. Whoever bid 1.0 pays 0.6 and gets 0.4 back; whoever bid 0.8 pays 0.6 and gets 0.2 back; whoever bid 0.6 pays 0.6. Whoever bid 0.5 did not win and is refunded 0.5 ${t} less the refund fee.` : 'If your bid wins, the campaign keeps the whole amount you sent; nothing is paid back. Send exactly the amount you mean to bid.' });
    rows.push(uniform ? { k: 'Reserve', v: `${campaign.reserve} ${t}`, sub: `A bid must be at least ${coin(campaign.reserve_zat + campaign.fee_zat)} ${t} to win: the reserve price of ${campaign.reserve} ${t} plus the fee. A bid below that is refunded. If fewer bids reach it than there are items, every winner pays the reserve price plus the fee.` }
      : { k: 'Reserve', v: 'none', sub: 'There is no reserve price: the highest bids win, whatever their amount, as long as each is at least the smallest bid.' });
    rows.push({ k: 'Ties', v: 'earlier in the chain wins', sub: 'Equal bids are ordered by when they were mined: the one earlier in the chain wins.' });
    rows.push({ k: 'Each bid', v: 'for one item', sub: 'The whole amount you send is your bid. Each bid is for one item; to try for two items, make two bids.' });
    if (uniform) rows.push({ k: 'Settlement', v: `by block ${campaign.settle_by}`, sub: `The campaign must settle winners within ${campaign.settle_window} blocks after the deadline (by block ${campaign.settle_by}); after that you can claim your own refund.` });
    rows.push({ k: 'Bid amounts', v: 'public at the close', sub: 'Bid amounts stay off the public record until the auction closes; the host sees each bid as it arrives.' });
  }
  rows.push({ k: 'Status', v: status });
  if (left) rows.push({ k: 'Time left', v: left });
  if (left && secPerBlock) rows.push({ k: 'Block time', v: `≈${Math.round(secPerBlock)} seconds` });
  if (raise && campaign.early_close) rows.push({ k: 'Early close', v: 'Allowed', sub: early });
  rows.push({ k: raise ? 'Smallest contribution' : 'Smallest bid', v: `${campaign.min} ${t}` }, { k: 'Refund fee', v: `${campaign.fee} ${t}` });
  rows.push({ k: 'Deadline', v: `block ${dl_}`, sub: `Paid after block ${dl_}: not counted, not refunded.` });
  if (raise) {
    const seen = new Map();
    for (const e of view.entries) if (e.ticket && e.contribution && e.contribution.value_zat != null) seen.set(e.contribution.nf, e.contribution.value_zat);
    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    // every listed contribution with a ticket, also those taken back later (a withdrawal does not remove the entry)
    rows.push({ k: 'Public list', v: `${seen.size} ${seen.size === 1 ? 'contribution' : 'contributions'}, ${coin(total)} ${t}`, dim: 'taken back included' });
    rows.push({ k: 'Live totals', link: { href: `recount.html#c=${cfg.id}${cfg.relays.map((r) => `&relay=${r}`).join('')}`, text: 'See live totals (the recount)' } });
  }
  if (campaign.network !== 'main') rows.push({ k: 'Network', v: 'Test network: no real money' });
  rows.push({ k: 'Ticket window', v: `${campaign.ticket_k} blocks`, sub: 'Your refund ticket is issued within this window, and if the campaign has not closed this long after the deadline you may claim your own refund.' }); // always the last row
  const key = JSON.stringify(rows);
  if ($('#about-card').dataset.key !== key) { // redrawn only when a fact changes, so an opened ▾ stays open across the page's refresh
    $('#about-card').dataset.key = key;
    $('#about-card').replaceChildren(rulesCard({ id: 'about-facts', rows, folds: false })); // round 13: the card ends at its Ticket window row
    decorateAmounts($('#about-card'));
  }
  for (const el of document.querySelectorAll('.ticker')) el.textContent = campaign.ticker;
  $('#amount-hint').textContent = `At least ${campaign.min} ${campaign.ticker}${raise ? '' : ' for a bid'}. About ${campaign.fee} ${campaign.ticker} of it is kept if you get a refund.`;
  if (!state) { showAmountProblem(amountProblem()); syncForm(); } // the room under a hard cap can change while the page is open
}

/** The bid page's rules text (an auction only): what a bid is, ties, the reserve, and what happens to an overpaid bid in each kind of auction. */
function auctionRules() {
  const t = campaign.ticker;
  const common = [
    ...fact('Your bid', `The whole amount you send is your bid. Each bid is for one item; to try for two items, make two bids.`),
    ...fact('Ties', 'Equal bids are ordered by when they were mined: the one earlier in the chain wins.'),
  ];
  if (campaign.pricing !== 'uniform') {
    return [
      ...common,
      ...fact('Winning bid', 'If your bid wins, the campaign keeps the whole amount you sent; nothing is paid back. Send exactly the amount you mean to bid.'),
      ...fact('Reserve', 'There is no reserve price: the highest bids win, whatever their amount, as long as each is at least the smallest bid.'),
    ];
  }
  return [
    ...common,
    ...fact('Pricing', `Everyone who wins pays the same price: the lowest winning bid. Anything extra you sent comes back to your refund address. Example: 3 items, and bids of 1.0, 0.8, 0.6 and 0.5 ${t}. The three highest win, so the price is 0.6 ${t}. Whoever bid 1.0 pays 0.6 and gets 0.4 back; whoever bid 0.8 pays 0.6 and gets 0.2 back; whoever bid 0.6 pays 0.6. Whoever bid 0.5 did not win and is refunded 0.5 ${t} less the refund fee.`),
    ...fact('Reserve', `A bid must be at least ${coin(campaign.reserve_zat + campaign.fee_zat)} ${t} to win: the reserve price of ${campaign.reserve} ${t} plus the fee. A bid below that is refunded. If fewer bids reach it than there are items, every winner pays the reserve price plus the fee.`),
    ...fact('Settlement', `The campaign must settle winners within ${campaign.settle_window} blocks after the deadline (by block ${campaign.settle_by}); after that you can claim your own refund.`),
  ];
}

function renderBanners() {
  const box = $('#banners');
  box.replaceChildren();
  if (refused) box.append(line(refused));
  if (state && !storageOk) box.append(line('This browser cannot save your secret, so download your backup file now.'));
  for (const n of view.notes) box.append(line(n));
  if (view.kind === 'none') {
    box.append(line(state && state.ticket
      ? "We can't reach the campaign's servers right now; your refund ticket is saved here and still works."
      : "We can't reach the campaign's servers right now; please try again in a moment."));
  }
  if (tip == null && !refused) box.append(line("We can't reach the network right now, so some details may be out of date."));
}

/** One step of the tracker. `text` is its full state, always there for a screen reader; `shown` is the small caption, only when it adds something the
 *  dot and the title do not (round 13: no caption while waiting, none that only repeats the title). */
function setStep(id, done, text, shown = '') {
  const li = $(id);
  li.classList.toggle('done', done);
  li.querySelector('.state').textContent = shown;
  let sr = li.querySelector('.st-sr');
  if (!sr) { sr = Object.assign(document.createElement('span'), { className: 'sr st-sr' }); li.append(sr); }
  sr.textContent = text;
}

function renderAuction() {
  const card = $('#auction-card');
  const uniform = campaign && campaign.pricing === 'uniform';
  $('#auction-account-note').hidden = !uniform;
  card.hidden = true;
  if (!uniform || !state || !state.ticket) return;
  const close = view.entries.find((e) => e.kind === 'close');
  if (!close || !close.close.winners) return;
  const nf = state.ticket.nf;
  const price = close.close.clearing_price_zat;
  const won = close.close.winners.includes(nf);
  const settle = view.entries.find((e) => e.kind === 'settle' && e.settle.nf === nf);
  card.hidden = false;
  $('#auction-proof').hidden = true;
  if (!won) {
    $('#auction-title').textContent = 'Auction result: you did not win';
    $('#auction-text').textContent = 'Your bid was not among the winning bids. Your contribution is refunded with your ticket (the campaign sends it; if it does not, the refund button appears here).';
    return;
  }
  $('#auction-title').textContent = 'Auction result: you won';
  if (!settle) {
    $('#auction-text').textContent = `You won. The price every winner pays is ${coin(price)} ${campaign.ticker}. The campaign has not published your settlement yet; it has until block ${campaign.settle_by}. After that you can claim your refund yourself.`;
    return;
  }
  const s = settle.settle;
  $('#auction-text').textContent = `You won and paid ${coin(s.price_zat)} ${campaign.ticker} (the same price every winner pays). ${s.excess_zat > 0 ? `${coin(s.excess_zat)} ${campaign.ticker} should have been paid back to your refund address in transaction ${s.txid}.` : 'Your bid was the lowest winning bid, so nothing is paid back.'} The network fee was ${coin(s.fee_zat)} ${campaign.ticker}.`;
  $('#auction-proof').hidden = s.excess_zat === 0;
}

async function publishDisclosure(complaint) {
  const nf = state.ticket.nf;
  const settle = view.entries.find((e) => e.kind === 'settle' && e.settle.nf === nf);
  const st = $('#proof-status');
  st.hidden = false;
  if (!settle) { st.textContent = 'Your settlement has not been published yet.'; return; }
  const [txid, action] = state.txid.split(':');
  let body;
  try { body = W.disclosure_json(state.seed, txid, Number(action), complaint ? '' : $('#proof-key').value, complaint); } catch (e) { st.textContent = String(e.message || e); return; }
  let ok = 0;
  for (const r of cfg.relays) {
    try { const res = await fetch(`${r}/v1/campaigns/${cfg.id}/challenges`, { method: 'PUT', body }); if (res.ok) ok++; } catch { /* next */ }
  }
  st.textContent = ok === cfg.relays.length ? (complaint ? 'Your report was published to all the servers. It is shown as unverified until you publish the viewing key.' : 'Published to all the servers. Anyone running the recount can now check that your excess arrived.') : `Published to ${ok} of ${cfg.relays.length} servers. Try again in a moment.`;
}

/** No payment code in this browser and the campaign takes no more payments (deadline passed, or closed early): the closed page (handoff 3.7). */
const closedView = () => !state && !!campaign && tip != null && (tip > campaign.deadline_height || closedEarlyAt() != null);
let showDone = false; // the Done screen after "Finish" (presentation only; this page load)
/** Done is offered only while it is true: no refund sent, and not a closed campaign that refunds this payment. */
const doneTrue = () => !!(state && state.ticket && !state.refundSentAt && !(view.entries.some((e) => e.kind === 'close') && owedRefund()));

function renderProgress() {
  const has = !!state;
  if (!doneTrue()) showDone = false;
  $('#form-card').hidden = has || !campaign || closedView();
  $('#pay-card').hidden = !has || !!(state && state.ticket);
  $('#progress-card').hidden = !has || showDone;
  $('#done-card').hidden = !showDone;
  $('#cwrap').classList.toggle('wide', closedView());
  if (!has) payStage = null;
  else if (!state.ticket && !payStage) payStage = paymentSeen() || state.backupDownloaded ? 'pay' : 'backup';
  const inBackup = has && !state.ticket && payStage === 'backup';
  $('#pay-backup').hidden = !inBackup; $('#pay-main').hidden = inBackup;
  if (inBackup) $('#progress-card').hidden = true;
  $('#cflow').dataset.stage = !has ? 'amount' : state.ticket ? 'ticket' : payStage;
  $('#ticket-h').hidden = !(has && state.ticket);
  $('#tk-folds').hidden = !(has && state.ticket); // the ticket's conditions, checks and details only once there is a ticket
  // one Back at the top left, by step: the campaign (question 1), question 1 (question 2), the refund address (backup), backup (pay), home (ticket); none on Done
  const stage = !has ? (closedView() ? 'closed' : qStep) : state.ticket ? (showDone ? 'done' : 'ticket') : payStage;
  $('#flow-back').hidden = !(stage === 'amount' || stage === 'closed');
  $('#flow-back-label').textContent = stage === 'closed' ? 'Campaigns' : 'Campaign';
  $('#flow-back').href = stage === 'closed' ? './' : flowBackHref;
  $('#q-back').hidden = stage !== 'addr';
  $('#edit-amount').hidden = stage !== 'backup' || paymentSeen();
  $('#back-to-backup').hidden = stage !== 'pay';
  $('#tk-back').hidden = stage !== 'ticket';
  $('#about').hidden = !(campaign && (stage === 'amount' || stage === 'addr'));
  $('#cwrap').classList.toggle('qwide', !$('#about').hidden);
  $('#stand').hidden = !has || !!state.ticket;
  $('#pay-more').hidden = !has || !!state.ticket;
  $('#ticket-actions').hidden = !(has && state.ticket);
  $('#finish').hidden = !doneTrue();
  if (!has) return;
  $('#backup-saved').checked = !!state.backupDownloaded || savedTick;
  setStep('#s-backup', !!state.backupDownloaded || savedTick, state.backupDownloaded ? 'saved' : savedTick ? 'saved, by your word' : 'not yet', !state.backupDownloaded && savedTick ? 'saved, by your word' : '');
  $('#s-backup').classList.toggle('warn', !(state.backupDownloaded || savedTick)); // not saved yet: the yellow ring
  const t = !!state.ticket;
  setStep('#s-seen', !!state.txid || t, state.txid || t ? 'seen on the network' : 'waiting for you to pay');
  setStep('#s-received', t, t ? 'done' : 'waiting');
  const tcv = ticketCheck && ticketCheck.verdict;
  setStep('#s-ticket', t && tcv === 'pass', !t ? 'waiting' : tcv === 'pass' ? 'received; passed the checks below' : tcv === 'fail' ? 'did NOT pass a check' : 'received; checking it…', t && tcv === 'fail' ? 'did NOT pass a check' : '');
  $('#s-ticket').classList.toggle('bad', t && tcv === 'fail');
  { let first = true; for (const li of document.querySelectorAll('.progress li')) { if (li.id === 's-backup') continue; const w = first && !li.classList.contains('done') && !li.classList.contains('bad'); li.classList.toggle('wait', w); if (w) first = false; } }
  renderTicketView(tcv);
  renderTicketChecks();
  let note = '';
  if (!t) note = '';
  else if (tcv === 'pass') note = '';
  else if (tcv === 'fail') note = 'Your refund ticket did not pass a check (see below). Keep your backup file.';
  else note = 'Your refund ticket is saved on this device. Checking it now…';
  // after paying: the amount that was seen on the network against the amount sealed into the payment code
  const pw = $('#paid-warning');
  const rj = myReject();
  if (state.paidZat != null && state.paidZat < state.amountZat) {
    pw.hidden = false;
    pw.textContent = `Your payment of ${coin(state.paidZat)} ${campaign.ticker} is smaller than the ${coin(state.amountZat)} ${campaign.ticker} sealed into your payment code, so it will NOT count as a contribution and will not be refunded (it becomes a donation). Do not pay again with the same code; contact whoever runs the campaign.`;
  } else if (rj && /underpaid/.test(rj.reason || '') && !t) {
    pw.hidden = false;
    pw.textContent = 'Your payment was smaller than the amount sealed into your payment code, so the campaign set it aside as a donation. It will not be refunded. Do not pay again with the same code; contact whoever runs the campaign.';
  } else pw.hidden = true;
  // the ticket window has run out and no ticket came: said only when it is true (payment mined at a known height, nothing rejected, no ticket)
  const late = !t && !rj && state.paidHeight != null && tip != null && tip > state.paidHeight + campaign.ticket_k && !(state.paidZat != null && state.paidZat < state.amountZat);
  $('#ticket-late').hidden = !late;
  if (late) $('#ticket-late-detail').textContent = `Your payment was mined in block ${state.paidHeight}. The campaign promised a refund ticket within ${campaign.ticket_k} blocks, and block ${state.paidHeight + campaign.ticket_k} has passed. Keep your backup file and ask whoever runs the campaign.`;
  $('#format-note').hidden = !(state.memo && state.memo.length === 256);
  // paying more than the amount chosen is fine: the whole payment is the contribution (and is refunded, minus the fee)
  const listed = state.ticket && state.ticket.entry.contribution.value_zat;
  $('#over-note').hidden = !(listed != null && state.amountZat != null && listed > state.amountZat);
  const rej = myReject();
  const waited = state.createdAt ? Date.now() - state.createdAt : 0;
  $('#unconfirmed').hidden = !(!t && !state.txid && waited > 10 * 60 * 1000);
  if (rej && !t) note = 'The campaign did not accept the message that came with your payment.';
  $('#progress-note').textContent = note;

  // A challenge is published only when the person presses the button: it reveals the refund address for this one payment, for good.
  const proof = $('#proof'), btn = $('#challenge-btn');
  if (rej && !t) {
    const c = state.challenge;
    const done = c ? c.ok.length : 0;
    const all = c && done === cfg.relays.length;
    const underpaid = /^underpaid/.test(rej.reason || '') || (state.paidZat != null && state.paidZat < state.amountZat);
    proof.hidden = false;
    proof.className = underpaid ? 'rsect' : 'rsect warn';
    const reason = underpaid
      ? "This payment looks underpaid: it is smaller than the amount in your payment code. Publishing won't change the outcome. "
      : 'The campaign did not accept this payment. If you think it was valid, you can publish proof. ';
    const warn = 'Publishing shows everyone your refund address for this one payment, and it can\'t be undone.';
    $('#challenge-text').textContent = all
      ? 'You published proof that your payment was valid, to all the servers. Anyone checking the campaign can now see it.'
      : c && done > 0 ? `${reason}Published to ${done} of ${cfg.relays.length} servers so far. ${warn}` : `${reason}${warn}`;
    btn.hidden = !!all;
    btn.className = underpaid ? 'secondary' : '';
    btn.textContent = c && done > 0 && !all ? 'Try the remaining servers again' : 'Publish proof that my payment was valid';
  } else { proof.hidden = true; btn.hidden = true; }

  // once the ticket is here: the refund right lives in this browser and the file; a file saved now also holds the ticket
  $('#backup-nudge').hidden = !state.ticket;
  $('#backup3-done').hidden = !state.backupWithTicket;

  // refund area
  const mode = refundMode();
  $('#refund-area').hidden = !mode;
  if (!mode) { $('#refund-confirm').hidden = true; $('#refund-btn').hidden = false; }
  $('#refund-k').textContent = mode === 'withdraw' ? 'CHANGED YOUR MIND?' : 'REFUND';
  if (mode === 'withdraw') {
    $('#refund-explain').textContent = 'You can take your contribution back any time before the deadline.';
    $('#refund-btn').textContent = 'Refund me';
  } else if (mode === 'silent') {
    $('#refund-explain').textContent = "The deadline has passed and the campaign hasn't wrapped up. You can now claim your refund yourself.";
    $('#refund-btn').textContent = 'Claim my refund';
  } else if (mode === 'late') {
    $('#refund-explain').textContent = 'The campaign closed but your refund has not appeared, so you can send it yourself.';
    $('#refund-btn').textContent = 'Claim my refund';
  }
  const rr = $('#refund-result');
  if (state.refundSentAt) {
    const rf = state.refundTrack || {};
    rr.hidden = false; rr.className = rf.status === 'other' ? 'notice' : 'notice good'; rr.dataset.state = rf.status || 'sent';
    if (rf.status === 'confirmed') rr.textContent = `Your refund is confirmed in block ${rf.minedHeight}. It should reach the address you gave.`;
    else if (rf.status === 'other') rr.textContent = `Your contribution was already spent in block ${rf.minedHeight} by a different transaction (for example the campaign's own refund). Look at the address you gave; nothing more is needed from you.`;
    else if (rf.status === 'resent') rr.textContent = `Your refund had not been mined after ≈${REFUND_RESEND_BLOCKS} blocks, so we sent the very same refund again (send ${rf.sends}). You don't need to do anything, and you never need to pay again.`;
    else rr.textContent = 'Your refund was sent to the network and is waiting to be mined. If it takes long, this page sends the same refund again by itself. Nothing is lost.';
  } else if (t && !mode && tip != null) {
    rr.hidden = false; rr.className = 'notice'; rr.dataset.state = 'info';
    const closed = view.entries.some((e) => e.kind === 'close');
    rr.textContent = closed
      ? (owedRefund() ? 'The campaign has closed; if your refund does not appear, a button to send it yourself shows here.' : 'The campaign has closed.')
      : `The deadline has passed. If the campaign doesn't wrap up, a refund button will appear here after block ${campaign.deadline_height + campaign.ticket_k}.`;
  } else rr.hidden = true;
  // taken back, mined, and the campaign still takes payments: offer a new payment code (the old one is kept in the list of earlier codes)
  const rebid = !!(state.refundSentAt && state.refundTrack && state.refundTrack.status === 'confirmed' && tip != null && !view.entries.some((e) => e.kind === 'close') && tip <= campaign.deadline_height && !tooLateToStart());
  $('#rebid-row').hidden = !rebid;
  if (rebid) {
    $('#rebid').textContent = campaign.mode === 'raise' ? 'Contribute again' : 'Bid again';
    $('#rebid-text').textContent = `Your ${campaign.mode === 'raise' ? 'contribution' : 'bid'} was taken back. You can make a new one with a new payment code; this one stays in this browser's list of earlier payment codes, so keep its backup file too.`;
  }
}

let useLightCode = false; // which code the person chose; kept across refreshes
let payStage = null; // 'backup' | 'pay' while the payment card is shown (presentation only; the backup stays optional)
let savedTick = false; // the person ticked "Saved" by hand (presentation only)

function renderPay(p) {
  const tog = $('#qr-toggle');
  tog.hidden = !p.qr_svg_light;
  const showCode = () => {
    const light = useLightCode && !!p.qr_svg_light;
    $('#qr').innerHTML = light ? p.qr_svg_light : p.qr_svg;
    $('#paylink').href = light ? p.uri_light : p.uri;
    tog.textContent = light ? 'Show the full code again' : 'Code hard to scan? Show a simpler code';
  };
  tog.onclick = () => { useLightCode = !useLightCode; showCode(); $('#qr').scrollIntoView({ block: 'nearest' }); }; // the whole code in view, below the header
  showCode(); // the choice survives the page's regular refresh
  $('#pay-min').textContent = `${p.amount} ${p.ticker}`;
  $('#pay-to').textContent = p.pay_to;
  $('#memo').textContent = p.memo;
  $('#pay-amt').textContent = p.amount;
  // the rows show a short form; Copy copies the whole value (the full text is in the hidden lines above)
  for (const [id, v, n] of [['#qc-addr', p.pay_to, 7], ['#qc-memo', p.memo, 6]]) { const el = $(id); el.textContent = v.length > 2 * n + 1 ? `${v.slice(0, n)}…${v.slice(-n)}` : v; el.title = v; }
  $('#qc-amount').innerHTML = amountHTML(state.amountZat, p.ticker);
}

function paymentFromState() {
  return JSON.parse(W.build_payment(rulesJson, state.seed, state.refund, state.amountZat));
}

function renderAll() {
  renderAllInner();
  decorateAmounts(document.querySelector('main'));
}

/** New payment codes stop this many blocks before the deadline: a wallet may need a few minutes to sync and send, and a payment can wait a block or
 *  two to be mined. One mined after the deadline is not counted, not ticketed and not refunded (README, limits). */
const CUTOFF_BLOCKS = 10;
const blocksLeft = () => (campaign && tip != null ? campaign.deadline_height - tip : null);
/** The close height of a fundraiser that closed early (its rules allow it once the goal is met), or null. Payments after it do not count. */
const closedEarlyAt = () => {
  const c = campaign && campaign.early_close && view.entries.find((e) => e.kind === 'close');
  return c && c.close && c.close.close_height <= campaign.deadline_height ? c.close.close_height : null;
};
/** Open, but too close to the deadline to start a new payment. */
const pastDeadline = () => { const b = blocksLeft(); return (b != null && b < 0) || closedEarlyAt() != null; };
const tooLateToStart = () => { const b = blocksLeft(); return b != null && b >= 0 && b < CUTOFF_BLOCKS; };

/** The stepper above the page (a visual aid only): Amount, Backup, Pay, Ticket, Done. */
function renderStepper() {
  const el = $('#stepper');
  const off = !!refused || !campaign || closedView();
  el.hidden = off;
  const now = !state ? 'amount' : state.ticket ? (showDone ? 'done' : 'ticket') : (payStage || 'backup');
  const order = ['amount', 'backup', 'pay', 'ticket', 'done'];
  const first = campaign && campaign.mode !== 'raise' ? 'Bid' : 'Contribute';
  const names = { amount: first, backup: 'Backup', pay: 'Pay', ticket: 'Ticket', done: 'Done' };
  const at = order.indexOf(now);
  for (const li of el.children) {
    const i = order.indexOf(li.dataset.step);
    li.className = i === at ? 'now' : i < at ? 'done' : '';
    li.textContent = `${i < at ? '✓' : i + 1} ${names[li.dataset.step]}`;
    if (i === at) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  }
  $('#ministep').hidden = off;
  $('#ministep').textContent = `STEP ${at + 1} OF 5 · ${names[now].toUpperCase()}`;
}

/** The refund ticket drawn as a ticket, from the ticket this page holds and its checks; then four short facts about it. Presentation only. */
function renderTicketView(tcv) {
  const view_ = $('#ticket-view'), led = $('#ticket-ledger');
  const t = state && state.ticket;
  view_.hidden = led.hidden = !t;
  if (!t) return;
  const e = t.entry, c = e.contribution || {};
  const rf = state.refundTrack || {};
  $('#tk-entry').textContent = `#${e.seq}`;
  const nPass = ticketCheck ? ticketCheck.checks.filter((x) => x.status === 'pass').length : 0;
  const chip = rf.status === 'confirmed' ? ['refunded', 'Refunded'] : tcv === 'pass' ? ['pass', `✓ Held · ${nPass} checks`] : tcv === 'fail' ? ['fail', '✕ Did not pass a check'] : ['nc', 'Checking'];
  $('#tk-chip').replaceChildren(Object.assign(document.createElement('span'), { className: `tkbadge ${chip[0]}`, textContent: chip[1] }));
  const back = c.value_zat != null ? c.value_zat - campaign.fee_zat : null; // what the ticket pays: the listed contribution minus the refund fee
  $('#tk-amount-box').hidden = back == null;
  if (back != null) $('#tk-amount').innerHTML = amountHTML(back, campaign.ticker);
  const checks = ticketCheck ? ticketCheck.checks : [];
  const st = (id) => (checks.find((x) => x.id === id) || {}).status;
  const rows = [];
  if (st('pays_you') === 'pass') rows.push(['Pays', 'Your refund address, sealed so only the campaign could read it']);
  if (st('no_expiry') === 'pass') rows.push(['Expires', 'No expiry height; it is valid for this network version and is issued again after an upgrade']);
  if (c.value_zat != null || c.height != null) rows.push(['Contribution', [c.value_zat != null ? `${coin(c.value_zat)} ${campaign.ticker}` : '', c.height != null ? `block ${c.height.toLocaleString('en-US')}` : ''].filter(Boolean).join(' · ')]);
  rows.push(['Kept where', storageOk ? 'This browser; with your backup file this page can fetch it again from a relay' : 'With your backup file this page can fetch it again from a relay']);
  $('#tk-facts').replaceChildren(...rows.flatMap(([k, v]) => fact(k, v)));
  // four facts, kept apart: saved, checked, refund path, refund
  const pass = checks.filter((x) => x.status === 'pass'), fail = checks.filter((x) => x.status === 'fail'), not = checks.filter((x) => x.status === 'not_checked');
  const mode = refundMode();
  const cells = [
    ['Saved', storageOk ? ['ok', 'Yes', 'In this browser'] : ['warn', 'Not in this browser', 'Keep your backup file']],
    ['Checked', !ticketCheck ? ['', 'Checking…', ''] : fail.length ? ['bad', `${fail.length} ${fail.length === 1 ? 'check' : 'checks'} failed`, 'Keep your backup file'] : ['ok', `${pass.length} of ${checks.length} passed`, not.length ? `Not checked: ${not.map((x) => x.label).join('; ')}` : '']],
    ['Refund path', state.refundSentAt ? ['', 'Used', ''] : tcv === 'fail' ? ['warn', "Don't rely on it yet", ''] : mode === 'withdraw' ? ['teal', 'Available', `“Refund me” until block ${campaign.deadline_height}`] : mode ? ['teal', 'Available', '“Claim my refund”'] : ['', 'Not available now', '']],
    ['Refund', !state.refundSentAt ? ['', 'Not sent', ''] : rf.status === 'confirmed' ? ['ok', 'Confirmed', `Block ${rf.minedHeight}`] : rf.status === 'other' ? ['', 'Spent by another transaction', `Block ${rf.minedHeight}`] : ['warn', 'Sent, waiting to be mined', 'Resent automatically if slow']],
  ];
  led.replaceChildren(...cells.map(([label, [cls, value, sub]]) => {
    const d = document.createElement('div');
    const l = document.createElement('p'); l.className = 'tl-l'; l.textContent = label;
    const v = document.createElement('p'); v.className = `tl-v ${cls}`; v.textContent = value;
    d.append(l, v);
    if (sub) { const s2 = document.createElement('p'); s2.className = 'tl-s'; s2.textContent = sub; d.append(s2); }
    return d;
  }));
}

/** The one line about the deadline, only in the last blocks before it. */
function renderNearDeadline() {
  const el = $('#near-deadline');
  let text = '';
  if (tooLateToStart() && !state) text = `New payments stop ${CUTOFF_BLOCKS} blocks before the deadline, because one mined after it would not count.`;
  else if (tooLateToStart() && state && !state.txid && !state.ticket) text = `The deadline is block ${campaign.deadline_height}; a payment mined after it is not counted or refunded.`;
  else if (pastDeadline() && state && !state.txid && !state.ticket) text = closedEarlyAt() != null ? 'The campaign has closed, so a payment now is not counted or refunded automatically.' : 'The deadline has passed, so a payment now is not counted or refunded automatically.';
  el.textContent = text;
  el.hidden = !text;
  syncForm(); // the buttons: valid input, and not in the last blocks before the deadline
}

function renderAllInner() {
  renderBanners();
  renderNearDeadline();
  renderStepper();
  if (refused) { for (const id of ['#form-card', '#pay-card', '#progress-card', '#auction-card']) $(id).hidden = true; return; } // no payment on a page that cannot tell the network
  renderHostSeen();
  renderEarlier();
  renderAuction();
  renderAbout();
  renderProgress();
  { const seen = paymentSeen(); $('#edit-locked').hidden = !seen; }
  if (state && !state.ticket) enterPayHistory();
  if (state && !state.ticket) { try { renderPay(paymentFromState()); } catch (e) { $('#banners').append(banner('bad', e.message)); } }
  // No new contributions: the closed page. Someone who already contributed restores their backup from its "Have a ticket backup file?" link
  // (their ticket, refund and auction result all depend on it); it is redrawn only when the list changes.
  const cc = $('#closed-card');
  cc.hidden = !closedView();
  if (closedView()) {
    const key = `${view.entries.length}:${tip > campaign.deadline_height}:${secPerBlock != null}`;
    if (cc.dataset.key !== key) {
      cc.dataset.key = key;
      const tail = `c=${cfg.id}${cfg.relays.map((r) => `&relay=${r}`).join('')}`;
      campaignView(cc, { c: campaign, id: cfg.id, entries: view.entries, ok: view.ok, relays: cfg.relays, single: view.kind === 'single', tip, secPerBlock, links: { recount: `recount.html#${tail}`, card: `card.html#${tail}` } }); // round 13: no "Not checked by a recount" fold on the closed page
    }
  } else cc.dataset.key = '';
  $('#cname').hidden = closedView() || !campaign;
  // the Done screen
  if (showDone && campaign) {
    $('#done-h').textContent = campaign.mode === 'raise' ? "You're in." : 'Your bid is in.';
    $('#done-text').textContent = `${storageOk ? 'Your refund ticket is saved on this device. ' : ''}Keep your backup file; with it you can open your ticket from any browser.`;
  }
}

// ---------- going back, starting over, and earlier payment codes ----------
// A payment code that has been left is never thrown away: it is kept here, and said so on the page, because a payment made with it is still a live contribution.
const earlierKey = `${storeKey}:earlier`;
const loadEarlier = () => { try { return JSON.parse(localStorage.getItem(earlierKey)) || []; } catch { return []; } };
const saveEarlier = (l) => { try { localStorage.setItem(earlierKey, JSON.stringify(l)); } catch { /* the page still works */ } };
let armedRemove = null; // the left-at time of the earlier code whose removal was asked once
let leaveTo = null; // 'amount' | 'over'

function askLeave(kind) {
  leaveTo = kind;
  $('#leave-text').textContent = state.txid
    ? 'This payment was seen, so paying again with a new code makes a second contribution; download your backup first.'
    : 'If you already paid with this code, stay; if not, leaving loses nothing and the code is kept.';
  // right under the buttons that asked: the backup step's own Back, or the row of Back to the amount, Start over and Download backup file
  if (!$('#pay-backup').hidden) $('#pay-backup').after($('#leave-confirm')); else $('#leave-box').after($('#leave-confirm'));
  $('#leave-confirm').hidden = false;
  $('#leave-confirm').scrollIntoView({ block: 'center' }); // the question sits below the code; bring it to where the button was tapped
}

const paymentSeen = () => !!(state && (state.txid || state.manualTxid));
const canKeepLeft = () => { try { const k = `${earlierKey}:probe`; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch { return false; } };
let skipPop = false; // the history entry of the payment step is being consumed by our own back()

function leavePayment() {
  if (leaveTo === 'amount' && paymentSeen()) return; // a payment for this code was seen: the amount can no longer be changed (Start over keeps its own warning)
  const old = state;
  const kept = canKeepLeft();
  saveEarlier([...loadEarlier(), { ...old, leftAt: Date.now() }]);
  // The browser cannot keep the left code: the only copy of its secret would vanish, so it goes into a backup file first.
  if (!kept && !old.backupDownloaded) downloadBackup(old);
  state = null; rc = null; scannedTo = 0; ticketCheck = null;
  try { localStorage.removeItem(storeKey); } catch { /* ignore */ }
  $('#leave-confirm').hidden = true;
  const note = $('#left-note');
  if (leaveTo === 'amount') {
    note.textContent = kept
      ? 'Do not pay the previous code; if you already did, it still counts and is listed below.'
      : 'Do not pay the previous code; if you already did, keep the backup file just saved.';
    note.hidden = false;
  } else note.hidden = true;
  renderAll();
  if (leaveTo === 'amount') { $('#amount').value = coin(old.amountZat); $('#refund').value = old.refund; qStep = 'addr'; }
  else { $('#amount').value = ''; $('#refund').value = ''; qStep = 'amount'; }
  syncForm();
  if (history.state && history.state.cbPay && !skipPop) { skipPop = true; history.back(); }
  $('#form-card').scrollIntoView({ behavior: 'smooth' });
}

/** The phone's back gesture: from the payment step it goes back to the amount step instead of leaving the page. */
function enterPayHistory() {
  try { if (!(history.state && history.state.cbPay)) history.pushState({ cbPay: 1 }, ''); } catch { /* history not available: the button still works */ }
}
window.addEventListener('popstate', () => {
  if (skipPop) { skipPop = false; return; }
  if (!state || state.ticket) return;
  enterPayHistory(); // stay on the payment step unless the code can safely be left
  if (paymentSeen()) { $('#edit-locked').hidden = false; $('#edit-locked').scrollIntoView({ block: 'center' }); return; }
  if (!canKeepLeft() && !state.backupDownloaded) { askLeave('amount'); $('#leave-text').textContent = 'This browser cannot keep your secret, so download your backup file before going back.'; $('#leave-confirm').scrollIntoView({ block: 'center' }); return; }
  leaveTo = 'amount'; leavePayment();
});

function followEarlier(i) {
  const list = loadEarlier();
  const [e] = list.splice(i, 1);
  saveEarlier(list);
  const { leftAt, ...rest } = e;
  state = rest; rc = null; scannedTo = 0; ticketCheck = null;
  save(); renderAll(); refresh();
}

function renderEarlier() {
  const box = $('#earlier'), list = loadEarlier();
  box.hidden = list.length === 0;
  if (!list.length) return;
  // one label instead of a paragraph: the note above says, right after the change, not to pay an old code
  const head = document.createElement('p');
  head.className = 't-label';
  head.textContent = 'Earlier payment codes in this browser (each still counts if you paid it)';
  box.replaceChildren(head);
  list.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const what = document.createElement('span');
    const stage = e.ticket ? 'refund ticket received' : e.txid ? 'payment seen on the network' : 'no payment seen yet';
    what.textContent = `${coin(e.amountZat)} ${campaign ? campaign.ticker : ''}, left ${new Date(e.leftAt).toISOString().slice(0, 16).replace('T', ' ')} UTC (${stage})`;
    row.append(what);
    if (!state) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = 'Follow it again';
      b.onclick = () => followEarlier(i); row.append(b);
    }
    const r = document.createElement('button'); r.type = 'button'; r.className = 'secondary';
    r.textContent = armedRemove === e.leftAt ? 'Really remove? This deletes its refund secret' : 'I never paid with it: remove';
    r.onclick = () => {
      if (armedRemove !== e.leftAt) { armedRemove = e.leftAt; renderAll(); return; }
      const l = loadEarlier(); l.splice(i, 1); saveEarlier(l); armedRemove = null; renderAll();
    };
    row.append(r);
    box.append(row);
  });
}

// ---------- the refresh loop ----------
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const reads = await Promise.all(cfg.relays.map(readRelay));
    view = judge(reads);
    if (view.rules && !rulesJson) { rulesJson = view.rules; lsSet(`${storeKey}:rules`, rulesJson); }
    if (rulesJson && !campaign) campaign = JSON.parse(W.campaign_summary(rulesJson, cfg.id));
    applyNetwork();
    if (refused || !cfg.server) { tip = null; return; }
    try { tip = await getTip(); } catch { tip = null; }
    await measureBlockTime();
    await readHostSeen();
    memoryStep();
    const mine = state; // the person may leave this payment code (back, start over) while the network is being asked
    if (mine) {
      try {
      if (!state.ticket) {
        await detectTicket();
        try { await detectPayment(); } catch { /* the network server may be busy; try again */ }
      } else {
        await detectTicket(); // picks up a re-issued ticket
        if (!state.refundSentAt && (await ticketAlreadySent())) { state.refundSentAt = Date.now(); state.refundTrack = { fromHeight: state.ticket.entry.contribution.height, lastSendTip: tip ?? 0, sends: 1, status: 'sent', minedHeight: null, spender: null, scanned: null }; save(); }
        if (state.refundSentAt && !state.refundTrack) { state.refundTrack = { fromHeight: state.ticket.entry.contribution.height, lastSendTip: tip ?? 0, sends: 1, status: 'sent', minedHeight: null, spender: null, scanned: null }; save(); }
        await trackRefund();
        await scanCoin();
        await checkTicket();
      }
      } catch (e) { if (state === mine) throw e; /* left meanwhile: this pass is dropped */ }
    }
  } finally {
    busy = false;
    renderAll();
  }
}

// ---------- actions ----------
function downloadBackup(st = state) {
  const out = {
    kind: 'contribution-backup', version: 1, campaign: cfg.id, relays: cfg.relays, server: cfg.server,
    seed: st.seed, refundAddress: st.refund, amountZat: st.amountZat, memo: st.memo,
    payment: st.txid || null, ticket: st.ticket || null, savedAt: new Date().toISOString(),
    note: 'Keep this file private. With it you can get your refund even if this page is gone. Anyone who has it can send your refund early (the money still goes only to your refund address) and can see your amount, your refund address and your payment. It cannot be used to send your money anywhere else.',
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = `contribution-backup-${cfg.id.slice(0, 8)}.json`;
  document.body.append(a); a.click(); a.remove();
  st.backupDownloaded = true; if (st.ticket) st.backupWithTicket = true;
  if (st === state) { save(); renderAll(); }
}

/** What is wrong with the amount typed, or null: not a number, below the smallest contribution, above the room left under a hard cap.
 *  An empty field is fine while typing and is "not a number" when the payment is made. */
function amountProblem(onSubmit = false) {
  const t = $('#amount').value.trim();
  if (!campaign || (!t && !onSubmit)) return null;
  let zat;
  try { zat = parseAmount(t); } catch (e) { return e.message; }
  if (zat < campaign.min_zat) return `The smallest amount this campaign accepts is ${campaign.min} ${campaign.ticker}.`;
  // a hard cap: an amount larger than the room left is refused here (the network would take it, but it could only be refunded at the close)
  const room = capRoom();
  if (room != null && zat > room) {
    return room < campaign.min_zat
      ? 'The hard cap is reached, so this page will not make a new payment. Room frees up only if earlier contributors take their payments back.'
      : `This is more than the room left under the hard cap (${coin(room)} ${campaign.ticker}). Enter at most that amount.`;
  }
  return null;
}
/** The amount's message sits directly under the amount box, in place of the grey hint, and the box glows red while it shows. */
function showAmountProblem(msg) {
  const inp = $('#amount'), e = $('#amount-error');
  e.textContent = msg || ''; e.hidden = !msg; $('#amount-hint').hidden = !!msg;
  $('.amountbox').classList.toggle('bad', !!msg);
  if (msg) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', 'amount-error'); }
  else { inp.removeAttribute('aria-invalid'); inp.setAttribute('aria-describedby', 'amount-hint'); }
}

// ---------- the two questions (round 11): one input per screen, its button enabled only when the input is valid ----------
let qStep = 'amount'; // 'amount' | 'addr', before a payment code exists (presentation only)
/** The address checked by the same rule onCreate uses (the WebAssembly module); null when valid, else its message. */
function addressProblem() {
  try { W.check_refund_address(campaign.network, $('#refund').value); return null; } catch (e) { return e.message || String(e); }
}
function syncForm() {
  if (!campaign) return;
  const t = $('#amount').value.trim();
  const msg = t ? amountProblem(true) : null, ok = !!t && !msg;
  $('.amountbox').classList.toggle('good', ok);
  $('#amount-ok').hidden = !ok; $('#amount-hint').hidden = !!t;
  if (ok) $('#amount-ok').textContent = `✓ A refund would return ${coin(parseAmount(t) - campaign.fee_zat)} ${campaign.ticker} after the ${campaign.fee} ${campaign.ticker} fee.`;
  $('#to-addr').disabled = !ok || tooLateToStart();
  $('#to-addr-why').textContent = ok ? '' : 'Enter an amount to continue.';
  const a = $('#refund').value.trim(), am = a ? addressProblem() : null, aok = !!a && !am;
  $('#refund').classList.toggle('good', aok); $('#refund').classList.toggle('bad', !!am);
  const rm = $('#refund-msg');
  rm.textContent = !a ? 'Your refund goes here and nowhere else.' : aok ? '✓ Looks like a shielded address.' : am;
  rm.className = `cmsg${!a ? '' : aok ? ' good' : ' bad'}`;
  $('#create').disabled = !aok || !ok || tooLateToStart();
  $('#create-why').textContent = aok ? '' : 'Paste your refund address to continue.';
  // the step shown, the progress bar and the back pill
  $('#q-amount').hidden = qStep !== 'amount'; $('#q-addr').hidden = qStep !== 'addr';
  $('#q-label').textContent = `QUESTION ${qStep === 'amount' ? 1 : 2} OF 2`;
  $('#q-bar').style.width = qStep === 'amount' ? '50%' : '100%';
}
function goQuestion(q) {
  qStep = q; renderAll();
  window.scrollTo(0, 0);
  (q === 'addr' ? $('#refund') : $('#amount')).focus({ preventScroll: true });
}

async function onCreate(ev) {
  ev.preventDefault();
  if (qStep === 'amount') { if (!$('#to-addr').disabled) goQuestion('addr'); else showAmountProblem(amountProblem(true)); return; }
  const err = $('#form-error'), gen = $('#create-error');
  say(err, ''); say(gen, '');
  if (tooLateToStart()) return; // the line above the form says why
  const amountMsg = amountProblem(true);
  let addrMsg = null;
  try { W.check_refund_address(campaign.network, $('#refund').value); } catch (e) { addrMsg = e.message || String(e); }
  showAmountProblem(amountMsg);
  say(err, addrMsg || ''); // the message under the refund address is only ever about the address
  if (amountMsg) { qStep = 'amount'; syncForm(); $('#amount').focus(); return; }
  if (addrMsg) { $('#refund').focus(); return; }
  try {
    const zat = parseAmount($('#amount').value);
    const seed = W.generate_seed();
    const p = JSON.parse(W.build_payment(rulesJson, seed, $('#refund').value, zat)); // refuses anything invalid
    state = { seed, refund: $('#refund').value.trim(), amountZat: zat, memo: p.memo, createdAt: Date.now(),
      startHeight: Math.max(0, (tip ?? 0) - 10), txid: null, manualTxid: null, ticket: null, challenge: null, refundSentAt: null, backupDownloaded: false };
    save();
    $('#left-note').hidden = true;
    renderAll();
    enterPayHistory();
    $('#pay-card').scrollIntoView({ behavior: 'smooth' });
    refresh();
  } catch (e) {
    say(gen, e.message || String(e));
  }
}

// ---------- following the refund and the coin ----------
const REFUND_RESEND_BLOCKS = 10; // about ten blocks without it being mined, and unknown to the server: send the same bytes again

/** Looks for the spending of this nullifier in the blocks `from..to` (compact blocks carry every nullifier). */
async function scanSpend(nf, from, to) {
  const w = new W.SpendWatch(JSON.stringify([nf]));
  for (let h = from; h <= to; h += 100) {
    const end = Math.min(h + 99, to);
    for (const b of await grpcWeb(cfg.server, 'GetBlockRange', W.block_range_request(h, end))) w.scan_block(b);
  }
  const s = w.spent(nf);
  return s ? JSON.parse(s) : null;
}

async function sendRefundBytes() {
  const t = JSON.parse(W.open_ticket(state.seed, JSON.stringify(state.ticket.entry), hexToBytes(state.ticket.blob_hex)));
  const [resp] = await grpcWeb(cfg.server, 'SendTransaction', W.send_request(t.raw_hex)); // the very same bytes every time
  const r = JSON.parse(W.parse_send_response(resp));
  // "already known" means the network has it: not an error
  if (!r.ok && !/already|duplicate|known/i.test(r.message || '')) throw new Error(r.message || 'The network did not accept it.');
  return t;
}

/** After the refund was sent: is the coin spent, by what, and in which block? If it is not mined after about ten
 *  blocks and the network does not know the transaction, send the same bytes again. Never asks the person to pay again. */
async function trackRefund() {
  const rf = state.refundTrack;
  if (!rf || rf.status === 'confirmed' || rf.status === 'other' || tip == null || !state.ticket) return;
  const nf = state.ticket.nf;
  try {
    const from = Math.max(rf.scanned ? rf.scanned + 1 : 0, (rf.fromHeight ?? tip) );
    if (from <= tip) {
      const s = await scanSpend(nf, from, tip);
      rf.scanned = tip;
      if (s) {
        rf.minedHeight = s.height; rf.spender = s.txid;
        rf.status = s.txid === state.ticket.entry.ticket.txid ? 'confirmed' : 'other';
        save();
        return;
      }
    }
    if (tip >= rf.lastSendTip + REFUND_RESEND_BLOCKS) {
      if (await ticketAlreadySent()) { rf.lastSendTip = tip; } // the network has it (waiting to be mined)
      else {
        await sendRefundBytes();
        rf.sends += 1; rf.lastSendTip = tip; rf.status = 'resent';
      }
    }
    save();
  } catch { /* the network server may be busy; look again next time */ }
}

/** Uniform auction: is this contributor's coin still unspent? (A winner may self refund only if the campaign did
 *  not settle them within the settlement window and the coin is still unspent.) */
async function scanCoin() {
  if (!state || !state.ticket || tip == null) return;
  const c = (state.coin ||= { scanned: null, spent: null });
  if (c.spent) return;
  const from = c.scanned != null ? c.scanned + 1 : state.ticket.entry.contribution.height;
  if (from > tip) return;
  try {
    const s = await scanSpend(state.ticket.nf, from, tip);
    c.scanned = tip;
    if (s) c.spent = s;
    save();
  } catch { /* try again */ }
}


// ---------- checking the ticket (SPEC §3.1): the page lists only the checks that actually ran ----------
let ticketCheck = null;
let branchCache = null;
const proofResults = new Map(); // ticket txid -> the proof check once it has run (this page load only)
let proofWorker = null;

/** Level 3: runs the proof check in a background worker, only when asked. Can be cancelled at any time. */
function startProofCheck() {
  if (proofWorker || !state || !state.ticket) return;
  const t = JSON.parse(W.open_ticket(state.seed, JSON.stringify(state.ticket.entry), hexToBytes(state.ticket.blob_hex)));
  const progress = $('#proof-progress');
  const finish = () => { if (proofWorker) proofWorker.terminate(); proofWorker = null; $('#proof-cancel').hidden = true; renderTicketChecks(); };
  progress.hidden = false; progress.textContent = 'Starting…'; $('#proof-cancel').hidden = false; $('#proof-btn').hidden = true;
  proofWorker = new Worker('proof-worker.js', { type: 'module' });
  proofWorker.onmessage = (e) => {
    if (e.data.type === 'status') { progress.textContent = e.data.text; return; }
    const txid = state.ticket.entry.ticket.txid;
    if (e.data.type === 'result') {
      proofResults.set(txid, e.data.ok
        ? { id: 'proof', status: 'pass', label: 'the proof is valid', detail: 'the zero knowledge proof of this ticket verifies' }
        : { id: 'proof', status: 'fail', label: 'its proof does not verify', detail: 'the zero knowledge proof of this ticket does not verify, so the network would refuse the ticket' });
    } else progress.textContent = `The proof could not be checked (${e.data.text}). It stays "not checked".`;
    finish();
    if (e.data.type === 'result') checkTicket().then(renderAll);
  };
  proofWorker.onerror = () => { progress.textContent = 'The proof could not be checked on this device. It stays "not checked".'; finish(); };
  proofWorker.postMessage({ raw_hex: t.raw_hex, branch: t.branch_id });
}

function cancelProofCheck() {
  if (!proofWorker) return;
  proofWorker.terminate(); proofWorker = null;
  $('#proof-progress').textContent = 'Stopped. The proof stays "not checked".';
  $('#proof-cancel').hidden = true;
  renderTicketChecks();
}

async function checkTicket() {
  if (!state || !state.ticket || !campaign) return;
  let branch = null;
  if (branchCache && Date.now() - branchCache.at < 60000) branch = branchCache.branch;
  else {
    try { const [m] = await grpcWeb(cfg.server, 'GetLightdInfo', new Uint8Array()); branch = JSON.parse(W.parse_lightd_info(m)).branch; branchCache = { branch, at: Date.now() }; } catch { /* not checked this time */ }
  }
  let raw, opening = null;
  try {
    const t = JSON.parse(W.open_ticket(state.seed, JSON.stringify(state.ticket.entry), hexToBytes(state.ticket.blob_hex)));
    raw = t.raw_hex; opening = t.opening || null; // version 1 tickets carry no opening
  } catch (e) {
    ticketCheck = { verdict: 'fail', checks: [{ id: 'readable', status: 'fail', label: 'it could not be opened with your secret', detail: String(e.message || e) }] }; // the label: the lists below print one for every check
    return;
  }
  const nf = state.ticket.nf;
  const known = view.entries.filter((e) => e.ticket && e.contribution && e.contribution.nf === nf).map((e) => e.ticket.txid)
    .concat(view.entries.filter((e) => e.kind === 'settle' && e.settle.nf === nf).map((e) => e.settle.txid));
  const c = state.coin || {};
  const fresh = JSON.parse(W.verify_ticket(JSON.stringify({
    raw_hex: raw, expected_txid: state.ticket.entry.ticket.txid, ticket_branch: state.ticket.entry.ticket.branch_id, contribution_nf: nf,
    fee_zat: campaign.fee_zat, current_branch: branch, scanned_to: c.scanned ?? null, spent: c.spent || null, known_txids: known,
    listed_contribution_zat: state.ticket.entry.contribution.value_zat ?? null, intended_contribution_zat: state.amountZat ?? null, paid_zat: state.paidZat ?? null,
    opening, refund_receiver_hex: state.refund ? (W.refund_receiver_hex(state.refund) || null) : null,
    // for a fundraiser the amount is public, so the refund must be exactly the contribution minus the fee
    expected_value_zat: state.ticket.entry.contribution.value_zat != null ? state.ticket.entry.contribution.value_zat - campaign.fee_zat : null,
  })));
  const pr = proofResults.get(state.ticket.entry.ticket.txid);
  if (pr) {
    const k = fresh.checks.findIndex((x) => x.id === 'proof');
    if (k >= 0) fresh.checks[k] = pr;
    fresh.verdict = fresh.checks.some((x) => x.status === 'fail') ? 'fail' : 'pass';
  }
  ticketCheck = fresh;
}

let tcKey = '';
function renderTicketChecks() {
  const box = $('#ticket-checks');
  box.hidden = !(state && state.ticket);
  if (box.hidden) return;
  const bad = $('#tc-bad');
  if (!ticketCheck) { bad.hidden = true; $('#tc-summary').textContent = 'Checking your ticket…'; $('#tc-count').textContent = ''; $('#tc-list').replaceChildren(); return; }
  const by = (s) => ticketCheck.checks.filter((x) => x.status === s);
  const pass = by('pass'), fail = by('fail'), not = by('not_checked');
  // one check per line, as a sentence; then, under a thin line, what was not checked
  const sentence = (t) => `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
  const lines = (items, cls) => { const ul = document.createElement('ul'); ul.className = cls; ul.append(...items.map((x) => Object.assign(document.createElement('li'), { textContent: sentence(x.label) }))); return ul; };
  const parts = [pass.length ? lines(pass, 'tc-ok') : Object.assign(document.createElement('p'), { textContent: 'Nothing checked yet.' })];
  if (not.length) { const nb = document.createElement('div'); nb.className = 'tc-not'; nb.append(Object.assign(document.createElement('p'), { className: 'tc-not-k', textContent: 'Not checked:' }), lines(not, 'tc-nc')); parts.push(nb); }
  $('#tc-summary').replaceChildren(...parts);
  $('#tc-count').textContent = `${pass.length} ${pass.length === 1 ? 'check' : 'checks'}`;
  if (fail.length) {
    bad.hidden = false;
    const special = fail.find((x) => x.id === 'network_version') ? ' This ticket is for an older network version; the campaign must reissue it.'
      : fail.find((x) => x.id === 'coin_unspent') ? ` ${fail.find((x) => x.id === 'coin_unspent').detail}.` : '';
    bad.textContent = `Your ticket did not pass a check: ${fail.map((x) => x.label).join('; ')}. Don't rely on it yet. Keep your backup file.${special}`;
  } else bad.hidden = true;
  const proofPending = ticketCheck.checks.find((x) => x.id === 'proof' && x.status === 'not_checked');
  $('#proof-row').hidden = !(proofPending || proofWorker);
  $('#proof-btn').hidden = !!proofWorker || !proofPending;
  if (!proofWorker && !proofPending) $('#proof-progress').hidden = true;
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const key = JSON.stringify(ticketCheck.checks);
  if (key !== tcKey) $('#tc-list').replaceChildren(...ticketCheck.checks.map((x) => checkRow({ id: x.id, name: cap(x.label), detail: x.detail, status: x.status })));
  tcKey = key; // rows are redrawn only when they change, so an open tooltip is not lost on every refresh
}

async function onRefundConfirmed() {
  const rr = $('#refund-result');
  try {
    await sendRefundBytes();
    state.refundSentAt = Date.now();
    state.refundTrack = { fromHeight: Math.max(0, (tip ?? 0) - 2), lastSendTip: tip ?? 0, sends: 1, status: 'sent', minedHeight: null, spender: null, scanned: null };
    save();
  } catch (e) {
    rr.hidden = false; rr.className = 'notice bad';
    rr.textContent = `We couldn't send your refund just now (${e.message || e}). Nothing was lost; you can try again, or use your backup file.`;
    return;
  }
  renderAll();
}

/** A backup file handed over by the Recount page's "Import ticket backup file" box, through this tab's session storage: read once and deleted
 *  at once, then given to the ordinary "I have a backup file" restore below, unchanged. Never when this browser already holds a payment here. */
function takeHandedBackup() {
  let text = null;
  try { const k = `cb-handover:${cfg.id}`; text = sessionStorage.getItem(k); sessionStorage.removeItem(k); } catch { return; }
  if (!text || state || !campaign) return;
  const input = $('#restore');
  try { const dt = new DataTransfer(); dt.items.add(new File([text], 'backup.json', { type: 'application/json' })); input.files = dt.files; } catch { return; }
  input.dispatchEvent(new Event('change'));
}

function onRestore(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  f.text().then((t) => {
    const b = JSON.parse(t);
    if (b.kind !== 'contribution-backup' || b.campaign !== cfg.id) throw new Error('That backup file is for a different campaign.');
    state = { seed: b.seed, refund: b.refundAddress, amountZat: b.amountZat, memo: b.memo, createdAt: Date.now(),
      startHeight: Math.max(0, (tip ?? 0) - 1000), txid: b.payment || null, manualTxid: null, ticket: b.ticket || null,
      challenge: null, refundSentAt: null, backupDownloaded: true };
    save(); renderAll(); refresh();
  }).catch((e) => say($('#restore-error'), e.message || 'That file could not be read.'));
}

function wire() {
  $('#challenge-btn').addEventListener('click', async () => { $('#challenge-btn').disabled = true; try { await publishChallenge(); } finally { $('#challenge-btn').disabled = false; renderAll(); } });
  $('#proof-btn').addEventListener('click', startProofCheck);
  $('#proof-cancel').addEventListener('click', cancelProofCheck);
  $('#proof-publish').addEventListener('click', () => publishDisclosure(false));
  $('#proof-complain').addEventListener('click', () => publishDisclosure(true));
  $('#form').addEventListener('submit', onCreate);
  $('#amount').addEventListener('input', () => {
    const a = $('#amount'); if (a.value.includes(',')) { const pos = a.selectionStart; a.value = a.value.replace(/,/g, '.'); a.setSelectionRange(pos, pos); } // a comma becomes a dot
    showAmountProblem(amountProblem()); syncForm();
  }); // at once, on every keystroke
  $('#refund').addEventListener('input', syncForm);
  $('#to-addr').addEventListener('click', () => { if (!$('#to-addr').disabled) goQuestion('addr'); });
  $('#q-back').addEventListener('click', () => goQuestion('amount'));
  $('#finish').addEventListener('click', () => { if (!doneTrue()) return; showDone = true; renderAll(); window.scrollTo(0, 0); });
  $('#to-ticket').addEventListener('click', () => { showDone = false; renderAll(); window.scrollTo(0, 0); });
  $('#backup').addEventListener('click', () => downloadBackup());
  $('#to-pay').addEventListener('click', () => { payStage = 'pay'; renderAll(); $('#cflow').scrollIntoView({ block: 'start' }); });
  $('#back-to-backup').addEventListener('click', () => { payStage = 'backup'; renderAll(); });
  $('#backup-saved').addEventListener('change', (e) => { savedTick = e.target.checked; renderAll(); });
  $('#edit-amount').addEventListener('click', () => askLeave('amount'));
  $('#start-over').addEventListener('click', () => askLeave('over'));
  $('#leave-yes').addEventListener('click', leavePayment);
  $('#leave-no').addEventListener('click', () => { $('#leave-confirm').hidden = true; });
  $('#backup2').addEventListener('click', () => downloadBackup());
  $('#backup3').addEventListener('click', () => downloadBackup());
  $('#rebid').addEventListener('click', () => { leaveTo = 'over'; leavePayment(); });
  $('#restore').addEventListener('change', onRestore);
  // the folds row under the questions: each button opens its own panel under the row; several may be open
  for (const b of document.querySelectorAll('.qf-btn')) b.addEventListener('click', () => { const o = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', String(o)); $(`#${b.getAttribute('aria-controls')}`).hidden = !o; });
  $('#qf-who').append(whoSeesWhat());
  $('#qf-nc-list').append(...NOT_CHECKED.map(([what, why]) => Object.assign(document.createElement('li'), { textContent: `${what}: ${why}` })));
  for (const b of document.querySelectorAll('[data-copy]')) {
    let t = null;
    b.addEventListener('click', async () => {
      clearTimeout(t);
      try { await navigator.clipboard.writeText($(`#${b.dataset.copy}`).textContent); b.textContent = '✓ Copied'; b.classList.add('copied'); t = setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('copied'); }, 1600); }
      catch { const r = document.createRange(); r.selectNodeContents($(`#${b.dataset.copy}`)); getSelection().removeAllRanges(); getSelection().addRange(r); b.textContent = 'Selected: press copy'; }
    });
  }
  $('#refund-btn').addEventListener('click', () => {
    // the amount and the address it goes to, then the page's own sentence
    const c = state.ticket && state.ticket.entry.contribution, back = c && c.value_zat != null ? c.value_zat - campaign.fee_zat : null;
    const to = state.refund.length > 16 ? `${state.refund.slice(0, 6)}…${state.refund.slice(-5)}` : state.refund;
    const p = $('#refund-confirm-text'); p.replaceChildren();
    if (back != null) p.append('Send ', Object.assign(document.createElement('b'), { textContent: `${coin(back)} ${campaign.ticker}` }), ' to ', Object.assign(document.createElement('b'), { textContent: to }), '? ');
    p.append(refundMode() === 'withdraw'
      ? 'This takes your contribution back out of the campaign. It cannot be undone, and a small fee is kept.'
      : 'This claims your refund yourself. A small fee is kept.');
    $('#refund-confirm').hidden = false; $('#refund-btn').hidden = true;
  });
  $('#refund-no').addEventListener('click', () => { $('#refund-confirm').hidden = true; $('#refund-btn').hidden = false; });
  $('#refund-yes').addEventListener('click', onRefundConfirmed);
  $('#manual-txid-save').addEventListener('click', () => {
    const v = $('#manual-txid').value.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(v)) { state.manualTxid = v; save(); refresh(); }
  });
}

async function main() {
  setup('Contribute');
  $('#campaign-id').textContent = cfg.id ? `Campaign ${cfg.id.slice(0, 8)}…` : '';
  if (!/^[0-9a-f]{64}$/.test(cfg.id) || cfg.relays.length === 0) {
    $('#banners').append(banner('bad', 'This link is incomplete. Please ask whoever sent it for the full campaign link.'));
    return;
  }
  const rb = $('#recount-btn');
  const linkTail = `c=${cfg.id}${cfg.relays.map((r) => `&relay=${r}`).join('')}`;
  rb.href = `recount.html#${linkTail}`; // from what this page already holds: no pasting
  rb.hidden = false;
  $('#nav-recount').href = rb.href; // the Recount item of the header points at this campaign's recount too
  // back to this campaign's own page, with the relays (and chain server) this page was opened with; built from the parts, because reading
  // rb.href back gives the full address, which a "recount.html" at the start never matches
  flowBackHref = $('#flow-back').href = `campaign.html#${linkTail}${cfg.server ? `&server=${cfg.server}` : ''}`;
  $('#done-recount').href = rb.href;
  await init();
  wire();
  wireSaveCopy();
  rulesJson = lsGet(`${storeKey}:rules`);
  if (rulesJson) { try { campaign = JSON.parse(W.campaign_summary(rulesJson, cfg.id)); } catch { rulesJson = null; } }
  applyNetwork();
  await refresh();
  markReady();
  if (!campaign && rulesJson) campaign = JSON.parse(W.campaign_summary(rulesJson, cfg.id));
  applyNetwork();
  renderAll();
  takeHandedBackup();
  setInterval(refresh, POLL_MS);
}

main().catch((e) => { $('#banners').append(banner('bad', `Something went wrong: ${e.message || e}`)); });
