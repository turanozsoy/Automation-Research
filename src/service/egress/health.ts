import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { Timeline } from '../timeline.js';
import type { EgressStore } from './store.js';

/**
 * Active health checks for proxy egresses: an HTTP CONNECT to the check target's host:443 (https
 * targets) or a plain GET through the proxy (http targets). Runs on an interval and on demand.
 * Credentials go into the Proxy-Authorization header only; results are recorded without them.
 */
export class EgressHealth {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(private egress: EgressStore, private checkUrl: string, private intervalMs: number, private tl: Timeline, private onChange: () => void = () => {}, private timeoutMs = 15_000) {}
  setOnChange(fn: () => void): void { this.onChange = fn; }

  start(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    setTimeout(() => void this.checkAll(), 3000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async checkAll(): Promise<void> {
    for (const row of this.egress.checkable()) await this.check(row.id);
  }

  async check(id: string): Promise<{ ok: boolean; error?: string; ms: number }> {
    if (this.running.has(id)) return { ok: false, error: 'check already running', ms: 0 };
    this.running.add(id);
    const t0 = Date.now();
    try {
      const opts = this.egress.proxyOptions(id);
      if (!opts) return { ok: true, ms: 0 };
      const before = this.egress.get(id);
      const r = await probe(opts, this.checkUrl, this.timeoutMs);
      this.egress.recordCheck(id, r.ok, r.error, r.hard);
      const after = this.egress.get(id);
      if (before && after && (before.health !== after.health || before.state !== after.state)) {
        this.tl.mark('egress health', `${after.label}: ${after.health}${after.state !== before.state ? `, state ${after.state}` : ''}${r.error ? ` (${r.error})` : ''}`);
        this.onChange();
      }
      return { ...r, ms: Date.now() - t0 };
    } finally {
      this.running.delete(id);
    }
  }
}

/** Outcome of one probe. `hard` = the PROXY itself is unusable (unreachable, refuses the connection, rejects the
 * credentials, answers 503); a soft failure means the proxy answered or accepted the connection but the TARGET was slow
 * or unreachable through it (timeout after connecting, CONNECT 502/504/403, HTTP 5xx). Only hard failures take a proxy down. */
export interface ProbeResult { ok: boolean; error?: string; hard: boolean; ms: number }

const HARD_CONNECT_CODES = new Set([503, 407]);

/** One request through the proxy. Resolves with ok=false on any failure; never throws. */
export function probe(opts: { server: string; username?: string; password?: string }, checkUrl: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let done = false;
    const t0 = Date.now();
    let connected = false;
    const finish = (ok: boolean, error?: string, hard = false) => { if (!done) { done = true; resolve({ ok, error, hard: ok ? false : hard, ms: Date.now() - t0 }); } };
    let proxy: URL, target: URL;
    try { proxy = new URL(opts.server); target = new URL(checkUrl); } catch (e) { return finish(false, 'bad url', true); }
    if (proxy.protocol.startsWith('socks')) return finish(true); // no active probe for socks5 (passive health only)
    const auth = opts.username !== undefined ? 'Basic ' + Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64') : null;
    // a timeout BEFORE the TCP connection to the proxy is a proxy failure; after it, the proxy is alive and the target is slow
    const timer = setTimeout(() => finish(false, connected ? `slow: no answer from the target within ${timeoutMs} ms (proxy reachable)` : `timeout: no connection to the proxy within ${timeoutMs} ms`, !connected), timeoutMs);
    if (target.protocol === 'https:') {
      const sock = connect(Number(proxy.port), proxy.hostname, () => {
        connected = true;
        sock.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
      });
      sock.once('data', (d) => {
        const line = d.toString().split('\r\n')[0]; const m = /^HTTP\/1\.[01] (\d{3})/.exec(line); clearTimeout(timer); sock.destroy();
        if (!m) return finish(false, 'bad proxy response', true);
        const code = Number(m[1]);
        if (code === 200) return finish(true);
        finish(false, `CONNECT ${code}${code === 407 ? ': proxy rejected the credentials' : code === 503 ? ': proxy unavailable' : ': the proxy could not reach the target'}`, HARD_CONNECT_CODES.has(code));
      });
      sock.on('error', (e) => { clearTimeout(timer); finish(false, (e as NodeJS.ErrnoException).code ?? e.message, !connected); });
    } else {
      // agent: false -> a fresh TCP connection per probe, so "connected" really means the proxy accepted a connection now
      const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: target.href, headers: { host: target.host, ...(auth ? { 'proxy-authorization': auth } : {}) }, timeout: timeoutMs, agent: false }, (res) => {
        clearTimeout(timer); res.resume();
        const code = res.statusCode ?? 0;
        if (code > 0 && code < 500 && code !== 407) return finish(true);
        finish(false, `HTTP ${code}${code === 407 ? ': proxy rejected the credentials' : code === 503 ? ': proxy unavailable' : ': the target failed through the proxy'}`, HARD_CONNECT_CODES.has(code));
      });
      req.on('socket', (sk) => { if (!sk.connecting) connected = true; else sk.once('connect', () => { connected = true; }); });
      req.on('timeout', () => { req.destroy(); finish(false, connected ? `slow: no answer from the target within ${timeoutMs} ms (proxy reachable)` : `timeout: no connection to the proxy within ${timeoutMs} ms`, !connected); });
      req.on('error', (e) => { clearTimeout(timer); finish(false, (e as NodeJS.ErrnoException).code ?? e.message, !connected); });
      req.end();
    }
  });
}

/**
 * Launch-time preflight: up to `attempts` probes through the proxy, one second apart, each bounded by `timeoutMs`.
 * The result reports every attempt so the caller can record them like health checks. `softOnly` = every attempt failed
 * but the proxy itself was reachable (slow target): the launch may proceed; only hard failures take the proxy down. socks5 proxies have no active probe (see probe()): they pass and the launch itself decides.
 */
export async function preflightProxy(opts: { server: string; username?: string; password?: string }, checkUrl: string, attempts: number, timeoutMs: number): Promise<{ ok: boolean; softOnly: boolean; attempts: ProbeResult[]; probed: boolean }> {
  let proxy: URL;
  try { proxy = new URL(opts.server); } catch { return { ok: false, softOnly: false, attempts: [{ ok: false, error: 'bad proxy url', hard: true, ms: 0 }], probed: false }; }
  if (proxy.protocol.startsWith('socks')) return { ok: true, softOnly: false, attempts: [], probed: false };
  const results: ProbeResult[] = [];
  for (let i = 0; i < Math.max(1, attempts); i++) {
    const r = await probe(opts, checkUrl, timeoutMs);
    results.push(r);
    if (r.ok) return { ok: true, softOnly: false, attempts: results, probed: true };
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 1000));
  }
  // every attempt failed: the proxy is down only when it was itself unreachable / refusing; a slow target is not its fault
  return { ok: false, softOnly: results.every((r) => !r.hard), attempts: results, probed: true };
}
