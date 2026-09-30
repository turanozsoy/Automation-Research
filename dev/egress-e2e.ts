/**
 * Egress (proxy) end to end against the running service, the fake Website B and two local fake proxies:
 * bulk import with duplicate / invalid feedback, credentials never exposed, exclusive use (one browser per
 * session), HELD after use until released, release serving the queue, health checks taking a proxy down,
 * a workflow through a failing proxy becoming an EGRESS_FAILED problem, and no credential anywhere.
 *
 *   npm run fake-b
 *   npx tsx dev/fake-proxy.ts --port 3100 --control 3900 --auth user1:pass1
 *   npx tsx dev/fake-proxy.ts --port 3101 --control 3901 --auth user2:pass2
 *   MAX_WORKFLOWS=10 COOLDOWN_MS=3000 npm run start:fake   (headless, >= 3 imported fake accounts), then:
 *   npm run e2e:egress
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import type { AppServerMsg, ApplicationView } from '../src/shared/messages.js';

const port = Number(process.env.PORT ?? 3000);
const base = `http://localhost:${port}`;
const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data/fake');
const SERVICE_LOG = process.env.SERVICE_LOG;
const P1 = { line: '127.0.0.1:3100:user1:pass1', control: 'http://127.0.0.1:3900', user: 'user1', pass: 'pass1' };
const P2 = { line: '127.0.0.1:3101:user2:pass2', control: 'http://127.0.0.1:3901', user: 'user2', pass: 'pass2' };
const SECRETS = [P1.pass, P2.pass, P1.user, P2.user];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond: unknown, what: string) => { if (!cond) failures++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`); };
const fatal = (m: string): never => { console.error(`[e2e:egress] FATAL: ${m}`); process.exit(1); };
setTimeout(() => fatal('overall timeout'), 420_000);
process.on('unhandledRejection', async (e) => { console.error('[e2e:egress] error:', e instanceof Error ? e.message.split('\n')[0] : e); try { await cleanup(); } catch { /* ignore */ } process.exit(1); });
const api = async (path: string, init?: RequestInit) => { const r = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' }, ...init }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
const stats = async (control: string) => (await (await fetch(`${control}/stats`)).json()) as { tunnels: number; requests: number; maxActive: number; authFailures: number; down: boolean };
const setDown = (control: string, down: boolean) => fetch(`${control}/${down ? 'down' : 'up'}`, { method: 'POST' });
const db = new Database(resolve(dataDir, 'automation.db'), { readonly: true });
const egressList = async () => (await api('/api/admin/egress')).body as { egress: { id: string; label: string; kind: string; state: string; health: string; useCount: number; consecutiveFailures: number }[]; counts: Record<string, number>; directAllowed: boolean };
const byLabel = async (label: string) => (await egressList()).egress.find((e) => e.label === label)!;

// ---- one applicant, driven over the applicant socket ----
class Applicant {
  id = ''; cookie = ''; ws!: WebSocket; views: ApplicationView[] = []; all: AppServerMsg[] = [];
  constructor(public name: string, public code: string) {}
  async start(): Promise<void> {
    const r = await fetch(`${base}/api/applications`, { method: 'POST' });
    this.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    this.id = ((await r.json()) as { application: ApplicationView }).application.id;
    this.ws = new WebSocket(`ws://localhost:${port}/ws/app`, { headers: { cookie: this.cookie } });
    await new Promise<void>((res, rej) => { this.ws.on('open', () => res()); this.ws.on('error', rej); });
    this.ws.on('message', (d) => { const m = JSON.parse(d.toString()) as AppServerMsg; this.all.push(m); if (m.type === 'app.state') this.views.push(m.application); });
    this.send({ type: 'app.update', fields: { firstName: this.name, lastName: 'Egress', mobileNumber: '5550100200', email: `${this.name.toLowerCase()}@example.com`, dateOfBirth: '1990-05-17', address1: '1 Main St', city: 'Springfield', state: 'NY', zip: '10001' } });
    await this.wait((v) => v.missingFields.length === 0, 5000, 'fields');
    this.send({ type: 'app.address_completed' });
  }
  send(m: object): void { this.ws.send(JSON.stringify({ ts: Date.now(), ...m })); }
  get view(): ApplicationView | undefined { return this.views[this.views.length - 1]; }
  async wait(pred: (v: ApplicationView) => boolean, ms: number, what: string): Promise<ApplicationView> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (this.view && pred(this.view)) return this.view; await sleep(100); }
    throw new Error(`${this.name}: timeout waiting for ${what}; last ${JSON.stringify(this.view)}`);
  }
  async finish(): Promise<ApplicationView> {
    await this.wait((v) => v.automation.phase === 'awaiting_code' || v.state === 'problem', 120_000, 'awaiting code');
    if (this.view!.state === 'problem') return this.view!;
    this.send({ type: 'app.verify', code: this.code });
    const v = await this.wait((v) => v.generatedUrl !== null || v.state === 'problem', 120_000, 'link or problem');
    if (v.state === 'problem') return v;
    this.send({ type: 'app.link_opened' });
    return this.wait((v) => v.state === 'completed', 90_000, 'verified');
  }
  workflowId(): string | null { return (db.prepare("SELECT workflow_id FROM application_events WHERE application_id = ? AND type = 'automation_started' ORDER BY id DESC LIMIT 1").get(this.id) as { workflow_id: string } | undefined)?.workflow_id ?? null; }
  egressUsed(): string | null { const wf = this.workflowId(); return wf ? ((db.prepare('SELECT egress_id FROM assignments WHERE workflow_id = ?').get(wf) as { egress_id: string | null } | undefined)?.egress_id ?? null) : null; }
  close(): void { this.ws.close(); }
}

// ---------------------------------------------------------------------------
// idempotent: remove leftovers from an earlier run and make sure direct is allocatable
async function cleanup(): Promise<void> {
  const l = await egressList();
  for (const e of l.egress) {
    if (e.kind === 'direct') { if (e.state !== 'available') await api(`/api/admin/egress/${e.id}/release`, { method: 'POST' }); continue; }
    if (/^127\.0\.0\.1:310[01]$/.test(e.label)) { if (e.state === 'in_use') continue; await api(`/api/admin/egress/${e.id}`, { method: 'DELETE' }); }
  }
  await setDown(P1.control, false); await setDown(P2.control, false);
}
await cleanup();
process.on('exit', () => { /* cleanup below runs on the normal path; a fatal exit leaves state for inspection */ });

console.log('[e2e:egress] 1. import');
{
  await setDown(P1.control, false); await setDown(P2.control, false);
  const lines = [P1.line, P2.line, P1.line, `http://${P1.user}:${P1.pass}@127.0.0.1:3100`, 'not a proxy', '127.0.0.1:99999:u:p', '', '   '].join('\n');
  const r = await api('/api/admin/egress', { method: 'POST', body: JSON.stringify({ lines }) });
  check(r.status === 200 && r.body.added === 2 && r.body.duplicates === 2 && r.body.invalid.length === 2, `bulk import: ${r.body.added} added / ${r.body.duplicates} duplicates / ${r.body.invalid?.length} invalid`);
  check(r.body.invalid.every((i: { reason: string }) => !SECRETS.some((s) => i.reason.includes(s))), 'invalid-line feedback carries no credentials');
  const again = await api('/api/admin/egress', { method: 'POST', body: JSON.stringify({ line: P2.line }) });
  check(again.body.added === 0 && again.body.duplicates === 1, 'the same proxy is never stored twice');
  const list = await egressList();
  const dump = JSON.stringify(list);
  check(!SECRETS.some((s) => dump.includes(s)), 'egress listing exposes no username or password');
  check(list.egress.filter((e) => e.kind !== 'direct').length === 2 && list.egress.filter((e) => e.kind !== 'direct').every((e) => e.state === 'available'), 'two proxy sessions available');
  const row = db.prepare("SELECT * FROM egress WHERE kind != 'direct' LIMIT 1").get() as Record<string, unknown>;
  check(Buffer.isBuffer(row.cred_enc) && !Object.values(row).some((v) => typeof v === 'string' && SECRETS.some((s) => v.includes(s))), 'credentials stored encrypted only');
  await sleep(4000); // first active checks
  const l2 = await egressList();
  check(l2.egress.filter((e) => e.kind !== 'direct').every((e) => e.health === 'healthy'), `active health checks passed (${l2.egress.filter((e) => e.kind !== 'direct').map((e) => e.health).join(', ')})`);
}

console.log('[e2e:egress] 1b. login capture takes a session exclusively');
{
  const acct = (db.prepare("SELECT id, label FROM profiles ORDER BY created_at LIMIT 1").get() as { id: string; label: string });
  const before1 = await stats(P1.control), before2 = await stats(P2.control);
  const st = await api(`/api/accounts/${acct.id}/login/start`, { method: 'POST' });
  check(st.status === 200 && st.body.open && /127\.0\.0\.1:310[01]/.test(st.body.egress ?? ''), `login browser opened via ${st.body.egress}`);
  await sleep(2500);
  const inUse = (await egressList()).egress.filter((e) => e.state === 'in_use');
  check(inUse.length === 1 && inUse[0].label === st.body.egress, 'that session is in use while the capture browser is open');
  const after1 = await stats(P1.control), after2 = await stats(P2.control);
  const used = st.body.egress.endsWith(':3100') ? after1.requests - before1.requests : after2.requests - before2.requests;
  check(used > 0, `the capture browser's traffic went through the session (${used} requests)`);
  await api(`/api/accounts/${acct.id}/login/cancel`, { method: 'POST' });
  await sleep(800);
  const held = await byLabel(st.body.egress);
  check(held.state === 'held', 'the session is held after the capture, not returned to the pool');
  await api(`/api/admin/egress/${held.id}/release`, { method: 'POST' });
}

console.log('[e2e:egress] 2. exclusive use, held after use, release serves the queue');
const direct = await byLabel('Direct (server IP)');
await api(`/api/admin/egress/${direct.id}/retire`, { method: 'POST' });
check((await byLabel('Direct (server IP)')).state === 'retired', 'direct egress retired: every workflow must use a proxy session');
const s1a = await stats(P1.control), s2a = await stats(P2.control);
const A = new Applicant('Alice', '111222333'), B = new Applicant('Bob', '444555666'), C = new Applicant('Carol', '777888999');
await Promise.all([A.start(), B.start(), C.start()]);
await sleep(2500);
{
  const l = await egressList();
  const inUse = l.egress.filter((e) => e.state === 'in_use');
  check(inUse.length === 2, `two sessions in use for two workflows, third applicant waits (${l.counts.available} available)`);
  const live = db.prepare("SELECT egress_id, COUNT(*) n FROM assignments WHERE state IN ('allocating','preparing','ready','submitting','paused') GROUP BY egress_id").all() as { egress_id: string; n: number }[];
  check(live.every((x) => x.n === 1) && live.length === 2, 'no proxy session has two live workflows');
}
const [ra, rb] = await Promise.all([A.finish(), B.finish()]);
check(ra.state === 'completed' && rb.state === 'completed', 'A and B completed through proxies');
const s1b = await stats(P1.control), s2b = await stats(P2.control);
// Chromium answers a proxy's 407 challenge on the first request, so the fake proxy counts one auth failure per session; what matters is that requests then went through.
check(s1b.requests > s1a.requests && s2b.requests > s2a.requests, `both proxies carried authenticated traffic (${s1b.requests - s1a.requests} and ${s2b.requests - s2a.requests} requests)`);
check(A.egressUsed() !== B.egressUsed() && A.egressUsed() !== null, `A and B used different sessions`);
await sleep(1500);
{
  const l = await egressList();
  check(l.egress.filter((e) => e.kind !== 'direct').every((e) => e.state === 'held') && l.counts.available === 0, 'both sessions HELD after use; not returned to the pool');
  check(C.view?.state === 'processing' && C.view.automation.phase === 'preparing', 'C still waiting: no session is allocatable while held');
  const waiting = db.prepare("SELECT COUNT(*) n FROM application_events WHERE application_id = ? AND type = 'automation_waiting_for_capacity'").get(C.id) as { n: number };
  check(waiting.n >= 1, 'C recorded as waiting for capacity');
  const held = l.egress.find((e) => e.state === 'held')!;
  const rel = await api(`/api/admin/egress/${held.id}/release`, { method: 'POST' });
  check(rel.status === 200 && rel.body.state === 'available', `operator released ${held.label}`);
  const rc = await C.finish();
  check(rc.state === 'completed' && C.egressUsed() === held.id, 'C got the released session and completed');
  await sleep(1500);
  check((await byLabel(held.label)).state === 'held', 'the released session is held again after C');
}

console.log('[e2e:egress] 3. health takes a proxy down; a failing proxy fails only its workflow');
{
  const p1 = await byLabel('127.0.0.1:3100'), p2 = await byLabel('127.0.0.1:3101');
  await api(`/api/admin/egress/${p1.id}/release`, { method: 'POST' });
  await api(`/api/admin/egress/${p2.id}/release`, { method: 'POST' });
  await setDown(P1.control, true);
  for (let i = 0; i < 3; i++) await api(`/api/admin/egress/${p1.id}/check`, { method: 'POST' });
  const down = await byLabel('127.0.0.1:3100');
  check(down.state === 'down' && down.health === 'down', 'three failed checks: session marked down and out of rotation');
  // A workflow through a proxy that dies after allocation: EGRESS_FAILED, applicant sees a safe message, other proxy unaffected.
  await setDown(P2.control, true);
  const D = new Applicant('Dana', '123123123');
  await D.start();
  const rd = await D.wait((v) => v.state === 'problem' || v.generatedUrl !== null, 60_000, 'D outcome');
  check(rd.state === 'problem' && rd.problem?.code === 'EGRESS_FAILED', `D: workflow through the dead proxy became a retryable problem (${rd.problem?.code})`);
  check(!/proxy|egress|ERR_|127\.0\.0\.1/i.test(rd.problem?.message ?? ''), 'applicant message is non-technical');
  await sleep(1000);
  const p2after = await byLabel('127.0.0.1:3101');
  check(p2after.state === 'held' && p2after.consecutiveFailures >= 1 && p2after.health !== 'healthy', `the failing session is held with a recorded failure (health ${p2after.health})`);
  await setDown(P1.control, false); await setDown(P2.control, false);
  await api(`/api/admin/egress/${p1.id}/release`, { method: 'POST' });
  check((await byLabel('127.0.0.1:3100')).state === 'available', 'Restore returns a down session to the pool');
  const E = new Applicant('Erin', '321321321');
  await E.start();
  const re = await E.finish();
  check(re.state === 'completed' && E.egressUsed() === p1.id, 'E completed through the restored session');
  for (const a of [A, B, C, D, E]) a.close();
}

console.log('[e2e:egress] 4. no credential anywhere');
{
  let leaks: string[] = [];
  for (const t of (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((x) => x.name)) {
    for (const row of db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) for (const [c, v] of Object.entries(row)) if (typeof v === 'string' && [P1.pass, P2.pass].some((s) => v.includes(s))) leaks.push(`${t}.${c}`);
  }
  check(leaks.length === 0, leaks.length ? `password in ${leaks.join(', ')}` : 'no password in any table');
  if (SERVICE_LOG && existsSync(SERVICE_LOG)) check(![P1.pass, P2.pass].some((s) => readFileSync(SERVICE_LOG, 'utf8').includes(s)), 'no password in the service log');
  const html = await (await fetch(`${base}/admin/accounts`)).text();
  const b = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const p = await b.newPage();
  await p.goto(`${base}/admin/accounts`);
  await p.waitForFunction(() => document.querySelectorAll('#egressRows tr[data-egress-id]').length >= 3);
  const dom = await p.content();
  const rowsText = await p.locator('#egressRows').innerText();
  await b.close();
  check(![P1.pass, P2.pass, P1.user, P2.user].some((s) => html.includes(s) || dom.includes(s)), 'no credential in the operations page DOM');
  check(/127\.0\.0\.1:3100/.test(rowsText) && /Held|Available|In use/.test(rowsText) && /Healthy|Degraded|Down/.test(rowsText), 'operations page lists proxies with status and health');
}

// cleanup: direct back, test proxies removed so other suites keep using the server IP
await cleanup();
db.close();
console.log(failures ? `[e2e:egress] ${failures} check(s) failed` : '[e2e:egress] all checks passed');
process.exit(failures ? 1 : 0);
