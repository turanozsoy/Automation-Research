import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { BrowserManager } from '../browser/manager.js';
import type { SiteBConfig } from '../config.js';
import { importProfile, type ImportRequest } from './import.js';
import type { ProfileStore } from './store.js';
import type { Timeline } from '../timeline.js';

/**
 * Watched "drop folder" for the manual route: put an exported session JSON into
 * <dataDir>/inbox/ and it is imported. The plaintext file is deleted after a
 * successful import (the database holds it encrypted); failures move to inbox/failed/.
 *
 * A file may be either:
 *   - a full import request {label, accountKey, storageState}
 *   - a bare storageState / cookie array, in which case the file name (minus .json)
 *     is used as both the label and the account key.
 */
export class ProfileInbox {
  private dir: string;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(dataDir: string, private store: ProfileStore, private browser: BrowserManager, private cfg: SiteBConfig, private tl: Timeline) {
    this.dir = join(dataDir, 'inbox');
    for (const d of [this.dir, join(this.dir, 'failed')]) mkdirSync(d, { recursive: true });
  }

  path(): string { return this.dir; }

  start(pollMs = 2000): void {
    this.timer = setInterval(() => void this.scan(), pollMs);
    void this.scan();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const files = existsSync(this.dir)
        ? readdirSync(this.dir).filter((f) => extname(f).toLowerCase() === '.json')
        : [];
      for (const f of files) await this.ingest(join(this.dir, f));
    } finally {
      this.busy = false;
    }
  }

  private async ingest(file: string): Promise<void> {
    const name = basename(file, '.json');
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const req: ImportRequest = raw && raw.storageState
        ? { label: raw.label ?? name, accountKey: raw.accountKey ?? raw.label ?? name, storageState: raw.storageState }
        : { label: name, accountKey: name, storageState: raw };
      const result = await importProfile(req, this.store, this.browser, this.cfg);
      this.tl.mark('profile imported from inbox', `${basename(file)} → ${result.label}: ${result.action}, ${result.detail}`);
      try { unlinkSync(file); } catch { /* next scan would re-import; harmless (reseed) */ }
    } catch (e) {
      this.tl.mark('inbox import failed', `${basename(file)}: ${e instanceof Error ? e.message : String(e)}`);
      this.moveToFailed(file);
    }
  }

  private moveToFailed(file: string): void {
    const dest = join(this.dir, 'failed', `${Date.now()}-${basename(file)}`);
    try { renameSync(file, dest); } catch { /* leave it; next scan may retry */ }
  }
}
