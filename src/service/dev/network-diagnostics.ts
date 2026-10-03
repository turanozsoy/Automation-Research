import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import type { BrowserManager } from '../browser/manager.js';
import { classifyCanary, describePlan, DNS_CANARY_SUFFIX, type CanaryVerdict } from '../browser/network.js';
import { EgressError } from '../egress/store.js';
import { ProfileRuntimeError, type ProfileStore } from '../profiles/store.js';
import type { Settings } from '../settings.js';
import type { Timeline } from '../timeline.js';

/**
 * Development-only network diagnostics for ONE account (internal API, operator login): opens the account's own
 * browser through the same BrowserManager.openAccount path as workflows and manual logins (same profile directory,
 * same assigned proxy, same runtime lock), then checks from inside the browser:
 *   - the effective command line (resolver rule present, proxy configured, no credentials),
 *   - the Secure DNS mode Chromium actually applied (histogram Net.DNS.DnsConfig.SecureDnsMode),
 *   - the public IP seen by an echo service, fetched through the proxy,
 *   - a controlled DNS-path test: a name under the reserved `.invalid` TLD that nobody can resolve, so the failure
 *     mode tells WHERE the lookup was attempted (proxy answered = remote DNS; ERR_NAME_NOT_RESOLVED = local lookup).
 * The account must already have an assigned proxy (nothing is assigned here; a direct account is never diagnosed).
 * Failover is disabled for this launch. The report never carries a username, password or encrypted value.
 */
export interface DiagnosticsReport {
  ok: boolean;
  verdict: 'ok' | 'leak' | 'launch_refused' | 'inconclusive' | 'not_applicable';
  account: { id: string; label: string };
  egress: { id: string; label: string; protocol: string | null; hostIsLiteral: boolean } | null;
  network: Record<string, unknown> | null;
  launch: { ok: boolean; code?: string; message?: string; failover: boolean; directFallback: false };
  commandLine: { hostResolverRules: string | null; proxyServerConfigured: boolean; credentialsPresent: boolean } | null;
  secureDns: { configured: 'off'; observed: 'off' | 'automatic' | 'secure' | 'unknown'; detail: string } | null;
  /** What the echo URL answered through the proxy: extracted IP, HTTP status and a short, credential-scrubbed body excerpt. */
  publicIp: { url: string; ip: string | null; status: number | null; bodySnippet: string | null; error: string | null } | null;
  canary: { hostname: string; http: { verdict: CanaryVerdict; explanation: string }; https: { verdict: CanaryVerdict; explanation: string } | null } | null;
  notes: string[];
  durationMs: number;
}

const SECURE_DNS_HISTOGRAM = 'Net.DNS.DnsConfig.SecureDnsMode';
/** Chromium's SecureDnsModeDetailsForHistogram: 0..3 = off (by user / policy / managed environment / parental controls), 4 = automatic, 5 = secure. */
const secureDnsFromSample = (v: number): 'off' | 'automatic' | 'secure' | 'unknown' => (v >= 0 && v <= 3 ? 'off' : v === 4 ? 'automatic' : v === 5 ? 'secure' : 'unknown');

export class NetworkDiagnostics {
  private running = new Set<string>();
  constructor(private settings: Settings, private store: ProfileStore, private browser: BrowserManager, private tl: Timeline) {}

  async run(accountId: string): Promise<DiagnosticsReport> {
    const t0 = Date.now();
    const account = this.store.get(accountId);
    if (!account) throw new Error('account not found');
    if (this.running.has(accountId)) throw new Error('diagnostics already running for this account');
    this.running.add(accountId);
    const notes: string[] = [];
    const base = { account: { id: account.id, label: account.label }, notes };
    try {
      const bound = this.store.egress.boundEgressOf(accountId);
      if (!bound) {
        notes.push('This account has no assigned proxy. Diagnostics never assign one; bind a proxy first (or run a workflow, which binds a clean proxy).');
        return { ...base, ok: false, verdict: 'not_applicable', egress: null, network: null, launch: { ok: false, failover: false, directFallback: false }, commandLine: null, secureDns: null, publicIp: null, canary: null, durationMs: Date.now() - t0 };
      }
      const egress = { id: bound.id, label: bound.label, protocol: bound.kind === 'direct' ? null : bound.kind, hostIsLiteral: false };
      // secrets to scrub from anything the browser or an error hands back (never written anywhere)
      const creds = this.store.egress.proxyOptions(bound.id);
      const secrets = [creds?.username, creds?.password].filter((s): s is string => !!s && s.length >= 3);
      const scrub = (s: string) => secrets.reduce((acc, sec) => acc.split(sec).join('<redacted>'), s);

      const key = `diag:${accountId}`;
      let runtime;
      try { runtime = this.store.acquireRuntime(accountId, 'diagnostic'); }
      catch (e) { throw new Error(e instanceof ProfileRuntimeError ? `This account's browser is in use (${e.message}); run diagnostics when it is idle.` : String(e)); }
      const acquired = this.store.egress.acquireExclusive(accountId, false, key);
      if (acquired.id === null) {
        this.store.releaseRuntime(runtime, 'diagnostics: egress unavailable');
        notes.push(`The assigned proxy cannot be used right now: ${acquired.blocked ?? 'no egress'}.`);
        return { ...base, ok: false, verdict: 'launch_refused', egress, network: null, launch: { ok: false, code: 'EGRESS_NOT_ELIGIBLE', message: acquired.blocked ?? 'no egress', failover: false, directFallback: false }, commandLine: null, secureDns: null, publicIp: null, canary: null, durationMs: Date.now() - t0 };
      }
      if (acquired.id !== bound.id) {
        // cannot happen for a bound account (pickForAccount reuses the binding); refuse rather than diagnose the wrong proxy
        this.store.egress.releaseExclusive(acquired.id, key, 'diagnostics: unexpected egress');
        this.store.releaseRuntime(runtime, 'diagnostics: unexpected egress');
        throw new Error('the account was handed an egress other than its assigned proxy; aborted');
      }

      let opened;
      try {
        opened = await this.browser.openAccount({ key, profileId: accountId, runtime, egressId: bound.id, headless: true, allowFailover: false, exclusiveTag: key });
      } catch (e) {
        this.store.egress.releaseExclusive(bound.id, key, 'diagnostics: launch refused');
        this.store.releaseRuntime(runtime, 'diagnostics: launch refused');
        const code = e instanceof EgressError ? e.code : e instanceof ProfileRuntimeError ? e.code : 'LAUNCH_FAILED';
        const message = scrub(e instanceof Error ? e.message.split('\n')[0] : String(e)).slice(0, 300);
        notes.push('The launch was refused and nothing ran through the server IP: a proxied account browser never falls back to direct.');
        this.tl.mark('network diagnostics: launch refused', `${account.label}: ${code}`);
        return { ...base, ok: false, verdict: 'launch_refused', egress, network: null, launch: { ok: false, code, message, failover: false, directFallback: false }, commandLine: null, secureDns: null, publicIp: null, canary: null, durationMs: Date.now() - t0 };
      }

      egress.hostIsLiteral = opened.network.proxyHostIsLiteral;
      const report: DiagnosticsReport = {
        ...base, ok: false, verdict: 'inconclusive', egress, network: describePlan(opened.network),
        launch: { ok: true, failover: !!opened.failover, directFallback: false }, commandLine: null, secureDns: null, publicIp: null, canary: null, durationMs: 0,
      };
      try {
        const page = opened.page;
        // 1. effective command line
        const cl = await readInternal(page, 'chrome://version', /Command Line/);
        const rules = /--host-resolver-rules="?([^"\n]*?)"?(?=\s+--|\s*$)/m.exec(cl)?.[1] ?? null;
        report.commandLine = { hostResolverRules: rules, proxyServerConfigured: /--proxy-server=/.test(cl), credentialsPresent: secrets.some((s) => cl.includes(s)) };
        if (!rules) notes.push('The host resolver rule is missing from the command line.');
        // 2. Secure DNS as applied by Chromium
        const hist = await readInternal(page, `chrome://histograms/${SECURE_DNS_HISTOGRAM}`, /SecureDnsMode/);
        const sample = /SecureDnsMode recorded \d+ samples?, mean = (\d+(?:\.\d+)?)/.exec(hist);
        const observed = sample ? secureDnsFromSample(Math.round(Number(sample[1]))) : 'unknown';
        report.secureDns = { configured: 'off', observed, detail: sample ? `${SECURE_DNS_HISTOGRAM} = ${Math.round(Number(sample[1]))} (0-3 off, 4 automatic, 5 secure)` : 'histogram not recorded yet' };
        if (observed !== 'off' && observed !== 'unknown') notes.push(`Secure DNS is ${observed} although the profile preference says off.`);
        // 3. public IP through the proxy
        const ipUrl = this.settings.diagIpUrl;
        const ipRes = await visit(page, ipUrl, 15000);
        const ipText = ipRes.status !== undefined ? await page.evaluate(() => document.body?.innerText ?? '').catch(() => '') : '';
        const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(ipText)?.[1] ?? (/\b([0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,7})\b/i.exec(ipText)?.[1] ?? null);
        report.publicIp = { url: ipUrl, ip, status: ipRes.status ?? null, bodySnippet: ipText ? scrub(ipText.replace(/\s+/g, ' ').slice(0, 160)) : null, error: ipRes.error ? scrub(ipRes.error) : null };
        // 4. controlled DNS-path test (http always; https CONNECT path for HTTP proxies)
        const nonce = randomBytes(6).toString('hex');
        const host = `${nonce}.${DNS_CANARY_SUFFIX}`;
        const http = classifyCanary(await visit(page, `http://${host}/`, 12000));
        const https = opened.network.protocol === 'http' ? classifyCanary(await visit(page, `https://${nonce}b.${DNS_CANARY_SUFFIX}/`, 12000)) : null;
        report.canary = { hostname: host, http, https };
        // verdict
        const leak = http.verdict === 'local' || https?.verdict === 'local' || report.commandLine.credentialsPresent;
        const solid = http.verdict === 'proxy' && (https === null || https.verdict === 'proxy') && !!rules && report.commandLine.proxyServerConfigured;
        report.verdict = leak ? 'leak' : solid ? 'ok' : 'inconclusive';
        report.ok = report.verdict === 'ok';
        if (http.verdict === 'proxy_unreachable') notes.push('The proxy itself could not be reached during the canary test; the public IP result above says whether the proxy works at all.');
        if (opened.failover) notes.push('Unexpected: the launch reported a failover although failover was disabled.');
      } finally {
        await this.browser.closeContext(key, 'diagnostics finished').catch(() => {});
        this.store.egress.releaseExclusive(bound.id, key, 'diagnostics finished');
      }
      report.durationMs = Date.now() - t0;
      // belt and braces: nothing secret leaves this method
      const json = scrub(JSON.stringify(report));
      this.tl.mark('network diagnostics', `${account.label} via ${bound.label}: ${report.verdict}; canary ${report.canary?.http.verdict ?? '-'}; Secure DNS ${report.secureDns?.observed ?? '-'}; IP ${report.publicIp?.ip ?? 'n/a'}`);
      return JSON.parse(json) as DiagnosticsReport;
    } finally {
      this.running.delete(accountId);
    }
  }
}

/** Navigate; report the HTTP status or the Chromium error name. Never throws. */
async function visit(page: Page, url: string, timeout: number): Promise<{ status?: number; error?: string }> {
  try {
    const r = await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
    return r ? { status: r.status() } : { error: 'no response' };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { error: msg.replace(/^page\.goto: /, '').slice(0, 200) };
  }
}

/** chrome:// internals pages render asynchronously; poll until the expected text is present. */
async function readInternal(page: Page, url: string, needle: RegExp): Promise<string> {
  try { await page.goto(url, { waitUntil: 'load', timeout: 8000 }); } catch { /* read whatever rendered */ }
  for (let i = 0; i < 16; i++) {
    const t = await page.evaluate(() => document.documentElement?.innerText ?? '').catch(() => '');
    if (needle.test(t)) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  return await page.evaluate(() => document.documentElement?.innerText ?? '').catch(() => '');
}
