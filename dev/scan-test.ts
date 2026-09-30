/**
 * Drives the real test page: uploads a synthetic license barcode PNG through the
 * "Take / upload photo" input and checks the fields the page fills.
 *   service running (fake or real config), then: npx tsx dev/scan-test.ts <png>
 */
import { chromium } from 'playwright';

const png = process.argv[2] ?? 'license-test.png';
const port = Number(process.env.PORT ?? 3000);
const b = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
const p = await b.newPage();
const requests: string[] = [];
p.on('request', (r) => requests.push(r.url()));
p.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR:', m.text()); });
try {
  await p.goto(`http://localhost:${port}`);
  await p.waitForFunction(() => document.querySelector('#state')!.textContent === 'idle', null, { timeout: 15000 });
  await p.setInputFiles('#scanFile', png);
  await p.waitForFunction(() => /Filled from the license|No barcode|Could not|not a U.S./.test(document.querySelector('#scanStatus')!.textContent || ''), null, { timeout: 60000 });
  console.log('status:', await p.locator('#scanStatus').textContent());
  const vals: Record<string, string> = {};
  for (const f of ['firstName', 'lastName', 'dateOfBirth', 'address1', 'city', 'state', 'zip', 'mobileNumber', 'authenticationCode']) vals[f] = await p.locator(`[data-field="${f}"]`).inputValue();
  console.log(JSON.stringify(vals));
  const expected: Record<string, string> = { firstName: 'Jane', lastName: 'Doe', dateOfBirth: '01/14/1990', address1: '8655 Bay Pkwy Apt F3', city: 'Brooklyn', state: 'NY', zip: '11214', mobileNumber: '', authenticationCode: '' };
  const wrong = Object.entries(expected).filter(([k, v]) => vals[k] !== v).map(([k, v]) => `${k}: got "${vals[k]}" want "${v}"`);
  const leaked = requests.filter((u) => !/^http:\/\/localhost:\d+\/(|index\.html|client\.js|scan\.js|admin\.html|admin\.js|api\/scan\/license|favicon\.ico)$/.test(u) && !u.startsWith('ws://'));
  if (leaked.length) console.log('unexpected requests:', leaked);
  if (wrong.length || leaked.length) { console.error('[scan-test] FAIL', wrong.join('; ')); process.exit(1); }
  console.log('[scan-test] OK — all 7 fields filled correctly; only page assets and /api/scan/license were requested');
} finally {
  await b.close();
}
