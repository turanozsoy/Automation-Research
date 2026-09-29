/** Unit test for the allocator: concurrent reservations never hand out the same profile. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/service/crypto.js';
import { openDb } from '../src/service/db.js';
import { ProfileStore } from '../src/service/profiles/store.js';

const dir = mkdtempSync(join(tmpdir(), 'pool-'));
const store = new ProfileStore(openDb(join(dir, 't.db')), Vault.load(dir), 'test');
const fail = (m: string) => { console.error('FAIL:', m); process.exit(1); };

for (let i = 1; i <= 3; i++) store.insert(`p${i}`, `acct${i}`, JSON.stringify({ cookies: [], origins: [] }));
try { store.insert('dup', 'acct1', '{}'); fail('duplicate account_key accepted'); } catch { /* expected */ }

// 10 "simultaneous" reservations for 3 profiles
const results = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => store.reserve(`wf${i}`, 30000))));
const got = results.filter(Boolean).map((r) => r!.profile.id);
if (got.length !== 3) fail(`expected 3 reservations, got ${got.length}`);
if (new Set(got).size !== 3) fail('same profile reserved twice');
if (store.reserve('wf0', 30000)?.profile.id !== got[0]) fail('re-reserve for same workflow not idempotent');

store.setAssignmentState('wf0', 'preparing'); store.setAssignmentState('wf0', 'ready');
if (store.get(got[0])!.state !== 'active') fail('profile not active after ready');

store.release('wf0', 'completed', 1000);
if (store.get(got[0])!.state !== 'cooldown') fail('profile not in cooldown after completed');
if (store.reserve('wf20', 30000)) fail('reserved a profile still in cooldown');
await new Promise((r) => setTimeout(r, 1100));
if (store.promoteCooledDown() !== 1) fail('cooldown not promoted');
if (!store.reserve('wf20', 30000)) fail('could not reserve after cooldown');

store.release('wf1', 'auth_expired', 1000);
if (store.get(got[1])!.state !== 'expired') fail('profile not expired after auth_expired');
store.reseed(got[1], JSON.stringify({ cookies: [], origins: [] }));
if (store.get(got[1])!.state !== 'available') fail('reseed did not restore availability');

// reassign keeps the workflow id free for a new reservation
store.release('wf2', 'auth_expired', 1000, { reassign: true });
if (!store.reserve('wf2', 30000)) fail('could not reserve a new profile for a reassigned workflow');

// orphan recovery
const lost = store.recoverOrphans(1000);
if (lost.length !== 2) fail(`expected 2 orphans, got ${lost.length}`);
console.log('store test OK', JSON.stringify(store.status()));
rmSync(dir, { recursive: true, force: true });
