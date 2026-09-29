import { randomUUID } from 'node:crypto';
import { BrowserManager } from './browser/manager.js';
import { loadConfig } from './config.js';
import { Vault } from './crypto.js';
import { openDb } from './db.js';
import { ProfileInbox } from './profiles/inbox.js';
import { ProfileStore } from './profiles/store.js';
import { loadSettings } from './settings.js';
import { Timeline } from './timeline.js';
import { WorkflowRegistry } from './workflows.js';
import { startServer } from './ws.js';

async function main(): Promise<void> {
  const settings = loadSettings();
  const cfg = loadConfig();
  const tl = new Timeline();
  const instanceId = randomUUID();
  tl.mark('service starting', `instance ${instanceId.slice(0, 8)}, target=${cfg.targetUrl}, data=${settings.dataDir}`);

  const db = openDb(settings.dbPath);
  const store = new ProfileStore(db, Vault.load(settings.dataDir), instanceId);
  const orphans = store.recoverOrphans(settings.cooldownMs);
  if (orphans.length) tl.mark('recovered orphaned assignments from a previous run', `${orphans.length} workflow(s) marked lost`);
  const status = store.status();
  tl.mark('profile pool', `${status.total} profile(s): ${status.available} available, ${status.cooldown} cooldown, ${status.expired} expired, ${status.invalid} invalid, ${status.disabled} disabled`);
  if (status.total === 0) console.warn('\n  No profiles yet. Seed one with:  npm run profile -- seed --label acct1 --account <accountKey>\n');

  const browser = new BrowserManager(settings, tl);
  await browser.launch();

  const registry = new WorkflowRegistry(settings, cfg, store, browser, tl);
  registry.start();
  await startServer({ cfg, registry, store, browser, settings, tl });
  tl.mark('test page available', `http://localhost:${settings.port}`);

  const inbox = new ProfileInbox(settings.dataDir, store, browser, cfg, tl);
  inbox.start();
  tl.mark('profile inbox watching', inbox.path());

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`  Test page:   http://localhost:${settings.port}   (open it in several tabs for several workflows)`);
  console.log(`  Import URL:  http://localhost:${settings.port}/import   (the browser extension posts sessions here)`);
  console.log(`  Drop folder: ${inbox.path()}   (drop an exported session .json to import it)`);
  console.log(`  Profiles:    npm run profile -- list`);
  console.log(`  Settings:    maxWorkflows=${settings.maxWorkflows} cooldown=${settings.cooldownMs}ms idle=${settings.idleTimeoutMs}ms lease=${settings.leaseMs}ms importToken=${settings.importToken ? 'set' : 'none'}`);
  console.log('────────────────────────────────────────────────────────────\n');

  const shutdown = async () => {
    tl.mark('shutting down');
    inbox.stop();
    await registry.stop();
    await browser.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
