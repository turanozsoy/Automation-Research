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
/** Page-side scan as a source string (kept out of the TS compiler's helper wrappers). */
function scanScript(prefix: string, pattern: string): string {
  return `(() => {
    const prefix = ${JSON.stringify(prefix)};
    // Unanchored copy for searching inside text/values; the caller re-validates the match against the strict pattern.
    const re = new RegExp(${JSON.stringify(pattern)}.replace(/^\\^/, '').replace(/\\$$/, ''));
    const walk = (root, out) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); } return out; };
    const all = walk(document, []);
    for (const a of all) if (a.tagName === 'A' && typeof a.href === 'string' && a.href.startsWith(prefix) && re.test(a.href)) return { url: a.href, source: 'anchor-href' };
    for (const el of all) {
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.value === 'string' && el.value.includes(prefix)) {
        const m = el.value.match(re); if (m) return { url: m[0], source: 'input-value' };
      }
      for (const attr of ['data-url', 'data-href', 'data-link', 'value', 'title']) {
        const v = el.getAttribute && el.getAttribute(attr); if (v && v.includes(prefix)) { const m = v.match(re); if (m) return { url: m[0], source: 'attribute:' + attr }; }
      }
    }
    const text = document.body ? document.body.innerText : '';
    if (text && text.includes(prefix)) { const m = text.match(re); if (m) return { url: m[0], source: 'visible-text' }; }
    for (const el of all) { if (el.shadowRoot) { const t = el.shadowRoot.textContent || ''; if (t.includes(prefix)) { const m = t.match(re); if (m) return { url: m[0], source: 'shadow-text' }; } } }
    return null;
  })()`;
}

function diagScript(host: string): string {
  return `(() => {
    const host = ${JSON.stringify(host)};
    const walk = (root, out) => { for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); } return out; };
    const all = walk(document, []);
    const links = all.filter((a) => a.tagName === 'A' && typeof a.href === 'string' && host && a.href.includes(host)).map((a) => a.href).slice(0, 5);
    const iframes = all.filter((el) => el.tagName === 'IFRAME').map((el) => el.getAttribute('src') || '(no src)').slice(0, 5);
    const text = document.body ? document.body.innerText : '';
    const textHits = host && text.includes(host) ? text.split('\\n').filter((l) => l.includes(host)).slice(0, 3).map((l) => l.trim().slice(0, 120)) : [];
    const imgs = all.filter((el) => el.tagName === 'IMG' || el.tagName === 'CANVAS' || el.tagName === 'SVG').length;
    return 'links=' + JSON.stringify(links) + ' iframes=' + JSON.stringify(iframes) + ' textLines=' + JSON.stringify(textHits) + ' images/canvas/svg=' + imgs + ' title="' + (document.title || '') + '"';
  })()`;
}

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
        void this.diagnostics().then((d) => {
          this.disarm();
          reject(new AutomationError('URL_TIMEOUT', `No URL matching ${this.cfg.generatedUrl.pattern} within ${timeout} ms. ${d}`));
        });
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

  /** What the pages look like when capture times out: frame URLs, links on the target host, text mentions. */
  private async diagnostics(): Promise<string> {
    let host = '';
    try { host = new URL(this.cfg.generatedUrl.prefix).host; } catch { /* keep empty */ }
    const parts: string[] = [];
    for (const p of this.pages) {
      if (p.isClosed()) continue;
      for (const f of p.frames()) {
        try {
          const d = await f.evaluate<string>(diagScript(host));
          parts.push(`[frame ${f.url() || 'about:blank'}] ${d}`);
        } catch { parts.push(`[frame ${f.url() || 'about:blank'}] (not readable)`); }
      }
    }
    return `Diagnostics: ${parts.join(' || ')}`;
  }

  /** Look at current frame URLs, anchors, text and input values in every open page. */
  private async scan(): Promise<void> {
    if (!this.armed) return;
    const prefix = this.cfg.generatedUrl.prefix;
    for (const p of this.pages) {
      if (p.isClosed()) continue;
      for (const f of p.frames()) {
        if (!this.armed) return;
        this.consider(f.url(), 'frame-url');
        try {
          const found = await f.evaluate<{ url: string; source: string } | null>(scanScript(prefix, this.cfg.generatedUrl.pattern));
          if (found) this.consider(found.url, found.source);
        } catch { /* frame navigated away or detached during evaluate */ }
      }
    }
  }
}
