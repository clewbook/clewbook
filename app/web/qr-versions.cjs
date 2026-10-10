// Prints the QR version and size for the real payment link and for lighter variants.
const QR = require('../vectors/js/node_modules/qrcode');
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const uri = d.uri; const [head, q] = uri.split('?'); const addr = head.slice(6);
const memo = q.match(/memo=([^&]*)/)[1];
const ver = (s, ec = 'L') => { const c = QR.create(s, { errorCorrectionLevel: ec }); return `v${c.version} (${c.modules.size}x${c.modules.size}) ${s.length} chars`; };
const cut = (n) => uri.replace(memo, memo.slice(0, memo.length - n));
const o = process.argv[3]; // orchard-only standard address
console.log('current (L):          ', ver(uri));
console.log('current (M):          ', ver(uri, 'M'));
if (o) console.log('Orchard-only address: ', ver(uri.replace(addr, o)));
console.log('drop signing key (-43 chars of memo): ', ver(cut(43)));
if (o) console.log('both:                 ', ver(cut(43).replace(addr, o)));
