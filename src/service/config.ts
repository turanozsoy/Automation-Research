import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  /** false: the field may not exist until a later step (e.g. state appears after an address is accepted). */
  requiredAtStart: boolean;
}

/**
 * Address finalisation. The address fields sync live; when the trigger field (the
 * authentication code) first arrives, the address input is focused and Enter is
 * pressed so Website B's autocomplete can finalise the address, the resulting values
 * are read, and mismatches against Website A are repaired. At submit the same
 * verify + repair runs strictly and blocks the submit click on failure.
 */
export interface AddressFinalizeConfig {
  /** Address fields in sync/repair order, e.g. ["address1","city","state","zip"]. */
  fields: string[];
  /** The autocomplete input (a key of `fields`), where Enter is pressed. */
  inputField: string;
  /** Field whose first update triggers the finalisation (write-only authentication code). */
  trigger: string;
  /** Wait for a suggestion list before pressing Enter (Enter into a closed list would submit the form). */
  suggestionsWaitMs: number;
  /** After Enter: address values must stay unchanged this long to count as settled. */
  settleQuietMs: number;
  settleMaxMs: number;
  /** Bounded repair rounds before giving up (submit is then refused). */
  repairRounds: number;
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
  /** false: the field may not exist until a later step (e.g. state appears after an address is accepted). */
  requiredAtStart: boolean;
}

/** Address autocomplete driven purely by keyboard: type one search string, ArrowDown, Enter, verify reveal. */
export interface AddressSearchConfig {
  /** The autocomplete input field (a key under `fields`). */
  field: string;
  /** Field names concatenated into the search string, in order. */
  order: string[];
  separator: string;
  /** How a two-letter state code is written into the search string. */
  stateAs: 'name' | 'code';
  /** Upper bound to wait for a suggestion signal (aria-expanded / role=option) before pressing keys anyway. */
  suggestionsWaitMs: number;
  /** Short settle after a suggestion signal so the list is populated. */
  settleMs: number;
  /** Key sequences tried on successive attempts, e.g. [["ArrowDown","Enter"],["Enter"]]. */
  keySequences: string[][];
  /** Pause between keys of a sequence so the widget can render the highlight. */
  keyDelayMs: number;
  /** true: press the keys even when no suggestion list was detected (Enter may then submit the form; handled). */
  enterWithoutList: boolean;
  /** Fields that must become visible after Enter to count the address as accepted. */
  revealFields: string[];
  revealTimeoutMs: number;
  /** Fields Website B may populate from the accepted address; reconciled against the snapshot afterwards. */
  dependentFields: string[];
  /** Extra attempts of the type + ArrowDown + Enter cycle when the reveal does not happen. */
  retries: number;
}

export interface SiteBConfig {
  baseUrl: string;
  targetUrl: string;
  loginPathPattern: string;
  recommendedLink: string;
  fields: Record<string, FieldConfig>;
  submitButton: string;
  addressFinalize?: AddressFinalizeConfig;
  /** After the URL is delivered: watch the automated page for a success text, then close the workflow. */
  verification: {
    /** Any of these (case-insensitive, apostrophes normalised) in any frame's visible text counts as verified. */
    successTexts: string[];
    pollMs: number;
    /** Give up waiting for the success text after this long; the workflow ends as abandoned. */
    timeoutMs: number;
  };
  checkout: {
    frameUrlIncludes?: string;
    /** Optional button shown right after the submit click (e.g. aria-label="Agree and continue"). */
    agreeButton?: string;
    toggle: string;
    primaryButton: string;
    secondaryButton: string;
  };
  generatedUrl: {
    prefix: string;
    pattern: string;
    watchNavigationRequests: boolean;
    anchorPollMs: number;
    /** After the first match, keep watching until no new matching URL appears for this long; report the final one. 0 = first match wins. */
    settleMs: number;
    /** Upper bound on the settle phase. */
    settleMaxMs: number;
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
  syncMode?: 'live' | 'deferred'; inputMethod?: 'fill' | 'type'; writeOnly?: boolean; requiredAtStart?: boolean;
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
    fields[name] = {
      selectors, kind: f.kind ?? 'text', format: f.format,
      syncMode: f.syncMode ?? 'live',
      inputMethod: f.inputMethod ?? 'fill',
      writeOnly: f.writeOnly ?? false,
      requiredAtStart: f.requiredAtStart ?? true,
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
    verification: {
      successTexts: raw.verification?.successTexts ?? ["You're good to go"],
      pollMs: raw.verification?.pollMs ?? 1000,
      timeoutMs: raw.verification?.timeoutMs ?? 10 * 60_000,
    },
    addressFinalize: raw.addressFinalize
      ? {
          fields: raw.addressFinalize.fields ?? ['address1', 'city', 'state', 'zip'],
          inputField: raw.addressFinalize.inputField ?? 'address1',
          trigger: raw.addressFinalize.trigger ?? 'authenticationCode',
          suggestionsWaitMs: raw.addressFinalize.suggestionsWaitMs ?? 1500,
          settleQuietMs: raw.addressFinalize.settleQuietMs ?? 400,
          settleMaxMs: raw.addressFinalize.settleMaxMs ?? 4000,
          repairRounds: raw.addressFinalize.repairRounds ?? 2,
        }
      : undefined,
    checkout: {
      frameUrlIncludes: raw.checkout.frameUrlIncludes || undefined,
      agreeButton: raw.checkout.agreeButton || undefined,
      toggle: raw.checkout.toggle,
      primaryButton: raw.checkout.primaryButton,
      secondaryButton: raw.checkout.secondaryButton,
    },
    generatedUrl: {
      prefix: raw.generatedUrl.prefix,
      pattern: raw.generatedUrl.pattern,
      watchNavigationRequests: raw.generatedUrl.watchNavigationRequests ?? true,
      anchorPollMs: raw.generatedUrl.anchorPollMs ?? 250,
      settleMs: raw.generatedUrl.settleMs ?? 1500,
      settleMaxMs: raw.generatedUrl.settleMaxMs ?? 10000,
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

  if (cfg.addressFinalize) {
    for (const n of [cfg.addressFinalize.inputField, cfg.addressFinalize.trigger, ...cfg.addressFinalize.fields]) {
      if (!(n in cfg.fields)) throw new Error(`addressFinalize references unknown field "${n}" in ${path}`);
    }
  }

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
