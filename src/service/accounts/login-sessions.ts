import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { isLoginUrl, type SiteBConfig } from '../config.js';
import type { ProfileStore } from '../profiles/store.js';
import type { Settings } from '../settings.js';
import type { Timeline } from '../timeline.js';

interface LoginSession { accountId: string; browser: Browser; context: BrowserContext; page: Page; startedAt: number }

export interface LoginStatus { accountId: string; open: boolean; startedAt?: number; currentUrl?: string; onLoginPage?: boolean }

/**
 * Manual-login browsers for the accounts page. Each "Get Cookies" / "Refresh Cookies"
 * opens ONE visible Chromium dedicated to that account (never the automation browser),
 * seeded with the account's current session when one exists. The operator logs in by
 * hand; "Done" exports the context's storageState, which the store encrypts and saves.
 *
 * Later, this is where the account's own proxy / egress configuration will be applied
 * to the launch, so the login happens from the same network the workflows will use.
 */
export class LoginSessionManager {
  private sessions = new Map<string, LoginSession>();

  constructor(private settings: Settings, private cfg: SiteBConfig, private store: ProfileStore, private tl: Timeline) {}

  status(accountId: string): LoginStatus {
    const s = this.sessions.get(accountId);
    if (!s) return { accountId, open: false };
    const url = s.page.isClosed() ? '' : s.page.url();
    return { accountId, open: true, startedAt: s.startedAt, currentUrl: url, onLoginPage: isLoginUrl(this.cfg, url) };
  }

  /** Open the visible login browser for an account. Idempotent: an open one is reused. */
  async start(accountId: string): Promise<LoginStatus> {
    const account = this.store.get(accountId);
    if (!account) throw new Error('account not found');
    const existing = this.sessions.get(accountId);
    if (existing && !existing.page.isClosed()) return this.status(accountId);
    if (existing) await this.close(accountId);

    // Visible by default; LOGIN_HEADLESS=1 exists only for automated tests.
    const headless = process.env.LOGIN_HEADLESS === '1';
    const browser = await chromium.launch({
      headless,
      executablePath: this.settings.chromiumPath,
      args: headless ? [] : ['--window-size=1200,860', '--window-position=80,60'],
    });
    let storageState: object | undefined;
    if (account.session_saved_at) {
      try { storageState = JSON.parse(this.store.decryptStorageState(account)); } catch { storageState = undefined; }
    }
    const context = await browser.newContext({ storageState: storageState as any, viewport: headless ? { width: 1200, height: 860 } : null });
    const page = await context.newPage();
    const session: LoginSession = { accountId, browser, context, page, startedAt: Date.now() };
    this.sessions.set(accountId, session);
    browser.on('disconnected', () => {
      if (this.sessions.get(accountId) === session) {
        this.sessions.delete(accountId);
        this.tl.mark('login browser closed by user', account.label);
      }
    });
    await page.goto(this.cfg.targetUrl, { waitUntil: 'domcontentloaded', timeout: this.cfg.timeouts.pageLoad }).catch(() => {});
    this.tl.mark('login browser opened', `${account.label} (${account.account_key}) → ${page.url()}${storageState ? ' with current session' : ''}`);
    return this.status(accountId);
  }

  /**
   * The operator says login is complete: verify Website B is not on its login page,
   * export the storageState, save it encrypted, close the browser.
   */
  async done(accountId: string): Promise<{ saved: boolean; reason?: string }> {
    const s = this.sessions.get(accountId);
    const account = this.store.get(accountId);
    if (!account) throw new Error('account not found');
    if (!s || s.page.isClosed()) return { saved: false, reason: 'the login browser is not open (start again)' };

    const url = s.page.url();
    if (isLoginUrl(this.cfg, url)) return { saved: false, reason: `Website B is still on its login page (${url}). Finish logging in, then press Done.` };

    const json = JSON.stringify(await s.context.storageState());
    const cookieCount = (JSON.parse(json).cookies as unknown[]).length;
    if (cookieCount === 0) return { saved: false, reason: 'no cookies in the browser session yet' };

    this.store.saveSession(accountId, json);
    this.tl.mark('session saved', `${account.label}: ${cookieCount} cookies (values not logged)`);
    await this.close(accountId);
    return { saved: true };
  }

  async cancel(accountId: string): Promise<void> {
    await this.close(accountId);
    this.tl.mark('login cancelled', this.store.get(accountId)?.label ?? accountId);
  }

  private async close(accountId: string): Promise<void> {
    const s = this.sessions.get(accountId);
    this.sessions.delete(accountId);
    if (s) await s.browser.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }
}
