import type { BrowserManager } from '../browser/manager.js';
import { isLoginUrl, type SiteBConfig } from '../config.js';
import { EgressError } from '../egress/store.js';
import { ProfileRuntimeError, type ProfileStore, type RuntimeHandle } from '../profiles/store.js';
import type { Settings } from '../settings.js';
import type { Timeline } from '../timeline.js';

interface LoginSession { accountId: string; key: string; runtime: RuntimeHandle; startedAt: number; egressId: string | null }

export interface LoginStatus { accountId: string; open: boolean; startedAt?: number; currentUrl?: string; onLoginPage?: boolean; egress?: string | null }

/**
 * Manual-login browsers for the accounts page. "Get Cookies" / "Refresh Cookies" opens the account's OWN persistent
 * browser profile (same userDataDir, same proxy, same environment, same runtime lock as the automation) in a visible
 * window; the operator logs in by hand. "Done" refreshes the encrypted storageState BACKUP and closes the window;
 * the persistent profile keeps the real session. There is never a second browser identity for an account.
 *
 * While automation owns the profile this fails with "profile already in use"; while a login is open, the automation
 * cannot reserve the account (the runtime row excludes it).
 */
export class LoginSessionManager {
  private sessions = new Map<string, LoginSession>();

  constructor(private settings: Settings, private cfg: SiteBConfig, private store: ProfileStore, private browser: BrowserManager, private tl: Timeline) {}

  status(accountId: string): LoginStatus {
    const s = this.sessions.get(accountId);
    if (!s || !this.browser.isOpen(s.key)) return { accountId, open: false };
    const url = this.browser.pageOf(s.key)?.url() ?? '';
    return { accountId, open: true, startedAt: s.startedAt, currentUrl: url, onLoginPage: isLoginUrl(this.cfg, url), egress: s.egressId ? (this.store.egress.get(s.egressId)?.label ?? s.egressId) : null };
  }

  /** Open the account's persistent browser for a manual login. Idempotent: an open one is reused. */
  async start(accountId: string): Promise<LoginStatus> {
    const account = this.store.get(accountId);
    if (!account) throw new Error('account not found');
    const existing = this.sessions.get(accountId);
    if (existing && this.browser.isOpen(existing.key)) return this.status(accountId);
    if (existing) await this.close(accountId, 'stale login session replaced');

    const key = `login:${accountId}`;
    // 1. exclusive runtime ownership (refused while a workflow or another login holds the profile)
    let runtime: RuntimeHandle;
    try { runtime = this.store.acquireRuntime(accountId, 'manual_login'); }
    catch (e) { throw new Error(e instanceof ProfileRuntimeError ? `This account's browser is already in use (${e.message}).` : String(e)); }
    // 2. the account's egress: its bound proxy, else one CLEAN proxy that becomes bound, else direct only in development
    const acquired = this.store.egress.acquireExclusive(accountId, this.store.isDirectAllowed(), key);
    if (acquired.id === null) {
      this.store.releaseRuntime(runtime, 'no egress for login');
      throw new Error(acquired.blocked ? `This account cannot open a browser right now: ${acquired.blocked}. Restore or replace its proxy first.` : 'No clean proxy for this account: add proxies (never-used ones), or bind one explicitly.');
    }
    let egressId: string | null = acquired.id;
    const headless = process.env.LOGIN_HEADLESS === '1'; // visible by default; LOGIN_HEADLESS=1 exists only for automated tests
    const session: LoginSession = { accountId, key, runtime, startedAt: Date.now(), egressId };
    try {
      const opened = await this.browser.openAccount({
        key, profileId: accountId, runtime, egressId, headless, exclusiveTag: key,
        windowArgs: ['--window-size=1200,860', '--window-position=80,60'],
        onClosed: () => {
          if (this.sessions.get(accountId) !== session) return;
          this.sessions.delete(accountId);
          if (session.egressId) this.store.egress.releaseExclusive(session.egressId, key, 'login browser closed by user');
          this.tl.mark('login browser closed by user', account.label);
        },
      });
      if (opened.failover) {
        // the failed proxy was released from exclusive use by the replacement; the new one is now in use for this login
        egressId = opened.egressId; session.egressId = egressId;
      }
      this.sessions.set(accountId, session);
      const page = opened.page;
      await page.goto(this.cfg.targetUrl, { waitUntil: 'domcontentloaded', timeout: this.cfg.timeouts.pageLoad }).catch(() => {});
      this.tl.mark('login browser opened', `${account.label} (${account.account_key}) via ${egressId ? (this.store.egress.get(egressId)?.label ?? egressId) : 'direct'} → ${page.url()}${opened.seeded ? ' (persistent profile seeded from the saved session)' : ''}`);
      return this.status(accountId);
    } catch (e) {
      // openAccount released the lock file; give back the lease and the exclusive egress (the failover may have moved it)
      const current = this.store.egress.boundEgressOf(accountId)?.id ?? egressId;
      if (current) this.store.egress.releaseExclusive(current, key, 'login browser failed to launch');
      this.store.releaseRuntime(runtime, 'login browser failed to launch');
      if (e instanceof EgressError) throw new Error(`${e.code}: ${e.message}`);
      throw e;
    }
  }

  /**
   * The operator says login is complete: verify Website B is not on its login page, refresh the encrypted backup of
   * the session from the persistent profile, close the browser (the profile directory keeps everything).
   */
  async done(accountId: string): Promise<{ saved: boolean; reason?: string }> {
    const s = this.sessions.get(accountId);
    const account = this.store.get(accountId);
    if (!account) throw new Error('account not found');
    if (!s || !this.browser.isOpen(s.key)) return { saved: false, reason: 'the login browser is not open (start again)' };

    const url = this.browser.pageOf(s.key)?.url() ?? '';
    if (isLoginUrl(this.cfg, url)) return { saved: false, reason: `Website B is still on its login page (${url}). Finish logging in, then press Done.` };

    const json = await this.browser.exportStorageState(s.key);
    if (!json) return { saved: false, reason: 'the browser session could not be exported' };
    const cookieCount = (JSON.parse(json).cookies as unknown[]).length;
    if (cookieCount === 0) return { saved: false, reason: 'no cookies in the browser session yet' };

    this.store.saveSession(accountId, json);
    this.tl.mark('session saved', `${account.label}: ${cookieCount} cookies backed up encrypted (values not logged); persistent profile untouched`);
    await this.close(accountId, 'login done');
    return { saved: true };
  }

  async cancel(accountId: string): Promise<void> {
    await this.close(accountId, 'login cancelled');
    this.tl.mark('login cancelled', this.store.get(accountId)?.label ?? accountId);
  }

  private async close(accountId: string, reason: string): Promise<void> {
    const s = this.sessions.get(accountId);
    this.sessions.delete(accountId);
    if (s) {
      await this.browser.closeContext(s.key, reason); // releases the runtime lease and lock file
      if (s.egressId) this.store.egress.releaseExclusive(s.egressId, s.key, 'login capture ended');
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id, 'service shutting down');
  }
}
