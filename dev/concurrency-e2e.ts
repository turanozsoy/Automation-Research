/**
 * Multi-applicant concurrency test against the running service + fake Website B (headless).
 * N synthetic applicants with obviously different data run at the same time and overlap in
 * stage: their address steps are released together, their verification codes are staggered,
 * one can be made to fail (checkout iframe never appears), one can drop and resume its socket,
 * one profile can be expired, some skip the final CTA. Throughout: the assignments table is
 * polled for a double allocation (fails at once), the developer channel is recorded to check
 * what each Website B context actually held, the operations page is watched live, and process
 * memory / CPU are sampled. Ends with strict isolation assertions and a database consistency pass.
 *
 *   npm run fake-b  +  MAX_WORKFLOWS=10 COOLDOWN_MS=3000 npm run start:fake   (headless, K imported fake accounts), then e.g.
 *   CONCURRENCY=2 npm run e2e:concurrency
 *   CONCURRENCY=5 npm run e2e:concurrency
 *   CONCURRENCY=8 EXPECT_PROFILES=5 npm run e2e:concurrency        # more applicants than profiles
 *   CONCURRENCY=3 FAIL_ONE=1 npm run e2e:concurrency                # applicant #1's iframe never appears
 *   CONCURRENCY=3 DROP_ONE=1 npm run e2e:concurrency                # applicant #1 drops and resumes its socket
 *   CONCURRENCY=3 EXPIRE_ONE=1 npm run e2e:concurrency              # an expired profile is in the pool
 *   CONCURRENCY=3 SKIP_CTA=1 npm run e2e:concurrency                # applicant #1 never clicks View Role Details
 *   NO_VERIFY=1 ... with the fake started as FAKE_B_GOOD_TO_GO_MS=600000 (nobody verifies within the test)
 */
import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import WebSocket from 'ws';
import type { AppServerMsg, ApplicationView, ServerMsg } from '../src/shared/messages.js';
import { Vault } from '../src/service/crypto.js';
import { openDb } from '../src/service/db.js';
import { ProfileStore } from '../src/service/profiles/store.js';

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------
const port = Number(process.env.PORT ?? 3000);
const base = `http://localhost:${port}`;
const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data/fake');
const N = Number(process.env.CONCURRENCY ?? 2);
const FAIL_ONE = process.env.FAIL_ONE === '1';
const DROP_ONE = process.env.DROP_ONE === '1';
const EXPIRE_ONE = process.env.EXPIRE_ONE === '1';
const NO_VERIFY = process.env.NO_VERIFY === '1';
const SKIP_CTA = new Set((process.env.SKIP_CTA ?? '').split(',').filter(Boolean).map(Number));
const EXPECT_PROFILES = process.env.EXPECT_PROFILES ? Number(process.env.EXPECT_PROFILES) : null;
const WATCH_ADMIN = process.env.ADMIN !== '0';
const SERVICE_LOG = process.env.SERVICE_LOG; // optional: grep it for the codes at the end
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

const results: { area: string; pass: boolean; note: string }[] = [];
let failures = 0;
const check = (area: string, cond: unknown, what: string) => {
  const pass = !!cond;
  if (!pass) failures++;
  results.push({ area, pass, note: what });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} [${area}] ${what}`);
};
const fatal = (m: string): never => { console.error(`[concurrency] FATAL: ${m}`); process.exit(1); };
setTimeout(() => fatal('overall timeout'), 420_000);

// ---------------------------------------------------------------------------
// synthetic applicants: everything differs, so any leak is unmistakable
// ---------------------------------------------------------------------------
const FIRST = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Hank', 'Ivy', 'Jack', 'Kim', 'Liam'];
const LAST = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu'];
const CITY = ['Albany', 'Bakersfield', 'Clearwater', 'Dallas', 'Elmira', 'Fresno', 'Gainesville', 'Houston', 'Ithaca', 'Jamul', 'Kissimmee', 'Laredo'];
const STATE = ['NY', 'CA', 'FL', 'TX']; // the fake's state select offers these four
interface Applicant {
  i: number; firstName: string; lastName: string; mobileNumber: string; email: string; dateOfBirth: string;
  address1: string; city: string; state: string; zip: string; code: string; answers: Record<string, string>;
}
const applicants: Applicant[] = Array.from({ length: N }, (_, i) => ({
  i,
  firstName: `${FIRST[i % FIRST.length]}${RUN}`,
  lastName: `${LAST[i % LAST.length]}${FAIL_ONE && i === 1 ? 'NOIFRAME' : ''}${i}`,
  mobileNumber: `555010${String(1000 + i).slice(-4)}`,
  email: `${FIRST[i % FIRST.length].toLowerCase()}${i}.${RUN.toLowerCase()}@example.com`,
  dateOfBirth: `${1975 + i}-0${(i % 9) + 1}-1${i % 9}`,
  address1: `${(i + 1) * 111} ${LAST[i % LAST.length]} Street`,
  city: CITY[i % CITY.length],
  state: STATE[i % STATE.length],
  zip: String((i + 1) * 11111).padStart(5, '0').slice(-5),
  code: String(100000000 + Math.floor(Math.random() * 899999999)),
  answers: { deliveryExperience: ['none', 'under_1', '1_3', 'over_3'][i % 4], scheduleType: ['full_time', 'part_time', 'flexible'][i % 3], weekends: ['yes', 'no', 'sometimes'][i % 3], startTiming: 'immediately', driversLicense: i % 2 ? 'yes' : 'no' },
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
class AppSocket {
  ws!: WebSocket;
  all: AppServerMsg[] = [];
  views: ApplicationView[] = [];
  raw: string[] = [];
  constructor(public label: string, private cookie: string) {}
  connect(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://localhost:${port}/ws/app`, { headers: { cookie: this.cookie } });
      this.ws.on('unexpected-response', (_r, r) => rej(new Error(`HTTP ${r.statusCode}`)));
      this.ws.on('error', rej);
      this.ws.on('open', () => res());
      this.ws.on('message', (d) => { const t = d.toString(); this.raw.push(t); const m = JSON.parse(t) as AppServerMsg; this.all.push(m); if (m.type === 'app.state') this.views.push(m.application); });
    });
  }
  send(m: object): void { this.ws.send(JSON.stringify({ ts: now(), ...m })); }
  get view(): ApplicationView | undefined { return this.views[this.views.length - 1]; }
  async waitView(pred: (v: ApplicationView) => boolean, ms: number, what: string): Promise<ApplicationView> {
    const t0 = now();
    while (now() - t0 < ms) { const v = this.view; if (v && pred(v)) return v; await sleep(100); }
    throw new Error(`[${this.label}] timeout waiting for ${what}; last: ${JSON.stringify(this.view)}`);
  }
  errors(code: string): number { return this.all.filter((m) => m.type === 'app.error' && m.code === code).length; }
  close(): Promise<void> { return new Promise((r) => { if (this.ws.readyState !== WebSocket.OPEN) return r(); this.ws.once('close', () => r()); this.ws.close(); }); }
}

interface Run {
  a: Applicant; id: string; cookie: string; sockets: AppSocket[]; s: AppSocket;
  tAddress: number; tCode: number; tLink: number; url: string | null; final: ApplicationView | null; error?: string;
}

// ---- barrier: every applicant reaches the address step, then all Continue at once ----
let arrived = 0; let release: () => void = () => {};
const gate = new Promise<void>((r) => { release = r; });
const arrive = async () => { arrived++; if (arrived === N) release(); await gate; };

// ---- developer channel: what each Website B context actually received (acks echo the page's values) ----
const dev: ServerMsg[] = [];
const devWs = new WebSocket(`ws://localhost:${port}/ws`);
devWs.on('message', (d) => dev.push(JSON.parse(d.toString()) as ServerMsg));

// ---- database watchers ----
const db = new Database(resolve(dataDir, 'automation.db'), { readonly: true });
const LIVE = "('allocating','preparing','ready','submitting','paused')";
let doubleAllocation: string | null = null;
let maxLive = 0;
const liveSamples: number[] = [];
const watcher = setInterval(() => {
  try {
    const dup = db.prepare(`SELECT profile_id, COUNT(*) n FROM assignments WHERE state IN ${LIVE} GROUP BY profile_id HAVING n > 1`).all() as { profile_id: string; n: number }[];
    if (dup.length && !doubleAllocation) { doubleAllocation = JSON.stringify(dup); console.error(`  !!! DOUBLE ALLOCATION ${doubleAllocation}`); }
    const live = (db.prepare(`SELECT COUNT(*) n FROM assignments WHERE state IN ${LIVE}`).get() as { n: number }).n;
    maxLive = Math.max(maxLive, live); liveSamples.push(live);
  } catch { /* busy */ }
}, 200);

// ---- resource sampler: only the service's own process tree (its Node + the Chromium it launched) ----
interface Sample { t: number; chromeRss: number; chromeProcs: number; nodeRss: number; cpu: number }
const samples: Sample[] = [];
let lastJiffies = new Map<number, number>(); let lastT = 0;
const sampler = setInterval(() => {
  try {
    const ps = execSync('ps -eo pid,ppid,rss,args --no-headers', { encoding: 'utf8' }).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean) as RegExpExecArray[];
    const rows = ps.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) / 1024, args: m[4] }));
    const roots = rows.filter((r) => /start-fake\.ts|src\/service\/main/.test(r.args) && !/tsx\s+dev|\/bin\/sh|npm/.test(r.args)).map((r) => r.pid);
    const tree = new Set<number>(roots);
    let grew = true; while (grew) { grew = false; for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true; } }
    let chromeRss = 0, chromeProcs = 0, nodeRss = 0, jiff = 0; const cur = new Map<number, number>();
    for (const r of rows) {
      if (!tree.has(r.pid)) continue;
      if (/chrome/.test(r.args)) { chromeRss += r.rss; chromeProcs++; } else nodeRss += r.rss;
      try { const st = readFileSync(`/proc/${r.pid}/stat`, 'utf8').split(') ')[1].split(' '); const j = Number(st[11]) + Number(st[12]); cur.set(r.pid, j); jiff += j - (lastJiffies.get(r.pid) ?? j); } catch { /* gone */ }
    }
    const t = now(); const cpu = lastT ? (jiff / 100) / ((t - lastT) / 1000) * 100 : 0; // 100 jiffies/s -> percent of one core
    lastJiffies = cur; lastT = t;
    samples.push({ t, chromeRss, chromeProcs, nodeRss, cpu });
  } catch { /* ps unavailable */ }
}, 1000);

// ---------------------------------------------------------------------------
// optional pool preparation: an expired profile competes for allocation
// ---------------------------------------------------------------------------
if (EXPIRE_ONE) {
  const ps = new ProfileStore(openDb(resolve(dataDir, 'automation.db')), Vault.load(dataDir), 'concurrency-test');
  const expired = readFileSync(resolve(process.cwd(), 'dev/fake-b/profile.expired.json'), 'utf8');
  ps.insert(`expired-${RUN}`, `expired-${RUN}@test`, expired);
  console.log(`[concurrency] inserted an expired profile expired-${RUN} into the pool`);
}

// ---------------------------------------------------------------------------
// admin page watched live (Playwright)
// ---------------------------------------------------------------------------
let adminPage: Page | null = null;
let adminBrowser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
if (WATCH_ADMIN) {
  adminBrowser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  adminPage = await adminBrowser.newPage();
  await adminPage.goto(`${base}/admin/accounts`);
  await adminPage.waitForSelector('#verifiedCount');
}

// ---------------------------------------------------------------------------
// one applicant, end to end, overlapping with the others
// ---------------------------------------------------------------------------
async function runApplicant(a: Applicant, created: { id: string; cookie: string }): Promise<Run> {
  const run: Run = { a, id: created.id, cookie: created.cookie, sockets: [], s: null as unknown as AppSocket, tAddress: 0, tCode: 0, tLink: 0, url: null, final: null };
  const tag = `#${a.i} ${a.firstName}`;
  const open = async () => { const s = new AppSocket(tag, created.cookie); await s.connect(); run.sockets.push(s); run.s = s; return s; };
  try {
    const s = await open();
    await s.waitView((v) => v.id === created.id, 5000, 'initial view');
    s.send({ type: 'app.update', fields: { firstName: a.firstName, lastName: a.lastName, mobileNumber: a.mobileNumber, email: a.email } });
    s.send({ type: 'app.step', step: 'dob', completedStep: 'contact' });
    s.send({ type: 'app.update', fields: { dateOfBirth: a.dateOfBirth } });
    s.send({ type: 'app.step', step: 'address', completedStep: 'dob' });
    s.send({ type: 'app.update', fields: { address1: a.address1, city: a.city, state: a.state, zip: a.zip } });
    await s.waitView((v) => v.missingFields.length === 0, 5000, 'fields saved');

    await arrive();                       // everyone Continues off the address step together
    run.tAddress = now();
    s.send({ type: 'app.address_completed' });
    s.send({ type: 'app.address_completed' }); // double click
    s.send({ type: 'app.step', step: 'code', completedStep: 'address' });
    await s.waitView((v) => v.state === 'processing', 10_000, 'processing');

    // Overlap stages: later applicants type their code later, so at any moment one is finalising an
    // address, another is submitting, another is in the iframe flow.
    await sleep(800 * a.i);
    // Some applicants send the code before their address is finalised (held), others after.
    if (a.i % 2 === 0) await s.waitView((v) => v.automation.phase === 'awaiting_code' || v.state !== 'processing', 90_000, 'awaiting code');
    run.tCode = now();
    s.send({ type: 'app.verify', code: a.code });
    s.send({ type: 'app.verify', code: a.code }); // double submit
    s.send({ type: 'app.step', step: 'experience', completedStep: 'code' });
    for (const [k, v] of Object.entries(a.answers)) s.send({ type: 'app.answers', answers: { [k]: v } });

    if (DROP_ONE && a.i === 1) {
      await sleep(1500);
      await s.close();
      await sleep(2500);
      const s2 = await open();
      await s2.waitView((v) => v.id === created.id, 5000, 'view after reconnect');
      check('disconnect/resume', s2.view!.fields.firstName === a.firstName && s2.view!.answers.scheduleType === a.answers.scheduleType && s2.view!.state !== 'started', `${tag}: resumed with its own data, state ${s2.view!.state}`);
    }

    const done = await run.s.waitView((v) => v.generatedUrl !== null || v.state === 'problem', 240_000, 'link or problem');
    run.tLink = now();
    run.url = done.generatedUrl;
    if (done.state === 'problem') { run.final = done; return run; }
    run.s.send({ type: 'app.step', step: 'complete', final: true });
    if (!SKIP_CTA.has(a.i)) { run.s.send({ type: 'app.link_opened' }); run.s.send({ type: 'app.link_opened' }); }
    if (NO_VERIFY) { await sleep(4000); run.final = run.s.view!; return run; }
    run.final = await run.s.waitView((v) => v.state === 'completed', 120_000, 'verified');
    return run;
  } catch (e) {
    run.error = e instanceof Error ? e.message : String(e);
    run.final = run.s?.view ?? null;
    return run;
  }
}

// ---------------------------------------------------------------------------
// go
// ---------------------------------------------------------------------------
// accounts held for review or taken by applicants of earlier runs go back into rotation (the operator's action in production)
async function releaseHeldAccounts(baseUrl: string): Promise<number> {
  const accounts = ((await (await fetch(`${baseUrl}/api/accounts`)).json()) as { accounts: { id: string; reservation: unknown }[] }).accounts.filter((a) => a.reservation);
  for (const a of accounts) await fetch(`${baseUrl}/api/accounts/${a.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'release' }) });
  return accounts.length;
}
await releaseHeldAccounts(base);
console.log(`[concurrency] ${N} applicant(s), run ${RUN}${FAIL_ONE ? ', #1 fails at the iframe' : ''}${DROP_ONE ? ', #1 drops its socket' : ''}${EXPIRE_ONE ? ', one expired profile in the pool' : ''}${SKIP_CTA.size ? `, no CTA for #${[...SKIP_CTA].join(',#')}` : ''}${NO_VERIFY ? ', nobody verifies' : ''}`);
const poolBefore = db.prepare("SELECT id, label, state, session_saved_at FROM profiles").all() as { id: string; label: string; state: string; session_saved_at: number | null }[];
const usable = poolBefore.filter((p) => p.state === 'available' || p.state === 'cooldown').length;
console.log(`[concurrency] pool: ${poolBefore.map((p) => `${p.label}:${p.state}`).join(' ')}`);

// rapid start: all applications created within the same instant
const t0 = now();
const created = await Promise.all(applicants.map(async () => {
  const r = await fetch(`${base}/api/applications`, { method: 'POST' });
  if (r.status !== 201) throw new Error(`create ${r.status}`);
  return { id: ((await r.json()) as { application: ApplicationView }).application.id, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
}));
console.log(`[concurrency] ${N} applications created in ${now() - t0} ms`);
check('rapid start', new Set(created.map((c) => c.id)).size === N && new Set(created.map((c) => c.cookie)).size === N, 'unique application ids and session cookies');

const runs = await Promise.all(applicants.map((a, i) => runApplicant(a, created[i])));
clearInterval(watcher); clearInterval(sampler);
await sleep(1500); // let the last release / session write-back land
for (const r of runs) console.log(`  #${r.a.i} ${r.a.firstName}: state=${r.final?.state} url=${r.url ?? '-'}${r.error ? ' ERROR ' + r.error.split('\n')[0] : ''}`);

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------
const failIdx = FAIL_ONE ? 1 : -1;
const okRuns = runs.filter((r) => r.a.i !== failIdx);
const expectedFinal = NO_VERIFY ? 'link_ready' : 'completed';

// -- outcomes
check('outcome', okRuns.every((r) => !r.error && r.final?.state === expectedFinal), `${okRuns.length} applicant(s) reached ${expectedFinal}${okRuns.some((r) => r.error) ? ': ' + okRuns.filter((r) => r.error).map((r) => `#${r.a.i} ${r.error}`).join(' | ') : ''}`);
if (FAIL_ONE) {
  const f = runs[1];
  check('one-workflow failure isolation', f.final?.state === 'problem' && f.final.problem?.code === 'IFRAME_NOT_FOUND' && f.url === null, `#1 became a retryable problem (${f.final?.problem?.code}) with no link`);
  check('one-workflow failure isolation', !/iframe|selector|frame/i.test(f.final?.problem?.message ?? ''), 'its applicant message is non-technical');
}

// -- map workflows -> applications from durable events
const ids = runs.map((r) => r.id);
const q = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Record<string, unknown>[];
const startedEvents = q(`SELECT application_id, workflow_id, at FROM application_events WHERE type = 'automation_started' AND application_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids) as { application_id: string; workflow_id: string; at: number }[];
const wfToApp = new Map(startedEvents.map((e) => [e.workflow_id, e.application_id]));
const appOf = (wf: string) => runs.find((r) => r.id === wfToApp.get(wf));
check('application/workflow mapping', new Set(startedEvents.map((e) => e.workflow_id)).size === startedEvents.length, 'workflow ids are unique across applications');
check('application/workflow mapping', okRuns.every((r) => startedEvents.filter((e) => e.application_id === r.id).length === 1), 'exactly one workflow per successful application (double clicks did not start a second)');
const asgRows = q(`SELECT workflow_id, profile_id, state, outcome_code, result_url, link_state, created_at FROM assignments WHERE workflow_id IN (${startedEvents.map(() => '?').join(',')})`, ...startedEvents.map((e) => e.workflow_id)) as { workflow_id: string; profile_id: string; state: string; outcome_code: string | null; result_url: string | null; link_state: string; created_at: number }[];

// -- profile allocation
check('profile allocation', doubleAllocation === null, doubleAllocation ? `two live workflows shared a profile: ${doubleAllocation}` : `no profile ever had two live assignments (${liveSamples.length} samples)`);
const liveProfiles = q(`SELECT profile_id, COUNT(*) n FROM assignments WHERE state IN ${LIVE} GROUP BY profile_id`);
// Without verification the workflows keep monitoring Website B (bounded by verification.timeoutMs) and hold their profiles.
check('profile allocation', NO_VERIFY ? liveProfiles.length === okRuns.length : liveProfiles.length === 0, NO_VERIFY ? `${liveProfiles.length} workflow(s) still monitoring for verification, holding their profiles (by design, up to verification.timeoutMs)` : 'no live assignment left after the run');
if (EXPECT_PROFILES !== null) {
  check('pool exhaustion queue', maxLive <= EXPECT_PROFILES, `at most ${maxLive} workflow(s) live at once with ${EXPECT_PROFILES} profiles`);
  const waiting = q(`SELECT application_id FROM application_events WHERE type = 'automation_waiting_for_capacity' AND application_id IN (${ids.map(() => '?').join(',')})`, ...ids).length;
  check('pool exhaustion queue', waiting >= N - EXPECT_PROFILES, `${waiting} applicant(s) recorded as waiting for capacity (expected >= ${N - EXPECT_PROFILES})`);
  // FIFO: queued workflows get their profile in the order they asked
  const queued = startedEvents.filter((e) => asgRows.find((a) => a.workflow_id === e.workflow_id)!.created_at - e.at > 500).sort((x, y) => x.at - y.at);
  const served = [...queued].sort((x, y) => asgRows.find((a) => a.workflow_id === x.workflow_id)!.created_at - asgRows.find((a) => a.workflow_id === y.workflow_id)!.created_at);
  check('pool exhaustion queue', queued.every((e, i) => e.workflow_id === served[i].workflow_id), `${queued.length} queued workflow(s) were served first-come-first-served`);
  check('pool exhaustion queue', okRuns.every((r) => r.final?.state === expectedFinal), 'every queued applicant eventually completed (no timeout, no data loss)');
}

// -- Website B context contents (field acks echo the page's own values) and address isolation
const acks = dev.filter((m) => m.type === 'field.ack' && m.workflowId && wfToApp.has(m.workflowId)) as Extract<ServerMsg, { type: 'field.ack' }>[];
let leaks: string[] = [];
let ackCount = 0;
for (const m of acks) {
  const r = appOf(m.workflowId)!; const a = r.a; ackCount++;
  const expect: Record<string, string> = { firstName: a.firstName, lastName: a.lastName, mobileNumber: a.mobileNumber, address1: a.address1, city: a.city, state: a.state, zip: a.zip };
  if (m.field in expect && m.value !== expect[m.field] && !(m.field === 'city' && m.value === 'Springfield') && !(m.field === 'zip' && m.value === '10099')) leaks.push(`${m.workflowId.slice(0, 8)} ${m.field}="${m.value}" expected "${expect[m.field]}"`);
  for (const other of applicants) if (other.i !== a.i && [other.firstName, other.lastName, other.address1, other.email].includes(m.value)) leaks.push(`${m.workflowId.slice(0, 8)} ${m.field} holds #${other.i}'s value`);
}
check('applicant data isolation', ackCount > 0 && leaks.length === 0, leaks.length ? leaks.slice(0, 5).join('; ') : `${ackCount} Website B field values checked across ${wfToApp.size} contexts, none foreign`);
const finalizations = dev.filter((m) => m.type === 'event' && m.workflowId && wfToApp.has(m.workflowId) && /address autocomplete finalized|final address verified/.test(m.name));
check('BrowserContext isolation', okRuns.every((r) => finalizations.some((m) => m.type === 'event' && wfToApp.get(m.workflowId!) === r.id)), `address finalisation ran inside each applicant's own context (${finalizations.length} events)`);
const finalAddr = q(`SELECT id, address1, city, address_state, zip FROM applications WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) as { id: string; address1: string; city: string; address_state: string; zip: string }[];
check('applicant data isolation', runs.every((r) => { const row = finalAddr.find((x) => x.id === r.id)!; return row.address1 === r.a.address1 && row.city === r.a.city && row.address_state === r.a.state && row.zip === r.a.zip; }), 'stored addresses still belong to their applicants');

// -- generated URL ownership
const urls = okRuns.map((r) => r.url!);
check('generated URL ownership', urls.every(Boolean) && new Set(urls).size === urls.length, `${urls.length} distinct generated URLs`);
const resultMsgs = dev.filter((m) => m.type === 'result' && m.workflowId && wfToApp.has(m.workflowId)) as Extract<ServerMsg, { type: 'result' }>[];
check('generated URL ownership', okRuns.every((r) => resultMsgs.some((m) => wfToApp.get(m.workflowId) === r.id && m.url === r.url)), 'each workflow produced exactly the URL its application received');
check('generated URL ownership', runs.every((r) => r.sockets.every((s) => s.views.every((v) => v.generatedUrl === null || v.generatedUrl === r.url))), 'no applicant socket ever saw a different URL, even briefly');
const dbUrls = q(`SELECT id, generated_url FROM applications WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) as { id: string; generated_url: string | null }[];
check('generated URL ownership', okRuns.every((r) => dbUrls.find((x) => x.id === r.id)!.generated_url === r.url) && asgRows.filter((x) => x.result_url).every((x) => appOf(x.workflow_id)!.url === x.result_url), 'persisted URLs match per application and per assignment');

// -- WebSocket isolation
let wsLeaks: string[] = [];
for (const r of runs) {
  const dump = r.sockets.map((s) => s.raw.join('\n')).join('\n');
  for (const s of r.sockets) for (const v of s.views) if (v.id !== r.id) wsLeaks.push(`#${r.a.i} received application ${v.id}`);
  for (const o of runs) if (o !== r) for (const needle of [o.id, o.a.firstName, o.a.lastName, o.a.email, o.a.mobileNumber, o.url ?? '\u0000']) if (needle && dump.includes(needle)) wsLeaks.push(`#${r.a.i} saw #${o.a.i}'s ${needle.slice(0, 20)}`);
  for (const needle of ['workflowId', 'profile', 'pool', 'fake1', 'fake2', 'storageState', 'cookie', 'selector', ...startedEvents.map((e) => e.workflow_id)]) if (dump.includes(needle)) wsLeaks.push(`#${r.a.i} saw "${needle.slice(0, 12)}"`);
}
check('WebSocket isolation', wsLeaks.length === 0, wsLeaks.length ? wsLeaks.slice(0, 5).join('; ') : `${runs.reduce((n, r) => n + r.sockets.reduce((m, s) => m + s.all.length, 0), 0)} applicant messages, none carried another application, a workflow id, pool or account detail`);

// -- verification codes
let codeLeaks: string[] = [];
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
for (const t of tables) for (const row of q(`SELECT * FROM "${t}"`)) for (const [c, v] of Object.entries(row)) if (typeof v === 'string' && applicants.some((a) => v.includes(a.code))) codeLeaks.push(`${t}.${c}`);
for (const r of runs) for (const s of r.sockets) for (const a of applicants) if (s.raw.join('').includes(a.code)) codeLeaks.push(`socket #${r.a.i} echoed a code`);
if (dev.some((m) => JSON.stringify(m).includes(applicants[0].code) || applicants.some((a) => JSON.stringify(m).includes(a.code)))) codeLeaks.push('developer channel carried a code');
if (SERVICE_LOG && existsSync(SERVICE_LOG)) { const log = readFileSync(SERVICE_LOG, 'utf8'); for (const a of applicants) if (log.includes(a.code)) codeLeaks.push('service log'); }
check('verification-code isolation', codeLeaks.length === 0, codeLeaks.length ? [...new Set(codeLeaks)].join(', ') : `${N} distinct codes: absent from every table, every applicant socket, the developer channel${SERVICE_LOG ? ' and the service log' : ''}`);
const codeEvents = q(`SELECT application_id, workflow_id FROM application_events WHERE type = 'verification_received' AND application_id IN (${ids.map(() => '?').join(',')})`, ...ids) as { application_id: string; workflow_id: string }[];
check('verification-code isolation', codeEvents.every((e) => wfToApp.get(e.workflow_id) === e.application_id) && runs.every((r) => codeEvents.filter((e) => e.application_id === r.id).length <= 1), 'each code was handed to its own workflow exactly once (duplicate verify rejected)');
check('duplicate requests', runs.every((r) => r.s.errors('INVALID_STATE') >= 1 || r.sockets.some((s) => s.errors('INVALID_STATE') >= 1)), 'the second app.verify was rejected as INVALID_STATE');

// -- session write-back isolation
const vault = Vault.load(dataDir);
const profRows = q(`SELECT * FROM profiles`) as { id: string; label: string; state: string; session_saved_at: number | null; storage_state_enc: Buffer; nonce: Buffer; data_key_enc: Buffer; key_version: number }[];
let wbLeaks: string[] = [];
let wbChecked = 0;
const usedProfiles = new Map<string, { workflow_id: string; created_at: number }[]>();
for (const a of asgRows) { const list = usedProfiles.get(a.profile_id) ?? []; list.push({ workflow_id: a.workflow_id, created_at: a.created_at }); usedProfiles.set(a.profile_id, list); }
for (const [profileId, list] of usedProfiles) {
  list.sort((x, y) => x.created_at - y.created_at);
  const lastOk = [...list].reverse().find((x) => { const r = appOf(x.workflow_id); return r && r.a.i !== failIdx && r.url; });
  if (!lastOk) continue;
  const p = profRows.find((x) => x.id === profileId)!;
  const state = JSON.parse(vault.decrypt(p.id, { ciphertext: p.storage_state_enc, nonce: p.nonce, dataKeyEnc: p.data_key_enc, keyVersion: p.key_version })) as { cookies: { name: string; value: string }[] };
  const who = decodeURIComponent(state.cookies.find((c) => c.name === 'lastApplicant')?.value ?? '');
  const expected = appOf(lastOk.workflow_id)!.a.firstName;
  wbChecked++;
  if (who !== expected) wbLeaks.push(`${p.label} holds session of "${who}", expected "${expected}"`);
  if (!(p.session_saved_at! >= lastOk.created_at)) wbLeaks.push(`${p.label} session_saved_at not updated`);
  const refreshed = q(`SELECT workflow_id FROM profile_events WHERE profile_id = ? AND to_state = 'session_refreshed' AND workflow_id IN (${list.map(() => '?').join(',')})`, p.id, ...list.map((x) => x.workflow_id));
  if (refreshed.some((e) => !list.some((x) => x.workflow_id === e.workflow_id))) wbLeaks.push(`${p.label} refreshed by a foreign workflow`);
}
if (!NO_VERIFY) check('refreshed session writeback', wbChecked > 0 && wbLeaks.length === 0, wbLeaks.length ? wbLeaks.join('; ') : `${wbChecked} profile session(s) re-saved, each holding exactly the applicant that last used it`);

// -- expired profile
if (EXPIRE_ONE) {
  const exp = profRows.find((p) => p.label === `expired-${RUN}`)!;
  const reassigned = dev.filter((m) => m.type === 'event' && /profile expired, reassigning/.test(m.name) && m.workflowId && wfToApp.has(m.workflowId));
  check('one profile expires', exp.state === 'expired', `expired profile is out of rotation (state ${exp.state})`);
  check('one profile expires', reassigned.length >= 1 && okRuns.every((r) => r.final?.state === expectedFinal), `${reassigned.length} workflow(s) reassigned away from it; every applicant still completed`);
  check('one profile expires', reassigned.every((m) => m.type === 'event' && startedEvents.filter((e) => e.workflow_id === m.workflowId).length === 1), 'the reassigned workflow kept its application');
}

// -- visited / verified independence
const linkRows = q(`SELECT id, link_state, final_link_clicked_at, visited_at, verified_at FROM applications WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) as { id: string; link_state: string; final_link_clicked_at: number | null; visited_at: number | null; verified_at: number | null }[];
for (const r of okRuns) {
  const row = linkRows.find((x) => x.id === r.id)!;
  const clicked = !SKIP_CTA.has(r.a.i);
  const ctaEvents = q(`SELECT COUNT(*) n FROM application_events WHERE application_id = ? AND type = 'final_cta_clicked'`, r.id)[0].n as number;
  const visitedEvents = q(`SELECT COUNT(*) n FROM application_events WHERE application_id = ? AND type = 'visited'`, r.id)[0].n as number;
  const verifiedEvents = q(`SELECT COUNT(*) n FROM application_events WHERE application_id = ? AND type = 'verified'`, r.id)[0].n as number;
  // visited = the applicant clicked; verified = Website B showed the success text. An applicant who never clicks is verified without ever being visited.
  check('visited/verified independence', (clicked ? row.final_link_clicked_at !== null && ctaEvents === 1 && visitedEvents === 1 : row.final_link_clicked_at === null && ctaEvents === 0 && visitedEvents === 0) && (NO_VERIFY ? row.link_state === (clicked ? 'visited' : 'none') && verifiedEvents === 0 : row.link_state === 'verified' && verifiedEvents === 1),
    `#${r.a.i}: ${clicked ? 'clicked once (double click collapsed)' : 'never clicked'} → link_state ${row.link_state}, cta=${ctaEvents} visited=${visitedEvents} verified=${verifiedEvents}`);
}

// -- admin live
if (adminPage) {
  const verifiedRuns = NO_VERIFY ? [] : okRuns;
  if (verifiedRuns.length) await adminPage.waitForFunction((names: string[]) => { const t = document.querySelector('#verifiedList')!.textContent!; return names.every((n) => t.includes(n)); }, verifiedRuns.map((r) => r.a.firstName), { timeout: 20_000 }).catch(() => {});
  const listText = await adminPage.locator('#verifiedList').innerText();
  const rowsFor = (r: Run) => adminPage!.locator(`.vrow:has-text("${r.a.firstName} ${r.a.lastName}")`);
  let adminOk = true; const notes: string[] = [];
  for (const r of verifiedRuns) {
    const n = await rowsFor(r).count();
    const text = n ? await rowsFor(r).first().innerText() : '';
    const asg = asgRows.filter((x) => wfToApp.get(x.workflow_id) === r.id).sort((x, y) => y.created_at - x.created_at)[0];
    const label = profRows.find((p) => p.id === asg?.profile_id)?.label ?? '?';
    const ok = n === 1 && text.includes(`APP-${r.id.slice(0, 6).toUpperCase()}`) && text.includes(label) && /Current|Needs attention/.test(text);
    if (!ok) { adminOk = false; notes.push(`#${r.a.i}: rows=${n} label=${label} text="${text.replace(/\s+/g, ' ').slice(0, 80)}"`); }
  }
  if (FAIL_ONE && listText.includes(runs[1].a.firstName)) { adminOk = false; notes.push('failed applicant listed as verified'); }
  for (const r of runs.filter((x) => NO_VERIFY || x.a.i === failIdx)) if (listText.includes(r.a.firstName)) { adminOk = false; notes.push(`#${r.a.i} listed although not verified`); }
  const order = await adminPage.locator('.vrow time').evaluateAll((els) => els.map((e) => Date.parse(e.getAttribute('datetime')!)));
  const sorted = order.every((t, i) => i === 0 || order[i - 1] >= t);
  check('admin live updates', adminOk && sorted, notes.length ? notes.join(' | ') : `${verifiedRuns.length} verified row(s) appeared live, once each, with the right APP id and account; newest first`);
  await adminBrowser!.close();
}

// -- database consistency
const issues: string[] = [];
const stuck = q("SELECT label, state FROM profiles WHERE state IN ('reserved','starting','active')");
const orphanLive = q(`SELECT workflow_id FROM assignments WHERE state IN ${LIVE}`);
if (NO_VERIFY) { if (stuck.length !== okRuns.length || orphanLive.length !== okRuns.length) issues.push(`expected ${okRuns.length} monitoring workflows, found ${orphanLive.length} live / ${stuck.length} active profiles`); }
else { if (stuck.length) issues.push(`profiles stuck live: ${JSON.stringify(stuck)}`); if (orphanLive.length) issues.push(`live assignments after the run: ${orphanLive.length}`); }
const staleLease = q(`SELECT workflow_id FROM assignments WHERE state IN ${LIVE} AND lease_expires_at < ?`, now());
if (staleLease.length) issues.push(`expired leases still live: ${staleLease.length}`);
const dupUrl = q("SELECT generated_url, COUNT(*) n FROM applications WHERE generated_url IS NOT NULL GROUP BY generated_url HAVING n > 1");
if (dupUrl.length) issues.push(`generated URL shared by applications: ${JSON.stringify(dupUrl)}`);
const dupVerified = q("SELECT application_id, COUNT(*) n FROM application_events WHERE type = 'verified' GROUP BY application_id HAVING n > 1");
if (dupVerified.length) issues.push(`duplicate verified events: ${dupVerified.length}`);
const badProc = q(`SELECT a.id FROM applications a LEFT JOIN assignments s ON s.workflow_id = a.processed_workflow_id WHERE a.processed_workflow_id IS NOT NULL AND s.workflow_id IS NOT NULL AND s.profile_id != a.processed_profile_id`);
if (badProc.length) issues.push(`processed_profile_id disagrees with the assignment: ${badProc.length}`);
const crossApp = q(`SELECT workflow_id FROM application_events WHERE workflow_id IS NOT NULL GROUP BY workflow_id HAVING COUNT(DISTINCT application_id) > 1`);
if (crossApp.length) issues.push(`a workflow id appears under two applications: ${crossApp.length}`);
const processingLeft = q(`SELECT id FROM applications WHERE state = 'processing' AND id IN (${ids.map(() => '?').join(',')})`, ...ids);
if (processingLeft.length) issues.push(`applications left processing: ${processingLeft.length}`);
check('database consistency', issues.length === 0, issues.length ? issues.join('; ') : 'no stuck profiles, no live or stale assignments, unique URLs, single verified events, processed account matches the assignment, no workflow under two applications');

// -- resources
const peak = samples.reduce((m, s) => ({ chromeRss: Math.max(m.chromeRss, s.chromeRss), chromeProcs: Math.max(m.chromeProcs, s.chromeProcs), nodeRss: Math.max(m.nodeRss, s.nodeRss), cpu: Math.max(m.cpu, s.cpu) }), { chromeRss: 0, chromeProcs: 0, nodeRss: 0, cpu: 0 });
const busy = samples.filter((x) => x.cpu > 0); const avgCpu = busy.length ? busy.reduce((a, x) => a + x.cpu, 0) / busy.length : 0;
const durations = okRuns.filter((r) => r.tCode && r.tLink).map((r) => r.tLink - r.tCode);
const startToLink = okRuns.filter((r) => r.tAddress && r.tLink).map((r) => r.tLink - r.tAddress);
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
console.log('\n[concurrency] resources (approx.)');
console.log(`  concurrency ${N} · max live workflows ${maxLive} · usable profiles ${usable}`);
console.log(`  Chromium: peak ${Math.round(peak.chromeRss)} MB RSS across up to ${peak.chromeProcs} processes · Node service: peak ${Math.round(peak.nodeRss)} MB`);
console.log(`  CPU of the service tree (percent of one core; 200% = two cores): peak ${Math.round(peak.cpu)}% · average ${Math.round(avgCpu)}% over ${samples.length} s`);
console.log(`  workflow: address step → link avg ${avg(startToLink)} ms (incl. queue wait) · code → link avg ${avg(durations)} ms`);

// -- summary
console.log('\n[concurrency] summary');
const areas = [...new Set(results.map((r) => r.area))];
for (const area of areas) { const rs = results.filter((r) => r.area === area); console.log(`  ${rs.every((r) => r.pass) ? 'PASS' : 'FAIL'}  ${area}`); }
db.close(); devWs.close();
for (const r of runs) for (const s of r.sockets) s.close().catch(() => {});
console.log(failures ? `[concurrency] ${failures} check(s) failed` : '[concurrency] all checks passed');
process.exit(failures ? 1 : 0);
