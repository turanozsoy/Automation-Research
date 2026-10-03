import { resolve } from 'node:path';

/**
 * Service-level settings (not Website B specifics). All from environment variables
 * with development defaults, so `npm start` works out of the box.
 */
export interface Settings {
  port: number;
  dataDir: string;
  dbPath: string;
  headless: boolean;
  chromiumPath?: string;
  /** Profile released after a workflow waits this long before it can be allocated again. */
  cooldownMs: number;
  /** Max workflows with a live browser context at once (also bounded by available profiles). */
  maxWorkflows: number;
  /** A workflow with no messages for this long is abandoned and its profile released. */
  idleTimeoutMs: number;
  /** Lease renewed by each live workflow; the reaper reclaims assignments whose lease lapsed. */
  leaseMs: number;
  /** How long workflow.start may wait in the queue for a profile. */
  queueTimeoutMs: number;
  /** Max automatic profile reassignments per workflow (expired profile discovered during prepare). */
  maxReassign: number;
  /** Applicant session cookie: Secure flag (set SECURE_COOKIES=1 behind HTTPS) and lifetime. */
  secureCookies: boolean;
  sessionTtlMs: number;
  /** After READY, submit an applicant workflow even if not every seeded field has been acknowledged yet. */
  applicantSubmitFallbackMs: number;
  /** Development: where the runtime browser-mode preference is kept (survives restarts; gitignored with DATA_DIR). */
  devSettingsPath: string;
  /** Development: screenshots / sanitized HTML / JSON written when an automation step fails (empty string disables). */
  failureArtifactsDir: string;
  /** Egress health: interval for active proxy checks (0 disables) and the URL probed through each proxy (default: Website B's base URL). */
  egressCheckIntervalMs: number;
  egressCheckUrl: string | null;
  /** Chromium proxy launch mode: 'auto' (per-context placeholder only on Windows when a proxy egress exists), 'per-context', or 'none'. */
  chromiumProxyMode: 'auto' | 'per-context' | 'none';
  /**
   * After an applicant opens the role link, hold the account for operator review; once verified, take it for that
   * applicant. ACCOUNT_RESERVE=0 disables this (load tests only): accounts then return to rotation after cooldown.
   */
  reserveAccounts: boolean;
  /** Operator password for the internal pages and APIs (ADMIN_PASSWORD). Unset: loopback-only access, with a startup warning. */
  adminPassword: string | null;
  /** Operator session lifetime (ADMIN_SESSION_HOURS, default 12). */
  adminSessionTtlMs: number;

  // ---- client isolation (persistent per-account browser profiles) ----
  /** NODE_ENV=production: secrets are required (fail closed) and strict egress is the default. */
  production: boolean;
  /**
   * STRICT_ACCOUNT_EGRESS=1: account browsers only ever use their assigned proxy; the Direct (server IP) egress is
   * never assigned to an account and never a fallback. Default on in production, off for local development.
   * Even when off, an account that HAS a proxy never falls back to direct or to another account's proxy.
   */
  strictAccountEgress: boolean;
  /** Root of the permanent Chromium user data directories, one per account (BROWSER_PROFILE_DIR). 0700. */
  browserProfileDir: string;
  /** Runtime lock files, outside the Chromium directories (PROFILE_LOCK_DIR). */
  profileLockDir: string;
  /** A profile runtime whose heartbeat is older than this is a candidate for stale-lock recovery (PROFILE_RUNTIME_LEASE_MS). */
  profileRuntimeLeaseMs: number;
  /** Bound on automatic clean-proxy replacements while launching one account browser (MAX_AUTO_EGRESS_FAILOVERS_PER_LAUNCH). */
  maxAutoEgressFailoversPerLaunch: number;
  /** Proxy preflight before an account browser launches: attempts and per-attempt timeout. Reaches the health threshold (3) by default. */
  egressPreflightAttempts: number;
  egressPreflightTimeoutMs: number;
  /** Default browser environment for accounts without an explicit one (BROWSER_DEFAULT_LOCALE / BROWSER_DEFAULT_TIMEZONE). Unset = Chromium/system defaults. */
  browserDefaultLocale: string | null;
  browserDefaultTimezone: string | null;
  /** Interface the HTTP/WebSocket server binds to (SERVICE_HOST, default 127.0.0.1: put a reverse proxy / VPN in front). */
  host: string;
  /**
   * Reverse proxies whose X-Forwarded-For may be trusted for client IPs and the loopback check (TRUSTED_PROXIES,
   * comma-separated IPs). Empty: forwarding headers are never trusted (default).
   */
  trustedProxies: string[];
}

const num = (name: string, def: number) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
};

const flag = (name: string, def: boolean) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v === '1' || v.toLowerCase() === 'true';
};

export function loadSettings(): Settings {
  const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
  const production = process.env.NODE_ENV === 'production';
  return {
    port: num('PORT', 3000),
    dataDir,
    dbPath: resolve(dataDir, 'automation.db'),
    headless: process.env.HEADLESS === '1',
    chromiumPath: process.env.CHROMIUM_PATH || undefined,
    cooldownMs: num('COOLDOWN_MS', 60_000),
    maxWorkflows: num('MAX_WORKFLOWS', 5),
    idleTimeoutMs: num('IDLE_TIMEOUT_MS', 10 * 60_000),
    leaseMs: num('LEASE_MS', 30_000),
    queueTimeoutMs: num('QUEUE_TIMEOUT_MS', 60_000),
    maxReassign: num('MAX_REASSIGN', 2),
    secureCookies: process.env.SECURE_COOKIES === '1',
    sessionTtlMs: num('SESSION_TTL_DAYS', 30) * 24 * 60 * 60_000,
    applicantSubmitFallbackMs: num('APPLICANT_SUBMIT_FALLBACK_MS', 20_000),
    devSettingsPath: resolve(dataDir, 'dev-settings.json'),
    failureArtifactsDir: process.env.FAILURE_ARTIFACTS === '0' ? '' : resolve(dataDir, 'debug', 'failures'),
    egressCheckIntervalMs: num('EGRESS_CHECK_INTERVAL_MS', 60_000),
    egressCheckUrl: process.env.EGRESS_CHECK_URL || null,
    chromiumProxyMode: (process.env.CHROMIUM_PROXY_MODE as 'auto' | 'per-context' | 'none') || 'auto',
    reserveAccounts: process.env.ACCOUNT_RESERVE !== '0',
    adminPassword: process.env.ADMIN_PASSWORD || null,
    adminSessionTtlMs: num('ADMIN_SESSION_HOURS', 12) * 60 * 60_000,
    production,
    strictAccountEgress: flag('STRICT_ACCOUNT_EGRESS', production),
    browserProfileDir: resolve(dataDir, process.env.BROWSER_PROFILE_DIR || 'browser-profiles'),
    profileLockDir: resolve(dataDir, process.env.PROFILE_LOCK_DIR || 'locks'),
    profileRuntimeLeaseMs: num('PROFILE_RUNTIME_LEASE_MS', 90_000),
    maxAutoEgressFailoversPerLaunch: num('MAX_AUTO_EGRESS_FAILOVERS_PER_LAUNCH', 1),
    egressPreflightAttempts: num('EGRESS_PREFLIGHT_ATTEMPTS', 3),
    egressPreflightTimeoutMs: num('EGRESS_PREFLIGHT_TIMEOUT_MS', 8000),
    browserDefaultLocale: process.env.BROWSER_DEFAULT_LOCALE || null,
    browserDefaultTimezone: process.env.BROWSER_DEFAULT_TIMEZONE || null,
    host: process.env.SERVICE_HOST || process.env.HOST || '127.0.0.1',
    trustedProxies: (process.env.TRUSTED_PROXIES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
