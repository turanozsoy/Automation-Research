import { randomUUID } from 'node:crypto';
import { BrowserManager } from './browser/manager.js';
import { loadConfig } from './config.js';
import { Vault } from './crypto.js';
import { openDb } from './db.js';
import { LoginSessionManager } from './accounts/login-sessions.js';
import { ApplicationService } from './applications/service.js';
import { ApplicationStore } from './applications/store.js';
import { BrowserModeControl } from './dev/browser-mode.js';
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
  if (status.total === 0) console.warn(`\n  No accounts yet. Add one at http://localhost:${settings.port}/admin/accounts\n`);

  const browser = new BrowserManager(settings, tl);
  const registry = new WorkflowRegistry(settings, cfg, store, browser, tl);
  const browserMode = new BrowserModeControl(settings, browser, registry, tl);
  browser.setMode(browserMode.initialMode());
  await browser.launch();
  registry.start();
  const logins = new LoginSessionManager(settings, cfg, store, tl);
  const apps = new ApplicationService(settings, cfg, new ApplicationStore(db), registry, tl, store);
  const interrupted = apps.recoverOnBoot();
  if (interrupted) tl.mark('applications interrupted by the restart', `${interrupted} marked as problem (retryable)`);
  await startServer({ cfg, registry, store, logins, apps, browserMode, settings, tl });
  tl.mark('server listening', `http://localhost:${settings.port}`);

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`  Accounts:   http://localhost:${settings.port}/admin/accounts   (add accounts, Get / Refresh Cookies)`);
  console.log(`  Applicant:  http://localhost:${settings.port}   (placeholder; API: POST /api/applications, GET /api/applications/me, WS /ws/app)`);
  console.log(`  Debug:      http://localhost:${settings.port}/debug   (raw workflow harness, one workflow per tab)`);
  console.log(`  CLI:        npm run profile -- list | workflows`);
  console.log(`  Settings:   maxWorkflows=${settings.maxWorkflows} cooldown=${settings.cooldownMs}ms idle=${settings.idleTimeoutMs}ms lease=${settings.leaseMs}ms`);
  console.log('────────────────────────────────────────────────────────────\n');

  const shutdown = async () => {
    tl.mark('shutting down');
    await logins.closeAll();
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
