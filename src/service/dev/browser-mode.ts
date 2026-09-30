import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserManager, BrowserMode } from '../browser/manager.js';
import type { Settings } from '../settings.js';
import type { Timeline } from '../timeline.js';
import type { WorkflowRegistry } from '../workflows.js';

export interface BrowserModeStatus {
  mode: BrowserMode;
  chromium: 'running' | 'restarting' | 'stopped';
  activeWorkflows: number;
  /** A requested mode waiting for active workflows to finish. */
  pendingMode: BrowserMode | null;
  message: string;
}

/**
 * Development-only control of the automation browser's launch mode (visible / headless).
 * Playwright picks headless when Chromium starts, so a switch means closing the idle process and
 * launching a new one; with workflows active the request is kept and applied once they finish.
 * The preference is persisted in a small file under DATA_DIR (never in application data).
 */
export class BrowserModeControl {
  private pending: BrowserMode | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastMessage = '';

  constructor(private settings: Settings, private browser: BrowserManager, private registry: WorkflowRegistry, private tl: Timeline) {}

  /** Mode to launch with: the persisted preference, else HEADLESS=1, else visible. */
  initialMode(): BrowserMode {
    const saved = this.readSaved();
    if (saved) { this.tl.mark('browser mode preference', `${saved} (from ${this.settings.devSettingsPath})`); return saved; }
    return this.settings.headless ? 'headless' : 'visible';
  }

  status(): BrowserModeStatus {
    const active = this.registry.activeCount();
    const restarting = this.browser.isRestarting();
    const mode = this.browser.mode();
    const message = restarting ? 'Restarting Chromium…'
      : this.pending ? `Will switch to ${this.pending} after ${active} active workflow(s) finish`
      : this.lastMessage || `${mode === 'headless' ? 'Headless' : 'Visible'} ready`;
    return { mode, chromium: restarting ? 'restarting' : this.browser.isAlive() ? 'running' : 'stopped', activeWorkflows: active, pendingMode: this.pending, message };
  }

  /** Ask for a mode. Switches now when idle, otherwise after the active workflows finish. */
  async request(mode: BrowserMode): Promise<BrowserModeStatus> {
    if (mode !== 'visible' && mode !== 'headless') throw new Error('mode must be visible or headless');
    this.save(mode);
    if (this.browser.mode() === mode && !this.browser.isRestarting()) { this.pending = null; this.lastMessage = `${mode === 'headless' ? 'Headless' : 'Visible'} ready`; return this.status(); }
    if (this.registry.activeCount() > 0 || this.browser.isRestarting()) {
      this.pending = mode;
      this.tl.mark('browser mode switch deferred', `${mode} after ${this.registry.activeCount()} active workflow(s)`);
      this.armWatcher();
      return this.status();
    }
    await this.switchNow(mode);
    return this.status();
  }

  private async switchNow(mode: BrowserMode): Promise<void> {
    this.pending = null;
    try {
      await this.browser.restart(mode);
      this.lastMessage = `${mode === 'headless' ? 'Headless' : 'Visible'} ready`;
      this.tl.mark('browser mode switched', `${mode} ready`);
    } catch (e) {
      this.lastMessage = `Switch failed: ${e instanceof Error ? e.message : String(e)}`;
      this.tl.mark('browser mode switch failed', this.lastMessage);
    }
  }

  private armWatcher(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.pending) { clearInterval(this.timer!); this.timer = null; return; }
      if (this.registry.activeCount() === 0 && !this.browser.isRestarting()) {
        const mode = this.pending;
        clearInterval(this.timer!); this.timer = null;
        void this.switchNow(mode);
      }
    }, 2000);
  }

  private readSaved(): BrowserMode | null {
    try {
      if (!existsSync(this.settings.devSettingsPath)) return null;
      const j = JSON.parse(readFileSync(this.settings.devSettingsPath, 'utf8'));
      return j.browserMode === 'headless' || j.browserMode === 'visible' ? j.browserMode : null;
    } catch { return null; }
  }

  private save(mode: BrowserMode): void {
    try {
      mkdirSync(dirname(this.settings.devSettingsPath), { recursive: true });
      let current: Record<string, unknown> = {};
      try { current = JSON.parse(readFileSync(this.settings.devSettingsPath, 'utf8')); } catch { current = {}; }
      writeFileSync(this.settings.devSettingsPath, JSON.stringify({ ...current, browserMode: mode }, null, 2));
    } catch (e) {
      this.tl.mark('could not persist browser mode preference', e instanceof Error ? e.message : String(e));
    }
  }
}
