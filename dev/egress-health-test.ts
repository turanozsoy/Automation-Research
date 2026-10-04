/**
 * Proxy health semantics (no browser): a proxy is taken down only when the PROXY fails (unreachable, 503, wrong
 * credentials); a slow or unreachable target through a reachable proxy is a soft failure that never takes it down;
 * a passing probe restores a proxy that checks took down; the launch preflight treats soft-only failures as "launch".
 *   npm run test:health
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNet } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/service/crypto.js';
import { openDb } from '../src/service/db.js';
import { preflightProxy, probe } from '../src/service/egress/health.js';
import { parseProxyLine } from '../src/service/egress/store.js';
import { ProfileStore } from '../src/service/profiles/store.js';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
process.on('exit', () => { for (const c of children) c.kill(); });
const http = (method: string, url: string) => fetch(url, { method }).then((r) => r.text());

// a target that accepts connections and never answers (a slow Website B)
const slow = createServer(() => { /* never respond */ });
await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
const slowPort = (slow.address() as { port: number }).port;
// a target that answers at once
const fast = createServer((_q, res) => { res.end('ok'); });
await new Promise<void>((r) => fast.listen(0, '127.0.0.1', () => r()));
const fastPort = (fast.address() as { port: number }).port;
// a closed port (nothing listens): the proxy cannot reach the target
const closedSrv = createNet(); await new Promise<void>((r) => closedSrv.listen(0, '127.0.0.1', () => r())); const closedPort = (closedSrv.address() as { port: number }).port; closedSrv.close();

const PROXY = { port: 3190, control: 3990, auth: 'hu:hp' };
children.push(spawn(process.execPath, ['--import', 'tsx', 'dev/fake-proxy.ts', '--port', String(PROXY.port), '--control', String(PROXY.control), '--auth', PROXY.auth], { stdio: 'ignore' }));
for (let i = 0; i < 50; i++) { try { await http('GET', `http://127.0.0.1:${PROXY.control}/stats`); break; } catch { await sleep(200); } }
const good = { server: `http://127.0.0.1:${PROXY.port}`, username: 'hu', password: 'hp' };

console.log('\n[test:health] 1. probe classification');
{
  const ok = await probe(good, `http://127.0.0.1:${fastPort}/`, 3000);
  check('reachable proxy + fast target: ok', ok.ok && !ok.hard, `${ok.ms} ms`);
  const slowR = await probe(good, `http://127.0.0.1:${slowPort}/`, 1500);
  check('reachable proxy + target that never answers: SOFT failure', !slowR.ok && !slowR.hard && /slow/.test(slowR.error ?? ''), slowR.error);
  const unreachable = await probe({ server: `http://127.0.0.1:${closedPort}` }, `http://127.0.0.1:${fastPort}/`, 1500);
  check('proxy port closed: HARD failure', !unreachable.ok && unreachable.hard, unreachable.error);
  const badAuth = await probe({ server: good.server, username: 'hu', password: 'wrong' }, `http://127.0.0.1:${fastPort}/`, 3000);
  check('wrong credentials (407): HARD failure', !badAuth.ok && badAuth.hard && /407/.test(badAuth.error ?? ''), badAuth.error);
  const badTarget = await probe(good, `https://127.0.0.1:${closedPort}/`, 3000);
  check('CONNECT to a target the proxy cannot reach (502): SOFT failure', !badTarget.ok && !badTarget.hard && /502/.test(badTarget.error ?? ''), badTarget.error);
  await http('POST', `http://127.0.0.1:${PROXY.control}/down`);
  const down = await probe(good, `http://127.0.0.1:${fastPort}/`, 3000);
  check('proxy answering 503: HARD failure', !down.ok && down.hard && /503/.test(down.error ?? ''), down.error);
  await http('POST', `http://127.0.0.1:${PROXY.control}/up`);
}

console.log('\n[test:health] 2. store: soft failures never take a proxy down; hard ones do; a passing probe restores it');
const dir = mkdtempSync(join(tmpdir(), 'health-'));
const store = new ProfileStore(openDb(join(dir, 't.db')), Vault.load(dir), 'health-test');
const r = parseProxyLine(`127.0.0.1:${PROXY.port}:hu:hp`); if (!r.ok) throw new Error(r.reason);
const P = (store.egress.add(r.proxy, 'P') as { id: string }).id;
{
  for (let i = 0; i < 5; i++) store.egress.recordCheck(P, false, 'slow: no answer from the target', false);
  let e = store.egress.get(P)!;
  check('five soft failures: health degraded, state still available, no failure count', e.health === 'degraded' && e.state === 'available' && e.consecutive_failures === 0, `${e.health}/${e.state}/${e.consecutive_failures}`);
  store.egress.recordCheck(P, false, 'ECONNREFUSED', true); store.egress.recordCheck(P, false, 'ECONNREFUSED', true);
  e = store.egress.get(P)!;
  check('two hard failures: degraded, still available', e.health === 'degraded' && e.state === 'available' && e.consecutive_failures === 2);
  store.egress.recordCheck(P, false, 'ECONNREFUSED', true);
  e = store.egress.get(P)!;
  check('third hard failure: DOWN', e.health === 'down' && e.state === 'down' && /health check failed/.test(e.state_reason ?? ''));
  store.egress.recordCheck(P, false, 'slow', false);
  e = store.egress.get(P)!;
  check('a soft failure while down changes nothing', e.health === 'down' && e.state === 'down');
  store.egress.recordCheck(P, true);
  e = store.egress.get(P)!;
  check('a passing probe restores the proxy automatically (checks took it down)', e.health === 'healthy' && e.state === 'available' && e.consecutive_failures === 0, `${e.health}/${e.state}`);
  // bound proxy: restored to held, binding kept
  const A = store.insert('Account A', 'a@x', JSON.stringify({ cookies: [], origins: [] })).id;
  store.egress.replaceProxyManually(A, P, 'test');
  store.egress.markFailed(P, 'launch preflight failed: 3 attempts');
  e = store.egress.get(P)!;
  check('preflight failure takes a bound proxy down', e.state === 'down' && store.egress.boundEgressOf(A)?.id === P);
  store.egress.recordCheck(P, true);
  e = store.egress.get(P)!;
  check('passing probe: bound proxy back to HELD for its account', e.state === 'held' && store.egress.boundEgressOf(A)?.id === P && /held for Account A/.test(e.state_reason ?? ''), e.state_reason ?? '');
  store.egress.retire(P);
  store.egress.recordCheck(P, true);
  check('a retired proxy is NOT restored by a probe', store.egress.get(P)!.state === 'retired');
}

console.log('\n[test:health] 3. launch preflight: soft-only failures mean "launch anyway"');
{
  const slowPf = await preflightProxy(good, `http://127.0.0.1:${slowPort}/`, 2, 1000);
  check('all attempts slow (proxy reachable): ok=false, softOnly=true', !slowPf.ok && slowPf.softOnly && slowPf.attempts.length === 2 && slowPf.attempts.every((a) => !a.hard));
  await http('POST', `http://127.0.0.1:${PROXY.control}/down`);
  const downPf = await preflightProxy(good, `http://127.0.0.1:${fastPort}/`, 2, 2000);
  check('proxy down (503): ok=false, softOnly=false (hard)', !downPf.ok && !downPf.softOnly && downPf.attempts.every((a) => a.hard));
  await http('POST', `http://127.0.0.1:${PROXY.control}/up`);
  const okPf = await preflightProxy(good, `http://127.0.0.1:${fastPort}/`, 2, 2000);
  check('healthy: ok after the first attempt', okPf.ok && okPf.attempts.length === 1);
}

slow.close(); fast.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
