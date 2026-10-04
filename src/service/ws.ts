import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ApplicantContent } from './applications/content.js';
import type { AccountMeta } from './profiles/store.js';
import type { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppClientMsg, AppServerMsg, ApplicationEventType, ApplicationView, ClientMsg, ServerMsg } from '../shared/messages.js';
import type { LoginSessionManager } from './accounts/login-sessions.js';
import type { ApplicationService } from './applications/service.js';
import type { BrowserModeControl } from './dev/browser-mode.js';
import type { NetworkDiagnostics } from './dev/network-diagnostics.js';
import type { EgressHealth } from './egress/health.js';
import { parseProxyLine } from './egress/store.js';
import { SESSION_COOKIE, looksLikeToken, parseCookies, sessionCookie } from './applications/session.js';
import { AdminAuth, loginPage } from './admin-auth.js';
import type { SiteBConfig } from './config.js';
import type { ProfileStore } from './profiles/store.js';
import type { Settings } from './settings.js';
import type { Timeline } from './timeline.js';
import type { WorkflowRegistry } from './workflows.js';

const INTERNAL_DIR = resolve(process.cwd(), 'src/test-a');   // /debug harness + /admin/accounts (internal pages)
const APPLY_DIR = resolve(process.cwd(), 'src/apply');       // the public application
const ICONS_DIR = resolve(APPLY_DIR, 'icons');               // favicon + app icons (drop the generated files here)
/** Icon files served at the root (browsers request these paths on their own). Missing files answer 404. */
const ICON_FILES = new Set(['favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png', 'android-chrome-192x192.png', 'android-chrome-512x512.png', 'site.webmanifest']);
export const APPLY_CONFIG_PATH = resolve(process.cwd(), process.env.APPLY_CONFIG ?? 'config/apply-questions.json');
const APPLY_CONFIG = APPLY_CONFIG_PATH;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/** Explicit routes only: nothing under src/ is reachable by guessing a file name. */
const PAGES: Record<string, [string, string]> = {
  '/': [APPLY_DIR, 'index.html'],
  '/debug': [INTERNAL_DIR, 'debug.html'],
  '/debug.js': [INTERNAL_DIR, 'debug.js'],
  '/admin/accounts': [INTERNAL_DIR, 'admin.html'],
  '/admin.js': [INTERNAL_DIR, 'admin.js'],
  '/admin.css': [INTERNAL_DIR, 'admin.css'],
};
/** Public legal pages: rendered from the editable applicant content (legal.<slug>.*). */
const LEGAL_PAGES: Record<string, 'privacy' | 'terms' | 'contact'> = { '/privacy': 'privacy', '/terms': 'terms', '/contact': 'contact' };
const APPLY_ROUTES = /^\/(step-\d{1,2}|preparing|completed)$/;

export interface ServerDeps {
  cfg: SiteBConfig;
  registry: WorkflowRegistry;
  store: ProfileStore;
  logins: LoginSessionManager;
  apps: ApplicationService;
  browserMode: BrowserModeControl;
  /** Development: per-account proxy/DNS path diagnostics (internal, operator login). */
  diagnostics: NetworkDiagnostics;
  egressHealth: EgressHealth;
  settings: Settings;
  tl: Timeline;
  /** Applicant-facing copy (defaults in code, overrides edited on the operations page). */
  content: ApplicantContent;
  /** Operator login for the internal surfaces. */
  auth: AdminAuth;
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
    // the pool changed (an account was reserved, released, held for review or taken): the operations page re-fetches
    if (m.type === 'pool.status') notifyAdmin('accounts');
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
  apps.setPresence((id: string) => [...(appSockets.get(id) ?? [])].filter((s) => s.readyState === WebSocket.OPEN).length);
  apps.setProgressNotifier((id: string, event: ApplicationEventType, step?: string) => sendApp(id, { type: 'app.progress', ts: Date.now(), event, step }));

  // ---- upgrade: pick the endpoint, authenticate applicants before the socket exists ----
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    // the developer and operations channels are internal: operator session required (or loopback when no password is set)
    if (AdminAuth.isProtectedPath(path) && deps.auth.authorize(req) !== 'ok') {
      socket.write(`HTTP/1.1 ${deps.auth.enabled ? '401 Unauthorized' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`); socket.destroy(); return;
    }
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
        case 'app.wait': r = apps.waitEvent(applicationId, m.event, m.elapsedMs); break;
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

  // Bind to one interface (SERVICE_HOST, default loopback): production puts the dashboard behind a VPN / private network
  // and a TLS reverse proxy, never on 0.0.0.0.
  return new Promise((res) => server.listen(settings.port, settings.host, () => res()));
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
    // ---- operator login (the only internal endpoints reachable without a session) ----
    if (url === '/admin/login' && method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (!deps.auth.enabled) { res.writeHead(302, { location: q.get('next') || '/admin/accounts' }); res.end(); return; }
      if (deps.auth.loggedIn(req)) { res.writeHead(302, { location: safeNext(q.get('next')) }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(loginPage(safeNext(q.get('next')), q.get('error') === '1' ? 'That password is not right.' : q.get('error') === '2' ? 'Too many attempts. Wait a minute and try again.' : undefined, deps.content.brandName()));
      return;
    }
    if (url === '/api/admin/login' && method === 'POST') {
      const body = await readBody(req);
      const isForm = /application\/x-www-form-urlencoded/.test(req.headers['content-type'] ?? '');
      const fields = isForm ? Object.fromEntries(new URLSearchParams(body)) : (JSON.parse(body || '{}') as Record<string, unknown>);
      const r = deps.auth.login(fields.password, deps.auth.clientIp(req));
      if (r.ok) {
        if (isForm) { res.writeHead(303, { location: safeNext(String(fields.next ?? '')), 'set-cookie': r.cookie }); res.end(); return; }
        return json(200, { ok: true }, { 'set-cookie': r.cookie });
      }
      deps.tl.mark('operator login failed', `${deps.auth.clientIp(req)}${r.retryAfterMs ? ` (locked ${Math.ceil(r.retryAfterMs / 1000)} s)` : ''}`);
      if (isForm) { res.writeHead(303, { location: `/admin/login?next=${encodeURIComponent(safeNext(String(fields.next ?? '')))}&error=${r.retryAfterMs ? 2 : 1}` }); res.end(); return; }
      return json(r.retryAfterMs ? 429 : 401, { error: r.retryAfterMs ? 'TOO_MANY_ATTEMPTS' : 'INVALID_PASSWORD', retryAfterMs: r.retryAfterMs });
    }
    if (url === '/api/admin/logout' && method === 'POST') return json(200, { ok: true }, { 'set-cookie': deps.auth.logoutCookie() });
    if (url === '/api/admin/session' && method === 'GET') return json(200, { authRequired: deps.auth.enabled, loggedIn: deps.auth.enabled ? deps.auth.loggedIn(req) : true });

    // ---- everything internal: operator session, or loopback when no password is configured ----
    if (AdminAuth.isProtectedPath(url)) {
      const verdict = deps.auth.authorize(req);
      if (verdict === 'login') {
        if (method === 'GET' && AdminAuth.isPagePath(url)) { res.writeHead(302, { location: `/admin/login?next=${encodeURIComponent(url)}` }); res.end(); return; }
        return json(401, { error: 'UNAUTHORIZED', login: '/admin/login' });
      }
      if (verdict === 'forbidden') {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Internal pages are limited to localhost until ADMIN_PASSWORD is set on the service.');
        return;
      }
    }

    if (method === 'GET' && PAGES[url]) return serveFile(PAGES[url][0], PAGES[url][1], res);
    if (method === 'GET' && ICON_FILES.has(url.slice(1))) return serveFile(ICONS_DIR, url.slice(1), res);
    // applicant step routes (/step-2 … /step-n, /preparing, /completed): the applicant page restores the step client-side
    if (method === 'GET' && APPLY_ROUTES.test(url)) return serveFile(APPLY_DIR, 'index.html', res);
    if (method === 'GET' && url.startsWith('/apply/')) return serveFile(APPLY_DIR, url.slice('/apply/'.length), res);
    if (method === 'GET' && LEGAL_PAGES[url]) return legalPage(LEGAL_PAGES[url], deps.content.values(), res);
    // ---- development: automation browser mode (internal, /debug) ----
    if (url === '/api/dev/browser' && method === 'GET') return json(200, deps.browserMode.status());
    if (url === '/api/dev/browser' && method === 'POST') {
      const body = await readJson(req);
      try { return json(200, await deps.browserMode.request(body.mode as never)); } catch (e) { return json(400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    // ---- development: network (proxy + DNS path) diagnostics for one account; opens its browser through the shared launch path ----
    const diag = /^\/api\/dev\/network-diagnostics\/([^/]+)$/.exec(url);
    if (diag && method === 'POST') {
      const id = decodeURIComponent(diag[1]);
      if (!deps.store.get(id)) return json(404, { error: 'account not found' });
      try { return json(200, await deps.diagnostics.run(id)); } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (method === 'GET' && url === '/api/apply/config') {
      // questions (keys/values fixed in config) + the current applicant copy (defaults merged with saved overrides)
      const questions = JSON.parse(readFileSync(APPLY_CONFIG, 'utf8')) as Record<string, unknown>;
      return json(200, { ...questions, content: deps.content.values() });
    }

    // ---- applicant page content (operations page): copy only, plain text ----
    if (url === '/api/admin/content' && method === 'GET') return json(200, deps.content.list());
    if (url === '/api/admin/content' && method === 'PUT') {
      const body = await readJson(req);
      const values = body.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) return json(400, { error: 'values object required' });
      const r = deps.content.save(values as Record<string, string | null>);
      return json(Object.keys(r.errors).length && !r.saved.length ? 400 : 200, r);
    }

    // ---- applicant session ----
    if (url === '/api/applications' && method === 'POST') {
      const { row, token } = deps.apps.create();
      return json(201, { application: deps.apps.view(row) }, { 'set-cookie': sessionCookie(token, { secure: deps.settings.secureCookies, maxAgeMs: deps.settings.sessionTtlMs }) });
    }
    // waiting-screen analytics sent with navigator.sendBeacon when the page is being closed (the socket may already be gone)
    if (url === '/api/applications/me/wait' && method === 'POST') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const row = looksLikeToken(token) ? deps.apps.authenticate(token) : undefined;
      if (!row) return json(401, { error: 'UNAUTHENTICATED' });
      let body: Record<string, unknown> = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(400, { error: 'BAD_REQUEST' }); }
      const r = deps.apps.waitEvent(row.id, body.event, body.elapsedMs);
      return json(r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.code });
    }
    if (url === '/api/applications/me' && method === 'GET') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const row = looksLikeToken(token) ? deps.apps.authenticate(token) : undefined;
      if (!row) return json(401, { error: 'UNAUTHENTICATED' });
      return json(200, { application: deps.apps.view(row) });
    }

    // ---- operations page (internal) ----
    if (url === '/api/accounts' && method === 'GET') return json(200, { accounts: deps.store.listAccounts().map((a) => enrichAccount(deps, a)), logins: activeLogins(deps) });

    // ---- egress (proxies): metadata only, never credentials ----
    if (url === '/api/admin/egress' && method === 'GET') return json(200, { egress: deps.store.egress.list(), counts: deps.store.egress.counts(), directAllowed: deps.store.isDirectAllowed(), strictAccountEgress: deps.settings.strictAccountEgress });
    // Isolation audit trail and proxy provenance (identifiers and safe codes only; never credentials or browser contents).
    if (url.startsWith('/api/admin/audit') && method === 'GET') {
      const qs = new URL(req.url ?? '/', 'http://x').searchParams;
      return json(200, { events: deps.store.audit.list({ profileId: qs.get('profileId') ?? undefined, egressId: qs.get('egressId') ?? undefined, type: (qs.get('type') as any) ?? undefined }, Number(qs.get('limit') ?? 50) || 50) });
    }
    if (url === '/api/admin/egress' && method === 'POST') {
      const body = await readJson(req);
      const text = typeof body.lines === 'string' ? body.lines : typeof body.line === 'string' ? body.line : '';
      if (!text.trim()) return json(400, { error: 'nothing to import' });
      if (text.length > 200_000) return json(413, { error: 'too much input' });
      const r = deps.store.egress.importLines(text);
      deps.tl.mark('egress import', `${r.added} added / ${r.duplicates} duplicates / ${r.invalid.length} invalid`);
      if (r.added) { deps.notifyAdmin?.('egress'); void deps.egressHealth.checkAll(); }
      if (!deps.settings.strictAccountEgressExplicit && !deps.settings.strictAccountEgress && deps.store.egress.counts().total > 0) { deps.settings.strictAccountEgress = true; deps.store.setDirectAllowed(false); deps.tl.mark('strict account egress', 'enabled: the first proxy was imported; accounts without a proxy no longer use the server IP'); }
      return json(200, r);
    }
    if (url === '/api/admin/egress/validate' && method === 'POST') {
      const body = await readJson(req);
      const r = parseProxyLine(String(body.line ?? ''));
      return json(200, r.ok ? { ok: true, host: r.proxy.host, port: r.proxy.port, kind: r.proxy.kind, hasAuth: r.proxy.username !== undefined } : { ok: false, reason: r.reason });
    }
    const eg = /^\/api\/admin\/egress\/([^/]+)(?:\/(release|retire|check|history))?$/.exec(url);
    if (eg) {
      const id = decodeURIComponent(eg[1]);
      const action = eg[2];
      if (!deps.store.egress.get(id)) return json(404, { error: 'egress not found' });
      try {
        if (!action && method === 'DELETE') { deps.store.egress.remove(id); deps.tl.mark('egress removed', id.slice(0, 8)); deps.notifyAdmin?.('egress'); return json(200, { ok: true }); }
        if (action === 'release' && method === 'POST') { const m = deps.store.egress.release(id); deps.tl.mark('egress released', m.label); deps.notifyAdmin?.('egress'); void deps.registry.kick(); return json(200, m); }
        if (action === 'retire' && method === 'POST') { const m = deps.store.egress.retire(id); deps.tl.mark('egress retired', m.label); deps.notifyAdmin?.('egress'); return json(200, m); }
        if (action === 'check' && method === 'POST') { const r = await deps.egressHealth.check(id); deps.notifyAdmin?.('egress'); return json(200, { ...r, egress: deps.store.egress.meta(deps.store.egress.get(id)!) }); }
        if (action === 'history' && method === 'GET') return json(200, { history: deps.store.egress.history({ egressId: id }), clean: deps.store.egress.isClean(id) });
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

    const m = /^\/api\/accounts\/([^/]+)(?:\/(login\/start|login\/done|login\/cancel|login\/status|review|proxy|environment|history))?$/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      const account = deps.store.get(id);
      if (!account) return json(404, { error: 'account not found' });

      if (!action && method === 'DELETE') {
        await deps.logins.cancel(id);
        try { deps.store.remove(id); } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e) }); }
        deps.tl.mark('account removed', `${account.label} (browser profile directory retained)`);
        deps.notifyAdmin?.('accounts');
        return json(200, { ok: true });
      }
      // Operator proxy replacement: explicit, audited; a proxy with assignment history needs allowHistorical=true.
      if (action === 'proxy' && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.egressId !== 'string') return json(400, { error: 'egressId required' });
        try {
          const r = deps.store.egress.replaceProxyManually(id, body.egressId, deps.auth.operator(req).name, { allowHistorical: body.allowHistorical === true });
          deps.tl.mark('account proxy replaced by operator', `${account.label}: ${r.oldEgressId ? deps.store.egress.get(r.oldEgressId)?.label ?? r.oldEgressId : 'none'} → ${deps.store.egress.get(r.newEgressId)?.label ?? r.newEgressId}`);
          deps.notifyAdmin?.('accounts'); deps.notifyAdmin?.('egress');
          return json(200, { account: enrichAccount(deps, deps.store.accountMeta(deps.store.get(id)!)), ...r });
        } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code ?? null }); }
      }
      // Stable per-account browser environment (locale / timezone / viewport). Set by the operator, reused every launch.
      if (action === 'environment' && method === 'POST') {
        const body = await readJson(req);
        try {
          const vp = body.viewport === null ? null : typeof body.viewport === 'string' && /^\d+x\d+$/.test(body.viewport) ? { width: Number(body.viewport.split('x')[0]), height: Number(body.viewport.split('x')[1]) } : undefined;
          const str = (v: unknown) => (v === undefined ? undefined : typeof v === 'string' && v ? v : null);
          const env = deps.store.setEnvironment(id, { locale: str(body.locale), timezone: str(body.timezone), viewport: vp }, deps.auth.operator(req).name);
          deps.notifyAdmin?.('accounts');
          return json(200, { environment: env, account: enrichAccount(deps, deps.store.accountMeta(deps.store.get(id)!)) });
        } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e) }); }
      }
      if (action === 'history' && method === 'GET') return json(200, { history: deps.store.egress.history({ profileId: id }), audit: deps.store.audit.list({ profileId: id }, 50), runtime: deps.store.getRuntime(id) ? { type: deps.store.getRuntime(id)!.runtime_type, since: deps.store.getRuntime(id)!.started_at } : null });
      if (action === 'review' && method === 'POST') {
        const body = await readJson(req);
        if (body.decision !== 'release' && body.decision !== 'verified') return json(400, { error: 'decision must be "release" or "verified"' });
        try { deps.store.reviewDecision(id, body.decision); } catch (e) { return json(409, { error: e instanceof Error ? e.message : String(e) }); }
        deps.tl.mark(`account ${body.decision === 'release' ? 'released' : 'marked verified'} by operator`, account.label);
        deps.notifyAdmin?.('accounts');
        if (body.decision === 'release') void deps.registry.kick(); // a queued applicant may take the released account right away
        return json(200, { account: enrichAccount(deps, deps.store.accountMeta(deps.store.get(id)!)) });
      }
      if (action === 'login/start' && method === 'POST') { const st = await deps.logins.start(id); deps.notifyAdmin?.('egress'); return json(200, st); }
      if (action === 'login/status' && method === 'GET') return json(200, deps.logins.status(id));
      if (action === 'login/done' && method === 'POST') {
        const r = await deps.logins.done(id);
        if (r.saved) { deps.notifyAdmin?.('accounts'); deps.notifyAdmin?.('egress'); }
        return json(r.saved ? 200 : 409, r);
      }
      if (action === 'login/cancel' && method === 'POST') { await deps.logins.cancel(id); deps.notifyAdmin?.('egress'); return json(200, { ok: true }); }
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

/** Operations page: name the applicant an account is held for (display id + name only). */
function enrichAccount(deps: ServerDeps, a: AccountMeta): AccountMeta & { reservation: (AccountMeta['reservation'] & { applicant: { displayId: string; fullName: string } | null }) | null } {
  if (!a.reservation) return { ...a, reservation: null };
  const brief = a.reservation.applicationId ? deps.apps.brief(a.reservation.applicationId) : null;
  return { ...a, reservation: { ...a.reservation, applicant: brief } };
}

/** A same-origin path to return to after login; anything else goes to the operations page. */
function safeNext(next: string | null | undefined): string {
  return next && /^\/(?!\/)[\w\-./?=&%#]*$/.test(next) ? next : '/admin/accounts';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
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
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Plain text with light structure -> HTML: "## " heading, "- " bullet, blank line = paragraph; emails and https links become links. Never raw HTML. */
function textToHtml(text: string): string {
  const inline = (line: string) => escHtml(line)
    .replace(/(https:\/\/[^\s<]+[^\s<.,)])/g, '<a href="$1" rel="noopener">$1</a>')
    .replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '<a href="mailto:$1">$1</a>');
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; }
    if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith('## ')) { flush(); out.push(`<h2>${inline(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('- ')) { if (para.length) flush(); list.push(line.slice(2)); continue; }
    if (list.length) flush();
    para.push(line);
  }
  flush();
  return out.join('\n');
}

function legalPage(slug: 'privacy' | 'terms' | 'contact', content: Record<string, string>, res: ServerResponse): void {
  const year = String(new Date().getFullYear());
  const brand = (content['brand.name'] ?? '').trim() || 'Shipzora';
  const v = (k: string) => (content[k] ?? '').replace(/\{year\}/g, year).replace(/\{brand\}/g, brand);
  const siteTitle = v('brand.siteTitle') || `${brand} Careers`;
  const title = v(`legal.${slug}.title`) || slug;
  let body = textToHtml(v(`legal.${slug}.body`));
  if (slug === 'contact') {
    const rows: string[] = [];
    if (v('legal.contact.email')) rows.push(`<div class="contact-row"><span class="contact-label">Email</span><a href="mailto:${escHtml(v('legal.contact.email'))}">${escHtml(v('legal.contact.email'))}</a></div>`);
    if (v('legal.contact.phone')) rows.push(`<div class="contact-row"><span class="contact-label">Phone</span><a href="tel:${escHtml(v('legal.contact.phone').replace(/[^+\d]/g, ''))}">${escHtml(v('legal.contact.phone'))}</a></div>`);
    if (v('legal.contact.hours')) rows.push(`<div class="contact-row"><span class="contact-label">Hours</span><span>${escHtml(v('legal.contact.hours'))}</span></div>`);
    if (v('legal.contact.address')) rows.push(`<div class="contact-row"><span class="contact-label">Address</span><span>${v('legal.contact.address').split('\n').map(escHtml).join('<br>')}</span></div>`);
    if (rows.length) body += `<div class="contact-card">${rows.join('')}</div>`;
  }
  const link = (href: string, text: string) => `<a href="${href}"${href === `/${slug}` ? ' aria-current="page"' : ''}>${text}</a>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light"><meta name="theme-color" content="#ffffff"><meta name="robots" content="noindex">
<title>${escHtml(title)} | ${escHtml(siteTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png"><link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">
<link rel="stylesheet" href="/apply/apply.css"></head>
<body data-screen="legal">
<header class="site-header"><div class="shell header-row"><a class="header-back" href="/" aria-label="Back to the application"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 12H6M12 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></a><p class="app-title"><span class="brand-word">${escHtml(brand)}</span> ${escHtml(v('brand.headerLanding') || 'Careers')}</p></div><div class="accent-line" aria-hidden="true"><span></span></div></header>
<main class="shell legal-page"><h1>${escHtml(title)}</h1>${body}
<nav class="legal-links legal-nav" aria-label="Legal pages">${link('/privacy', 'Privacy')}${link('/terms', 'Terms')}${link('/contact', 'Contact')}</nav>
<p class="copyright">${escHtml(v('landing.copyright') || `© ${year} ${brand}`)}</p></main></body></html>`);
}

function placeholderPage(title: string, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;margin:0;background:#f3f4f1;color:#1b1f24}main{max-width:560px;margin:0 auto;padding:48px 20px}a{color:#084b46}</style></head>
<body><main><h1>${title}</h1><p>This page isn\u2019t available yet.</p><p><a href="/">Back to your application</a></p></main></body></html>`);
}
