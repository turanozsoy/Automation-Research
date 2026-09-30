import type { ApplicantErrorCode, ApplicationEventType, ApplicationView, ServerMsg } from '../../shared/messages.js';
import type { SiteBConfig } from '../config.js';
import type { Settings } from '../settings.js';
import type { Timeline } from '../timeline.js';
import type { WorkflowRegistry } from '../workflows.js';
import { FIELD_COLUMNS, type ApplicationRow, type ApplicationStore, type StorableField } from './store.js';

/** Per-workflow bookkeeping while an application's automation is running. Lives in memory only. */
interface Runtime {
  applicationId: string;
  phase: 'preparing' | 'awaiting_code' | 'submitting';
  /** Fields seeded into the workflow; the workflow acknowledges each one once Website B has it. */
  seeded: Set<string>;
  resolved: Set<string>;
  /** Latest value handed to the workflow per field (to forward only real changes while live). */
  sent: Map<string, string>;
  seq: number;
  addressFinalized: boolean;
  /** Code received before the workflow was ready for it; handed over as soon as the address is finalised, then dropped. */
  pendingCode: string | null;
  codeInjected: boolean;
  submitted: boolean;
  submittingReported: boolean;
  fallbackTimer: NodeJS.Timeout | null;
  /** The failure that will explain a `failed` state message (fatal error, or the paused step we aborted). */
  lastError: { code: string; message: string; stage?: string } | null;
}

export type Result = { ok: true } | { ok: false; code: ApplicantErrorCode; message: string; missingFields?: string[] };

const MAX_FIELD_LEN = 200;
const MAX_CODE_LEN = 64;

/** What the applicant is told for each automation failure. Never the raw automation message. */
function applicantMessage(code: string): string {
  switch (code) {
    case 'NO_PROFILE_AVAILABLE': return 'All processing slots are busy right now. Please try again in a few minutes.';
    case 'ADDRESS_NOT_ACCEPTED': case 'ADDRESS_MISMATCH': return 'We could not confirm your address. Please check the address fields and try again.';
    case 'FIELD_FILL_FAILED': case 'RECONCILE_MISMATCH': return 'Some of your information was not accepted. Please review your details and try again.';
    case 'URL_TIMEOUT': return 'We did not receive your link in time. Please try again.';
    case 'BROWSER_CLOSED': case 'SERVICE_RESTARTED': case 'AUTOMATION_ABANDONED': return 'Processing was interrupted. Please try again.';
    default: return 'We could not complete this step automatically. Please try again.';
  }
}

/**
 * The bridge between Shipzora applications and automation workflows.
 *
 *   applicationId (persistent)  ->  current workflowId (nullable, temporary)  ->  profile  ->  browser context
 *
 * Nothing is reserved while the applicant fills in the early steps. When the address step is
 * completed (every Website B field except the code is present) ONE workflow is started: profile,
 * onboarding page, seeded fields, then the existing address finalisation, all in the background
 * while the applicant is on the verification-code step. The code, when it arrives, goes into the
 * live workflow (write-only handling) and the submit sequence runs to the generated URL. The code
 * lives in memory here only until it is handed over. Workflow messages are routed here by
 * workflowId (server-side); the applicant only ever receives their own ApplicationView.
 */
export class ApplicationService {
  private runtimes = new Map<string, Runtime>();
  private notify: (applicationId: string, view: ApplicationView) => void = () => {};
  private progress: (applicationId: string, event: ApplicationEventType, step?: string) => void = () => {};

  constructor(
    private settings: Settings,
    private cfg: SiteBConfig,
    private store: ApplicationStore,
    private registry: WorkflowRegistry,
    private tl: Timeline,
  ) {}

  /** Called after every change with the fresh safe view (the WebSocket layer pushes it to that application's sockets only). */
  setNotifier(fn: (applicationId: string, view: ApplicationView) => void): void { this.notify = fn; }
  setProgressNotifier(fn: (applicationId: string, event: ApplicationEventType, step?: string) => void): void { this.progress = fn; }

  // ---------- field model (derived from the Website B config, the single source of truth) ----------

  /** Website B fields the workflow needs, minus the write-only code (provided separately, never stored). */
  requiredFields(): string[] { return Object.keys(this.cfg.fields).filter((n) => !this.cfg.fields[n].writeOnly); }
  writeOnlyFields(): string[] { return Object.keys(this.cfg.fields).filter((n) => this.cfg.fields[n].writeOnly); }
  /** Fields an applicant may save: every storable Website B field plus Shipzora-only ones. */
  storableFields(): StorableField[] {
    return (Object.keys(FIELD_COLUMNS) as StorableField[]).filter((n) => n === 'email' || (n in this.cfg.fields && !this.cfg.fields[n].writeOnly));
  }

  private value(row: ApplicationRow, field: string): string {
    const col = FIELD_COLUMNS[field as StorableField];
    const v = col ? row[col] : null;
    return typeof v === 'string' ? v : '';
  }

  missingFields(row: ApplicationRow): string[] {
    return this.requiredFields().filter((f) => this.value(row, f).trim() === '');
  }

  view(row: ApplicationRow): ApplicationView {
    const fields: Record<string, string> = {};
    for (const f of this.storableFields()) { const v = this.value(row, f); if (v !== '') fields[f] = v; }
    let answers: Record<string, unknown> = {};
    try { answers = JSON.parse(row.answers_json) ?? {}; } catch { answers = {}; }
    return {
      id: row.id,
      state: row.state,
      currentStep: row.current_step,
      fields,
      answers,
      verificationStep: row.verification_step,
      missingFields: this.missingFields(row),
      automation: { active: row.state === 'processing', attempts: row.workflow_count, phase: this.runtimeOf(row)?.phase ?? null },
      generatedUrl: row.generated_url,
      generatedUrlReadyAt: row.generated_url_ready_at,
      linkState: row.link_state,
      finalLinkClickedAt: row.final_link_clicked_at,
      problem: row.problem_code ? { code: row.problem_code, message: row.problem_message ?? applicantMessage(row.problem_code), at: row.problem_at ?? row.updated_at } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private runtimeOf(row: ApplicationRow): Runtime | undefined {
    return row.workflow_id ? this.runtimes.get(row.workflow_id) : undefined;
  }

  private emit(applicationId: string): void {
    const row = this.store.get(applicationId);
    if (row) this.notify(applicationId, this.view(row));
  }

  // ---------- applicant actions ----------

  create(): { row: ApplicationRow; token: string } {
    const r = this.store.create();
    this.tl.mark('application created', r.row.id.slice(0, 8));
    return r;
  }

  authenticate(token: string): ApplicationRow | undefined { return this.store.authenticate(token); }
  get(id: string): ApplicationRow | undefined { return this.store.get(id); }

  updateFields(id: string, raw: unknown): Result {
    const row = this.store.get(id);
    if (!row) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'BAD_REQUEST', message: 'fields must be an object' };
    const allowed = new Set<string>(this.storableFields());
    const clean: Partial<Record<StorableField, string>> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (this.writeOnlyFields().includes(k)) return { ok: false, code: 'INVALID_FIELD', message: `"${k}" is provided through app.verify and is never saved` };
      if (!allowed.has(k)) return { ok: false, code: 'INVALID_FIELD', message: `Unknown field "${k}"` };
      if (typeof v !== 'string') return { ok: false, code: 'INVALID_FIELD', message: `Field "${k}" must be a string` };
      if (v.length > MAX_FIELD_LEN) return { ok: false, code: 'INVALID_FIELD', message: `Field "${k}" is too long` };
      clean[k as StorableField] = v.trim();
    }
    this.store.updateFields(id, clean);
    this.store.event(id, 'fields_updated', { step: row.current_step, detail: Object.keys(clean).join(',') });
    // A live workflow that has not received the code yet keeps syncing (the existing live-sync path).
    const rt = this.runtimeOf(row);
    if (rt && row.workflow_id && !rt.codeInjected) {
      for (const [field, value] of Object.entries(clean)) {
        if (!(field in this.cfg.fields) || rt.sent.get(field) === value) continue;
        this.forward(rt, row.workflow_id, field, value!);
      }
    }
    this.emit(id);
    return { ok: true };
  }

  private forward(rt: Runtime, workflowId: string, field: string, value: string): void {
    rt.seeded.add(field);
    rt.resolved.delete(field);
    rt.sent.set(field, value);
    this.registry.handleFieldUpdate({ type: 'field.update', ts: Date.now(), workflowId, field, value, seq: ++rt.seq });
  }

  mergeAnswers(id: string, raw: unknown): Result {
    if (!this.store.get(id)) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'BAD_REQUEST', message: 'answers must be an object' };
    if (JSON.stringify(raw).length > 20_000) return { ok: false, code: 'BAD_REQUEST', message: 'answers too large' };
    this.store.mergeAnswers(id, raw as Record<string, unknown>);
    this.emit(id);
    return { ok: true };
  }

  setStep(id: string, step: unknown, completedStep?: unknown): Result {
    const row = this.store.get(id);
    if (!row) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (typeof step !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(step)) return { ok: false, code: 'BAD_REQUEST', message: 'invalid step name' };
    if (completedStep !== undefined && (typeof completedStep !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(completedStep))) return { ok: false, code: 'BAD_REQUEST', message: 'invalid completedStep name' };
    if (typeof completedStep === 'string') this.store.event(id, 'step_completed', { step: completedStep });
    this.store.patch(id, { current_step: step });
    this.store.event(id, 'step_viewed', { step });
    this.emit(id);
    return { ok: true };
  }

  /**
   * The applicant completed the address step. Start and prepare the onboarding workflow now, in the
   * background, so the address is finalised while the applicant is on the verification-code step.
   * Idempotent while a workflow is live for this application.
   */
  addressCompleted(id: string, clientIp?: string): Result {
    const row = this.store.get(id);
    if (!row) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (row.state === 'link_ready' || row.state === 'completed') return { ok: false, code: 'INVALID_STATE', message: 'Your application has already been processed' };
    const missing = this.missingFields(row);
    if (missing.length) {
      this.store.event(id, 'information_required', { step: row.current_step, detail: missing.join(',') });
      this.emit(id);
      return { ok: false, code: 'INFORMATION_REQUIRED', message: 'Some required information is still missing', missingFields: missing };
    }
    if (this.runtimeOf(row)) { this.store.event(id, 'step_completed', { step: 'address', workflowId: row.workflow_id }); return { ok: true }; }
    if (row.state === 'processing') return { ok: false, code: 'INVALID_STATE', message: 'Your application is already being processed' };
    this.store.event(id, 'step_completed', { step: 'address' });
    return this.startAutomation(row, clientIp, null);
  }

  /**
   * The applicant provided the verification code. Handed to the live workflow (after its address is
   * finalised), or held in memory until then. If no workflow is running (a retry, or a client that
   * skipped app.address_completed) one is started first. The code is never persisted.
   */
  provideVerification(id: string, code: unknown, clientIp?: string): Result {
    const row = this.store.get(id);
    if (!row) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (typeof code !== 'string' || code.trim() === '' || code.length > MAX_CODE_LEN) return { ok: false, code: 'BAD_REQUEST', message: 'A verification code is required' };
    if (row.state === 'link_ready' || row.state === 'completed') return { ok: false, code: 'INVALID_STATE', message: 'Your application has already been processed' };
    const rt = this.runtimeOf(row);
    if (rt && row.workflow_id) {
      if (rt.codeInjected || rt.pendingCode !== null) return { ok: false, code: 'INVALID_STATE', message: 'Your verification code was already received' };
      if (rt.addressFinalized) this.injectCode(rt, row.workflow_id, code.trim());
      else { rt.pendingCode = code.trim(); this.tl.child(row.workflow_id).mark('verification code received early, held until the address is finalized'); }
      this.emit(id);
      return { ok: true };
    }
    if (row.state === 'processing') return { ok: false, code: 'INVALID_STATE', message: 'Your application is already being processed' };
    const missing = this.missingFields(row);
    if (missing.length) {
      this.store.event(id, 'information_required', { step: row.current_step, detail: missing.join(',') });
      this.emit(id);
      return { ok: false, code: 'INFORMATION_REQUIRED', message: 'Some required information is still missing', missingFields: missing };
    }
    return this.startAutomation(row, clientIp, code.trim());
  }

  /** Reserve a profile and seed every non-secret Website B field. The code, if already known, waits in the runtime. */
  private startAutomation(row: ApplicationRow, clientIp: string | undefined, code: string | null): Result {
    if (this.writeOnlyFields().length !== 1) {
      // The config is the contract: this bridge injects exactly one write-only field with the code.
      this.tl.mark('application cannot start automation', `config has ${this.writeOnlyFields().length} write-only field(s), expected 1`);
      return { ok: false, code: 'INVALID_STATE', message: 'Processing is not available right now' };
    }
    const id = row.id;
    const { workflowId, queuePosition } = this.registry.startWorkflow(clientIp);
    const attempts = row.workflow_count + 1;
    this.store.patch(id, {
      state: 'processing', workflow_id: workflowId, workflow_count: attempts, verification_step: 'required',
      problem_code: null, problem_message: null, problem_at: null,
    });
    this.store.event(id, 'automation_started', { workflowId, step: row.current_step, retryCount: attempts - 1, detail: queuePosition ? `queued at position ${queuePosition}` : 'profile reserved' });
    this.tl.child(workflowId).mark('application automation started', `application ${id.slice(0, 8)}, attempt ${attempts}${queuePosition ? `, queued #${queuePosition}` : ''}`);

    const rt: Runtime = {
      applicationId: id, phase: 'preparing', seeded: new Set(), resolved: new Set(), sent: new Map(), seq: 0, addressFinalized: false,
      pendingCode: code, codeInjected: false, submitted: false, submittingReported: false, fallbackTimer: null, lastError: null,
    };
    this.runtimes.set(workflowId, rt);
    for (const field of this.requiredFields()) this.forward(rt, workflowId, field, this.value(row, field));
    this.progress(id, 'automation_started');
    this.emit(id);
    return { ok: true };
  }

  /** Hand the code to the live workflow (write-only field, masked handling) and arm the submit fallback. */
  private injectCode(rt: Runtime, workflowId: string, code: string): void {
    const field = this.writeOnlyFields()[0];
    rt.codeInjected = true;
    rt.pendingCode = null;
    rt.phase = 'submitting';
    rt.seeded.add(field);
    rt.resolved.delete(field);
    this.registry.handleFieldUpdate({ type: 'field.update', ts: Date.now(), workflowId, field, value: code, seq: ++rt.seq });
    this.store.event(rt.applicationId, 'verification_received', { workflowId });
    this.tl.child(workflowId).mark('verification code handed to the workflow');
    this.progress(rt.applicationId, 'verification_received');
    if (!rt.fallbackTimer) rt.fallbackTimer = setTimeout(() => this.trySubmit(workflowId, true), this.settings.applicantSubmitFallbackMs);
  }

  /** READY arrived: apply live updates, then finalise the address with the existing tested logic. */
  private async finalizeAddressFor(workflowId: string): Promise<void> {
    const rt = this.runtimes.get(workflowId);
    const wf = this.registry.get(workflowId);
    if (!rt || !wf) return;
    try {
      const r = await wf.finalizeAddress();
      if (r === 'not-ready' || !this.runtimes.has(workflowId)) return;
    } catch (e) {
      this.tl.child(workflowId).mark('address finalization failed, submit will verify strictly', e instanceof Error ? e.message : String(e));
    }
    rt.addressFinalized = true;
    this.store.event(rt.applicationId, 'address_finalized', { workflowId });
    this.progress(rt.applicationId, 'address_finalized');
    if (rt.pendingCode !== null) this.injectCode(rt, workflowId, rt.pendingCode);
    else rt.phase = 'awaiting_code';
    this.emit(rt.applicationId);
  }

  /** The applicant clicked the final call to action. Persists visited on the application and, when the workflow is live, on its assignment too. */
  linkOpened(id: string): Result {
    const row = this.store.get(id);
    if (!row) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (!row.generated_url) return { ok: false, code: 'INVALID_STATE', message: 'Your link is not ready yet' };
    const now = Date.now();
    const first = row.final_link_clicked_at === null;
    this.store.patch(id, {
      final_link_clicked_at: row.final_link_clicked_at ?? now,
      link_state: row.link_state === 'verified' ? 'verified' : 'visited',
      visited_at: row.visited_at ?? now,
    });
    if (first) {
      this.store.event(id, 'final_cta_clicked', { workflowId: row.workflow_id, step: row.current_step });
      if (row.link_state === 'none') { this.store.event(id, 'visited', { workflowId: row.workflow_id }); this.progress(id, 'visited'); }
    }
    if (row.workflow_id) this.registry.get(row.workflow_id)?.linkOpened();
    this.emit(id);
    return { ok: true };
  }

  // ---------- workflow -> application ----------

  /** Every service message that carries a workflowId passes through here (server-side routing). */
  onWorkflowMessage(workflowId: string, m: ServerMsg): void {
    const rt = this.runtimes.get(workflowId);
    if (!rt) return;
    const id = rt.applicationId;
    switch (m.type) {
      case 'state':
        switch (m.state) {
          case 'ready':
            this.store.event(id, 'automation_ready', { workflowId });
            this.progress(id, 'automation_ready');
            // Next tick: the workflow starts draining the seeded fields right after it announces READY;
            // finalizeAddress() waits for that drain so the tested order (fields, then address) is kept.
            setImmediate(() => void this.finalizeAddressFor(workflowId));
            break;
          case 'submitting':
            if (!rt.submittingReported) { rt.submittingReported = true; this.store.event(id, 'automation_submitting', { workflowId }); this.progress(id, 'automation_submitting'); }
            break;
          case 'completed':
            this.verified(rt, workflowId);
            this.endRuntime(workflowId, 'completed');
            break;
          case 'failed':
          case 'abandoned':
            this.terminal(rt, workflowId, m.state, m.detail);
            this.endRuntime(workflowId, m.state);
            break;
          default: break; // allocating / preparing / paused / link_ready / visited: reflected through other messages
        }
        break;
      case 'error':
        if (m.fatal && !rt.lastError) rt.lastError = { code: m.code, message: m.message };
        break;
      case 'paused': {
        // Nobody sits at the Chromium window for an applicant workflow: do not hold the profile, abort and report.
        rt.lastError = { code: m.code, message: m.message, stage: m.step };
        this.tl.child(workflowId).mark('applicant workflow paused: aborting', `step "${m.step}" (${m.code})`);
        // The workflow emits `paused` just before it enters the paused state; abort on the next tick.
        setImmediate(() => void this.registry.get(workflowId)?.resume('abort'));
        break;
      }
      case 'result': {
        const row = this.store.get(id);
        if (!row) break;
        this.store.patch(id, {
          state: 'link_ready', generated_url: m.url, generated_url_ready_at: row.generated_url_ready_at ?? m.ts,
          verification_step: 'completed', problem_code: null, problem_message: null, problem_at: null,
        });
        this.store.event(id, 'generated_link_ready', { workflowId });
        this.progress(id, 'generated_link_ready');
        this.emit(id);
        break;
      }
      case 'field.ack':
      case 'field.deferred':
      case 'field.error':
        rt.resolved.add(m.field);
        if (m.type === 'field.ack' && this.cfg.fields[m.field]?.writeOnly) {
          const row = this.store.get(id);
          if (row && row.verification_step !== 'completed') { this.store.patch(id, { verification_step: 'completed' }); this.emit(id); }
        }
        this.trySubmit(workflowId, false);
        break;
      default: break; // event / hello / pool.status / workflow.accepted: developer telemetry only
    }
  }

  /** Submit once the code is in and Website B has acknowledged every seeded field (or the fallback fired after the code). */
  private trySubmit(workflowId: string, force: boolean): void {
    const rt = this.runtimes.get(workflowId);
    if (!rt || rt.submitted || !rt.codeInjected) return;
    const wf = this.registry.get(workflowId);
    if (!wf || wf.state !== 'ready') return;
    const pending = [...rt.seeded].filter((f) => !rt.resolved.has(f));
    if (pending.length && !force) return;
    rt.submitted = true;
    if (rt.fallbackTimer) { clearTimeout(rt.fallbackTimer); rt.fallbackTimer = null; }
    this.tl.child(workflowId).mark('application submitting', pending.length ? `fallback after ${this.settings.applicantSubmitFallbackMs} ms, unacknowledged: ${pending.join(', ')}` : 'all fields acknowledged');
    // The snapshot lives in the workflow (the code included); it never comes back through here.
    void wf.submit(wf.getSnapshot(), Date.now());
  }

  private verified(rt: Runtime, workflowId: string): void {
    const row = this.store.get(rt.applicationId);
    if (!row) return;
    const now = Date.now();
    this.store.patch(rt.applicationId, { state: 'completed', link_state: 'verified', visited_at: row.visited_at ?? now, verified_at: row.verified_at ?? now, workflow_id: null });
    this.store.event(rt.applicationId, 'verified', { workflowId });
    this.progress(rt.applicationId, 'verified');
    this.emit(rt.applicationId);
  }

  /** The workflow ended without verification. Before the link: a problem the applicant can retry. After it: the link stands. */
  private terminal(rt: Runtime, workflowId: string, state: 'failed' | 'abandoned', detail?: string): void {
    const row = this.store.get(rt.applicationId);
    if (!row) return;
    if (row.state === 'link_ready' || row.state === 'completed') {
      this.store.patch(rt.applicationId, { workflow_id: null });
      this.store.event(rt.applicationId, 'automation_ended', { workflowId, code: state, detail: safeDetail(detail) });
      this.emit(rt.applicationId);
      return;
    }
    const code = rt.lastError?.code ?? (state === 'abandoned' ? 'AUTOMATION_ABANDONED' : 'AUTOMATION_FAILED');
    this.problem(rt.applicationId, workflowId, code, { stage: rt.lastError?.stage, detail: rt.lastError?.message ?? detail, retryCount: row.workflow_count - 1 });
  }

  private problem(id: string, workflowId: string | null, code: string, o: { stage?: string; detail?: string; retryCount?: number }): void {
    const message = applicantMessage(code);
    const now = Date.now();
    this.store.patch(id, { state: 'problem', problem_code: code, problem_message: message, problem_at: now, verification_step: 'failed', workflow_id: null });
    this.store.event(id, 'problem', { workflowId, stage: o.stage, code, message, detail: safeDetail(o.detail), retryCount: o.retryCount });
    this.progress(id, 'problem');
    this.emit(id);
  }

  private endRuntime(workflowId: string, why: string): void {
    const rt = this.runtimes.get(workflowId);
    if (!rt) return;
    rt.pendingCode = null;
    if (rt.fallbackTimer) clearTimeout(rt.fallbackTimer);
    this.runtimes.delete(workflowId);
    this.tl.child(workflowId).mark('application automation ended', `${why}, application ${rt.applicationId.slice(0, 8)}`);
  }

  // ---------- boot ----------

  /** Live workflows do not survive a restart. Applications that were processing become a retryable problem. */
  recoverOnBoot(): number {
    const rows = this.store.processing();
    for (const row of rows) {
      this.store.event(row.id, 'service_restarted', { workflowId: row.workflow_id });
      this.problem(row.id, row.workflow_id, 'SERVICE_RESTARTED', { retryCount: row.workflow_count - 1 });
    }
    return rows.length;
  }

  /** How many applications currently have a running workflow (for the debug page / logs). */
  activeCount(): number { return this.runtimes.size; }
}

/** Internal detail kept with a problem event: automation text (selectors, stage names), bounded. Never shown to applicants. */
function safeDetail(s?: string): string | undefined {
  if (!s) return undefined;
  return s.replace(/\s+/g, ' ').slice(0, 500);
}
