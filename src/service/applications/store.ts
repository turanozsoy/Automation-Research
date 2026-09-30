import { randomUUID } from 'node:crypto';
import type { ApplicationEventType, ApplicationState, LinkState, VerificationStep } from '../../shared/messages.js';
import type { Db } from '../db.js';
import { hashSessionToken, newSessionToken } from './session.js';

export interface ApplicationRow {
  id: string;
  session_token_hash: string;
  state: ApplicationState;
  current_step: string;
  first_name: string | null; last_name: string | null; email: string | null; phone: string | null; date_of_birth: string | null;
  address1: string | null; city: string | null; address_state: string | null; zip: string | null;
  answers_json: string;
  verification_step: VerificationStep;
  workflow_id: string | null;
  workflow_count: number;
  generated_url: string | null;
  generated_url_ready_at: number | null;
  final_link_clicked_at: number | null;
  link_state: LinkState;
  visited_at: number | null;
  verified_at: number | null;
  problem_code: string | null;
  problem_message: string | null;
  problem_at: number | null;
  processed_workflow_id: string | null;
  processed_profile_id: string | null;
  processed_profile_label: string | null;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
}

export interface ApplicationEventRow {
  id: number; application_id: string; workflow_id: string | null; type: ApplicationEventType;
  step: string | null; stage: string | null; code: string | null; message: string | null; detail: string | null; retry_count: number | null; at: number;
}

export interface EventOpts { workflowId?: string | null; step?: string; stage?: string; code?: string; message?: string; detail?: string; retryCount?: number }

/**
 * Website B field name (config key) -> applications column. `email` is Shipzora-only and has no
 * Website B counterpart. The write-only verification code has NO column on purpose.
 */
export const FIELD_COLUMNS = {
  firstName: 'first_name',
  lastName: 'last_name',
  dateOfBirth: 'date_of_birth',
  mobileNumber: 'phone',
  address1: 'address1',
  city: 'city',
  state: 'address_state',
  zip: 'zip',
  email: 'email',
} as const satisfies Record<string, keyof ApplicationRow>;
export type StorableField = keyof typeof FIELD_COLUMNS;

/** Columns a caller may patch directly. Never the token hash, never the id. */
const PATCHABLE = new Set<keyof ApplicationRow>([
  'state', 'current_step', 'verification_step', 'workflow_id', 'workflow_count', 'generated_url', 'generated_url_ready_at',
  'final_link_clicked_at', 'link_state', 'visited_at', 'verified_at', 'problem_code', 'problem_message', 'problem_at', 'answers_json', 'last_activity_at',
  'processed_workflow_id', 'processed_profile_id', 'processed_profile_label',
]);

/**
 * Persistence for Shipzora applications and their event history. Separate from the profile /
 * assignment tables: an application outlives any workflow and may go through several of them.
 */
export class ApplicationStore {
  constructor(private db: Db) {}

  /** New application + the applicant's session token. Only the token's hash is stored. */
  create(step = 'start'): { row: ApplicationRow; token: string } {
    const id = randomUUID();
    const token = newSessionToken();
    const now = Date.now();
    this.db.prepare(`INSERT INTO applications (id, session_token_hash, state, current_step, created_at, updated_at, last_activity_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, hashSessionToken(token), 'started', step, now, now, now);
    this.event(id, 'application_started', { step });
    return { row: this.get(id)!, token };
  }

  /** The application a session token belongs to, or undefined. */
  authenticate(token: string): ApplicationRow | undefined {
    return this.db.prepare('SELECT * FROM applications WHERE session_token_hash = ?').get(hashSessionToken(token)) as ApplicationRow | undefined;
  }

  get(id: string): ApplicationRow | undefined {
    return this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as ApplicationRow | undefined;
  }

  byWorkflow(workflowId: string): ApplicationRow | undefined {
    return this.db.prepare('SELECT * FROM applications WHERE workflow_id = ?').get(workflowId) as ApplicationRow | undefined;
  }

  byProcessedWorkflow(workflowId: string): ApplicationRow | undefined {
    return this.db.prepare('SELECT * FROM applications WHERE processed_workflow_id = ?').get(workflowId) as ApplicationRow | undefined;
  }

  /** Verified applications, newest first, optional search on full name or application id (prefix / substring). */
  listVerified(q: string, offset: number, limit: number): { total: number; rows: ApplicationRow[] } {
    const needle = q.trim().toLowerCase().replace(/^app-/, '');
    const where = needle
      ? "link_state = 'verified' AND (lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) LIKE ? OR lower(id) LIKE ?)"
      : "link_state = 'verified'";
    const params = needle ? [`%${needle}%`, `${needle}%`] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM applications WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM applications WHERE ${where} ORDER BY verified_at DESC, created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as ApplicationRow[];
    return { total, rows };
  }

  listRecent(limit = 30): ApplicationRow[] {
    return this.db.prepare('SELECT * FROM applications ORDER BY created_at DESC LIMIT ?').all(limit) as ApplicationRow[];
  }

  /** Save applicant fields (keys are Website B field names / `email`). Unknown keys are ignored here; validate before calling. */
  updateFields(id: string, fields: Partial<Record<StorableField, string>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = FIELD_COLUMNS[k as StorableField];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      values.push(v);
    }
    if (!sets.length) return;
    const now = Date.now();
    this.db.prepare(`UPDATE applications SET ${sets.join(', ')}, updated_at = ?, last_activity_at = ? WHERE id = ?`).run(...values, now, now, id);
  }

  mergeAnswers(id: string, answers: Record<string, unknown>): void {
    const row = this.get(id);
    if (!row) return;
    let current: Record<string, unknown> = {};
    try { current = JSON.parse(row.answers_json) ?? {}; } catch { current = {}; }
    this.patch(id, { answers_json: JSON.stringify({ ...current, ...answers }) });
  }

  /** Generic column patch; touches updated_at and last_activity_at. */
  patch(id: string, cols: Partial<ApplicationRow>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(cols)) {
      if (!PATCHABLE.has(k as keyof ApplicationRow)) throw new Error(`column ${k} is not patchable`);
      sets.push(`${k} = ?`);
      values.push(v);
    }
    const now = Date.now();
    sets.push('updated_at = ?', 'last_activity_at = ?');
    values.push(now, now);
    this.db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  touch(id: string): void {
    const now = Date.now();
    this.db.prepare('UPDATE applications SET last_activity_at = ? WHERE id = ?').run(now, id);
  }

  event(id: string, type: ApplicationEventType, o: EventOpts = {}): void {
    this.db.prepare(`INSERT INTO application_events (application_id, workflow_id, type, step, stage, code, message, detail, retry_count, at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, o.workflowId ?? null, type, o.step ?? null, o.stage ?? null, o.code ?? null, o.message ?? null, o.detail ?? null, o.retryCount ?? null, Date.now());
  }

  events(id: string, limit = 50): ApplicationEventRow[] {
    return this.db.prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY id DESC LIMIT ?').all(id, limit) as ApplicationEventRow[];
  }

  /** Applications that were mid-automation when the service died. Their workflows are gone. */
  processing(): ApplicationRow[] {
    return this.db.prepare("SELECT * FROM applications WHERE state = 'processing'").all() as ApplicationRow[];
  }
}
