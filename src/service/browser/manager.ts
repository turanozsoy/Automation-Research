import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../settings.js';
import type { Timeline } from '../timeline.js';
import type { ProfileStore, RuntimeHandle, RuntimeType } from '../profiles/store.js';
import { ProfileRuntimeError } from '../profiles/store.js';
import { DIRECT_ID, EgressError } from '../egress/store.js';
import { preflightProxy } from '../egress/health.js';
import { acquireFsLock, downloadsPath, ensurePrivateDir, lockPath, pidStartOf, profilePath, releaseFsLock, seedPreferences, writeLock, ProfileLockConflict, type LockRecord } from './profile-dirs.js';

export interface ContextBundle { context: BrowserContext; page: Page }
export type BrowserMode = 'visible' | 'headless';

export interface OpenAccountOptions {
  /** Registry key: the workflow id, or `login:<accountId>` for a manual login. */
  key: string;
  profileId: string;
  /** Exclusive runtime ownership, acquired by the store (reserve() or acquireRuntime()). Launch is refused without it. */
  runtime: RuntimeHandle;
  /** The account's current egress ('direct' only in non-strict development; a proxy otherwise). */
  egressId: string | null;
  workflowId?: string | null;
  /** Default: the manager's mode. Manual login is visible unless LOGIN_HEADLESS=1. */
  headless?: boolean;
  windowArgs?: string[];
  /** The context closed on its own (Chromium crash / operator closed the window). The runtime is already released. */
  onClosed?: (reason: string) => void;
  /** Tag used when a manual login takes over a failover proxy exclusively. */
  exclusiveTag?: string;
}
export interface OpenedAccount extends ContextBundle {
  egressId: string | null;
  /** Set when the launch replaced the account's failed proxy with a clean one (same profile, same directory). */
  failover: { from: string; to: string } | null;
  profileDir: string;
  seeded: boolean;
}

interface Session { key: string; profileId: string; runtime: RuntimeHandle; context: BrowserContext; page: Page; egressId: string | null; lockFile: string; lock: LockRecord; closing: boolean; onClosed?: (reason: string) => void }

/** Page-side: the document's HTML with anything that could hold applicant input or secrets removed. */
const SANITIZED_HTML = `(() => {
  const doc = document.documentElement.cloneNode(true);
  for (const el of doc.querySelectorAll('script, style, link[rel="stylesheet"]')) el.remove();
  for (const el of doc.querySelectorAll('input, textarea, select')) {
    for (const a of [...el.attributes]) if (!['id','name','type','placeholder','class','aria-label','aria-invalid','required','disabled'].includes(a.name) && !a.name.startsWith('aria-')) el.removeAttribute(a.name);
    if (el.tagName === 'TEXTAREA') el.textContent = '';
  }
  for (const el of doc.querySelectorAll('*')) for (const a of [...el.attributes]) if (a.name.startsWith('data-') && a.name !== 'data-accent-color' && a.name !== 'data-variant') el.removeAttribute(a.name);
  return '<!doctype html>' + doc.outerHTML;
})()`;

/**
 * Chromium switches for every account browser, on top of Playwright's defaults (which already include
 * --disable-background-networking, --disable-component-update, --disable-sync, --metrics-recording-only, --no-first-run
 * and the DevTools pipe instead of a debugging port). Documented switches only; no stealth patches.
 */
const ISOLATION_ARGS = [
  // WebRTC may only use UDP that goes through the proxy; no local-interface enumeration. (Also seeded in Preferences.)
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  // Less of Chromium's own traffic: no hyperlink auditing pings, no domain-reliability uploads.
  '--no-pings',
  '--disable-domain-reliability',
];

/**
 * One persistent Chromium process per ACTIVE account, launched on the account's permanent user data directory with
 * the account's own proxy and stable environment. Workflows and manual logins both come through here, so an
 * account is one browser installation: cookies, localStorage, IndexedDB, cache, service workers and preferences all
 * live in <BROWSER_PROFILE_DIR>/profile-<id>/ and survive every run. Nothing here deletes a profile directory.
 *
 * Launch order: runtime lease (db) -> lock file (fs) -> proxy preflight -> bounded clean failover -> launchPersistentContext.
 * The encrypted storageState remains a backup/seed only.
 */
export class BrowserManager {
  private sessions = new Map<string, Session>();
  private byProfile = new Map<string, string>(); // profileId -> key
  private headless: boolean;
  private restarting = false;
  private ready = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private captures = new Map<string, Promise<void>>();
  private lastCapture = new Map<string, number>();

  constructor(private settings: Settings, private store: ProfileStore, private tl: Timeline) {
    this.headless = settings.headless;
  }

  mode(): BrowserMode { return this.headless ? 'headless' : 'visible'; }
  isRestarting(): boolean { return this.restarting; }
  /** The mode new account browsers launch in. */
  setMode(mode: BrowserMode): void { this.headless = mode === 'headless'; }

  /** Prepare the profile root and lock directory (0700) and start the lease heartbeat. No shared Chromium process. */
  async launch(): Promise<void> {
    ensurePrivateDir(this.settings.browserProfileDir);
    ensurePrivateDir(this.settings.profileLockDir);
    if (!this.heartbeat) {
      const every = Math.max(2000, Math.floor(this.settings.profileRuntimeLeaseMs / 3));
      this.heartbeat = setInterval(() => this.beat(), every);
    }
    this.ready = true;
    this.tl.mark('browser layer ready', `${this.mode()}; persistent profiles in ${this.settings.browserProfileDir}; ${this.settings.strictAccountEgress ? 'STRICT account egress (no direct)' : 'direct allowed for unbound accounts (development)'}`);
  }

  /** Development: switch the launch mode for the NEXT account browsers; refused while any is live. */
  async restart(mode: BrowserMode): Promise<void> {
    if (this.sessions.size > 0) throw new Error(`cannot switch browser mode with ${this.sessions.size} live account browser(s)`);
    if (this.restarting) throw new Error('restart already in progress');
    this.restarting = true;
    try { this.headless = mode === 'headless'; this.tl.mark('browser mode set', mode); } finally { this.restarting = false; }
  }

  isAlive(): boolean { return this.ready; }
  liveContexts(): number { return this.sessions.size; }

  // ---------- open / close ----------

  async openAccount(o: OpenAccountOptions): Promise<OpenedAccount> {
    if (!this.ready) throw new Error('browser layer not started');
    const profile = this.store.get(o.profileId);
    if (!profile) throw new ProfileRuntimeError('PROFILE_NOT_FOUND', 'account not found');
    // 1. the lease must be ours and alive; refreshing it proves both
    if (o.runtime.profileId !== o.profileId || !this.store.heartbeatRuntime(o.runtime)) throw new ProfileRuntimeError('RUNTIME_LEASE_LOST', 'runtime lease is not held for this profile');
    if (this.byProfile.has(o.profileId) || this.sessions.has(o.key)) {
      this.store.audit.record('PROFILE_RUNTIME_LOCK_CONFLICT', { profileId: o.profileId, workflowId: o.workflowId ?? null, code: 'IN_PROCESS', detail: 'already open in this service instance' });
      throw new ProfileRuntimeError('PROFILE_IN_USE', 'profile already in use in this service');
    }
    // 2. the permanent directory (name from the id only) and the lock file outside it
    const dirName = this.store.profileDirName(o.profileId);
    const profileDir = profilePath(this.settings.browserProfileDir, dirName);
    const created = ensurePrivateDir(profileDir);
    ensurePrivateDir(downloadsPath(profileDir));
    if (created || profile.profile_dir_initialized_at === null) seedPreferences(profileDir);
    const lockFile = lockPath(this.settings.profileLockDir, dirName);
    const lock: LockRecord = { profileDir: dirName, instanceId: this.store.instanceId, pid: process.pid, pidStart: pidStartOf(process.pid), leaseToken: o.runtime.leaseToken, runtimeType: o.runtime.runtimeType, startedAt: Date.now(), heartbeatAt: Date.now() };
    let fsLock: ReturnType<typeof acquireFsLock>;
    try { fsLock = acquireFsLock(lockFile, lock, this.settings.profileRuntimeLeaseMs); } catch (e) {
      if (e instanceof ProfileLockConflict) {
        this.store.audit.record('PROFILE_RUNTIME_LOCK_CONFLICT', { profileId: o.profileId, workflowId: o.workflowId ?? null, code: e.code, detail: e.message });
        throw new ProfileRuntimeError('PROFILE_IN_USE', e.message);
      }
      throw e;
    }
    if (fsLock.reclaimed) {
      this.store.audit.record('PROFILE_RUNTIME_LOCK_RECOVERED', { profileId: o.profileId, workflowId: o.workflowId ?? null, code: 'FS_LOCK', detail: `stale lock file of instance ${fsLock.reclaimed.instanceId.slice(0, 8)} pid ${fsLock.reclaimed.pid} reclaimed; profile data untouched` });
      this.tl.mark('stale profile lock recovered', `${profile.label}: previous owner pid ${fsLock.reclaimed.pid} is gone`);
    }

    let egressId = o.egressId;
    let failover: OpenedAccount['failover'] = null;
    let context: BrowserContext | null = null;
    try {
      // 3. the network: the account's proxy, preflighted; direct only when allowed AND the account has no proxy
      if (egressId === DIRECT_ID || egressId === null) {
        if (this.settings.strictAccountEgress || !this.store.isDirectAllowed()) throw new EgressError('DIRECT_EGRESS_FORBIDDEN', 'account browsers must use their assigned proxy (STRICT_ACCOUNT_EGRESS)');
        if (profile.egress_id) throw new EgressError('EGRESS_BINDING_CHANGED', 'this account has a proxy; it never goes direct');
      } else {
        let failovers = 0;
        for (;;) {
          const ok = await this.preflight(egressId, o.workflowId ?? null);
          if (ok) break;
          if (failovers >= this.settings.maxAutoEgressFailoversPerLaunch) throw new EgressError('EGRESS_NOT_ELIGIBLE', `Egress ${this.store.egress.get(egressId)?.label ?? egressId} failed its preflight and the automatic failover budget (${this.settings.maxAutoEgressFailoversPerLaunch}) is spent`);
          // same account, same profile, same directory, same environment: only the network changes, to a CLEAN proxy
          const r = this.store.egress.replaceProxyAutomatically(o.profileId, egressId, o.workflowId ?? null); // throws NO_CLEAN_EGRESS_AVAILABLE
          if (o.runtime.runtimeType === 'manual_login') this.store.egress.markInUse(r.newEgressId, o.exclusiveTag ?? o.key);
          failover = { from: r.oldEgressId, to: r.newEgressId };
          egressId = r.newEgressId;
          failovers++;
          this.tl.mark('egress failover', `${profile.label}: ${this.store.egress.get(r.oldEgressId)?.label ?? r.oldEgressId} → ${this.store.egress.get(r.newEgressId)?.label ?? r.newEgressId} (clean proxy, same profile)`);
        }
      }
      const proxy = egressId && egressId !== DIRECT_ID ? this.store.egress.proxyOptions(egressId) : null; // throws when credentials cannot be decrypted: stop
      if (egressId && egressId !== DIRECT_ID && !proxy) throw new EgressError('EGRESS_NOT_ELIGIBLE', 'assigned egress is not a usable proxy');

      // 4. stable environment: stored per account, identical on every launch
      const env = this.store.environmentOf(profile);
      const locale = env.locale ?? this.settings.browserDefaultLocale ?? undefined;
      const timezoneId = env.timezone ?? this.settings.browserDefaultTimezone ?? undefined;
      const headless = o.headless ?? this.headless;
      const viewport = env.viewport ?? (headless ? { width: 1280, height: 900 } : null);
      const args = [...ISOLATION_ARGS];
      if (proxy) {
        // No local DNS for anything but the proxy host itself: a request that somehow bypassed the proxy fails instead
        // of resolving (and leaking) through the server's resolver. Proxied requests are resolved by the proxy.
        const host = new URL(proxy.server).hostname.replace(/^\[|\]$/g, '');
        args.push(`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}`);
      }
      if (!headless) args.push(...(o.windowArgs ?? ['--window-size=1280,900', '--window-position=40,40']));

      // 5. one-time seed from the encrypted backup for a directory that has never been initialized
      const seedNeeded = profile.profile_dir_initialized_at === null && profile.session_saved_at !== null;
      let seed: { cookies: any[]; origins: { origin: string; localStorage: { name: string; value: string }[] }[] } | null = null;
      if (seedNeeded) {
        const json = this.store.decryptStorageState(profile); // cannot decrypt -> throws -> stop (fail closed)
        seed = JSON.parse(json);
      }

      // 6. the persistent Chromium process for this account
      context = await chromium.launchPersistentContext(profileDir, {
        headless, executablePath: this.settings.chromiumPath, args,
        proxy: proxy ?? undefined,
        locale, timezoneId, viewport,
        acceptDownloads: true, downloadsPath: downloadsPath(profileDir),
        // the service's own shutdown closes account browsers in order; Playwright must not kill them on SIGTERM
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      });
      if (seed) {
        if (Array.isArray(seed.cookies) && seed.cookies.length) await context.addCookies(seed.cookies);
        const origins = Array.isArray(seed.origins) ? seed.origins.filter((x) => x && typeof x.origin === 'string' && Array.isArray(x.localStorage) && x.localStorage.length) : [];
        if (origins.length) {
          // localStorage can only be written from its origin: a one-time init script seeds it on the first visit.
          await context.addInitScript((data: typeof origins) => {
            const mine = data.find((x) => x.origin === location.origin);
            if (!mine || localStorage.getItem('__profile_seeded__')) return;
            for (const { name, value } of mine.localStorage) if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
            localStorage.setItem('__profile_seeded__', '1');
          }, origins);
        }
      }
      this.store.markProfileDirInitialized(o.profileId, !!seed);
      // restore_on_startup reopens last session's tabs: keep one blank page for the caller, close everything else
      const page = context.pages().find((p) => p.url() === 'about:blank') ?? await context.newPage();
      for (const extra of context.pages()) if (extra !== page) await extra.close().catch(() => {});

      // Playwright does not expose the Chromium pid for a persistent context; the owner recorded for liveness is this
      // service process (it holds the lease and heartbeats), which is what stale-lock recovery checks.
      const pid = process.pid;
      this.store.setRuntimeProcess(o.runtime, pid, pidStartOf(pid));
      const session: Session = { key: o.key, profileId: o.profileId, runtime: o.runtime, context, page, egressId, lockFile, lock, closing: false, onClosed: o.onClosed };
      this.sessions.set(o.key, session);
      this.byProfile.set(o.profileId, o.key);
      context.on('close', () => void this.onContextClosed(session));
      this.store.audit.record('ACCOUNT_LAUNCHED', { profileId: o.profileId, egressId, workflowId: o.workflowId ?? null, code: o.runtime.runtimeType, detail: `${headless ? 'headless' : 'visible'}; dir ${dirName}; owner pid ${pid}${failover ? '; after failover' : ''}${seed ? '; seeded from saved session' : ''}` });
      this.tl.mark('account browser launched', `${profile.label} via ${egressId ? (this.store.egress.get(egressId)?.label ?? egressId) : 'direct'} (${o.runtime.runtimeType}, ${headless ? 'headless' : 'visible'})`);
      return { context, page, egressId, failover, profileDir, seeded: !!seed };
    } catch (e) {
      if (context) await context.close().catch(() => {});
      releaseFsLock(lockFile, o.runtime.leaseToken);
      throw e;
    }
  }

  /** Preflight the proxy; every attempt counts like a health check; all-fail takes the proxy down (PROXY_FAILURE). */
  private async preflight(egressId: string, workflowId: string | null): Promise<boolean> {
    const e = this.store.egress.get(egressId);
    if (!e) throw new EgressError('EGRESS_BINDING_CHANGED', 'assigned egress no longer exists');
    if (e.state === 'retired') throw new EgressError('EGRESS_NOT_ELIGIBLE', `proxy ${e.label} is retired`);
    const opts = this.store.egress.proxyOptions(egressId);
    if (!opts) throw new EgressError('EGRESS_NOT_ELIGIBLE', 'assigned egress is not a proxy');
    const url = this.settings.egressCheckUrl ?? this.checkUrl;
    const r = await preflightProxy(opts, url, this.settings.egressPreflightAttempts, this.settings.egressPreflightTimeoutMs);
    for (const a of r.attempts) this.store.egress.recordCheck(egressId, a.ok, a.error);
    if (r.ok) {
      if (!r.probed) this.tl.mark('egress preflight skipped', `${e.label}: socks5 has no active probe; the launch decides`);
      return true;
    }
    const why = r.attempts.map((a) => a.error ?? 'failed').join(', ');
    this.store.egress.markFailed(egressId, `${r.attempts.length} attempts: ${why}`, workflowId ?? undefined);
    this.tl.mark('egress preflight failed', `${e.label}: ${why}`);
    return false;
  }
  private checkUrl = 'https://example.com/';
  /** Website B's base URL (set by main) is what a preflight must reach through the proxy. */
  setCheckUrl(url: string): void { this.checkUrl = url; }

  private async onContextClosed(s: Session): Promise<void> {
    if (this.sessions.get(s.key) !== s) return;
    this.forget(s);
    if (s.closing) return;
    // unexpected: Chromium crashed, or the operator closed the window. Lease + lock go back; the directory and the
    // proxy binding stay exactly as they are.
    this.store.audit.record('BROWSER_CRASHED', { profileId: s.profileId, egressId: s.egressId, workflowId: s.runtime.workflowId, code: s.runtime.runtimeType, detail: 'context closed unexpectedly; profile and proxy binding preserved' });
    this.tl.mark('account browser closed unexpectedly', `${this.store.get(s.profileId)?.label ?? s.profileId} (${s.runtime.runtimeType})`);
    this.store.releaseRuntime(s.runtime, 'browser closed unexpectedly');
    releaseFsLock(s.lockFile, s.runtime.leaseToken);
    s.onClosed?.('browser closed unexpectedly');
  }

  private forget(s: Session): void {
    this.sessions.delete(s.key);
    if (this.byProfile.get(s.profileId) === s.key) this.byProfile.delete(s.profileId);
    this.lastCapture.delete(s.key);
  }

  /** Renew every live lease (db + lock file). A lease that is gone means we are no longer the owner: close that browser. */
  private beat(): void {
    for (const s of [...this.sessions.values()]) {
      if (s.closing) continue;
      if (!this.store.heartbeatRuntime(s.runtime)) {
        this.tl.mark('runtime lease lost', `${this.store.get(s.profileId)?.label ?? s.profileId}: closing its browser`);
        this.store.audit.record('PROFILE_RUNTIME_LOCK_CONFLICT', { profileId: s.profileId, workflowId: s.runtime.workflowId, code: 'LEASE_LOST', detail: 'lease disappeared while the browser was open; closing' });
        void this.closeContext(s.key, 'lease lost');
        continue;
      }
      s.lock.heartbeatAt = Date.now();
      try { writeLock(s.lockFile, s.lock); } catch { /* the db lease is authoritative */ }
    }
  }

  // ---------- compatibility surface for the registry / login manager ----------

  /** Export the account's current storageState as an encrypted BACKUP (the directory is the real profile). */
  async exportStorageState(key: string): Promise<string | null> {
    const s = this.sessions.get(key);
    if (!s) return null;
    try { return JSON.stringify(await s.context.storageState()); } catch { return null; }
  }

  egressOf(key: string): string | null { return this.sessions.get(key)?.egressId ?? null; }
  isOpen(key: string): boolean { const s = this.sessions.get(key); return !!s && !s.page.isClosed(); }
  pageOf(key: string): Page | null { return this.sessions.get(key)?.page ?? null; }

  /** Close an account browser and give its runtime lease back. The profile directory is left as it is. */
  async closeContext(key: string, reason = 'closed'): Promise<void> {
    const pending = this.captures.get(key);
    if (pending) await Promise.race([pending, new Promise((r) => setTimeout(r, 8000))]);
    const s = this.sessions.get(key);
    if (!s) return;
    s.closing = true;
    this.forget(s);
    await s.context.close().catch(() => {});
    this.store.releaseRuntime(s.runtime, reason);
    releaseFsLock(s.lockFile, s.runtime.leaseToken);
    this.store.audit.record('ACCOUNT_CLOSED', { profileId: s.profileId, egressId: s.egressId, workflowId: s.runtime.workflowId, code: s.runtime.runtimeType, detail: reason });
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const key of [...this.sessions.keys()]) await this.closeContext(key, 'service shutting down');
    this.ready = false;
  }

  /**
   * Development: what Chromium rendered when a step failed. Screenshots of every page in the account's context, a
   * sanitized HTML snapshot (no input values, no data-* attributes, no scripts) and a JSON with stage, code, message,
   * URLs, frame count and browser mode. Never cookies, storage or field values. closeContext waits for a capture in flight.
   */
  captureFailure(workflowId: string, stage: string, code: string, message: string): void {
    const dir = this.settings.failureArtifactsDir;
    const b = this.sessions.get(workflowId);
    if (!dir || !b) return;
    const last = this.lastCapture.get(workflowId) ?? 0;
    if (Date.now() - last < 5000) return;
    this.lastCapture.set(workflowId, Date.now());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${stamp}-${workflowId.slice(0, 8)}-${stage.replace(/[^a-z0-9_-]/gi, '_').slice(0, 30)}`;
    const run = (async () => {
      try {
        mkdirSync(dir, { recursive: true });
        const pages = b.context.pages().filter((p) => !p.isClosed());
        const shots: string[] = [];
        for (const [i, page] of pages.entries()) {
          const file = join(dir, `${base}${i ? '-page' + i : ''}.png`);
          await page.screenshot({ path: file, fullPage: true, timeout: 5000 }).then(() => shots.push(file)).catch(() => {});
        }
        const page = pages[0];
        let html = '';
        if (page) html = await page.evaluate(SANITIZED_HTML).catch(() => '') as string;
        if (html) writeFileSync(join(dir, `${base}.html`), html);
        const info = {
          at: new Date().toISOString(), workflowId, stage, code, message: message.slice(0, 1000), browserMode: this.mode(),
          pages: pages.map((p) => ({ url: p.url(), frames: p.frames().length, frameUrls: p.frames().map((f) => f.url()) })),
          screenshots: shots, html: html ? `${base}.html` : null,
        };
        writeFileSync(join(dir, `${base}.json`), JSON.stringify(info, null, 2));
        this.tl.mark('failure artifacts saved', `${this.mode()} · ${base}.{png,html,json} in ${dir}`);
      } catch (e) {
        this.tl.mark('failure artifacts not saved', e instanceof Error ? e.message.split('\n')[0] : String(e));
      }
    })();
    this.captures.set(workflowId, run.finally(() => { if (this.captures.get(workflowId) === run) this.captures.delete(workflowId); }));
  }
}
export type { RuntimeType };
