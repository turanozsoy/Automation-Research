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
}

const num = (name: string, def: number) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
};

export function loadSettings(): Settings {
  const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
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
  };
}
