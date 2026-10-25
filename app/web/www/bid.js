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
import { setup, setNetwork, markReady } from './ui.js';
import { milestones, DEFAULT_RELAY, copyLinkButton } from './public.js';
import { afterNu7, firstMeasured } from './nu7.js';
import { findAnchor } from './anchor.js';
import { showResult } from './result.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.hash.slice(1));
const cfg = {
  id: (params.get('c') || '').toLowerCase(),
  relays: ((r) => (r.length ? r : [DEFAULT_RELAY]))(params.getAll('relay').map((u) => u.replace(/\/$/, ''))), // none named: the project's relay
  server: (params.get('server') || '').replace(/\/$/, ''),
  // a second chain server for a private test chain (its tests only; on the test and main networks the page picks its own two)
  server2: (params.get('server2') || '').replace(/\/$/, ''),
};
const DEFAULT_SERVER = { test: 'https://zjs.zec.rocks/testnet', main: 'https://zjs.zec.rocks/mainnet' };
// the owner's rule (22 Oct 2026): before PROTECTED the page asks two chain servers at the same time; the second is run by someone else
const SECOND_SERVER = { test: 'https://zcash-testnet.chainsafe.dev', main: 'https://zcash-mainnet.chainsafe.dev' };
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
let serversDisagree = false; // the two chain servers gave different answers on this refresh: not PROTECTED, asked again on the next
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
  // the unit next to the bid box: the auction's own (ZEC on the main network, TAZ on the test network; the owner's report of 22 Oct 2026)
  for (const el of document.querySelectorAll('.ticker')) el.textContent = campaign.ticker || '';
  if (campaign.network === 'regtest') {
    // set 2, M4: a private test chain runs on one computer; anywhere else "regtest" would only switch off the checks
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) { refused = 'This auction is for a private test chain and opens only on the computer that runs it.'; return; }
    if (!cfg.server) refused = 'This auction is on a private test chain; this page needs that chain\'s server in its link.';
    return;
  }
  if (kind === 'unknown') { refused = 'This page cannot tell which network this auction is on, so it will not take a bid.'; return; }
  // set 1, M2: the host gives out the link, so on the test and main networks the page never uses a chain server the link names (a
  // host's own server could fake the coin, the note trees and the heights); it uses its own
  if (cfg.server && cfg.server !== DEFAULT_SERVER[kind]) ignoredServer = cfg.server;
  cfg.server = DEFAULT_SERVER[kind];
  cfg.server2 = SECOND_SERVER[kind];
}

/** The same question to both chain servers at the same time: each answer's first message, null for "not found" (an answer too: a coin can
 *  leave the chain), or undefined for a server that did not answer (in 20 seconds). On a private test chain without a second server, only the first. */
async function askBoth(method, req) {
  const ask = (server) => Promise.race([grpcWeb(server, method, req).then((m) => m[0] ?? null), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 20000))])
    .catch((e) => (/grpc-status 5\b/.test(String(e && e.message)) ? null : undefined));
  return Promise.all([cfg.server, cfg.server2].filter(Boolean).map(ask));
}
/** What the servers that answered say, after `read` (which may throw for a broken answer, counted as no answer): `{ value, answered }`, or
 *  `{ disagree: true }` when two answers differ. */
function agree(answers, read) {
  const got = [];
  for (const a of answers) { if (a === undefined) continue; try { got.push(read(a)); } catch { /* no usable answer */ } }
  if (got.length === 2 && JSON.stringify(got[0]) !== JSON.stringify(got[1])) return { disagree: true };
  return { value: got[0], answered: got.length };
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

let resultKey = '';
let spb = null; // seconds per block, measured once over the last 200 blocks, after NU7 only once it has come (for "~6 days")
async function readTip() {
  const [msg] = await grpcWeb(cfg.server, 'GetLatestBlock', new Uint8Array());
  tip = readVarintField(msg, 1);
  const [b] = await grpcWeb(cfg.server, 'GetBlockRange', W.block_range_request(tip, tip));
  tipTime = readVarintField(b, 5);
  const h0 = firstMeasured(rules && rules.network, tip, 200);
  if (spb == null && tip - h0 >= 20) {
    try { const [o] = await grpcWeb(cfg.server, 'GetBlockRange', W.block_range_request(h0, h0)); const t0 = readVarintField(o, 5); if (t0 && tipTime > t0) spb = (tipTime - t0) / (tip - h0); } catch { /* the pill says Open */ }
  }
}

// An early ticket expires at the deadline. Zebra (7.0.0-rc.0) drops a transaction from its mempool once the chain tip reaches its expiry
// height (remove_expired_transactions: tip_height >= expiry_height): sent while the tip is below the deadline, plus 1 of safety, gives the
// deadline minus 2. zcashd refuses one that is "expiring soon" (next block height + 3 > expiry height): sent while the tip is at most the
// deadline minus 4. The page uses the larger margin (set 1, L5): it offers the early ticket while the tip is at most the deadline minus 4.
const ZEBRA_MARGIN = 1 + 1, ZCASHD_MARGIN = 1 + 3;
const TAKE_BACK_MARGIN = Math.max(ZEBRA_MARGIN, ZCASHD_MARGIN);
const lastTakeBack = () => rules.deadline_height - TAKE_BACK_MARGIN;
const COIN_WARN_BLOCKS = 15; // ll_core::sealed::COIN_WARN_BLOCKS
const coinScale = () => ((rules.sealed.timing || 'standard') === 'standard' && afterNu7(rules.network, rules.start_height) ? 3 : 1);
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
  // set 2, H2: with open payouts the challenge carries the payment's memo, so a relay checks the secret opens it
  const body = rules.sealed.open_payouts ? W.challenge_json_memo(state.seed, rj.txid, rj.action, state.memo) : W.challenge_json(state.seed, rj.txid, rj.action);
  for (const r of cfg.relays) {
    if (sent.ok.includes(r)) continue;
    try { const res = await fetch(`${r}/v1/campaigns/${cfg.id}/challenges`, { method: 'PUT', body }); if (res.ok) sent.ok.push(r); } catch { /* tried again on the next press */ }
  }
  state.challenge = sent;
  save();
  render();
}

// set 1, H4 and C1: before PROTECTED and before the take back button, the early ticket and the refund the host signed with
// the deposit are checked in full, like a refund ticket: who they pay and how much (from their own note commitments), that they spend this
// deposit, their signatures, the network version, the expiry (the deadline for the early ticket, never for the refund), the fee, and the proof
async function networkBranch() {
  try { const [m] = await grpcWeb(cfg.server, 'GetLightdInfo', new Uint8Array()); return JSON.parse(W.parse_lightd_info(m)).branch; } catch { return null; }
}
/** The network version, from both servers (the owner's rule): `{ value, answered }` or `{ disagree: true }`. */
async function networkBranchBoth() {
  return agree((await askBoth('GetLightdInfo', new Uint8Array())).map((m) => (m === null ? undefined : m)), (m) => JSON.parse(W.parse_lightd_info(m)).branch);
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
      // set 2, M1: a deposit may pay more than its size; a ticket pays back at least the size minus the fee, and the early
      // ticket's own value then says what was paid (the recount checks the exact amount after the close)
      refund_receiver_hex: W.refund_receiver_hex(state.refund) || null, intended_contribution_zat: Number(state.tranche),
    };
    const run = async (t, extra, what) => {
      // level 4: the ticket's anchor is the note tree of a real block, as both chain servers say. A server that does not answer leaves it not
      // checked (never a failure); only a range every server answered without it fails. Run once, before PROTECTED: a page that already
      // checked its tickets never runs it again
      const anchor = await findAnchor(W, [cfg.server, cfg.server2].filter(Boolean), () => W.ticket_anchor(t.raw_hex), e.contribution.height, e.ticket.issue_height, tip).catch(() => null);
      const r = JSON.parse(W.verify_ticket(JSON.stringify({ ...base, raw_hex: t.raw_hex, expected_txid: t.txid, ticket_branch: t.branch_id, opening: t.opening || null, anchor, ...extra })));
      // set 2, C1: who a ticket pays and the network version must be checked, not only "not failed": a ticket this page cannot
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
  work = ''; // the proof checker's progress line ends with the check
  save();
}

// L4: a page opened again checks that the host's small payment is still on the chain (a reorganised chain can drop it)
let coinRechecked = false;
async function recheckCoin() {
  coinRechecked = true;
  const ce = myCoinEntry();
  if (!ce) return;
  try {
    const seen = agree(await askBoth('GetTransaction', W.tx_filter_request(ce.coin.txid)), (raw) => (raw === null ? null : JSON.parse(W.find_coin(raw, state.pageKey))));
    serversDisagree = !!seen.disagree;
    if (seen.disagree) { coinRechecked = false; return; } // asked again on the next refresh
    if (!seen.answered) { coinRechecked = false; return; }
    state.coinGone = !seen.value || seen.value.height == null;
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

// set 2, L3: a worker that cannot load answers "no" (never a page that waits for ever), and the proof is checked for the network
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

// "Payment seen, waiting for the network": only for a payment this page knows the id of (sent with Noir). A blind bid auction's viewing key
// is not public, so the page cannot open other payments waiting in the mempool; a wallet payment shows once the host lists it. Cleared once
// the payment is mined.
async function detectPending() {
  if (!state || state.ticket || !state.noirTxid) return;
  const [raw] = await grpcWeb(cfg.server, 'GetTransaction', W.tx_filter_request(state.noirTxid));
  const h = raw && raw.length ? readVarintField(raw, 2) : null;
  const waiting = !!(raw && raw.length) && !(h != null && h > 0 && h < 0xffffffff);
  if (waiting !== !!state.pendingSeen) { state.pendingSeen = waiting; save(); }
}

/** The coin came: open the late ticket, check it against the list and the chain (coin, anchor, refund output, signatures, proof), sign it. */
async function protectLate() {
  const ce = myCoinEntry();
  if (!ce || state.late || state.lateProblem) return;
  const s = rules.sealed;
  const cutoff = rules.deadline_height - s.coin_cutoff;
  // the owner's rule: the coin as two servers see it; when they differ, nothing is signed and the page asks again on the next refresh
  const coinSeen = agree(await askBoth('GetTransaction', W.tx_filter_request(ce.coin.txid)), (raw) => (raw === null ? 'not found' : JSON.parse(W.find_coin(raw, state.pageKey))));
  serversDisagree = !!coinSeen.disagree;
  if (coinSeen.disagree || !coinSeen.answered || coinSeen.value === 'not found') return; // not on the chain yet: on its way
  const found = coinSeen.value;
  state.coin = found ? { ...found, txid: ce.coin.txid } : null;
  if (!found) { state.lateProblem = 'The host\'s small payment does not pay this page\'s address.'; save(); return; }
  if (found.height == null || tip < found.height + coinConfirmations() - 1) return; // on its way
  if (found.height > cutoff) { state.lateProblem = `The host's small payment came after the cutoff (block ${cutoff}).`; save(); return; }
  if (found.index !== ce.coin.index || found.value_zat !== ce.coin.value_zat || found.value_zat < s.coin_zat) { state.lateProblem = 'The host\'s small payment is not what the list says.'; save(); return; }
  work = 'The host\'s small payment arrived. Checking and signing your late ticket.'; render();
  const blob = await getBytes(`blobs/${ce.blob_hash}`);
  if (!blob) return;
  // set 2, L2: when the chain server cannot say which network version it runs, ask again on the next refresh (never saved as
  // a failed late ticket)
  const branchSeen = await networkBranchBoth();
  if (branchSeen.disagree) { serversDisagree = true; work = ''; return; }
  const branchNow = branchSeen.value;
  if (branchNow == null) { work = ''; return; }
  try {
    const opened = JSON.parse(W.open_late(state.seed, JSON.stringify(ce), blob));
    // set 3: with late_key the late ticket is made with this payment's own key, which this page works out itself, so
    // the recount can later open it and check whom it paid
    if (s.late_key && opened.ovk_hex !== W.payout_ovk(state.seed, rules.payload_pubkey, state.ticket.nf, 'late')) throw new Error('The late ticket is not made with the key this page works out, so a recount could not check whom it pays.');
    const expect = JSON.stringify({
      deposit_nf: state.ticket.nf, coin_txid: ce.coin.txid, coin_index: ce.coin.index, coin_value_zat: ce.coin.value_zat,
      lock_time: s.claim_after, refund_address: state.refund, refund_zat: state.paidZat - rules.refund_fee_zat, deposit_zat: state.paidZat,
      current_branch: branchNow, // H5: built for the network version in use now
    });
    const checked = JSON.parse(W.check_late(state.seed, opened.raw_hex, opened.ovk_hex, expect));
    const rootSeen = agree(await askBoth('GetTreeState', W.tree_state_request(opened.anchor_height)), (ts) => (ts === null ? null : W.ironwood_root(ts)));
    if (rootSeen.disagree) { serversDisagree = true; work = ''; return; }
    if (!rootSeen.answered) { work = ''; return; }
    if (rootSeen.value !== checked.anchor_hex) throw new Error('The late ticket\'s anchor is not a note tree root of the chain.');
    if (!(await proofOk(opened.raw_hex, JSON.parse(expect).current_branch))) throw new Error('The late ticket\'s proof does not verify.');
    // how many servers agreed on the coin, the network version and the note tree (2, or 1 when the other did not answer)
    const checkedWith = Math.min(coinSeen.answered, branchSeen.answered, rootSeen.answered);
    state.late = { signed_hex: W.sign_late(state.seed, opened.raw_hex, expect), txid: opened.txid, checkedWith, ofServers: cfg.server2 ? 2 : 1 };
    // a copy for the late ticket watcher, which sends it after the late ticket block if the host never closes (docs/BLIND_BIDS.md). Only for a
    // late ticket signed from 23 Oct 2026 on: a page that signed one before keeps doing what it did
    state.lateUpload = { done: [], tries: 0 };
  } catch (e) {
    state.lateProblem = String(e.message || e);
  }
  work = '';
  save();
  await uploadLate();
}

/** Gives each list server a copy of the signed late ticket (write only: a server never shows it, as it would show the deposit's size before
 *  the close). A server that does not take it (an older one) is asked again on the next two refreshes, then left. */
async function uploadLate() {
  const u = state && state.late && state.lateUpload;
  if (!u || u.tries >= 3 || u.done.length === cfg.relays.length) return;
  u.tries++;
  const body = hexToBytes(state.late.signed_hex);
  for (const r of cfg.relays.filter((x) => !u.done.includes(x))) {
    try { const res = await fetch(`${r}/v1/campaigns/${cfg.id}/late/${state.ticket.nf}`, { method: 'PUT', body }); if (res.ok) u.done.push(r); } catch { /* asked again */ }
  }
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
  sent(r);
  if (r.ok) { state.earlySent = t.txid; save(); }
  render();
}

async function sendLate() {
  const r = await send(state.late.signed_hex);
  sent(r);
  if (r.ok) { state.lateSent = state.late.txid; save(); }
  render();
}

// ---------- what the page shows ----------
// The owner's rule for page text: one short plain line, only when it changes what the person must do; the rest behind "more". status() gives
// one card: its tone (m neutral, t teal, g green, a amber, r red), tag, title, line, the "more" text and what it offers.
const fmtB = (n) => Number(n).toLocaleString('en-US');
const amount = (zat) => (zat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
const ticker = () => (campaign ? campaign.ticker : '');
const short = (a, head = 6, tail = 6) => (a && a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a || '');
const PRICING = {
  uniform: ['Uniform price', 'winners pay the lowest winning bid', 'Every winner pays the lowest winning bid.'],
  second: ['Second price', 'winners pay the highest losing bid', 'Every winner pays the highest losing bid.'],
  pay_your_bid: ['Pay your bid', 'winners pay their own bid', 'Winners pay their own bid.'],
};
const pricing = () => PRICING[rules.sealed.pricing] || PRICING.pay_your_bid;
// drand quicknet: a round every 3 seconds from its genesis (ll_core::sealed::round_time)
const QUICKNET_GENESIS = 1692803367, QUICKNET_PERIOD = 3;
const roundTime = (r) => QUICKNET_GENESIS + (r - 1) * QUICKNET_PERIOD;
function eta(blocks) {
  if (!spb || blocks < 0) return null;
  const s = blocks * spb;
  if (s < 90) return '<1 min';
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}
const S = (tone, tag, title, line, more, o = {}) => ({ tone, tag, title, line, more: more || '', ...o });

function status() {
  const s = rules.sealed, d = rules.deadline_height, cutoff = d - s.coin_cutoff, hs = s.claim_after, fee = rules.refund_fee_zat;
  const take = lastTakeBack(), canTake = tip <= take, early = canTake ? 'early' : null;
  const takeNow = 'Take your money back now.';
  const atClose = 'Your deposit comes back at the close.';
  const tooLate = `An early ticket must be sent by block ${fmtB(take)} to be mined before it expires at the deadline.`;
  // C1 and H2: the host's payment to this person, opened on the chain with this page's own key
  const po = state.payout;
  const words = { refund: 'refund', change: 'change', return: 'return' };
  if (po && po.height && !po.ok) return S('r', 'PROBLEM', 'The host\'s payment does not pay you', 'Keep your backup file. The recount marks this host.', `The ${words[po.kind]} (transaction ${po.txid}, block ${fmtB(po.height)}) does not pay ${coin(po.want)} to your refund address. This page opened it on the chain with its own key.`);
  const chain = !!(po && po.height && po.ok);
  const checked = chain ? `Checked on the chain with this page's own key: the ${words[po.kind]} pays ${coin(po.want)} to your refund address.` : '';
  if (state.rejected) {
    const sent = state.challenge && state.challenge.ok.length;
    return S('a', 'REJECTED', 'The host rejected your payment', `${state.lateReturn ? 'It was sent back to you' : 'It is being sent back to you'}, minus the fee.`, [
      `Mined in block ${fmtB(state.rejected.height)}${state.rejected.reason ? ` (the host's reason: ${state.rejected.reason})` : ''}.`,
      state.lateReturn ? `Return: transaction ${state.lateReturn.txid}, minus the ${coin(fee)} fee.` : `The host must send it back within ${rules.ticket_k} blocks; the recount marks it if not.`,
      sent ? `You published proof that it was valid, to ${state.challenge.ok.length} of ${cfg.relays.length} list servers; the recount marks the host if the proof holds.` : 'If it was valid, you can publish proof. Publishing shows everyone your refund address now; the close makes it public anyway.',
      checked].filter(Boolean).join(' '), { action: 'challenge', chain });
  }
  if (state.lateReturn) return S('a', 'TOO LATE', 'Your payment came too late', 'It arrived after bidding closed, so it was sent back, minus the fee.', `Payments after block ${fmtB(lastDeposit())} cannot join the auction; yours was mined in block ${fmtB(state.lateReturn.height)}. Return: transaction ${state.lateReturn.txid}, minus the ${coin(fee)} fee. ${checked}`, { chain });
  if (state.earlySent && state.earlyMined) return S('g', 'TAKEN BACK', 'Your money is back', 'Your bid is out of the auction.', `Your early ticket was mined in block ${fmtB(state.earlyMined)}: your deposit, minus the fee, is at your refund address.`);
  if (state.earlySent && tip <= d) return S('t', 'SENDING BACK', 'Your money is on its way back', 'Keep this page open until it is mined.', `Your early ticket must be mined by block ${fmtB(d)}.`, { pulse: 1 });
  if (state.earlySent && state.refundMined) return S('g', 'REFUNDED', 'Your money is back', 'It came back by the host\'s signed refund.', `Your early ticket was not mined before the deadline, so the deposit stayed in the auction; the refund was mined in block ${fmtB(state.refundMined)}.`);
  if (state.lateSent) return S('t', 'SENDING BACK', 'Your deposit is on its way back', 'It goes to your refund address, minus the fee.', 'You sent your late ticket.', { pulse: 1 });
  if (!state.ticket && state.pendingSeen) return S('m', 'PAYMENT SEEN', 'Payment seen, waiting for the network', 'Sent with Noir. This page updates by itself.', `Your payment is waiting to be mined. You can leave and come back with the same link. The host lists your ticket within ${rules.ticket_k} blocks of your payment; a payment mined after block ${fmtB(lastDeposit())} does not count and is sent back, minus the fee.`, { back: 1, pulse: 1 });
  if (!state.ticket) return S('m', 'WAITING', 'Waiting for your payment', state.noirTxid || state.noirSent ? 'Sent with Noir. This page updates by itself.' : 'Your payment only counts if it carried the message. If it did not, it is a donation.', `This page cannot see payments into the auction: its viewing key stays private until after the close. Your ticket shows here once the host lists your payment, usually a minute or two after it is mined. You can leave and come back with the same link. The host lists your ticket within ${rules.ticket_k} blocks of your payment; a payment mined after block ${fmtB(lastDeposit())} does not count and is sent back, minus the fee.`, { back: 1, pulse: 1 });
  const c = closeEntry();
  if (c) {
    const won = (c.close.winners || []).includes(state.ticket.nf), st = mySettle();
    if (c.close.outcome === 'void') return S('m', 'RESULT', 'The auction was void', 'Every deposit goes back by its signed refund.', `The bids could have been opened too early for this deadline, so no bid counts. ${checked}`, { chain, recount: 1 });
    if (won) {
      const line = !st ? 'The host is settling. The rest of your deposit comes back to you.' : st.settle.excess_zat > 0 ? `${coin(st.settle.excess_zat)} change is coming back to your refund address.` : 'Your bid used the whole deposit, so no change comes back.';
      return S('g', 'RESULT', 'You won', line, `${pricing()[2]} The rest of the deposit, minus the fee, goes back to the refund address. ${checked}`, { num: st ? amount(st.settle.price_zat) : null, unit: `${ticker()} paid`, chain, recount: 1 });
    }
    return S('m', 'RESULT', 'You did not win', 'Your deposit is coming back to your refund address.', `Every losing deposit goes back to its refund address, minus the fee, by the host's signed refund. ${checked}`, { num: amount((state.paidZat || state.tranche) - fee), unit: `${ticker()} coming back`, chain, recount: 1, action: tip > hs && state.late ? 'late' : null });
  }
  if (tip > hs) return S('r', 'PROBLEM', 'The host did not finish', state.late ? 'Bids were not settled in time. Take your money back.' : 'Bids were not settled in time. Keep your backup file.', `The host did not open and settle the bids by block ${fmtB(hs)}. ${state.late ? `From block ${fmtB(hs + 1)} your late ticket pays your deposit, minus the fee, to your refund address.` : 'This page holds no late ticket for you; the recount marks this host.'}`, { action: state.late ? 'late' : null });
  if (tip > d) return S('t', 'BIDDING CLOSED', 'Bids open soon', `All bids open at drand round ${fmtB(s.drand_round)}.`, `drand is a public clock anyone can check. At that round every bid can be read at once.${state.late ? ` If the host does not finish, from block ${fmtB(hs + 1)} you can take your deposit back on your own.` : ''}`, { cd: 1, pulse: 1 });
  const paidAt = state.ticket.entry && state.ticket.entry.contribution ? state.ticket.entry.contribution.height : null;
  // H4 and C1: nothing is PROTECTED, and no take back is offered, before the early ticket and the signed refund check out
  const tc = state.ticketsChecked;
  if (!tc) return S('m', 'CHECKING', 'Checking your tickets', 'Keep this page open.', 'This page checks who your tickets pay, how much, their signatures and their proofs.', { pulse: 1 });
  if (!tc.ok) {
    const what = tc.problems.join(' ');
    return tc.earlyOk && canTake
      ? S('r', 'PROBLEM', 'Your ticket does not check out', 'Do not rely on it. Take your money back now.', `${what} The recount marks the host.`, { action: 'early' })
      : S('r', 'PROBLEM', 'Your ticket does not check out', tc.earlyOk ? `${atClose} Keep your backup file.` : 'This page cannot take your money back for you. Keep your backup file.', `${what} ${tc.earlyOk ? tooLate : ''} The recount marks the host.`);
  }
  if (serversDisagree) return S('a', 'WAIT', 'The servers disagree', 'Wait or take your money back.', `Two chain servers gave different answers about your ticket, so this page does not say PROTECTED. It asks both again every few seconds.${canTake ? '' : ` ${tooLate}`}`, { action: early });
  if (state.late && state.coinGone) return S('a', 'ACTION NEEDED', 'The host\'s small payment is gone', `It is gone from the chain. ${canTake ? takeNow : atClose}`, `The chain was reorganised, so your late ticket would not work.${canTake ? '' : ` ${tooLate}`}`, { action: early });
  if (paidAt != null && paidAt > cutoff && !state.late) {
    const why = `Your deposit was mined in block ${fmtB(paidAt)}, after the cutoff for the host's small payment (block ${fmtB(cutoff)}). Without that payment you have no late ticket: if the host never closes, nothing gives your money back on its own.`;
    return canTake
      ? S('a', 'ACTION NEEDED', 'Your bid does not count', 'You paid after the cutoff. Take your money back now.', why, { action: 'early' })
      : S('a', 'TOO LATE', 'Your bid does not count', atClose, `${why} ${tooLate}`);
  }
  const back = canTake ? takeNow : atClose;
  const backMore = canTake ? `You can take your money back until block ${fmtB(take)}.` : `${tooLate} If the host never closes, this page holds no late ticket for you.`;
  if (planProblem) return S('r', 'PROBLEM', 'This auction\'s timing is wrong', back, `${planProblem} ${backMore}`, { action: early });
  if (planProblem === undefined) return S('m', 'CHECKING', 'Checking the auction', 'Keep this page open.', 'This page checks the auction\'s timing against the chain.', { action: early, pulse: 1 });
  if (state.late) return S('g', 'YOUR MONEY IS COVERED', 'PROTECTED', canTake ? `You can take your money back until block ${fmtB(take)}.` : atClose, `${state.late.ofServers === 2 && state.late.checkedWith === 1 ? 'Checked with 1 of 2 servers. ' : ''}Your refund ticket checks out. Your bid stays locked until bids open. If the host never finishes, open your bid page after block ${fmtB(hs)} and press Take my money back.`, { big: 1, num: amount(state.tranche), unit: `${ticker()} deposit`, action: early, grey: 1 });
  if (state.lateProblem) return S('r', 'PROBLEM', 'Your ticket does not check out', back, `${state.lateProblem} ${backMore}`, { action: early });
  if (tip >= cutoff) return S('a', 'ACTION NEEDED', 'The host\'s small payment did not arrive', back, `Without it, your refund ticket cannot be completed by the host. ${backMore}`, { action: early });
  // M3: the page checks and signs the late ticket only while it is open; it warns from the block by which the host must have sent its
  // small payment (COIN_RUSH_BLOCKS before the cutoff) plus 5 blocks to mine it, well before the cutoff. An auction made after NU7 with the
  // standard timing has three times both (ll_core::sealed::coin_scale): the same time with 25 second blocks
  const signs = `This page signs your late ticket only while it is open. You can take your money back until block ${fmtB(take)}.`;
  const coming = !!myCoinEntry();
  if (tip >= cutoff - COIN_WARN_BLOCKS * coinScale()) return S('a', 'ACTION NEEDED', 'Not protected yet, and the cutoff is close', `Keep this page open. If it does not say PROTECTED by block ${fmtB(cutoff)}, take your money back.`, `${coming ? 'The host\'s small payment is on its way.' : `The host's small payment has not come; it must be mined by block ${fmtB(cutoff)}.`} ${signs}`, { action: early, pulse: 1 });
  return S('t', 'ALMOST THERE', 'Waiting for your ticket', 'Keep this page open until it says PROTECTED.', `Your payment arrived. ${coming ? 'The host\'s small payment that completes your refund ticket is on its way.' : `The host now sends a small payment that completes your refund ticket. If it has not come by block ${fmtB(cutoff)}, take your money back.`} ${signs}${coming ? '' : ' If you close this page, open it again before then.'}`, { action: early, pulse: 1 });
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
  $('#noir-row').hidden = $('#noir-pay').hidden;
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

// ---------- drawing the page: step 1 the bid, step 2 the payment, step 3 one status card ----------
let editing = false; // "← Bid" from the payment: the form again, filled in, the payment kept until a new one is made
let moreOpen = false, moreKey = '', takeAsk = null, cdTimer = null;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function factRow(k, v, sub) {
  const row = el('div', 'bb-fr'), r = el('span', 'r');
  r.append(el('b', null, v));
  if (sub) r.append(el('span', null, sub));
  row.append(el('span', null, k), r);
  return row;
}
/** The page sees the payment (its ticket, a reject, a return), or something was sent from here: the status card comes by itself. */
const seen = () => !!(state && (state.ticket || state.rejected || state.lateReturn || state.earlySent || state.lateSent || state.noirTxid || state.noirSent || state.showStatus));

function render() {
  for (const id of ['#form-card', '#pay-card', '#status-card', '#status-line']) $(id).hidden = true;
  $('#banners').replaceChildren();
  if (refused) { const p = el('p', 'warnline', refused); $('#banners').append(p); return; }
  if (!rules || tip == null) return;
  const s = rules.sealed, d = rules.deadline_height;
  const step = !state || editing ? 1 : seen() ? 3 : 2;
  // the auction line: OPEN · ~time left, or CLOSED once the deadline has passed or the auction closed
  $('#status-line').hidden = false;
  $('#cname').textContent = campaign.name || `Blind bid auction ${cfg.id.slice(0, 8)}`;
  $('#ckind').textContent = `Blind bid auction · ${rules.items} ${rules.items === 1 ? 'item' : 'items'}`;
  const closed = tip > d || !!closeEntry(), left = eta(d - tip);
  $('#status-chip').classList.toggle('closed', closed);
  $('#pill-t').textContent = closed ? 'CLOSED' : left ? `OPEN · ~${left}` : 'OPEN';
  for (const li of document.querySelectorAll('#steps li')) {
    const n = Number(li.dataset.n);
    li.classList.toggle('done', n < step);
    if (n === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    li.querySelector('span').textContent = n < step ? '✓' : String(n);
  }
  $('#flow-back').hidden = step !== 1; $('#pay-back').hidden = step !== 2; $('#home-back').hidden = step !== 3;
  const mine = state ? [['Deposit', coin(state.tranche), 'public size'], ['Your bid', coin(state.bid), closeEntry() ? 'opened at the close' : 'locked until bids open'], ['Refund to', short(state.refund), 'public after the close']] : [];
  for (const box of document.querySelectorAll('.bb-mine')) box.replaceChildren(...mine.map(([k, v, sub]) => factRow(k, v, sub)));
  renderNoir();
  if (step === 1) return renderForm();
  if (step === 2) return renderPay();
  return renderStatus();
}

function renderForm() {
  const s = rules.sealed, fee = rules.refund_fee_zat, d = rules.deadline_height, [pl, psub] = pricing();
  $('#form-card').hidden = false;
  $('#edit-note').hidden = !editing;
  const left = eta(d - tip);
  $('#facts').replaceChildren(
    factRow('Items', String(rules.items)),
    factRow('Deposit sizes', `${s.tranches_zat.map(amount).join(' · ')} ${ticker()}`),
    tip > d ? factRow('Deadline', 'passed', `block ${fmtB(d)}`) : left ? factRow('Deadline', `≈${left}`, `block ${fmtB(d)}`) : factRow('Deadline', `block ${fmtB(d)}`),
    factRow('Bids open', 'drand round', fmtB(s.drand_round)),
    factRow('Pricing', pl, psub),
    factRow('Ties', 'Chain order'),
  );
  const box = $('#tranche');
  if (!box.children.length) {
    s.tranches_zat.forEach((t, i) => {
      const b = el('button', 'bb-dep');
      b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.zat = String(t);
      b.setAttribute('aria-checked', i === 0 ? 'true' : 'false'); b.tabIndex = i === 0 ? 0 : -1;
      const v = el('span', 'v'); v.append(el('b', null, amount(t)), el('span', null, ticker()));
      b.append(el('span', 'dot'), v, el('span', 'up', `bids up to ${amount(t - fee)}`));
      b.setAttribute('aria-label', `${coin(t)} deposit, bids up to ${amount(t - fee)}`);
      b.addEventListener('click', () => pickTranche(b));
      box.append(b);
    });
    box.addEventListener('keydown', (e) => {
      const all = [...box.children], i = all.findIndex((x) => x.getAttribute('aria-checked') === 'true');
      const next = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (next == null) return;
      e.preventDefault(); const b = all[(i + next + all.length) % all.length]; pickTranche(b); b.focus();
    });
  }
  if (editing && state && !$('#form').dataset.filled) {
    $('#form').dataset.filled = '1';
    const b = [...box.children].find((x) => Number(x.dataset.zat) === Number(state.tranche)); if (b) pickTranche(b, true);
    $('#bid').value = amount(state.bid); $('#refund').value = state.refund;
  }
  const w = JSON.parse(W.sealed_bid_window(rulesJson, tip, tipTime || 0));
  windowOk = w.ok && !planProblem && planProblem !== undefined;
  hint = planProblem ? 'This auction\'s timing is wrong. Do not bid.' : w.ok && planProblem === undefined ? 'Checking the auction\'s timing against the chain.' : w.ok ? 'Your deposit shows only its size, never your bid.' : w.reason;
  $('#recount-link').href = $('#nav-recount').href;
  syncBid();
}
function pickTranche(b, quiet) {
  for (const x of $('#tranche').children) { const on = x === b; x.setAttribute('aria-checked', on ? 'true' : 'false'); x.tabIndex = on ? 0 : -1; }
  if (!quiet) syncBid();
}

// which wallets keep the message (the memo) on a payment. Only zcash-devtool was tried with Clewbook; the others are read from their source
// code (25 Oct 2026): Zashi (now Zodl) takes a pasted memo and the memo of a code scanned inside the app (iOS ignores a tapped link); Zingo
// caps a memo at 511 bytes and splits a longer one, and the message of an auction with the long tag is 512; YWallet says it no longer
// supports Zcash since the Ironwood upgrade.
function wallets(memo) {
  const long = new TextEncoder().encode(memo || '').length > 511;
  return `Tested with zcash-devtool; others read from source only, not tested. Zashi keeps a pasted message, and the code when scanned from inside the app (on iPhone a tapped link is not used). ${long
    ? 'Zingo splits a message over 511 bytes and this one is longer, so do not use Zingo here.'
    : 'Zingo keeps a pasted message and the code\'s.'} YWallet says it no longer supports Zcash since the Ironwood upgrade.`;
}

function renderPay() {
  $('#pay-card').hidden = false;
  $('#pay-amount').textContent = coin(state.tranche);
  const to = $('#pay-to'); to.textContent = short(state.payTo, 13, 8); to.dataset.full = state.payTo; to.title = state.payTo;
  $('#pay-amt').textContent = coin(state.tranche); $('#pay-amt').dataset.full = String(state.tranche / 1e8);
  const m = $('#memo'); m.textContent = state.memo; m.title = state.memo;
  if ($('#qr').dataset.memo !== state.memo) { $('#qr').dataset.memo = state.memo; $('#qr').replaceChildren(...(typeof state.qrSvg === 'string' && state.qrSvg ? [qrImage(state.qrSvg)] : [])); }
  $('#open-wallet').href = state.uri || `zcash:${state.payTo}?amount=${amount(state.tranche)}&memo=${btoa(String.fromCharCode(...new TextEncoder().encode(state.memo))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  const saved = !!state.backupSaved;
  $('#backup-card').classList.toggle('saved', saved);
  $('#bk-tag').textContent = saved ? '✓ STEP 1 · SAVED' : '△ STEP 1 · IMPORTANT';
  $('#saved').checked = saved;
  // the message comes first: the address and the amount show once the person says the message is in their wallet's memo (Noir attaches it itself)
  $('#attached').checked = !!state.memoAttached;
  $('#pay-lock').hidden = !state.memoAttached; $('#pay-locked').hidden = !!state.memoAttached;
  $('#wallets-text').textContent = wallets(state.memo);
  $('#pay-by').textContent = `Pay by block ${fmtB(lastDeposit())}. Late payments are sent back.`;
}

function renderStatus() {
  $('#status-card').hidden = false;
  const st = status(), card = $('#st-card');
  const key = `${st.tone}|${st.title}`;
  if (key !== moreKey) { moreKey = key; moreOpen = false; if (takeAsk && !st.action) takeAsk = null; }
  card.dataset.tone = st.tone;
  card.classList.toggle('big', !!st.big); card.classList.toggle('pulse', !!st.pulse);
  $('#st-tag').textContent = st.tag; $('#st-title').textContent = st.title; $('#st-text').textContent = st.line;
  $('#st-numrow').hidden = !st.num; $('#st-num').textContent = st.num || ''; $('#st-unit').textContent = st.unit || '';
  $('#st-chain').hidden = !st.chain;
  $('#st-cd').hidden = !st.cd; tickCountdown();
  $('#st-back-pay').hidden = !st.back;
  $('#st-recount').hidden = !st.recount; $('#st-recount').href = $('#nav-recount').href;
  // the facts that used to be a list: behind "more", with the rest
  const extra = [];
  if (state.noirTxid && !state.paidZat) extra.push(`Sent with Noir: transaction ${state.noirTxid}.`);
  if (state.earlySent && !state.earlyMined && tip > rules.deadline_height) extra.push(`Your early ticket (${state.earlySent}) was not mined before it expired at the deadline (block ${fmtB(rules.deadline_height)}): your deposit stayed in the auction.`);
  if (ignoredServer) extra.push(`The link named the chain server ${ignoredServer}; this page uses ${cfg.server} instead.`);
  const more = [st.more, ...extra].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  $('#st-more').textContent = more; $('#st-more').hidden = !moreOpen || !more;
  $('#st-more-btn').hidden = !more; $('#st-more-btn').textContent = moreOpen ? 'less' : 'more'; $('#st-more-btn').setAttribute('aria-expanded', String(moreOpen));
  say($('#st-work'), work);
  // the actions: the early ticket (before the deadline), the late ticket (a host that did not finish), the proof of a rejected payment;
  // taking money back always asks once more
  const tone = st.grey ? 'grey' : st.tone === 'r' ? 'red' : st.tone === 'a' ? 'amber' : st.tone === 'g' || st.tone === 't' ? 'grey' : '';
  const canEarly = st.action === 'early' && state.ticket && tip <= lastTakeBack() && !state.earlySent && state.ticketsChecked && state.ticketsChecked.earlyOk;
  const canLate = st.action === 'late' && state.late && !state.lateSent;
  for (const [id, on] of [['#take-back', canEarly], ['#send-late', canLate]]) {
    const b = $(id); b.hidden = !on || !!takeAsk; b.classList.remove('grey', 'red', 'amber'); if (tone) b.classList.add(tone);
  }
  if (takeAsk && !(takeAsk === 'early' ? canEarly : canLate)) takeAsk = null;
  $('#take-ask').hidden = !takeAsk;
  if (takeAsk) { $('#take-amt').textContent = coin((state.paidZat || state.tranche) - rules.refund_fee_zat); $('#take-to').textContent = short(state.refund); }
  const ch = state.challenge;
  $('#challenge').hidden = !(st.action === 'challenge' && !(ch && ch.ok.length === cfg.relays.length));
  $('#challenge').textContent = ch && ch.ok.length ? 'Try the remaining list servers again' : 'Publish proof that my payment was valid';
}
/** The countdown to the drand round that opens the bids, from the round's own time. */
function tickCountdown() {
  if ($('#st-cd').hidden || !rules) return;
  const left = Math.max(0, Math.round(roundTime(rules.sealed.drand_round) - Date.now() / 1000));
  const p2 = (n) => String(n).padStart(2, '0');
  $('#cd-h').textContent = p2(Math.floor(left / 3600)); $('#cd-m').textContent = p2(Math.floor((left % 3600) / 60)); $('#cd-s').textContent = p2(left % 60);
}
function sent(r) {
  const m = $('#send-msg');
  say(m, r.ok ? '✓ Sent. It shows in your wallet after a block or two.' : `Not sent: ${r.message}`);
  m.classList.toggle('ok', !!r.ok);
  takeAsk = null;
}

// ---------- the bid ----------
let windowOk = false, hint = ''; // the auction takes deposits now, and the grey line under the bid (set by renderForm)
const selectedTranche = () => { const b = document.querySelector('#tranche [aria-checked="true"]'); return b ? Number(b.dataset.zat) : null; };
/** The bid as typed: empty, not an amount, too high for the chosen deposit (the deposit minus the refund fee, the limit the payment is built
 * with), or fine. The deposit is never changed for the person. */
function bidState() {
  const t = $('#bid').value.trim().replace(',', '.');
  if (!t) return { typed: false };
  if (!/^\d*\.?\d{0,8}$/.test(t) || !(Number(t) > 0)) return { typed: true, bad: `Enter a bid in ${ticker()}, up to 8 decimals.` };
  const bid = Math.round(Number(t) * 1e8), dep = selectedTranche(), fee = rules.refund_fee_zat, max = dep - fee;
  if (bid > max) {
    const bigger = rules.sealed.tranches_zat.some((x) => x > dep && bid <= x - fee);
    return { typed: true, tooHigh: true, bad: `Too high for a ${coin(dep)} deposit. Bid up to ${amount(max)}${bigger ? ' or pick a bigger deposit' : ''}.` };
  }
  return { typed: true, ok: true, bid };
}
/** The refund address: "" when this auction's network can pay it, else the one line (the WebAssembly module decides). */
const prefix = () => ({ main: 'u1', test: 'utest1' }[campaign.network] || 'uregtest1');
function addrState() {
  const a = $('#refund').value.trim();
  if (!a) return { typed: false };
  const p = W.sealed_refund_problem(campaign.network, a);
  return p ? { typed: true, bad: p } : { typed: true, ok: true };
}
/** Live, as on the contribute page: the red line under the bid in place of the grey one, the box glows, the chosen deposit turns red when the
 * bid is too high for it, and the button waits until the bid and the address are good. */
function syncBid() {
  if (!rules || !$('#tranche').children.length) return;
  const b = bidState(), a = addrState(), inp = $('#bid'), e = $('#bid-error');
  e.textContent = b.bad || ''; e.hidden = !b.bad;
  $('#bid-hint').textContent = hint; $('#bid-hint').hidden = !!b.bad || !hint;
  $('#bidbox').classList.toggle('bad', !!b.bad);
  for (const x of $('#tranche').children) x.classList.toggle('bad', !!b.tooHigh && x.getAttribute('aria-checked') === 'true');
  if (b.bad) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', 'bid-error'); } else { inp.removeAttribute('aria-invalid'); inp.setAttribute('aria-describedby', 'bid-hint'); }
  const r = $('#refund'), m = $('#refund-msg');
  m.textContent = !a.typed ? `A shielded address starting with ${prefix()}. Use one you use nowhere else.` : a.ok ? '✓ Shielded address. Use one you use nowhere else.' : a.bad;
  m.className = `bb-help${a.bad ? ' bad' : a.ok ? ' ok' : ''}`; m.setAttribute('role', a.bad ? 'alert' : 'note');
  r.classList.toggle('bad', !!a.bad); r.classList.toggle('ok', !!a.ok);
  if (a.bad) r.setAttribute('aria-invalid', 'true'); else r.removeAttribute('aria-invalid');
  $('#create').disabled = !windowOk || !b.ok || !a.ok;
}

async function onCreate(ev) {
  ev.preventDefault();
  const err = $('#form-error');
  try {
    const b = bidState(), a = addrState();
    if (!windowOk || !b.ok || !a.ok) return;
    const seed = W.generate_seed();
    const tranche = selectedTranche();
    const refund = $('#refund').value.trim();
    const p = JSON.parse(W.sealed_bid_payment(rulesJson, seed, refund, tranche, b.bid));
    // a bid changed after its payment was shown: the earlier one stays in this browser (and in its backup file)
    if (editing && state) { try { localStorage.setItem(`${storeKey}:replaced:${Date.now()}`, JSON.stringify(state)); } catch { /* the backup file holds it */ } }
    state = { seed, refund, tranche, bid: b.bid, memo: p.memo, payTo: p.pay_to, pageKey: p.page_key, qrSvg: p.qr_svg, uri: p.uri, paidZat: null, startHeight: tip };
    editing = false; delete $('#form').dataset.filled;
    save();
    say(err, '');
    render(); window.scrollTo(0, 0);
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

// set 2, L4: the payment code is shown as an image, never as markup, so a code taken from a stored or restored state cannot
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
    // the one line result at the top, once the auction has settled (result.js); drawn again when the list grows
    if (resultKey !== `${entries.length}:${state && state.ticket ? state.ticket.nf : ''}`) { resultKey = `${entries.length}:${state && state.ticket ? state.ticket.nf : ''}`; showResult($('#my-result'), { c: campaign, entries, id: cfg.id, W, servers: [cfg.server, cfg.server2].filter(Boolean), relays: cfg.relays, recount: $('#nav-recount').href }).catch(() => {}); }
    await readTip();
    if (planProblem === undefined) await checkPlan();
    if (state && !state.ticket) await detectTicket();
    if (state && !state.ticket) { try { await detectPending(); } catch { /* asked again on the next refresh */ } }
    if (state && state.lateUpload) await uploadLate();
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
  setup('Blind bid');
  if (!cfg.id || !cfg.relays.length) { refused = 'This link is missing the auction or its list servers.'; render(); return; }
  const tail = `c=${cfg.id}${cfg.relays.map((r) => `&relay=${r}`).join('')}`;
  const ms = milestones(), on = (h) => (ms ? ms.onward(h) : h); // opened from the demo's Tested milestones page: keep the way back
  $('#flow-back').href = on(`campaign.html#${tail}${cfg.server ? `&server=${cfg.server}` : ''}`);
  $('#nav-recount').href = on(`recount.html#${tail}`);
  copyLinkButton($('#copy-link'), cfg.id); // the short link when the listing names the auction, else the full one
  await init();
  $('#form').addEventListener('submit', onCreate);
  $('#bid').addEventListener('input', syncBid);
  $('#refund').addEventListener('input', syncBid);
  $('#noir-pay').addEventListener('click', onNoirPay);
  detectNoir().then((w) => { if (w) { noir = w; renderNoir(); } });
  const backedUp = () => { if (state) { state.backupSaved = true; save(); render(); } };
  $('#backup').addEventListener('click', () => { downloadBackup(); backedUp(); });
  $('#backup2').addEventListener('click', () => { downloadBackup(); backedUp(); });
  $('#saved').addEventListener('change', (e) => { if (state) { state.backupSaved = e.target.checked; save(); render(); } });
  $('#attached').addEventListener('change', (e) => { if (state) { state.memoAttached = e.target.checked; save(); render(); } });
  $('#restore-toggle').addEventListener('click', () => { const b = $('#restore-box'); b.hidden = !b.hidden; $('#restore-toggle').setAttribute('aria-expanded', String(!b.hidden)); });
  $('#restore').addEventListener('change', onRestore);
  $('#pay-back').addEventListener('click', () => { editing = true; render(); window.scrollTo(0, 0); });
  $('#edit-keep').addEventListener('click', () => { editing = false; delete $('#form').dataset.filled; render(); });
  $('#to-status').addEventListener('click', () => { state.showStatus = true; save(); render(); window.scrollTo(0, 0); });
  $('#st-back-pay').addEventListener('click', () => { state.showStatus = false; save(); render(); window.scrollTo(0, 0); });
  $('#st-more-btn').addEventListener('click', () => { moreOpen = !moreOpen; render(); });
  $('#take-back').addEventListener('click', () => { takeAsk = 'early'; render(); });
  $('#send-late').addEventListener('click', () => { takeAsk = 'late'; render(); });
  $('#take-no').addEventListener('click', () => { takeAsk = null; render(); });
  $('#take-yes').addEventListener('click', () => {
    const which = takeAsk, b = $('#take-yes');
    b.disabled = true;
    (which === 'late' ? sendLate() : takeBack()).catch((e) => { say($('#send-msg'), String(e.message || e)); takeAsk = null; render(); }).finally(() => { b.disabled = false; });
  });
  $('#challenge').addEventListener('click', () => { $('#challenge').disabled = true; publishChallenge().catch((e) => say($('#send-msg'), String(e.message || e))).finally(() => { $('#challenge').disabled = false; }); });
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', () => {
      const v = $(`#${b.dataset.copy}`);
      navigator.clipboard.writeText(v.dataset.full || v.textContent).catch(() => {});
      b.textContent = '✓ Copied'; b.classList.add('done');
      clearTimeout(b._t); b._t = setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1600);
    });
  }
  cdTimer = setInterval(tickCountdown, 1000);
  await refresh();
  markReady();
  setInterval(refresh, POLL_MS);
}

main().catch((e) => { refused = `Something went wrong: ${e.message || e}`; render(); });
