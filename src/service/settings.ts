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
  /** Optional shared secret the browser extension must send as x-import-token to POST /import. */
  importToken?: string;
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
    importToken: process.env.IMPORT_TOKEN || undefined,
  };
}
