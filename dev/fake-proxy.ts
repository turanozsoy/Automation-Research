/**
 * Tiny HTTP forward proxy for development and tests (CONNECT tunnels + plain HTTP), with
 * optional Proxy-Authorization (basic), a control port for stats and a "down" switch.
 *   npx tsx dev/fake-proxy.ts --port 3100 --control 3900 --auth user1:pass1
 * Control: GET /stats -> { tunnels, active, maxActive, authFailures, down }
 *          POST /down | POST /up  -> refuse / accept new connections
 * Test-only: no TLS termination, no logging of request bodies or credentials.
 */
import { createServer as createHttp, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';

const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const port = Number(arg('port', '3100'));
const control = Number(arg('control', String(port + 800)));
const auth = arg('auth', '');
const expected = auth ? 'Basic ' + Buffer.from(auth).toString('base64') : null;
const stats = { tunnels: 0, requests: 0, active: 0, maxActive: 0, authFailures: 0, down: false };

function authorized(req: IncomingMessage): boolean {
  if (!expected) return true;
  if (req.headers['proxy-authorization'] === expected) return true;
  stats.authFailures++;
  return false;
}
const track = (s: { once: (ev: 'close', fn: () => void) => unknown }) => { stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active); s.once('close', () => { stats.active--; }); };

const proxy = createHttp((req, res) => {
  // plain http://host/path through the proxy
  if (stats.down) { res.writeHead(503); res.end(); return; }
  if (!authorized(req)) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fake-proxy"' }); res.end(); return; }
  stats.requests++;
  let u: URL;
  try { u = new URL(req.url ?? ''); } catch { res.writeHead(400); res.end(); return; }
  const headers = { ...req.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
  const out = httpRequest({ host: u.hostname, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  out.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(out);
});
proxy.on('connect', (req, socket, head) => {
  if (stats.down) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
  if (!authorized(req)) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fake-proxy"\r\n\r\n'); return; }
  const [host, p] = (req.url ?? '').split(':');
  const target = connect(Number(p || 443), host, () => {
    stats.tunnels++; track(socket);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) target.write(head);
    socket.pipe(target); target.pipe(socket);
  });
  target.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  socket.on('error', () => target.destroy());
});
proxy.listen(port, () => console.log(`[fake-proxy] proxy on ${port}${auth ? ' (auth)' : ''}, control on ${control}`));

createHttp((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(stats)); return; }
  if (req.url === '/down' && req.method === 'POST') { stats.down = true; res.end('down'); return; }
  if (req.url === '/up' && req.method === 'POST') { stats.down = false; res.end('up'); return; }
  res.writeHead(404); res.end();
}).listen(control);
