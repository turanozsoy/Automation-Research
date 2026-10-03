/**
 * Tiny HTTP forward proxy for development and tests (CONNECT tunnels + plain HTTP), with
 * optional Proxy-Authorization (basic), a control port for stats and a "down" switch.
 *   npx tsx dev/fake-proxy.ts --port 3100 --control 3900 --auth user1:pass1
 * Control: GET /stats -> { tunnels, requests, active, maxActive, authFailures, down, hosts (last 50 hostnames asked for) }
 * Forwarded plain-HTTP requests carry `x-fake-proxy-port` so a local echo server can tell which proxy they came through.
 *          POST /down | POST /up  -> refuse / accept new connections
 * Test-only: no TLS termination, no logging of request bodies or credentials.
 */
import { createServer as createHttp, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';

const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const port = Number(arg('port', '3100'));
const control = Number(arg('control', String(port + 800)));
const auth = arg('auth', '');
const delay = Number(arg('delay', '0')); // ms added before every forwarded request / tunnel: simulates a slow proxy
const expected = auth ? 'Basic ' + Buffer.from(auth).toString('base64') : null;
const stats = { tunnels: 0, requests: 0, active: 0, maxActive: 0, authFailures: 0, down: false, hosts: [] as string[] };
/** Hostnames the proxy was asked to reach (absolute-URI requests and CONNECT targets): shows that the browser sent the NAME, not an address. */
const sawHost = (h: string) => { stats.hosts.push(h); if (stats.hosts.length > 50) stats.hosts.shift(); };

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
  sawHost(u.hostname);
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, 'x-fake-proxy-port': String(port) }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
  const forward = () => {
    const out = httpRequest({ host: u.hostname, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    out.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(out);
  };
  if (delay > 0) setTimeout(forward, delay); else forward();
});
proxy.on('connect', (req, socket, head) => {
  if (stats.down) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
  if (!authorized(req)) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fake-proxy"\r\n\r\n'); return; }
  const [host, p] = (req.url ?? '').split(':');
  sawHost(host);
  const target = connect(Number(p || 443), host, () => { setTimeout(established, delay); });
  const established = () => {
    stats.tunnels++; track(socket);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) target.write(head);
    socket.pipe(target); target.pipe(socket);
  };
  target.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  socket.on('error', () => target.destroy());
});
proxy.listen(port, () => console.log(`[fake-proxy] proxy on ${port}${auth ? ' (auth)' : ''}${delay ? `, ${delay} ms delay` : ''}, control on ${control}`));

createHttp((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(stats)); return; }
  if (req.url === '/down' && req.method === 'POST') { stats.down = true; res.end('down'); return; }
  if (req.url === '/up' && req.method === 'POST') { stats.down = false; res.end('up'); return; }
  res.writeHead(404); res.end();
}).listen(control);
