import type { ApplicantErrorCode, ApplicationEventType, ApplicationView, ServerMsg } from '../../shared/messages.js';
import type { SiteBConfig } from '../config.js';
import type { ProfileStore } from '../profiles/store.js';
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
  /** The workflow announced READY (Website B open, fields being typed). */
  ready: boolean;
  /** The applicant completed the address step; finalisation needs both this and `ready`. */
  addressCompleted: boolean;
  finalizing: boolean;
  addressFinalized: boolean;
  /** Code received before the workflow was ready for it; handed over as soon as the address is finalised, then dropped. */
  pendingCode: string | null;
  codeInjected: boolean;
  submitted: boolean;
  submittingReported: boolean;
  fallbackTimer: NodeJS.Timeout | null;
  /** Armed when every applicant socket is gone before the code was handed over; fires -> the workflow ends and the account is freed. */
  leaveTimer: NodeJS.Timeout | null;
  leftByApplicant: boolean;
  /** The failure that will explain a `failed` state message (fatal error, or the paused step we aborted). */
  lastError: { code: string; message: string; stage?: string } | null;
}

export type Result = { ok: true } | { ok: false; code: ApplicantErrorCode; message: string; missingFields?: string[] };

/** One row of the operations page's Verified Applications list. Internal only. */
export interface VerifiedApplicationItem {
  id: string; displayId: string; fullName: string; email: string | null;
  createdAt: number; generatedUrlReadyAt: number | null; finalLinkClickedAt: number | null; visitedAt: number | null; verifiedAt: number | null;
  workflowId: string | null; workflowOutcome: string | null;
  egress: { id: string; label: string } | null;
  processedWith: { profileId: string; label: string; exists: boolean; sessionStatus: 'none' | 'current' | 'attention' | 'expired'; sessionNote: string | null; sessionSavedAt: number | null; lastUsedAt: number | null; reservation: { state: 'review' | 'taken'; applicationId: string | null } | null } | null;
  sessionResult: 'refreshed' | 'failed' | null;
  /** The wait for the link: how long, whether the applicant left the waiting screen, came back, and was present when it became ready. */
  wait: { waitedMs: number | null; left: boolean; leftAfterMs: number | null; cameBack: boolean; unattendedAtReady: boolean; openedLink: boolean };
  answers: Record<string, unknown>;
}

const MAX_FIELD_LEN = 200;
const MAX_CODE_LEN = 64;

/** What the applicant is told for each automation failure. Never the raw automation message. */
function applicantMessage(code: string): string {
  switch (code) {
    case 'NO_PROFILE_AVAILABLE': return 'All processing slots are busy right now. Please try again in a few minutes.';
    case 'ADDRESS_NOT_ACCEPTED': case 'ADDRESS_MISMATCH': return 'We could not confirm your address. Please check the address fields and try again.';
    case 'FIELD_FILL_FAILED': case 'RECONCILE_MISMATCH': return 'Some of your information was not accepted. Please review your details and try again.';
    case 'URL_TIMEOUT': return 'We did not receive your link in time. Please try again.';
    case 'BROWSER_CLOSED': case 'SERVICE_RESTARTED': case 'AUTOMATION_ABANDONED': case 'EGRESS_FAILED': return 'Processing was interrupted. Please try again.';
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
    private profiles: ProfileStore,
  ) {
    registry.setSessionHandler((workflowId, profileId, result) => this.onSessionResult(workflowId, profileId, result));
  }

  /** Internal (admin) notifications: something on the operations page changed. Carries no data, the page re-fetches. */
  private adminNotify: (what: 'verified' | 'accounts') => void = () => {};
  setAdminNotifier(fn: (what: 'verified' | 'accounts') => void): void { this.adminNotify = fn; }

  /** Called after every change with the fresh safe view (the WebSocket layer pushes it to that application's sockets only). */
  setNotifier(fn: (applicationId: string, view: ApplicationView) => void): void { this.notify = fn; }
  setProgressNotifier(fn: (applicationId: string, event: ApplicationEventType, step?: string) => void): void { this.progress = fn; }
  /** How many applicant sockets are connected for an application right now (set by the server). */
  private presence: (applicationId: string) => number = () => 0;
  setPresence(fn: (applicationId: string) => number): void { this.presence = fn; }

  /**
   * The number of applicant sockets for an application changed. With none left while a workflow is live and the
   * code has not been handed over yet, the applicant "left before continuing": after the grace period (a page
   * refresh, a network blip or a switch to the SMS app must not count) the workflow ends, the browser closes and the
   * account returns to rotation; the application goes back to `started` and resumes from its saved step when the
   * applicant comes back. Once the code is in, the workflow always runs to the end.
   */
  presenceChanged(applicationId: string, sockets: number): void {
    const row = this.store.get(applicationId);
    const rt = row ? this.runtimeOf(row) : undefined;
    if (!row || !rt || !row.workflow_id) return;
    const workflowId = row.workflow_id;
    if (sockets > 0) {
      if (rt.leaveTimer) { clearTimeout(rt.leaveTimer); rt.leaveTimer = null; this.tl.child(workflowId).mark('applicant is back', 'leave timer cancelled'); }
      return;
    }
    if (rt.codeInjected || rt.leaveTimer) return;
    const grace = this.settings.applicantLeaveGraceMs;
    this.tl.child(workflowId).mark('applicant page gone before the code', `workflow ends in ${grace} ms unless the applicant returns`);
    rt.leaveTimer = setTimeout(() => {
      rt.leaveTimer = null;
      if (!this.runtimes.has(workflowId) || rt.codeInjected || this.presence(applicationId) > 0) return;
      rt.leftByApplicant = true;
      this.tl.child(workflowId).mark('applicant left before continuing', 'ending the workflow; the browser closes and the account returns to rotation');
      this.registry.end(workflowId, 'applicant left before continuing');
    }, grace);
  }

  /** Display id + name of an application, for the operations page (never contact details). */
  brief(id: string): { displayId: string; fullName: string } | null {
    const r = this.store.get(id);
    return r ? { displayId: `APP-${r.id.slice(0, 6).toUpperCase()}`, fullName: [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)' } : null;
  }

  /** Waiting-screen analytics from the applicant page (never affects the workflow). */
  waitEvent(id: string, event: unknown, elapsedMs: unknown): Result {
    const row = this.store.get(id);
    if (!row) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (event !== 'shown' && event !== 'hidden' && event !== 'visible') return { ok: false, code: 'BAD_REQUEST', message: 'unknown wait event' };
    const ms = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(Math.min(elapsedMs, 86_400_000)) : null;
    const type: ApplicationEventType = event === 'shown' ? 'wait_shown' : event === 'hidden' ? 'wait_hidden' : 'wait_visible';
    // only meaningful while the link is not there yet; afterwards the page shows the result and this says nothing about the wait
    if (row.generated_url) return { ok: true };
    this.store.event(id, type, { workflowId: row.workflow_id, step: row.current_step, detail: ms === null ? undefined : `after ${ms} ms` });
    return { ok: true };
  }

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

  setStep(id: string, step: unknown, completedStep?: unknown, final?: unknown): Result {
    const row = this.store.get(id);
    if (!row) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (typeof step !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(step)) return { ok: false, code: 'BAD_REQUEST', message: 'invalid step name' };
    if (completedStep !== undefined && (typeof completedStep !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(completedStep))) return { ok: false, code: 'BAD_REQUEST', message: 'invalid completedStep name' };
    if (typeof completedStep === 'string') this.store.event(id, 'step_completed', { step: completedStep });
    this.store.patch(id, { current_step: step });
    this.store.event(id, 'step_viewed', { step });
    if (final === true && row.current_step !== step) this.store.event(id, 'final_step_reached', { step, workflowId: row.workflow_id });
    this.emit(id);
    return { ok: true };
  }

  /** Client-side validation stopped the applicant. Field names only; never values. */
  validationFailed(id: string, step: unknown, fields: unknown): Result {
    if (!this.store.get(id)) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (typeof step !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(step)) return { ok: false, code: 'BAD_REQUEST', message: 'invalid step name' };
    if (!Array.isArray(fields) || fields.length > 20 || !fields.every((f) => typeof f === 'string' && /^[a-z0-9_-]{1,40}$/i.test(f))) return { ok: false, code: 'BAD_REQUEST', message: 'invalid fields' };
    this.store.event(id, 'validation_failed', { step, detail: fields.join(',') });
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
    const rt = this.runtimeOf(row);
    if (rt && row.workflow_id) {
      // started early (app.prepare): the browser is already on Website B; the address may be finalised now
      const first = !rt.addressCompleted;
      rt.addressCompleted = true;
      this.store.event(id, 'address_completed', { workflowId: row.workflow_id, detail: first ? (rt.ready ? 'workflow ready, finalising the address now' : 'workflow still preparing; address finalised once it is ready') : 'repeated' });
      if (first && rt.ready) setImmediate(() => void this.finalizeAddressFor(row.workflow_id!));
      return { ok: true };
    }
    if (row.state === 'processing') return { ok: false, code: 'INVALID_STATE', message: 'Your application is already being processed' };
    this.store.event(id, 'address_completed');
    return this.startAutomation(row, clientIp, null, true);
  }

  /** Website B fields that belong to the address (finalised together, after the applicant confirms the address). */
  private addressFields(): string[] { return this.cfg.addressFinalize?.fields ?? []; }

  /**
   * The applicant reached the address step: contact details and date of birth are saved, the address is not.
   * Start the workflow now so the account is reserved, the browser launched, Website B opened and the known
   * fields typed while the applicant fills in the address; the address fields follow as live updates and are
   * finalised after app.address_completed. Idempotent; silently a no-op when a workflow is already live.
   */
  prepare(id: string, clientIp?: string): Result {
    const row = this.store.get(id);
    if (!row) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (row.state === 'link_ready' || row.state === 'completed') return { ok: false, code: 'INVALID_STATE', message: 'Your application has already been processed' };
    if (this.runtimeOf(row) || row.state === 'processing') return { ok: true };
    const addr = new Set(this.addressFields());
    const missing = this.missingFields(row).filter((f) => !addr.has(f));
    if (missing.length) {
      this.store.event(id, 'information_required', { step: row.current_step, detail: missing.join(',') });
      this.emit(id);
      return { ok: false, code: 'INFORMATION_REQUIRED', message: 'Some required information is still missing', missingFields: missing };
    }
    return this.startAutomation(row, clientIp, null, false);
  }

  /**
   * The applicant provided the verification code. Handed to the live workflow (after its address is
   * finalised), or held in memory until then. If no workflow is running (a retry, or a client that
   * skipped app.address_completed) one is started first. The code is never persisted.
   */
  provideVerification(id: string, code: unknown, clientIp?: string): Result {
    const row = this.store.get(id);
    if (!row) return { ok: false, code: 'UNAUTHENTICATED', message: 'Unknown application' };
    if (typeof code !== 'string' || normalizeCode(code) === '' || code.length > MAX_CODE_LEN) return { ok: false, code: 'BAD_REQUEST', message: 'A verification code is required' };
    if (row.state === 'link_ready' || row.state === 'completed') return { ok: false, code: 'INVALID_STATE', message: 'Your application has already been processed' };
    const rt = this.runtimeOf(row);
    if (rt && row.workflow_id) {
      if (rt.codeInjected || rt.pendingCode !== null) return { ok: false, code: 'INVALID_STATE', message: 'Your verification code was already received' };
      if (rt.addressFinalized) this.injectCode(rt, row.workflow_id, normalizeCode(code));
      else { rt.pendingCode = normalizeCode(code); this.tl.child(row.workflow_id).mark('verification code received early, held until the address is finalized'); }
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
    return this.startAutomation(row, clientIp, normalizeCode(code), true);
  }

  /** Reserve a profile and seed every non-secret Website B field. The code, if already known, waits in the runtime. */
  private startAutomation(row: ApplicationRow, clientIp: string | undefined, code: string | null, addressCompleted: boolean): Result {
    if (this.writeOnlyFields().length !== 1) {
      // The config is the contract: this bridge injects exactly one write-only field with the code.
      this.tl.mark('application cannot start automation', `config has ${this.writeOnlyFields().length} write-only field(s), expected 1`);
      return { ok: false, code: 'INVALID_STATE', message: 'Processing is not available right now' };
    }
    const id = row.id;
    const { workflowId, queuePosition } = this.registry.startWorkflow(clientIp, id);
    const attempts = row.workflow_count + 1;
    this.store.patch(id, {
      state: 'processing', workflow_id: workflowId, workflow_count: attempts, verification_step: 'required',
      problem_code: null, problem_message: null, problem_at: null,
    });
    this.store.event(id, 'automation_started', { workflowId, step: row.current_step, retryCount: attempts - 1, detail: `${queuePosition ? `queued at position ${queuePosition}` : 'profile reserved'}${addressCompleted ? '' : '; started early at the address step'}` });
    if (queuePosition) this.store.event(id, 'automation_waiting_for_capacity', { workflowId, detail: `queue position ${queuePosition}` });
    this.tl.child(workflowId).mark('application automation started', `application ${id.slice(0, 8)}, attempt ${attempts}${queuePosition ? `, queued #${queuePosition}` : ''}`);

    const rt: Runtime = {
      applicationId: id, phase: 'preparing', seeded: new Set(), resolved: new Set(), sent: new Map(), seq: 0, ready: false, addressCompleted, finalizing: false, addressFinalized: false,
      pendingCode: code, codeInjected: false, submitted: false, submittingReported: false, fallbackTimer: null, leaveTimer: null, leftByApplicant: false, lastError: null,
    };
    this.runtimes.set(workflowId, rt);
    // every known field now; an early start leaves the address fields for the live updates that follow
    for (const field of this.requiredFields()) { const v = this.value(row, field); if (addressCompleted || v.trim() !== '') this.forward(rt, workflowId, field, v); }
    this.progress(id, 'automation_started');
    this.emit(id);
    return { ok: true };
  }

  /** Hand the code to the live workflow (write-only field, masked handling) and arm the submit fallback. */
  private injectCode(rt: Runtime, workflowId: string, code: string): void {
    const field = this.writeOnlyFields()[0];
    rt.codeInjected = true;
    rt.pendingCode = null;
    this.setPhase(rt, workflowId, 'submitting');
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
    if (!rt || !wf || rt.finalizing || rt.addressFinalized) return;
    rt.finalizing = true;
    try {
      const r = await wf.finalizeAddress();
      if (r === 'not-ready' || !this.runtimes.has(workflowId)) { rt.finalizing = false; return; }
    } catch (e) {
      this.tl.child(workflowId).mark('address finalization failed, submit will verify strictly', e instanceof Error ? e.message : String(e));
    }
    rt.addressFinalized = true;
    this.store.event(rt.applicationId, 'address_finalized', { workflowId });
    this.progress(rt.applicationId, 'address_finalized');
    if (rt.pendingCode !== null) this.injectCode(rt, workflowId, rt.pendingCode);
    else this.setPhase(rt, workflowId, 'awaiting_code');
    this.emit(rt.applicationId);
  }

  private setPhase(rt: Runtime, workflowId: string, phase: Runtime['phase']): void {
    if (rt.phase === phase) return;
    rt.phase = phase;
    this.store.event(rt.applicationId, 'automation_phase_changed', { workflowId, detail: phase });
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
      // The click is the applicant's action and is recorded as such even when Website B already verified.
      this.store.event(id, 'final_cta_clicked', { workflowId: row.workflow_id, step: row.current_step });
      this.store.event(id, 'visited', { workflowId: row.workflow_id, detail: row.link_state === 'verified' ? 'already verified' : undefined });
      this.progress(id, 'visited');
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
            rt.ready = true;
            this.store.event(id, 'automation_ready', { workflowId, detail: rt.addressCompleted ? undefined : 'started early; waiting for the applicant to complete the address' });
            this.progress(id, 'automation_ready');
            // Next tick: the workflow starts draining the seeded fields right after it announces READY;
            // finalizeAddress() waits for that drain so the tested order (fields, then address) is kept.
            // An early start waits here until app.address_completed arrives (addressCompleted() finalises then).
            if (rt.addressCompleted) setImmediate(() => void this.finalizeAddressFor(workflowId));
            else this.tl.child(workflowId).mark('ready before the address', 'fields typed as they arrive; the address is finalised once the applicant confirms it');
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
        const asg = this.profiles.getAssignment(workflowId);
        const prof = asg ? this.profiles.get(asg.profile_id) : undefined;
        this.store.patch(id, {
          state: 'link_ready', generated_url: m.url, generated_url_ready_at: row.generated_url_ready_at ?? m.ts,
          verification_step: 'completed', problem_code: null, problem_message: null, problem_at: null,
          processed_workflow_id: workflowId, processed_profile_id: asg?.profile_id ?? null, processed_profile_label: prof?.label ?? null,
        });
        this.store.event(id, 'generated_link_ready', { workflowId });
        if (this.presence(id) === 0) this.store.event(id, 'link_ready_unattended', { workflowId, detail: 'no applicant page connected when the link became ready' });
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
    this.adminNotify('verified');
  }

  /** After a successful run: was the account's refreshed session persisted? Internal event only; never shown to the applicant. */
  private onSessionResult(workflowId: string, profileId: string, result: 'refreshed' | 'failed'): void {
    const row = this.store.byProcessedWorkflow(workflowId);
    const label = this.profiles.get(profileId)?.label ?? row?.processed_profile_label ?? profileId;
    if (row) this.store.event(row.id, result === 'refreshed' ? 'session_refreshed' : 'session_persist_failed', { workflowId, code: result === 'failed' ? 'SESSION_PERSIST_FAILED' : undefined, detail: `account ${label}` });
    this.adminNotify('accounts');
  }

  // ---------- admin (internal) ----------

  /** Verified applications for the operations page: safe fields, the account that processed each one, session health. Never the session itself. */
  verifiedList(q: string, offset: number, limit: number): { total: number; items: VerifiedApplicationItem[]; waitStats: ReturnType<ApplicationStore['waitStats']> } {
    const { total, rows } = this.store.listVerified(q, offset, limit);
    return { total, items: rows.map((r) => this.verifiedItem(r)), waitStats: this.store.waitStats() };
  }

  private verifiedItem(r: ApplicationRow): VerifiedApplicationItem {
    const profile = r.processed_profile_id ? this.profiles.get(r.processed_profile_id) : undefined;
    const asg = r.processed_workflow_id ? this.profiles.getAssignment(r.processed_workflow_id) : undefined;
    const meta = profile ? this.profiles.accountMeta(profile) : null;
    let answers: Record<string, unknown> = {};
    try { answers = JSON.parse(r.answers_json) ?? {}; } catch { answers = {}; }
    const events = this.store.events(r.id, 200);
    const sessionEvent = events.find((e) => e.type === 'session_refreshed' || e.type === 'session_persist_failed');
    return {
      id: r.id,
      displayId: `APP-${r.id.slice(0, 6).toUpperCase()}`,
      fullName: [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)',
      email: r.email,
      createdAt: r.created_at, generatedUrlReadyAt: r.generated_url_ready_at, finalLinkClickedAt: r.final_link_clicked_at, visitedAt: r.visited_at, verifiedAt: r.verified_at,
      workflowId: r.processed_workflow_id,
      workflowOutcome: asg ? `${asg.state}${asg.outcome_code ? ' (' + asg.outcome_code + ')' : ''}` : null,
      egress: asg?.egress_id ? { id: asg.egress_id, label: this.profiles.egress.get(asg.egress_id)?.label ?? '(removed egress)' } : null,
      processedWith: r.processed_profile_id
        ? { profileId: r.processed_profile_id, label: profile?.label ?? r.processed_profile_label ?? '(removed account)', exists: !!profile,
            sessionStatus: meta?.sessionStatus ?? 'none', sessionNote: meta?.sessionNote ?? null, sessionSavedAt: meta?.sessionSavedAt ?? null, lastUsedAt: meta?.lastUsedAt ?? null,
            reservation: meta?.reservation ? { state: meta.reservation.state, applicationId: meta.reservation.applicationId } : null }
        : null,
      sessionResult: sessionEvent ? (sessionEvent.type === 'session_refreshed' ? 'refreshed' : 'failed') : null,
      wait: (() => {
        const chrono = [...events].reverse(); // oldest first
        const codeAt = chrono.find((e) => e.type === 'verification_received')?.at ?? chrono.find((e) => e.type === 'address_completed')?.at ?? null;
        const hidden = chrono.find((e) => e.type === 'wait_hidden');
        const leftAfter = hidden?.detail ? Number(/after (\d+) ms/.exec(hidden.detail)?.[1] ?? NaN) : NaN;
        return {
          waitedMs: r.generated_url_ready_at !== null && codeAt !== null ? Math.max(0, r.generated_url_ready_at - codeAt) : null,
          left: !!hidden, leftAfterMs: Number.isFinite(leftAfter) ? leftAfter : null,
          cameBack: chrono.some((e) => e.type === 'wait_visible'),
          unattendedAtReady: chrono.some((e) => e.type === 'link_ready_unattended'),
          openedLink: r.final_link_clicked_at !== null,
        };
      })(),
      answers,
    };
  }

  /** The workflow ended without verification. Before the link: a problem the applicant can retry. After it: the link stands. */
  private terminal(rt: Runtime, workflowId: string, state: 'failed' | 'abandoned', detail?: string): void {
    const row = this.store.get(rt.applicationId);
    if (!row) return;
    if (rt.leftByApplicant && state === 'abandoned' && row.state === 'processing') {
      // not a problem for the applicant: the application simply waits at its saved step; a new workflow starts when they return
      this.store.patch(rt.applicationId, { state: 'started', workflow_id: null, verification_step: 'required' });
      this.store.event(rt.applicationId, 'applicant_left', { workflowId, step: row.current_step, detail: 'page gone before the code was handed over; workflow ended, account freed' });
      this.emit(rt.applicationId);
      return;
    }
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
    if (rt.leaveTimer) clearTimeout(rt.leaveTimer);
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

/** The verification code as Website B expects it: the message shows it as 482-16-7304; the dashes and spaces are not part of the code. */
function normalizeCode(code: string): string { return code.replace(/[\s\u2010-\u2015-]/g, ''); }
