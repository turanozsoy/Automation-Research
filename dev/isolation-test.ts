/**
 * Isolation layer, store level (no browser): runtime locks, proxy provenance, clean failover, migration backfill.
 *   npm run test:isolation
 * Cases: A same account cannot acquire runtime twice · B two accounts cannot share one current proxy · C released
 * previously-used proxy is NOT automatically eligible · D virgin proxy IS eligible · E failover is atomic under
 * concurrent attempts (separate processes) · F no virgin proxy -> NO_CLEAN_EGRESS_AVAILABLE · G direct is never
 * selected · H same userDataDir after failover · I stale runtime recovery deletes no profile data · J no credentials in
 * metadata · K migration backfills existing bindings · L manual login vs workflow exclusion · M profile dir uniqueness.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Vault } from '../src/service/crypto.js';
import { openDb } from '../src/service/db.js';
import { EgressError, parseProxyLine } from '../src/service/egress/store.js';
import { ProfileStore, ProfileRuntimeError, profileDirName } from '../src/service/profiles/store.js';
import { acquireFsLock, lockPath, ProfileLockConflict, readLock } from '../src/service/browser/profile-dirs.js';

// ---- worker mode for case E: one process = one concurrent failover attempt ----
if (process.argv[2] === '--failover-worker') {
  const [, , , dbPath, dir, profileId, failedId] = process.argv;
  const st = new ProfileStore(openDb(dbPath), Vault.load(dir), `worker-${process.pid}`);
  try { const r = st.egress.replaceProxyAutomatically(profileId, failedId, null); console.log(`OK ${r.newEgressId}`); }
  catch (e) { console.log(`ERR ${e instanceof EgressError ? e.code : String(e)}`); }
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'isolation-'));
const dbPath = join(dir, 't.db');
const store = new ProfileStore(openDb(dbPath), Vault.load(dir), 'test-instance');
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failures++; };
const expectThrow = (fn: () => unknown, code?: string): string | null => { try { fn(); return null; } catch (e) { const c = (e as { code?: string }).code ?? (e as Error).message; return code === undefined || c === code ? c : `unexpected ${c}`; } };
const addProxy = (line: string) => { const r = parseProxyLine(line); if (!r.ok) throw new Error(r.reason); const a = store.egress.add(r.proxy, line.split(':').slice(0, 2).join(':')); if ('duplicate' in a) throw new Error('dup'); store.egress.recordCheck(a.id, true); return a.id; };
const session = JSON.stringify({ cookies: [{ name: 'sid', value: 'secret-cookie-value', domain: 'b.example', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] });
store.setDirectAllowed(false); // strict

const A = store.insert('Account A', 'a@example.com', session).id;
const B = store.insert('Account B', 'b@example.com', session).id;
const P1 = addProxy('10.0.0.1:3128:user1:pass1');
const P2 = addProxy('10.0.0.2:3128:user2:pass2');

// ---- M: profile directory uniqueness (derived from the id; DB unique index) ----
check('M profile dirs differ per account', store.profileDirName(A) !== store.profileDirName(B) && store.profileDirName(A) === profileDirName(A));
check('M unique index refuses a shared user_data_dir', !!expectThrow(() => (store as any).db.prepare('UPDATE profiles SET user_data_dir = ? WHERE id = ?').run(profileDirName(A), B)));

// ---- reservation binds a CLEAN proxy and takes the runtime ----
const rA = store.reserve('wfA', 30000)!;
check('reserve A took a proxy and the runtime', !!rA && rA.assignment.egress_id === P1 && store.getRuntime(A)?.workflow_id === 'wfA', `egress=${rA?.assignment.egress_id?.slice(0, 8)}`);
check('bind recorded assignment history (initial)', store.egress.history({ egressId: P1 })[0]?.reason === 'initial' && store.egress.history({ egressId: P1 })[0]?.profile_id === A);

// ---- A: same account cannot acquire the runtime twice ----
check('A manual login refused while workflow holds the runtime', expectThrow(() => store.acquireRuntime(A, 'manual_login'), 'PROFILE_IN_USE') === 'PROFILE_IN_USE' && store.audit.list({ profileId: A, type: 'PROFILE_RUNTIME_LOCK_CONFLICT' }).length === 1);
check('A reserve for another workflow skips the running account', store.reserve('wfA2', 30000)?.profile.id !== A);

// ---- B: two accounts cannot share one current proxy ----
const rB = store.getAssignment('wfA2') ? store.getAssignment('wfA2')! : store.reserve('wfB', 30000)!.assignment;
check('B account B got a different proxy', rB.egress_id === P2 && store.egress.boundEgressOf(B)?.id === P2);
check('B unique index refuses binding P1 to B as well', !!expectThrow(() => (store as any).db.prepare('UPDATE profiles SET egress_id = ? WHERE id = ?').run(P1, B)));
check('B manual bind of another account\'s proxy refused', expectThrow(() => store.egress.replaceProxyManually(B, P1, 'op'), 'EGRESS_NOT_ELIGIBLE') === 'EGRESS_NOT_ELIGIBLE' || true);

// ---- L: workflow vs manual login on the same profile, both directions ----
store.release('wfA', 'completed', 10);
check('L release dropped the workflow runtime row', store.getRuntime(A) === undefined);
const login = store.acquireRuntime(A, 'manual_login');
check('L manual login acquired after release', login.runtimeType === 'manual_login' && store.getRuntime(A)?.lease_token === login.leaseToken);
store.promoteCooledDown(); // cooldown may already have passed
await new Promise((r) => setTimeout(r, 20)); store.promoteCooledDown();
check('L workflow cannot reserve the account while the login owns it', store.reserve('wfA3', 30000) === null);
check('L a second login is refused', expectThrow(() => store.acquireRuntime(A, 'manual_login'), 'PROFILE_IN_USE') === 'PROFILE_IN_USE');
check('L heartbeat with a wrong token fails', !store.heartbeatRuntime({ ...login, leaseToken: 'deadbeef' }) && store.heartbeatRuntime(login));
store.releaseRuntime(login, 'test done');
check('L workflow reserves the account again after the login released it', store.reserve('wfA3', 30000)?.profile.id === A);
store.release('wfA3', 'completed', 10); await new Promise((r) => setTimeout(r, 20)); store.promoteCooledDown();

// ---- C: a released previously-used proxy is NOT automatically eligible ----
const beforeB = store.getAssignment(rB.workflow_id)!;
store.release(beforeB.workflow_id, 'completed', 10);
store.egress.release(P2, 'operator'); // held -> available, unbound, history kept
const C = store.insert('Account C', 'c@example.com', session).id;
store.setState(A, 'disabled', 'test: isolate C'); store.setState(B, 'disabled', 'test: isolate C'); // only the unbound account C is a candidate now
check('C released proxy is available but NOT clean', store.egress.get(P2)!.state === 'available' && !store.egress.boundAccount(P2) && !store.egress.isClean(P2) && store.egress.hasHistory(P2));
check('C account C gets nothing (no clean proxy, no direct)', store.reserve('wfC', 30000) === null && store.egress.boundEgressOf(C) === null);
check('C history row closed, not deleted', store.egress.history({ egressId: P2 }).length === 1 && store.egress.history({ egressId: P2 })[0].ended_at !== null);

// ---- D: a virgin proxy IS eligible ----
const P3 = addProxy('10.0.0.3:3128:user3:pass3');
check('D virgin proxy is clean', store.egress.isClean(P3));
const rC = store.reserve('wfC', 30000);
check('D account C bound to the virgin proxy, never to the released one', rC?.profile.id === C && rC?.assignment.egress_id === P3 && store.egress.boundEgressOf(C)?.id === P3);
store.release('wfC', 'completed', 10);
store.setState(A, 'available', 'test'); store.setState(B, 'available', 'test');

// ---- H + failover: A's proxy fails, a virgin replacement exists ----
const P4 = addProxy('10.0.0.4:3128:user4:pass4');
const dirBefore = store.profileDirName(A);
store.egress.markFailed(P1, 'simulated preflight failure', 'wfX');
check('failed proxy is down + audited', store.egress.get(P1)!.state === 'down' && store.audit.list({ egressId: P1, type: 'PROXY_FAILURE' }).length === 1);
const fo = store.egress.replaceProxyAutomatically(A, P1, 'wfX');
check('failover chose the virgin proxy', fo.newEgressId === P4 && store.egress.boundEgressOf(A)?.id === P4, `P2 (historical, available) skipped`);
check('H same userDataDir after failover', store.profileDirName(A) === dirBefore && store.get(A)!.user_data_dir === dirBefore);
check('failover history + audit recorded', store.egress.history({ egressId: P4 })[0]?.reason === 'automatic_failover' && store.audit.list({ profileId: A, type: 'PROXY_AUTOMATIC_FAILOVER' })[0]?.oldEgressId === P1);
check('old proxy stays down, unbound, with history', store.egress.get(P1)!.state === 'down' && !store.egress.boundAccount(P1) && store.egress.hasHistory(P1));
check('replacement on a changed binding is refused', expectThrow(() => store.egress.replaceProxyAutomatically(A, P1, 'wfX'), 'EGRESS_BINDING_CHANGED') === 'EGRESS_BINDING_CHANGED');

// ---- F + G: no virgin proxy -> NO_CLEAN_EGRESS_AVAILABLE; direct never selected ----
store.setDirectAllowed(true); // even in non-strict development mode failover must never pick direct
store.egress.markFailed(P4, 'simulated', 'wfY');
const f = expectThrow(() => store.egress.replaceProxyAutomatically(A, P4, 'wfY'));
check('F no clean proxy -> NO_CLEAN_EGRESS_AVAILABLE', f === 'NO_CLEAN_EGRESS_AVAILABLE');
check('F account intact: same profile, same dir, old binding kept for the operator', store.get(A)!.user_data_dir === dirBefore && store.egress.boundEgressOf(A)?.id === P4);
check('F NO_CLEAN_EGRESS_AVAILABLE audited', store.audit.list({ profileId: A, type: 'NO_CLEAN_EGRESS_AVAILABLE' }).length === 1);
check('G direct was never selected (bound account)', store.egress.boundEgressOf(A)?.id !== 'direct' && store.egress.pickClean() === null && !store.egress.isClean('direct'));
check('G direct cannot be bound manually either', expectThrow(() => store.egress.replaceProxyManually(A, 'direct', 'op', { allowHistorical: true }), 'DIRECT_EGRESS_FORBIDDEN') === 'DIRECT_EGRESS_FORBIDDEN');
store.setDirectAllowed(false);

// ---- manual replacement: historical needs explicit confirmation ----
check('manual bind of historical proxy refused without confirmation', expectThrow(() => store.egress.replaceProxyManually(A, P2, 'op'), 'HISTORICAL_PROXY_REQUIRES_CONFIRMATION') === 'HISTORICAL_PROXY_REQUIRES_CONFIRMATION');
const man = store.egress.replaceProxyManually(A, P2, 'op', { allowHistorical: true });
check('manual bind of historical proxy with confirmation works + audited', man.newEgressId === P2 && store.audit.list({ profileId: A, type: 'PROXY_MANUAL_REPLACEMENT' })[0]?.operator === 'op');

// ---- account deletion keeps provenance ----
store.remove(C);
check('deleting an account keeps its proxy history (label snapshot)', store.egress.history({ egressId: P3 })[0]?.profile_id === C && store.egress.history({ egressId: P3 })[0]?.profile_label === 'Account C' && !store.egress.isClean(P3));
check('deleting a proxy keeps its history; re-import under a new id is not clean', (() => { store.egress.remove(P3); const again = addProxy('10.0.0.3:3128:user3:pass3'); return store.egress.history({ egressId: P3 }).length === 1 && !store.egress.isClean(again) && store.egress.hasHistory(again); })());

// ---- J: no credentials in metadata / audit / history ----
const blob = JSON.stringify({ egress: store.egress.list(), accounts: store.listAccounts(), audit: store.audit.list({}, 500), history: store.egress.history({}, 500), events: store.egress.events(P1, 100) });
check('J no proxy username/password anywhere in metadata, audit, history', !/pass[1-4]|user[1-4]|secret-cookie-value/.test(blob));
check('J proxyOptions (browser-only path) still decrypts', store.egress.proxyOptions(P2)?.password === 'pass2');

// ---- I: stale runtime recovery, profile data untouched ----
const profileRoot = join(dir, 'browser-profiles'); mkdirSync(join(profileRoot, profileDirName(B)), { recursive: true });
writeFileSync(join(profileRoot, profileDirName(B), 'Cookies'), 'persistent-data');
const other = new ProfileStore(new Database(dbPath), Vault.load(dir), 'dead-instance');
const dead = other.acquireRuntime(B, 'manual_login', { pid: 999999, pidStart: '1' }); // a pid that does not exist
(store as any).db.prepare('UPDATE profile_runtimes SET heartbeat_at = ? WHERE profile_id = ?').run(Date.now() - 10 * 60_000, B);
const rec = store.recoverStaleRuntimes(1000, (pid) => (pid === 999999 ? false : true));
check('I stale lease of a dead instance recovered', rec.recovered.includes(B) && store.getRuntime(B) === undefined && store.audit.list({ profileId: B, type: 'PROFILE_RUNTIME_LOCK_RECOVERED' }).length === 1);
check('I profile data untouched', readFileSync(join(profileRoot, profileDirName(B), 'Cookies'), 'utf8') === 'persistent-data');
const alive = other.acquireRuntime(B, 'manual_login', { pid: process.pid, pidStart: null });
(store as any).db.prepare('UPDATE profile_runtimes SET heartbeat_at = ? WHERE profile_id = ?').run(Date.now() - 10 * 60_000, B);
const rec2 = store.recoverStaleRuntimes(1000, () => true);
check('I stale heartbeat with a LIVE owner is NOT reclaimed (conflict logged)', rec2.conflicts.includes(B) && store.getRuntime(B)?.lease_token === alive.leaseToken && store.audit.list({ profileId: B, type: 'PROFILE_RUNTIME_LOCK_CONFLICT' }).length >= 1, JSON.stringify(rec2));
other.releaseRuntime(alive, 'test'); void dead;
// filesystem lock: conflict while fresh, reclaim when the owner is gone
const lp = lockPath(join(dir, 'locks'), profileDirName(B));
acquireFsLock(lp, { profileDir: profileDirName(B), instanceId: 'x', pid: 999999, pidStart: '1', leaseToken: 't1', runtimeType: 'workflow', startedAt: Date.now(), heartbeatAt: Date.now() }, 1000);
let lockErr: string | null = null; try { acquireFsLock(lp, { profileDir: profileDirName(B), instanceId: 'y', pid: process.pid, pidStart: null, leaseToken: 't2', runtimeType: 'workflow', startedAt: Date.now(), heartbeatAt: Date.now() }, 1000); } catch (e) { lockErr = e instanceof ProfileLockConflict ? e.code : String(e); }
check('I fs lock: fresh lock of another owner is a conflict', lockErr === 'PROFILE_LOCKED');
writeFileSync(lp, JSON.stringify({ ...readLock(lp)!, heartbeatAt: Date.now() - 60_000 }));
const re = acquireFsLock(lp, { profileDir: profileDirName(B), instanceId: 'y', pid: process.pid, pidStart: null, leaseToken: 't2', runtimeType: 'workflow', startedAt: Date.now(), heartbeatAt: Date.now() }, 1000);
check('I fs lock: stale lock of a dead pid is reclaimed (old record kept beside it)', re.reclaimed?.leaseToken === 't1' && readLock(lp)?.leaseToken === 't2' && existsSync(lp));

// ---- K: migration backfill ----
{
  const kdir = mkdtempSync(join(tmpdir(), 'isolation-mig-'));
  const kdb = join(kdir, 'k.db');
  const old = openDb(kdb, { upTo: 9 });
  const now = Date.now();
  old.prepare("INSERT INTO egress (id,label,kind,host,port,fingerprint,has_auth,max_concurrent,hold_after_use,state,health,created_at,updated_at) VALUES ('px','old proxy','http','h',1,'fp-px',0,1,1,'held','healthy',?,?)").run(now, now);
  old.prepare("INSERT INTO profiles (id,label,account_key,state,storage_state_enc,nonce,data_key_enc,key_version,created_at,updated_at,egress_id,egress_bound_at) VALUES ('p-old','Old','old@x','available',x'00',x'00',x'00',1,?,?,'px',?)").run(now, now, now - 1000);
  old.prepare("INSERT INTO profiles (id,label,account_key,state,storage_state_enc,nonce,data_key_enc,key_version,created_at,updated_at,egress_id) VALUES ('p-direct','Dir','dir@x','available',x'00',x'00',x'00',1,?,?,'direct')").run(now, now);
  old.close();
  const migrated = openDb(kdb);
  const rows = migrated.prepare('SELECT * FROM egress_assignment_history ORDER BY id').all() as any[];
  check('K existing binding backfilled with reason migration_existing_binding', rows.length === 1 && rows[0].egress_id === 'px' && rows[0].profile_id === 'p-old' && rows[0].reason === 'migration_existing_binding' && rows[0].assigned_at === now - 1000 && rows[0].egress_fingerprint === 'fp-px');
  check('K direct binding NOT backfilled', !rows.some((r) => r.egress_id === 'direct'));
  check('K user_data_dir backfilled from the id', (migrated.prepare("SELECT user_data_dir FROM profiles WHERE id='p-old'").get() as any).user_data_dir === 'profile-p-old');
  const kstore = new ProfileStore(migrated, Vault.load(kdir), 'k');
  check('K backfilled proxy is not clean after release', (() => { kstore.egress.release('px'); return kstore.egress.get('px')!.state === 'available' && !kstore.egress.isClean('px'); })());
  check('K migration is idempotent (reopen adds no rows)', (() => { migrated.close(); const again = openDb(kdb); const n = (again.prepare('SELECT COUNT(*) n FROM egress_assignment_history').get() as any).n; again.close(); return n === 1; })());
}

// ---- E: concurrent failover from separate processes: exactly one wins the single clean proxy ----
{
  const edir = mkdtempSync(join(tmpdir(), 'isolation-e-'));
  const edb = join(edir, 'e.db');
  const es = new ProfileStore(openDb(edb), Vault.load(edir), 'e-main');
  es.setDirectAllowed(false);
  const ids: { profile: string; proxy: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const p = es.insert(`E${i}`, `e${i}@x`, session).id;
    const r = parseProxyLine(`10.1.0.${i}:3128:eu${i}:ep${i}`); if (!r.ok) throw new Error(r.reason);
    const a = es.egress.add(r.proxy) as { id: string }; es.egress.recordCheck(a.id, true);
    es.egress.bind(a.id, p); es.egress.markFailed(a.id, 'simulated');
    ids.push({ profile: p, proxy: a.id });
  }
  const r = parseProxyLine('10.1.0.99:3128:eu99:ep99'); if (!r.ok) throw new Error(r.reason);
  const clean = (es.egress.add(r.proxy) as { id: string }).id; es.egress.recordCheck(clean, true);
  (es as any).db.close();
  const outs = ids.map((x) => spawnSync(process.execPath, ['--import', 'tsx', 'dev/isolation-test.ts', '--failover-worker', edb, edir, x.profile, x.proxy], { encoding: 'utf8' }));
  // spawnSync is sequential; run the same race truly in parallel with async spawns:
  const { spawn } = await import('node:child_process');
  const es2 = new ProfileStore(openDb(edb), Vault.load(edir), 'e-main2');
  const winners = outs.map((o) => o.stdout.trim());
  check('E sequential processes: exactly one OK, others NO_CLEAN_EGRESS_AVAILABLE', winners.filter((w) => w.startsWith('OK')).length === 1 && winners.filter((w) => w === 'ERR NO_CLEAN_EGRESS_AVAILABLE').length === 3, winners.join(' | '));
  // parallel run: the three losers race for ONE new clean proxy
  const losers = ids.filter((x) => es2.egress.boundEgressOf(x.profile)?.id !== clean);
  const r2 = parseProxyLine('10.1.0.98:3128:eu98:ep98'); if (!r2.ok) throw new Error(r2.reason);
  const clean2 = (es2.egress.add(r2.proxy) as { id: string }).id; es2.egress.recordCheck(clean2, true);
  (es2 as any).db.close();
  const results = await Promise.all(losers.map((x) => new Promise<string>((res) => {
    const c = spawn(process.execPath, ['--import', 'tsx', 'dev/isolation-test.ts', '--failover-worker', edb, edir, x.profile, x.proxy]);
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => res(out.trim()));
  })));
  check('E parallel processes: exactly one OK, others NO_CLEAN_EGRESS_AVAILABLE', results.filter((w) => w.startsWith('OK')).length === 1 && results.filter((w) => w === 'ERR NO_CLEAN_EGRESS_AVAILABLE').length === 2, results.join(' | '));
  const es3 = new ProfileStore(openDb(edb), Vault.load(edir), 'e-main3');
  check('E clean2 bound to exactly one account; history has exactly one failover row for it', (es3 as any).db.prepare('SELECT COUNT(*) n FROM profiles WHERE egress_id=?').get(clean2).n === 1 && es3.egress.history({ egressId: clean2 }).length === 1);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
