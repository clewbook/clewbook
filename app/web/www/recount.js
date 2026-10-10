// In-browser recount (spike S4): fetch compact blocks and full transactions over gRPC-web,
// scan them in WebAssembly with the campaign's viewing key, and print the recount report.
// The same module runs in Node (>= 18) for timing and comparison with the CLI.
import init, { Recount, block_range_request, tx_filter_request } from './pkg/ll_web.js';

const SERVICE = 'cash.z.wallet.sdk.rpc.CompactTxStreamer';

/** One gRPC-web unary or server-streaming call; returns the protobuf messages. Never waits forever:
 *  the request is cancelled after `timeoutMs` and reported as "no answer". */
export async function grpcWeb(base, method, request, { timeoutMs = 20000 } = {}) {
  const body = new Uint8Array(5 + request.length);
  new DataView(body.buffer).setUint32(1, request.length); // byte 0 = 0: uncompressed data frame
  body.set(request, 5);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const messages = [];
    let trailers = '';
    for (let i = 0; i < buf.length; ) {
      const flag = buf[i];
      const len = new DataView(buf.buffer, buf.byteOffset + i + 1, 4).getUint32(0);
      const payload = buf.subarray(i + 5, i + 5 + len);
      i += 5 + len;
      if (flag & 0x80) trailers += new TextDecoder().decode(payload);
      else messages.push(payload);
    }
    const status = /grpc-status:\s*(\d+)/i.exec(trailers) ?? [null, res.headers.get('grpc-status') ?? '0'];
    if (status[1] !== '0') throw new Error(`${method}: grpc-status ${status[1]} ${trailers.trim()}`);
    return messages;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${method}: no answer within ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Several equivalent servers. A call that fails or stalls moves on to the next server, and that
 *  server is then used first for the rest of the run. `events` records every switch, for display. */
export class Servers {
  constructor(urls) {
    this.urls = urls.map((u) => u.replace(/\/$/, ''));
    this.active = 0;
    this.events = [];
  }

  get current() { return this.urls[this.active]; }

  async call(method, request, timeoutMs = 12000) {
    let lastError = null;
    for (let k = 0; k < this.urls.length; k++) {
      const idx = (this.active + k) % this.urls.length;
      try {
        const out = await grpcWeb(this.urls[idx], method, request, { timeoutMs });
        if (idx !== this.active) {
          this.events.push(`${hostOf(this.urls[this.active])} did not answer (${lastError?.message ?? 'no reply'}); switched to ${hostOf(this.urls[idx])}`);
          this.active = idx;
        }
        return out;
      } catch (e) { lastError = e; }
    }
    throw new Error(`None of the ${this.urls.length} servers answered in time (${lastError?.message ?? 'no reply'}).`);
  }
}

function hostOf(u) { try { return new URL(u).host; } catch { return u; } }

/**
 * bundle: { network, ufvk, start, end, rules, rules_id, ledger, challenges }
 * wasm: optional module bytes (Node); in a browser the .wasm is fetched next to the glue.
 */
export async function runRecount(endpoints, bundle, { wasm, log = () => {}, batch = 100, timeoutMs = 12000 } = {}) {
  await init(wasm ? { module_or_path: wasm } : undefined);
  const servers = new Servers(Array.isArray(endpoints) ? endpoints : [endpoints]);
  const t0 = performance.now();
  const rc = new Recount(bundle.network, bundle.ufvk);
  let blocksBytes = 0;
  for (let h = bundle.start; h <= bundle.end; h += batch) {
    const to = Math.min(h + batch - 1, bundle.end);
    const blocks = await servers.call('GetBlockRange', block_range_request(h, to), timeoutMs);
    for (const b of blocks) { blocksBytes += b.length; rc.scan_block(b); }
    log(`scanned ${h}..${to} (${blocks.length} blocks)`);
  }
  const t1 = performance.now();
  const txids = rc.txids_needing_memos();
  for (const txid of txids) {
    const [raw] = await servers.call('GetTransaction', tx_filter_request(txid), timeoutMs);
    rc.add_raw_transaction(raw);
  }
  const t2 = performance.now();
  const report = rc.report(JSON.stringify(bundle.rules), bundle.rules_id,
    JSON.stringify(bundle.ledger), JSON.stringify(bundle.challenges ?? []));
  const t3 = performance.now();
  return {
    report,
    events: servers.events,
    server: servers.current,
    stats: {
      blocks: rc.blocks_scanned(), actions: rc.actions_seen(), compact_bytes: blocksBytes,
      full_txs: txids.length, scan_ms: Math.round(t1 - t0), full_tx_ms: Math.round(t2 - t1),
      recount_ms: Math.round(t3 - t2), notes: JSON.parse(rc.notes_json()).length,
    },
  };
}

/**
 * Scans the same block range from up to `maxSources` public endpoints and compares what each showed.
 * input: { network, ufvk, start, rules, rules_id, ledger, challenges }
 * `endpoints` are tried in order: the first `maxSources` that answer are used; any further ones are spares that replace an
 * endpoint that does not answer. Returns { end, sources: [{endpoint, ok, error, report, stats}], agree }
 * where agree is true (identical), false (different) or null (fewer than two endpoints gave an answer).
 * Nothing here waits forever: every call has a timeout.
 */
export async function crossCheck(endpoints, input, { onStatus = () => {}, timeoutMs = 12000, batch = 100, maxSources = 3 } = {}) {
  await init();
  const urls = endpoints.map((u) => u.replace(/\/$/, ''));
  const failed = []; // { endpoint, error }
  const used = [];
  const tips = new Map();
  const tipOf1 = async (u) => {
    try {
      const [m] = await grpcWeb(u, 'GetLatestBlock', new Uint8Array(), { timeoutMs });
      return varint(m, 1);
    } catch (e) { failed.push({ endpoint: u, error: String(e.message || e) }); return null; }
  };
  // choose up to two endpoints that answer, replacing silent ones with spares
  let next = 0;
  while (used.length < maxSources && next < urls.length) {
    const batchUrls = urls.slice(next, next + (maxSources - used.length));
    next += batchUrls.length;
    onStatus(`Asking ${batchUrls.map(hostOf).join(' and ')} for the latest block…`);
    const heights = await Promise.all(batchUrls.map(tipOf1));
    batchUrls.forEach((u, i) => { if (heights[i] != null) { used.push(u); tips.set(u, heights[i]); } });
  }
  if (!used.length) throw new Error('None of the public servers answered in time. Nothing was concluded.');
  // the same range from all of them: end at the lowest of their heights
  const end = Math.min(...used.map((u) => tips.get(u)));
  const sources = await Promise.all(used.map(async (u) => {
    try {
      const rc = new Recount(input.network, input.ufvk);
      // a uniform-price auction also scans the treasury's public viewing key over the same blocks
      const trc = input.treasury_ufvk ? new Recount(input.network, input.treasury_ufvk) : null;
      const servers = new Servers([u]);
      let blocks = 0;
      for (let h = input.start; h <= end; h += batch) {
        const to = Math.min(h + batch - 1, end);
        const list = await servers.call('GetBlockRange', block_range_request(h, to), timeoutMs);
        for (const b of list) { rc.scan_block(b); if (trc) trc.scan_block(b); }
        blocks += list.length;
        onStatus(`${hostOf(u)}: scanned blocks up to ${to} of ${end}`);
      }
      const txids = rc.txids_needing_memos();
      for (const txid of txids) { const [raw] = await servers.call('GetTransaction', tx_filter_request(txid), timeoutMs); rc.add_raw_transaction(raw); }
      // transactions that spent campaign notes (tickets and settlements): fee, outputs, and what a winner's key can open
      for (const txid of rc.txids_spending_notes()) { if (txids.includes(txid)) continue; const [raw] = await servers.call('GetTransaction', tx_filter_request(txid), timeoutMs); rc.add_raw_transaction(raw); }
      const report = JSON.parse(rc.report_json(JSON.stringify(input.rules), input.rules_id, JSON.stringify(input.ledger), JSON.stringify(input.challenges ?? []), trc ? trc.notes_for_report() : ''));
      return { endpoint: u, ok: true, report, stats: { blocks: rc.blocks_scanned(), actions: rc.actions_seen(), full_txs: txids.length } };
    } catch (e) { return { endpoint: u, ok: false, error: String(e.message || e) }; }
  }));
  for (const f of failed) sources.push({ endpoint: f.endpoint, ok: false, error: f.error, unreachable: true });
  const good = sources.filter((s) => s.ok);
  let agree = null;
  if (good.length >= 2) agree = good.every((s) => JSON.stringify(s.report) === JSON.stringify(good[0].report));
  // agree === false means at least one server showed something different
  return { end, sources, agree };
}

function varint(bytes, field) {
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++], f = tag >> 3, t = tag & 7;
    if (t === 0) { let v = 0, s = 0, b; do { b = bytes[i++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); if (f === field) return v; }
    else if (t === 2) { let len = 0, s = 0, b; do { b = bytes[i++]; len += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); i += len; }
    else if (t === 1) i += 8; else if (t === 5) i += 4; else break;
  }
  return null;
}
