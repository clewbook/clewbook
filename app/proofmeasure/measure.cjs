// Level 3 measurement (not integrated): time and size of checking a ticket's proof in the browser.
const { chromium } = require('../vectors/js/node_modules/playwright');
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const root = __dirname;
const srv = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(f).pipe(res);
}).listen(8793, '127.0.0.1');
const tickets = ['../ticketcheck/src/testdata/ticket-v1.json', '../ticketcheck/src/testdata/ticket-v2.json'].map((p) => JSON.parse(fs.readFileSync(path.join(root, p))).raw_hex);
(async () => {
  const wasm = fs.readFileSync(path.join(root, 'out/ll_proofmeasure_bg.wasm'));
  const page_wasm = fs.readFileSync(path.join(root, '../web/www/pkg/ll_web_bg.wasm'));
  console.log(JSON.stringify({ sizes_bytes: {
    proof_module_raw: wasm.length, proof_module_gzip: zlib.gzipSync(wasm, { level: 9 }).length, proof_module_brotli: zlib.brotliCompressSync(wasm).length,
    current_page_module_raw: page_wasm.length, current_page_module_gzip: zlib.gzipSync(page_wasm, { level: 9 }).length, current_page_module_brotli: zlib.brotliCompressSync(page_wasm).length } }));
  for (const rate of (process.env.RATES || "1,4").split(",").map(Number)) {
    const b = await chromium.launch();
    const page = await b.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.goto('http://127.0.0.1:8793/measure.html');
    const r = await page.evaluate((t) => window.run(t), tickets);
    console.log(JSON.stringify({ cpu_slowdown: rate, ...r }));
    await b.close();
  }
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
