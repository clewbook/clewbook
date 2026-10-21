// TEST ONLY: lets a browser page read a private chain. Pages speak gRPC-web over HTTP/1.1; zebrad's light wallet service speaks plain gRPC
// over HTTP/2 on this machine. This bridge passes each request through unchanged (both use the same length-prefixed messages) and turns
// the gRPC trailers into a gRPC-web trailer frame. Node's own http and http2 modules only. Usage: node grpc-web-bridge.cjs <listen port> <grpc url>
const http = require('http'), http2 = require('http2');

function start(port, target) {
  const session = () => {
    if (!start.s || start.s.closed || start.s.destroyed) start.s = http2.connect(target);
    return start.s;
  };
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-grpc-web,x-user-agent', 'access-control-expose-headers': 'grpc-status,grpc-message' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const s = session().request({ ':method': 'POST', ':path': req.url, 'content-type': 'application/grpc', te: 'trailers' });
      const out = [];
      let status = '0', message = '';
      s.on('response', (h) => { if (h['grpc-status'] != null) { status = String(h['grpc-status']); message = h['grpc-message'] || ''; } });
      s.on('trailers', (t) => { status = String(t['grpc-status'] ?? status); message = t['grpc-message'] || message; });
      s.on('data', (d) => out.push(d));
      s.on('end', () => {
        const t = Buffer.from(`grpc-status:${status}\r\ngrpc-message:${message}\r\n`), th = Buffer.alloc(5);
        th[0] = 0x80; th.writeUInt32BE(t.length, 1);
        res.writeHead(200, { ...cors, 'content-type': 'application/grpc-web+proto' });
        res.end(Buffer.concat([...out, th, t]));
      });
      s.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, cors); res.end(String(e)); } });
      s.end(Buffer.concat(chunks));
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

if (require.main === module) start(Number(process.argv[2]), process.argv[3]);
module.exports = { start };
