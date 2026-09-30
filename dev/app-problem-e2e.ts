/**
 * Failure path of the applicant foundation. Requires the fake Website B WITHOUT its Agree button,
 * so the workflow pauses at the "agree" step; for an applicant workflow the bridge aborts it,
 * releases the profile and records a retryable problem. A second attempt hits the same wall.
 *   FAKE_B_NO_AGREE=1 npm run fake-b   +   npm run start:fake (one imported fake account is enough), then:
 *   npm run e2e:app:problem
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import type { AppServerMsg, ApplicationView, ServerMsg } from '../src/shared/messages.js';

const port = Number(process.env.PORT ?? 3000);
const base = `http://localhost:${port}`;
const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data/fake');
const CODE = '123-45-6789';
setTimeout(() => { console.error('[e2e:app:problem] TIMEOUT'); process.exit(1); }, 300_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond: unknown, what: string) => { if (!cond) { failures++; console.error(`  FAIL: ${what}`); } else console.log(`  ok: ${what}`); };

const r = await fetch(`${base}/api/applications`, { method: 'POST' });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
const { application } = await r.json() as { application: ApplicationView };

const views: ApplicationView[] = [];
const errors: AppServerMsg[] = [];
const ws = new WebSocket(`ws://localhost:${port}/ws/app`, { headers: { cookie } });
await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as AppServerMsg; if (m.type === 'app.state') views.push(m.application); if (m.type === 'app.error') errors.push(m); });
const send = (m: object) => ws.send(JSON.stringify({ ts: Date.now(), ...m }));
const waitView = async (pred: (v: ApplicationView) => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = [...views].reverse().find(pred); if (v) return v; await sleep(100); }
  console.error(`[e2e:app:problem] timeout waiting for ${what}; last: ${JSON.stringify(views[views.length - 1])}`); process.exit(1);
};

// A developer socket sees the raw workflow telemetry: use it to confirm the pause -> abort happened.
const devSeen: string[] = [];
const dev = new WebSocket(`ws://localhost:${port}/ws`);
dev.on('message', (raw) => { const m = JSON.parse(raw.toString()) as ServerMsg; if (m.type === 'paused') devSeen.push(`paused:${m.step}`); if (m.type === 'event') devSeen.push(m.name); if (m.type === 'pool.status') devSeen.push(`pool:${m.pool.available}`); });

send({ type: 'app.update', fields: { firstName: 'John', lastName: 'Doe', dateOfBirth: '1990-05-17', mobileNumber: '5551234567', address1: '1 Main St', city: 'Springfield', state: 'NY', zip: '10001' } });
await waitView((v) => v.missingFields.length === 0, 5000, 'fields');
send({ type: 'app.verify', code: CODE });
await waitView((v) => v.state === 'processing', 5000, 'processing');
const problem = await waitView((v) => v.state === 'problem', 120_000, 'problem');
console.log(`  problem: ${JSON.stringify(problem.problem)}`);
check(problem.problem?.code === 'AGREE_NOT_FOUND', 'problem code is the failed step\'s code (AGREE_NOT_FOUND)');
check(!/a\[|button|aria-label|selector|http/i.test(problem.problem?.message ?? ''), 'applicant message contains no selectors or URLs');
check(problem.verificationStep === 'failed' && problem.automation.active === false && problem.automation.attempts === 1, 'verification step failed, automation inactive, 1 attempt');
check(devSeen.includes('paused:agree'), 'the workflow paused at "agree" (developer telemetry)');
check(devSeen.some((n) => n.startsWith('applicant workflow paused: aborting')), 'the bridge aborted the paused workflow instead of holding the profile');

// The profile must be released (cooldown -> available) rather than held by the paused workflow.
await sleep(Number(process.env.COOLDOWN_MS ?? 3000) + 6000);
const db = new Database(resolve(dataDir, 'automation.db'), { readonly: true });
const live = (db.prepare("SELECT COUNT(*) n FROM assignments WHERE state IN ('allocating','preparing','ready','submitting','paused')").get() as { n: number }).n;
check(live === 0, 'no live assignment is left behind');
const ev = db.prepare("SELECT * FROM application_events WHERE application_id = ? AND type = 'problem' ORDER BY id DESC LIMIT 1").get(application.id) as Record<string, unknown>;
check(ev && ev.code === 'AGREE_NOT_FOUND' && ev.stage === 'agree' && ev.retry_count === 0 && typeof ev.workflow_id === 'string', 'problem event: code, stage, retry count, workflow id');
check(!String(ev.detail ?? '').includes(CODE) && !String(ev.message ?? '').includes(CODE), 'problem event carries no secret');
db.close();

// Retry: the code is required again; the same wall gives a second problem with attempts = 2.
send({ type: 'app.verify', code: CODE });
await waitView((v) => v.state === 'processing' && v.automation.attempts === 2, 5000, 'second processing');
const problem2 = await waitView((v) => v.state === 'problem' && v.automation.attempts === 2, 120_000, 'second problem');
check(problem2.problem?.code === 'AGREE_NOT_FOUND', 'second attempt recorded as a new problem');
const db2 = new Database(resolve(dataDir, 'automation.db'), { readonly: true });
const wfIds = (db2.prepare("SELECT DISTINCT workflow_id FROM application_events WHERE application_id = ? AND type = 'automation_started'").all(application.id) as { workflow_id: string }[]).map((x) => x.workflow_id);
check(wfIds.length === 2 && wfIds[0] !== wfIds[1], 'two distinct workflows in the history of one application');
check((db2.prepare('SELECT workflow_id FROM applications WHERE id = ?').get(application.id) as { workflow_id: string | null }).workflow_id === null, 'current workflow_id is null after the problem');
db2.close();

ws.close(); dev.close();
console.log(failures ? `[e2e:app:problem] ${failures} check(s) failed` : '[e2e:app:problem] all checks passed');
process.exit(failures ? 1 : 0);
