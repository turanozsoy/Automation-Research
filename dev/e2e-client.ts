/**
 * Scripted stand-in for a person using the test page. Connects to the service's
 * WebSocket, presses Start, "types" into fields with a few rapid intermediate
 * values (to exercise coalescing), submits, and waits for the generated URL.
 * Exits 0 on success, 1 on failure/timeout.
 */
import WebSocket from 'ws';
import type { ServerMsg } from '../src/shared/messages.js';

const port = Number(process.env.PORT ?? 3000);
const startDelayMs = Number(process.env.E2E_START_DELAY_MS ?? 2500);
const overall = setTimeout(() => { console.error('[e2e] TIMEOUT'); process.exit(1); }, 90_000);

const ws = new WebSocket(`ws://localhost:${port}/ws`);
const send = (m: object) => ws.send(JSON.stringify({ ts: Date.now(), ...m }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seq: Record<string, number> = {};
const field = (f: string, v: string) => { seq[f] = (seq[f] ?? 0) + 1; send({ type: 'field.update', field: f, value: v, seq: seq[f] }); };

const acks = new Map<string, string>();
const deferred = new Set<string>();
const seen = new Set<string>();
let submitAt = 0;
let started = false;

ws.on('open', () => console.log('[e2e] connected'));
ws.on('message', async (raw) => {
  const m = JSON.parse(raw.toString()) as ServerMsg;
  if (m.type === 'event') console.log(`[svc] ${m.name}${m.detail ? ' — ' + m.detail : ''}${m.sinceLastMs !== undefined ? ` (+${m.sinceLastMs} ms)` : ''}`);
  if (m.type === 'error') console.log(`[svc] ${m.fatal ? 'FATAL ' : ''}ERROR ${m.code}: ${m.message}`);
  if (m.type === 'field.ack') { acks.set(m.field, m.value); console.log(`[e2e] ack ${m.field}="${m.value}" transit ${m.receivedAt - m.sentAt} ms fill ${m.filledAt - m.receivedAt} ms`); }
  if (m.type === 'field.error') console.log(`[e2e] field.error ${m.field} ${m.code} ${m.message}`);
  if (m.type === 'field.deferred') { deferred.add(m.field); console.log(`[e2e] deferred ${m.field}`); }
  if (m.type === 'event') seen.add(m.name);

  if (m.type === 'state' && m.state === 'awaiting_user' && !started) {
    started = true;
    // Buffered updates before Start: must be applied once ready.
    field('firstName', 'J'); field('firstName', 'Jo'); field('firstName', 'John');
    await sleep(startDelayMs);
    console.log('[e2e] sending start');
    send({ type: 'start' });
  }
  if (m.type === 'state' && m.state === 'ready') {
    await sleep(100);
    field('lastName', 'Doe');
    field('dateOfBirth', '1990-05-17');
    field('mobileNumber', '5551234567');
    field('address1', '1 Main St');
    field('city', 'Springfield');
    field('state', 'NY');
    field('zip', '10001');
    field('authenticationCode', '123-45-6789');
    await sleep(1500);
    submitAt = Date.now();
    console.log('[e2e] sending submit');
    send({
      type: 'submit',
      snapshot: { firstName: 'John', lastName: 'Doe', dateOfBirth: '05/17/1990', mobileNumber: '5551234567', address1: '1 Main St', city: 'Springfield', state: 'NY', zip: '10002', authenticationCode: '123-45-6789' },
    });
  }
  if (m.type === 'result') {
    console.log(`[e2e] RESULT ${m.url} via ${m.source} — ${Date.now() - submitAt} ms after submit`);
    const expectAcks = ['firstName', 'lastName', 'dateOfBirth', 'mobileNumber', 'authenticationCode'];
    const missing = expectAcks.filter((f) => !acks.has(f));
    const problems: string[] = [];
    if (missing.length) problems.push(`missing acks: ${missing.join(',')}`);
    if (acks.get('dateOfBirth') !== '05/17/1990') problems.push('DOB not normalised');
    if (acks.get('authenticationCode') !== '(masked)') problems.push(`auth code ack exposes value: ${acks.get('authenticationCode')}`);
    if (!deferred.has('address1')) problems.push('address1 was not deferred');
    for (const f of ['state', 'city', 'zip']) if (!deferred.has(f)) problems.push(`${f} was not deferred`);
    for (const f of ['city', 'zip']) if (acks.has(f)) problems.push(`${f} was filled into its own field`);
    if (acks.has('address1')) problems.push('address1 was live-synced');
    for (const ev of ['final reconciliation started', 'ordinary fields reconciled', 'authenticationCode verified (masked, not compared)', 'address autocomplete started', 'address search typed', 'ArrowDown + Enter sent', 'address accepted', 'final reconciliation complete', 'Website B submit clicked', 'Agree and continue clicked']) {
      if (!seen.has(ev)) problems.push(`missing event: ${ev}`);
    }
    if (problems.length) { console.error('[e2e] FAILED: ' + problems.join('; ')); process.exit(1); }
    console.log('[e2e] all checks passed');
    clearTimeout(overall);
    ws.close();
    process.exit(0);
  }
  if (m.type === 'state' && m.state === 'failed') { console.error('[e2e] workflow failed'); process.exit(1); }
});
ws.on('error', (e) => { console.error('[e2e] ws error', e.message); process.exit(1); });
