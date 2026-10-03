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

  constructor(private egress: EgressStore, private checkUrl: string, private intervalMs: number, private tl: Timeline, private onChange: () => void = () => {}) {}
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
      const r = await probe(opts, this.checkUrl, 8000);
      this.egress.recordCheck(id, r.ok, r.error);
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

/** One request through the proxy. Resolves with ok=false on any failure; never throws. */
export function probe(opts: { server: string; username?: string; password?: string }, checkUrl: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, error?: string) => { if (!done) { done = true; resolve({ ok, error }); } };
    let proxy: URL, target: URL;
    try { proxy = new URL(opts.server); target = new URL(checkUrl); } catch (e) { return finish(false, 'bad url'); }
    if (proxy.protocol.startsWith('socks')) return finish(true); // no active probe for socks5 (passive health only)
    const auth = opts.username !== undefined ? 'Basic ' + Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64') : null;
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    if (target.protocol === 'https:') {
      const sock = connect(Number(proxy.port), proxy.hostname, () => {
        sock.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
      });
      sock.once('data', (d) => { const line = d.toString().split('\r\n')[0]; const m = /^HTTP\/1\.[01] (\d{3})/.exec(line); clearTimeout(timer); sock.destroy(); finish(!!m && m[1] === '200', m ? `CONNECT ${m[1]}` : 'bad proxy response'); });
      sock.on('error', (e) => { clearTimeout(timer); finish(false, (e as NodeJS.ErrnoException).code ?? e.message); });
    } else {
      const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: target.href, headers: { host: target.host, ...(auth ? { 'proxy-authorization': auth } : {}) }, timeout: timeoutMs }, (res) => {
        clearTimeout(timer); res.resume();
        const code = res.statusCode ?? 0;
        finish(code > 0 && code < 500 && code !== 407, code >= 500 || code === 407 ? `HTTP ${code}` : undefined);
      });
      req.on('timeout', () => { req.destroy(); finish(false, 'timeout'); });
      req.on('error', (e) => { clearTimeout(timer); finish(false, (e as NodeJS.ErrnoException).code ?? e.message); });
      req.end();
    }
  });
}

/**
 * Launch-time preflight: up to `attempts` probes through the proxy, one second apart, each bounded by `timeoutMs`.
 * The result reports every attempt so the caller can record them like health checks (the same consecutive-failure
 * threshold decides "down"). socks5 proxies have no active probe (see probe()): they pass and the launch itself decides.
 */
export async function preflightProxy(opts: { server: string; username?: string; password?: string }, checkUrl: string, attempts: number, timeoutMs: number): Promise<{ ok: boolean; attempts: { ok: boolean; error?: string }[]; probed: boolean }> {
  let proxy: URL;
  try { proxy = new URL(opts.server); } catch { return { ok: false, attempts: [{ ok: false, error: 'bad proxy url' }], probed: false }; }
  if (proxy.protocol.startsWith('socks')) return { ok: true, attempts: [], probed: false };
  const results: { ok: boolean; error?: string }[] = [];
  for (let i = 0; i < Math.max(1, attempts); i++) {
    const r = await probe(opts, checkUrl, timeoutMs);
    results.push(r);
    if (r.ok) return { ok: true, attempts: results, probed: true };
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 1000));
  }
  return { ok: false, attempts: results, probed: true };
}
