import type { Frame } from 'playwright';
import type { ErrorCode, FieldUpdateMsg, ServerMsg, WorkflowState } from '../shared/messages.js';
import type { BrowserBundle } from './browser.js';
import { isLoginUrl, type SiteBConfig } from './config.js';
import { SiteB } from './site-b.js';
import { AutomationError, type Timeline } from './timeline.js';
import { UrlCapture } from './url-capture.js';

interface PendingUpdate { value: string; seq: number; sentAt: number; receivedAt: number }

/**
 * Phase 1: exactly one workflow bound to the one open page. Holds the latest
 * snapshot, coalesces field updates per field, and runs the submit sequence.
 * Later phases wrap this in a per-workflow runtime with its own context.
 */
export class Workflow {
  state: WorkflowState = 'booting';
  private snapshot = new Map<string, string>();
  private pending = new Map<string, PendingUpdate>();
  private drainPromise: Promise<void> | null = null;
  private siteB: SiteB;
  private capture: UrlCapture;
  private send: (msg: ServerMsg) => void = () => {};
  private lastLoginWarnUrl: string | null = null;

  constructor(private bundle: BrowserBundle, private cfg: SiteBConfig, private tl: Timeline) {
    this.siteB = new SiteB(bundle.page, cfg, tl);
    this.capture = new UrlCapture(bundle.page, bundle.context, cfg, tl);
    this.watchBrowser();
  }

  setSender(fn: (msg: ServerMsg) => void): void {
    this.send = fn;
  }

  fieldNames(): string[] {
    return Object.keys(this.cfg.fields);
  }

  writeOnlyFields(): string[] {
    return Object.keys(this.cfg.fields).filter((n) => this.cfg.fields[n].writeOnly);
  }

  deferredFields(): string[] {
    return Object.keys(this.cfg.fields).filter((n) => this.cfg.fields[n].syncMode === 'deferred');
  }

  /** Value as it may appear in logs. */
  private loggable(field: string, value: string): string {
    return this.cfg.fields[field]?.writeOnly ? '(masked)' : `"${value}"`;
  }

  // ---------- lifecycle ----------

  async boot(): Promise<void> {
    this.setState('booting', 'opening Website B');
    try {
      await this.siteB.openTarget();
      this.tl.mark('Website B opened', this.siteB.currentUrl());
    } catch (e) {
      this.tl.mark('Website B did not finish loading', msg(e));
    }
    this.warnIfLoginPage(this.siteB.currentUrl());
    this.setState('awaiting_user', 'log in / navigate manually in Chromium, then press Start');
  }

  async start(): Promise<void> {
    if (this.state !== 'awaiting_user') {
      this.emitError('INVALID_STATE', `Start is only allowed in awaiting_user (current: ${this.state})`, false);
      return;
    }
    const url = this.siteB.currentUrl();
    if (isLoginUrl(this.cfg, url)) {
      this.emitError('LOGIN_REQUIRED', `Still on the login page (${url}). Log in first, then press Start again.`, false);
      return;
    }
    this.setState('starting');
    this.tl.mark('start requested', url);
    try {
      await this.siteB.clickRecommended();
      this.tl.mark('Recommended clicked');
      await this.siteB.resolveFields();
      this.setState('ready', 'field sync active');
      this.tl.mark('READY', `${this.pending.size} buffered update(s) to apply`);
      void this.drain();
    } catch (e) {
      // Recoverable: the user can fix the page in Chromium and press Start again.
      const ae = toAutomationError(e);
      this.tl.mark(`start failed: ${ae.code}`, ae.message);
      this.emitError(ae.code, ae.message, false);
      this.setState('awaiting_user', 'start failed, fix the page and press Start again');
    }
  }

  handleFieldUpdate(m: FieldUpdateMsg): void {
    const receivedAt = this.tl.mark(`update received: ${m.field}`, `${this.loggable(m.field, m.value)} seq=${m.seq}`);
    if (!(m.field in this.cfg.fields)) {
      this.send({ type: 'field.error', ts: Date.now(), field: m.field, seq: m.seq, code: 'UNKNOWN_FIELD', message: `No mapping for "${m.field}" in config` });
      return;
    }
    if (this.state === 'submitting' || this.state === 'completed' || this.state === 'failed') {
      this.send({ type: 'field.error', ts: Date.now(), field: m.field, seq: m.seq, code: 'INVALID_STATE', message: `Field updates are not accepted in state ${this.state}` });
      return;
    }
    this.snapshot.set(m.field, m.value);
    if (this.cfg.fields[m.field].syncMode === 'deferred') {
      // Kept in the snapshot only; applied during the final submit sequence (e.g. address autocomplete).
      this.tl.mark(`${m.field} saved locally, applied at submit`);
      this.send({ type: 'field.deferred', ts: Date.now(), field: m.field, seq: m.seq });
      return;
    }
    // Coalesce: a newer value for the same field replaces the older pending one.
    this.pending.set(m.field, { value: m.value, seq: m.seq, sentAt: m.ts, receivedAt });
    void this.drain();
  }

  /** Apply pending updates one field at a time. Only one drain runs at a time; new updates are picked up by the running loop. */
  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    if (this.state !== 'ready' || this.pending.size === 0) return Promise.resolve();
    // .finally runs asynchronously, so the assignment below always happens before the reset.
    this.drainPromise = this.runDrain().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    while (this.pending.size > 0 && this.state === 'ready') {
      const [field, upd] = this.pending.entries().next().value as [string, PendingUpdate];
      this.pending.delete(field);
      try {
        const startedAt = Date.now();
        const actual = await this.siteB.setField(field, upd.value);
        const filledAt = this.cfg.fields[field].writeOnly
          ? this.tl.mark(`${field} updated (masked by Website B)`)
          : this.tl.mark(`Website B ${field} updated`, `"${actual}"`);
        this.send({ type: 'field.ack', ts: filledAt, field, seq: upd.seq, sentAt: upd.sentAt, receivedAt: upd.receivedAt, startedAt, filledAt, value: actual });
      } catch (e) {
        const ae = toAutomationError(e);
        if (ae.code === 'FIELD_NOT_FOUND' && !this.cfg.fields[field].requiredAtStart) {
          // Not on the page until a later step (e.g. state after the address is accepted); reconciled at submit.
          this.tl.mark(`${field} not on page yet, applied after address is accepted`);
          this.send({ type: 'field.deferred', ts: Date.now(), field, seq: upd.seq });
          continue;
        }
        this.tl.mark(`field update failed: ${field}`, ae.message);
        this.send({ type: 'field.error', ts: Date.now(), field, seq: upd.seq, code: ae.code, message: ae.message });
      }
    }
  }

  async submit(snapshot: Record<string, string>, requestedAt: number): Promise<void> {
    if (this.state !== 'ready') {
      this.emitError('INVALID_STATE', `Submit is only allowed in ready (current: ${this.state})`, false);
      return;
    }
    this.setState('submitting');
    this.tl.mark('submit received', `${Object.keys(snapshot).length} fields in snapshot, ${Date.now() - requestedAt} ms after request`);

    // The snapshot supersedes anything still queued.
    for (const [k, v] of Object.entries(snapshot)) this.snapshot.set(k, v);
    this.pending.clear();
    if (this.drainPromise) await this.drainPromise; // let an in-flight fill finish

    try {
      await this.finalReconciliation(snapshot);

      this.capture.arm();

      await this.siteB.clickLastSubmit();
      this.tl.mark('Website B submit clicked');

      if (this.cfg.checkout.agreeButton) {
        const agreeFrame = await this.siteB.findFrameWith(this.cfg.checkout.agreeButton, this.cfg.timeouts.checkoutStep, 'AGREE_NOT_FOUND');
        await this.siteB.clickInFrame(agreeFrame, this.cfg.checkout.agreeButton, 'AGREE_NOT_FOUND');
        this.tl.mark('Agree and continue clicked');
      }

      let frame = await this.siteB.findFrameWith(this.cfg.checkout.toggle, this.cfg.timeouts.iframe, 'IFRAME_NOT_FOUND');
      this.tl.mark('iframe detected', frame.url());

      const toggle = await this.siteB.ensureToggleOff(frame);
      this.tl.mark(toggle === 'unchecked' ? 'checkbox unchecked' : 'checkbox already unchecked');

      frame = await this.siteB.findFrameWith(this.cfg.checkout.primaryButton, this.cfg.timeouts.checkoutStep, 'PRIMARY_NOT_FOUND');
      this.tl.mark('primary available');
      const secondaryVisibleBefore = await frame.locator(this.cfg.checkout.secondaryButton).filter({ visible: true }).count().catch(() => 0);
      await this.siteB.clickInFrame(frame, this.cfg.checkout.primaryButton, 'PRIMARY_NOT_FOUND');
      this.tl.mark('primary clicked');

      if (secondaryVisibleBefore > 0) {
        // A secondary button already existed in this state; make sure we wait for the NEXT state before clicking one.
        const changed = await this.waitForStateChange(frame, this.cfg.checkout.primaryButton, this.cfg.timeouts.checkoutStep);
        this.tl.mark(changed ? 'checkout state changed after primary' : 'no state change detected after primary, continuing');
      }

      frame = await this.siteB.findFrameWith(this.cfg.checkout.secondaryButton, this.cfg.timeouts.checkoutStep, 'SECONDARY_NOT_FOUND');
      this.tl.mark('secondary available');
      await this.siteB.clickInFrame(frame, this.cfg.checkout.secondaryButton, 'SECONDARY_NOT_FOUND');
      this.tl.mark('secondary clicked');

      const { url, source } = await this.capture.wait(this.cfg.timeouts.generatedUrl);
      const detectedAt = this.tl.mark('generated URL detected', `${source}: ${url}`);
      this.send({ type: 'result', ts: detectedAt, url, source, submitRequestedAt: requestedAt });
      this.tl.mark('URL sent to Website A', `${Date.now() - requestedAt} ms after submit requested`);
      this.setState('completed', url);
    } catch (e) {
      this.capture.disarm();
      this.fail(e);
    }
  }

  async reset(): Promise<void> {
    this.capture.disarm();
    this.pending.clear();
    this.snapshot.clear();
    if (this.bundle.page.isClosed()) {
      this.emitError('BROWSER_CLOSED', 'The page is closed. Restart the service.', true);
      return;
    }
    this.tl.mark('reset requested');
    await this.boot();
  }

  /**
   * Final sequence before the submit click:
   *   ordinary live fields → write-only check → deferred fields (address1) → done.
   * The caller clicks Website B's submit button immediately afterwards.
   */
  private async finalReconciliation(snapshot: Record<string, string>): Promise<void> {
    this.tl.mark('final reconciliation started');

    // 1. Ordinary live fields (state/city/zip included). Write-only and deferred fields are excluded here.
    const corrected = await this.siteB.reconcile(snapshot);
    this.tl.mark('ordinary fields reconciled', corrected.length ? `corrected: ${corrected.join(', ')}` : 'all in sync');

    // 2. Write-only fields: fill only if empty, otherwise validate without reading the value back.
    for (const name of this.writeOnlyFields()) {
      const r = await this.siteB.finaliseWriteOnly(name, snapshot[name] ?? this.snapshot.get(name) ?? '');
      this.tl.mark(r === 'filled' ? `${name} updated (masked)` : r === 'verified' ? `${name} verified (masked, not compared)` : `${name} empty in snapshot, skipped`);
    }

    // 3. Address autocomplete driven by keyboard (type search string, ArrowDown, Enter), then the
    //    fields it reveals/populates are reconciled against Website A's snapshot.
    const as = this.cfg.addressSearch;
    if (as) {
      this.tl.mark('address autocomplete started');
      await this.siteB.acceptAddressViaAutocomplete(snapshot);
      if (as.dependentFields.length) {
        const fixed = await this.siteB.reconcile(snapshot, as.dependentFields);
        this.tl.mark(`${as.dependentFields.join('/')} reconciled after address`, fixed.length ? `corrected: ${fixed.join(', ')}` : 'all in sync');
      }
    }

    // 4. Any other deferred field: set once, last. Fields consumed by the address search string are never filled individually.
    for (const name of this.deferredFields()) {
      if (as && (name === as.field || as.order.includes(name))) continue;
      const value = snapshot[name] ?? this.snapshot.get(name) ?? '';
      if (value.trim() === '') {
        this.tl.mark(`${name} empty in snapshot, skipped`);
        continue;
      }
      const actual = await this.siteB.setField(name, value);
      this.tl.mark(`${name} filled`, `"${actual}"`);
    }

    this.tl.mark('final reconciliation complete');
  }

  // ---------- helpers ----------

  /** Resolve true when the primary button disappears or the frame navigates/detaches; false on timeout. */
  private waitForStateChange(frame: Frame, primarySelector: string, timeout: number): Promise<boolean> {
    const page = this.bundle.page;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        page.off('framenavigated', onNav);
        page.off('framedetached', onNav);
        resolve(v);
      };
      const onNav = (f: Frame) => { if (f === frame) finish(true); };
      const timer = setTimeout(() => finish(false), timeout);
      page.on('framenavigated', onNav);
      page.on('framedetached', onNav);
      frame.locator(primarySelector).first().waitFor({ state: 'hidden', timeout }).then(() => finish(true), () => finish(true));
    });
  }

  private watchBrowser(): void {
    const { page, browser } = this.bundle;
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      const url = f.url();
      if (!isLoginUrl(this.cfg, url)) return;
      if (this.state === 'awaiting_user' || this.state === 'booting') {
        this.warnIfLoginPage(url);
      } else if (this.state !== 'failed' && this.state !== 'completed') {
        this.fail(new AutomationError('LOGIN_REQUIRED', `Session lost: Website B redirected to ${url} during ${this.state}`));
      }
    });
    page.on('close', () => this.onBrowserGone('page closed'));
    browser.on('disconnected', () => this.onBrowserGone('browser disconnected'));
  }

  private warnIfLoginPage(url: string): void {
    if (!isLoginUrl(this.cfg, url) || this.lastLoginWarnUrl === url) return;
    this.lastLoginWarnUrl = url;
    this.emitError('LOGIN_REQUIRED', `Website B is on its login page (${url}). Log in manually in the Chromium window, reach the target page, then press Start.`, false);
  }

  private onBrowserGone(reason: string): void {
    if (this.state === 'failed') return;
    this.capture.disarm();
    this.fail(new AutomationError('BROWSER_CLOSED', `${reason}. Restart the service.`));
  }

  private fail(e: unknown): void {
    const ae = toAutomationError(e);
    this.tl.mark(`FAILED: ${ae.code}`, ae.message);
    this.emitError(ae.code, ae.message, true);
    this.setState('failed', `${ae.code}: ${ae.message}`);
  }

  private emitError(code: ErrorCode, message: string, fatal: boolean): void {
    console.error(`[error] ${code}: ${message}`);
    this.send({ type: 'error', ts: Date.now(), code, message, fatal });
  }

  private setState(state: WorkflowState, detail?: string): void {
    this.state = state;
    this.tl.mark(`state → ${state}`, detail);
    this.send({ type: 'state', ts: Date.now(), state, detail });
  }
}

function toAutomationError(e: unknown): AutomationError {
  if (e instanceof AutomationError) return e;
  return new AutomationError('INTERNAL', msg(e));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}
