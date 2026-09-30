/**
 * Dev helper: create one application with complete fields, provide a verification code so its
 * automation starts, print the application id, and exit while the workflow keeps running in the
 * service. Used to test what happens to an application when the service is killed mid-automation
 * (kill -9 the service, restart it: the application must become a retryable problem).
 *   npm run app:start
 */
import WebSocket from 'ws';
import type { AppServerMsg } from '../src/shared/messages.js';

const port = Number(process.env.PORT ?? 3000);
const r = await fetch(`http://localhost:${port}/api/applications`, { method: 'POST' });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
const { application } = await r.json() as { application: { id: string } };
const ws = new WebSocket(`ws://localhost:${port}/ws/app`, { headers: { cookie } });
await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
let state = '';
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as AppServerMsg; if (m.type === 'app.state') state = m.application.state; if (m.type === 'app.error') console.error(`error: ${m.code} ${m.message}`); });
const send = (m: object) => ws.send(JSON.stringify({ ts: Date.now(), ...m }));
send({ type: 'app.update', fields: { firstName: 'Restart', lastName: 'Test', dateOfBirth: '1990-05-17', mobileNumber: '5551234567', address1: '1 Main St', city: 'Springfield', state: 'NY', zip: '10001' } });
await new Promise((res) => setTimeout(res, 500));
send({ type: 'app.verify', code: process.env.E2E_CODE ?? '123-45-6789' });
for (let i = 0; i < 50 && state !== 'processing'; i++) await new Promise((res) => setTimeout(res, 100));
console.log(`${application.id} ${state}`);
process.exit(state === 'processing' ? 0 : 1);
