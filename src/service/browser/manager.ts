import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Settings } from '../settings.js';
import type { Timeline } from '../timeline.js';

export interface ContextBundle { context: BrowserContext; page: Page }

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

  constructor(private settings: Settings, private tl: Timeline) {}

  async launch(): Promise<void> {
    const { headless, chromiumPath } = this.settings;
    this.browser = await chromium.launch({
      headless,
      executablePath: chromiumPath,
      args: headless ? [] : ['--window-size=1280,900', '--window-position=40,40'],
    });
    this.browser.on('disconnected', () => {
      this.tl.mark('Chromium disconnected');
      this.contexts.clear();
      this.browser = null;
      this.onDisconnect?.();
    });
    this.tl.mark('Chromium launched', headless ? 'headless' : 'visible');
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

  /** New isolated context for a workflow, seeded with the profile's storageState (JSON string). */
  async createContext(workflowId: string, storageStateJson: string): Promise<ContextBundle> {
    if (!this.browser) throw new Error('browser not running');
    const storageState = JSON.parse(storageStateJson);
    const context = await this.browser.newContext({
      storageState,
      viewport: this.settings.headless ? { width: 1280, height: 900 } : null,
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
    const b = this.contexts.get(workflowId);
    this.contexts.delete(workflowId);
    if (b) await b.context.close().catch(() => {});
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.contexts.clear();
  }
}
