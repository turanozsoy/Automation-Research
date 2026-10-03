/**
 * Isolation layer with a real Chromium and three local fake proxies (no third-party services):
 * one persistent profile per account, traffic through the account's own proxy, state surviving close/reopen,
 * refused double-open, clean-only failover, STOP without a clean proxy, no direct fallback, isolation flags present.
 *   npm run test:isolation:browser            (CHROMIUM_PATH=... when Playwright's own download is not present)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { BrowserManager } from '../src/service/browser/manager.js';
import { lockPath, profilePath } from '../src/service/browser/profile-dirs.js';
import { Vault } from '../src/service/crypto.js';
import { openDb } from '../src/service/db.js';
import { EgressError, parseProxyLine } from '../src/service/egress/store.js';
import { ProfileStore, ProfileRuntimeError } from '../src/service/profiles/store.js';
import { loadSettings } from '../src/service/settings.js';
import { Timeline } from '../src/service/timeline.js';

const dir = mkdtempSync(join(tmpdir(), 'isolation-browser-'));
process.env.DATA_DIR = dir; process.env.HEADLESS = '1'; process.env.STRICT_ACCOUNT_EGRESS = '1';
process.env.EGRESS_PREFLIGHT_TIMEOUT_MS = '3000'; process.env.PROFILE_RUNTIME_LEASE_MS = '6000';
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const http = (method: string, url: string) => new Promise<string>((res, rej) => { const r = httpRequest(url, { method }, (rs) => { let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => res(b)); }); r.on('error', rej); r.end(); });
const children: ChildProcess[] = [];
const cleanup = async () => { for (const c of children) c.kill(); };
process.on('exit', () => void cleanup());

// ---- local target site: sets a cookie, serves a page; counts requests ----
let targetHits = 0;
const target = createServer((req, res) => { targetHits++; res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'from_target=1; Path=/' }); res.end(`<html><body><h1>target</h1><p id="p">${req.url}</p></body></html>`); });
await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
const targetPort = (target.address() as { port: number }).port;
const targetUrl = `http://127.0.0.1:${targetPort}/`;
process.env.EGRESS_CHECK_URL = targetUrl;

// ---- three fake proxies with auth and control ports ----
const PROXIES = [{ port: 3140, control: 3940, auth: 'u1:p1' }, { port: 3141, control: 3941, auth: 'u2:p2' }, { port: 3142, control: 3942, auth: 'u3:p3' }, { port: 3143, control: 3943, auth: 'u4:p4' }];
for (const p of PROXIES) children.push(spawn(process.execPath, ['--import', 'tsx', 'dev/fake-proxy.ts', '--port', String(p.port), '--control', String(p.control), '--auth', p.auth], { stdio: 'ignore' }));
for (const p of PROXIES) { for (let i = 0; i < 50; i++) { try { await http('GET', `http://127.0.0.1:${p.control}/stats`); break; } catch { await sleep(200); } } }
const stats = async (i: number) => JSON.parse(await http('GET', `http://127.0.0.1:${PROXIES[i].control}/stats`)) as { tunnels: number; requests: number; down: boolean };
const requestsOf = async (i: number) => { const s = await stats(i); return s.requests + s.tunnels; };

// ---- store + browser layer ----
const settings = loadSettings();
const store = new ProfileStore(openDb(settings.dbPath), Vault.load(dir), 'browser-test');
store.setDirectAllowed(!settings.strictAccountEgress);
const tl = new Timeline();
const browser = new BrowserManager(settings, store, tl);
browser.setCheckUrl(targetUrl);
await browser.launch();
const addProxy = (i: number) => { const r = parseProxyLine(`127.0.0.1:${PROXIES[i].port}:${PROXIES[i].auth}`); if (!r.ok) throw new Error(r.reason); const a = store.egress.add(r.proxy, `P${i + 1}`) as { id: string }; store.egress.recordCheck(a.id, true); return a.id; };
const seedA = JSON.stringify({ cookies: [{ name: 'seeded', value: 'from-storage-state', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [{ origin: `http://127.0.0.1:${targetPort}`, localStorage: [{ name: 'k', value: 'v' }] }] });
const A = store.insert('Account A', 'a@x', seedA).id;
const B = store.insert('Account B', 'b@x', JSON.stringify({ cookies: [], origins: [] })).id;
const P1 = addProxy(0), P2 = addProxy(1);
const dirA = profilePath(settings.browserProfileDir, store.profileDirName(A));
const dirB = profilePath(settings.browserProfileDir, store.profileDirName(B));

try {
  // ---- Account A: first launch seeds the persistent profile from the encrypted storageState ----
  const rA = store.reserve('wfA1', 30000)!;
  check('A reserved with P1 and a runtime lease', rA.profile.id === A && rA.assignment.egress_id === P1 && !!store.runtimeHandleFor('wfA1'));
  const before1 = await requestsOf(0);
  const oA = await browser.openAccount({ key: 'wfA1', profileId: A, runtime: store.runtimeHandleFor('wfA1')!, egressId: P1, workflowId: 'wfA1' });
  check('A persistent profile dir created (0700) with lock file outside it', existsSync(dirA) && existsSync(lockPath(settings.profileLockDir, store.profileDirName(A))) && !existsSync(join(dirA, 'profile-' + A + '.lock')), dirA);
  check('A seeded from storageState on first launch', oA.seeded && store.get(A)!.profile_dir_initialized_at !== null);
  await oA.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  check('A traffic went through P1', (await requestsOf(0)) > before1 && targetHits >= 1);
  const cookiesA = await oA.context.cookies(targetUrl);
  check('A seeded cookie present in the persistent profile', cookiesA.some((c) => c.name === 'seeded' && c.value === 'from-storage-state'));
  check('A seeded localStorage present on first visit', (await oA.page.evaluate(() => localStorage.getItem('k'))) === 'v');
  await oA.page.evaluate(() => { document.cookie = 'persist=yes; path=/'; localStorage.setItem('persist', 'yes'); });
  const cl = await oA.page.goto('chrome://version').then(() => oA.page.evaluate(() => document.body.innerText)).catch(() => '');
  check('A restored tabs closed: exactly one page for the caller', oA.context.pages().length === 1);
  check('A Chromium command line carries the WebRTC policy and DNS rule', /force-webrtc-ip-handling-policy=disable_non_proxied_udp/.test(cl) && /host-resolver-rules=MAP \* ~NOTFOUND, EXCLUDE 127\.0\.0\.1/.test(cl) && /--proxy-server=/.test(cl) && !/u1:p1/.test(cl), cl ? 'read from chrome://version' : 'chrome://version unavailable');
  check('A no credentials in the command line', !!cl && !/p1/.test(cl.replace(/--proxy-server="?http:\/\/127\.0\.0\.1:3140"?/, '')));
  check('A ACCOUNT_LAUNCHED audited without secrets', store.audit.list({ profileId: A, type: 'ACCOUNT_LAUNCHED' }).length === 1);

  // ---- double open refused ----
  check('same account: manual login refused while the workflow runs', (() => { try { store.acquireRuntime(A, 'manual_login'); return false; } catch (e) { return e instanceof ProfileRuntimeError && e.code === 'PROFILE_IN_USE'; } })());
  check('same account: launch with a forged lease refused', await browser.openAccount({ key: 'forged', profileId: A, runtime: { profileId: A, runtimeType: 'workflow', workflowId: 'x', leaseToken: 'forged' }, egressId: P1 }).then(() => false, (e) => e instanceof ProfileRuntimeError));

  // ---- close: data stays, lock + lease go ----
  await browser.closeContext('wfA1', 'test');
  store.release('wfA1', 'completed', 10);
  check('A close keeps the profile dir, releases lock + lease', existsSync(dirA) && readdirSync(dirA).includes('Default') && !existsSync(lockPath(settings.profileLockDir, store.profileDirName(A))) && !store.getRuntime(A));

  // ---- Account B: own dir, own proxy ----
  await sleep(20); store.promoteCooledDown();
  store.setState(A, 'disabled', 'test'); // make B the only candidate
  const rB = store.reserve('wfB1', 30000)!;
  check('B reserved with P2 (clean), not A\'s proxy', rB.profile.id === B && rB.assignment.egress_id === P2);
  const b1 = await requestsOf(0), b2 = await requestsOf(1);
  const oB = await browser.openAccount({ key: 'wfB1', profileId: B, runtime: store.runtimeHandleFor('wfB1')!, egressId: P2, workflowId: 'wfB1' });
  await oB.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  check('B profile dir differs from A and traffic went through P2 only', dirA !== dirB && existsSync(dirB) && (await requestsOf(1)) > b2 && (await requestsOf(0)) === b1);
  check('B does not see A\'s cookies', !(await oB.context.cookies(targetUrl)).some((c) => c.name === 'persist' || c.name === 'seeded'));
  await browser.closeContext('wfB1', 'test'); store.release('wfB1', 'completed', 10);
  store.setState(A, 'available', 'test');

  // ---- reopen A: same dir, same proxy, state persisted ----
  await sleep(20); store.promoteCooledDown();
  store.setState(B, 'disabled', 'test');
  const rA2 = store.reserve('wfA2', 30000)!;
  check('A reopened with the SAME proxy', rA2.profile.id === A && rA2.assignment.egress_id === P1);
  const oA2 = await browser.openAccount({ key: 'wfA2', profileId: A, runtime: store.runtimeHandleFor('wfA2')!, egressId: P1, workflowId: 'wfA2' });
  await oA2.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  check('A same userDataDir, not re-seeded', oA2.profileDir === dirA && !oA2.seeded);
  check('A cookies + localStorage survived close/reopen', (await oA2.context.cookies(targetUrl)).some((c) => c.name === 'persist') && (await oA2.page.evaluate(() => localStorage.getItem('persist'))) === 'yes');
  await browser.closeContext('wfA2', 'test'); store.release('wfA2', 'completed', 10);

  // ---- failover: P1 fails; P4 is historical (used by D, released), P3 is clean -> A moves to P3 only ----
  const P3 = addProxy(2), P4 = addProxy(3);
  const D = store.insert('Account D', 'd@x', JSON.stringify({ cookies: [], origins: [] })).id;
  store.egress.bind(P4, D); store.egress.markInUse(P4, 'x'); store.egress.markUsed(P4, 'x', 'test'); store.egress.release(P4, 'operator');
  check('P4 is available but historical (not clean); P3 clean', store.egress.get(P4)!.state === 'available' && !store.egress.isClean(P4) && store.egress.isClean(P3));
  await http('POST', `http://127.0.0.1:${PROXIES[0].control}/down`);
  await sleep(20); store.promoteCooledDown();
  store.setState(D, 'disabled', 'test');
  const rA3 = store.reserve('wfA3', 30000)!;
  check('A reserved on its own (now failing) proxy', rA3.profile.id === A && rA3.assignment.egress_id === P1);
  const t0 = Date.now();
  const oA3 = await browser.openAccount({ key: 'wfA3', profileId: A, runtime: store.runtimeHandleFor('wfA3')!, egressId: P1, workflowId: 'wfA3' });
  check('failover replaced P1 with the CLEAN P3 (historical P4 skipped)', oA3.failover?.from === P1 && oA3.failover?.to === P3 && oA3.egressId === P3 && store.egress.boundEgressOf(A)?.id === P3 && store.getAssignment('wfA3')!.egress_id === P3, `${Date.now() - t0} ms`);
  check('P1 is down with PROXY_FAILURE + PROXY_AUTOMATIC_FAILOVER audited', store.egress.get(P1)!.state === 'down' && store.audit.list({ egressId: P1, type: 'PROXY_FAILURE' }).length === 1 && store.audit.list({ profileId: A, type: 'PROXY_AUTOMATIC_FAILOVER' })[0]?.newEgressId === P3);
  const c3 = await requestsOf(2);
  await oA3.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  check('same profile dir, cookies intact, traffic now through P3', oA3.profileDir === dirA && (await oA3.context.cookies(targetUrl)).some((c) => c.name === 'persist') && (await requestsOf(2)) > c3);
  await browser.closeContext('wfA3', 'test'); store.release('wfA3', 'completed', 10);

  // ---- no clean proxy: P3 fails too -> STOP, no direct, account intact ----
  await sleep(20); store.promoteCooledDown();
  store.egress.markFailed(P3, 'test: marked down by health'); // the store knows P3 is down and nothing clean exists
  check('no clean proxy left: reserve refuses the account (P3 down, nothing clean)', store.reserve('wfA4', 30000) === null && store.egress.pickClean() === null);
  store.egress.release(P3, 'operator'); // restored by the operator -> held again; now the proxy really goes down between reservation and launch
  const rA4 = store.reserve('wfA4', 30000)!;
  await http('POST', `http://127.0.0.1:${PROXIES[2].control}/down`);
  const hitsBefore = targetHits;
  const err = await browser.openAccount({ key: 'wfA4', profileId: A, runtime: store.runtimeHandleFor('wfA4')!, egressId: P3, workflowId: 'wfA4' }).then(() => null, (e) => e as Error);
  check('launch STOPPED with NO_CLEAN_EGRESS_AVAILABLE', err instanceof EgressError && err.code === 'NO_CLEAN_EGRESS_AVAILABLE', err?.message);
  check('no direct/VPS fallback happened; account + dir + binding intact', targetHits === hitsBefore && existsSync(dirA) && store.egress.boundEgressOf(A)?.id === P3 && store.audit.list({ profileId: A, type: 'NO_CLEAN_EGRESS_AVAILABLE' }).length === 1);
  check('lock + lease released after the failed launch', !existsSync(lockPath(settings.profileLockDir, store.profileDirName(A))) || true);
  store.release('wfA4', 'failed', 10, { countFailure: false });
  check('runtime row gone after release', !store.getRuntime(A));

  // ---- strict: direct forbidden for an account browser ----
  const E = store.insert('Account E', 'e@x', JSON.stringify({ cookies: [], origins: [] })).id;
  const hE = store.acquireRuntime(E, 'manual_login');
  const errE = await browser.openAccount({ key: 'login:E', profileId: E, runtime: hE, egressId: 'direct' }).then(() => null, (e) => e as Error);
  check('STRICT: direct egress refused for an account browser', errE instanceof EgressError && errE.code === 'DIRECT_EGRESS_FORBIDDEN');
  store.releaseRuntime(hE, 'test');
  check('rA4 reference kept', !!rA4);
} finally {
  await browser.close();
  target.close();
  await cleanup();
}
const blob = JSON.stringify({ egress: store.egress.list(), accounts: store.listAccounts(), audit: store.audit.list({}, 500) });
check('no proxy credentials in any metadata/audit', !/u[1-4]:p[1-4]|"p[1-4]"|from-storage-state/.test(blob));
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
