/**
 * Operator login for the internal surfaces.
 *   1. unit: token issue/verify/expiry/tamper, protected-path list, rate limit, loopback rule
 *   2. a second service instance started with ADMIN_PASSWORD on another port: internal pages redirect to the login
 *      page, internal APIs and /ws, /ws/admin answer 401, the applicant site and /ws/app stay public, wrong
 *      passwords are rate limited per client, the right one sets an HttpOnly SameSite=Strict cookie that opens
 *      everything, a tampered cookie is rejected, logout clears it, the password never reaches the log
 *   3. the running development instance (no password): internal APIs answer localhost, 403 behind a forwarding header
 *   npm run fake-b + npm run start:fake, then: npm run test:auth
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { AdminAuth, isLoopback } from '../src/service/admin-auth.js';

let failures = 0;
const check = (cond: unknown, what: string) => { if (!cond) failures++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error('[test:auth] TIMEOUT'); process.exit(1); }, 120_000);

console.log('[test:auth] 1. unit');
{
  const secret = Buffer.alloc(32, 7);
  const a = new AdminAuth({ password: 'correct horse', secret, secure: false, ttlMs: 60_000 });
  const tok = a.issue();
  check(a.verify(tok), 'issued token verifies');
  check(!a.verify(tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A')), 'tampered signature is rejected');
  const [exp, nonce, sig] = tok.split('.');
  check(!a.verify(`${Number(exp) + 1000}.${nonce}.${sig}`), 'changed expiry is rejected');
  const short = new AdminAuth({ password: 'x', secret, ttlMs: 1, secure: false });
  const t2 = short.issue(); await sleep(5);
  check(!short.verify(t2), 'expired token is rejected');
  const other = new AdminAuth({ password: 'correct horse', secret: Buffer.alloc(32, 8), secure: false, ttlMs: 60_000 });
  check(!other.verify(tok), 'a token signed with another key is rejected');
  for (const p of ['/debug', '/debug.js', '/admin/accounts', '/admin.js', '/admin.css', '/api/accounts', '/api/accounts/abc/login/start', '/api/admin/egress', '/api/admin/content', '/api/dev/browser', '/ws', '/ws/admin']) check(AdminAuth.isProtectedPath(p), `protected: ${p}`);
  for (const p of ['/', '/step-2', '/completed', '/apply/apply.js', '/api/applications', '/api/applications/me', '/api/apply/config', '/ws/app', '/privacy', '/admin/login', '/api/admin/login', '/api/admin/logout', '/api/admin/session']) check(!AdminAuth.isProtectedPath(p), `public: ${p}`);
  check(a.login('wrong', '1.1.1.1').ok === false && a.login('correct horse', '1.1.1.1').ok === true, 'wrong password refused, right password accepted');
  for (let i = 0; i < 5; i++) a.login('nope', '2.2.2.2');
  const locked = a.login('correct horse', '2.2.2.2');
  check(!locked.ok && locked.retryAfterMs > 0, 'five failures lock that client for a while, even for the right password');
  check(a.login('correct horse', '3.3.3.3').ok, 'another client is unaffected');
  const fakeReq = (ip: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: ip } } as any);
  check(isLoopback(fakeReq('127.0.0.1')) && isLoopback(fakeReq('::1')) && isLoopback(fakeReq('::ffff:127.0.0.1')), 'loopback addresses recognised');
  check(!isLoopback(fakeReq('10.0.0.5')) && !isLoopback(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), 'remote clients and proxied requests are not loopback');
  check(!isLoopback(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), ['127.0.0.1']) && isLoopback(fakeReq('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }), ['127.0.0.1']) && !isLoopback(fakeReq('10.0.0.5', { 'x-forwarded-for': '127.0.0.1' }), ['127.0.0.1']), 'trusted proxy: the forwarded client decides; an untrusted peer cannot claim loopback');
  const open = new AdminAuth({ password: null, secret, secure: false, ttlMs: 1 });
  check(!open.enabled && open.authorize(fakeReq('127.0.0.1')) === 'ok' && open.authorize(fakeReq('10.0.0.5')) === 'forbidden', 'no password: loopback ok, anything else forbidden');
  check(a.authorize(fakeReq('127.0.0.1')) === 'login' && a.authorize(fakeReq('127.0.0.1', { cookie: `shipzora_admin=${tok}` })) === 'ok', 'password set: login required even on loopback; valid cookie passes');
}

console.log('[test:auth] 2. a service instance with ADMIN_PASSWORD');
const PORT = 3010;
const base = `http://localhost:${PORT}`;
const PASSWORD = 'Operator-Secret-9312';
const dataDir = mkdtempSync(join(tmpdir(), 'auth-'));
const logLines: string[] = [];
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'dev/start-fake.ts'], {
  // TRUSTED_PROXIES: this instance models a deployment behind a reverse proxy on the same host, so X-Forwarded-For from
  // the loopback peer is the client address (without it forwarding headers are ignored and rate limits key on the peer).
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, HEADLESS: '1', MAX_WORKFLOWS: '1', EGRESS_CHECK_INTERVAL_MS: '0', TRUSTED_PROXIES: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => logLines.push(d.toString()));
child.stderr.on('data', (d) => logLines.push(d.toString()));
const stop = async () => { child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 8000); }); rmSync(dataDir, { recursive: true, force: true }); };
process.on('unhandledRejection', async (e) => { console.error('[test:auth] error:', e instanceof Error ? e.message : e); await stop(); process.exit(1); });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/apply/config`)).ok) break; } catch { /* not yet */ } await sleep(300); }
const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
const wsTry = (path: string, headers: Record<string, string> = {}) => new Promise<'open' | number>((res) => { const w = new WebSocket(`ws://localhost:${PORT}${path}`, { headers }); w.on('open', () => { res('open'); w.close(); }); w.on('unexpected-response', (_r, r2) => res(r2.statusCode ?? 0)); w.on('error', () => res(0)); });
{
  const r1 = await get('/admin/accounts');
  check(r1.status === 302 && (r1.headers.get('location') ?? '').startsWith('/admin/login?next=%2Fadmin%2Faccounts'), 'operations page redirects to the login page');
  check((await get('/debug')).status === 302, '/debug redirects to the login page');
  check((await get('/admin.js')).status === 401 && (await get('/debug.js')).status === 401, 'internal scripts are not served without a session');
  check((await get('/api/accounts')).status === 401 && (await get('/api/admin/content')).status === 401 && (await get('/api/admin/egress')).status === 401 && (await get('/api/dev/browser')).status === 401, 'internal APIs answer 401');
  check((await get('/api/admin/content', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { 'code.title': 'x' } }) })).status === 401, 'content cannot be edited without a session');
  check((await wsTry('/ws')) === 401 && (await wsTry('/ws/admin')) === 401, 'developer and operations sockets refuse the upgrade');
  check((await get('/')).status === 200 && (await get('/step-3')).status === 200 && (await get('/completed')).status === 200 && (await get('/apply/apply.js')).status === 200 && (await get('/api/apply/config')).status === 200 && (await get('/privacy')).status === 200, 'applicant site, step routes, assets, config and placeholder pages stay public');
  const created = await get('/api/applications', { method: 'POST' });
  const appCookie = (created.headers.get('set-cookie') ?? '').split(';')[0];
  check(created.status === 201 && (await wsTry('/ws/app', { cookie: appCookie })) === 'open', 'applicants can still create an application and connect to /ws/app');
  const login = await get('/admin/login');
  check(login.status === 200 && /Operator password/.test(await login.text()), 'login page served');
  check((await get('/api/admin/session')).ok && (await (await get('/api/admin/session')).json()).authRequired === true, 'session endpoint reports that a login is required');

  // rate limit: a client (by forwarded address) locks after five wrong tries, even with the right password
  const attempt = (password: string, ip?: string) => get('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: JSON.stringify({ password }) });
  check((await attempt('wrong', '198.51.100.7')).status === 401, 'wrong password: 401');
  for (let i = 0; i < 4; i++) await attempt('wrong', '198.51.100.7');
  const lockedRight = await attempt(PASSWORD, '198.51.100.7');
  check(lockedRight.status === 429 && (await lockedRight.json()).retryAfterMs > 0, 'after five failures the client is locked (429) even for the right password');
  const ok = await attempt(PASSWORD);
  const setCookie = ok.headers.get('set-cookie') ?? '';
  check(ok.status === 200 && /^shipzora_admin=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+/.test(setCookie), `right password from another client: session cookie HttpOnly + SameSite=Strict (${setCookie.split(';').slice(1, 4).join(';').trim()})`);
  const cookie = setCookie.split(';')[0];
  check((await get('/api/accounts', { headers: { cookie } })).status === 200 && (await get('/admin/accounts', { headers: { cookie } })).status === 200 && (await get('/debug', { headers: { cookie } })).status === 200 && (await get('/api/admin/content', { headers: { cookie } })).status === 200, 'with the cookie: operations page, /debug and admin APIs open');
  check((await wsTry('/ws', { cookie })) === 'open' && (await wsTry('/ws/admin', { cookie })) === 'open', 'with the cookie: developer and operations sockets connect');
  const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
  check((await get('/api/accounts', { headers: { cookie: tampered } })).status === 401, 'a tampered cookie is rejected');
  check((await get('/admin/login', { headers: { cookie } })).status === 302, 'login page redirects an already signed-in operator');
  const form = await get('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: PASSWORD, next: '/debug' }).toString() });
  check(form.status === 303 && form.headers.get('location') === '/debug' && /shipzora_admin=/.test(form.headers.get('set-cookie') ?? ''), 'form login sets the cookie and returns to the requested page');
  const evil = await get('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: PASSWORD, next: '//evil.example/x' }).toString() });
  check(evil.headers.get('location') === '/admin/accounts', 'an off-site "next" is ignored');
  const out = await get('/api/admin/logout', { method: 'POST', headers: { cookie } });
  check(/shipzora_admin=; .*Max-Age=0/.test(out.headers.get('set-cookie') ?? ''), 'logout clears the cookie');
  await sleep(300);
  check(!logLines.join('').includes(PASSWORD), 'the password never appears in the service log');
}
await stop();

console.log('[test:auth] 3. the development instance without ADMIN_PASSWORD (loopback only)');
{
  const dev = 'http://localhost:3000';
  const open = await fetch(`${dev}/api/admin/session`).then((r) => r.json()).catch(() => null) as { authRequired: boolean } | null;
  if (!open) console.log('  (skipped: no service on :3000)');
  else {
    check(open.authRequired === false, 'no password configured on the development instance');
    check((await fetch(`${dev}/api/accounts`)).status === 200, 'localhost may use the internal APIs');
    check((await fetch(`${dev}/api/accounts`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status === 403, 'a request that came through a proxy (forwarding header) is refused: 403');
  }
}
console.log(failures ? `[test:auth] ${failures} check(s) failed` : '[test:auth] all checks passed');
process.exit(failures ? 1 : 0);
