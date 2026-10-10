// How hard is the payment QR to scan? Builds the QR for the real payment link and for shorter variants, then
// imitates a phone camera (shrink + blur) and asks a software decoder (jsQR) whether it can still read it.
// This is a proxy: real camera apps decode better than jsQR, but the ordering of the variants should hold.
const QR = require('../vectors/js/node_modules/qrcode');
const jsQR = require('../vectors/js/node_modules/jsqr');
const { PNG } = require('../vectors/js/node_modules/pngjs');
const fs = require('fs');

const real = JSON.parse(fs.readFileSync(process.argv[2]));
const uri = real.uri;
const [head, query] = uri.split('?');
const payTo = head.split(':')[1];
const memoParam = new URLSearchParams(query).get('memo');
const memoText = Buffer.from(memoParam, 'base64url').toString();
const b64u = (s) => Buffer.from(s).toString('base64url');
const fakeAddr = (len) => payTo.slice(0, 6) + 'q'.repeat(Math.max(0, len - 6)); // same-length stand-in for a shorter address

function link(addr, memo) { return `${head.split(':')[0]}:${addr}?amount=0.01&memo=${b64u(memo)}`; }
// memo = "LL1:" + base64url(sealed box); sealed = 48 + plaintext; plaintext = 1 + rules_id(32) + sign_pk(32) + enc_pk(32) + type(1) + receiver(43)
const memoWith = (plain) => 'LL1:' + Buffer.alloc(48 + plain, 0x5a).toString('base64url');
const variants = [
  ['A. as built now', uri],
  ['B. shorter payment address (Orchard-only, ~140 chars)', link(fakeAddr(140), memoText)],
  ['C. leaner message (drop the signing key, 109 bytes)', link(payTo, memoWith(109))],
  ['D. B + C together', link(fakeAddr(140), memoWith(109))],
  ['E. B + leaner still (also drop the campaign id, 77 bytes)', link(fakeAddr(140), memoWith(77))],
];

function renderRGBA(text, moduleSize) {
  const png = PNG.sync.read(QR.toBuffer ? Buffer.alloc(0) : Buffer.alloc(0)); // placeholder, replaced below
}

function qrPixels(text, px) { // grayscale float image of the QR with a 4-module quiet zone, `px` pixels per module
  const q = QR.create(text, { errorCorrectionLevel: 'L' });
  const n = q.modules.size, quiet = 4, side = (n + 2 * quiet) * px;
  const img = new Float32Array(side * side).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.modules.get(r, c))
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) img[((r + quiet) * px + y) * side + (c + quiet) * px + x] = 0;
  return { img, side, version: q.version, modules: n };
}
function boxResize(img, side, target) { // area-average downscale (what a camera sensor roughly does)
  const out = new Float32Array(target * target), s = side / target;
  for (let y = 0; y < target; y++) for (let x = 0; x < target; x++) {
    let sum = 0, cnt = 0;
    for (let yy = Math.floor(y * s); yy < Math.min(side, Math.ceil((y + 1) * s)); yy++)
      for (let xx = Math.floor(x * s); xx < Math.min(side, Math.ceil((x + 1) * s)); xx++) { sum += img[yy * side + xx]; cnt++; }
    out[y * target + x] = sum / cnt;
  }
  return out;
}
function blur(img, side, sigma) {
  if (sigma <= 0) return img;
  const r = Math.ceil(sigma * 2), k = []; let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  const tmp = new Float32Array(img.length), out = new Float32Array(img.length);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * img[y * side + Math.min(side - 1, Math.max(0, x + i))]; tmp[y * side + x] = s / ks; }
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(side - 1, Math.max(0, y + i)) * side + x]; out[y * side + x] = s / ks; }
  return out;
}
function decodes(img, side, expected) {
  const rgba = new Uint8ClampedArray(side * side * 4);
  for (let i = 0; i < side * side; i++) { const v = Math.max(0, Math.min(255, Math.round(img[i]))); rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
  const r = jsQR(rgba, side, side);
  return !!r && r.data === expected;
}

// what the page itself drew, decoded as-is
const shot = PNG.sync.read(fs.readFileSync(process.argv[3]));
const direct = jsQR(new Uint8ClampedArray(shot.data), shot.width, shot.height);
console.log(`The QR as the page draws it (phone-sized, ${shot.width}x${shot.height} px): ${direct && direct.data === uri ? 'DECODES, content identical to the payment link' : 'did NOT decode'}\n`);

console.log('Camera imitation: shrink so each QR dot is N pixels wide in the photo, plus a little blur (sigma 0.6 px).');
console.log('"easiest N" = the smallest dot size that still decodes (smaller is better: easier from far away or with a poor camera).\n');
const rows = [];
for (const [name, text] of variants) {
  const { version, modules } = qrPixels(text, 1);
  const results = [];
  for (const n of [1.6, 1.8, 2.0, 2.3, 2.6, 3.0, 3.5, 4.0, 5.0]) {
    const hi = qrPixels(text, 10), target = Math.round((modules + 8) * n);
    const small = boxResize(hi.img, hi.side, target);
    results.push([n, decodes(blur(small, target, 0.6), target, text)]);
  }
  const easiest = results.find(([, ok]) => ok);
  rows.push({ name, length: text.length, version, modules, easiest: easiest ? easiest[0] : '>5', dotOn300: (300 / (modules + 8)).toFixed(2) });
}
console.table(rows.map((r) => ({ variant: r.name, 'link chars': r.length, 'QR version': r.version, 'dots across': r.modules, 'dot size on a 300 px QR': r.dotOn300 + ' px', 'easiest N (px)': r.easiest })));
