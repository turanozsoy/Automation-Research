import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../settings.js';
import type { Timeline } from '../timeline.js';

export interface ContextBundle { context: BrowserContext; page: Page }
export type BrowserMode = 'visible' | 'headless';

/** Page-side: the document's HTML with anything that could hold applicant input or secrets removed. */
const SANITIZED_HTML = `(() => {
  const doc = document.documentElement.cloneNode(true);
  for (const el of doc.querySelectorAll('script, style, link[rel="stylesheet"]')) el.remove();
  for (const el of doc.querySelectorAll('input, textarea, select')) {
    for (const a of [...el.attributes]) if (!['id','name','type','placeholder','class','aria-label','aria-invalid','required','disabled'].includes(a.name) && !a.name.startsWith('aria-')) el.removeAttribute(a.name);
    if (el.tagName === 'TEXTAREA') el.textContent = '';
  }
  for (const el of doc.querySelectorAll('*')) for (const a of [...el.attributes]) if (a.name.startsWith('data-') && a.name !== 'data-accent-color' && a.name !== 'data-variant') el.removeAttribute(a.name);
  return '<!doctype html>' + doc.outerHTML;
})()`;

/**
 * One Chromium process, one isolated BrowserContext per workflow. Each context is
 * created from a profile's decrypted storageState, so cookies/localStorage never
 * cross between workflows. Process sharding and a warm pool come in a later phase;
 * this class is the seam where they plug in.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private contexts = new Map<string, ContextBundle>();
  private onDisconnect: (() => void) | null = null;
  private headless: boolean;
  /** Launch with Playwright's 'per-context' proxy placeholder (needed on Windows for per-context proxies; contexts without a proxy cannot work then). */
  private perContextProxy = false;
  private restarting = false;
  private closingIntentionally = false;
  private captures = new Map<string, Promise<void>>();
  private lastCapture = new Map<string, number>();

  constructor(private settings: Settings, private tl: Timeline) {
    this.headless = settings.headless;
  }

  mode(): BrowserMode { return this.headless ? 'headless' : 'visible'; }
  isRestarting(): boolean { return this.restarting; }
  /** Only before launch() / restart(): the mode the next Chromium process uses. */
  setMode(mode: BrowserMode): void { this.headless = mode === 'headless'; }
  /** Only before launch() / restart(). */
  setPerContextProxy(v: boolean): void { this.perContextProxy = v; }
  isPerContextProxy(): boolean { return this.perContextProxy; }

  async launch(): Promise<void> {
    const { chromiumPath } = this.settings;
    const headless = this.headless;
    const browser = await chromium.launch({
      headless,
      executablePath: chromiumPath,
      args: headless ? [] : ['--window-size=1280,900', '--window-position=40,40'],
      // The service's own shutdown ends workflows, exports their sessions, then closes Chromium.
      // Playwright's default signal handlers would kill Chromium the instant SIGTERM/SIGINT arrives.
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      // Linux/macOS: per-context proxies work with a plain launch and no-proxy contexts go direct. Windows needs the
      // placeholder, under which EVERY context must carry a proxy (the 'direct' egress is then unavailable).
      proxy: this.perContextProxy ? { server: 'per-context' } : undefined,
    });
    this.browser = browser;
    browser.on('disconnected', () => {
      if (this.browser !== browser && this.closingIntentionally) return; // replaced on purpose (mode switch)
      this.tl.mark('Chromium disconnected');
      this.contexts.clear();
      this.browser = null;
      this.onDisconnect?.();
    });
    this.tl.mark('Chromium launched', `${headless ? 'headless' : 'visible'}${this.perContextProxy ? ', per-context proxy mode' : ''}`);
  }

  /**
   * Development: relaunch Chromium in another mode. Playwright picks headless at launch, so the
   * idle process is closed and a new one started; refused while any context is live.
   */
  async restart(mode: BrowserMode): Promise<void> {
    if (this.contexts.size > 0) throw new Error(`cannot restart Chromium with ${this.contexts.size} live context(s)`);
    if (this.restarting) throw new Error('restart already in progress');
    this.restarting = true;
    this.closingIntentionally = true;
    const old = this.browser;
    try {
      this.browser = null;
      if (old) await old.close().catch(() => {});
      this.headless = mode === 'headless';
      this.tl.mark('Chromium restarting', `switching to ${mode}`);
      await this.launch();
    } finally {
      this.closingIntentionally = false;
      this.restarting = false;
    }
  }

  /**
   * Development: what Chromium rendered when a step failed. Screenshots of every page in the
   * workflow's context, a sanitized HTML snapshot (no input values, no data-* attributes, no
   * scripts) and a JSON with stage, code, message, URLs, frame count and browser mode. Never
   * cookies, storage or field values. closeContext waits for a capture in flight.
   */
  captureFailure(workflowId: string, stage: string, code: string, message: string): void {
    const dir = this.settings.failureArtifactsDir;
    const b = this.contexts.get(workflowId);
    if (!dir || !b) return;
    // A pause followed by an abort reports the same failure twice: keep the first capture.
    const last = this.lastCapture.get(workflowId) ?? 0;
    if (Date.now() - last < 5000) return;
    this.lastCapture.set(workflowId, Date.now());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${stamp}-${workflowId.slice(0, 8)}-${stage.replace(/[^a-z0-9_-]/gi, '_').slice(0, 30)}`;
    const run = (async () => {
      try {
        mkdirSync(dir, { recursive: true });
        const pages = b.context.pages().filter((p) => !p.isClosed());
        const shots: string[] = [];
        for (const [i, page] of pages.entries()) {
          const file = join(dir, `${base}${i ? '-page' + i : ''}.png`);
          await page.screenshot({ path: file, fullPage: true, timeout: 5000 }).then(() => shots.push(file)).catch(() => {});
        }
        const page = pages[0];
        let html = '';
        if (page) html = await page.evaluate(SANITIZED_HTML).catch(() => '') as string;
        if (html) writeFileSync(join(dir, `${base}.html`), html);
        const info = {
          at: new Date().toISOString(), workflowId, stage, code, message: message.slice(0, 1000), browserMode: this.mode(),
          pages: pages.map((p) => ({ url: p.url(), frames: p.frames().length, frameUrls: p.frames().map((f) => f.url()) })),
          screenshots: shots, html: html ? `${base}.html` : null,
        };
        writeFileSync(join(dir, `${base}.json`), JSON.stringify(info, null, 2));
        this.tl.mark('failure artifacts saved', `${this.mode()} · ${base}.{png,html,json} in ${dir}`);
      } catch (e) {
        this.tl.mark('failure artifacts not saved', e instanceof Error ? e.message.split('\n')[0] : String(e));
      }
    })();
    this.captures.set(workflowId, run.finally(() => { if (this.captures.get(workflowId) === run) this.captures.delete(workflowId); }));
  }

  setDisconnectHandler(fn: () => void): void {
    this.onDisconnect = fn;
  }

  isAlive(): boolean {
    return !!this.browser && this.browser.isConnected();
  }

  liveContexts(): number {
    return this.contexts.size;
  }

  /** New isolated context for a workflow, seeded with the profile's storageState (JSON string) and, for a proxy egress, its proxy. */
  async createContext(workflowId: string, storageStateJson: string, proxy?: { server: string; username?: string; password?: string } | null): Promise<ContextBundle> {
    if (!this.browser) throw new Error('browser not running');
    const storageState = JSON.parse(storageStateJson);
    const context = await this.browser.newContext({
      storageState,
      viewport: this.headless ? { width: 1280, height: 900 } : null,
      proxy: proxy ?? undefined,
    });
    const page = await context.newPage();
    const bundle = { context, page };
    this.contexts.set(workflowId, bundle);
    return bundle;
  }

  /** Export the context's current storageState (to refresh the profile after a successful run). */
  async exportStorageState(workflowId: string): Promise<string | null> {
    const b = this.contexts.get(workflowId);
    if (!b) return null;
    try {
      return JSON.stringify(await b.context.storageState());
    } catch {
      return null;
    }
  }

  async closeContext(workflowId: string): Promise<void> {
    const pending = this.captures.get(workflowId);
    if (pending) await Promise.race([pending, new Promise((r) => setTimeout(r, 8000))]);
    const b = this.contexts.get(workflowId);
    this.contexts.delete(workflowId);
    this.lastCapture.delete(workflowId);
    if (b) await b.context.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.closingIntentionally = true;
    const b = this.browser;
    this.browser = null; // the 'disconnected' handler sees a replaced browser and stays quiet
    await b?.close().catch(() => {});
    this.contexts.clear();
  }
}
