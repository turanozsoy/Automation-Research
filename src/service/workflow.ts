import type { Frame } from 'playwright';
import type { ErrorCode, FieldUpdateMsg, ServerMsg, WorkflowState } from '../shared/messages.js';
import type { ContextBundle } from './browser/manager.js';
import { isLoginUrl, type SiteBConfig } from './config.js';
import { SiteB } from './site-b.js';
import { AutomationError, type Timeline } from './timeline.js';
import { UrlCapture } from './url-capture.js';

interface PendingUpdate { value: string; seq: number; sentAt: number; receivedAt: number }

export type TerminalOutcome = 'completed' | 'failed' | 'abandoned' | 'auth_expired' | 'browser_lost' | 'uncertain';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type Send = (msg: DistributiveOmit<ServerMsg, 'workflowId'>) => void;

/**
 * One workflow = one profile = one isolated browser context. Holds the latest
 * snapshot, coalesces field updates per field, and runs the submit sequence as
 * pausable steps. The registry owns allocation and release; this class reports
 * its terminal outcome through `onTerminal`.
 */
export class Workflow {
  state: WorkflowState = 'allocating';
  lastActivityAt = Date.now();
  private snapshot = new Map<string, string>();
  private pending = new Map<string, PendingUpdate>();
  private drainPromise: Promise<void> | null = null;
  private siteB: SiteB;
  private capture: UrlCapture;
  private terminal: TerminalOutcome | null = null;
  private onTerminal: (outcome: TerminalOutcome, code?: ErrorCode) => void = () => {};
  private onLinkState: (state: 'visited' | 'verified') => void = () => {};
  private onSubmitState: (state: 'submitting' | 'succeeded', url?: string) => void = () => {};
  private monitorTimer: NodeJS.Timeout | null = null;
  private monitorDeadline = 0;
  private linkVisited = false;

  constructor(
    public readonly id: string,
    private bundle: ContextBundle,
    private cfg: SiteBConfig,
    private tl: Timeline,
    private rawSend: (msg: ServerMsg) => void,
  ) {
    this.siteB = new SiteB(bundle.page, cfg, tl);
    this.capture = new UrlCapture(bundle.page, bundle.context, cfg, tl);
    this.watchBrowser();
  }

  setTerminalHandler(fn: (outcome: TerminalOutcome, code?: ErrorCode) => void): void {
    this.onTerminal = fn;
  }

  setLinkStateHandler(fn: (state: 'visited' | 'verified') => void): void {
    this.onLinkState = fn;
  }

  setSubmitStateHandler(fn: (state: 'submitting' | 'succeeded', url?: string) => void): void {
    this.onSubmitState = fn;
  }

  private send: Send = (msg) => {
    this.rawSend({ ...msg, workflowId: this.id } as ServerMsg);
  };

  fieldNames(): string[] { return Object.keys(this.cfg.fields); }
  writeOnlyFields(): string[] { return Object.keys(this.cfg.fields).filter((n) => this.cfg.fields[n].writeOnly); }
  deferredFields(): string[] { return Object.keys(this.cfg.fields).filter((n) => this.cfg.fields[n].syncMode === 'deferred'); }
  private loggable(field: string, value: string): string { return this.cfg.fields[field]?.writeOnly ? '(masked)' : `"${value}"`; }

  // ---------- prepare ----------

  /**
   * Open Website B with the profile's session, verify it is authenticated, click
   * Recommended, resolve field selectors. Throws LOGIN_REQUIRED when the profile's
   * session is not valid (the registry then releases it as expired and reassigns).
   */
  async prepare(): Promise<void> {
    this.setState('preparing', 'opening Website B with the assigned profile');
    await this.siteB.openTarget();
    const url = this.siteB.currentUrl();
    this.tl.mark('Website B opened', url);
    if (isLoginUrl(this.cfg, url)) throw new AutomationError('LOGIN_REQUIRED', `profile session not valid: redirected to ${url}`);
    this.tl.mark('session verified');
    await this.siteB.clickRecommended();
    this.tl.mark('Recommended clicked');
    await this.siteB.resolveFields();
    this.setState('ready', 'field sync active');
    this.tl.mark('READY', `${this.pending.size} buffered update(s) to apply`);
    void this.drain();
  }

  // ---------- snapshot carry-over (reassignment) ----------

  getSnapshot(): Record<string, string> { return Object.fromEntries(this.snapshot); }

  /** Seed values received before this runtime existed (buffered by the registry, or from a previous profile). */
  seedSnapshot(values: Record<string, string>): void {
    const now = Date.now();
    for (const [field, value] of Object.entries(values)) {
      if (!(field in this.cfg.fields)) continue;
      this.snapshot.set(field, value);
      if (this.cfg.fields[field].syncMode === 'live') this.pending.set(field, { value, seq: 0, sentAt: now, receivedAt: now });
    }
    if (Object.keys(values).length) this.tl.mark('snapshot carried over', `${Object.keys(values).length} field(s)`);
  }

  // ---------- live field sync ----------

  handleFieldUpdate(m: FieldUpdateMsg): void {
    this.touch();
    const receivedAt = this.tl.mark(`update received: ${m.field}`, `${this.loggable(m.field, m.value)} seq=${m.seq}`);
    if (!(m.field in this.cfg.fields)) {
      this.send({ type: 'field.error', ts: Date.now(), field: m.field, seq: m.seq, code: 'UNKNOWN_FIELD', message: `No mapping for "${m.field}" in config` });
      return;
    }
    if (!(this.state === 'allocating' || this.state === 'preparing' || this.state === 'ready')) {
      this.send({ type: 'field.error', ts: Date.now(), field: m.field, seq: m.seq, code: 'INVALID_STATE', message: `Field updates are not accepted in state ${this.state}` });
      return;
    }
    this.snapshot.set(m.field, m.value);
    if (this.cfg.fields[m.field].syncMode === 'deferred') {
      this.tl.mark(`${m.field} saved locally, applied at submit`);
      this.send({ type: 'field.deferred', ts: Date.now(), field: m.field, seq: m.seq });
      return;
    }
    // Coalesce: a newer value for the same field replaces the older pending one.
    this.pending.set(m.field, { value: m.value, seq: m.seq, sentAt: m.ts, receivedAt });
    void this.drain();
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    if (this.state !== 'ready' || this.pending.size === 0) return Promise.resolve();
    this.drainPromise = this.runDrain().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  private addressFinalized = false;

  /**
   * Apply pending updates of the address fields now, in the configured order, so the
   * finalisation always works on the latest address regardless of arrival order.
   */
  private async flushPendingAddress(fields: string[]): Promise<void> {
    let flushed = 0;
    for (const field of fields) {
      const upd = this.pending.get(field);
      if (!upd) continue;
      this.pending.delete(field);
      try {
        const actual = await this.siteB.setField(field, upd.value);
        const filledAt = this.tl.mark(`${field} synchronized`, `"${actual}"`);
        this.send({ type: 'field.ack', ts: filledAt, field, seq: upd.seq, sentAt: upd.sentAt, receivedAt: upd.receivedAt, startedAt: filledAt, filledAt, value: actual });
        flushed++;
      } catch (e) {
        const ae = toAutomationError(e);
        if (ae.code === 'FIELD_NOT_FOUND' && !this.cfg.fields[field].requiredAtStart) { this.tl.mark(`${field} not on page yet, applied after the address is finalized`); this.send({ type: 'field.deferred', ts: Date.now(), field, seq: upd.seq }); continue; }
        this.tl.mark(`field update failed: ${field}`, ae.message);
        this.send({ type: 'field.error', ts: Date.now(), field, seq: upd.seq, code: ae.code, message: ae.message });
      }
    }
    this.tl.mark('pending address updates flushed', `${flushed} applied`);
  }

  /**
   * Explicit address finalisation, for a caller that knows the address step is complete
   * (the Shipzora application moving to its verification-code step) and does not want to
   * wait for the first code keystroke. Same tested logic as the trigger path; runs under
   * the drain lock so it never overlaps live field sync, and applies live updates first
   * in their normal order. A later code update then finds the address already finalised.
   */
  async finalizeAddress(): Promise<'finalized' | 'already' | 'not-ready'> {
    if (!this.cfg.addressFinalize) return 'already';
    while (this.drainPromise) await this.drainPromise;
    if (this.state !== 'ready') return 'not-ready';
    if (this.addressFinalized) return 'already';
    this.drainPromise = this.finalizeAddressOnTrigger('address step completed').finally(() => { this.drainPromise = null; });
    await this.drainPromise;
    void this.drain(); // anything that arrived meanwhile
    return 'finalized';
  }

  /** First authentication-code update (or an explicit request): finalise the address on Website B before the code is typed. */
  private async finalizeAddressOnTrigger(reason?: string): Promise<void> {
    const af = this.cfg.addressFinalize!;
    this.addressFinalized = true;
    this.tl.mark(reason ? `finalizing address (${reason})` : `${af.trigger} started, finalizing address`);
    await this.flushPendingAddress(af.fields);
    const snapshot = this.getSnapshot();
    try {
      await this.siteB.finalizeAddressWithEnter(snapshot);
      await this.siteB.verifyAndRepairAddress(snapshot, af.fields, af.repairRounds, false);
    } catch (e) {
      this.tl.mark('address finalization problem (will be re-checked at submit)', toAutomationError(e).message);
    }
  }

  private async runDrain(): Promise<void> {
    while (this.pending.size > 0 && this.state === 'ready') {
      const [field, upd] = this.pending.entries().next().value as [string, PendingUpdate];
      const af = this.cfg.addressFinalize;
      if (af && field === af.trigger && !this.addressFinalized) {
        await this.finalizeAddressOnTrigger();
        if (this.state !== 'ready') return;
        continue; // the trigger update is still pending; it is applied on the next iteration
      }
      this.pending.delete(field);
      try {
        const startedAt = Date.now();
        const actual = await this.siteB.setField(field, upd.value);
        const filledAt = this.cfg.fields[field].writeOnly
          ? this.tl.mark(`${field} updated (masked)`)
          : this.cfg.addressFinalize?.fields.includes(field)
            ? this.tl.mark(`${field} synchronized`, `"${actual}"`)
            : this.tl.mark(`Website B ${field} updated`, `"${actual}"`);
        this.send({ type: 'field.ack', ts: filledAt, field, seq: upd.seq, sentAt: upd.sentAt, receivedAt: upd.receivedAt, startedAt, filledAt, value: actual });
      } catch (e) {
        const ae = toAutomationError(e);
        if (ae.code === 'FIELD_NOT_FOUND' && !this.cfg.fields[field].requiredAtStart) {
          this.tl.mark(`${field} not on page yet, applied after the address is finalized`);
          this.send({ type: 'field.deferred', ts: Date.now(), field, seq: upd.seq });
          continue;
        }
        this.tl.mark(`field update failed: ${field}`, ae.message);
        this.send({ type: 'field.error', ts: Date.now(), field, seq: upd.seq, code: ae.code, message: ae.message });
      }
    }
  }

  // ---------- submit: ordered steps, pausable ----------

  private submitCtx: { snapshot: Record<string, string>; requestedAt: number } | null = null;
  private stepIndex = 0;
  /**
   * Which checkout path the race in 'checkout-route' chose (priority 4, 7, 5, 6):
   * 'agree' = 4 → optional 5 → 6 → 7; 'secondary' = 7 only (4, 5 and 6 never appear);
   * 'toggle' = 5 → 6 → 7 (the toggle screen opened without an Agree button);
   * 'direct' = 6 → 7 (the primary button showed up without Agree, secondary or toggle).
   */
  private checkoutPath: 'agree' | 'secondary' | 'toggle' | 'direct' | null = null;
  private stepNames(): string[] {
    // Checkout after the submit click (Step 3): 'checkout-route' races Steps 4, 7, 5 and 6 (in that priority) in
    // every frame; whichever is visible first decides the path. A previously-used account may land on Step 7
    // directly (then 4/5/6 are skipped) or on the toggle / primary screen (then 4 is skipped).
    return ['reconcile', 'address', 'submit-click', 'checkout-route', 'checkout-toggle', 'primary', 'secondary', 'capture-url'];
  }

  async submit(snapshot: Record<string, string>, requestedAt: number): Promise<void> {
    this.touch();
    if (this.state !== 'ready') {
      this.emitError('INVALID_STATE', `Submit is only allowed in ready (current: ${this.state})`, false);
      return;
    }
    this.setState('submitting');
    this.tl.mark('submit received', `${Object.keys(snapshot).length} fields in snapshot, ${Date.now() - requestedAt} ms after request`);
    for (const [k, v] of Object.entries(snapshot)) this.snapshot.set(k, v);
    this.pending.clear();
    if (this.drainPromise) await this.drainPromise;
    this.submitCtx = { snapshot, requestedAt };
    this.stepIndex = 0;
    this.checkoutPath = null;
    this.onSubmitState('submitting');
    this.capture.arm();
    await this.runSteps();
  }

  async resume(mode: 'retry' | 'skip' | 'abort'): Promise<void> {
    this.touch();
    if (this.state !== 'paused' || !this.submitCtx) {
      this.emitError('INVALID_STATE', `Resume is only allowed while paused (current: ${this.state})`, false);
      return;
    }
    const names = this.stepNames();
    if (mode === 'abort') {
      this.capture.disarm();
      this.fail(new AutomationError('INTERNAL', `Aborted by user at step "${names[this.stepIndex]}"`));
      return;
    }
    if (mode === 'skip') { this.tl.mark(`step "${names[this.stepIndex]}" skipped by user (done manually)`); this.stepIndex++; }
    else this.tl.mark(`step "${names[this.stepIndex]}" retried by user`);
    this.setState('submitting', `resuming at step ${names[this.stepIndex] ?? 'done'}`);
    await this.runSteps();
  }

  /** What each submit step does, for the /debug timeline. */
  private static readonly STEP_WHAT: Record<string, string> = {
    'reconcile': 'compare every Website B field with the final snapshot and re-fill any that differ',
    'address': 'verify the finalised address (and repair it if Website B changed it)',
    'submit-click': 'Step 3: click the submit button, then watch for field errors or the next screen',
    'checkout-route': 'race Steps 4, 7, 5 and 6 (priority in that order): search every frame for the Agree button, the secondary button, the toggle and the primary button at the same time; whichever is visible first decides the path',
    'checkout-toggle': 'Step 5: look for the toggle and the primary button together; turn the toggle OFF if it is on',
    'primary': 'Step 6: click the primary button',
    'secondary': 'Step 7: click the secondary button',
    'capture-url': 'wait for the generated role-details URL (navigation, anchor or text)',
  };

  private async runSteps(): Promise<void> {
    const names = this.stepNames();
    while (this.stepIndex < names.length) {
      const name = names[this.stepIndex];
      const startedAt = Date.now();
      this.tl.mark(`▶ step ${this.stepIndex + 1}/${names.length} "${name}"`, Workflow.STEP_WHAT[name] ?? '');
      try {
        await this.runStep(name);
        this.tl.mark(`✓ step "${name}" done`, `${Date.now() - startedAt} ms`);
        this.stepIndex++;
      } catch (e) {
        const ae = toAutomationError(e);
        if (this.terminal) return;
        this.tl.mark(`step "${name}" failed: ${ae.code}`, ae.message);
        this.send({ type: 'paused', ts: Date.now(), step: name, stepIndex: this.stepIndex, steps: names, code: ae.code, message: ae.message });
        this.setState('paused', `step "${name}" failed — retry it, do it manually in Chromium and skip, or abort`);
        return;
      }
    }
  }

  private async runStep(name: string): Promise<void> {
    const ctx = this.submitCtx!;
    const { snapshot } = ctx;
    void ctx;
    switch (name) {
      case 'reconcile': {
        this.tl.mark('final reconciliation started');
        const af = this.cfg.addressFinalize;
        const normal = Object.keys(this.cfg.fields).filter((n) => !this.cfg.fields[n].writeOnly && this.cfg.fields[n].syncMode === 'live' && !(af && af.fields.includes(n)));
        const corrected = await this.siteB.reconcile(snapshot, normal);
        this.tl.mark('ordinary fields reconciled', corrected.length ? `corrected: ${corrected.join(', ')}` : 'all in sync');
        return;
      }
      case 'address': {
        const af = this.cfg.addressFinalize;
        if (af) {
          // Strict: verify → repair (address1 → city → state → zip) → verify; refuses to continue on mismatch.
          await this.siteB.verifyAndRepairAddress(snapshot, af.fields, af.repairRounds, true);
        }
        for (const n of this.writeOnlyFields()) {
          const r = await this.siteB.finaliseWriteOnly(n, snapshot[n] ?? this.snapshot.get(n) ?? '');
          this.tl.mark(r === 'filled' ? `${n} updated (masked)` : r === 'verified' ? `${n} verified (masked, not compared)` : `${n} empty in snapshot, skipped`);
        }
        for (const n of this.deferredFields()) {
          const value = snapshot[n] ?? this.snapshot.get(n) ?? '';
          if (value.trim() === '') { this.tl.mark(`${n} empty in snapshot, skipped`); continue; }
          const actual = await this.siteB.setField(n, value);
          this.tl.mark(`Website B ${n} updated`, `"${actual}"`);
        }
        this.tl.mark('final reconciliation complete');
        return;
      }
      case 'submit-click': {
        const fe = this.cfg.fieldErrors;
        for (let attempt = 1; attempt <= fe.maxRetries + 1; attempt++) {
          await this.siteB.clickLastSubmit();
          this.tl.mark(attempt === 1 ? 'Website B submit clicked' : `submit retried (attempt ${attempt})`);
          const r = await this.siteB.watchAfterSubmit(fe.postSubmitWaitMs);
          if (r.outcome === 'advanced') return;
          if (r.outcome !== 'errors') { this.tl.mark(r.outcome === 'form-gone' ? 'form left the page, waiting for the next step' : 'form still on page with no flagged field'); return; }
          // Still on the form with flagged fields: re-fill them from Website A and click again.
          for (const e of r.errors) this.tl.mark(`field error detected: ${e.field}`, `${e.reason} (after submit attempt ${attempt})`);
          const failed = await this.siteB.refillFields(r.errors.map((e) => e.field), snapshot);
          if (failed.length === r.errors.length) throw new AutomationError('FIELD_FILL_FAILED', `Could not re-fill flagged field(s): ${failed.join(', ')}`);
          if (this.cfg.addressFinalize && r.errors.some((e) => this.cfg.addressFinalize!.fields.includes(e.field))) {
            await this.siteB.verifyAndRepairAddress(snapshot, this.cfg.addressFinalize.fields, this.cfg.addressFinalize.repairRounds, true);
          }
          const still = await this.siteB.fieldsWithErrors();
          this.tl.mark(still.length ? 'fields still flagged after re-fill' : 'field errors fixed', (still.length ? still : r.errors).map((e) => e.field).join(', '));
        }
        throw new AutomationError('FIELD_FILL_FAILED', `Website B still reports field errors after ${fe.maxRetries + 1} submit attempt(s)`);
      }
      case 'checkout-route': {
        // Step 3 is done. Depending on the account, the checkout may open on Step 4 (Agree), straight on Step 7
        // (secondary button), or on the toggle / primary screen (Steps 5/6). All four controls are searched in
        // every frame at the same time; the first one visible decides the path. Priority when several are
        // visible in the same check: 4, then 7, then 5, then 6. No waiting for one step followed by a fallback.
        const agree = this.cfg.checkout.agreeButton;
        const toggle = this.cfg.checkout.toggle;
        const primary = this.cfg.checkout.primaryButton;
        const secondary = this.cfg.checkout.secondaryButton;
        if (!agree) { this.checkoutPath = 'agree'; this.tl.mark('no Agree button configured', 'continuing with the toggle and primary steps'); return; }
        const candidates = this.cfg.checkout.agreeOptional ? [agree, secondary, toggle, primary] : [agree];
        this.tl.mark('racing checkout controls', this.cfg.checkout.agreeOptional
          ? `priority 4, 7, 5, 6 — Step 4 = ${agree}  |  Step 7 = ${secondary}  |  Step 5 = ${toggle}  |  Step 6 = ${primary}  —  up to ${this.cfg.timeouts.checkoutStep} ms${this.cfg.checkout.frameUrlIncludes ? `, frames filtered by "${this.cfg.checkout.frameUrlIncludes}"` : ''}`
          : `agreeOptional=false: Step 4 only (${agree}) — up to ${this.cfg.timeouts.checkoutStep} ms`);
        const hit = await this.siteB.findFrameWithAny(candidates, this.cfg.timeouts.checkoutStep, 'AGREE_NOT_FOUND');
        if (hit.selector === agree) {
          this.checkoutPath = 'agree';
          await this.siteB.clickInFrame(hit.frame, agree, 'AGREE_NOT_FOUND');
          this.tl.mark('Agree and continue clicked', 'Step 4 appeared first: optional toggle, then primary, then secondary');
          return;
        }
        if (hit.selector === secondary) {
          // Step 7 appeared without Step 4: Steps 4, 5 and 6 are skipped for this account; click Step 7 now.
          this.checkoutPath = 'secondary';
          this.tl.mark('Agree and continue not present: secondary button visible first', 'Steps 4, 5 and 6 skipped for this account');
          await this.clickSecondary(hit.frame);
          return;
        }
        if (hit.selector === toggle) {
          // The toggle screen opened without an Agree button: Step 4 skipped; Step 5 handles the toggle next, then 6, then 7.
          this.checkoutPath = 'toggle';
          this.tl.mark('Agree and continue not present: toggle visible first', 'Step 4 skipped for this account; toggle, then primary, then secondary');
          return;
        }
        this.checkoutPath = 'direct';
        this.tl.mark('Agree and continue not present: primary button visible first', 'Steps 4 and 5 skipped for this account');
        await this.clickPrimary(hit.frame);
        return;
      }
      case 'checkout-toggle': {
        if (this.checkoutPath === 'secondary') { this.tl.mark('checkout toggle step skipped', 'secondary button already clicked'); return; }
        if (this.checkoutPath === 'direct') { this.tl.mark('checkout toggle step skipped', 'primary button already clicked'); return; }
        // After Step 4: look for Step 5 and Step 6 together. Step 5 is optional and is only ever turned OFF.
        const toggle = this.cfg.checkout.toggle;
        const primary = this.cfg.checkout.primaryButton;
        const candidates = this.cfg.checkout.toggleOptional ? [toggle, primary] : [toggle];
        const hit = await this.siteB.findFrameWithAny(candidates, this.cfg.timeouts.iframe, 'IFRAME_NOT_FOUND');
        this.tl.mark('iframe detected', hit.frame.url());
        if (hit.selector !== toggle) {
          // The UI advanced straight to Step 6: one instant re-check of that frame for the toggle, no waiting.
          const present = await hit.frame.locator(toggle).filter({ visible: true }).count().catch(() => 0);
          if (!present) { this.tl.mark('checkout toggle not present, skipped', 'primary button already visible'); return; }
        }
        const result = await this.siteB.ensureToggleOff(hit.frame);
        this.tl.mark(result === 'unchecked' ? 'checkbox unchecked' : 'checkbox already unchecked');
        return;
      }
      case 'primary': {
        if (this.checkoutPath === 'secondary') { this.tl.mark('primary step skipped', 'secondary button already clicked'); return; }
        if (this.checkoutPath === 'direct') { this.tl.mark('primary step already done', 'clicked when it appeared before the Agree button'); return; }
        const sel = this.cfg.checkout.primaryButton;
        const f = await this.siteB.findFrameWith(sel, this.cfg.timeouts.checkoutStep, 'PRIMARY_NOT_FOUND');
        this.tl.mark('primary available');
        await this.clickPrimary(f);
        return;
      }
      case 'secondary': {
        if (this.checkoutPath === 'secondary') { this.tl.mark('secondary step already done', 'clicked when it appeared before the Agree button'); return; }
        const sel = this.cfg.checkout.secondaryButton;
        const f = await this.siteB.findFrameWith(sel, this.cfg.timeouts.checkoutStep, 'SECONDARY_NOT_FOUND');
        this.tl.mark('secondary available');
        await this.clickSecondary(f);
        return;
      }
      case 'capture-url': {
        const { url, source } = await this.capture.wait(this.cfg.timeouts.generatedUrl);
        const detectedAt = this.tl.mark('generated URL detected', `${source}: ${url}`);
        this.onSubmitState('succeeded', url);
        this.send({ type: 'result', ts: detectedAt, url, source, submitRequestedAt: ctx.requestedAt });
        this.tl.mark('URL sent to Website A', `${Date.now() - ctx.requestedAt} ms after submit requested`);
        this.submitCtx = null;
        this.setState('link_ready', 'waiting for the user to open the link and for the success text on Website B');
        this.startVerificationMonitor();
        return;
      }
      default:
        throw new AutomationError('INTERNAL', `Unknown step ${name}`);
    }
  }

  // ---------- after the URL: visited / verified ----------

  /** The user clicked "Open link" on Website A. */
  linkOpened(): void {
    this.touch();
    if (this.terminal) return;
    if (this.state !== 'link_ready' && this.state !== 'visited') {
      this.emitError('INVALID_STATE', `Link cannot be opened in state ${this.state}`, false);
      return;
    }
    if (this.linkVisited) return;
    this.linkVisited = true;
    this.tl.mark('link opened by user (visited)');
    this.onLinkState('visited');
    this.setState('visited', 'watching Website B for the success text');
  }

  /** Poll every frame (and popup) of the automated context for one of the configured success texts. */
  private startVerificationMonitor(): void {
    const v = this.cfg.verification;
    const needles = v.successTexts.map(normText).filter(Boolean);
    this.monitorDeadline = Date.now() + v.timeoutMs;
    this.tl.mark('verification monitor started', `looking for ${JSON.stringify(v.successTexts)} for up to ${v.timeoutMs} ms`);
    const tick = async () => {
      if (this.terminal) return;
      if (Date.now() > this.monitorDeadline) {
        this.tl.mark('verification timed out', `no success text within ${v.timeoutMs} ms`);
        this.end('verification timeout');
        return;
      }
      try {
        for (const page of this.bundle.context.pages()) {
          if (page.isClosed()) continue;
          for (const frame of page.frames()) {
            const text = await frame.evaluate(`(() => {
              const walk = (root, out) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) { out.push(el.shadowRoot.textContent || ''); walk(el.shadowRoot, out); } } return out; };
              return (document.body ? document.body.innerText : '') + ' ' + walk(document, []).join(' ');
            })()`).catch(() => '') as string;
            const hay = normText(text);
            const hit = needles.find((n) => hay.includes(n));
            if (hit) {
              this.stopVerificationMonitor();
              this.tl.mark('verification text found', `"${hit}" in ${frame.url() || 'about:blank'}`);
              if (!this.linkVisited) { this.linkVisited = true; this.onLinkState('visited'); }
              this.onLinkState('verified');
              this.setState('completed', 'verified: success text seen on Website B');
              this.finish('completed');
              return;
            }
          }
        }
      } catch { /* page re-rendering; try again next tick */ }
      if (!this.terminal) this.monitorTimer = setTimeout(() => void tick(), v.pollMs);
    };
    this.monitorTimer = setTimeout(() => void tick(), v.pollMs);
  }

  private stopVerificationMonitor(): void {
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
  }

  // ---------- ending ----------

  /** Client closed the form, or idle timeout. */
  end(reason: string): void {
    if (this.terminal) return;
    this.stopVerificationMonitor();
    this.capture.disarm();
    this.tl.mark('workflow ended', reason);
    this.setState('abandoned', reason);
    this.finish('abandoned');
  }

  /** True once the workflow reached a terminal state. */
  isTerminal(): boolean { return this.terminal !== null; }

  /**
   * Silently retire this runtime (the registry is moving the workflow to another
   * profile): no messages, no terminal callback, and closing the context afterwards
   * must not be reported as a browser loss.
   */
  detach(): void {
    this.stopVerificationMonitor();
    this.capture.disarm();
    this.terminal = 'failed';
  }

  private finish(outcome: TerminalOutcome, code?: ErrorCode): void {
    if (this.terminal) return;
    this.terminal = outcome;
    this.onTerminal(outcome, code);
  }

  private touch(): void { this.lastActivityAt = Date.now(); }

  // ---------- helpers ----------

  /** Step 6: click the primary button in `f`; when the secondary button was already visible, wait for the checkout state to change. */
  private async clickPrimary(f: Frame): Promise<void> {
    const sel = this.cfg.checkout.primaryButton;
    const secondaryVisibleBefore = await f.locator(this.cfg.checkout.secondaryButton).filter({ visible: true }).count().catch(() => 0);
    await this.siteB.clickInFrame(f, sel, 'PRIMARY_NOT_FOUND');
    this.tl.mark('primary clicked');
    if (secondaryVisibleBefore > 0) {
      const changed = await this.waitForStateChange(f, sel, this.cfg.timeouts.checkoutStep);
      this.tl.mark(changed ? 'checkout state changed after primary' : 'no state change detected after primary, continuing');
    }
  }

  /** Step 7: click the secondary button in `f`. */
  private async clickSecondary(f: Frame): Promise<void> {
    await this.siteB.clickInFrame(f, this.cfg.checkout.secondaryButton, 'SECONDARY_NOT_FOUND');
    this.tl.mark('secondary clicked');
  }

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
    const { page, context } = this.bundle;
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame() || this.terminal) return;
      const url = f.url();
      if (!isLoginUrl(this.cfg, url)) return;
      if (this.state === 'preparing') return; // prepare() checks and throws itself
      this.fail(new AutomationError('LOGIN_REQUIRED', `Session lost: Website B redirected to ${url} during ${this.state}`));
    });
    page.on('close', () => { if (!this.terminal) this.onBrowserGone('page closed'); });
    context.on('close', () => { if (!this.terminal) this.onBrowserGone('context closed'); });
  }

  private onBrowserGone(reason: string): void {
    this.stopVerificationMonitor();
    this.capture.disarm();
    const ae = new AutomationError('BROWSER_CLOSED', `${reason}.`);
    this.tl.mark(`FAILED: ${ae.code}`, ae.message);
    this.emitError(ae.code, ae.message, true);
    this.setState('failed', `${ae.code}: ${ae.message}`);
    this.finish('browser_lost', ae.code);
  }

  /** Terminal failure. Maps LOGIN_REQUIRED to auth_expired so the registry retires the profile. */
  fail(e: unknown): void {
    if (this.terminal) return;
    const ae = toAutomationError(e);
    this.stopVerificationMonitor();
    this.capture.disarm();
    this.tl.mark(`FAILED: ${ae.code}`, ae.message);
    this.emitError(ae.code, ae.message, true);
    this.setState('failed', `${ae.code}: ${ae.message}`);
    const uncertain = this.submitCtx !== null && this.stepIndex > this.stepNames().indexOf('submit-click');
    this.finish(ae.code === 'LOGIN_REQUIRED' ? 'auth_expired' : uncertain ? 'uncertain' : 'failed', ae.code);
  }

  private emitError(code: ErrorCode, message: string, fatal: boolean): void {
    console.error(`[error] [wf ${this.id.slice(0, 8)}] ${code}: ${message}`);
    this.send({ type: 'error', ts: Date.now(), code, message, fatal });
  }

  setState(state: WorkflowState, detail?: string): void {
    this.state = state;
    this.tl.mark(`state → ${state}`, detail);
    this.send({ type: 'state', ts: Date.now(), state, detail });
  }
}

/** Lower-case, straight quotes, collapsed whitespace, so "You’re good to go" matches "you're good to go". */
export function normText(s: string): string {
  return s.replace(/[\u2018\u2019\u02BC\u2032`]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function toAutomationError(e: unknown): AutomationError {
  if (e instanceof AutomationError) return e;
  return new AutomationError('INTERNAL', e instanceof Error ? e.message.split('\n')[0] : String(e));
}
