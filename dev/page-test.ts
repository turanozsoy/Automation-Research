/**
 * Drives the debug harness page (/debug, src/test-a/debug.html) in a headless browser exactly like a person:
 * Start workflow, type into the inputs, Submit, Open link, wait for verification.
 * Complements dev/e2e-client.ts, which talks to the WebSocket directly.
 *   npm run fake-b  +  npm run start:fake  (with a saved fake account), then: npm run e2e:page
 */
import { chromium } from 'playwright';

const port = Number(process.env.PORT ?? 3000);
const b = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
const p = await b.newPage();
const fail = (m: string) => { console.error('[page-test] FAIL:', m); process.exit(1); };
try {
  await p.goto(`http://localhost:${port}/debug`);
  await p.waitForFunction(() => document.querySelector('#state')!.textContent === 'idle', null, { timeout: 15000 });
  await p.click('#btnStart');
  await p.waitForFunction(() => document.querySelector('#state')!.textContent === 'ready', null, { timeout: 60000 });
  const vals: Record<string, string> = { firstName: 'John', lastName: 'Doe', dateOfBirth: '05/17/1990', mobileNumber: '5551234567', address1: '1 Main St', city: 'Springfield', zip: '10001', authenticationCode: '123-45-6789' };
  for (const [k, v] of Object.entries(vals)) await p.locator(`[data-field="${k}"]`).pressSequentially(v, { delay: 30 });
  await p.selectOption('[data-field="state"]', 'NY');
  await p.waitForFunction(() => [...document.querySelectorAll('[data-sync]')].every((s) => s.textContent!.startsWith('✓')), null, { timeout: 15000 });
  await p.click('#btnSubmit');
  await p.waitForSelector('#result button', { timeout: 90000 });
  const url = await p.locator('#result div').textContent();
  await p.click('#result button');
  await p.waitForFunction(() => document.querySelector('#state')!.textContent === 'completed', null, { timeout: 60000 });
  const btn = await p.locator('#result button').textContent();
  if (!url || !btn?.includes('Verified')) fail(`url=${url} button=${btn}`);
  console.log(`[page-test] OK ${url}`);
} catch (e) {
  const log = await p.locator('#log').innerText().catch(() => '');
  fail(`${e instanceof Error ? e.message.split('\n')[0] : e}\n--- page log ---\n${log.split('\n').slice(-15).join('\n')}`);
} finally {
  await b.close();
}
