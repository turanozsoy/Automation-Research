/**
 * Drives the PUBLIC Shipzora application at / in a headless browser like an applicant, against
 * the running service + fake Website B: start, contact, date of birth, address, the verification
 * screen appearing at once while the workflow prepares, the code, the job questions, a refresh
 * that resumes, the final screen with a live CTA, visited, verified, and no technical detail on
 * any public screen.
 *   npm run fake-b  +  npm run start:fake  (an imported fake account), then: npm run e2e:apply
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';

const port = Number(process.env.PORT ?? 3000);
const base = `http://localhost:${port}`;
const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data/fake');
const CODE = '482913756';
const LAST = `Rivera${Date.now().toString(36).slice(-4).toUpperCase()}`; // unique per run: the fake DB persists between runs
const FULL = `Jordan ${LAST}`;
let failures = 0;
const check = (cond: unknown, what: string) => { if (!cond) { failures++; console.error(`  FAIL: ${what}`); } else console.log(`  ok: ${what}`); };
const fail = (m: string): never => { console.error('[e2e:apply] FATAL:', m); process.exit(1); };
const TECH = /workflow|profile|pool|selector|iframe|playwright|chromium|browsercontext|storagestate|reconcil|LOGIN_REQUIRED|AGREE_NOT_FOUND|wf [0-9a-f]{8}/i;

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p: Page = await ctx.newPage();
const consoleErrors: string[] = [];
p.on('pageerror', (e) => consoleErrors.push(e.message));
const text = () => p.locator('main').innerText();
const noTech = async (where: string) => { const t = await text(); check(!TECH.test(t), `no technical detail on ${where}`); };
const h1 = async (expected: RegExp, timeout = 15000) => { await p.locator('main h1').filter({ hasText: expected }).first().waitFor({ timeout }); };

try {
  console.log('[e2e:apply] 1. landing + start');
  await p.goto(base);
  await h1(/Drive with Shipzora/);
  check(!(await p.evaluate(() => document.cookie)).includes('shipzora_session'), 'session cookie is not readable by page script before start');
  await noTech('landing');
  const atPath = (path: string, what: string) => check(new URL(p.url()).pathname === path, `${what} at ${path} (got ${new URL(p.url()).pathname})`);
  await p.goto(`${base}/step-3`);
  await h1(/Drive with Shipzora/);
  atPath('/', 'a step URL without an application shows the landing page');
  check((await ctx.cookies(base)).every((c) => c.name !== 'shipzora_session'), 'no application was created by opening a step URL');
  await p.getByRole('button', { name: 'Start Driving Today' }).click();
  await h1(/Tell us about yourself/);
  atPath('/step-2', 'first step');
  check((await ctx.cookies(base)).some((c) => c.name === 'shipzora_session' && c.httpOnly), 'HttpOnly session cookie set on start');
  check(/^step 1 of 7$/i.test(await p.locator('#progressLabel').innerText()), 'step badge reads Step 1 of 7');

  console.log('[e2e:apply] 2. contact: validation then continue');
  await p.getByRole('button', { name: 'Continue' }).click();
  check((await p.locator('#err-firstName').innerText()).includes('first name'), 'inline validation next to the field');
  check(await p.locator('#f-firstName').getAttribute('aria-invalid') === 'true', 'aria-invalid set on the failing field');
  await p.fill('#f-firstName', 'Jordan');
  await p.fill('#f-lastName', LAST);
  await p.fill('#f-mobileNumber', '(555) 010-7788');
  await p.fill('#f-email', 'jordan@example.com');
  check(await p.locator('#f-firstName').getAttribute('autocomplete') === 'given-name' && await p.locator('#f-mobileNumber').getAttribute('type') === 'tel', 'autocomplete/type attributes');
  await p.getByRole('button', { name: 'Continue' }).click();
  await h1(/date of birth/i);
  atPath('/step-3', 'date of birth');

  console.log('[e2e:apply] 3. date of birth');
  await p.fill('#f-dob-m', '05'); await p.fill('#f-dob-d', '17'); await p.fill('#f-dob-y', '1990');
  await p.getByRole('button', { name: 'Continue' }).click();
  await h1(/home address/i);
  atPath('/step-4', 'address');
  check((await p.locator('label[for="f-address1"]').innerText()).trim().toLowerCase() === 'street address' && /driver’s license/.test(await p.locator('#help-address1').innerText()), 'address field reads "Street address" with the license helper text');

  console.log('[e2e:apply] 4. address -> verification screen appears immediately');
  // The operations page is opened BEFORE any workflow exists for this applicant; it must pick up the verified row live.
  const admin = await ctx.newPage();
  await admin.goto(`${base}/admin/accounts`);
  await admin.waitForSelector('#verifiedCount');
  check(!(await admin.locator('#verifiedList').innerText()).includes(FULL), 'operations page does not list the applicant before they are processed');
  await p.bringToFront();
  await p.fill('#f-address1', '1 Main St');
  await p.fill('#f-city', 'Springfield');
  await p.selectOption('#f-state', 'NY');
  await p.fill('#f-zip', '10001');
  const tContinue = Date.now();
  await p.getByRole('button', { name: 'Continue' }).click();
  await h1(/Verification code/, 3000);
  atPath('/step-5', 'verification code');
  const dt = Date.now() - tContinue;
  check(dt < 1500, `verification screen shown ${dt} ms after Continue (no waiting on the address step)`);
  await noTech('verification screen');
  const dbEarly = new Database(resolve(dataDir, 'automation.db'), { readonly: true });
  const started = (dbEarly.prepare("SELECT COUNT(*) n FROM applications WHERE first_name = 'Jordan' AND last_name = ? AND state = 'processing'").get(LAST) as { n: number }).n;
  dbEarly.close();
  check(started === 1, 'background workflow started for the application while the applicant is on the code screen');

  console.log('[e2e:apply] 5. verification code (+ editable copy from the operations page)');
  check(await p.locator('#f-code').getAttribute('autocomplete') === 'one-time-code' && await p.locator('#f-code').getAttribute('inputmode') === 'numeric', 'OTP input attributes');
  const put = (values: Record<string, string | null>) => fetch(`${base}/api/admin/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) }).then((r) => r.json() as Promise<{ saved: string[]; errors: Record<string, string> }>);
  const edit = await put({ 'code.title': 'Enter your code', 'code.cta': 'Verify and continue', 'code.intro': 'Type the <b>{n}</b>-digit code from your welcome email.', 'code.label': '', 'nope.key': 'x' });
  check(edit.saved.length === 3 && /empty/.test(edit.errors['code.label'] ?? '') && /unknown/.test(edit.errors['nope.key'] ?? ''), 'content API saves valid keys, rejects empty text and unknown keys');
  await p.reload();
  await h1(/Enter your code/, 10000);
  atPath('/step-5', 'reload on the code step with edited copy');
  check((await p.locator('#help-code').innerText()) === 'Type the <b>9</b>-digit code from your welcome email.' && (await p.locator('#help-code b').count()) === 0, 'edited copy is rendered as plain text ({n} substituted, no HTML)');
  check(/Verify and continue/.test(await p.locator('button.btn-primary').innerText()), 'edited Continue button text');
  check(await p.locator('#f-code').getAttribute('name') === 'code' && await p.locator('#f-code').getAttribute('id') === 'f-code', 'field hooks unchanged by copy edits');
  const reset = await put({ 'code.title': null, 'code.cta': null, 'code.intro': null });
  check(reset.saved.length === 3, 'reset to default');
  await p.reload();
  await h1(/Verification code/, 10000);
  await p.fill('#f-code', CODE);
  await p.getByRole('button', { name: 'Continue' }).click();
  await h1(/Your experience/);
  atPath('/step-6', 'experience');

  console.log('[e2e:apply] 6. questions (card radios), refresh mid-way resumes');
  await p.getByRole('button', { name: 'Continue' }).click();
  check((await p.locator('#err-deliveryExperience').innerText()).includes('Choose one'), 'radio group validation');
  await p.getByText('1 to 3 years').click();
  await p.getByRole('button', { name: 'Continue' }).click();
  await h1(/Your schedule/);
  atPath('/step-7', 'schedule');
  await p.getByText('Part time').click();
  await p.getByText('Sometimes').click();
  await p.reload();
  await h1(/Your schedule/);
  atPath('/step-7', 'refresh on a step URL restores that step directly');
  check(await p.locator('#q-scheduleType-part_time').isChecked() && await p.locator('#q-weekends-sometimes').isChecked(), 'answers restored after refresh');
  const cookiesBefore = (await ctx.cookies(base)).find((c) => c.name === 'shipzora_session')!.value;
  await p.goto(`${base}/step-8`);
  await h1(/Your schedule/);
  atPath('/step-7', 'a step beyond the first incomplete one is clamped');
  await p.goto(base);
  await p.locator('.landing-panel h2').filter({ hasText: /Welcome back/ }).waitFor({ timeout: 15000 });
  await p.getByRole('button', { name: /Continue application/ }).click();
  await h1(/Your schedule/);
  atPath('/step-7', 'Continue application resumes the saved step');
  check((await ctx.cookies(base)).find((c) => c.name === 'shipzora_session')!.value === cookiesBefore, 'refresh and resume kept the same application session');
  await p.getByRole('button', { name: 'Back' }).click();
  await h1(/Your experience/);
  atPath('/step-6', 'header Back');
  check(await p.locator('#q-deliveryExperience-1_3').isChecked(), 'Back keeps previous answers');
  await p.goBack();
  await h1(/Your schedule/);
  atPath('/step-7', 'browser Back returns to the step left with the header arrow');
  await p.goForward();
  await h1(/Your experience/);
  atPath('/step-6', 'browser Forward');
  await p.getByRole('button', { name: 'Continue' }).click();
  await h1(/Your schedule/);
  await p.getByRole('button', { name: 'Continue' }).click();
  await h1(/Getting started/);
  atPath('/step-8', 'availability');
  await p.getByText('Right away').click();
  await p.locator('#q-driversLicense-yes + label').click();
  await p.getByRole('button', { name: 'Continue' }).click();

  console.log('[e2e:apply] 7. final screen: live CTA, visited, verified');
  await h1(/role details/i);
  const firstTitle = await p.locator('main h1').innerText();
  console.log(`  final screen first shows: "${firstTitle}"`);
  if (/Preparing/.test(firstTitle)) atPath('/preparing', 'preparing state');
  await noTech('final screen');
  const cta = p.locator('#btnViewRole');
  await cta.waitFor({ timeout: 120_000 });
  check(/your role details are ready/i.test(await p.locator('main h1').innerText()), 'CTA appeared live when the link was ready');
  await p.waitForFunction(() => location.pathname === '/completed', null, { timeout: 5000 }).catch(() => {});
  atPath('/completed', 'role-ready conversion route');
  await p.reload();
  await cta.waitFor({ timeout: 15_000 });
  atPath('/completed', 'refresh on /completed keeps the completed screen');
  check(!/hired|job offer|congratulations/i.test(await text()), 'no offer/hired wording');
  const href = await cta.getAttribute('href');
  check(!!href && /\/test\/it-worked\//.test(href), 'CTA points at this application\'s generated link');
  // The fake Website B gates every page behind its login cookie, which the applicant's browser does not have,
  // so the new tab ends on the fake's login page: assert the navigation the CTA requested, not where the fake sent it.
  const navs: string[] = [];
  ctx.on('request', (r) => { if (r.isNavigationRequest()) navs.push(r.url()); });
  const [popup] = await Promise.all([ctx.waitForEvent('page'), cta.click()]);
  await popup.waitForLoadState('domcontentloaded');
  check(navs.includes(href!), `CTA opened the generated link in a new tab (requested ${navs.join(' -> ')})`);
  await p.waitForFunction(() => /Open Role Details again|opened your role details/i.test(document.querySelector('main')!.innerText), null, { timeout: 5000 });
  await p.waitForFunction(() => /have been confirmed/i.test(document.querySelector('main')!.innerText), null, { timeout: 90_000 });
  check(true, 'verified state reached and reflected on the page');
  await noTech('final screen after verification');
  await admin.waitForFunction((name) => document.querySelector('#verifiedList')!.textContent!.includes(name), FULL, { timeout: 15000 }).catch(() => {});
  const adminAfter = await admin.locator('#verifiedList').innerText();
  const rowText = await admin.locator(`.vrow:has-text("${FULL}")`).first().innerText().catch(() => '');
  check(adminAfter.includes(FULL) && /Processed with\s*fake/i.test(rowText) && /Session\s*Current/i.test(rowText), 'operations page listed the verified applicant live (no reload), with the account used and session status');
  await admin.locator(`.vrow:has-text("${FULL}") .details`).first().click();
  await admin.waitForSelector('#dlgDetails[open]');
  const det = await admin.locator('#detList').innerText();
  check(det.includes('Workflow ID') && /Refreshed/.test(det) && !/cookie|storage|482913756|1990/.test(det), 'details drawer shows workflow and session result, no secrets or DOB');
  await admin.locator('#btnCloseDetails').click();
  const adminHtml = await admin.content();
  check(!/482913756|storage_state|"cookies"/.test(adminHtml), 'no secrets in the operations page DOM');
  check(!(await admin.locator('#rows').innerText()).includes(FULL), 'accounts table itself does not get application data');
  await admin.close();

  const mode = await (await fetch(`${base}/api/dev/browser`)).json() as { mode: string; chromium: string };
  console.log(`  automation browser mode during this run: ${mode.mode} (${mode.chromium})`);
  console.log('[e2e:apply] 8. database + internal pages');
  const db = new Database(resolve(dataDir, 'automation.db'), { readonly: true });
  const row = db.prepare("SELECT * FROM applications WHERE first_name = 'Jordan' AND last_name = ? ORDER BY created_at DESC LIMIT 1").get(LAST) as Record<string, unknown>;
  check(row.state === 'completed' && row.link_state === 'verified' && row.generated_url === href && row.final_link_clicked_at !== null, 'application row: completed, verified, url, final CTA time');
  check(row.phone === '5550107788' && row.date_of_birth === '1990-05-17' && row.address_state === 'NY' && row.email === 'jordan@example.com', 'fields persisted (phone digits only, ISO DOB)');
  const answers = JSON.parse(String(row.answers_json));
  check(answers.deliveryExperience === '1_3' && answers.scheduleType === 'part_time' && answers.weekends === 'sometimes' && answers.startTiming === 'immediately' && answers.driversLicense === 'yes', 'answers persisted');
  const types = (db.prepare('SELECT type FROM application_events WHERE application_id = ? ORDER BY id').all(row.id) as { type: string }[]).map((e) => e.type);
  for (const t of ['application_started', 'step_viewed', 'step_completed', 'validation_failed', 'address_completed', 'automation_started', 'automation_phase_changed', 'address_finalized', 'verification_received', 'generated_link_ready', 'final_step_reached', 'final_cta_clicked', 'visited', 'verified']) check(types.includes(t), `event ${t} recorded`);
  let leak = false;
  for (const t of (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((x) => x.name)) {
    for (const r of db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) for (const val of Object.values(r)) if (typeof val === 'string' && val.includes(CODE)) leak = true;
  }
  check(!leak, 'verification code not in the database');
  db.close();
  const dbg = await (await fetch(`${base}/debug`)).text();
  const adm = await (await fetch(`${base}/admin/accounts`)).text();
  check(dbg.includes('debug harness') && adm.includes('Account &amp; session management') && adm.includes('Verified applications') && adm.includes('Applicant page content') && (await fetch(`${base}/admin.css`)).status === 200, '/debug and /admin/accounts still served (with the Applicant page content section)');
  const contentList = await (await fetch(`${base}/api/admin/content`)).json() as { groups: string[]; fields: { key: string; custom: boolean; value: string }[] };
  check(contentList.groups.length === 8 && contentList.fields.some((f) => f.key === 'opt.scheduleType.part_time.label') && contentList.fields.some((f) => f.key === 'landing.pill') && contentList.fields.every((f) => !f.custom), 'content schema covers landing, steps, questions and role-ready; nothing left edited');
  check((await fetch(`${base}/debug.html`)).status === 404 && (await fetch(`${base}/index.html`)).status === 404, 'files are not reachable by guessing names');
  check((await fetch(`${base}/privacy`)).status === 200, 'footer placeholder pages respond');
  const direct = await fetch(`${base}/step-3`);
  check(direct.status === 200 && (await direct.text()).includes('/apply/apply.js') && (await fetch(`${base}/completed`)).status === 200 && (await fetch(`${base}/step-x`)).status === 404, 'server serves the applicant page for /step-n and /completed, 404 otherwise');
  check(consoleErrors.length === 0, `no page errors${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`);
} catch (e) {
  const t = await text().catch(() => '');
  fail(`${e instanceof Error ? e.message.split('\n')[0] : e}\n--- page ---\n${t.slice(0, 800)}`);
} finally {
  await browser.close();
}
console.log(failures ? `[e2e:apply] ${failures} check(s) failed` : '[e2e:apply] all checks passed');
process.exit(failures ? 1 : 0);
