// Seconds per block, measured from the block times of the last 100 blocks on a public server; no wasm needed, so the host's pages
// (which are served by the host program, not by the page server) can use it. Returns null if no server answers: no guessed constant.
const SERVICE = 'cash.z.wallet.sdk.rpc.CompactTxStreamer';

const varint = (n) => { const o = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return o; };
const field = (f, n) => [(f << 3) | 0, ...varint(n)];
const lenField = (f, bytes) => [(f << 3) | 2, ...varint(bytes.length), ...bytes];
function readVarint(bytes, wanted) {
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++], f = tag >> 3, t = tag & 7;
    if (t === 0) { let v = 0, s = 0, b; do { b = bytes[i++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); if (f === wanted) return v; }
    else if (t === 2) { let n = 0, s = 0, b; do { b = bytes[i++]; n += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); i += n; }
    else if (t === 1) i += 8; else if (t === 5) i += 4; else break;
  }
  return null;
}
async function call(base, method, request, timeoutMs = 12000) {
  const body = new Uint8Array(5 + request.length); new DataView(body.buffer).setUint32(1, request.length); body.set(request, 5);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/${SERVICE}/${method}`, { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' }, body, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer()), msgs = [];
    for (let i = 0; i < buf.length;) { const flag = buf[i], len = new DataView(buf.buffer, buf.byteOffset + i + 1, 4).getUint32(0); const p = buf.subarray(i + 5, i + 5 + len); i += 5 + len; if (!(flag & 0x80)) msgs.push(p); }
    return msgs;
  } finally { clearTimeout(timer); }
}

export const PUBLIC_SERVERS = {
  test: ['https://zjs.zec.rocks/testnet', 'https://zcash-testnet.chainsafe.dev'],
  main: ['https://zjs.zec.rocks/mainnet', 'https://zcash-mainnet.chainsafe.dev'],
};

/** { tip, secondsPerBlock } from the first server that answers; secondsPerBlock is null if the block times could not be read. */
export async function measureBlocks(network) {
  for (const s of PUBLIC_SERVERS[network === 'main' ? 'main' : 'test']) {
    try {
      const [m] = await call(s, 'GetLatestBlock', new Uint8Array());
      const tip = readVarint(m, 1);
      const timeOf = async (h) => { const id = lenField(1, field(1, h)); const range = new Uint8Array([...lenField(1, field(1, h)), ...lenField(2, field(1, h))]); const [b] = await call(s, 'GetBlockRange', range); return readVarint(b, 5); };
      const h0 = Math.max(1, tip - 100), t0 = await timeOf(h0), t1 = await timeOf(tip);
      return { tip, secondsPerBlock: t0 != null && t1 != null && t1 > t0 && tip - h0 >= 20 ? (t1 - t0) / (tip - h0) : null, spanBlocks: tip - h0, server: s };
    } catch { /* next server */ }
  }
  return { tip: null, secondsPerBlock: null, spanBlocks: 0, server: null };
}
