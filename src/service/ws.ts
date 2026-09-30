import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppClientMsg, AppServerMsg, ApplicationEventType, ApplicationView, ClientMsg, ServerMsg } from '../shared/messages.js';
import type { LoginSessionManager } from './accounts/login-sessions.js';
import type { ApplicationService } from './applications/service.js';
import { SESSION_COOKIE, looksLikeToken, parseCookies, sessionCookie } from './applications/session.js';
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
  apps: ApplicationService;
  settings: Settings;
  tl: Timeline;
}

/**
 * HTTP + two WebSocket endpoints:
 *
 *   /ws      developer channel (the /debug harness, e2e scripts): raw workflow protocol, pool status,
 *            timeline events. Workflows started here belong to the socket and end with it.
 *   /ws/app  applicant channel: authenticated by the session cookie, bound to ONE application.
 *            Receives only that application's view / progress / errors. Closing it never touches
 *            a workflow: the automation runs in the background and the applicant reconnects.
 *
 * Service messages are routed server-side: everything goes to developer sockets; messages that
 * carry a workflowId are also handed to the ApplicationService, which updates the owning
 * application and pushes the new view to that application's sockets only.
 */
export function startServer(deps: ServerDeps): Promise<void> {
  const { cfg, registry, apps, settings, tl } = deps;
  const server = createServer((req, res) => void handleHttp(req, res, deps));
  const devWss = new WebSocketServer({ noServer: true });
  const appWss = new WebSocketServer({ noServer: true });

  // ---- routing ----
  const devClients = new Set<WebSocket>();
  const appSockets = new Map<string, Set<WebSocket>>();
  const sendApp = (applicationId: string, m: AppServerMsg) => {
    const set = appSockets.get(applicationId);
    if (!set) return;
    const data = JSON.stringify(m);
    for (const s of set) if (s.readyState === WebSocket.OPEN) s.send(data);
  };
  const route = (m: ServerMsg) => {
    const data = JSON.stringify(m);
    for (const c of devClients) if (c.readyState === WebSocket.OPEN) c.send(data);
    if ('workflowId' in m && m.workflowId) apps.onWorkflowMessage(m.workflowId, m);
  };
  tl.onEvent(route);
  registry.setSender(route);
  apps.setNotifier((id: string, application: ApplicationView) => sendApp(id, { type: 'app.state', ts: Date.now(), application }));
  apps.setProgressNotifier((id: string, event: ApplicationEventType, step?: string) => sendApp(id, { type: 'app.progress', ts: Date.now(), event, step }));

  // ---- upgrade: pick the endpoint, authenticate applicants before the socket exists ----
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/ws') {
      devWss.handleUpgrade(req, socket, head, (ws) => devWss.emit('connection', ws, req));
      return;
    }
    if (path === '/ws/app') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const app = looksLikeToken(token) ? apps.authenticate(token) : undefined;
      if (!app) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      appWss.handleUpgrade(req, socket, head, (ws) => appWss.emit('connection', ws, req, app.id));
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  // ---- developer channel (unchanged protocol) ----
  const fields = Object.keys(cfg.fields);
  const writeOnlyFields = fields.filter((n) => cfg.fields[n].writeOnly);
  const deferredFields = fields.filter((n) => cfg.fields[n].syncMode === 'deferred');

  devWss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const clientIp = remoteIp(req);
    devClients.add(socket);
    socket.send(JSON.stringify({ type: 'hello', ts: Date.now(), debounceMs: cfg.debounceMs, fields, targetUrl: cfg.targetUrl, writeOnlyFields, deferredFields, pool: registry.poolStatus() } satisfies ServerMsg));
    tl.mark('debug client connected', clientIp);

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
    // Harness semantics: a workflow started from a developer socket ends with that socket.
    socket.on('close', () => { devClients.delete(socket); for (const id of own) registry.end(id, 'debug client disconnected'); });
  });

  // ---- applicant channel ----
  appWss.on('connection', (socket: WebSocket, req: IncomingMessage, applicationId: string) => {
    const clientIp = remoteIp(req);
    let set = appSockets.get(applicationId);
    if (!set) { set = new Set(); appSockets.set(applicationId, set); }
    set.add(socket);
    tl.mark('applicant connected', `application ${applicationId.slice(0, 8)}, ${set.size} socket(s)`);
    const reply = (r: AppServerMsg) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(r)); };
    const row = apps.get(applicationId);
    if (row) reply({ type: 'app.state', ts: Date.now(), application: apps.view(row) });

    socket.on('message', (raw) => {
      let m: AppClientMsg;
      try { m = JSON.parse(raw.toString()); } catch { reply({ type: 'app.error', ts: Date.now(), code: 'BAD_REQUEST', message: 'invalid JSON' }); return; }
      // Message bodies are never logged: app.verify carries the verification code.
      let r;
      switch (m?.type) {
        case 'app.update': r = apps.updateFields(applicationId, m.fields); break;
        case 'app.answers': r = apps.mergeAnswers(applicationId, m.answers); break;
        case 'app.step': r = apps.setStep(applicationId, m.step, m.completedStep); break;
        case 'app.address_completed': r = apps.addressCompleted(applicationId, clientIp); break;
        case 'app.verify': r = apps.provideVerification(applicationId, m.code, clientIp); break;
        case 'app.link_opened': r = apps.linkOpened(applicationId); break;
        case 'ping': reply({ type: 'pong', ts: Date.now(), echo: m.ts }); return;
        default: reply({ type: 'app.error', ts: Date.now(), code: 'BAD_REQUEST', message: 'unknown message type' }); return;
      }
      if (!r.ok) reply({ type: 'app.error', ts: Date.now(), code: r.code, message: r.message, missingFields: r.missingFields });
    });
    // Closing the applicant's socket never ends a workflow: the automation continues and the applicant resumes later.
    socket.on('close', () => {
      const s = appSockets.get(applicationId);
      if (s) { s.delete(socket); if (!s.size) appSockets.delete(applicationId); }
    });
  });

  return new Promise((res) => server.listen(settings.port, () => res()));
}

function remoteIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '').replace('::ffff:', '');
}

// ---------------------------------------------------------------------------
// HTTP: static pages, applicant session API, accounts API (metadata only, never cookies)
// ---------------------------------------------------------------------------

async function handleHttp(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';
  const json = (code: number, body: object, headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  try {
    if (url === '/' && method === 'GET') return serveStatic('/index.html', res);
    if (url === '/debug' && method === 'GET') return serveStatic('/debug.html', res);
    if (url === '/admin/accounts' && method === 'GET') return serveStatic('/admin.html', res);

    // ---- applicant session ----
    if (url === '/api/applications' && method === 'POST') {
      const { row, token } = deps.apps.create();
      return json(201, { application: deps.apps.view(row) }, { 'set-cookie': sessionCookie(token, { secure: deps.settings.secureCookies, maxAgeMs: deps.settings.sessionTtlMs }) });
    }
    if (url === '/api/applications/me' && method === 'GET') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const row = looksLikeToken(token) ? deps.apps.authenticate(token) : undefined;
      if (!row) return json(401, { error: 'UNAUTHENTICATED' });
      return json(200, { application: deps.apps.view(row) });
    }

    // ---- accounts (internal) ----
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
