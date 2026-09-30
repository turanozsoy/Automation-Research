/**
 * Checkout navigation after the submit click (Step 3): Step 4 (Agree) and Step 6 (primary button) are raced.
 *   Path A (fresh account):            3 → 4 → 5 → 6 → 7
 *   Path B (previously-used account):  3 → 6 → 7   (Steps 4 and 5 never appear)
 * Path B must prove the automation does not sit waiting for Step 4 while Step 6 is already visible.
 * The fake Website B takes a last name containing RETURNING as "previously-used account" for that applicant only.
 *   npm run fake-b   +   npm run start:fake (two imported fake accounts), then:
 *   npm run e2e:checkout
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import type { AppServerMsg, ApplicationView, EventMsg, ServerMsg } from '../src/shared/messages.js';

const port = Number(process.env.PORT ?? 3000);
const base = `http://localhost:${port}`;
const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data/fake');
const CODE = '123456789';
/** Upper bound for "Step 6 clicked promptly": the fake shows the returning checkout ~0.9 s after submit. Far below timeouts.checkoutStep (30 s). */
const PROMPT_MS = 5000;
setTimeout(() => { console.error('[e2e:checkout] TIMEOUT'); process.exit(1); }, 240_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond: unknown, what: string) => { if (!cond) { failures++; console.error(`  FAIL: ${what}`); } else console.log(`  ok: ${what}`); };

// Developer channel: every workflow timeline mark, with its workflow id and timestamp.
const marks: EventMsg[] = [];
const paused: string[] = [];
const dev = new WebSocket(`ws://localhost:${port}/ws`);
await new Promise<void>((res, rej) => { dev.on('open', () => res()); dev.on('error', rej); });
dev.on('message', (raw) => { const m = JSON.parse(raw.toString()) as ServerMsg; if (m.type === 'event') marks.push(m); if (m.type === 'paused') paused.push(`${m.workflowId}:${m.step}`); });

interface Applicant { name: string; ws: WebSocket; views: ApplicationView[]; id: string; workflowId: string | null }
async function start(firstName: string, lastName: string): Promise<Applicant> {
  const r = await fetch(`${base}/api/applications`, { method: 'POST' });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  const { application } = await r.json() as { application: ApplicationView };
  const ws = new WebSocket(`ws://localhost:${port}/ws/app`, { headers: { cookie } });
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  const a: Applicant = { name: firstName, ws, views: [], id: application.id, workflowId: null };
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as AppServerMsg; if (m.type === 'app.state') a.views.push(m.application); });
  ws.send(JSON.stringify({ ts: Date.now(), type: 'app.update', fields: { firstName, lastName, dateOfBirth: '1990-05-17', mobileNumber: '5551234567', address1: '1 Main St', city: 'Springfield', state: 'NY', zip: '10001' } }));
  await waitView(a, (v) => v.missingFields.length === 0, 5000, 'fields');
  ws.send(JSON.stringify({ ts: Date.now(), type: 'app.verify', code: CODE }));
  await waitView(a, (v) => v.state === 'processing', 5000, 'processing');
  return a;
}
async function waitView(a: Applicant, pred: (v: ApplicationView) => boolean, ms: number, what: string): Promise<ApplicationView> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = [...a.views].reverse().find(pred); if (v) return v; await sleep(100); }
  console.error(`[e2e:checkout] ${a.name}: timeout waiting for ${what}; last: ${JSON.stringify(a.views[a.views.length - 1])}`); process.exit(1);
}
function workflowOf(a: Applicant): string {
  if (a.workflowId) return a.workflowId;
  const db = new Database(resolve(dataDir, 'automation.db'), { readonly: true });
  const row = db.prepare("SELECT workflow_id FROM application_events WHERE application_id = ? AND type = 'automation_started' ORDER BY id DESC LIMIT 1").get(a.id) as { workflow_id: string } | undefined;
  db.close();
  if (!row) throw new Error(`${a.name}: no automation_started event`);
  a.workflowId = row.workflow_id;
  return row.workflow_id;
}
const marksOf = (a: Applicant) => marks.filter((m) => m.workflowId === workflowOf(a));
const tsOf = (a: Applicant, name: string) => marksOf(a).find((m) => m.name === name)?.ts ?? null;
const has = (a: Applicant, name: string) => tsOf(a, name) !== null;
/** True when every named mark exists and they were recorded in this order. */
function ordered(a: Applicant, names: string[]): boolean {
  const ts = names.map((n) => tsOf(a, n));
  return ts.every((t) => t !== null) && ts.every((t, i) => i === 0 || t! >= ts[i - 1]!);
}

const fresh = await start('Paula', 'Fresh');
const returning = await start('Rhea', 'RETURNINGaccount');
const linkA = await waitView(fresh, (v) => v.generatedUrl !== null, 120_000, 'fresh applicant link');
const linkB = await waitView(returning, (v) => v.generatedUrl !== null, 120_000, 'returning applicant link');
await sleep(300);

console.log('[e2e:checkout] Path A (fresh account): 3 → 4 → 5 → 6 → 7');
check(/\/test\/it-worked\//.test(linkA.generatedUrl!), `fresh applicant got a generated link (${linkA.generatedUrl})`);
check(ordered(fresh, ['Website B submit clicked', 'Agree and continue clicked', 'checkbox unchecked', 'primary clicked', 'secondary clicked', 'generated URL detected']), 'Step 3, Agree (4), toggle turned off (5), primary (6), secondary (7), URL — in that order');
check(has(fresh, 'toggle inspected'), 'the toggle was inspected before being turned off (never turned on)');
check(!has(fresh, 'checkout toggle step skipped') && !has(fresh, 'primary step already done'), 'nothing was skipped on the fresh path');

console.log('[e2e:checkout] Path B (previously-used account): 3 → 6 → 7');
check(/\/test\/it-worked\//.test(linkB.generatedUrl!), `returning applicant got a generated link (${linkB.generatedUrl})`);
check(ordered(returning, ['Website B submit clicked', 'Agree and continue not present: primary button visible first', 'primary clicked', 'checkout toggle step skipped', 'primary step already done', 'secondary clicked', 'generated URL detected']), 'Step 3, primary (6) as soon as it appeared, secondary (7), URL — Steps 4 and 5 skipped');
check(!has(returning, 'Agree and continue clicked') && !has(returning, 'toggle inspected') && !has(returning, 'iframe detected'), 'no Agree click, no toggle inspection, no separate iframe wait on the returning path');
const submitToPrimary = tsOf(returning, 'primary clicked')! - tsOf(returning, 'Website B submit clicked')!;
check(submitToPrimary < PROMPT_MS, `Step 6 clicked ${submitToPrimary} ms after the submit click: no wait for Step 4 (bound ${PROMPT_MS} ms, checkoutStep timeout 30 000 ms)`);
check(!paused.some((p) => p.startsWith(workflowOf(returning)) || p.startsWith(workflowOf(fresh))), 'neither workflow paused');

console.log('[e2e:checkout] both applicants reach the role details');
for (const a of [fresh, returning]) {
  a.ws.send(JSON.stringify({ ts: Date.now(), type: 'app.link_opened' }));
  const done = await waitView(a, (v) => v.state === 'completed', 90_000, `${a.name} completed`);
  check(done.linkState === 'verified', `${a.name}: link visited and verified`);
  a.ws.close();
}
dev.close();
console.log(failures ? `[e2e:checkout] ${failures} check(s) failed` : '[e2e:checkout] all checks passed');
process.exit(failures ? 1 : 0);
