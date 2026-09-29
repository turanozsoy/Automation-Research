import type { BrowserContext, Frame, Page, Request } from 'playwright';
import type { SiteBConfig } from './config.js';
import { AutomationError, type Timeline } from './timeline.js';

export interface CapturedUrl { url: string; source: string }

/**
 * Watches every place a generated URL could surface without touching Website B's
 * internal APIs:
 *   1. any frame navigating to it (framenavigated)
 *   2. a newly attached iframe pointing at it
 *   3. top-level navigation
 *   4. a popup / new tab
 *   5. a visible anchor whose href matches (light poll across frames)
 *   6. (optional) the navigation *request* for it, which fires before the response
 *      arrives. Only navigation requests are inspected, never API traffic.
 * First match wins.
 */
export class UrlCapture {
  private armed = false;
  private captured: CapturedUrl | null = null;
  private resolveFn: ((v: CapturedUrl) => void) | null = null;
  private pattern: RegExp;
  private pollTimer: NodeJS.Timeout | null = null;
  private pages = new Set<Page>();

  constructor(private page: Page, private context: BrowserContext, private cfg: SiteBConfig, private tl: Timeline) {
    this.pattern = new RegExp(cfg.generatedUrl.pattern);
  }

  private onFrameNav = (f: Frame) => this.consider(f.url(), 'frame-navigation');
  private onFrameAttached = (f: Frame) => this.consider(f.url(), 'iframe-attached');
  private onRequest = (r: Request) => { if (r.isNavigationRequest()) this.consider(r.url(), 'navigation-request'); };
  private onPopup = (p: Page) => {
    this.pages.add(p);
    this.consider(p.url(), 'popup');
    p.on('framenavigated', (f) => this.consider(f.url(), 'popup-navigation'));
    if (this.cfg.generatedUrl.watchNavigationRequests) p.on('request', this.onRequest);
  };

  /** Start listening. Safe to call before the actions that trigger the URL. */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.captured = null;
    this.pages.add(this.page);
    this.page.on('framenavigated', this.onFrameNav);
    this.page.on('frameattached', this.onFrameAttached);
    if (this.cfg.generatedUrl.watchNavigationRequests) this.page.on('request', this.onRequest);
    this.context.on('page', this.onPopup);
    this.pollTimer = setInterval(() => void this.scan(), this.cfg.generatedUrl.anchorPollMs);
    this.tl.mark('url capture armed', `prefix=${this.cfg.generatedUrl.prefix}`);
  }

  /** Resolve with the first matching URL, or reject with URL_TIMEOUT. */
  wait(timeout: number): Promise<CapturedUrl> {
    if (this.captured) {
      const v = this.captured;
      this.disarm();
      return Promise.resolve(v);
    }
    return new Promise<CapturedUrl>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.disarm();
        reject(new AutomationError('URL_TIMEOUT', `No URL matching ${this.cfg.generatedUrl.pattern} within ${timeout} ms`));
      }, timeout);
      this.resolveFn = (v) => {
        clearTimeout(timer);
        this.disarm();
        resolve(v);
      };
      void this.scan();
    });
  }

  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.page.off('framenavigated', this.onFrameNav);
    this.page.off('frameattached', this.onFrameAttached);
    this.page.off('request', this.onRequest);
    this.context.off('page', this.onPopup);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.resolveFn = null;
    this.captured = null;
  }

  private consider(url: string, source: string): void {
    if (!this.armed || !url) return;
    if (url.startsWith(this.cfg.generatedUrl.prefix) && this.pattern.test(url)) {
      if (this.captured) return;
      this.captured = { url, source };
      const fn = this.resolveFn;
      if (fn) fn({ url, source });
      else this.tl.mark('generated URL seen while no step was waiting for it', `${source}: ${url}`);
    }
  }

  /** Look at current frame URLs and visible anchors in every open page. */
  private async scan(): Promise<void> {
    if (!this.armed) return;
    const prefix = this.cfg.generatedUrl.prefix;
    for (const p of this.pages) {
      if (p.isClosed()) continue;
      for (const f of p.frames()) {
        if (!this.armed) return;
        this.consider(f.url(), 'frame-url');
        try {
          const href = await f.evaluate((pre: string) => {
            const a = document.querySelector<HTMLAnchorElement>(`a[href^="${pre}"]`);
            return a ? a.href : null;
          }, prefix);
          if (href) this.consider(href, 'anchor-href');
        } catch { /* frame navigated away or detached during evaluate */ }
      }
    }
  }
}
