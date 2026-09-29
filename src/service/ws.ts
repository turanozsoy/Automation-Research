import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/messages.js';
import type { SiteBConfig } from './config.js';
import type { Timeline } from './timeline.js';
import type { Workflow } from './workflow.js';

const STATIC_DIR = resolve(process.cwd(), 'src/test-a');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** Serves the local test page and hosts the WebSocket the page talks to. */
export function startServer(port: number, cfg: SiteBConfig, wf: Workflow, tl: Timeline): Promise<void> {
  const server = createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Keep recent events so a page that connects late still sees the boot timeline.
  const history: ServerMsg[] = [];
  const remember = (m: ServerMsg) => {
    history.push(m);
    if (history.length > 300) history.shift();
  };

  const broadcast = (m: ServerMsg) => {
    remember(m);
    const data = JSON.stringify(m);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };

  tl.onEvent(broadcast);
  wf.setSender(broadcast);

  wss.on('connection', (socket) => {
    // hello first, then the replayed history, and only then the "connected" mark (so it is not delivered twice).
    socket.send(JSON.stringify({ type: 'hello', ts: Date.now(), state: wf.state, debounceMs: cfg.debounceMs, fields: wf.fieldNames(), targetUrl: cfg.targetUrl } satisfies ServerMsg));
    for (const m of history) socket.send(JSON.stringify(m));
    tl.mark('test page connected');

    socket.on('message', (raw) => {
      let m: ClientMsg;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (m.type) {
        case 'start': void wf.start(); break;
        case 'field.update': wf.handleFieldUpdate(m); break;
        case 'submit': void wf.submit(m.snapshot, m.ts); break;
        case 'reset': void wf.reset(); break;
        case 'ping': socket.send(JSON.stringify({ type: 'pong', ts: Date.now(), echo: m.ts } satisfies ServerMsg)); break;
      }
    });
  });

  return new Promise((res) => server.listen(port, () => res()));
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url === '/' || req.url === undefined ? '/index.html' : req.url.split('?')[0];
  if (path.includes('..')) { res.writeHead(400); res.end(); return; }
  try {
    const body = readFileSync(resolve(STATIC_DIR, `.${path}`));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}
