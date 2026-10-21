// The bid page of a sealed bid auction (SPEC §9). Everything that touches keys, bids or tickets runs in the WebAssembly module, in this
// browser; the page talks only to the auction's relays (the public list) and to a network server (the chain).
//
// Link: bid.html#c=<auction id>&relay=<url>&relay=<url>&server=<url> (server only for a private test chain: on the test and main networks the
// page uses its own chain server, whatever the link says)
//
// The states, in order: the bid and its payment; the early ticket (take your money back any time before the deadline); the host's small
// payment (the coin) by the coin cutoff; the late ticket, checked completely and signed here: PROTECTED; after the deadline the result,
// or, if the host does not finish, the late ticket from the block after the late ticket block.

import init, * as W from './pkg/ll_web.js';
import { grpcWeb } from './recount.js';
import { setNetwork, markReady } from './ui.js';
import { milestones } from './public.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.hash.slice(1));
const cfg = {
  id: (params.get('c') || '').toLowerCase(),
  relays: params.getAll('relay').map((u) => u.replace(/\/$/, '')),
  server: (params.get('server') || '').replace(/\/$/, ''),
};
const DEFAULT_SERVER = { test: 'https://zjs.zec.rocks/testnet', main: 'https://zjs.zec.rocks/mainnet' };
const POLL_MS = 5000;
// confirmations before the page trusts the host's small payment (owner decision): 1 on the test network, 2 on the main network
const COIN_CONFIRMATIONS = { test: 1, regtest: 1, main: 2 };
const coinConfirmations = () => COIN_CONFIRMATIONS[campaign && campaign.network] || 2;
const storeKey = `ll:sealed:${cfg.id}`;
const load = () => { try { return JSON.parse(localStorage.getItem(storeKey)); } catch { return null; } };
const save = () => { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch { /* the backup file still holds everything */ } };
let state = load();
let rulesJson = null, rules = null, campaign = null, entries = [];
let tip = null, tipTime = null;
let refused = null, busy = false, work = '';
let ignoredServer = null; // M2: a chain server the link named, not used
let planProblem; // M1: undefined until checked, then null or why the round or the late ticket block is later than the deadline needs

const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const coin = (zat) => `${(zat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} ${campaign ? campaign.ticker : ''}`.trim();
const say = (el, text) => { el.textContent = text; el.hidden = !text; };

function readVarintField(bytes, field) {
  for (let i = 0; i < bytes.length; ) {
    let key = 0, shift = 0, b;
    do { b = bytes[i++]; key |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const f = key >>> 3, wt = key & 7;
    if (wt === 0) {
      let v = 0, m = 1;
      do { b = bytes[i++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
      if (f === field) return v;
    } else if (wt === 2) {
      let len = 0, s2 = 0;
      do { b = bytes[i++]; len |= (b & 0x7f) << s2; s2 += 7; } while (b & 0x80);
      i += len;
    } else if (wt === 5) i += 4; else if (wt === 1) i += 8; else return null;
  }
  return null;
}

async function getText(url) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
}
async function getBytes(path) {
  for (const r of cfg.relays) {
    try { const res = await fetch(`${r}/v1/campaigns/${cfg.id}/${path}`, { cache: 'no-store' }); if (res.ok) return new Uint8Array(await res.arrayBuffer()); } catch { /* next */ }
  }
  return null;
}

// ---------- the public list, from every relay ----------
async function readLists() {
  let best = null;
  for (const url of cfg.relays) {
    try {
      const r = await getText(`${url}/v1/campaigns/${cfg.id}`);
      W.campaign_summary(r, cfg.id);
      const l = await getText(`${url}/v1/campaigns/${cfg.id}/ledger?from=0`);
      if (JSON.parse(W.check_ledger(r, cfg.id, l)).length) continue;
      const e = JSON.parse(l);
      if (!best || e.length > best.entries.length) best = { rules: r, entries: e };
    } catch { /* the next relay */ }
  }
  return best;
}

function applyNetwork() {
  if (!campaign || refused) return;
  const kind = setNetwork(campaign.network);
  if (campaign.network === 'regtest') {
    // the second review, M4: a private test chain runs on one computer; anywhere else "regtest" would only switch off the checks
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) { refused = 'This auction is for a private test chain and opens only on the computer that runs it.'; return; }
    if (!cfg.server) refused = 'This auction is on a private test chain; this page needs that chain\'s server in its link.';
    return;
  }
  if (kind === 'unknown') { refused = 'This page cannot tell which network this auction is on, so it will not take a bid.'; return; }
  // the review, M2: the host gives out the link, so on the test and main networks the page never uses a chain server the link names (a
  // host's own server could fake the coin, the note trees and the heights); it uses its own
  if (cfg.server && cfg.server !== DEFAULT_SERVER[kind]) ignoredServer = cfg.server;
  cfg.server = DEFAULT_SERVER[kind];
}

// M1: the round and the late ticket block must be what the plan gives from the block before the start (no years long wait for a late ticket)
async function checkPlan() {
  const h = Math.max(0, rules.start_height - 1);
  try {
    const [b] = await grpcWeb(cfg.server, 'GetBlockRange', W.block_range_request(h, h));
    const r = JSON.parse(W.sealed_plan_check(rulesJson, readVarintField(b, 5)));
    planProblem = r.ok ? null : r.reason;
  } catch { /* tried again on the next refresh */ }
}

async function readTip() {
  const [msg] = await grpcWeb(cfg.server, 'GetLatestBlock', new Uint8Array());
  tip = readVarintField(msg, 1);
  const [b] = await grpcWeb(cfg.server, 'GetBlockRange', W.block_range_request(tip, tip));
  tipTime = readVarintField(b, 5);
}

// An early ticket expires at the deadline. Zebra (7.0.0-rc.0) drops a transaction from its mempool once the chain tip reaches its expiry
// height (remove_expired_transactions: tip_height >= expiry_height): sent while the tip is below the deadline, plus 1 of safety, gives the
// deadline minus 2. zcashd refuses one that is "expiring soon" (next block height + 3 > expiry height): sent while the tip is at most the
// deadline minus 4. The page uses the larger margin (the review, L5): it offers the early ticket while the tip is at most the deadline minus 4.
const ZEBRA_MARGIN = 1 + 1, ZCASHD_MARGIN = 1 + 3;
const TAKE_BACK_MARGIN = Math.max(ZEBRA_MARGIN, ZCASHD_MARGIN);
const lastTakeBack = () => rules.deadline_height - TAKE_BACK_MARGIN;
// the last block a payment can be mined in and still bid (with a coin margin, its small payment must be able to arrive by the cutoff)
const lastDeposit = () => { const s = rules.sealed, d = rules.deadline_height, base = d - 3; return s.coin_margin ? Math.min(base, d - s.coin_cutoff - s.coin_margin) : base; };

// ---------- my deposit, my coin, my late ticket ----------
const myIssue = () => (state && state.ticket ? state.ticket.entry : null);
const myCoinEntry = () => (state && state.ticket ? entries.find((e) => e.kind === 'coin' && e.coin && e.coin.nf === state.ticket.nf) : null);
const closeEntry = () => entries.find((e) => e.kind === 'close') || null;
const mySettle = () => (state && state.ticket ? entries.find((e) => e.kind === 'settle' && e.settle.nf === state.ticket.nf) : null);

// what the chain says about what this page sent: the early ticket mined, or (it expired unmined) the refund the host signed, after the close
const minedAt = async (txid) => {
  try { const [raw] = await grpcWeb(cfg.server, 'GetTransaction', W.tx_filter_request(txid)); return raw ? JSON.parse(W.tx_mined_height(raw)) : null; } catch { return null; }
};
async function checkSent() {
  if (!state.earlyMined) { const h = await minedAt(state.earlySent); if (h != null) { state.earlyMined = h; save(); } }
  const refund = myIssue() && myIssue().refund;
  if (!state.earlyMined && tip > rules.deadline_height && refund && !state.refundMined) { const h = await minedAt(refund); if (h != null) { state.refundMined = h; save(); } }
}
// a payment that came too late to bid: the host sends it back on its own and names it on the list by the hash of its memo
function findReturn() {
  const h = W.memo_hash(state.memo);
  const e = entries.find((x) => x.kind === 'late_return' && x.blob_hash === h);
  if (e && !state.lateReturn) { state.lateReturn = { txid: e.refund, height: e.contribution.height, nf: e.contribution.nf }; save(); }
}

// H3: a payment the host rejected. The reject carries the hash of the payment's memo, so this page finds it; the host sends a rejected
// payment back on its own, minus the fee, and the person can publish proof that the payment was valid (the memo's one time secret)
function findReject() {
  const h = W.memo_hash(state.memo);
  const e = entries.find((x) => x.kind === 'reject' && x.blob_hash === h && x.contribution);
  if (e && !state.rejected) { state.rejected = { txid: e.contribution.txid, action: e.contribution.action, nf: e.contribution.nf, height: e.contribution.height, reason: e.reason || '' }; save(); }
}
async function publishChallenge() {
  const rj = state.rejected;
  if (!rj) return;
  const sent = state.challenge || { ok: [] };
  // the second review, H2: with open payouts the challenge carries the payment's memo, so a relay checks the secret opens it
  const body = rules.sealed.open_payouts ? W.challenge_json_memo(state.seed, rj.txid, rj.action, state.memo) : W.challenge_json(state.seed, rj.txid, rj.action);
  for (const r of cfg.relays) {
    if (sent.ok.includes(r)) continue;
    try { const res = await fetch(`${r}/v1/campaigns/${cfg.id}/challenges`, { method: 'PUT', body }); if (res.ok) sent.ok.push(r); } catch { /* tried again on the next press */ }
  }
  state.challenge = sent;
  save();
  render();
}

// the independent review, H4 and C1: before PROTECTED and before the take back button, the early ticket and the refund the host signed with
// the deposit are checked in full, like a refund ticket: who they pay and how much (from their own note commitments), that they spend this
// deposit, their signatures, the network version, the expiry (the deadline for the early ticket, never for the refund), the fee, and the proof
async function networkBranch() {
  try { const [m] = await grpcWeb(cfg.server, 'GetLightdInfo', new Uint8Array()); return JSON.parse(W.parse_lightd_info(m)).branch; } catch { return null; }
}
async function checkTickets() {
  const e = myIssue(), blob = hexToBytes(state.ticket.blob_hex);
  const problems = [];
  let earlyOk = false;
  try {
    const branch = await networkBranch();
    if (branch == null) return; // the network could not be asked: checked again on the next refresh, never saved as a failure
    const base = {
      contribution_nf: state.ticket.nf, fee_zat: rules.refund_fee_zat, current_branch: branch, known_txids: [],
      // the second review, M1: a deposit may pay more than its size; a ticket pays back at least the size minus the fee, and the early
      // ticket's own value then says what was paid (the recount checks the exact amount after the close)
      refund_receiver_hex: W.refund_receiver_hex(state.refund) || null, intended_contribution_zat: Number(state.tranche),
    };
    const run = async (t, extra, what) => {
      const r = JSON.parse(W.verify_ticket(JSON.stringify({ ...base, raw_hex: t.raw_hex, expected_txid: t.txid, ticket_branch: t.branch_id, opening: t.opening || null, ...extra })));
      // the second review, C1: who a ticket pays and the network version must be checked, not only "not failed": a ticket this page cannot
      // open (no opening values, an older format) could pay anyone, so it never counts as checked and its take back is never offered
      const must = (c) => (c.id === 'pays_you' || c.id === 'network_version') && c.status !== 'pass';
      const bad = r.checks.filter((c) => c.status === 'fail' || must(c)).map((c) => `${what}: ${c.status === 'fail' ? c.detail : c.id === 'pays_you' ? 'this page cannot see who it pays, so it is not used' : 'the network could not be asked which version it runs, so it is not used yet'}`);
      if (!bad.length && !(await proofOk(t.raw_hex, branch))) bad.push(`${what}: its proof does not verify`);
      return bad;
    };
    const early = JSON.parse(W.open_ticket(state.seed, JSON.stringify(e), blob));
    const eb = await run(early, { expected_expiry: rules.deadline_height }, 'the early ticket');
    earlyOk = eb.length === 0;
    problems.push(...eb);
    if (earlyOk && early.opening) { state.paidZat = early.opening.value_zat + rules.refund_fee_zat; save(); }
    const refund = JSON.parse(W.open_signed_refund(state.seed, JSON.stringify(e), blob));
    if (refund) problems.push(...(await run(refund, earlyOk && early.opening ? { expected_value_zat: early.opening.value_zat } : {}, 'the signed refund')));
    else if (rules.sealed.open_payouts) problems.push('the signed refund: the host did not seal it to this page, so who it pays cannot be checked');
  } catch (err) {
    problems.push(`the tickets: ${String(err.message || err)}`);
  }
  state.ticketsChecked = { ok: problems.length === 0, earlyOk, problems, at: tip };
  save();
}

// L4: a page opened again checks that the host's small payment is still on the chain (a reorganised chain can drop it)
let coinRechecked = false;
async function recheckCoin() {
  coinRechecked = true;
  const ce = myCoinEntry();
  if (!ce) return;
  try {
    const [raw] = await grpcWeb(cfg.server, 'GetTransaction', W.tx_filter_request(ce.coin.txid));
    const found = JSON.parse(W.find_coin(raw, state.pageKey));
    state.coinGone = !found || found.height == null;
  } catch { state.coinGone = true; }
  save();
}

// C1 and H2: after the close the page opens the host's payment to this person on the chain with the key it works out itself, and checks it
// pays the refund address it gave, the right amount (the refund, a winner's change, or the return of a payment too late to bid)
async function checkPayout() {
  const fee = rules.refund_fee_zat;
  let job = null;
  if (state.lateReturn) job = { kind: 'return', nf: state.lateReturn.nf, txid: state.lateReturn.txid, want: Number(state.tranche) - fee };
  else if (state.ticket && mySettle()) { const st = mySettle().settle; if (st.excess_zat > 0) job = { kind: 'change', nf: state.ticket.nf, txid: st.txid, want: st.excess_zat }; }
  else if (state.ticket && myIssue() && myIssue().refund && !state.earlyMined) job = { kind: 'refund', nf: state.ticket.nf, txid: myIssue().refund, want: Number(state.tranche) - fee };
  if (!job || !job.nf) return;
  try {
    const [raw] = await grpcWeb(cfg.server, 'GetTransaction', W.tx_filter_request(job.txid));
    const r = JSON.parse(W.payout_outputs(raw, W.payout_ovk(state.seed, rules.payload_pubkey, job.nf, job.kind)));
    const mine = W.refund_receiver_hex(state.refund);
    state.payout = { ...job, height: r.height, ok: r.outputs.some((o) => o.receiver_hex === mine && o.value_zat === job.want), outputs: r.outputs };
    save();
  } catch { /* not mined yet, or not reachable: tried again on the next refresh */ }
}

async function detectTicket() {
  for (const e of entries.filter((x) => x.kind === 'issue' && x.contribution)) {
    const blob = await getBytes(`tickets/${e.contribution.nf}`);
    if (!blob || !W.blob_is_mine(state.seed, blob)) continue;
    try { W.open_ticket(state.seed, JSON.stringify(e), blob); } catch { continue; }
    state.ticket = { nf: e.contribution.nf, entry: e, blob_hex: bytesToHex(blob) };
    save();
    return;
  }
}

// the second review, L3: a worker that cannot load answers "no" (never a page that waits for ever), and the proof is checked for the network
// version the chain server reports
function proofOk(rawHex, branch) {
  return new Promise((resolve) => {
    const w = new Worker('proof-worker.js', { type: 'module' });
    w.onmessage = (m) => {
      if (m.data.type === 'status') { work = m.data.text; render(); }
      if (m.data.type === 'result' || m.data.type === 'error') { w.terminate(); resolve(m.data.type === 'result' && m.data.ok === true); }
    };
    w.onerror = () => { w.terminate(); resolve(false); };
    w.postMessage({ raw_hex: rawHex, branch: branch || '77190ad9' });
  });
}

/** The coin came: open the late ticket, check it against the list and the chain (coin, anchor, refund output, signatures, proof), sign it. */
async function protectLate() {
  const ce = myCoinEntry();
  if (!ce || state.late || state.lateProblem) return;
  const s = rules.sealed;
  const cutoff = rules.deadline_height - s.coin_cutoff;
  const [raw] = await grpcWeb(cfg.server, 'GetTransaction', W.tx_filter_request(ce.coin.txid));
  const found = JSON.parse(W.find_coin(raw, state.pageKey));
  state.coin = found ? { ...found, txid: ce.coin.txid } : null;
  if (!found) { state.lateProblem = 'The host\'s small payment does not pay this page\'s address.'; save(); return; }
  if (found.height == null || tip < found.height + coinConfirmations() - 1) return; // on its way
  if (found.height > cutoff) { state.lateProblem = `The host's small payment came after the cutoff (block ${cutoff}).`; save(); return; }
  if (found.index !== ce.coin.index || found.value_zat !== ce.coin.value_zat || found.value_zat < s.coin_zat) { state.lateProblem = 'The host\'s small payment is not what the list says.'; save(); return; }
  work = 'The host\'s small payment arrived. Checking and signing your late ticket.'; render();
  const blob = await getBytes(`blobs/${ce.blob_hash}`);
  if (!blob) return;
  // the second review, L2: when the chain server cannot say which network version it runs, ask again on the next refresh (never saved as
  // a failed late ticket)
  const branchNow = await networkBranch();
  if (branchNow == null) { work = ''; return; }
  try {
    const opened = JSON.parse(W.open_late(state.seed, JSON.stringify(ce), blob));
    const expect = JSON.stringify({
      deposit_nf: state.ticket.nf, coin_txid: ce.coin.txid, coin_index: ce.coin.index, coin_value_zat: ce.coin.value_zat,
      lock_time: s.claim_after, refund_address: state.refund, refund_zat: state.paidZat - rules.refund_fee_zat, deposit_zat: state.paidZat,
      current_branch: branchNow, // H5: built for the network version in use now
    });
    const checked = JSON.parse(W.check_late(state.seed, opened.raw_hex, opened.ovk_hex, expect));
    const [ts] = await grpcWeb(cfg.server, 'GetTreeState', W.tree_state_request(opened.anchor_height));
    if (W.ironwood_root(ts) !== checked.anchor_hex) throw new Error('The late ticket\'s anchor is not a note tree root of the chain.');
    if (!(await proofOk(opened.raw_hex, JSON.parse(expect).current_branch))) throw new Error('The late ticket\'s proof does not verify.');
    state.late = { signed_hex: W.sign_late(state.seed, opened.raw_hex, expect), txid: opened.txid };
  } catch (e) {
    state.lateProblem = String(e.message || e);
  }
  work = '';
  save();
}

async function send(rawHex) {
  const [resp] = await grpcWeb(cfg.server, 'SendTransaction', W.send_request(rawHex));
  return JSON.parse(W.parse_send_response(resp));
}

async function takeBack() {
  if (tip > lastTakeBack()) throw new Error(`It is too late to take it back yourself: an early ticket must be sent by block ${lastTakeBack()}.`);
  const e = myIssue();
  const t = JSON.parse(W.open_ticket(state.seed, JSON.stringify(e), hexToBytes(state.ticket.blob_hex)));
  const r = await send(t.raw_hex);
  say($('#send-msg'), r.ok ? 'Sent. Your money is on its way back to your refund address.' : `Not sent: ${r.message}`);
  if (r.ok) { state.earlySent = t.txid; save(); }
  render();
}

async function sendLate() {
  const r = await send(state.late.signed_hex);
  say($('#send-msg'), r.ok ? 'Sent. Your deposit is on its way back to your refund address.' : `Not sent: ${r.message}`);
  if (r.ok) { state.lateSent = state.late.txid; save(); }
  render();
}

// ---------- what the page shows ----------
// The owner's rule for page text: one short plain line, only when it changes what the person must do; the rest behind "more".
// status() gives [title, line, button, more].
function status() {
  const s = rules.sealed, d = rules.deadline_height, cutoff = d - s.coin_cutoff, hs = s.claim_after;
  const take = lastTakeBack(), canTake = tip <= take;
  const takeNow = `Take your money back now (until block ${take}).`;
  const atClose = 'Your deposit comes back at the close.';
  const tooLate = `An early ticket must be sent by block ${take} to be mined before it expires at the deadline.`;
  // C1 and H2: the host's payment to this person, opened on the chain with this page's own key
  const po = state.payout;
  const words = { refund: 'refund', change: 'change', return: 'return' };
  if (po && po.height && !po.ok) return ['The host\'s payment does not pay you', 'Keep your backup file: the recount marks this host.', null, `The ${words[po.kind]} (transaction ${po.txid}, block ${po.height}) does not pay ${coin(po.want)} to your refund address. This page opened it on the chain with its own key.`];
  const checked = po && po.height && po.ok ? `Checked on the chain with this page's own key: the ${words[po.kind]} pays ${coin(po.want)} to your refund address.` : '';
  if (state.rejected) {
    const sent = state.challenge && state.challenge.ok.length;
    return ['The host rejected your payment', `${state.lateReturn ? 'It was sent back to you' : 'It is sent back to you'}, minus the fee. ${sent ? 'You published proof that it was valid.' : 'If it was valid, you can publish proof.'}`, 'challenge', [
      `Mined in block ${state.rejected.height}${state.rejected.reason ? ` (the host's reason: ${state.rejected.reason})` : ''}.`,
      state.lateReturn ? `Return: transaction ${state.lateReturn.txid}, minus the ${coin(rules.refund_fee_zat)} fee.` : `The host must send it back within ${rules.ticket_k} blocks; the recount marks it if not.`,
      sent ? `Published to ${state.challenge.ok.length} of ${cfg.relays.length} list servers; the recount marks the host if the proof holds.` : 'Publishing shows everyone your refund address now; the close makes it public anyway.',
      checked].filter(Boolean).join(' ')];
  }
  if (state.lateReturn) return ['Your payment came too late to bid', 'It was sent back to you, minus the fee.', null, `Mined in block ${state.lateReturn.height}; deposits had to be mined by block ${lastDeposit()}. Return: transaction ${state.lateReturn.txid}, minus the ${coin(rules.refund_fee_zat)} fee. ${checked}`];
  if (state.earlySent && state.earlyMined) return ['Your money is back', 'Your bid is out of the auction.', null, `Your early ticket was mined in block ${state.earlyMined}: your deposit, minus the fee, is at your refund address.`];
  if (state.earlySent && tip <= d) return ['Your money is on its way back', 'Keep this page open until it is mined.', null, `Your early ticket must be mined by block ${d}.`];
  if (state.earlySent && state.refundMined) return ['Your money is back', 'It came back by the host\'s signed refund.', null, `Your early ticket was not mined before the deadline, so the deposit stayed in the auction; the refund was mined in block ${state.refundMined}.`];
  if (state.lateSent) return ['Your deposit is on its way back', 'You sent your late ticket.', null, 'It pays your deposit, minus the fee, to your refund address.'];
  if (!state.ticket) return ['Waiting for your deposit\'s ticket', 'Keep this page open until it says PROTECTED.', null, `The host lists your early ticket within ${rules.ticket_k} blocks of your payment. A payment mined after block ${lastDeposit()} does not count and is sent back, minus the fee.`];
  const c = closeEntry();
  if (c) {
    const won = (c.close.winners || []).includes(state.ticket.nf), st = mySettle();
    if (c.close.outcome === 'void') return ['The auction was void', 'Round R came too early for this deadline, so every deposit goes back by its signed refund.', null, ''];
    if (won) return ['Your bid won', st ? `You pay ${coin(st.settle.price_zat)}; ${coin(st.settle.excess_zat)} comes back to your refund address.` : 'The host is settling: the price goes to the treasury and the rest of your deposit comes back to you.', null, checked];
    return ['Your bid did not win', 'Your deposit comes back by the host\'s signed refund.', tip > hs && state.late ? 'late' : null, checked];
  }
  if (tip > hs) return ['The host did not finish', state.late ? 'From this block you can take your deposit back on your own with your late ticket.' : 'The host did not finish, and this page holds no late ticket for you.', state.late ? 'late' : null, ''];
  if (tip > d) return ['Bidding has closed', `The bids open with drand round ${s.drand_round}. ${state.late ? `If the host does not finish the auction, from block ${hs + 1} you can take your deposit back on your own.` : ''}`, null, ''];
  const paidAt = state.ticket.entry && state.ticket.entry.contribution ? state.ticket.entry.contribution.height : null;
  // H4 and C1: nothing is PROTECTED, and no take back is offered, before the early ticket and the signed refund check out
  const tc = state.ticketsChecked;
  if (!tc) return ['Checking your tickets', 'Keep this page open.', null, 'This page checks who your tickets pay, how much, their signatures and their proofs.'];
  if (!tc.ok) {
    const what = tc.problems.join(' ');
    return tc.earlyOk && canTake
      ? ['NOT PROTECTED: a ticket does not check out', takeNow, 'early', `${what} The recount marks the host.`]
      : ['NOT PROTECTED: a ticket does not check out', tc.earlyOk ? `${atClose} Keep your backup file.` : 'This page cannot take your money back for you. Keep your backup file.', null, `${what} ${tc.earlyOk ? tooLate : ''} The recount marks the host.`];
  }
  if (state.late && state.coinGone) return ['NOT PROTECTED after the deadline', `The host's small payment is gone from the chain. ${canTake ? takeNow : atClose}`, canTake ? 'early' : null, `The chain was reorganised, so the late ticket would not work.${canTake ? '' : ` ${tooLate}`}`];
  if (paidAt != null && paidAt > cutoff && !state.late) {
    const why = `Your deposit was mined in block ${paidAt}, after the cutoff for the host's small payment (block ${cutoff}). Without that payment you have no late ticket: if the host never closes, nothing gives your money back on its own.`;
    return canTake
      ? ['Take your money back now', `Your bid does not count: you paid after the cutoff. Take it back now (until block ${take}).`, 'early', why]
      : ['Your bid does not count', atClose, null, `${why} ${tooLate}`];
  }
  const back = canTake ? takeNow : atClose;
  const backMore = canTake ? '' : `${tooLate} If the host never closes, this page holds no late ticket for you.`;
  if (planProblem) return ['NOT PROTECTED after the deadline', `This auction's timing is wrong. ${back}`, canTake ? 'early' : null, `${planProblem} ${backMore}`];
  if (planProblem === undefined) return ['Checking your tickets', 'Keep this page open.', canTake ? 'early' : null, 'This page checks the auction\'s timing against the chain.'];
  if (state.late) return ['PROTECTED', canTake ? `You can take your money back until block ${take}.` : atClose, canTake ? 'early' : null, `If the host does not finish the auction, from block ${hs + 1} you can take your deposit back on your own.`];
  if (state.lateProblem) return ['NOT PROTECTED after the deadline', back, canTake ? 'early' : null, `${state.lateProblem} ${backMore}`];
  if (tip >= cutoff) return ['NOT PROTECTED after the deadline', `The host's small payment did not come. ${back}`, canTake ? 'early' : null, backMore];
  // M3: the page checks and signs the late ticket only while it is open; it warns from the block by which the host must have sent its
  // small payment (COIN_RUSH_BLOCKS before the cutoff) plus 5 blocks to mine it, well before the cutoff
  const warn = tip >= cutoff - 15;
  const act = `Keep this page open. If it does not say PROTECTED by block ${cutoff}, take your money back.`;
  const signs = `This page signs your late ticket only while it is open. You can take your money back until block ${take}.`;
  if (myCoinEntry()) return [warn ? 'Not protected yet, and the cutoff is close' : 'Not protected after the deadline yet', warn ? act : 'Keep this page open until it says PROTECTED.', canTake ? 'early' : null, `The host's small payment is on its way. ${signs}`];
  if (warn) return ['Not protected yet, and the cutoff is close', act, canTake ? 'early' : null, `The host's small payment has not come; it must be mined by block ${cutoff}. ${signs}`];
  return ['Waiting for the host\'s small payment', 'Keep this page open until it says PROTECTED.', canTake ? 'early' : null, `If the host's small payment has not come by block ${cutoff}, take your money back. ${signs} If you close it, open it again before the cutoff.`];
}

// ---------- Pay with Noir (only when the Noir browser extension is present; without it nothing on the page changes) ----------
// The same rules as the contribute page: the network is checked by the address Noir shares, exactly the deposit address, amount and
// message shown are sent, a returned transaction ID is kept, and the button is gone once a payment is sent or seen.
let noir = null; // the extension, once found
let noirBusy = false;
const findNoir = () => (window.noirwallet && window.noirwallet.isNoirWallet ? window.noirwallet : null);
/** As the extension's own kit does: found at once, or on its initialized event, for at most 3 seconds. */
function detectNoir() {
  if (findNoir()) return Promise.resolve(findNoir());
  return new Promise((done) => {
    const t = setTimeout(() => done(findNoir()), 3000);
    window.addEventListener('noirwallet#initialized', () => { clearTimeout(t); done(findNoir()); }, { once: true });
  });
}
const noirApi = () => (noir.zcash && typeof noir.zcash.request === 'function' ? noir.zcash : noir);
/** The shielded address Noir shares: the first unified address in its answer, whatever its shape (u1 on mainnet, utest1 on testnet). */
function noirAddress(res) {
  const found = [];
  const walk = (v, depth) => {
    if (typeof v === 'string') found.push(v);
    else if (v && typeof v === 'object' && depth < 3) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(res, 0);
  return found.find((s) => /^(u1|utest1)[0-9a-z]+$/.test(s)) || null;
}
function renderNoir() {
  $('#noir-pay').hidden = !(noir && state && state.payTo && !state.paidZat && !state.ticket && !state.noirTxid && !state.noirSent);
}
function noirSay(text, bad) {
  const m = $('#noir-msg');
  m.textContent = text; m.hidden = !text; m.classList.toggle('bad', !!bad);
}
async function onNoirPay() {
  if (noirBusy || !noir || !state || !state.payTo || !campaign) return;
  // exactly what the page shows: the deposit address, the deposit amount and the message
  const p = { to: state.payTo, amount: String(state.tranche / 1e8), memo: state.memo };
  if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(p.amount) || new TextEncoder().encode(p.memo).length > 512) {
    noirSay('This payment cannot be sent with Noir. Use the code instead.', true);
    return;
  }
  const btn = $('#noir-pay');
  noirBusy = true; btn.disabled = true; btn.textContent = 'Waiting for Noir…'; noirSay('', false);
  const net = (n) => (n === 'test' ? 'test' : 'main');
  try {
    const api = noirApi();
    const addr = noirAddress(await api.request({ method: 'zcash_requestAccounts' }));
    if (!addr) { noirSay('Noir did not share a shielded address. Nothing was sent. Pay with the code instead.', true); return; }
    const has = addr.startsWith('utest1') ? 'test' : 'main', want = net(campaign.network);
    if (has !== want) {
      noirSay(`Noir is on the ${has} network, but this auction is on the ${want} network. Nothing was sent. Use the Noir extension for the ${want} network and try again.`, true);
      return;
    }
    const res = await api.request({ method: 'zcash_sendTransaction', params: [p] });
    const txid = typeof res === 'string' ? res : res && (res.txid || res.transactionId || res.hash);
    if (typeof txid === 'string' && /^[0-9a-fA-F]{64}$/.test(txid)) {
      state.noirTxid = txid.toLowerCase();
      noirSay('Sent with Noir. This page now waits to see your deposit on the network, as with any wallet.', false);
    } else {
      state.noirSent = true;
      noirSay('Noir says it sent the payment, without a transaction ID. This page waits to see your deposit on the network.', false);
    }
    save();
    render();
  } catch (e) {
    const text = String((e && e.message) || e || '');
    if ((e && e.code === 4001) || /reject|denied|cancel/i.test(text)) noirSay('Cancelled in Noir. Nothing was sent.', false);
    else if (/insufficient|not enough|balance|funds/i.test(text)) noirSay('Noir does not have enough funds for this payment and its fee. Nothing was sent.', true);
    else noirSay('Noir could not complete the payment. Check its activity list before you try again, so you do not pay twice.', true);
  } finally {
    noirBusy = false; btn.disabled = false; btn.textContent = 'Pay with Noir';
    renderNoir();
  }
}

function render() {
  for (const id of ['#form-card', '#pay-card', '#status-card']) $(id).hidden = true;
  $('#banners').replaceChildren();
  if (refused) { const p = document.createElement('p'); p.className = 'warnline'; p.textContent = refused; $('#banners').append(p); return; }
  if (!rules || tip == null) return;
  const s = rules.sealed;
  $('#cname').hidden = false; $('#cname').textContent = campaign.name || `Blind bid auction ${cfg.id.slice(0, 8)}`;
  $('#status-line').hidden = false; $('#status-text').textContent = `block ${tip} · deadline ${rules.deadline_height}`;
  if (!state) {
    $('#form-card').hidden = false;
    $('#f-round').textContent = s.drand_round;
    const sel = $('#tranche');
    if (!sel.options.length) for (const t of s.tranches_zat) sel.append(new Option(`${coin(t)} (bids up to ${coin(t - rules.refund_fee_zat)})`, String(t)));
    const w = JSON.parse(W.sealed_bid_window(rulesJson, tip, tipTime || 0));
    windowOk = w.ok && !planProblem && planProblem !== undefined;
    say($('#bid-hint'), planProblem ? 'This auction\'s timing is wrong. Do not bid.' : w.ok && planProblem === undefined ? 'Checking the auction\'s timing against the chain.' : w.ok ? `Pay by block ${w.last_block}. Your deposit shows only the size you chose, never your bid.` : w.reason);
    syncBid();
    return;
  }
  if ((!state.paidZat || !state.ticket) && !state.rejected && !state.lateReturn) {
    $('#pay-card').hidden = false;
    $('#pay-amount').textContent = coin(state.tranche);
    $('#pay-to').textContent = state.payTo; $('#pay-amt').textContent = String(state.tranche / 1e8); $('#memo').textContent = state.memo;
    $('#qr').replaceChildren(...(typeof state.qrSvg === 'string' && state.qrSvg ? [qrImage(state.qrSvg)] : []));
  }
  renderNoir();
  $('#status-card').hidden = false;
  const [title, text, action, more] = status();
  $('#st-title').textContent = title; $('#st-text').textContent = text;
  const moreText = [more, ignoredServer ? `The link named the chain server ${ignoredServer}; this page uses ${cfg.server} instead.` : ''].filter(Boolean).join(' ');
  $('#st-more').textContent = moreText; $('#st-more-box').hidden = !moreText;
  const facts = [
    `Your deposit: ${coin(state.tranche)}; your bid: ${coin(state.bid)}`,
    `Deadline: block ${rules.deadline_height}; the host's small payment by block ${rules.deadline_height - s.coin_cutoff}`,
    `Bids open with drand round ${s.drand_round}; late tickets work from block ${s.claim_after + 1}`,
  ];
  if (state.noirTxid && !state.paidZat) facts.push(`Sent with Noir: transaction ${state.noirTxid}`);
  if (state.earlySent && !state.earlyMined && tip > rules.deadline_height) facts.push(`Your early ticket (${state.earlySent}) was not mined before it expired at the deadline (block ${rules.deadline_height}): your deposit stayed in the auction.`);
  $('#st-facts').replaceChildren(...facts.map((f) => Object.assign(document.createElement('li'), { textContent: f })));
  say($('#st-work'), work);
  $('#take-back').hidden = !(action === 'early' && state.ticket && tip <= lastTakeBack() && !state.earlySent && state.ticketsChecked && state.ticketsChecked.earlyOk);
  $('#send-late').hidden = !(action === 'late' && state.late && !state.lateSent);
  const ch = state.challenge;
  $('#challenge').hidden = !(action === 'challenge' && !(ch && ch.ok.length === cfg.relays.length));
  $('#challenge').textContent = ch && ch.ok.length ? 'Try the remaining list servers again' : 'Publish proof that my payment was valid';
}

// ---------- the bid ----------
let windowOk = false; // the auction takes deposits now (set by render)
/** A bid above what the chosen deposit allows (the deposit minus the refund fee): one short line naming the smallest deposit that fits, if any.
 * The deposit is never changed for the person. */
function bidProblem() {
  const t = $('#bid').value.trim(), bid = Math.round(Number(t) * 1e8), fee = rules.refund_fee_zat;
  if (!t || !Number.isFinite(bid) || bid <= Number($('#tranche').value) - fee) return null;
  const fits = rules.sealed.tranches_zat.filter((x) => bid <= x - fee).sort((a, b) => a - b)[0];
  return fits ? `Too high for this deposit. Pick ${coin(fits)} or lower your bid.` : `Too high for any deposit here. Lower your bid to ${coin(Math.max(...rules.sealed.tranches_zat) - fee)} or less.`;
}
/** Live, as on the contribute page: the line under the bid box in place of the grey hint, the box glows red, and the button waits. */
function syncBid() {
  if (!rules || !$('#tranche').options.length) return;
  const msg = bidProblem(), inp = $('#bid'), e = $('#bid-error');
  e.textContent = msg || ''; e.hidden = !msg; $('#bid-hint').hidden = !!msg || !$('#bid-hint').textContent;
  inp.closest('.amountbox').classList.toggle('bad', !!msg);
  if (msg) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', 'bid-error'); } else { inp.removeAttribute('aria-invalid'); inp.setAttribute('aria-describedby', 'bid-hint'); }
  $('#create').disabled = !windowOk || !!msg;
}

async function onCreate(ev) {
  ev.preventDefault();
  const err = $('#form-error');
  try {
    const seed = W.generate_seed();
    const tranche = Number($('#tranche').value);
    const bid = Math.round(Number($('#bid').value.trim()) * 1e8);
    const refund = $('#refund').value.trim();
    const p = JSON.parse(W.sealed_bid_payment(rulesJson, seed, refund, tranche, bid));
    state = { seed, refund, tranche, bid, memo: p.memo, payTo: p.pay_to, pageKey: p.page_key, qrSvg: p.qr_svg, paidZat: null, startHeight: tip };
    save();
    say(err, '');
    render();
  } catch (e) { say(err, String(e.message || e)); }
}

function downloadBackup() {
  const out = { kind: 'sealed-bid-backup', version: 1, campaign: cfg.id, relays: cfg.relays, server: cfg.server, state,
    note: 'Keep this file private. It holds this page\'s keys: with it you can take your deposit back even if this page is gone, and it shows your bid.' };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = `sealed-bid-backup-${cfg.id.slice(0, 8)}.json`;
  document.body.append(a); a.click(); a.remove();
}

// the second review, L4: the payment code is shown as an image, never as markup, so a code taken from a stored or restored state cannot
// run script in this page (an SVG loaded as an image never runs script)
function qrImage(svg) {
  const img = new Image();
  img.alt = 'Payment code';
  img.style.display = 'block'; img.style.width = '100%'; img.style.height = 'auto';
  img.src = `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}`;
  return img;
}

// a restored file must be this auction's bid backup with the fields the page relies on, of the right kinds
function backupState(b) {
  const s = b && b.state;
  const okNum = (v) => v == null || (Number.isSafeInteger(v) && v >= 0);
  if (!b || b.kind !== 'sealed-bid-backup' || b.campaign !== cfg.id || !s || typeof s !== 'object') return null;
  if (!/^[0-9a-f]{64}$/.test(s.seed) || typeof s.memo !== 'string' || typeof s.refund !== 'string' || !okNum(s.tranche) || !okNum(s.bid) || !okNum(s.paidZat)) return null;
  if (s.qrSvg != null && typeof s.qrSvg !== 'string') return null;
  return s;
}

async function onRestore(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const restored = backupState(JSON.parse(await f.text()));
    if (!restored) throw new Error('This is not a backup of a bid in this auction.');
    state = restored; save(); render();
  } catch (e) { say($('#restore-error'), String(e.message || e)); }
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const l = await readLists();
    if (l) { rulesJson = l.rules; entries = l.entries; rules = JSON.parse(rulesJson); campaign = JSON.parse(W.campaign_summary(rulesJson, cfg.id)); }
    if (!rules) { refused = refused || 'No list server answered with this auction.'; return; }
    if (!rules.sealed) { location.replace(`contribute.html${location.hash}`); return; }
    applyNetwork();
    if (refused) return;
    await readTip();
    if (planProblem === undefined) await checkPlan();
    if (state && !state.ticket) await detectTicket();
    if (state && state.ticket && !state.paidZat) { state.paidZat = Number(state.tranche); save(); }
    if (state && state.ticket && !state.ticketsChecked) await checkTickets();
    if (state && state.ticket) await protectLate();
    if (state && state.late && !coinRechecked) await recheckCoin();
    if (state && state.earlySent) await checkSent();
    if (state && rules.sealed.open_payouts && (closeEntry() || state.lateReturn) && !(state.payout && state.payout.height)) await checkPayout();
    if (state && !state.ticket && state.memo) { findReject(); findReturn(); }
  } catch (e) {
    work = `Could not reach the network just now (${e.message || e}); trying again.`;
  } finally {
    busy = false;
    render();
  }
}

async function main() {
  if (!cfg.id || !cfg.relays.length) { refused = 'This link is missing the auction or its list servers.'; render(); return; }
  const tail = `c=${cfg.id}${cfg.relays.map((r) => `&relay=${r}`).join('')}`;
  const ms = milestones(), on = (h) => (ms ? ms.onward(h) : h); // opened from the demo's Tested milestones page: keep the way back
  $('#flow-back').href = on(`campaign.html#${tail}${cfg.server ? `&server=${cfg.server}` : ''}`);
  $('#nav-recount').href = on(`recount.html#${tail}`);
  await init();
  $('#form').addEventListener('submit', onCreate);
  $('#bid').addEventListener('input', syncBid);
  $('#tranche').addEventListener('change', syncBid);
  $('#noir-pay').addEventListener('click', onNoirPay);
  detectNoir().then((w) => { if (w) { noir = w; renderNoir(); } });
  $('#backup').addEventListener('click', downloadBackup);
  $('#backup2').addEventListener('click', downloadBackup);
  $('#restore').addEventListener('change', onRestore);
  $('#take-back').addEventListener('click', () => takeBack().catch((e) => say($('#send-msg'), String(e.message || e))));
  $('#challenge').addEventListener('click', () => { $('#challenge').disabled = true; publishChallenge().catch((e) => say($('#send-msg'), String(e.message || e))).finally(() => { $('#challenge').disabled = false; }); });
  $('#send-late').addEventListener('click', () => sendLate().catch((e) => say($('#send-msg'), String(e.message || e))));
  for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', () => navigator.clipboard.writeText($(`#${b.dataset.copy}`).textContent).catch(() => {}));
  await refresh();
  markReady();
  setInterval(refresh, POLL_MS);
}

main().catch((e) => { refused = `Something went wrong: ${e.message || e}`; render(); });
