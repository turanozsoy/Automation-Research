/**
 * Meta Pixel + Conversions API against a stack this test starts itself (fake Website B that never shows the success
 * text, a fake Graph API, service with a test pixel id and token). Nothing else may listen on 3001 / 3012.
 *   npm run e2e:pixel
 *  - browser pixel: base code loaded with the configured id, PageView per step, Lead with eventID when the lead step
 *    opens, CompleteRegistration with eventID when the application becomes verified
 *  - server (CAPI): Lead and CompleteRegistration with the same event_id, hashed contact details, fbc from ?fbclid,
 *    landing URL; a failed send is retried; "Mark verified" by the operator verifies the application and sends
 *    CompleteRegistration exactly once; the token never appears in the service log
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const PORT = 3012;
const base = `http://localhost:${PORT}`;
const PIXEL = '424242424242';
const TOKEN = 'test-capi-token-0123456789';
const CODE = '482913756';
let failures = 0;
const check = (ok: boolean, name: string, detail = '') => { console.log(`  ${ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const dataDir = mkdtempSync(join(tmpdir(), 'pixel-'));
const children: ChildProcess[] = [];
const logs: string[] = [];
const stop = async () => { for (const c of children) c.kill('SIGTERM'); await sleep(1500); rmSync(dataDir, { recursive: true, force: true }); };
const fatal = async (what: string): Promise<never> => { console.error(`[e2e:pixel] FATAL: ${what}`); console.error(logs.slice(-25).join('')); await stop(); process.exit(1); };
process.on('unhandledRejection', (e) => void fatal(e instanceof Error ? e.message : String(e)));
const run = (args: string[], env: Record<string, string>) => { const c = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); c.stdout.on('data', (d) => logs.push(d.toString())); c.stderr.on('data', (d) => logs.push(d.toString())); children.push(c); return c; };
const once = (args: string[], env: Record<string, string>) => new Promise<number>((res) => { const c = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); c.stderr.on('data', (d) => logs.push(d.toString())); c.on('exit', (code) => res(code ?? 1)); });

// ---- fake Graph API: records every events call; the very first call fails to prove the retry ----
interface Received { path: string; token: string | null; body: { data: Record<string, any>[]; test_event_code?: string } }
const received: Received[] = [];
let failNext = 1;
const graph = createServer((req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    const u = new URL(req.url ?? '/', 'http://x');
    received.push({ path: u.pathname, token: u.searchParams.get('access_token'), body: JSON.parse(body || '{}') });
    if (failNext > 0) { failNext--; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"simulated outage"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"events_received":1}');
  });
});
await new Promise<void>((r) => graph.listen(0, '127.0.0.1', () => r()));
const graphUrl = `http://127.0.0.1:${(graph.address() as { port: number }).port}/v21.0`;
const eventsOf = (name: string) => received.flatMap((r) => r.body.data ?? []).filter((e) => e.event_name === name);

// ---- stack ----
for (const p of [3001, PORT]) { try { await fetch(`http://localhost:${p}/`); await fatal(`port ${p} is already in use (stop the development stack first)`); } catch (e) { if (e instanceof Error && /already in use/.test(e.message)) throw e; } }
run(['dev/fake-b/server.ts'], { FAKE_B_GOOD_TO_GO_MS: '600000' });
for (let i = 0; i < 50; i++) { try { if ((await fetch('http://localhost:3001/')).ok) break; } catch { /* not yet */ } await sleep(200); }
const env = { DATA_DIR: dataDir, SITE_B_CONFIG: 'config/site-b.fake.json' };
for (const [label, key] of [['px1', 'p1'], ['px2', 'p2']]) if (await once(['dev/profile-fake.ts', 'import', '--label', label, '--account', key, '--file', 'dev/fake-b/profile.storage-state.json'], env) !== 0) await fatal(`seeding ${label} failed`);
run(['dev/start-fake.ts'], { ...env, PORT: String(PORT), HEADLESS: '1', MAX_WORKFLOWS: '2', COOLDOWN_MS: '1000', EGRESS_CHECK_INTERVAL_MS: '0', VERIFICATION_AFTER_VISIT_MS: '3000', META_PIXEL_ID: PIXEL, META_CAPI_TOKEN: TOKEN, META_GRAPH_URL: graphUrl, META_TEST_EVENT_CODE: 'TEST99', PIXEL_LEAD_STEP: 'dob' });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/apply/config`)).ok) break; } catch { /* not yet */ } await sleep(300); }
const cfg = await (await fetch(`${base}/api/apply/config`)).json() as { pixel: { id: string; leadStep: string } | null };
check(cfg.pixel?.id === PIXEL && cfg.pixel.leadStep === 'dob', 'config exposes the pixel id and the lead step (token never)', JSON.stringify(cfg.pixel));

// ---- the applicant, arriving from an ad ----
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'PixelTest/1.0 Mobile Safari' });
await ctx.route('https://connect.facebook.net/**', (r) => r.abort()); // offline: the base code's queue keeps every fbq call for inspection
const p = await ctx.newPage();
const fbqQueue = () => p.evaluate(() => (window as any).fbq && (window as any).fbq.queue ? (window as any).fbq.queue.map((a: IArguments) => Array.from(a)) : []) as Promise<unknown[][]>;
await p.goto(`${base}/?fbclid=TESTCLICK123&utm_source=fb`);
await p.waitForSelector('#btnStart');
let q = await fbqQueue();
check(q.some((c) => c[0] === 'init' && c[1] === PIXEL) && q.some((c) => c[0] === 'track' && c[1] === 'PageView'), 'landing: base code loaded with the pixel id, PageView fired', `${q.length} calls`);
check(!(await p.content()).includes(TOKEN), 'the applicant page never contains the token');

console.log('[e2e:pixel] 1. Lead when the lead step opens');
await p.click('#btnStart'); await p.waitForSelector('#f-firstName');
await p.fill('#f-firstName', 'Mia'); await p.fill('#f-lastName', 'Pixel'); await p.fill('#f-mobileNumber', '(555) 010-2244'); await p.fill('#f-email', 'Mia.Pixel@Example.com ');
await p.getByRole('button', { name: 'Continue' }).click(); await p.waitForSelector('#f-dob-m');
const appId = (await (await p.request.get(`${base}/api/applications/me`)).json() as { application: { id: string } }).application.id;
q = await fbqQueue();
const lead = q.find((c) => c[0] === 'track' && c[1] === 'Lead') as unknown[] | undefined;
check(!!lead && JSON.stringify(lead[3]) === JSON.stringify({ eventID: `${appId}:Lead` }), 'browser Lead fired once with eventID <application>:Lead', JSON.stringify(lead));
check(q.filter((c) => c[0] === 'track' && c[1] === 'PageView').length >= 3, 'PageView fired for the landing, contact and date-of-birth steps', `${q.filter((c) => c[0] === 'track' && c[1] === 'PageView').length}`);
let serverLead: Record<string, any> | undefined;
for (let i = 0; i < 60 && !serverLead; i++) { serverLead = eventsOf('Lead')[0]; if (!serverLead) await sleep(250); }
check(!!serverLead && serverLead.event_id === `${appId}:Lead` && serverLead.action_source === 'website', 'server Lead sent through the Conversions API with the same event_id');
check(received[0]?.path === `/v21.0/${PIXEL}/events` && received[0]?.token === TOKEN && received[0]?.body.test_event_code === 'TEST99', 'posted to /<pixel>/events with the token in the query and the test event code');
const u = serverLead?.user_data ?? {};
check(u.em?.[0] === sha('mia.pixel@example.com') && u.ph?.[0] === sha('15550102244') && u.fn?.[0] === sha('mia') && u.ln?.[0] === sha('pixel'), 'contact details hashed with Meta normalisation (email lowercased/trimmed, phone digits with country code)');
check(typeof u.fbc === 'string' && /TESTCLICK123$/.test(u.fbc) && typeof u.client_user_agent === 'string' && /PixelTest/.test(u.client_user_agent) && !!u.client_ip_address, 'fbc built from ?fbclid, user agent and client IP attached', JSON.stringify({ fbc: u.fbc, ua: u.client_user_agent, ip: u.client_ip_address }));
check(/fbclid=TESTCLICK123/.test(serverLead?.event_source_url ?? ''), 'event_source_url is the landing URL with its query');
check(!JSON.stringify(serverLead).includes('Mia.Pixel@') && !JSON.stringify(serverLead).includes('5550102244'), 'no plain contact detail in the server event');
// retry: the first Graph call failed (500); the second attempt carried the same Lead
await sleep(3000);
const leadCalls = received.filter((r) => (r.body.data ?? []).some((e) => e.event_name === 'Lead'));
check(leadCalls.length === 2, 'the failed first send was retried (two Lead calls, one event)', `${leadCalls.length}`);

console.log('[e2e:pixel] 2. through the application to the role link');
await p.fill('#f-dob-m', '05'); await p.fill('#f-dob-d', '17'); await p.fill('#f-dob-y', '1990'); await p.getByRole('button', { name: 'Continue' }).click();
await p.waitForSelector('#f-address1'); await p.fill('#f-address1', '1 Main St'); await p.fill('#f-city', 'Springfield'); await p.selectOption('#f-state', 'NY'); await p.fill('#f-zip', '10001'); await p.getByRole('button', { name: 'Continue' }).click();
await p.waitForSelector('#btnAddressYes'); await p.click('#btnAddressYes');
await p.waitForSelector('#f-code'); await p.fill('#f-code', CODE); await p.getByRole('button', { name: /Continue|Verify/ }).click();
await p.getByText('1 to 3 years').click(); await p.getByRole('button', { name: 'Continue' }).click();
await p.getByText('Part time').click(); await p.getByText('Sometimes').click(); await p.getByRole('button', { name: 'Continue' }).click();
await p.getByText('Right away').click(); await p.getByText('Yes', { exact: true }).click(); await p.getByRole('button', { name: 'Continue' }).click();
await p.waitForSelector('#btnViewRole', { timeout: 120_000 });
q = await fbqQueue();
check(!q.some((c) => c[0] === 'track' && c[1] === 'CompleteRegistration'), 'no CompleteRegistration before verification');
check(eventsOf('CompleteRegistration').length === 0, 'no server CompleteRegistration before verification');
const popup = ctx.waitForEvent('page');
await p.click('#btnViewRole'); await popup;
await sleep(4500); // the review window (3 s) passes without a success text: the account is under review

console.log('[e2e:pixel] 3. the operator marks the account verified: application verified, CompleteRegistration once');
type Account = { id: string; name: string; reservation: { state: string; applicationId: string | null } | null };
const accounts = (await (await fetch(`${base}/api/accounts`)).json() as { accounts: Account[] }).accounts;
const held = accounts.find((a) => a.reservation?.state === 'review');
check(!!held && held.reservation?.applicationId === appId, 'the account is under review for this application', held?.name);
const r1 = await fetch(`${base}/api/accounts/${held!.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'verified' }) });
check(r1.status === 200, 'Mark verified accepted');
let serverCR: Record<string, any> | undefined;
for (let i = 0; i < 40 && !serverCR; i++) { serverCR = eventsOf('CompleteRegistration')[0]; if (!serverCR) await sleep(250); }
check(!!serverCR && serverCR.event_id === `${appId}:CompleteRegistration` && serverCR.user_data?.em?.[0] === sha('mia.pixel@example.com'), 'server CompleteRegistration sent with the application\'s hashed contact details');
await sleep(1500);
q = await fbqQueue();
const cr = q.find((c) => c[0] === 'track' && c[1] === 'CompleteRegistration') as unknown[] | undefined;
check(!!cr && JSON.stringify(cr[3]) === JSON.stringify({ eventID: `${appId}:CompleteRegistration` }), 'browser CompleteRegistration fired with the same eventID (page still open)', JSON.stringify(cr));
const db = new Database(join(dataDir, 'automation.db'), { readonly: true });
const row = db.prepare('SELECT state, link_state, verified_at, verification_step FROM applications WHERE id = ?').get(appId) as { state: string; link_state: string; verified_at: number | null; verification_step: string };
check(row.state === 'completed' && row.link_state === 'verified' && row.verified_at !== null && row.verification_step === 'completed', 'application marked verified by the operator action', JSON.stringify(row));
const pe = db.prepare('SELECT event, status, attempts FROM pixel_events WHERE application_id = ? ORDER BY event').all(appId) as { event: string; status: string; attempts: number }[];
check(pe.length === 2 && pe.every((e) => e.status === 'sent') && pe.find((e) => e.event === 'Lead')?.attempts === 2 && pe.find((e) => e.event === 'CompleteRegistration')?.attempts === 1, 'pixel_events: both sent, Lead needed two attempts', JSON.stringify(pe));
const r2 = await fetch(`${base}/api/accounts/${held!.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'verified' }) });
await sleep(1000);
check((r2.status === 200 || r2.status === 409) && eventsOf('CompleteRegistration').length === 1, 'a second Mark verified sends nothing twice');
const list = await (await fetch(`${base}/api/admin/applications/verified`)).json() as { items: { id: string; pixel: Record<string, { status: string }> }[] };
const item = list.items.find((i) => i.id === appId);
check(!!item && item.pixel.Lead?.status === 'sent' && item.pixel.CompleteRegistration?.status === 'sent', 'operations page data carries the pixel status');
check(!logs.join('').includes(TOKEN), 'the access token never appears in the service output');
check(!db.prepare("SELECT 1 FROM application_events WHERE detail LIKE ?").get(`%${TOKEN}%`), 'the access token never appears in application events');

db.close(); await browser.close(); graph.close();
await stop();
console.log(failures ? `[e2e:pixel] ${failures} check(s) failed` : '[e2e:pixel] all checks passed');
process.exit(failures ? 1 : 0);
