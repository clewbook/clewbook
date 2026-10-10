// A small local static server that applies the "headers" rules of the folder's vercel.json the way Vercel does for plain static files (every
// matching rule applies, in order; a later rule wins for the same header). It is for testing the headers on this machine; it is not Vercel, and
// what Vercel really sends is checked after a deploy (see docs/DEPLOY_VERCEL.md). Usage: node app/web/serve-vercel.cjs <folder> [port]
const http = require('http'), fs = require('fs'), path = require('path');
const dir = path.resolve(process.argv[2] || 'runs/vercel-site'), port = Number(process.argv[3] || 8805);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'vercel.json'), 'utf8'));
const esc = (s) => s.replace(/[.+?^${}|[\]\\]/g, '\\$&');
// A source pattern as Vercel reads it, for the forms vercel.json uses: ":name" (one segment), ":name*" (the rest of the path), ":name(regex)", "(.*)", literals.
function pattern(source) {
  const names = [];
  let re = '', i = 0;
  while (i < source.length) {
    const m = /^:([A-Za-z]+)(\*|\(([^)]*)\))?/.exec(source.slice(i));
    if (m) {
      names.push(m[1]);
      re += m[2] === '*' ? '(.*)' : m[3] !== undefined ? `(${m[3]})` : '([^/]+)';
      i += m[0].length;
    } else if (source.startsWith('(.*)', i)) { re += '(.*)'; i += 4; }
    else { re += esc(source[i]); i++; }
  }
  return { re: new RegExp(`^${re}$`), names };
}
const fill = (dest, names, m) => names.reduce((d, n, i) => d.split(`:${n}`).join(m[i + 1]), dest);
const rules = (cfg.headers || []).map((h) => ({ re: pattern(h.source).re, headers: h.headers }));
const redirects = (cfg.redirects || []).map((r) => ({ ...pattern(r.source), dest: r.destination, status: r.statusCode || (r.permanent ? 308 : 307) }));
const rewrites = (cfg.rewrites || []).map((r) => ({ ...pattern(r.source), dest: r.destination }));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  for (const r of redirects) { const m = r.re.exec(p); if (m) { res.writeHead(r.status, { location: fill(r.dest, r.names, m) }); return res.end(); } }
  for (const r of rewrites) { const m = r.re.exec(p); if (m) { p = fill(r.dest, r.names, m); break; } }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(dir, p);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' };
  for (const r of rules) if (r.re.test(p)) for (const h of r.headers) headers[h.key.toLowerCase()] = h.value;
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${dir} on http://127.0.0.1:${port}`));
