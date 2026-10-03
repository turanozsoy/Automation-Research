import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The ONE place that turns an egress into Chromium/Playwright networking options. Every account browser (applicant
 * workflows, Add Account / Get Cookies, Refresh Cookies, the development diagnostics) launches through
 * BrowserManager.openAccount, which calls planNetwork() and applyNetworkPrefs(); nothing else builds proxy or DNS
 * configuration, so the three entry points cannot drift apart.
 *
 * What was verified against the Chromium that Playwright 1.63 installs (Chromium 141):
 *   - http:// proxy: Chromium never resolves the destination name itself. Plain http requests are sent as absolute
 *     URIs and https requests as `CONNECT host:443`; the proxy resolves the name. Verified with a canary name under
 *     the reserved `.invalid` TLD: the proxy received the name (proxy-side 502 / ERR_TUNNEL_CONNECTION_FAILED), never
 *     ERR_NAME_NOT_RESOLVED.
 *   - socks5:// proxy: Chromium's SOCKS5 client always sends the destination as a domain-name address (ATYP 3), even
 *     for IP literals, i.e. remote DNS by design (what curl calls socks5h). It supports NO authentication.
 *   - socks5h:// is not a Chromium scheme: every request fails with ERR_NO_SUPPORTED_PROXIES (no direct fallback).
 *   - socks4:// resolves locally. Never used here.
 *   - Secure DNS (DNS-over-HTTPS) defaults to "automatic" (histogram Net.DNS.DnsConfig.SecureDnsMode = 4). In that
 *     mode Chromium may probe/upgrade to a public DoH resolver directly from this machine, outside the proxy, for the
 *     names it resolves locally. It is turned off per profile through the Local State preference
 *     `dns_over_https.mode = "off"` (verified: histogram value 0 after seeding). There is no command-line switch for
 *     it, and a `--disable-features=` argument is overwritten by Playwright's own list, so the preference is used.
 *   - `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE <proxy host>` makes every local lookup other than the proxy's
 *     own address fail. With a working proxy nothing needs the local resolver; a request that somehow bypassed the
 *     proxy fails with ERR_NAME_NOT_RESOLVED instead of resolving through the server's DNS.
 *
 * The proxy's own hostname (when it is not an IP literal) is necessarily resolved by this machine's resolver: the
 * browser has to find the proxy before anything can go through it. That lookup reveals only the proxy's address.
 */
export interface ProxyEndpoint { server: string; username?: string; password?: string }
export type ProxyProtocol = 'http' | 'socks5';

export interface NetworkPlan {
  mode: 'proxied' | 'direct';
  protocol: ProxyProtocol | null;
  /** Proxy host as written (hostname or IP literal, brackets stripped) and port. Never credentials. */
  proxyHost: string | null;
  proxyPort: number | null;
  proxyHostIsLiteral: boolean;
  /** Playwright's `proxy` launch option (carries the credentials; never logged). */
  playwrightProxy: ProxyEndpoint | undefined;
  /** Chromium switches that belong to networking (host resolver rules). */
  args: string[];
  /** Where destination hostnames are resolved. */
  destinationDns: 'proxy' | 'local';
  /** Human-readable, credential-free explanation for the timeline and diagnostics. */
  dnsSummary: string;
  localResolver: string;
  /** Secure DNS (DoH) preference written into the profile's Local State before launch. */
  secureDns: 'off';
}

export class NetworkConfigError extends Error {
  constructor(public code: 'UNSUPPORTED_PROXY_SCHEME' | 'INVALID_PROXY_ADDRESS' | 'UNSUPPORTED_PROXY_AUTH', message: string) { super(message); }
}

/** Reserved TLD (RFC 2606): no resolver anywhere can answer it, so where the lookup is attempted is observable. */
export const DNS_CANARY_SUFFIX = 'dns-path.invalid';

/**
 * Build the networking configuration for one browser. `proxy` is EgressStore.proxyOptions(egressId) (null = direct,
 * which the caller only allows in development for accounts WITHOUT a proxy). Throws NetworkConfigError when the
 * proxy cannot be configured correctly; the caller must fail the launch, never continue direct.
 */
export function planNetwork(proxy: ProxyEndpoint | null): NetworkPlan {
  if (!proxy) {
    return {
      mode: 'direct', protocol: null, proxyHost: null, proxyPort: null, proxyHostIsLiteral: false, playwrightProxy: undefined, args: [],
      destinationDns: 'local', dnsSummary: 'no proxy: destination hostnames are resolved by this machine (development only)',
      localResolver: 'used', secureDns: 'off',
    };
  }
  let u: URL;
  try { u = new URL(proxy.server); } catch { throw new NetworkConfigError('INVALID_PROXY_ADDRESS', 'proxy address is not a valid URL'); }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  let protocol: ProxyProtocol;
  if (scheme === 'http') protocol = 'http';
  else if (scheme === 'socks5') protocol = 'socks5';
  else if (scheme === 'socks5h' || scheme === 'socks4' || scheme === 'socks4a' || scheme === 'socks' || scheme === 'https') {
    // socks5h is not a Chromium scheme (ERR_NO_SUPPORTED_PROXIES); socks4 resolves locally; https (TLS to the proxy) is
    // not what the provider lines describe. Refuse rather than guess.
    throw new NetworkConfigError('UNSUPPORTED_PROXY_SCHEME', `proxy scheme "${scheme}" is not supported for account browsers (use http or socks5)`);
  } else throw new NetworkConfigError('UNSUPPORTED_PROXY_SCHEME', `proxy scheme "${scheme.slice(0, 20)}" is not supported`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new NetworkConfigError('INVALID_PROXY_ADDRESS', 'proxy address has no host');
  if (!u.port) throw new NetworkConfigError('INVALID_PROXY_ADDRESS', 'proxy address has no port');
  if (u.username || u.password) throw new NetworkConfigError('INVALID_PROXY_ADDRESS', 'credentials belong in the separate fields, not in the proxy address');
  if (protocol === 'socks5' && (proxy.username !== undefined || proxy.password !== undefined)) {
    // Chromium's SOCKS5 client offers only the "no authentication" method; Playwright's proxy credentials apply to
    // HTTP proxies. A socks5 proxy that needs a login would fail every connection, so stop before launching.
    throw new NetworkConfigError('UNSUPPORTED_PROXY_AUTH', 'socks5 proxies with a username/password are not supported by Chromium; use the provider\'s http endpoint or IP allow-listing');
  }
  const literal = isIpLiteral(host);
  return {
    mode: 'proxied', protocol, proxyHost: host, proxyPort: Number(u.port), proxyHostIsLiteral: literal,
    playwrightProxy: { server: `${protocol}://${literal && host.includes(':') ? `[${host}]` : host}:${u.port}`, ...(proxy.username !== undefined ? { username: proxy.username, password: proxy.password ?? '' } : {}) },
    // No local DNS for anything but the proxy host itself: a request that somehow bypassed the proxy fails instead of
    // resolving (and revealing) through this machine's resolver. Destination names are resolved by the proxy.
    args: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}`],
    destinationDns: 'proxy',
    dnsSummary: protocol === 'http'
      ? 'destination hostnames are sent to the HTTP proxy (absolute-URI for http, CONNECT host:port for https) and resolved there'
      : 'destination hostnames are sent to the SOCKS5 proxy as domain names (ATYP 3) and resolved there',
    localResolver: literal ? 'blocked for every name (the proxy is an IP literal, nothing is looked up locally)' : `blocked for every name except the proxy host ${host}`,
    secureDns: 'off',
  };
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[0-9a-f:]+$/i.test(host) && host.includes(':');
}

/**
 * Write the networking preferences that live in the profile's `Local State` (browser-wide, not per Chromium profile):
 * Secure DNS off. Called before every launch while the caller holds the profile's runtime lock (Chromium is not
 * running on the directory), so an existing file is merged, never replaced. Chromium rewrites the file on exit and
 * keeps the value (verified).
 */
export function applyNetworkPrefs(profileDir: string): { file: string; changed: boolean } {
  const file = join(profileDir, 'Local State');
  let state: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { const parsed = JSON.parse(readFileSync(file, 'utf8')); if (parsed && typeof parsed === 'object') state = parsed; } catch { /* unreadable: rewrite the networking keys into a fresh object; Chromium regenerates the rest */ }
  }
  const doh = (state.dns_over_https && typeof state.dns_over_https === 'object' ? state.dns_over_https : {}) as Record<string, unknown>;
  const changed = doh.mode !== 'off' || doh.templates !== '';
  if (changed) {
    state.dns_over_https = { ...doh, mode: 'off', templates: '' };
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  }
  return { file, changed };
}

/** Credential-free view of a plan for logs, audit rows and the diagnostics report. */
export function describePlan(plan: NetworkPlan): Record<string, unknown> {
  return {
    mode: plan.mode, protocol: plan.protocol, proxyHost: plan.proxyHost, proxyPort: plan.proxyPort, proxyHostIsLiteral: plan.proxyHostIsLiteral,
    hostResolverRules: plan.args.find((a) => a.startsWith('--host-resolver-rules='))?.slice('--host-resolver-rules='.length) ?? null,
    destinationDns: plan.destinationDns, dnsSummary: plan.dnsSummary, localResolver: plan.localResolver, secureDns: plan.secureDns,
  };
}

/** One-line, credential-free summary for the timeline. */
export function planSummary(plan: NetworkPlan): string {
  if (plan.mode === 'direct') return 'direct (no proxy): local DNS, Secure DNS off';
  return `${plan.protocol} proxy ${plan.proxyHost}:${plan.proxyPort}; destination DNS via proxy; local resolver blocked${plan.proxyHostIsLiteral ? '' : ' except for the proxy host'}; Secure DNS off`;
}

export type CanaryVerdict = 'proxy' | 'local' | 'proxy_unreachable' | 'inconclusive';

/**
 * Interpret what happened when the browser opened `http(s)://<nonce>.dns-path.invalid/`. Nobody can resolve that name,
 * so the failure mode says WHERE the lookup was attempted.
 */
export function classifyCanary(outcome: { status?: number; error?: string }): { verdict: CanaryVerdict; explanation: string } {
  const e = outcome.error ?? '';
  if (outcome.status !== undefined) return { verdict: 'proxy', explanation: `the proxy received the hostname and answered HTTP ${outcome.status} (it could not resolve the canary, as expected)` };
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_HOST_UNREACHABLE/.test(e)) return { verdict: 'proxy', explanation: `the proxy received the hostname and could not resolve it (${e.match(/ERR_[A-Z_]+/)?.[0]}): no local lookup happened` };
  if (/ERR_SOCKS_CONNECTION_FAILED/.test(e)) return { verdict: 'proxy', explanation: 'the SOCKS proxy received the hostname and refused the connection: no local lookup happened' };
  if (/ERR_NAME_NOT_RESOLVED/.test(e)) return { verdict: 'local', explanation: 'Chromium tried to resolve the destination name on this machine (blocked by the resolver rule): the request did not go to the proxy' };
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_PROXY_AUTH|ERR_NO_SUPPORTED_PROXIES/.test(e)) return { verdict: 'proxy_unreachable', explanation: `the proxy itself could not be used (${e.match(/ERR_[A-Z_]+/)?.[0]}); no direct attempt was made` };
  return { verdict: 'inconclusive', explanation: e ? `unexpected result: ${e.slice(0, 120)}` : 'no result' };
}
