import { randomUUID } from 'node:crypto';
import { BrowserManager } from './browser/manager.js';
import { loadConfig } from './config.js';
import { Vault } from './crypto.js';
import { openDb } from './db.js';
import { LoginSessionManager } from './accounts/login-sessions.js';
import { ApplicationService } from './applications/service.js';
import { ApplicationStore } from './applications/store.js';
import { BrowserModeControl } from './dev/browser-mode.js';
import { NetworkDiagnostics } from './dev/network-diagnostics.js';
import { EgressHealth } from './egress/health.js';
import { ProfileStore } from './profiles/store.js';
import { loadSettings } from './settings.js';
import { ApplicantContent } from './applications/content.js';
import { APPLY_CONFIG_PATH } from './ws.js';
import { readFileSync } from 'node:fs';
import { Timeline } from './timeline.js';
import { AdminAuth } from './admin-auth.js';
import { WorkflowRegistry } from './workflows.js';
import { startServer } from './ws.js';
import { ownerAlive } from './proc.js';

async function main(): Promise<void> {
  const settings = loadSettings();
  const cfg = loadConfig();
  const tl = new Timeline();
  const instanceId = randomUUID();
  tl.mark('service starting', `instance ${instanceId.slice(0, 8)}, target=${cfg.targetUrl}, data=${settings.dataDir}`);

  const db = openDb(settings.dbPath);
  const vault = Vault.load(settings.dataDir); // production: PROFILE_MASTER_KEY required, fail closed
  const store = new ProfileStore(db, vault, instanceId);
  store.setReserveAfterUse(settings.reserveAccounts);
  if (!settings.reserveAccounts) console.warn('\n  ACCOUNT_RESERVE=0: accounts return to rotation after every run (load testing only).\n');
  const loopbackHost = ['127.0.0.1', '::1', 'localhost'].includes(settings.host);
  if (settings.production && !settings.adminPassword && !loopbackHost) throw new Error('ADMIN_PASSWORD is required in production when SERVICE_HOST is not loopback');
  const auth = new AdminAuth({ password: settings.adminPassword, secret: vault.derive('admin-auth'), secure: settings.secureCookies, ttlMs: settings.adminSessionTtlMs, trustedProxies: settings.trustedProxies });
  if (!auth.enabled) console.warn('\n  ADMIN_PASSWORD is not set: /admin/accounts, /debug and the admin APIs answer only to localhost. Set it before exposing this service.\n');
  if (!loopbackHost) console.warn(`\n  SERVICE_HOST=${settings.host}: the service is reachable beyond this machine. Keep it on a private interface / VPN behind a TLS reverse proxy; set TRUSTED_PROXIES for that proxy.\n`);
  const orphans = store.recoverOrphans(settings.cooldownMs);
  if (orphans.length) tl.mark('recovered orphaned assignments from a previous run', `${orphans.length} workflow(s) marked lost`);
  // runtime leases of dead service instances: reclaimed only when the owner is provably gone; profiles are never touched
  const stale = store.recoverStaleRuntimes(settings.profileRuntimeLeaseMs, ownerAlive);
  if (stale.recovered.length || stale.conflicts.length) tl.mark('profile runtime leases from a previous run', `${stale.recovered.length} stale lease(s) recovered, ${stale.conflicts.length} left in place (owner alive or heartbeat too recent)`);
  const status = store.status();
  tl.mark('profile pool', `${status.total} profile(s): ${status.available} available, ${status.cooldown} cooldown, ${status.expired} expired, ${status.invalid} invalid, ${status.disabled} disabled`);
  if (status.total === 0) console.warn(`\n  No accounts yet. Add one at http://localhost:${settings.port}/admin/accounts\n`);

  const browser = new BrowserManager(settings, store, tl);
  browser.setCheckUrl(settings.egressCheckUrl ?? cfg.baseUrl);
  const registry = new WorkflowRegistry(settings, cfg, store, browser, tl);
  const browserMode = new BrowserModeControl(settings, browser, registry, tl);
  browser.setMode(browserMode.initialMode());
  // Every account browser is its own Chromium process launched with its own proxy, so the per-context placeholder is
  // no longer needed anywhere. Direct (server IP) is never an automatic fallback for an account that has a proxy; under
  // STRICT_ACCOUNT_EGRESS it is never used for account browsers at all.
  const eg = store.egress.counts();
  // Strict account egress is the default as soon as at least one proxy is imported: accounts without a proxy then wait
  // for one instead of using the server IP. STRICT_ACCOUNT_EGRESS=0/1 in the environment overrides this.
  if (!settings.strictAccountEgressExplicit && eg.total > 0 && !settings.strictAccountEgress) { settings.strictAccountEgress = true; tl.mark('strict account egress', 'enabled automatically: proxies are imported (STRICT_ACCOUNT_EGRESS=0 to allow direct)'); }
  store.setDirectAllowed(!settings.strictAccountEgress);
  tl.mark('egress', `${eg.total} proxy egress(es): ${eg.available} available (${eg.clean} clean / never assigned), ${eg.inUse} in use, ${eg.held} held, ${eg.down} down, ${eg.retired} retired; direct ${settings.strictAccountEgress ? 'FORBIDDEN for account browsers (STRICT_ACCOUNT_EGRESS)' : 'allowed for unbound accounts (development)'}`);
  if (!settings.strictAccountEgress) console.warn('\n  STRICT_ACCOUNT_EGRESS is off: accounts without a proxy may run through the server IP. It turns on by itself once a proxy is imported (unless STRICT_ACCOUNT_EGRESS=0).\n');
  await browser.launch();
  registry.start();
  const logins = new LoginSessionManager(settings, cfg, store, browser, tl);
  const diagnostics = new NetworkDiagnostics(settings, store, browser, tl);
  const apps = new ApplicationService(settings, cfg, new ApplicationStore(db), registry, tl, store);
  const content = new ApplicantContent(db, JSON.parse(readFileSync(APPLY_CONFIG_PATH, 'utf8')));
  const interrupted = apps.recoverOnBoot();
  if (interrupted) tl.mark('applications interrupted by the restart', `${interrupted} marked as problem (retryable)`);
  const egressHealth = new EgressHealth(store.egress, settings.egressCheckUrl ?? cfg.baseUrl, settings.egressCheckIntervalMs, tl, () => {}, settings.egressCheckTimeoutMs);
  await startServer({ cfg, registry, store, logins, apps, browserMode, diagnostics, egressHealth, settings, tl, content, auth });
  egressHealth.start();
  tl.mark('server listening', `http://${settings.host}:${settings.port}`);

  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`  Accounts:   http://localhost:${settings.port}/admin/accounts   (add accounts, Get / Refresh Cookies)`);
  console.log(`  Applicant:  http://localhost:${settings.port}   (placeholder; API: POST /api/applications, GET /api/applications/me, WS /ws/app)`);
  console.log(`  Debug:      http://localhost:${settings.port}/debug   (raw workflow harness, one workflow per tab)`);
  console.log(`  CLI:        npm run profile -- list | workflows`);
  console.log(`  Settings:   maxWorkflows=${settings.maxWorkflows} cooldown=${settings.cooldownMs}ms idle=${settings.idleTimeoutMs}ms lease=${settings.leaseMs}ms`);
  console.log('────────────────────────────────────────────────────────────\n');

  const shutdown = async () => {
    tl.mark('shutting down');
    egressHealth.stop();
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
