import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppClientMsg, AppServerMsg, ApplicationEventType, ApplicationView, ClientMsg, ServerMsg } from '../shared/messages.js';
import type { LoginSessionManager } from './accounts/login-sessions.js';
import type { ApplicationService } from './applications/service.js';
import type { BrowserModeControl } from './dev/browser-mode.js';
import type { EgressHealth } from './egress/health.js';
import { parseProxyLine } from './egress/store.js';
import { SESSION_COOKIE, looksLikeToken, parseCookies, sessionCookie } from './applications/session.js';
import type { SiteBConfig } from './config.js';
import type { ProfileStore } from './profiles/store.js';
import type { Settings } from './settings.js';
import type { Timeline } from './timeline.js';
import type { WorkflowRegistry } from './workflows.js';

const INTERNAL_DIR = resolve(process.cwd(), 'src/test-a');   // /debug harness + /admin/accounts (internal pages)
const APPLY_DIR = resolve(process.cwd(), 'src/apply');       // the public Shipzora application
const APPLY_CONFIG = resolve(process.cwd(), process.env.APPLY_CONFIG ?? 'config/apply-questions.json');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

/** Explicit routes only: nothing under src/ is reachable by guessing a file name. */
const PAGES: Record<string, [string, string]> = {
  '/': [APPLY_DIR, 'index.html'],
  '/debug': [INTERNAL_DIR, 'debug.html'],
  '/debug.js': [INTERNAL_DIR, 'debug.js'],
  '/admin/accounts': [INTERNAL_DIR, 'admin.html'],
  '/admin.js': [INTERNAL_DIR, 'admin.js'],
  '/admin.css': [INTERNAL_DIR, 'admin.css'],
};
const PLACEHOLDER_PAGES: Record<string, string> = { '/privacy': 'Privacy', '/terms': 'Terms', '/contact': 'Contact' };

export interface ServerDeps {
  cfg: SiteBConfig;
  registry: WorkflowRegistry;
  store: ProfileStore;
  logins: LoginSessionManager;
  apps: ApplicationService;
  browserMode: BrowserModeControl;
  egressHealth: EgressHealth;
  settings: Settings;
  tl: Timeline;
  /** Set by startServer: nudge the operations page. */
  notifyAdmin?: (what: 'verified' | 'accounts' | 'egress') => void;
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
  const adminWss = new WebSocketServer({ noServer: true });

  // ---- routing ----
  const devClients = new Set<WebSocket>();
  const adminClients = new Set<WebSocket>();
  // Internal operations page: a data-free nudge; the page re-fetches what changed over the admin API.
  const notifyAdmin = (what: 'verified' | 'accounts' | 'egress') => {
    const data = JSON.stringify({ type: 'admin.changed', what, ts: Date.now() });
    for (const c of adminClients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };
  apps.setAdminNotifier(notifyAdmin);
  deps.notifyAdmin = notifyAdmin;
  deps.egressHealth.setOnChange(() => notifyAdmin('egress'));
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
    if ('workflowId' in m && m.workflowId) {
      // Development artifacts: what the page looked like when a step failed (before the context is closed).
      if (m.type === 'paused') deps.registry.captureFailure(m.workflowId, m.step, m.code, m.message);
      else if (m.type === 'error' && m.fatal) deps.registry.captureFailure(m.workflowId, 'fatal', m.code, m.message);
      apps.onWorkflowMessage(m.workflowId, m);
    }
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
    if (path === '/ws/admin') {
      adminWss.handleUpgrade(req, socket, head, (ws) => adminWss.emit('connection', ws, req));
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

  // ---- internal operations page channel (nudges only) ----
  adminWss.on('connection', (socket: WebSocket) => {
    adminClients.add(socket);
    socket.on('message', () => { /* nothing to receive */ });
    socket.on('close', () => adminClients.delete(socket));
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
        case 'app.step': r = apps.setStep(applicationId, m.step, m.completedStep, m.final); break;
        case 'app.validation_failed': r = apps.validationFailed(applicationId, m.step, m.fields); break;
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
    if (method === 'GET' && PAGES[url]) return serveFile(PAGES[url][0], PAGES[url][1], res);
    if (method === 'GET' && url.startsWith('/apply/')) return serveFile(APPLY_DIR, url.slice('/apply/'.length), res);
    if (method === 'GET' && PLACEHOLDER_PAGES[url]) return placeholderPage(PLACEHOLDER_PAGES[url], res);
    // ---- development: automation browser mode (internal, /debug) ----
    if (url === '/api/dev/browser' && method === 'GET') return json(200, deps.browserMode.status());
    if (url === '/api/dev/browser' && method === 'POST') {
      const body = await readJson(req);
      try { return json(200, await deps.browserMode.request(body.mode as never)); } catch (e) { return json(400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (method === 'GET' && url === '/api/apply/config') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(readFileSync(APPLY_CONFIG)); return; }

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

    // ---- operations page (internal) ----
    if (url === '/api/accounts' && method === 'GET') return json(200, { accounts: deps.store.listAccounts(), logins: activeLogins(deps) });

    // ---- egress (proxies): metadata only, never credentials ----
    if (url === '/api/admin/egress' && method === 'GET') return json(200, { egress: deps.store.egress.list(), counts: deps.store.egress.counts(), directAllowed: !deps.registry.isPerContextProxy() });
    if (url === '/api/admin/egress' && method === 'POST') {
      const body = await readJson(req);
      const text = typeof body.lines === 'string' ? body.lines : typeof body.line === 'string' ? body.line : '';
      if (!text.trim()) return json(400, { error: 'nothing to import' });
      if (text.length > 200_000) return json(413, { error: 'too much input' });
      const r = deps.store.egress.importLines(text);
      deps.tl.mark('egress import', `${r.added} added / ${r.duplicates} duplicates / ${r.invalid.length} invalid`);
      if (r.added) { deps.notifyAdmin?.('egress'); void deps.egressHealth.checkAll(); }
      return json(200, r);
    }
    if (url === '/api/admin/egress/validate' && method === 'POST') {
      const body = await readJson(req);
      const r = parseProxyLine(String(body.line ?? ''));
      return json(200, r.ok ? { ok: true, host: r.proxy.host, port: r.proxy.port, kind: r.proxy.kind, hasAuth: r.proxy.username !== undefined } : { ok: false, reason: r.reason });
    }
    const eg = /^\/api\/admin\/egress\/([^/]+)(?:\/(release|retire|check))?$/.exec(url);
    if (eg) {
      const id = decodeURIComponent(eg[1]);
      const action = eg[2];
      if (!deps.store.egress.get(id)) return json(404, { error: 'egress not found' });
      try {
        if (!action && method === 'DELETE') { deps.store.egress.remove(id); deps.tl.mark('egress removed', id.slice(0, 8)); deps.notifyAdmin?.('egress'); return json(200, { ok: true }); }
        if (action === 'release' && method === 'POST') { const m = deps.store.egress.release(id); deps.tl.mark('egress released', m.label); deps.notifyAdmin?.('egress'); void deps.registry.kick(); return json(200, m); }
        if (action === 'retire' && method === 'POST') { const m = deps.store.egress.retire(id); deps.tl.mark('egress retired', m.label); deps.notifyAdmin?.('egress'); return json(200, m); }
        if (action === 'check' && method === 'POST') { const r = await deps.egressHealth.check(id); deps.notifyAdmin?.('egress'); return json(200, { ...r, egress: deps.store.egress.meta(deps.store.egress.get(id)!) }); }
      } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (url === '/api/admin/applications/verified' && method === 'GET') {
      const qs = new URL(req.url ?? '/', 'http://x').searchParams;
      const limit = Math.min(100, Math.max(1, Number(qs.get('limit') ?? 25) || 25));
      const offset = Math.max(0, Number(qs.get('offset') ?? 0) || 0);
      return json(200, deps.apps.verifiedList(qs.get('q') ?? '', offset, limit));
    }

    if (url === '/api/accounts' && method === 'POST') {
      const body = await readJson(req);
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim();
      if (!name || !email) return json(400, { error: 'name and email are required' });
      if (deps.store.byLabelOrId(email)) return json(409, { error: 'an account with this email already exists' });
      const row = deps.store.createAccount(name, email);
      deps.tl.mark('account created', `${name} (${email})`);
      deps.notifyAdmin?.('accounts');
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
        deps.notifyAdmin?.('accounts');
        return json(200, { ok: true });
      }
      if (action === 'login/start' && method === 'POST') return json(200, await deps.logins.start(id));
      if (action === 'login/status' && method === 'GET') return json(200, deps.logins.status(id));
      if (action === 'login/done' && method === 'POST') {
        const r = await deps.logins.done(id);
        if (r.saved) deps.notifyAdmin?.('accounts');
        return json(r.saved ? 200 : 409, r);
      }
      if (action === 'login/cancel' && method === 'POST') { await deps.logins.cancel(id); return json(200, { ok: true }); }
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
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

function serveFile(dir: string, rel: string, res: ServerResponse): void {
  if (rel.includes('..') || rel.includes('\\') || rel === '') { res.writeHead(404); res.end('not found'); return; }
  try {
    const body = readFileSync(resolve(dir, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

/** Footer links exist in the UI before the pages do; say so plainly instead of inventing policy text. */
function placeholderPage(title: string, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Shipzora Careers</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;margin:0;background:#f3f4f1;color:#1b1f24}main{max-width:560px;margin:0 auto;padding:48px 20px}a{color:#084b46}</style></head>
<body><main><h1>${title}</h1><p>This page isn\u2019t available yet.</p><p><a href="/">Back to your application</a></p></main></body></html>`);
}
