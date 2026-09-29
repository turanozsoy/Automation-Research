import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface FieldConfig {
  /** Tried in order; the first selector that matches an element on the page wins. */
  selectors: string[];
  kind: 'text' | 'select';
  /** Optional normalisation applied before filling. */
  format?: 'MM/DD/YYYY';
}

export interface SiteBConfig {
  baseUrl: string;
  targetUrl: string;
  loginPathPattern: string;
  recommendedLink: string;
  fields: Record<string, FieldConfig>;
  submitButton: string;
  checkout: {
    frameUrlIncludes?: string;
    toggle: string;
    primaryButton: string;
    secondaryButton: string;
  };
  generatedUrl: {
    prefix: string;
    pattern: string;
    watchNavigationRequests: boolean;
    anchorPollMs: number;
  };
  timeouts: {
    pageLoad: number;
    action: number;
    iframe: number;
    checkoutStep: number;
    generatedUrl: number;
  };
  debounceMs: number;
}

interface RawFieldConfig { selector: string | string[]; kind?: 'text' | 'select'; format?: 'MM/DD/YYYY' }

export function loadConfig(): SiteBConfig {
  const path = resolve(process.cwd(), process.env.SITE_B_CONFIG ?? 'config/site-b.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));

  const fields: Record<string, FieldConfig> = {};
  for (const [name, f] of Object.entries(raw.fields as Record<string, RawFieldConfig>)) {
    const selectors = Array.isArray(f.selector) ? f.selector : [f.selector];
    if (selectors.length === 0) throw new Error(`Field "${name}" has no selector in ${path}`);
    fields[name] = { selectors, kind: f.kind ?? 'text', format: f.format };
  }

  const required = ['baseUrl', 'targetUrl', 'loginPathPattern', 'recommendedLink', 'submitButton', 'checkout', 'generatedUrl', 'timeouts'];
  for (const key of required) {
    if (raw[key] === undefined) throw new Error(`Missing "${key}" in ${path}`);
  }

  const cfg: SiteBConfig = {
    baseUrl: raw.baseUrl,
    targetUrl: raw.targetUrl,
    loginPathPattern: raw.loginPathPattern,
    recommendedLink: raw.recommendedLink,
    fields,
    submitButton: raw.submitButton,
    checkout: {
      frameUrlIncludes: raw.checkout.frameUrlIncludes || undefined,
      toggle: raw.checkout.toggle,
      primaryButton: raw.checkout.primaryButton,
      secondaryButton: raw.checkout.secondaryButton,
    },
    generatedUrl: {
      prefix: raw.generatedUrl.prefix,
      pattern: raw.generatedUrl.pattern,
      watchNavigationRequests: raw.generatedUrl.watchNavigationRequests ?? true,
      anchorPollMs: raw.generatedUrl.anchorPollMs ?? 250,
    },
    timeouts: {
      pageLoad: raw.timeouts.pageLoad ?? 60000,
      action: raw.timeouts.action ?? 10000,
      iframe: raw.timeouts.iframe ?? 30000,
      checkoutStep: raw.timeouts.checkoutStep ?? 30000,
      generatedUrl: raw.timeouts.generatedUrl ?? 30000,
    },
    debounceMs: raw.debounceMs ?? 150,
  };

  // Fail early on a bad regex rather than at submit time.
  new RegExp(cfg.loginPathPattern);
  new RegExp(cfg.generatedUrl.pattern);

  console.log(`[config] loaded ${path}`);
  return cfg;
}

/** True when `url` is on Website B's host and its path matches the login pattern. */
export function isLoginUrl(cfg: SiteBConfig, url: string): boolean {
  try {
    const u = new URL(url);
    const base = new URL(cfg.baseUrl);
    return u.host === base.host && new RegExp(cfg.loginPathPattern).test(u.pathname);
  } catch {
    return false;
  }
}
