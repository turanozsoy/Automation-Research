import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/messages.js';
import type { LoginSessionManager } from './accounts/login-sessions.js';
import type { SiteBConfig } from './config.js';
import type { ProfileStore } from './profiles/store.js';
import type { Settings } from './settings.js';
import type { Timeline } from './timeline.js';
import type { WorkflowRegistry } from './workflows.js';

const STATIC_DIR = resolve(process.cwd(), 'src/test-a');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export interface ServerDeps {
  cfg: SiteBConfig;
  registry: WorkflowRegistry;
  store: ProfileStore;
  logins: LoginSessionManager;
  settings: Settings;
  tl: Timeline;
}

/** Serves the test page, the accounts admin page + JSON API, and the workflow WebSocket. */
export function startServer(deps: ServerDeps): Promise<void> {
  const { cfg, registry, settings, tl } = deps;
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

  return new Promise((res) => server.listen(settings.port, () => res()));
}

// ---------------------------------------------------------------------------
// HTTP: static pages + accounts API (metadata only, never cookies)
// ---------------------------------------------------------------------------

async function handleHttp(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';
  const json = (code: number, body: object) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  try {
    if (url === '/admin/accounts' && method === 'GET') return serveStatic('/admin.html', res);

    if (url === '/api/accounts' && method === 'GET') return json(200, { accounts: deps.store.listAccounts(), logins: activeLogins(deps) });

    if (url === '/api/accounts' && method === 'POST') {
      const body = await readJson(req);
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim();
      if (!name || !email) return json(400, { error: 'name and email are required' });
      if (deps.store.byLabelOrId(email)) return json(409, { error: 'an account with this email already exists' });
      const row = deps.store.createAccount(name, email);
      deps.tl.mark('account created', `${name} (${email})`);
      return json(201, { id: row.id });
    }

    const m = /^\/api\/accounts\/([^/]+)(?:\/(login\/start|login\/done|login\/cancel|login\/status))?$/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      const account = deps.store.get(id);
      if (!account) return json(404, { error: 'account not found' });

      if (!action && method === 'DELETE') {
        await deps.logins.cancel(id);
        deps.store.remove(id);
        deps.tl.mark('account removed', account.label);
        return json(200, { ok: true });
      }
      if (action === 'login/start' && method === 'POST') return json(200, await deps.logins.start(id));
      if (action === 'login/status' && method === 'GET') return json(200, deps.logins.status(id));
      if (action === 'login/done' && method === 'POST') {
        const r = await deps.logins.done(id);
        return json(r.saved ? 200 : 409, r);
      }
      if (action === 'login/cancel' && method === 'POST') { await deps.logins.cancel(id); return json(200, { ok: true }); }
    }

    return serveStatic(url, res);
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
}

function activeLogins(deps: ServerDeps): Record<string, ReturnType<LoginSessionManager['status']>> {
  const out: Record<string, ReturnType<LoginSessionManager['status']>> = {};
  for (const a of deps.store.list()) {
    const s = deps.logins.status(a.id);
    if (s.open) out[a.id] = s;
  }
  return out;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
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
