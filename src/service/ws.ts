import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/messages.js';
import type { SiteBConfig } from './config.js';
import type { Timeline } from './timeline.js';
import type { WorkflowRegistry } from './workflows.js';

const STATIC_DIR = resolve(process.cwd(), 'src/test-a');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** Serves the local test page and hosts the WebSocket; routes every workflow message by workflowId. */
export function startServer(port: number, cfg: SiteBConfig, registry: WorkflowRegistry, tl: Timeline): Promise<void> {
  const server = createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (m: ServerMsg) => {
    const data = JSON.stringify(m);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };
  tl.onEvent(broadcast);
  registry.setSender(broadcast);

  const fields = Object.keys(cfg.fields);
  const writeOnlyFields = fields.filter((n) => cfg.fields[n].writeOnly);
  const deferredFields = fields.filter((n) => cfg.fields[n].syncMode === 'deferred');

  wss.on('connection', (socket, req) => {
    const clientIp = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
    socket.send(JSON.stringify({ type: 'hello', ts: Date.now(), debounceMs: cfg.debounceMs, fields, targetUrl: cfg.targetUrl, writeOnlyFields, deferredFields, pool: registry.poolStatus() } satisfies ServerMsg));
    tl.mark('client connected', clientIp);

    const own = new Set<string>();
    socket.on('message', (raw) => {
      let m: ClientMsg;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      const reply = (r: ServerMsg) => socket.send(JSON.stringify(r));
      switch (m.type) {
        case 'workflow.start': {
          const { workflowId, queuePosition } = registry.startWorkflow(m.clientIp ?? clientIp);
          own.add(workflowId);
          reply({ type: 'workflow.accepted', ts: Date.now(), workflowId, queuePosition });
          break;
        }
        case 'field.update': case 'submit': case 'resume': case 'workflow.end': case 'link.opened': {
          const wf = registry.get(m.workflowId);
          if (m.type === 'workflow.end') { registry.end(m.workflowId, m.reason ?? 'client ended the workflow'); own.delete(m.workflowId); break; }
          if (m.type === 'field.update') {
            if (registry.handleFieldUpdate(m) === 'unknown') reply({ type: 'error', ts: Date.now(), workflowId: m.workflowId, code: 'UNKNOWN_WORKFLOW', message: 'No workflow with this id (ended or unknown)', fatal: false });
            break;
          }
          if (!wf) {
            const known = registry.isKnown(m.workflowId);
            reply({ type: 'error', ts: Date.now(), workflowId: m.workflowId, code: known ? 'INVALID_STATE' : 'UNKNOWN_WORKFLOW', message: known ? 'Workflow is not ready yet' : 'No workflow with this id (ended or unknown)', fatal: false });
            break;
          }
          if (m.type === 'submit') void wf.submit(m.snapshot, m.ts);
          else if (m.type === 'link.opened') wf.linkOpened();
          else void wf.resume(m.mode);
          break;
        }
        case 'ping': reply({ type: 'pong', ts: Date.now(), echo: m.ts }); break;
      }
    });
    // A client that disconnects abandons the workflows it started (after their own idle grace inside the registry).
    socket.on('close', () => { for (const id of own) registry.end(id, 'client disconnected'); });
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
