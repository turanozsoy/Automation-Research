/**
 * Profile CLI (run with: npm run profile -- <command> [options])
 *
 *   seed   --label <name> --account <accountKey>        opens a visible Chromium on Website B; log in by hand,
 *                                                        press Enter in this terminal, the session is saved encrypted
 *   import --label <name> --account <accountKey> --file <storageState.json>
 *   reseed <label|id>  [--file <storageState.json>]      replace the session of an expired/invalid profile
 *   list                                                  table of profiles and states
 *   verify <label|id>                                     opens Website B with the profile (headless) and checks the session
 *   disable <label|id> | enable <label|id> | remove <label|id>
 *   events <label|id>                                     recent state transitions
 *   workflows                                             recent workflows: profile, state, link state (none/visited/verified), URL
 *
 * Profiles are stored encrypted in <DATA_DIR>/automation.db. The same Website B
 * account must not be seeded twice (account key is unique).
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { isLoginUrl, loadConfig } from '../src/service/config.js';
import { Vault } from '../src/service/crypto.js';
import { openDb } from '../src/service/db.js';
import { ProfileStore } from '../src/service/profiles/store.js';
import { loadSettings } from '../src/service/settings.js';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')))[0];

const settings = loadSettings();
const cfg = loadConfig();
const store = new ProfileStore(openDb(settings.dbPath), Vault.load(settings.dataDir), 'cli');

function fmt(ts: number | null): string { return ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : '-'; }

async function waitEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((r) => rl.question(prompt, () => r()));
  rl.close();
}

async function captureSession(): Promise<string> {
  const browser = await chromium.launch({ headless: false, executablePath: settings.chromiumPath, args: ['--window-size=1280,900'] });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(cfg.targetUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageLoad }).catch(() => {});
  console.log(`\nA Chromium window is open on ${cfg.targetUrl}.`);
  console.log('Log in there with the account for this profile and reach the target page.');
  await waitEnter('Then press Enter here to save the session... ');
  if (isLoginUrl(cfg, page.url())) {
    await browser.close();
    throw new Error(`still on the login page (${page.url()}); nothing saved`);
  }
  const state = JSON.stringify(await context.storageState());
  await browser.close();
  return state;
}

async function verify(label: string, storageStateJson: string): Promise<boolean> {
  const browser = await chromium.launch({ headless: true, executablePath: settings.chromiumPath });
  const context = await browser.newContext({ storageState: JSON.parse(storageStateJson) });
  const page = await context.newPage();
  let ok = false;
  try {
    await page.goto(cfg.targetUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageLoad });
    ok = !isLoginUrl(cfg, page.url());
    console.log(`${label}: ${ok ? 'AUTHENTICATED' : 'NOT authenticated'} (${page.url()})`);
  } finally {
    await browser.close();
  }
  return ok;
}

function need(ref: string | undefined) {
  if (!ref) throw new Error('profile label or id required');
  const p = store.byLabelOrId(ref);
  if (!p) throw new Error(`profile "${ref}" not found`);
  return p;
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'seed': {
      const label = opt('label'), account = opt('account');
      if (!label || !account) throw new Error('usage: seed --label <name> --account <accountKey>');
      const json = await captureSession();
      const p = store.insert(label, account, json);
      console.log(`saved profile ${p.label} (${p.id}) as available`);
      break;
    }
    case 'import': {
      const label = opt('label'), account = opt('account'), file = opt('file');
      if (!label || !account || !file) throw new Error('usage: import --label <name> --account <accountKey> --file <storageState.json>');
      const json = readFileSync(file, 'utf8');
      JSON.parse(json); // validate
      const p = store.insert(label, account, json);
      console.log(`imported profile ${p.label} (${p.id}) as available`);
      break;
    }
    case 'reseed': {
      const p = need(positional);
      const file = opt('file');
      const json = file ? readFileSync(file, 'utf8') : await captureSession();
      store.reseed(p.id, json);
      console.log(`profile ${p.label} re-seeded and available`);
      break;
    }
    case 'list': {
      const rows = store.list();
      if (!rows.length) { console.log('no profiles. Seed one with: npm run profile -- seed --label acct1 --account <accountKey>'); break; }
      console.log(['label'.padEnd(14), 'state'.padEnd(10), 'account'.padEnd(24), 'uses', 'last used'.padEnd(20), 'verified'.padEnd(20), 'reason'].join('  '));
      for (const r of rows) {
        console.log([r.label.padEnd(14), r.state.padEnd(10), r.account_key.padEnd(24), String(r.use_count).padStart(4), fmt(r.last_used_at).padEnd(20), fmt(r.last_verified_at).padEnd(20), r.state_reason ?? ''].join('  '));
      }
      console.log('\n' + JSON.stringify(store.status()));
      break;
    }
    case 'verify': {
      const p = need(positional);
      const ok = await verify(p.label, store.decryptStorageState(p));
      if (ok) store.markVerified(p.id);
      else store.setState(p.id, 'expired', 'manual verify failed');
      break;
    }
    case 'disable': { const p = need(positional); store.setState(p.id, 'disabled', 'operator'); console.log(`${p.label} disabled`); break; }
    case 'enable': { const p = need(positional); store.setState(p.id, 'available', 'operator'); console.log(`${p.label} available`); break; }
    case 'remove': { const p = need(positional); store.remove(p.id); console.log(`${p.label} removed`); break; }
    case 'workflows': {
      const rows = store.listAssignments(30);
      if (!rows.length) { console.log('no workflows yet'); break; }
      console.log(['workflow'.padEnd(9), 'profile'.padEnd(14), 'state'.padEnd(10), 'link'.padEnd(9), 'started'.padEnd(20), 'visited'.padEnd(20), 'verified'.padEnd(20), 'url'].join('  '));
      for (const r of rows) console.log([r.workflow_id.slice(0, 8).padEnd(9), r.profile_label.padEnd(14), r.state.padEnd(10), r.link_state.padEnd(9), fmt(r.created_at).padEnd(20), fmt(r.visited_at).padEnd(20), fmt(r.verified_at).padEnd(20), r.result_url ?? ''].join('  '));
      break;
    }
    case 'events': {
      const p = need(positional);
      for (const e of store.events(p.id).reverse()) console.log(`${fmt(e.at)}  ${e.from_state ?? '-'} -> ${e.to_state}  ${e.reason ?? ''}  ${e.workflow_id ? 'wf=' + e.workflow_id.slice(0, 8) : ''}`);
      break;
    }
    default:
      console.log('commands: seed | import | reseed | list | verify | disable | enable | remove | events | workflows');
      process.exitCode = 1;
  }
}

main().catch((e) => { console.error('error:', e.message ?? e); process.exit(1); });
