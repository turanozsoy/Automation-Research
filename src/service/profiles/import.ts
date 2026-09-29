import type { BrowserManager } from '../browser/manager.js';
import { isLoginUrl, type SiteBConfig } from '../config.js';
import type { ProfileStore } from './store.js';

export interface ImportRequest { label: string; accountKey: string; storageState: unknown }
export interface ImportResult { id: string; label: string; action: 'inserted' | 'reseeded'; verified: boolean | null; detail: string }

interface RawCookie {
  name: string; value: string; domain: string; path?: string;
  expires?: number; expirationDate?: number; httpOnly?: boolean; secure?: boolean;
  sameSite?: string; session?: boolean;
}
interface PwStorageState { cookies: unknown[]; origins: unknown[] }

/**
 * Normalise a storageState coming from the browser extension (or any export) into
 * what Playwright accepts: cookies with `expires` in seconds (-1 for a session
 * cookie) and `sameSite` in {Strict, Lax, None}; origins carrying localStorage.
 * Accepts either a full {cookies, origins} object or a bare array of cookies.
 */
export function normaliseStorageState(input: unknown): string {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  const cookiesIn: RawCookie[] = Array.isArray(raw) ? raw : Array.isArray(raw?.cookies) ? raw.cookies : [];
  const originsIn: unknown[] = Array.isArray(raw?.origins) ? raw.origins : [];

  const sameSite = (s: string | undefined): 'Strict' | 'Lax' | 'None' => {
    switch ((s ?? '').toLowerCase()) {
      case 'strict': return 'Strict';
      case 'none': case 'no_restriction': return 'None';
      default: return 'Lax';
    }
  };

  const cookies = cookiesIn
    .filter((c) => c && c.name && c.domain)
    .map((c) => {
      const expiresRaw = c.expires ?? c.expirationDate;
      const expires = c.session || expiresRaw === undefined || expiresRaw <= 0 ? -1 : Math.floor(expiresRaw);
      return {
        name: c.name,
        value: c.value ?? '',
        domain: c.domain,
        path: c.path || '/',
        expires,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: sameSite(c.sameSite),
      };
    });

  const state: PwStorageState = { cookies, origins: originsIn };
  return JSON.stringify(state);
}

/**
 * Insert a new profile or re-seed an existing one (matched by account key), then
 * verify the session against Website B. Verification failure keeps the imported
 * session but marks the profile expired, so the operator sees it needs a fresh login.
 */
export async function importProfile(
  req: ImportRequest,
  store: ProfileStore,
  browser: BrowserManager,
  cfg: SiteBConfig,
): Promise<ImportResult> {
  if (!req.label || !req.accountKey) throw new Error('label and accountKey are required');
  const json = normaliseStorageState(req.storageState);
  const cookieCount = (JSON.parse(json).cookies as unknown[]).length;
  if (cookieCount === 0) throw new Error('no cookies in the imported session');

  const existing = store.byLabelOrId(req.accountKey) ?? store.byLabelOrId(req.label);
  let id: string;
  let action: 'inserted' | 'reseeded';
  if (existing) {
    store.reseed(existing.id, json);
    id = existing.id;
    action = 'reseeded';
  } else {
    id = store.insert(req.label, req.accountKey, json).id;
    action = 'inserted';
  }

  const verified = await verifySession(id, json, store, browser, cfg).catch(() => null);
  const detail = verified === true ? `${cookieCount} cookies, session valid`
    : verified === false ? `${cookieCount} cookies, but NOT authenticated (marked expired, re-login and re-import)`
    : `${cookieCount} cookies, could not verify (browser unavailable)`;
  return { id, label: existing?.label ?? req.label, action, verified, detail };
}

async function verifySession(
  profileId: string,
  json: string,
  store: ProfileStore,
  browser: BrowserManager,
  cfg: SiteBConfig,
): Promise<boolean | null> {
  if (!browser.isAlive()) return null;
  const probeId = `verify:${profileId}`;
  try {
    const { page } = await browser.createContext(probeId, json);
    await page.goto(cfg.targetUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageLoad });
    const ok = !isLoginUrl(cfg, page.url());
    if (ok) store.markVerified(profileId);
    else store.setState(profileId, 'expired', 'import verify: redirected to login');
    return ok;
  } finally {
    await browser.closeContext(probeId);
  }
}
