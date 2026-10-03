import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ownerAlive, pidStartOf, type Liveness } from '../proc.js';
export { ownerAlive, pidStartOf, type Liveness };

/**
 * Filesystem side of the persistent per-account browser profile:
 *   <BROWSER_PROFILE_DIR>/profile-<uuid>/            the Chromium user data dir (0700), never deleted by the service
 *   <BROWSER_PROFILE_DIR>/profile-<uuid>/downloads/  per-profile downloads (never a shared folder)
 *   <PROFILE_LOCK_DIR>/profile-<uuid>.lock           runtime lock file, OUTSIDE the Chromium directory
 * The directory name comes from the internal profile id only; anything else is rejected.
 */
const DIR_NAME_RE = /^profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LockRecord { profileDir: string; instanceId: string; pid: number; pidStart: string | null; leaseToken: string; runtimeType: string; startedAt: number; heartbeatAt: number }

export class ProfileLockConflict extends Error {
  constructor(public code: 'PROFILE_LOCKED' | 'PROFILE_DIR_INVALID', message: string) { super(message); }
}

/** mkdir -p with 0700 on the final directory only (Chromium's own files are never chmod'ed). */
export function ensurePrivateDir(path: string): boolean {
  const created = !existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { try { chmodSync(path, 0o700); } catch { /* best effort on exotic filesystems */ } }
  return created;
}

export function profilePath(root: string, dirName: string): string {
  if (!DIR_NAME_RE.test(dirName)) throw new ProfileLockConflict('PROFILE_DIR_INVALID', 'profile directory name is not derived from a profile id');
  const p = resolve(root, dirName);
  if (!p.startsWith(resolve(root) + (process.platform === 'win32' ? '\\' : '/'))) throw new ProfileLockConflict('PROFILE_DIR_INVALID', 'profile directory escapes the profile root');
  return p;
}
export const downloadsPath = (profileDir: string) => join(profileDir, 'downloads');
export const lockPath = (lockDir: string, dirName: string) => join(lockDir, `${dirName}.lock`);

/**
 * Seed Chromium preferences BEFORE the first launch of a new profile directory (never touched afterwards):
 * WebRTC must not open non-proxied UDP routes or enumerate extra interfaces. Belt and braces with the command-line
 * policy flag; Chromium honours whichever is stricter.
 */
export function seedPreferences(profileDir: string): void {
  const def = join(profileDir, 'Default');
  const file = join(def, 'Preferences');
  if (existsSync(file)) return;
  mkdirSync(def, { recursive: true, mode: 0o700 });
  const prefs = {
    webrtc: { ip_handling_policy: 'disable_non_proxied_udp', multiple_routes_enabled: false, nonproxied_udp_enabled: false },
    // "Continue where you left off": the only startup mode in which Chromium persists SESSION cookies across a restart
    // (verified: without it a session cookie set before close is gone after relaunch). The restored tabs are closed by
    // the browser layer right after launch; the account's logged-in session survives like in a real browser install.
    session: { restore_on_startup: 1 },
    profile: { exit_type: 'Normal', password_manager_enabled: false, default_content_setting_values: { notifications: 2 } },
    download: { prompt_for_download: false },
    credentials_enable_service: false, // no OS password manager prompts inside an automation profile
  };
  writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 });
}

export function readLock(path: string): LockRecord | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as LockRecord; } catch { return null; }
}

/**
 * Create the lock file exclusively. An existing file is a conflict unless its owner is stale (heartbeat older than
 * leaseMs AND the owner process is dead / reused) — then it is reclaimed and the caller logs the recovery.
 * Nothing inside the profile directory is touched.
 */
export function acquireFsLock(path: string, rec: LockRecord, leaseMs: number): { reclaimed: LockRecord | null } {
  ensurePrivateDir(resolve(path, '..'));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(rec)); closeSync(fd);
      return { reclaimed: null };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const cur = readLock(path);
    if (cur && cur.leaseToken === rec.leaseToken) { writeLock(path, rec); return { reclaimed: null }; } // our own (re-entrant refresh)
    const age = cur ? Date.now() - cur.heartbeatAt : Infinity;
    const alive = cur ? ownerAlive(cur.pid, cur.pidStart) : 'unknown';
    const stale = !cur || (age > leaseMs && alive === false) || (age > leaseMs * 3 && alive === 'unknown');
    if (!stale) {
      throw new ProfileLockConflict('PROFILE_LOCKED', cur
        ? `profile locked by ${cur.runtimeType} on instance ${cur.instanceId.slice(0, 8)} (pid ${cur.pid}, heartbeat ${Math.round(age / 1000)}s ago${alive === true ? ', process alive' : ''})`
        : 'profile lock file unreadable');
    }
    // stale: keep the old record beside the lock for forensics, then retry the exclusive create
    try { renameSync(path, `${path}.stale-${Date.now()}`); } catch { try { unlinkSync(path); } catch { /* raced */ } }
    if (attempt === 1) throw new ProfileLockConflict('PROFILE_LOCKED', 'profile lock could not be reclaimed');
    const reclaimed = cur;
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(rec)); closeSync(fd);
      return { reclaimed };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  throw new ProfileLockConflict('PROFILE_LOCKED', 'profile lock contended');
}

/** Atomic rewrite (temp + rename) used for heartbeats. */
export function writeLock(path: string, rec: LockRecord): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Remove the lock only if it is still ours. */
export function releaseFsLock(path: string, leaseToken: string): boolean {
  const cur = readLock(path);
  if (!cur || cur.leaseToken !== leaseToken) return false;
  try { unlinkSync(path); return true; } catch { return false; }
}

export function dirExists(path: string): boolean { try { return statSync(path).isDirectory(); } catch { return false; } }
