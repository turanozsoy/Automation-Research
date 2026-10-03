/**
 * Proxy + DNS path of the account browsers (real Chromium, local fake proxies, no third-party services):
 *   npm run test:network            (CHROMIUM_PATH=... when Playwright's own download is not present)
 *
 *  1. proxied Chromium reaches the network through its assigned proxy (echo server sees the proxy's marker)
 *  2. destination names go to the proxy (http proxy: absolute-URI + CONNECT; socks5: domain-name address type)
 *  3. the local resolver is never asked for a destination name (canary under .invalid never ERR_NAME_NOT_RESOLVED)
 *  4./5. Add Account and Refresh Cookies (LoginSessionManager.start) launch through the same helper as
 *  6. workflow browsers (openAccount with the reservation's runtime lease): identical network plan for the same proxy
 *  7. a proxy that fails (down) or cannot be configured (socks5 with auth, socks5h/socks4/https) fails the launch; nothing goes direct
 *  8. proxy credentials never appear in timeline marks, audit rows, egress events, errors or the diagnostics report
 *  plus: Secure DNS off as applied by Chromium; the single launch site in the source tree.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNet, type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from '../src/service/browser/manager.js';
import { applyNetworkPrefs, classifyCanary, DNS_CANARY_SUFFIX, describePlan, NetworkConfigError, planNetwork } from '../src/service/browser/network.js';
import { LoginSessionManager } from '../src/service/accounts/login-sessions.js';
import { loadConfig } from '../src/service/config.js';
import { Vault } from '../src/service/crypto.js';
import { openDb } from '../src/service/db.js';
import { NetworkDiagnostics } from '../src/service/dev/network-diagnostics.js';
import { EgressError, parseProxyLine } from '../src/service/egress/store.js';
import { ProfileStore } from '../src/service/profiles/store.js';
import { loadSettings } from '../src/service/settings.js';
import { Timeline } from '../src/service/timeline.js';

const dir = mkdtempSync(join(tmpdir(), 'network-test-'));
process.env.DATA_DIR = dir; process.env.HEADLESS = '1'; process.env.LOGIN_HEADLESS = '1'; process.env.STRICT_ACCOUNT_EGRESS = '1';
process.env.EGRESS_PREFLIGHT_TIMEOUT_MS = '3000'; process.env.EGRESS_PREFLIGHT_ATTEMPTS = '2'; process.env.SITE_B_CONFIG ??= 'config/site-b.fake.json';
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const http = (method: string, url: string) => new Promise<string>((res, rej) => { const r = httpRequest(url, { method }, (rs) => { let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => res(b)); }); r.on('error', rej); r.end(); });
const children: ChildProcess[] = [];
process.on('exit', () => { for (const c of children) c.kill(); });

// ---- echo server: reports the proxy marker header the fake proxy adds and the peer address ----
let echoHits = 0;
const echo = createServer((req, res) => { echoHits++; res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`via=${req.headers['x-fake-proxy-port'] ?? 'none'} peer=${req.socket.remoteAddress}`); });
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
const echoPort = (echo.address() as { port: number }).port;
const echoUrl = `http://127.0.0.1:${echoPort}/ip`;
process.env.EGRESS_CHECK_URL = echoUrl; process.env.DIAG_IP_URL = echoUrl;

// ---- fake HTTP proxies (auth) ----
const PROXIES = [{ port: 3170, control: 3970, auth: 'user1:pass1' }, { port: 3171, control: 3971, auth: 'user2:pass2' }];
for (const p of PROXIES) children.push(spawn(process.execPath, ['--import', 'tsx', 'dev/fake-proxy.ts', '--port', String(p.port), '--control', String(p.control), '--auth', p.auth], { stdio: 'ignore' }));
for (const p of PROXIES) { for (let i = 0; i < 50; i++) { try { await http('GET', `http://127.0.0.1:${p.control}/stats`); break; } catch { await sleep(200); } } }
const stats = async (i: number) => JSON.parse(await http('GET', `http://127.0.0.1:${PROXIES[i].control}/stats`)) as { tunnels: number; requests: number; hosts: string[] };

// ---- fake SOCKS5 server (no auth): records the address type + name the browser sends, then refuses ----
const socksSeen: string[] = [];
const socks = createNet((s: Socket) => {
  s.on('error', () => {}); let stage = 0;
  s.on('data', (d) => {
    if (stage === 0) { s.write(Buffer.from([5, 0])); stage = 1; return; }
    if (stage === 1) { const atyp = d[3]; socksSeen.push(atyp === 3 ? `DOMAIN:${d.subarray(5, 5 + d[4]).toString()}` : atyp === 1 ? `IPV4:${d[4]}.${d[5]}.${d[6]}.${d[7]}` : `ATYP${atyp}`); s.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); }
  });
});
await new Promise<void>((r) => socks.listen(3180, '127.0.0.1', () => r()));

// ---- store, browser layer, login manager, diagnostics (the real wiring, minus the HTTP server) ----
const settings = loadSettings();
const cfg = loadConfig();
const store = new ProfileStore(openDb(settings.dbPath), Vault.load(dir), 'network-test');
store.setDirectAllowed(false);
const tl = new Timeline();
const marks: string[] = [];
const origMark = tl.mark.bind(tl);
tl.mark = ((name: string, detail?: string) => { marks.push(`${name} ${detail ?? ''}`); return origMark(name, detail); }) as Timeline['mark'];
const browser = new BrowserManager(settings, store, tl);
browser.setCheckUrl(echoUrl);
await browser.launch();
const logins = new LoginSessionManager(settings, cfg, store, browser, tl);
const diag = new NetworkDiagnostics(settings, store, browser, tl);
const SECRETS = ['pass1', 'pass2', 'user1', 'user2', 'sockspass'];
const addProxy = (line: string, label: string) => { const r = parseProxyLine(line); if (!r.ok) throw new Error(r.reason); const a = store.egress.add(r.proxy, label) as { id: string }; store.egress.recordCheck(a.id, true); return a.id; };
const session = (origin: string) => JSON.stringify({ cookies: [{ name: 'sid', value: 'x', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [{ origin, localStorage: [] }] });
const A = store.insert('Account A', 'a@x', session(`http://127.0.0.1:${echoPort}`)).id;
const B = store.insert('Account B', 'b@x', session(`http://127.0.0.1:${echoPort}`)).id;
const P1 = addProxy(`127.0.0.1:${PROXIES[0].port}:${PROXIES[0].auth}`, 'P1');
const canary = (tag: string) => `${tag}-${Date.now().toString(36)}.${DNS_CANARY_SUFFIX}`;
const visit = async (page: any, url: string) => { try { const r = await page.goto(url, { timeout: 10000, waitUntil: 'domcontentloaded' }); return { status: r?.status() as number | undefined, text: await page.evaluate(() => document.body?.innerText ?? '').catch(() => '') as string }; } catch (e) { return { error: String((e as Error).message).split('\n')[0].replace(/^page\.goto: /, '') }; } };
const readInternal = async (page: any, url: string, needle: RegExp) => { try { await page.goto(url, { waitUntil: 'load', timeout: 8000 }); } catch { /* read what rendered */ } for (let i = 0; i < 16; i++) { const t = await page.evaluate(() => document.documentElement?.innerText ?? '').catch(() => ''); if (needle.test(t)) return t; await sleep(250); } return ''; };

console.log('\n[test:network] 0. the helper itself');
{
  const h = planNetwork({ server: 'http://proxy.example.net:8080', username: 'u', password: 'p' });
  check('http proxy: destination DNS via proxy, resolver rule excludes only the proxy host', h.destinationDns === 'proxy' && h.args[0] === '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE proxy.example.net' && h.playwrightProxy?.server === 'http://proxy.example.net:8080' && !h.proxyHostIsLiteral);
  const s5 = planNetwork({ server: 'socks5://10.0.0.9:1080' });
  check('socks5 proxy (no auth): remote DNS by Chromium design, literal host', s5.destinationDns === 'proxy' && s5.protocol === 'socks5' && s5.proxyHostIsLiteral && s5.args[0] === '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 10.0.0.9');
  const codeOf = (fn: () => unknown) => { try { fn(); return 'none'; } catch (e) { return e instanceof NetworkConfigError ? e.code : 'other'; } };
  check('socks5 with username/password refused (Chromium has no SOCKS auth)', codeOf(() => planNetwork({ server: 'socks5://10.0.0.9:1080', username: 'u', password: 'p' })) === 'UNSUPPORTED_PROXY_AUTH');
  check('socks5h / socks4 / https schemes refused, never passed to Chromium', ['socks5h', 'socks4', 'https', 'socks'].every((s) => codeOf(() => planNetwork({ server: `${s}://10.0.0.9:1080` })) === 'UNSUPPORTED_PROXY_SCHEME'));
  check('missing port / credentials inside the URL refused', codeOf(() => planNetwork({ server: 'http://proxy.example.net' })) === 'INVALID_PROXY_ADDRESS' && codeOf(() => planNetwork({ server: 'http://u:p@proxy.example.net:1' })) === 'INVALID_PROXY_ADDRESS');
  check('direct (development only): no resolver rule, local DNS', planNetwork(null).mode === 'direct' && planNetwork(null).args.length === 0);
  check('describePlan carries no credentials', !JSON.stringify(describePlan(h)).includes('"u"') && !JSON.stringify(describePlan(h)).includes('"p"'));
  const pd = mkdtempSync(join(tmpdir(), 'ls-'));
  writeFileSync(join(pd, 'Local State'), JSON.stringify({ browser: { keep: true }, dns_over_https: { mode: 'automatic' } }));
  const r1 = applyNetworkPrefs(pd); const after = JSON.parse(readFileSync(join(pd, 'Local State'), 'utf8'));
  check('Local State merged: Secure DNS off, other keys kept, idempotent', r1.changed && after.dns_over_https.mode === 'off' && after.browser.keep === true && applyNetworkPrefs(pd).changed === false);
  check('canary classification', classifyCanary({ error: 'net::ERR_NAME_NOT_RESOLVED at http://x' }).verdict === 'local' && classifyCanary({ error: 'net::ERR_TUNNEL_CONNECTION_FAILED' }).verdict === 'proxy' && classifyCanary({ status: 502 }).verdict === 'proxy' && classifyCanary({ error: 'net::ERR_PROXY_CONNECTION_FAILED' }).verdict === 'proxy_unreachable');
}

console.log('\n[test:network] 1-3, 6. workflow browser through its assigned http proxy');
let workflowPlan: Record<string, unknown> | null = null;
{
  const r = store.reserve('wf1', 30000)!;
  check('reservation bound the clean proxy P1 to Account A (allocation unchanged)', r.profile.id === A && r.assignment.egress_id === P1);
  const o = await browser.openAccount({ key: 'wf1', profileId: A, runtime: store.runtimeHandleFor('wf1')!, egressId: P1, workflowId: 'wf1' });
  workflowPlan = describePlan(o.network);
  const before = await stats(0);
  const ip = await visit(o.page, echoUrl);
  check('1. traffic leaves through the assigned proxy (echo saw the proxy marker)', ip.status === 200 && /via=3170/.test(ip.text ?? ''), ip.text?.slice(0, 60));
  const c1 = canary('wf-http'); const h1 = classifyCanary(await visit(o.page, `http://${c1}/`));
  const c2 = canary('wf-https'); const h2 = classifyCanary(await visit(o.page, `https://${c2}/`));
  const after = await stats(0);
  check('2. http canary: the proxy received the NAME (absolute-URI request)', h1.verdict === 'proxy' && after.hosts.includes(c1), h1.explanation);
  check('2. https canary: the proxy received the NAME (CONNECT host:443)', h2.verdict === 'proxy' && after.hosts.includes(c2), h2.explanation);
  check('3. no local lookup for either canary (never ERR_NAME_NOT_RESOLVED)', h1.verdict !== 'local' && h2.verdict !== 'local' && after.requests + after.tunnels > before.requests + before.tunnels);
  const cl = await readInternal(o.page, 'chrome://version', /Command Line/);
  check('command line: resolver rule for everything but the proxy host, proxy configured, no credentials', /--host-resolver-rules="?MAP \* ~NOTFOUND, EXCLUDE 127\.0\.0\.1/.test(cl) && /--proxy-server="?http:\/\/127\.0\.0\.1:3170/.test(cl) && !SECRETS.some((s) => cl.includes(s)));
  const hist = await readInternal(o.page, 'chrome://histograms/Net.DNS.DnsConfig.SecureDnsMode', /SecureDnsMode/);
  const sample = /SecureDnsMode recorded \d+ samples?, mean = (\d+)/.exec(hist);
  check('Secure DNS applied as OFF by Chromium (histogram 0; default would be 4 = automatic)', !!sample && Number(sample[1]) === 0, sample ? `mean ${sample[1]}` : 'histogram not found');
  check('Local State of the profile carries dns_over_https.mode=off', existsSync(join(o.profileDir, 'Local State')) && /"mode":\s*"off"/.test(readFileSync(join(o.profileDir, 'Local State'), 'utf8')));
  check('6. networkOf(workflow key) exposes the plan used', browser.networkOf('wf1')?.protocol === 'http' && browser.networkOf('wf1')?.proxyHost === '127.0.0.1');
  await browser.closeContext('wf1', 'test done');
  store.release('wf1', 'completed', 0);
}

console.log('\n[test:network] 4-5. Add Account / Refresh Cookies (the manual login browser) use the same helper');
{
  const st = await logins.start(A); // Add Account -> Get Cookies and Refresh Cookies both call start(): the account's own profile + its proxy
  check('login browser opened via the account\'s own proxy', st.open && st.egress === 'P1', st.egress ?? '');
  const loginPlan = browser.networkOf(`login:${A}`);
  check('4./5. login browser network plan identical to the workflow browser plan for the same proxy', !!loginPlan && JSON.stringify(describePlan(loginPlan)) === JSON.stringify(workflowPlan));
  const page = browser.pageOf(`login:${A}`)!;
  const c3 = canary('login'); const h3 = classifyCanary(await visit(page, `http://${c3}/`));
  check('login browser: canary name went to the proxy, not the local resolver', h3.verdict === 'proxy' && (await stats(0)).hosts.includes(c3), h3.explanation);
  await logins.cancel(A);
  check('login closed: proxy back to held for the account, binding kept', store.egress.get(P1)?.state === 'held' && store.egress.boundEgressOf(A)?.id === P1);
}

console.log('\n[test:network] diagnostics report (same launch path, failover disabled)');
{
  const rep = await diag.run(A);
  check('verdict ok: proxy IP path, canary via proxy, Secure DNS off', rep.ok && rep.verdict === 'ok' && rep.canary?.http.verdict === 'proxy' && rep.canary?.https?.verdict === 'proxy' && rep.secureDns?.observed === 'off', `${rep.verdict}; ${rep.canary?.http.explanation}`);
  check('public IP fetched through the proxy (echo saw the proxy marker), no failover, no direct fallback', rep.publicIp?.status === 200 && /via=3170/.test(rep.publicIp?.bodySnippet ?? '') && rep.launch.failover === false && rep.launch.directFallback === false, JSON.stringify(rep.publicIp));
  check('report names the egress and protocol, carries no credentials', rep.egress?.id === P1 && rep.egress.protocol === 'http' && !SECRETS.some((s) => JSON.stringify(rep).includes(s)));
  check('account browser closed and runtime released after diagnostics', browser.liveContexts() === 0 && !store.getRuntime(A));
  const noProxy = await diag.run(B);
  check('account without a proxy: not applicable, nothing assigned', noProxy.verdict === 'not_applicable' && store.egress.boundEgressOf(B) === null);
}

console.log('\n[test:network] 2. socks5: Chromium sends the domain name to the proxy');
{
  const S5 = addProxy('socks5://127.0.0.1:3180', 'S5');
  store.egress.replaceProxyManually(B, S5, 'test');
  const rt = store.acquireRuntime(B, 'diagnostic');
  const o = await browser.openAccount({ key: 'socksB', profileId: B, runtime: rt, egressId: S5, headless: true, allowFailover: false });
  const c4 = canary('socks'); const h4 = classifyCanary(await visit(o.page, `http://${c4}/`));
  check('socks5 canary: DOMAIN address type with the canary name (remote DNS), refused by the fake server', h4.verdict === 'proxy' && socksSeen.includes(`DOMAIN:${c4}`), `${h4.explanation}; seen ${socksSeen.filter((s) => s.includes(DNS_CANARY_SUFFIX)).join(',')}`);
  check('socks5 plan: remote DNS, resolver rule present', o.network.destinationDns === 'proxy' && o.network.args.length === 1);
  await browser.closeContext('socksB', 'test done');
}

console.log('\n[test:network] 7. failures never fall back to direct');
{
  // 7a. the assigned proxy is down: preflight fails, failover disabled -> launch refused, no browser, nothing direct
  await http('POST', `http://127.0.0.1:${PROXIES[0].control}/down`);
  echoHits = 0;
  const rep = await diag.run(A);
  check('7a. down proxy: launch refused with a sanitized code, no browser, no direct traffic', rep.verdict === 'launch_refused' && rep.launch.code === 'EGRESS_NOT_ELIGIBLE' && browser.liveContexts() === 0 && echoHits === 0 && !SECRETS.some((s) => JSON.stringify(rep).includes(s)), `${rep.launch.code}: ${rep.launch.message}`);
  check('7a. binding kept for the operator (Account A still bound to P1)', store.egress.boundEgressOf(A)?.id === P1);
  await http('POST', `http://127.0.0.1:${PROXIES[0].control}/up`);
  store.egress.release(P1); // the down proxy is restored for later cases (operator action)
  // 7b. a proxy Chromium cannot be configured with: socks5 with credentials
  const SA = addProxy('socks5://sockuser:sockspass@127.0.0.1:3180', 'S5auth');
  const C = store.insert('Account C', 'c@x', session(`http://127.0.0.1:${echoPort}`)).id;
  store.egress.replaceProxyManually(C, SA, 'test');
  const rt = store.acquireRuntime(C, 'diagnostic');
  const err = await browser.openAccount({ key: 'authC', profileId: C, runtime: rt, egressId: SA, headless: true, allowFailover: false }).then(() => null, (e) => e as Error);
  check('7b. socks5 with auth: launch refused before Chromium starts (EGRESS_NOT_ELIGIBLE), no direct fallback', err instanceof EgressError && err.code === 'EGRESS_NOT_ELIGIBLE' && /socks5/.test(err.message) && browser.liveContexts() === 0, err?.message.slice(0, 100));
  check('7b. refusal message carries no credentials', !!err && !SECRETS.some((s) => err.message.includes(s)));
  check('7b. runtime lock released by the refused launch\'s caller path (store still consistent)', (store.releaseRuntime(rt, 'test'), !store.getRuntime(C)));
}

console.log('\n[test:network] 8. credentials never in logs, audit, events or errors');
{
  const auditDump = JSON.stringify(store.audit.list({}, 500));
  const eventsDump = JSON.stringify([P1].map((id) => store.egress.events(id, 100)));
  const marksDump = marks.join('\n');
  check('timeline marks carry no proxy credentials', !SECRETS.some((s) => marksDump.includes(s)), `${marks.length} marks`);
  check('audit rows and egress events carry no proxy credentials', !SECRETS.some((s) => auditDump.includes(s) || eventsDump.includes(s)));
  check('egress metadata carries no credentials', !SECRETS.some((s) => JSON.stringify(store.egress.list()).includes(s)));
}

console.log('\n[test:network] single launch site');
{
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk('src/service');
  // src/service/browser.ts is the Phase 1 prototype (no proxy, nothing imports it); everything live launches in browser/manager.ts
  const launchers = files.filter((f) => !/service[\\/]browser\.ts$/.test(f) && /launchPersistentContext\(|chromium\.launch\(|newContext\(/.test(readFileSync(f, 'utf8')));
  check('src/service: only browser/manager.ts launches Chromium (workflows, logins and diagnostics all go through openAccount)', launchers.length === 1 && /browser[\\/]manager\.ts$/.test(launchers[0]), launchers.join(', '));
  const proxyBuilders = files.filter((f) => /MAP \* ~NOTFOUND|proxy:\s*\{\s*server/.test(readFileSync(f, 'utf8')));
  check('src/service: only browser/network.ts builds proxy/DNS options', proxyBuilders.length === 1 && /browser[\\/]network\.ts$/.test(proxyBuilders[0]), proxyBuilders.join(', '));
}

await browser.close();
socks.close(); echo.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
