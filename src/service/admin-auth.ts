import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { parseCookies } from './applications/session.js';

/**
 * Operator login for the internal surfaces (/admin/accounts, /debug, admin + dev APIs, /ws and /ws/admin).
 *
 * One shared operator password (ADMIN_PASSWORD). A successful login sets an HttpOnly, SameSite=Strict cookie
 * holding a signed, expiring token (HMAC-SHA256 with a key derived from the vault master key, so sessions
 * survive restarts and no password material is ever stored). Failed attempts are rate limited per client IP.
 *
 * Without ADMIN_PASSWORD the internal surfaces answer only to the loopback interface with no forwarding
 * header (local development and tests); any other client gets 403 with the instruction to set it.
 * The applicant site, its API and /ws/app are never behind this.
 */
export const ADMIN_COOKIE = 'shipzora_admin';
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

const PROTECTED_EXACT = new Set(['/debug', '/debug.js', '/admin/accounts', '/admin.js', '/admin.css', '/ws', '/ws/admin']);
const PROTECTED_PREFIXES = ['/api/accounts', '/api/admin/', '/api/dev/'];
const PUBLIC_ADMIN_API = new Set(['/api/admin/login', '/api/admin/logout', '/api/admin/session']);
/** Pages a browser navigates to: an unauthenticated request is redirected to the login page instead of a bare 401. */
const PAGE_PATHS = new Set(['/debug', '/admin/accounts']);

export type AuthResult = 'ok' | 'login' | 'forbidden';

export class AdminAuth {
  private readonly passwordHash: Buffer | null;
  private readonly fails = new Map<string, { n: number; until: number }>();

  constructor(private readonly opts: { password: string | null; secret: Buffer; secure: boolean; ttlMs: number }) {
    this.passwordHash = opts.password ? createHash('sha256').update(opts.password, 'utf8').digest() : null;
  }

  /** True when a password is configured, i.e. the internal surfaces require a login from everywhere. */
  get enabled(): boolean { return this.passwordHash !== null; }

  static isProtectedPath(path: string): boolean {
    if (PUBLIC_ADMIN_API.has(path)) return false;
    if (PROTECTED_EXACT.has(path)) return true;
    return PROTECTED_PREFIXES.some((p) => path.startsWith(p));
  }
  static isPagePath(path: string): boolean { return PAGE_PATHS.has(path); }

  /** Decide for one request to a protected path. */
  authorize(req: IncomingMessage): AuthResult {
    if (!this.enabled) return isLoopback(req) ? 'ok' : 'forbidden';
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    return token && this.verify(token) ? 'ok' : 'login';
  }

  /** Is this request carrying a valid operator session (for the session endpoint; never throws). */
  loggedIn(req: IncomingMessage): boolean {
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    return !!token && this.verify(token);
  }

  /** Check a password attempt. Rate limited per client: after 5 failures the client waits a minute. */
  login(password: unknown, clientIp: string): { ok: true; cookie: string } | { ok: false; retryAfterMs: number } {
    if (!this.passwordHash) return { ok: false, retryAfterMs: 0 };
    const now = Date.now();
    const f = this.fails.get(clientIp);
    if (f && f.until > now) return { ok: false, retryAfterMs: f.until - now };
    const given = createHash('sha256').update(typeof password === 'string' ? password : '', 'utf8').digest();
    if (typeof password === 'string' && timingSafeEqual(given, this.passwordHash)) {
      this.fails.delete(clientIp);
      return { ok: true, cookie: this.cookie(this.issue()) };
    }
    const expiredLock = !!f && f.until > 0 && f.until <= now; // a lock that has run out starts the count again
    const n = (!f || expiredLock ? 0 : f.n) + 1;
    this.fails.set(clientIp, { n, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
    if (this.fails.size > 10_000) this.fails.clear();
    return { ok: false, retryAfterMs: n >= MAX_FAILS ? LOCK_MS : 0 };
  }

  logoutCookie(): string {
    return [`${ADMIN_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(this.opts.secure ? ['Secure'] : [])].join('; ');
  }

  // ---- token: <expiresAtMs>.<nonce>.<hmac> ----
  issue(): string {
    const exp = Date.now() + this.opts.ttlMs;
    const nonce = randomBytes(16).toString('base64url');
    return `${exp}.${nonce}.${this.sign(`${exp}.${nonce}`)}`;
  }
  verify(token: string): boolean {
    const m = /^(\d{10,16})\.([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{40,50})$/.exec(token);
    if (!m) return false;
    if (Number(m[1]) < Date.now()) return false;
    const expected = Buffer.from(this.sign(`${m[1]}.${m[2]}`));
    const given = Buffer.from(m[3]);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
  private sign(payload: string): string { return createHmac('sha256', this.opts.secret).update(payload).digest('base64url'); }
  private cookie(token: string): string {
    return [`${ADMIN_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(this.opts.ttlMs / 1000)}`, ...(this.opts.secure ? ['Secure'] : [])].join('; ');
  }
}

/** Loopback client with no reverse-proxy forwarding header: the only client allowed when no password is set. */
export function isLoopback(req: IncomingMessage): boolean {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded']) return false;
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(',')[0];
  return (first?.trim() || req.socket.remoteAddress || 'unknown').slice(0, 64);
}

/** The login page (internal, tiny, no external assets). `next` is validated server-side to a same-origin path. */
export function loginPage(next: string, error?: string): string {
  const safeNext = /^\/(?!\/)[\w\-./?=&%#]*$/.test(next) ? next : '/admin/accounts';
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sign in — Shipzora Operations</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;margin:0;background:#f3f4f1;color:#1b1f24;display:flex;min-height:100vh;align-items:center;justify-content:center}
  main{width:100%;max-width:380px;padding:24px}
  .card{background:#fff;border:1px solid #d8dbd5;border-radius:10px;padding:26px 24px}
  h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px;color:#4a5158;font-size:14px}
  label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;height:42px;padding:0 12px;border:1px solid #b9bdb6;border-radius:6px;font:inherit;font-size:15px}
  input:focus{outline:3px solid rgba(11,93,87,.22);border-color:#0b5d57}
  button{margin-top:14px;width:100%;height:42px;border:0;border-radius:6px;background:#0b5d57;color:#fff;font:inherit;font-weight:600;font-size:15px;cursor:pointer}
  button:hover{background:#084b46}.err{background:#fbeae8;border:1px solid #f0b7b0;color:#7a1a12;border-radius:6px;padding:10px 12px;font-size:13.5px;margin-bottom:14px}
  .brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7178;font-weight:700;margin-bottom:14px}
</style></head>
<body><main><div class="card"><div class="brand">Shipzora Operations</div><h1>Sign in</h1><p>Internal pages. Enter the operator password.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/api/admin/login"><input type="hidden" name="next" value="${esc(safeNext)}">
<label for="pw">Operator password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button></form></div></main></body></html>`;
}
