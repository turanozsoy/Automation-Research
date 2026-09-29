import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AutocompleteConfig {
  /** Selectors for suggestion options (any frame-less DOM, incl. portals). Tried as one combined selector. */
  suggestionSelectors: string[];
  /** How long to wait for the suggestion UI after typing the address. */
  appearTimeoutMs: number;
  /** 'required': fail if no suggestion UI appears. 'auto': continue with the typed value if none appears. */
  mode: 'required' | 'auto';
  /** Fields Website B may overwrite when a suggestion is picked; re-reconciled afterwards. */
  dependentFields: string[];
}

export interface FieldConfig {
  /** Tried in order; the first selector that matches an element on the page wins. */
  selectors: string[];
  kind: 'text' | 'select';
  /** Optional normalisation applied before filling. */
  format?: 'MM/DD/YYYY';
  /** 'live': filled as the user types. 'deferred': kept in the snapshot, applied only at submit. */
  syncMode: 'live' | 'deferred';
  /** 'fill' sets the value in one go; 'type' presses keys (no delay) for widgets that need key events. */
  inputMethod: 'fill' | 'type';
  /** Website B masks this field after entry: never read back for comparison, never log its value. */
  writeOnly: boolean;
  /** Present when the field drives an address-suggestion widget. */
  autocomplete?: AutocompleteConfig;
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

interface RawFieldConfig {
  selector: string | string[]; kind?: 'text' | 'select'; format?: 'MM/DD/YYYY';
  syncMode?: 'live' | 'deferred'; inputMethod?: 'fill' | 'type'; writeOnly?: boolean;
  autocomplete?: Partial<AutocompleteConfig>;
}

export function loadConfig(): SiteBConfig {
  const path = resolve(process.cwd(), process.env.SITE_B_CONFIG ?? 'config/site-b.json');
  let raw = JSON.parse(readFileSync(path, 'utf8'));

  // Optional gitignored override next to the base file (site-b.json -> site-b.local.json).
  // Lets you keep real URLs/selectors locally without conflicting with repo updates.
  const localPath = path.replace(/\.json$/, '.local.json');
  if (existsSync(localPath)) {
    raw = deepMerge(raw, JSON.parse(readFileSync(localPath, 'utf8')));
    console.log(`[config] merged override ${localPath}`);
  }

  const fields: Record<string, FieldConfig> = {};
  for (const [name, f] of Object.entries(raw.fields as Record<string, RawFieldConfig>)) {
    const selectors = Array.isArray(f.selector) ? f.selector : [f.selector];
    if (selectors.length === 0) throw new Error(`Field "${name}" has no selector in ${path}`);
    const autocomplete: AutocompleteConfig | undefined = f.autocomplete
      ? {
          suggestionSelectors: f.autocomplete.suggestionSelectors ?? ['[role="listbox"] [role="option"]', 'ul[role="listbox"] li', '.pac-item'],
          appearTimeoutMs: f.autocomplete.appearTimeoutMs ?? 2500,
          mode: f.autocomplete.mode ?? 'auto',
          dependentFields: f.autocomplete.dependentFields ?? [],
        }
      : undefined;
    fields[name] = {
      selectors, kind: f.kind ?? 'text', format: f.format,
      syncMode: f.syncMode ?? 'live',
      inputMethod: f.inputMethod ?? 'fill',
      writeOnly: f.writeOnly ?? false,
      autocomplete,
    };
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

function deepMerge(base: any, override: any): any {
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== 'object' || typeof override !== 'object' || !base || !override) return override;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
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
