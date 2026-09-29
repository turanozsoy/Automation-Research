import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/messages.js';
import type { BrowserManager } from './browser/manager.js';
import type { SiteBConfig } from './config.js';
import { importProfile, type ImportRequest } from './profiles/import.js';
import type { ProfileStore } from './profiles/store.js';
import type { Settings } from './settings.js';
import type { Timeline } from './timeline.js';
import type { WorkflowRegistry } from './workflows.js';

const STATIC_DIR = resolve(process.cwd(), 'src/test-a');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

export interface ServerDeps {
  cfg: SiteBConfig;
  registry: WorkflowRegistry;
  store: ProfileStore;
  browser: BrowserManager;
  settings: Settings;
  tl: Timeline;
}

/** Serves the test page, the import endpoint (browser extension), and the workflow WebSocket. */
export function startServer(deps: ServerDeps): Promise<void> {
  const { cfg, registry, store, browser, settings, tl } = deps;
  const server = createServer((req, res) => void handleHttp(req, res, deps));
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
    socket.on('close', () => { for (const id of own) registry.end(id, 'client disconnected'); });
  });

  void ({ store, browser, settings }); // used by handleHttp via deps
  return new Promise((res) => server.listen(settings.port, () => res()));
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = (req.url ?? '/').split('?')[0];

  // CORS so the browser extension (a different origin) can POST the session.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-import-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url === '/import' && req.method === 'POST') return handleImport(req, res, deps);
  if (url === '/import' && req.method === 'GET') { // extension health check + target info
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, targetUrl: deps.cfg.targetUrl, baseUrl: deps.cfg.baseUrl, tokenRequired: !!deps.settings.importToken }));
    return;
  }
  serveStatic(url, res);
}

async function handleImport(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const { store, browser, cfg, settings, tl } = deps;
  const send = (code: number, body: object) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  if (settings.importToken && req.headers['x-import-token'] !== settings.importToken) {
    return send(401, { ok: false, error: 'invalid or missing x-import-token' });
  }
  let body = '';
  let tooBig = false;
  req.on('data', (c) => { body += c; if (body.length > 8 * 1024 * 1024) { tooBig = true; req.destroy(); } });
  req.on('end', async () => {
    if (tooBig) return send(413, { ok: false, error: 'payload too large' });
    try {
      const parsed = JSON.parse(body) as ImportRequest;
      const result = await importProfile(parsed, store, browser, cfg);
      tl.mark('profile imported via extension', `${result.label}: ${result.action}, ${result.detail}`);
      send(200, { ok: true, ...result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tl.mark('profile import failed', msg);
      send(400, { ok: false, error: msg });
    }
  });
}

function serveStatic(path: string, res: ServerResponse): void {
  const rel = path === '/' ? '/index.html' : path;
  if (rel.includes('..')) { res.writeHead(400); res.end(); return; }
  try {
    const body = readFileSync(resolve(STATIC_DIR, `.${rel}`));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}
