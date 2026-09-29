/**
 * Messages exchanged between the local test page (Website A stand-in) and the
 * automation service over one WebSocket. Every message carries `ts` (ms epoch,
 * sender clock). Both ends run on the same machine in Phase 1, so timestamps
 * are directly comparable.
 */

export type WorkflowState =
  | 'booting'        // browser launching, Website B loading
  | 'awaiting_user'  // Website B open; user logs in / navigates manually, then presses Start
  | 'starting'       // Recommended link clicked, field selectors resolving
  | 'ready'          // fields resolved, live field sync active
  | 'submitting'     // final action in progress
  | 'completed'      // generated URL captured
  | 'failed';        // a required step failed; use Reset

export type ErrorCode =
  | 'LOGIN_REQUIRED'
  | 'RECOMMENDED_NOT_FOUND'
  | 'FIELD_NOT_FOUND'
  | 'FIELD_FILL_FAILED'
  | 'UNKNOWN_FIELD'
  | 'RECONCILE_MISMATCH'
  | 'SUBMIT_BUTTON_NOT_FOUND'
  | 'IFRAME_NOT_FOUND'
  | 'TOGGLE_NOT_FOUND'
  | 'TOGGLE_STATE_FAILED'
  | 'PRIMARY_NOT_FOUND'
  | 'SECONDARY_NOT_FOUND'
  | 'ADDRESS_SUGGESTION_NOT_FOUND'
  | 'ADDRESS_SUGGESTION_AMBIGUOUS'
  | 'URL_TIMEOUT'
  | 'BROWSER_CLOSED'
  | 'INVALID_STATE'
  | 'INTERNAL';

// ---- client -> service ----

export interface StartMsg { type: 'start'; ts: number }
export interface FieldUpdateMsg { type: 'field.update'; ts: number; field: string; value: string; seq: number }
export interface SubmitMsg { type: 'submit'; ts: number; snapshot: Record<string, string> }
export interface ResetMsg { type: 'reset'; ts: number }
export interface PingMsg { type: 'ping'; ts: number }

export type ClientMsg = StartMsg | FieldUpdateMsg | SubmitMsg | ResetMsg | PingMsg;

// ---- service -> client ----

export interface HelloMsg {
  type: 'hello'; ts: number;
  state: WorkflowState; debounceMs: number; fields: string[]; targetUrl: string;
  /** Fields whose value must never appear in logs (masked by Website B). */
  writeOnlyFields: string[];
  /** Fields kept locally and applied only at submit (e.g. address autocomplete). */
  deferredFields: string[];
}
export interface StateMsg { type: 'state'; ts: number; state: WorkflowState; detail?: string }
export interface EventMsg { type: 'event'; ts: number; name: string; detail?: string; sinceLastMs?: number }
export interface FieldAckMsg {
  type: 'field.ack'; ts: number; field: string; seq: number;
  sentAt: number; receivedAt: number; startedAt: number; filledAt: number; value: string;
}
export interface FieldDeferredMsg { type: 'field.deferred'; ts: number; field: string; seq: number }
export interface FieldErrorMsg { type: 'field.error'; ts: number; field: string; seq: number; code: ErrorCode; message: string }
export interface ResultMsg { type: 'result'; ts: number; url: string; source: string; submitRequestedAt: number }
export interface ErrorMsg { type: 'error'; ts: number; code: ErrorCode; message: string; fatal: boolean }
export interface PongMsg { type: 'pong'; ts: number; echo: number }

export type ServerMsg = HelloMsg | StateMsg | EventMsg | FieldAckMsg | FieldDeferredMsg | FieldErrorMsg | ResultMsg | ErrorMsg | PongMsg;
