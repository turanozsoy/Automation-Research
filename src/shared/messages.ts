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
  | 'completed'      // generated URL captured
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
  | 'URL_TIMEOUT'
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
export interface PingMsg { type: 'ping'; ts: number }

export type ClientMsg = WorkflowStartMsg | FieldUpdateMsg | SubmitMsg | ResumeMsg | WorkflowEndMsg | PingMsg;

// ---- service -> client ----

export interface PoolStatus { total: number; available: number; live: number; cooldown: number; expired: number; invalid: number; disabled: number; queued: number; maxWorkflows: number }

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
