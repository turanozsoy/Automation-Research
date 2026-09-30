/**
 * End-to-end test of the applicant foundation against the running service + fake Website B:
 * creation, cookie session, resume, socket reconnect, isolation between two applications,
 * address-step start with explicit address finalisation, held / late verification code,
 * application -> workflow mapping, generated URL persistence, visited / verified propagation,
 * and the verification code never reaching the database.
 *   npm run fake-b  +  npm run start:fake  (two imported fake accounts), then: npm run e2e:app
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import type { AppServerMsg, ApplicationView } from '../src/shared/messages.js';

const port = Number(process.env.PORT ?? 3000);
const base = `http://localhost:${port}`;
const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data/fake');
const CODE = process.env.E2E_CODE ?? '123-45-6789';
const overall = setTimeout(() => { console.error('[e2e:app] TIMEOUT'); process.exit(1); }, 240_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (cond: unknown, what: string) => { if (!cond) { failures++; console.error(`  FAIL: ${what}`); } else console.log(`  ok: ${what}`); };
const fatal = (what: string): never => { console.error(`[e2e:app] FATAL: ${what}`); process.exit(1); };

async function createApp(): Promise<{ id: string; cookie: string; view: ApplicationView }> {
  const r = await fetch(`${base}/api/applications`, { method: 'POST' });
  if (r.status !== 201) fatal(`create returned ${r.status}`);
  const setCookie = r.headers.get('set-cookie') ?? '';
  check(/HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie), 'session cookie is HttpOnly + SameSite');
  const j = await r.json() as { application: ApplicationView };
  return { id: j.application.id, cookie: setCookie.split(';')[0], view: j.application };
}

class AppSocket {
  ws!: WebSocket;
  all: AppServerMsg[] = [];
  views: ApplicationView[] = [];
  closed = false;
  constructor(public label: string, private cookie: string) {}
  connect(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://localhost:${port}/ws/app`, { headers: { cookie: this.cookie } });
      this.ws.on('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
      this.ws.on('error', rej);
      this.ws.on('open', () => res());
      this.ws.on('close', () => { this.closed = true; });
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as AppServerMsg;
        this.all.push(m);
        if (m.type === 'app.state') this.views.push(m.application);
        if (m.type === 'app.progress') console.log(`  [${this.label}] progress: ${m.event}`);
        if (m.type === 'app.error') console.log(`  [${this.label}] error: ${m.code} — ${m.message}${m.missingFields ? ' ' + JSON.stringify(m.missingFields) : ''}`);
      });
    });
  }
  send(m: object): void { this.ws.send(JSON.stringify({ ts: Date.now(), ...m })); }
  get view(): ApplicationView | undefined { return this.views[this.views.length - 1]; }
  async waitView(pred: (v: ApplicationView) => boolean, timeoutMs: number, what: string): Promise<ApplicationView> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = this.views.find(pred) ?? (this.view && pred(this.view) ? this.view : undefined);
      if (v) return v;
      await sleep(100);
    }
    fatal(`[${this.label}] timeout waiting for ${what}; last view: ${JSON.stringify(this.view)}`);
    throw new Error('unreachable');
  }
  async waitError(code: string, timeoutMs = 5000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.all.some((m) => m.type === 'app.error' && m.code === code)) return true;
      await sleep(50);
    }
    return false;
  }
  close(): Promise<void> { return new Promise((r) => { this.ws.once('close', () => r()); this.ws.close(); }); }
}

const FIELDS_A = { firstName: 'John', lastName: 'Doe', dateOfBirth: '1990-05-17', mobileNumber: '5551234567', address1: '1 Main St', city: 'Springfield', state: 'NY', zip: '10001', email: 'john@example.com' };
const FIELDS_B = { firstName: 'Jane', lastName: 'Roe', dateOfBirth: '1988-01-02', mobileNumber: '5559876543', address1: '2 Oak Ave', city: 'Springfield', state: 'NY', zip: '10001', email: 'jane@example.com' };

// ---------------------------------------------------------------------------
console.log('[e2e:app] 1. authentication');
{
  const r = await fetch(`${base}/api/applications/me`);
  check(r.status === 401, 'GET /api/applications/me without a cookie is 401');
  const r2 = await fetch(`${base}/api/applications/me`, { headers: { cookie: 'shipzora_session=' + 'A'.repeat(43) } });
  check(r2.status === 401, 'a well-formed but unknown token is 401');
  let rejected = false;
  try { await new AppSocket('anon', '').connect(); } catch (e) { rejected = /401/.test(String(e)); }
  check(rejected, 'WebSocket /ws/app without a session is refused with 401');
}

console.log('[e2e:app] 2. creation + resume by cookie');
const A = await createApp();
const B = await createApp();
check(A.id !== B.id && A.cookie !== B.cookie, 'two applications: distinct ids and tokens');
check(A.view.state === 'started' && A.view.missingFields.length === 8 && A.view.automation.active === false, 'fresh application: started, 8 required Website B fields missing, no automation');
{
  const me = await (await fetch(`${base}/api/applications/me`, { headers: { cookie: A.cookie } })).json() as { application: ApplicationView };
  check(me.application.id === A.id, 'GET /me with A cookie resumes A');
  let socketWithGuessedId = false;
  try { await new AppSocket('guess', `shipzora_session=${A.id}`).connect(); socketWithGuessedId = true; } catch { /* expected */ }
  check(!socketWithGuessedId, 'knowing an applicationId does not open a socket');
}

console.log('[e2e:app] 3. isolation between two applications');
let sa = new AppSocket('A', A.cookie); await sa.connect();
const sb = new AppSocket('B', B.cookie); await sb.connect();
await sa.waitView((v) => v.id === A.id, 5000, 'initial A snapshot');
await sb.waitView((v) => v.id === B.id, 5000, 'initial B snapshot');
sa.send({ type: 'app.update', fields: FIELDS_A });
sb.send({ type: 'app.update', fields: { lastName: 'Roe' } });
await sa.waitView((v) => v.fields.firstName === 'John' && v.fields.email === 'john@example.com', 5000, 'A fields saved');
await sb.waitView((v) => v.fields.lastName === 'Roe', 5000, 'B field saved');
await sleep(500);
check(sb.views.every((v) => v.id === B.id) && sa.views.every((v) => v.id === A.id), 'each socket only ever receives its own application');
check(!sb.views.some((v) => v.fields.firstName === 'John'), "B never sees A's data");
check(sa.view!.missingFields.length === 0, 'A has every Website B field (code excluded)');
sa.send({ type: 'app.update', fields: { authenticationCode: CODE } });
check(await sa.waitError('INVALID_FIELD'), 'the verification code is refused as a saved field');
sa.send({ type: 'app.update', fields: { favouriteColor: 'blue' } });
check(await sa.waitError('INVALID_FIELD'), 'unknown fields are refused');
sa.send({ type: 'app.step', step: 'questions', completedStep: 'contact' });
await sa.waitView((v) => v.currentStep === 'questions', 5000, 'A step recorded');
sa.send({ type: 'app.answers', answers: { position: 'driver' } });
await sa.waitView((v) => v.answers.position === 'driver', 5000, 'A answers saved');

console.log('[e2e:app] 4. reconnect resumes state');
await sa.close();
sa = new AppSocket('A2', A.cookie); await sa.connect();
const resumed = await sa.waitView((v) => v.id === A.id, 5000, 'A snapshot after reconnect');
check(resumed.fields.firstName === 'John' && resumed.currentStep === 'questions' && resumed.state === 'started' && resumed.answers.position === 'driver', 'fields, step and answers survive a reconnect');

console.log('[e2e:app] 5. information required blocks the automation');
const C = await createApp();
const sc = new AppSocket('C', C.cookie); await sc.connect();
sc.send({ type: 'app.verify', code: CODE });
check(await sc.waitError('INFORMATION_REQUIRED'), 'verify without the fields -> INFORMATION_REQUIRED');
const cErr = sc.all.find((m) => m.type === 'app.error' && m.code === 'INFORMATION_REQUIRED');
check(cErr?.type === 'app.error' && (cErr.missingFields ?? []).length === 8, 'missing fields are listed');
check(sc.view?.state === 'started' && sc.view.automation.attempts === 0, 'no workflow was started for C');
await sc.close();

console.log('[e2e:app] 6. address step starts the automation; code arrives later; the socket may drop meanwhile');
sb.send({ type: 'app.update', fields: FIELDS_B });
await sb.waitView((v) => v.missingFields.length === 0, 5000, 'B complete');
const tVerify = Date.now();
// A: the intended flow. Address step done -> workflow prepares and finalises the address -> awaiting the code.
sa.send({ type: 'app.address_completed' });
await sa.waitView((v) => v.state === 'processing', 5000, 'A processing');
check(sa.view!.automation.active && sa.view!.automation.attempts === 1 && sa.view!.automation.phase === 'preparing', 'A: automation active, attempt 1, phase preparing');
sa.send({ type: 'app.address_completed' });
await sleep(300);
check(!sa.all.some((m) => m.type === 'app.error') || sa.all.filter((m) => m.type === 'app.error').every((m) => m.type === 'app.error' && m.code === 'INVALID_FIELD'), 'a repeated address_completed is idempotent (no error)');
// B: address step and code sent back to back; the code must be held until the address is finalised.
sb.send({ type: 'app.address_completed' });
sb.send({ type: 'app.verify', code: CODE });
await sb.waitView((v) => v.state === 'processing', 5000, 'B processing');
sb.send({ type: 'app.verify', code: CODE });
check(await sb.waitError('INVALID_STATE'), 'a second code while one is held -> INVALID_STATE');
// Drop A's socket while the workflow prepares: the workflow must continue.
await sa.close();
await sleep(2500);
sa = new AppSocket('A3', A.cookie); await sa.connect();
const afterDrop = await sa.waitView((v) => v.id === A.id, 5000, 'A snapshot after dropping the socket mid-automation');
check(afterDrop.state === 'processing', `automation survived the disconnect (state ${afterDrop.state}, phase ${afterDrop.automation.phase})`);
const awaiting = await sa.waitView((v) => v.automation.phase === 'awaiting_code', 60_000, 'A awaiting the code');
console.log(`  A address finalised, awaiting code after ${Date.now() - tVerify} ms`);
check(awaiting.state === 'processing' && awaiting.generatedUrl === null && awaiting.verificationStep === 'required', 'A waits for the code: no URL yet, verification still required');
await sleep(1500); // the applicant "types" the code while the workflow waits
check(sa.view!.automation.phase === 'awaiting_code' && sa.view!.state === 'processing', 'A keeps waiting; nothing was submitted without the code');
sa.send({ type: 'app.verify', code: CODE });
await sa.waitView((v) => v.automation.phase === 'submitting', 5000, 'A submitting after the code');
const linkA = await sa.waitView((v) => v.generatedUrl !== null, 120_000, 'A generated link');
const linkB = await sb.waitView((v) => v.generatedUrl !== null, 120_000, 'B generated link');
console.log(`  A link ${linkA.generatedUrl} after ${Date.now() - tVerify} ms; B link ${linkB.generatedUrl}`);
check(/\/test\/it-worked\//.test(linkA.generatedUrl!) && /\/test\/it-worked\//.test(linkB.generatedUrl!), 'both links match the configured pattern');
check(linkA.generatedUrl !== linkB.generatedUrl, 'each application got its own link');
check(linkA.state === 'link_ready' || linkA.state === 'completed', 'A state link_ready');
check(linkA.verificationStep === 'completed', 'verification step recorded as completed (metadata only)');
check(typeof linkA.generatedUrlReadyAt === 'number', 'generatedUrlReadyAt persisted');
check(sa.all.some((m) => m.type === 'app.progress' && m.event === 'generated_link_ready'), 'progress event generated_link_ready received');
check(sb.all.some((m) => m.type === 'app.progress' && m.event === 'address_finalized') && sb.all.some((m) => m.type === 'app.progress' && m.event === 'verification_received'), 'B: address finalised, then the held code was handed over');

console.log('[e2e:app] 7. visited / verified propagation');
sa.send({ type: 'app.link_opened' });
const visited = await sa.waitView((v) => v.linkState === 'visited' || v.linkState === 'verified', 5000, 'A visited');
check(typeof visited.finalLinkClickedAt === 'number', 'final CTA click recorded');
const doneA = await sa.waitView((v) => v.state === 'completed', 90_000, 'A completed (verified)');
const doneB = await sb.waitView((v) => v.state === 'completed', 90_000, 'B completed (verified)');
check(doneA.linkState === 'verified' && doneB.linkState === 'verified', 'both verified');
check(doneA.automation.active === false, 'automation no longer active after completion');
sa.send({ type: 'app.verify', code: CODE });
check(await sa.waitError('INVALID_STATE'), 'verify after completion -> INVALID_STATE');

console.log('[e2e:app] 8. database: persistence, mapping, and no secret');
{
  const db = new Database(resolve(dataDir, 'automation.db'), { readonly: true });
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(A.id) as Record<string, unknown>;
  check(app.generated_url === linkA.generatedUrl && app.link_state === 'verified' && app.state === 'completed', 'A row: generated_url, link_state, state persisted');
  check(app.workflow_id === null && app.workflow_count === 1 && app.final_link_clicked_at !== null && app.verified_at !== null, 'A row: workflow detached after completion, counters and timestamps set');
  check(app.first_name === 'John' && app.phone === '5551234567' && app.address_state === 'NY', 'A row: applicant fields persisted');
  const events = db.prepare('SELECT type, workflow_id FROM application_events WHERE application_id = ? ORDER BY id').all(A.id) as { type: string; workflow_id: string | null }[];
  const types = events.map((e) => e.type);
  for (const t of ['application_started', 'fields_updated', 'step_completed', 'step_viewed', 'automation_started', 'automation_ready', 'address_finalized', 'verification_received', 'automation_submitting', 'generated_link_ready', 'final_cta_clicked', 'visited', 'verified']) check(types.includes(t), `event ${t} recorded`);
  const order = ['automation_ready', 'address_finalized', 'verification_received', 'automation_submitting', 'generated_link_ready'].map((t) => types.indexOf(t));
  check(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), 'A events in order: ready -> address finalised -> code received -> submitting -> link');
  const wfId = events.find((e) => e.type === 'automation_started')?.workflow_id;
  check(!!wfId, 'automation_started names the workflow');
  const asg = wfId ? db.prepare('SELECT * FROM assignments WHERE workflow_id = ?').get(wfId) as Record<string, unknown> | undefined : undefined;
  check(!!asg && asg.link_state === 'verified' && asg.result_url === linkA.generatedUrl && asg.state === 'completed', 'the workflow assignment carries the same URL and verified link state');
  const bRow = db.prepare('SELECT workflow_count FROM applications WHERE id = ?').get(B.id) as { workflow_count: number };
  const bWf = (db.prepare("SELECT workflow_id FROM application_events WHERE application_id = ? AND type = 'automation_started'").get(B.id) as { workflow_id: string }).workflow_id;
  check(bRow.workflow_count === 1 && bWf !== wfId, 'B used a different workflow');

  // The secret must not be anywhere: not in any text column of any table, not in the raw database bytes.
  const needles = [CODE, CODE.replace(/\D/g, '')];
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  let leaks: string[] = [];
  for (const t of tables) {
    for (const row of db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) {
      for (const [col, v] of Object.entries(row)) if (typeof v === 'string' && needles.some((n) => v.includes(n))) leaks.push(`${t}.${col}`);
    }
  }
  check(leaks.length === 0, `verification code absent from every table column${leaks.length ? ': ' + leaks.join(', ') : ''}`);
  db.close();
  for (const f of ['automation.db', 'automation.db-wal']) {
    const p = resolve(dataDir, f);
    if (!existsSync(p)) continue;
    const bytes = readFileSync(p);
    check(!needles.some((n) => bytes.includes(n)), `verification code absent from raw ${f}`);
  }
}

await sa.close(); await sb.close();
clearTimeout(overall);
console.log(failures ? `[e2e:app] ${failures} check(s) failed` : '[e2e:app] all checks passed');
process.exit(failures ? 1 : 0);
