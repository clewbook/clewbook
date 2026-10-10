// Shared by the campaign page and the recount page: reading a campaign's public list from its relays,
// and small formatting helpers. Link format: <page>.html#c=<campaign id>&relay=<url>&relay=<url>&endpoint=<url>&endpoint=<url>
import * as W from './pkg/ll_web.js';
import { grpcWeb } from './recount.js';

export const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

export function linkParams() {
  const p = new URLSearchParams(location.hash.slice(1));
  const clean = (u) => u.replace(/\/$/, '');
  return {
    id: (p.get('c') || '').toLowerCase(),
    relays: p.getAll('relay').map(clean),
    endpoints: p.getAll('endpoint').map(clean),
    server: clean(p.get('server') || ''),
  };
}

export const DEFAULT_ENDPOINTS = {
  test: ['https://zjs.zec.rocks/testnet', 'https://zcash-testnet.chainsafe.dev'],
  // Servers run by different people on different hosting come first; the last one is a spare.
  // The two that answer browsers directly are both served through Fly.io (see groupOf).
  main: ['https://zjs.zec.rocks/mainnet', `${location.origin}/grpc/zec.0xrpc.io`, `${location.origin}/grpc/z.ombie.cash`, 'https://zcash-mainnet.chainsafe.dev'],
};

export const coin = (zat) => (zat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';

/** Seconds per block, measured from the block times of the last 100 blocks at the first endpoint that answers. null if none does. */
export async function observedBlockSeconds(endpoints, tip) {
  if (tip == null) return null;
  for (const e of endpoints) {
    try {
      const timeOf = async (h) => { const [b] = await grpcWeb(e, 'GetBlockRange', W.block_range_request(h, h), { timeoutMs: 12000 }); return varintField(b, 5); };
      const h0 = Math.max(1, tip - 100), t0 = await timeOf(h0), t1 = await timeOf(tip);
      if (t0 != null && t1 != null && tip - h0 >= 20 && t1 > t0) return (t1 - t0) / (tip - h0);
    } catch { /* try the next endpoint */ }
  }
  return null;
}

/** "about 3 hours" from a number of blocks and a measured seconds-per-block; null when it was not measured (no guessed constant). */
export function eta(blocks, secondsPerBlock) {
  if (!secondsPerBlock) return null;
  const sec = blocks * secondsPerBlock;
  if (sec < 90) return 'about a minute';
  if (sec < 5400) return `about ${Math.round(sec / 60)} minutes`;
  if (sec < 172800) return `about ${Math.round(sec / 3600)} hours`;
  return `about ${Math.round(sec / 86400)} days`;
}

async function getText(url) {
  // A request that never comes back (a dropped connection somewhere on the way) must not keep a page waiting: it is given 12 s, then asked once more for 20 s.
  let r;
  try { r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12000) }); }
  catch { r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) }); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** Reads rules, ledger and challenges from one relay and checks what it can: the rules must hash to the
 *  campaign id, and the ledger must be signed, chained and gap-free. */
export async function readRelay(url, id) {
  try {
    const rules = await getText(`${url}/v1/campaigns/${id}`);
    W.campaign_summary(rules, id);
    const ledgerText = await getText(`${url}/v1/campaigns/${id}/ledger?from=0`);
    const problems = JSON.parse(W.check_ledger(rules, id, ledgerText));
    let challenges = [];
    try { challenges = JSON.parse(await getText(`${url}/v1/campaigns/${id}/challenges`)); } catch { /* optional */ }
    return { url, rules, entries: JSON.parse(ledgerText), challenges, problems, error: null };
  } catch (e) {
    return { url, rules: null, entries: [], challenges: [], problems: [], error: String(e.message || e) };
  }
}

/** A saved copy of the public list (the host's export or backup: rules + signed list), checked the way a relay's copy is: the rules must hash to the
 *  campaign id and the list must be signed, chained and gap-free. Returns the same shape as `judge`, as a single source marked `fromFile`; throws a plain
 *  message when the file is not usable. */
export function fromSavedCopy(text, id) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error('That file is not a saved copy of a campaign list (it could not be read as JSON).'); }
  if (!d || d.kind !== 'ledger-export' || !Array.isArray(d.ledger) || !d.rules) throw new Error('That file is not a saved copy of a campaign list (it is not an export made by the host program).');
  if (String(d.campaign || '').toLowerCase() !== id) throw new Error('That saved copy is for a different campaign. Nothing was checked.');
  const rules = typeof d.rules === 'string' ? d.rules : JSON.stringify(d.rules);
  try { W.campaign_summary(rules, id); } catch (e) { throw new Error(`The saved copy does not check out: its rules do not match the campaign (${e.message || e}). It was ignored.`); }
  const problems = JSON.parse(W.check_ledger(rules, id, JSON.stringify(d.ledger)));
  if (problems.length) throw new Error(`The saved copy does not check out: ${problems[0]} It was ignored, so no verdict is given from it.`);
  const challenges = Array.isArray(d.challenges) ? d.challenges : [];
  return { kind: 'single', fromFile: true, entries: d.ledger, challenges, notes: [], rules, final: d.final ? JSON.stringify(d.final) : '', ok: [{ url: 'saved copy', entries: d.ledger }] };
}

/** kind: agree | single | disagree | none. A disagreement is never blamed on the host. */
export function judge(reads) {
  const notes = [];
  for (const r of reads) {
    if (r.error) notes.push(`${hostOf(r.url)} could not be reached (${r.error}).`);
    else if (r.problems.length) notes.push(`${hostOf(r.url)} shows a list that does not add up (${r.problems[0]}), so it is ignored.`);
  }
  const ok = reads.filter((r) => !r.error && r.problems.length === 0);
  const rules = (ok[0] || reads.find((r) => r.rules) || {}).rules || null;
  if (!ok.length) return { kind: 'none', entries: [], challenges: [], notes, rules, ok };
  const best = ok.reduce((a, b) => (b.entries.length > a.entries.length ? b : a));
  const same = ok.every((r) => JSON.stringify(r.entries) === JSON.stringify(ok[0].entries));
  const seen = new Map();
  for (const r of ok) for (const c of r.challenges) seen.set(JSON.stringify(c), c);
  const challenges = [...seen.values()];
  if (ok.length > 1 && !same) {
    notes.push('The relays do not show the same list: ' + ok.map((r) => `${hostOf(r.url)} has ${r.entries.length} entries`).join(', ') + '. A relay can be behind, down or dishonest, so this says nothing about the host.');
    return { kind: 'disagree', entries: best.entries, challenges, notes, rules, ok };
  }
  return { kind: ok.length > 1 ? 'agree' : 'single', entries: best.entries, challenges, notes, rules, ok };
}

export async function readAllRelays(id, relays) {
  return judge(await Promise.all(relays.map((u) => readRelay(u, id))));
}

function varintField(bytes, field) {
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++], f = tag >> 3, t = tag & 7;
    if (t === 0) { let v = 0, s = 0, b; do { b = bytes[i++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); if (f === field) return v; }
    else if (t === 2) { let len = 0, s = 0, b; do { b = bytes[i++]; len += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); i += len; }
    else if (t === 1) i += 8; else if (t === 5) i += 4; else break;
  }
  return null;
}

/** Chain height from one endpoint, or null if it does not answer in time. */
export async function tipOf(endpoint, timeoutMs = 12000) {
  try { const [m] = await grpcWeb(endpoint, 'GetLatestBlock', new Uint8Array(), { timeoutMs }); return varintField(m, 1); } catch { return null; }
}

const pageDir = () => new URL('.', location.href.split('#')[0]).href; // the folder this page is in (the link's #part may contain slashes)

/** Contribute / recount / campaign links that keep the same relays and endpoints. */
export function sibling(page, { id, relays, endpoints, server }) {
  const base = pageDir();
  const q = [`c=${id}`, ...relays.map((r) => `relay=${r}`), ...endpoints.map((e) => `endpoint=${e}`), ...(server ? [`server=${server}`] : [])];
  return `${base}${page}.html#${q.join('&')}`;
}

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The badge a host pastes into their own page: a small iframe of badge.html (this site draws it, so it carries our fonts and look). It claims
 *  nothing: it names the campaign and links to the live recount. Inside the iframe a plain link is the fallback. */
export function badgeSrc(recountLink) { return recountLink.replace('recount.html#', 'badge.html#'); }
export function badgeSnippet(links) {
  return `<iframe src="${escAttr(badgeSrc(links.recount))}" title="Recount badge for this campaign" width="300" height="160" loading="lazy" style="border:0;max-width:100%">\n  <a href="${escAttr(links.recount)}">Recount this campaign yourself</a>\n</iframe>`;
}

/** Which hosting a server appears to run on, from what we could observe (response headers and addresses).
 *  Two servers in the same group are not independent evidence. Unknown servers count as their own group. */
/** The server's own name: for a call forwarded by this computer's page server (/grpc/<host>) it is that host. */
export function serverName(url) {
  try { const u = new URL(url); const m = u.pathname.match(/^\/grpc\/([^/]+)/); return m ? m[1] : u.host; } catch { return url; }
}

export function groupOf(url) {
  const h = serverName(url);
  if (/(^|\.)zec\.rocks$/.test(h) || /(^|\.)chainsafe\.dev$/.test(h)) return 'Fly.io, the zec.rocks network';
  return h;
}
