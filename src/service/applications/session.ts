import { createHash, randomBytes } from 'node:crypto';

/**
 * Applicant session: an opaque 256-bit token, given to the browser in a first-party
 * HttpOnly cookie. The server stores only its SHA-256; knowing an applicationId is
 * never enough to read or subscribe to an application.
 */
export const SESSION_COOKIE = 'shipzora_session';

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cookie header -> map. Values are URL-decoded; malformed pairs are skipped. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed value */ }
  }
  return out;
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeMs: number }): string {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Only a well-formed token is worth a database lookup. */
export function looksLikeToken(token: string | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(token);
}
