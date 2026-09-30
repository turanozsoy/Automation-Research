/**
 * Unit test for the application store and session helpers, on a throwaway database:
 * creation, token authentication (hash only stored), field updates, patch whitelist, events.
 *   npm run test:app
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/service/db.js';
import { ApplicationStore } from '../src/service/applications/store.js';
import { hashSessionToken, looksLikeToken, parseCookies, sessionCookie, SESSION_COOKIE } from '../src/service/applications/session.js';

const dir = mkdtempSync(join(tmpdir(), 'app-store-'));
const db = openDb(join(dir, 'test.db'));
const store = new ApplicationStore(db);
let failures = 0;
const check = (cond: unknown, what: string) => { if (!cond) { failures++; console.error(`  FAIL: ${what}`); } else console.log(`  ok: ${what}`); };

try {
  // ---- creation + authentication ----
  const { row, token } = store.create('start');
  check(looksLikeToken(token), 'token is a well-formed opaque token');
  check(row.session_token_hash === hashSessionToken(token), 'only the token hash is stored');
  check(!JSON.stringify(row).includes(token), 'the token itself never appears in the row');
  check(store.authenticate(token)?.id === row.id, 'authenticate(token) finds the application');
  check(store.authenticate(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')) === undefined, 'a token differing in one character does not authenticate');
  check(store.authenticate(row.id) === undefined, 'the applicationId is not a credential');
  check(row.state === 'started' && row.current_step === 'start' && row.verification_step === 'required' && row.workflow_id === null, 'fresh application defaults');

  const second = store.create();
  check(second.token !== token && second.row.id !== row.id, 'two applications have distinct ids and tokens');
  check(store.authenticate(second.token)?.id === second.row.id, 'second token maps to the second application only');

  // ---- fields ----
  store.updateFields(row.id, { firstName: 'John', mobileNumber: '5551234567', email: 'john@example.com', state: 'NY' });
  const r2 = store.get(row.id)!;
  check(r2.first_name === 'John' && r2.phone === '5551234567' && r2.email === 'john@example.com' && r2.address_state === 'NY', 'updateFields maps Website B names to columns');
  check(store.get(second.row.id)!.first_name === null, 'updating one application leaves the other untouched');
  check(!Object.keys(r2).some((k) => /auth|verification_code|secret|otp/i.test(k)), 'no column can hold the verification code');

  // ---- patch whitelist ----
  let threw = false;
  try { store.patch(row.id, { session_token_hash: 'x' } as never); } catch { threw = true; }
  check(threw, 'patch refuses the token hash column');
  threw = false;
  try { store.patch(row.id, { first_name: 'x' } as never); } catch { threw = true; }
  check(threw, 'patch refuses applicant field columns (use updateFields)');
  store.patch(row.id, { state: 'processing', workflow_id: 'wf-1', workflow_count: 1 });
  check(store.byWorkflow('wf-1')?.id === row.id && store.processing().length === 1, 'byWorkflow / processing() see the patched row');
  store.patch(row.id, { state: 'problem', workflow_id: null, problem_code: 'SERVICE_RESTARTED' });
  check(store.processing().length === 0 && store.byWorkflow('wf-1') === undefined, 'workflow detached on problem');

  // ---- answers + events ----
  store.mergeAnswers(row.id, { position: 'driver' });
  store.mergeAnswers(row.id, { availability: 'nights' });
  check(JSON.parse(store.get(row.id)!.answers_json).position === 'driver' && JSON.parse(store.get(row.id)!.answers_json).availability === 'nights', 'answers merge');
  store.event(row.id, 'problem', { workflowId: 'wf-1', stage: 'agree', code: 'AGREE_NOT_FOUND', message: 'safe text', retryCount: 0 });
  const evs = store.events(row.id);
  check(evs[0].type === 'problem' && evs[0].code === 'AGREE_NOT_FOUND' && evs[0].workflow_id === 'wf-1' && evs.some((e) => e.type === 'application_started'), 'events recorded with structure');

  // ---- cookies ----
  const c = sessionCookie(token, { secure: true, maxAgeMs: 60_000 });
  check(c.startsWith(`${SESSION_COOKIE}=${token}`) && c.includes('HttpOnly') && c.includes('SameSite=Lax') && c.includes('Secure') && c.includes('Max-Age=60'), 'session cookie attributes');
  check(!sessionCookie(token, { secure: false, maxAgeMs: 60_000 }).includes('Secure'), 'Secure omitted when not configured');
  check(parseCookies(`a=1; ${SESSION_COOKIE}=${token}; b=x%20y`)[SESSION_COOKIE] === token && parseCookies('a=1; b=x%20y').b === 'x y' && Object.keys(parseCookies(undefined)).length === 0, 'cookie parsing');
  check(!looksLikeToken('short') && !looksLikeToken(undefined) && !looksLikeToken('x'.repeat(41) + '!'), 'malformed tokens rejected before lookup');
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `[test:app] ${failures} check(s) failed` : '[test:app] all checks passed');
process.exit(failures ? 1 : 0);
