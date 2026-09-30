/**
 * Scripted stand-in for a person using the test page. Starts one workflow (or
 * E2E_PARALLEL workflows at once), "types" into fields with rapid intermediate
 * values (exercises coalescing), submits, and waits for the generated URL.
 * Exits 0 when every workflow succeeded, 1 otherwise.
 */
import WebSocket from 'ws';
import type { ServerMsg } from '../src/shared/messages.js';

const port = Number(process.env.PORT ?? 3000);
const parallel = Number(process.env.E2E_PARALLEL ?? 1);
const expectAdvanced = process.env.E2E_EXPECT_ADVANCED === '1';
const expectFieldError = process.env.E2E_EXPECT_FIELD_ERROR === '1';
const expectReturning = process.env.E2E_EXPECT_RETURNING === '1'; // fake started with FAKE_B_RETURNING=1: no Agree, no toggle, no primary (checkout path 3 → 7)
const overall = setTimeout(() => { console.error('[e2e] TIMEOUT'); process.exit(1); }, 150_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(`ws://localhost:${port}/ws`);
const send = (m: object) => ws.send(JSON.stringify({ ts: Date.now(), ...m }));

interface Run { id: string; acks: Map<string, string>; deferred: Set<string>; seen: Set<string>; seq: Record<string, number>; submitAt: number; done: boolean; ok: boolean }
const runs = new Map<string, Run>();
let pendingStarts = 0;
const tag = (id: string) => id.slice(0, 8);

function field(run: Run, f: string, v: string) { run.seq[f] = (run.seq[f] ?? 0) + 1; send({ type: 'field.update', workflowId: run.id, field: f, value: v, seq: run.seq[f] }); }

function finishRun(run: Run, ok: boolean, why?: string) {
  if (run.done) return;
  run.done = true; run.ok = ok;
  console.log(`[e2e] ${tag(run.id)} ${ok ? 'OK' : 'FAILED'}${why ? ': ' + why : ''}`);
  if ([...runs.values()].every((r) => r.done) && pendingStarts === 0) {
    const allOk = [...runs.values()].every((r) => r.ok) && runs.size === parallel;
    console.log(allOk ? '[e2e] all checks passed' : '[e2e] some workflows failed');
    clearTimeout(overall); ws.close(); process.exit(allOk ? 0 : 1);
  }
}

ws.on('open', () => console.log('[e2e] connected'));
ws.on('message', async (raw) => {
  const m = JSON.parse(raw.toString()) as ServerMsg;
  if (m.type === 'hello') {
    console.log(`[e2e] pool: ${JSON.stringify(m.pool)}`);
    pendingStarts = parallel;
    for (let i = 0; i < parallel; i++) send({ type: 'workflow.start' });
    return;
  }
  if (m.type === 'pool.status') return;
  if (m.type === 'workflow.accepted' && !runs.has(m.workflowId)) {
    pendingStarts--;
    const run: Run = { id: m.workflowId, acks: new Map(), deferred: new Set(), seen: new Set(), seq: {}, submitAt: 0, done: false, ok: false };
    runs.set(run.id, run);
    console.log(`[e2e] ${tag(run.id)} accepted${m.queuePosition ? ' (queued ' + m.queuePosition + ')' : ''}`);
    // Buffered updates before READY: must be applied once ready.
    field(run, 'firstName', 'J'); field(run, 'firstName', 'Jo'); field(run, 'firstName', 'John');
    return;
  }
  const run = 'workflowId' in m && m.workflowId ? runs.get(m.workflowId) : undefined;
  if (!run) { if (m.type === 'error') console.log(`[svc] ERROR ${m.code}: ${m.message}`); return; }
  const t = `[svc ${tag(run.id)}]`;
  if (m.type === 'event') { run.seen.add(m.name); console.log(`${t} ${m.name}${m.detail ? ' — ' + m.detail : ''}${m.sinceLastMs !== undefined ? ` (+${m.sinceLastMs} ms)` : ''}`); }
  if (m.type === 'error') console.log(`${t} ${m.fatal ? 'FATAL ' : ''}ERROR ${m.code}: ${m.message}`);
  if (m.type === 'field.ack') { run.acks.set(m.field, m.value); console.log(`[e2e ${tag(run.id)}] ack ${m.field}="${m.value}" transit ${m.receivedAt - m.sentAt} ms fill ${m.filledAt - m.startedAt} ms`); }
  if (m.type === 'field.deferred') run.deferred.add(m.field);
  if (m.type === 'field.error') console.log(`[e2e ${tag(run.id)}] field.error ${m.field} ${m.code} ${m.message}`);
  if (m.type === 'paused') { console.log(`[e2e ${tag(run.id)}] PAUSED at ${m.step}: ${m.code} — sending skip`); run.seen.add(`paused:${m.step}`); send({ type: 'resume', workflowId: run.id, mode: 'skip' }); }

  if (m.type === 'state' && m.state === 'ready') {
    await sleep(100);
    field(run, 'lastName', 'Doe'); field(run, 'dateOfBirth', '1990-05-17'); field(run, 'mobileNumber', '5551234567');
    field(run, 'address1', '1 Main St'); field(run, 'city', 'Springfield'); field(run, 'state', 'NY'); field(run, 'zip', '10001'); field(run, 'authenticationCode', '123-45-6789');
    // A person only presses Submit after the code was typed; wait for the finalisation + code (bounded).
    for (let i = 0; i < 100 && !run.seen.has('authenticationCode updated (masked)'); i++) await sleep(100);
    await sleep(300);
    run.submitAt = Date.now();
    send({ type: 'submit', workflowId: run.id, snapshot: { firstName: 'John', lastName: 'Doe', dateOfBirth: '05/17/1990', mobileNumber: '5551234567', address1: '1 Main St', city: 'Springfield', state: 'NY', zip: '10002', authenticationCode: '123-45-6789' } });
  }
  if (m.type === 'result') {
    console.log(`[e2e ${tag(run.id)}] RESULT ${m.url} via ${m.source} — ${Date.now() - run.submitAt} ms after submit`);
    run.seen.add('result');
    setTimeout(() => { console.log(`[e2e ${tag(run.id)}] opening link`); send({ type: 'link.opened', workflowId: run.id }); }, 500);
    return;
  }
  if (m.type === 'state' && m.state === 'completed') {
    const problems: string[] = [];
    for (const f of ['firstName', 'lastName', 'dateOfBirth', 'mobileNumber', 'authenticationCode']) if (!run.acks.has(f)) problems.push(`missing ack ${f}`);
    if (run.acks.get('dateOfBirth') !== '05/17/1990') problems.push('DOB not normalised');
    if (run.acks.get('authenticationCode') !== '(masked)') problems.push('auth code ack exposes value');
    for (const f of ['address1', 'city', 'zip']) if (!run.acks.has(f)) problems.push(`${f} was not live-synced`);
    const expected = ['session verified', 'authenticationCode started, finalizing address', 'pending address updates flushed', 'Enter pressed on address1', 'address autocomplete finalized', 'authenticationCode updated (masked)',
      'final reconciliation started', 'ordinary fields reconciled', 'verifying final address', 'final address verified', 'authenticationCode verified (masked, not compared)', 'final reconciliation complete',
      ...(expectReturning ? ['Agree and continue not present: secondary button visible first', 'checkout toggle step skipped', 'primary step skipped', 'secondary step already done'] : ['Agree and continue clicked', 'checkbox unchecked']),
      ...(expectAdvanced ? [] : ['Website B submit clicked']),
      ...(expectFieldError ? ['field error detected: city', 'field re-filled: city', 'field errors fixed', 'submit retried (attempt 2)'] : [])];
    expected.push('result', 'link opened by user (visited)', 'link state stored: visited', 'verification text found', 'link state stored: verified');
    for (const ev of expected) if (!run.seen.has(ev)) problems.push(`missing event: ${ev}`);
    finishRun(run, problems.length === 0, problems.join('; '));
  }
  if (m.type === 'state' && (m.state === 'failed' || m.state === 'abandoned')) finishRun(run, false, `${m.state}: ${m.detail ?? ''}`);
});
ws.on('error', (e) => { console.error('[e2e] ws error', e.message); process.exit(1); });
