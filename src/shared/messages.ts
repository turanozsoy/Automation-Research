/**
 * Messages exchanged between a Website A client (the local test page for now) and
 * the automation service over one WebSocket. Every message carries `ts` (ms epoch,
 * sender clock). Messages about a workflow carry `workflowId`; a client only acts on
 * messages for workflows it started.
 */

export type WorkflowState =
  | 'allocating'     // waiting for / reserving a profile
  | 'preparing'      // context created, Website B loading, session verified, Recommended clicked, fields resolved
  | 'ready'          // live field sync active
  | 'submitting'     // final action in progress
  | 'paused'         // a submit step failed; user may retry it, skip it (done manually), or abort
  | 'link_ready'     // generated URL delivered; waiting for the user to open it / the success text
  | 'visited'        // user opened the link; still watching Website B for the success text
  | 'completed'      // success text seen on Website B (verified); workflow closed
  | 'failed'         // unrecoverable; profile released
  | 'abandoned';     // ended by the client or idle timeout

export type ErrorCode =
  | 'LOGIN_REQUIRED'
  | 'NO_PROFILE_AVAILABLE'
  | 'RECOMMENDED_NOT_FOUND'
  | 'FIELD_NOT_FOUND'
  | 'FIELD_FILL_FAILED'
  | 'UNKNOWN_FIELD'
  | 'RECONCILE_MISMATCH'
  | 'SUBMIT_BUTTON_NOT_FOUND'
  | 'AGREE_NOT_FOUND'
  | 'IFRAME_NOT_FOUND'
  | 'TOGGLE_NOT_FOUND'
  | 'TOGGLE_STATE_FAILED'
  | 'PRIMARY_NOT_FOUND'
  | 'SECONDARY_NOT_FOUND'
  | 'ADDRESS_NOT_ACCEPTED'
  | 'ADDRESS_MISMATCH'
  | 'URL_TIMEOUT'
  | 'EGRESS_FAILED'
  | 'BROWSER_CLOSED'
  | 'INVALID_STATE'
  | 'UNKNOWN_WORKFLOW'
  | 'INTERNAL';

// ---- client -> service ----

export interface WorkflowStartMsg { type: 'workflow.start'; ts: number; clientIp?: string }
export interface FieldUpdateMsg { type: 'field.update'; ts: number; workflowId: string; field: string; value: string; seq: number }
export interface SubmitMsg { type: 'submit'; ts: number; workflowId: string; snapshot: Record<string, string> }
/** After a pause: 'retry' runs the failed step again, 'skip' continues with the next step (you did it by hand), 'abort' fails the workflow. */
export interface ResumeMsg { type: 'resume'; ts: number; workflowId: string; mode: 'retry' | 'skip' | 'abort' }
export interface WorkflowEndMsg { type: 'workflow.end'; ts: number; workflowId: string; reason?: string }
/** The user clicked the button that opens the generated link. */
export interface LinkOpenedMsg { type: 'link.opened'; ts: number; workflowId: string }
export interface PingMsg { type: 'ping'; ts: number }

export type ClientMsg = WorkflowStartMsg | FieldUpdateMsg | SubmitMsg | ResumeMsg | WorkflowEndMsg | LinkOpenedMsg | PingMsg;

// ---- service -> client ----

export interface PoolStatus {
  total: number; available: number; live: number; cooldown: number; expired: number; invalid: number; disabled: number;
  /** Accounts held after an applicant opened the role link (operator decides) / taken by a verified applicant. */
  review: number; taken: number;
  /** Accounts that exist but have no saved session yet. */
  noSession: number;
  /** ms until the earliest cooling-down account is available again, or null. */
  nextAvailableInMs: number | null;
  queued: number; maxWorkflows: number;
}

export interface HelloMsg {
  type: 'hello'; ts: number;
  debounceMs: number; fields: string[]; targetUrl: string;
  /** Fields whose value must never appear in logs (masked by Website B). */
  writeOnlyFields: string[];
  /** Fields kept locally and applied only at submit (e.g. address autocomplete). */
  deferredFields: string[];
  pool: PoolStatus;
}
export interface WorkflowAcceptedMsg { type: 'workflow.accepted'; ts: number; workflowId: string; queuePosition?: number }
export interface StateMsg { type: 'state'; ts: number; workflowId: string; state: WorkflowState; detail?: string }
export interface EventMsg { type: 'event'; ts: number; workflowId?: string; name: string; detail?: string; sinceLastMs?: number }
export interface FieldAckMsg {
  type: 'field.ack'; ts: number; workflowId: string; field: string; seq: number;
  sentAt: number; receivedAt: number; startedAt: number; filledAt: number; value: string;
}
export interface FieldDeferredMsg { type: 'field.deferred'; ts: number; workflowId: string; field: string; seq: number }
export interface FieldErrorMsg { type: 'field.error'; ts: number; workflowId: string; field: string; seq: number; code: ErrorCode; message: string }
export interface ResultMsg { type: 'result'; ts: number; workflowId: string; url: string; source: string; submitRequestedAt: number }
export interface ErrorMsg { type: 'error'; ts: number; workflowId?: string; code: ErrorCode; message: string; fatal: boolean }
/** Sent when a submit step fails and the workflow waits for the user's decision. */
export interface PausedMsg { type: 'paused'; ts: number; workflowId: string; step: string; stepIndex: number; steps: string[]; code: ErrorCode; message: string }
export interface PoolStatusMsg { type: 'pool.status'; ts: number; pool: PoolStatus }
export interface PongMsg { type: 'pong'; ts: number; echo: number }

export type ServerMsg = HelloMsg | WorkflowAcceptedMsg | StateMsg | EventMsg | FieldAckMsg | FieldDeferredMsg | FieldErrorMsg | ResultMsg | ErrorMsg | PausedMsg | PoolStatusMsg | PongMsg;

// ===========================================================================
// Applicant protocol (/ws/app). Authenticated by the first-party session cookie.
// An applicant socket only ever receives its own application; nothing about
// workflows, profiles, the pool or Website B internals crosses this boundary.
// ===========================================================================

/** Shipzora application state (distinct from workflow state and profile state). */
export type ApplicationState =
  | 'started'      // applicant is filling in the application; no automation, no profile reserved
  | 'processing'   // all Website B information is available; a workflow is running (or queued) in the background
  | 'link_ready'   // the generated link is available to the applicant
  | 'completed'    // Website B confirmed success (verified)
  | 'problem';     // the automation could not finish; the applicant may retry (verification code required again)

export type VerificationStep = 'required' | 'completed' | 'failed';
export type LinkState = 'none' | 'visited' | 'verified';

export type ApplicationEventType =
  | 'application_started' | 'step_viewed' | 'step_completed' | 'fields_updated' | 'information_required' | 'validation_failed' | 'address_completed'
  | 'automation_started' | 'automation_waiting_for_capacity' | 'automation_ready' | 'automation_phase_changed' | 'address_finalized' | 'verification_received' | 'automation_submitting' | 'automation_ended'
  | 'generated_link_ready' | 'final_step_reached' | 'problem' | 'final_cta_clicked' | 'visited' | 'verified' | 'service_restarted'
  | 'session_refreshed' | 'session_persist_failed'
  // waiting-screen analytics: the applicant saw the preparing screen, left it (tab hidden or page closed), came back;
  // link_ready_unattended = the link became ready while no applicant socket was connected
  | 'wait_shown' | 'wait_hidden' | 'wait_visible' | 'link_ready_unattended';

/** Everything an applicant is allowed to see about their own application. */
export interface ApplicationView {
  id: string;
  state: ApplicationState;
  currentStep: string;
  fields: Record<string, string>;
  answers: Record<string, unknown>;
  verificationStep: VerificationStep;
  /** Fields still missing before the automation can start (Website B field names). */
  missingFields: string[];
  /**
   * phase: null when no workflow is running; `preparing` (profile reserved, onboarding page opening, fields seeding),
   * `awaiting_code` (address finalised, waiting for the verification code), `submitting` (code received, submit sequence running).
   */
  automation: { active: boolean; attempts: number; phase: 'preparing' | 'awaiting_code' | 'submitting' | null };
  generatedUrl: string | null;
  generatedUrlReadyAt: number | null;
  linkState: LinkState;
  finalLinkClickedAt: number | null;
  problem: { code: string; message: string; at: number } | null;
  createdAt: number;
  updatedAt: number;
}

export type ApplicantErrorCode = 'UNAUTHENTICATED' | 'INVALID_FIELD' | 'INFORMATION_REQUIRED' | 'INVALID_STATE' | 'BAD_REQUEST';

// ---- applicant -> service ----
/** Save non-secret application fields (Website B field names plus `email`). The verification code is refused here. */
export interface AppUpdateMsg { type: 'app.update'; ts: number; fields: Record<string, string> }
/** Save job/application answers (free-form JSON, merged). */
export interface AppAnswersMsg { type: 'app.answers'; ts: number; answers: Record<string, unknown> }
/** The applicant moved to a step; optionally names the step they just completed. `final` marks the last screen (final_step_reached). */
export interface AppStepMsg { type: 'app.step'; ts: number; step: string; completedStep?: string; final?: boolean }
/** Local validation stopped the applicant on a step; field names only, never values. */
export interface AppValidationFailedMsg { type: 'app.validation_failed'; ts: number; step: string; fields: string[] }
/**
 * The applicant completed the address step (all Website B fields except the code are saved). Starts and
 * prepares the onboarding workflow in the background: profile, page, seeded fields, address finalisation.
 * The applicant can move on to the verification-code step immediately. Idempotent while a workflow is live.
 */
export interface AppAddressCompletedMsg { type: 'app.address_completed'; ts: number }
/**
 * The verification code. Held only in memory, handed to the live workflow, never persisted or logged.
 * Continues the submit sequence; if no workflow is running yet (e.g. a retry), it starts one first.
 */
export interface AppVerifyMsg { type: 'app.verify'; ts: number; code: string }
/** The applicant clicked the final call to action that opens the generated link. */
export interface AppLinkOpenedMsg { type: 'app.link_opened'; ts: number }
/** The applicant is waiting for the role-details link: the waiting screen was shown, left (tab hidden / page closed) or shown again. */
export interface AppWaitMsg { type: 'app.wait'; ts: number; event: 'shown' | 'hidden' | 'visible'; elapsedMs?: number }
export interface AppPingMsg { type: 'ping'; ts: number }
export type AppClientMsg = AppUpdateMsg | AppAnswersMsg | AppStepMsg | AppValidationFailedMsg | AppAddressCompletedMsg | AppVerifyMsg | AppLinkOpenedMsg | AppWaitMsg | AppPingMsg;

// ---- service -> applicant ----
/** Full safe snapshot; sent on connect and after every change. */
export interface AppStateMsg { type: 'app.state'; ts: number; application: ApplicationView }
/** Safe progress notification (also reflected in the snapshot). */
export interface AppProgressMsg { type: 'app.progress'; ts: number; event: ApplicationEventType; step?: string }
export interface AppErrorMsg { type: 'app.error'; ts: number; code: ApplicantErrorCode; message: string; missingFields?: string[] }
export interface AppPongMsg { type: 'pong'; ts: number; echo: number }
export type AppServerMsg = AppStateMsg | AppProgressMsg | AppErrorMsg | AppPongMsg;
