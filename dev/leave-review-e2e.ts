/**
 * Leaving and the review window, against a stack this test starts itself (fake Website B that never shows the
 * success text, service with short timers). Nothing else may be listening on 3001 / 3011.
 *   npm run e2e:leave
 *  1. the applicant's page is gone before the code -> after the grace period the workflow ends, the browser closes,
 *     the account is free again, the application is back to `started` (no problem) and resumes when they return
 *  2. a short disconnect (refresh, SMS app) within the grace period changes nothing
 *  3. the applicant opened the link; no success text within verification.afterVisitMs -> browser closed, account
 *     under review, application untouched (link_ready / visited, no problem)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { AppServerMsg, ApplicationView } from '../src/shared/messages.js';

const PORT = 3011;
const base = `http://localhost:${PORT}`;
const CODE = '482913756';
const GRACE_MS = 2000;
const AFTER_VISIT_MS = 4000;
let failures = 0;
const check = (ok: boolean, name: string, detail = '') => { console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dataDir = mkdtempSync(join(tmpdir(), 'leave-'));
const children: ChildProcess[] = [];
const logs: string[] = [];
const stop = async () => { for (const c of children) c.kill('SIGTERM'); await sleep(1500); rmSync(dataDir, { recursive: true, force: true }); };
const fatal = async (what: string): Promise<never> => { console.error(`[e2e:leave] FATAL: ${what}`); console.error(logs.slice(-20).join('')); await stop(); process.exit(1); };
process.on('unhandledRejection', (e) => void fatal(e instanceof Error ? e.message : String(e)));

const run = (args: string[], env: Record<string, string>) => { const c = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); c.stdout.on('data', (d) => logs.push(d.toString())); c.stderr.on('data', (d) => logs.push(d.toString())); children.push(c); return c; };
const once = (args: string[], env: Record<string, string>) => new Promise<number>((res) => { const c = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); c.stderr.on('data', (d) => logs.push(d.toString())); c.on('exit', (code) => res(code ?? 1)); });

// ---- stack ----
for (const p of [3001, PORT]) { try { await fetch(`http://localhost:${p}/`); await fatal(`port ${p} is already in use (stop the development stack first)`); } catch (e) { if (e instanceof Error && /already in use/.test(e.message)) throw e; } }
run(['dev/fake-b/server.ts'], { FAKE_B_GOOD_TO_GO_MS: '600000' }); // the success text never appears within the test
for (let i = 0; i < 50; i++) { try { if ((await fetch('http://localhost:3001/')).ok) break; } catch { /* not yet */ } await sleep(200); }
const env = { DATA_DIR: dataDir, SITE_B_CONFIG: 'config/site-b.fake.json' };
for (const [label, key] of [['leave1', 'l1'], ['leave2', 'l2'], ['leave3', 'l3']]) if (await once(['dev/profile-fake.ts', 'import', '--label', label, '--account', key, '--file', 'dev/fake-b/profile.storage-state.json'], env) !== 0) await fatal(`seeding ${label} failed`);
run(['dev/start-fake.ts'], { ...env, PORT: String(PORT), HEADLESS: '1', MAX_WORKFLOWS: '3', COOLDOWN_MS: '1000', EGRESS_CHECK_INTERVAL_MS: '0', ACCOUNT_RESERVE: '1', APPLICANT_LEAVE_GRACE_MS: String(GRACE_MS), VERIFICATION_AFTER_VISIT_MS: String(AFTER_VISIT_MS) });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/apply/config`)).ok) break; } catch { /* not yet */ } await sleep(300); }

// ---- helpers ----
async function createApp(): Promise<{ id: string; cookie: string }> {
  const r = await fetch(`${base}/api/applications`, { method: 'POST' });
  if (r.status !== 201) await fatal(`create returned ${r.status}`);
  const j = await r.json() as { application: ApplicationView };
  return { id: j.application.id, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
}
class AppSocket {
  ws!: WebSocket; all: AppServerMsg[] = []; views: ApplicationView[] = [];
  constructor(public label: string, private cookie: string) {}
  connect(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}/ws/app`, { headers: { cookie: this.cookie } });
      this.ws.on('error', rej); this.ws.on('open', () => res());
      this.ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as AppServerMsg; this.all.push(m); if (m.type === 'app.state') this.views.push(m.application); });
    });
  }
  send(m: object): void { this.ws.send(JSON.stringify({ ts: Date.now(), ...m })); }
  get view(): ApplicationView | undefined { return this.views[this.views.length - 1]; }
  async waitView(pred: (v: ApplicationView) => boolean, timeoutMs: number, what: string): Promise<ApplicationView> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { const v = this.view && pred(this.view) ? this.view : this.views.find(pred); if (v) return v; await sleep(100); }
    return fatal(`[${this.label}] timeout waiting for ${what}; last view: ${JSON.stringify(this.view)}`);
  }
  close(): Promise<void> { return new Promise((r) => { this.ws.once('close', () => r()); this.ws.close(); }); }
}
type Account = { id: string; name: string; reservation: { state: string } | null; browser: { running: unknown } | null; sessionStatus: string };
const accounts = async () => (await (await fetch(`${base}/api/accounts`)).json() as { accounts: Account[] }).accounts;
const CONTACT = { firstName: 'Lea', lastName: 'Gone', dateOfBirth: '1992-02-02', mobileNumber: '5550002222', email: 'lea@example.com' };
const ADDRESS = { address1: '9 Pine St', city: 'Springfield', state: 'NY', zip: '10001' };

console.log('[e2e:leave] 1. the applicant leaves at the address step: browser closed, account free, application resumable');
const A = await createApp();
let sa = new AppSocket('A', A.cookie); await sa.connect();
sa.send({ type: 'app.update', fields: CONTACT });
await sa.waitView((v) => v.fields.firstName === 'Lea', 5000, 'A contact');
sa.send({ type: 'app.step', step: 'address', completedStep: 'dob' });
sa.send({ type: 'app.prepare' });
await sa.waitView((v) => v.state === 'processing', 5000, 'A processing');
await sa.waitView((v) => v.automation.phase === 'preparing', 5000, 'A preparing');
await sleep(4000); // let the browser launch and reach Website B
let acc = await accounts();
check(acc.some((a) => a.browser && a.browser.running), 'an account browser is running for A');
await sa.close(); // the tab is closed
const tLeft = Date.now();
await sleep(GRACE_MS + 3500);
sa = new AppSocket('A2', A.cookie); await sa.connect();
const back = await sa.waitView((v) => v.id === A.id, 5000, 'A view after returning');
check(back.state === 'started' && !back.automation.active && back.automation.attempts === 1 && !back.problem, `A: application back to "started", no problem shown (state ${back.state}, active ${back.automation.active})`);
check(back.currentStep === 'address' && back.fields.firstName === 'Lea', 'A: saved step and fields kept');
acc = await accounts();
check(acc.every((a) => !(a.browser && a.browser.running)), `A: the account browser was closed ${Date.now() - tLeft} ms after the grace period started`);
check(acc.every((a) => !a.reservation), 'A: no account is held or taken');
const db = (await import('better-sqlite3')).default;
const dbh = new db(join(dataDir, 'automation.db'), { readonly: true });
check(!!dbh.prepare("SELECT 1 FROM application_events WHERE application_id = ? AND type = 'applicant_left'").get(A.id), 'A: applicant_left event recorded');
check(!dbh.prepare("SELECT 1 FROM application_events WHERE application_id = ? AND type = 'problem'").get(A.id), 'A: no problem event');
// A comes back: finishes the address and enters the code -> a fresh workflow runs to the link
sa.send({ type: 'app.prepare' });
await sa.waitView((v) => v.state === 'processing' && v.automation.attempts === 2, 5000, 'A second workflow after returning');
sa.send({ type: 'app.update', fields: ADDRESS });
await sa.waitView((v) => v.missingFields.length === 0, 5000, 'A address saved');
sa.send({ type: 'app.address_completed' });
await sa.waitView((v) => v.automation.phase === 'awaiting_code', 60_000, 'A awaiting the code');
sa.send({ type: 'app.verify', code: CODE });
const linkA = await sa.waitView((v) => v.generatedUrl !== null, 120_000, 'A link');
check(!!linkA.generatedUrl && linkA.state === 'link_ready', 'A: link ready on the second attempt');

console.log('[e2e:leave] 2. a short disconnect within the grace period changes nothing');
const B = await createApp();
let sb = new AppSocket('B', B.cookie); await sb.connect();
sb.send({ type: 'app.update', fields: { ...CONTACT, firstName: 'Bo', lastName: 'Blip', email: 'bo@example.com' } });
await sb.waitView((v) => v.fields.firstName === 'Bo', 5000, 'B contact');
sb.send({ type: 'app.prepare' });
await sb.waitView((v) => v.state === 'processing', 5000, 'B processing');
await sb.close();
await sleep(Math.floor(GRACE_MS / 2));
sb = new AppSocket('B2', B.cookie); await sb.connect();
await sleep(GRACE_MS + 1000);
check(sb.view!.state === 'processing' && sb.view!.automation.active && sb.view!.automation.attempts === 1, 'B: the workflow kept running across a short disconnect');
sb.send({ type: 'app.update', fields: ADDRESS });
await sb.waitView((v) => v.missingFields.length === 0, 5000, 'B address saved');
sb.send({ type: 'app.address_completed' });
await sb.waitView((v) => v.automation.phase === 'awaiting_code', 60_000, 'B awaiting the code');
sb.send({ type: 'app.verify', code: CODE });
await sb.waitView((v) => v.generatedUrl !== null, 120_000, 'B link');
await sb.close();

console.log('[e2e:leave] 3. link opened, no success text within the window: browser closed, account under review');
sa.send({ type: 'app.link_opened' });
const visited = await sa.waitView((v) => v.linkState === 'visited', 5000, 'A visited');
check(visited.state === 'link_ready', 'A: visited, still link_ready');
const tVisit = Date.now();
let reviewed: Account | undefined;
for (let i = 0; i < 60; i++) { acc = await accounts(); reviewed = acc.find((a) => a.reservation?.state === 'review'); if (reviewed && !(reviewed.browser && reviewed.browser.running)) break; await sleep(500); }
const tReview = Date.now() - tVisit;
check(!!reviewed && !(reviewed.browser && reviewed.browser.running), `A: account under review with its browser closed ${tReview} ms after the visit (window ${AFTER_VISIT_MS} ms)`, reviewed ? reviewed.name : 'none');
check(tReview >= AFTER_VISIT_MS - 500 && tReview < AFTER_VISIT_MS + 6000, 'A: the browser stayed open for the whole window, not longer');
await sleep(500);
check(sa.view!.state === 'link_ready' && sa.view!.linkState === 'visited' && !sa.view!.problem, `A: application untouched (state ${sa.view!.state}, link ${sa.view!.linkState})`);
check(acc.filter((a) => a.reservation?.state === 'review').length === 1, 'exactly one account under review (B never opened its link)');
await sa.close();

dbh.close();
await stop();
console.log(failures ? `[e2e:leave] ${failures} check(s) failed` : '[e2e:leave] all checks passed');
process.exit(failures ? 1 : 0);
