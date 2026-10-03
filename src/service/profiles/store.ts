import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { Vault } from '../crypto.js';
import { EgressStore } from '../egress/store.js';

export type ProfileState = 'available' | 'reserved' | 'starting' | 'active' | 'cooldown' | 'expired' | 'invalid' | 'disabled' | 'review' | 'taken';
export type AssignmentState = 'allocating' | 'preparing' | 'ready' | 'submitting' | 'paused' | 'completed' | 'failed' | 'abandoned' | 'lost' | 'uncertain';
export type ReleaseOutcome = 'completed' | 'abandoned' | 'failed' | 'auth_expired' | 'invalid' | 'lost' | 'uncertain';

export interface ProfileRow {
  id: string; label: string; account_key: string; state: ProfileState;
  storage_state_enc: Buffer; nonce: Buffer; data_key_enc: Buffer; key_version: number;
  needs_verify: number; cooldown_until: number | null; last_verified_at: number | null; last_used_at: number | null;
  use_count: number; consecutive_failures: number; state_reason: string | null; created_at: number; updated_at: number;
  session_saved_at: number | null; proxy_json: string | null; session_note: string | null;
  egress_id: string | null; egress_bound_at: number | null;
  reserved_for_application_id: string | null; reserved_at: number | null;
}

/** Safe, cookie-free view of an account for Website A's management page. */
export interface AccountMeta {
  id: string; name: string; email: string; hasSession: boolean;
  createdAt: number; sessionSavedAt: number | null; lastUsedAt: number | null; lastVerifiedAt: number | null;
  /** Business status: 'expired' (session dead) or the latest workflow's link state, else 'none'. */
  status: 'expired' | 'visited' | 'verified' | 'none';
  /**
   * Saved-session health, never the session itself: none (no session), current (saved and not flagged),
   * attention (a run ended uncertain / lost or the refreshed session could not be persisted), expired (Website B rejected it).
   */
  sessionStatus: 'none' | 'current' | 'attention' | 'expired';
  sessionNote: string | null;
  lastWorkflowAt: number | null; lastUrl: string | null; stateReason: string | null;
  /** The proxy this account is bound to (reused for every run and login capture until the operator releases it). */
  proxy: { id: string; label: string; state: string; since: number | null } | null;
  /**
   * Out of rotation for an applicant: 'review' = the applicant opened the role link and the outcome is unknown until
   * the operator releases the account or marks it verified; 'taken' = verified, this applicant's account for good.
   */
  reservation: { state: 'review' | 'taken'; applicationId: string | null; since: number | null } | null;
}
export interface AssignmentRow {
  workflow_id: string; profile_id: string; state: AssignmentState; instance_id: string; lease_expires_at: number;
  client_ip: string | null; reassign_count: number; submit_state: string; idempotency_key: string | null;
  snapshot_hash: string | null; submitted_at: number | null; result_url: string | null; outcome_code: string | null;
  link_state: 'none' | 'visited' | 'verified'; visited_at: number | null; verified_at: number | null;
  egress_id: string | null; application_id: string | null; lease_token: string | null;
  created_at: number; updated_at: number; ended_at: number | null;
}
export interface PoolStatus { total: number; available: number; live: number; cooldown: number; expired: number; invalid: number; disabled: number; review: number; taken: number; noSession: number; nextAvailableInMs: number | null }

const LIVE: AssignmentState[] = ['allocating', 'preparing', 'ready', 'submitting', 'paused'];

/**
 * All profile/assignment persistence. Every mutation is a synchronous SQLite
 * transaction, so two concurrent workflow.start calls can never reserve the same
 * profile: the UPDATE selects exactly one 'available' row and flips it in one
 * statement, and the partial unique index on live assignments backs that up.
 */
export class ProfileStore {
  /** Egress rows live in the same database, so account + egress are acquired in ONE transaction. */
  readonly egress: EgressStore;
  /** False when Chromium was launched in per-context proxy mode (Windows): contexts without a proxy cannot work there. */
  private directAllowed = true;

  constructor(private db: Db, private vault: Vault, private instanceId: string) {
    this.egress = new EgressStore(db, vault);
  }

  setDirectAllowed(v: boolean): void { this.directAllowed = v; }
  isDirectAllowed(): boolean { return this.directAllowed; }

  // ---------- CRUD ----------

  insert(label: string, accountKey: string, storageStateJson: string): ProfileRow {
    const id = randomUUID();
    const e = this.vault.encrypt(id, storageStateJson);
    const now = Date.now();
    this.db.prepare(`INSERT INTO profiles (id,label,account_key,state,storage_state_enc,nonce,data_key_enc,key_version,session_saved_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, label, accountKey, 'available', e.ciphertext, e.nonce, e.dataKeyEnc, e.keyVersion, now, now, now);
    this.event(id, null, 'available', 'seeded');
    return this.get(id)!;
  }

  /** Create an account record with NO session yet (the manual login flow fills it in). */
  createAccount(name: string, email: string): ProfileRow {
    const id = randomUUID();
    const e = this.vault.encrypt(id, JSON.stringify({ cookies: [], origins: [] }));
    const now = Date.now();
    this.db.prepare(`INSERT INTO profiles (id,label,account_key,state,storage_state_enc,nonce,data_key_enc,key_version,session_saved_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,NULL,?,?)`).run(id, name, email, 'available', e.ciphertext, e.nonce, e.dataKeyEnc, e.keyVersion, now, now);
    this.event(id, null, 'available', 'account created (no session yet)');
    return this.get(id)!;
  }

  /** Store a freshly captured session for an account: encrypted, back in rotation, counters reset. */
  saveSession(id: string, storageStateJson: string): void {
    const p = this.get(id);
    if (!p) throw new Error(`account ${id} not found`);
    const e = this.vault.encrypt(id, storageStateJson);
    const now = Date.now();
    this.db.prepare(`UPDATE profiles SET storage_state_enc=?, nonce=?, data_key_enc=?, key_version=?, session_saved_at=?, last_verified_at=?,
      state=CASE WHEN state='disabled' THEN 'disabled' ELSE 'available' END, state_reason=NULL, session_note=NULL, consecutive_failures=0, needs_verify=0, cooldown_until=NULL, updated_at=? WHERE id=?`)
      .run(e.ciphertext, e.nonce, e.dataKeyEnc, e.keyVersion, now, now, now, id);
    this.event(id, p.state, this.get(id)!.state, 'session saved from manual login');
  }

  /** Metadata for the accounts page: never includes cookies. */
  listAccounts(): AccountMeta[] {
    const rows = this.db.prepare(`
      SELECT p.*, a.link_state AS link_state, a.created_at AS wf_at, a.result_url AS wf_url
      FROM profiles p
      LEFT JOIN assignments a ON a.workflow_id = (
        SELECT workflow_id FROM assignments WHERE profile_id = p.id ORDER BY created_at DESC LIMIT 1
      )
      ORDER BY p.created_at`).all() as (ProfileRow & { link_state: string | null; wf_at: number | null; wf_url: string | null })[];
    return rows.map((r) => this.accountMeta(r, r.link_state, r.wf_at, r.wf_url));
  }

  /** Safe metadata for one account (cookie-free). */
  accountMeta(r: ProfileRow, linkState: string | null = null, wfAt: number | null = null, wfUrl: string | null = null): AccountMeta {
    return {
      id: r.id, name: r.label, email: r.account_key, hasSession: r.session_saved_at !== null,
      createdAt: r.created_at, sessionSavedAt: r.session_saved_at, lastUsedAt: r.last_used_at, lastVerifiedAt: r.last_verified_at,
      status: r.state === 'expired' || r.state === 'invalid' ? 'expired' : linkState === 'verified' ? 'verified' : linkState === 'visited' ? 'visited' : 'none',
      sessionStatus: r.session_saved_at === null ? 'none' : r.state === 'expired' || r.state === 'invalid' ? 'expired' : r.needs_verify || r.session_note ? 'attention' : 'current',
      sessionNote: r.session_note,
      lastWorkflowAt: wfAt, lastUrl: wfUrl, stateReason: r.state_reason,
      proxy: (() => { const e = this.egress.boundEgressOf(r.id); return e ? { id: e.id, label: e.label, state: e.state, since: r.egress_bound_at } : null; })(),
      reservation: r.state === 'review' || r.state === 'taken' ? { state: r.state, applicationId: r.reserved_for_application_id, since: r.reserved_at } : null,
    };
  }

  /** Enable/disable holding accounts for review / taking them after verification (default on; ACCOUNT_RESERVE=0 for load tests). */
  setReserveAfterUse(v: boolean): void { this.reserveAfterUse = v; }
  private reserveAfterUse = true;

  /**
   * Operator decision on a held account: 'release' puts it back into rotation (cooldown skipped), 'verified' takes it
   * for the applicant. Allowed from review or taken (so a mistaken decision can be corrected).
   */
  reviewDecision(id: string, decision: 'release' | 'verified', by = 'operator'): void {
    const p = this.get(id);
    if (!p) throw new Error('account not found');
    if (p.state !== 'review' && p.state !== 'taken') throw new Error(`account is ${p.state}, not under review or taken`);
    const now = Date.now();
    if (decision === 'release') {
      this.db.prepare("UPDATE profiles SET state='available', state_reason=?, reserved_for_application_id=NULL, reserved_at=NULL, cooldown_until=NULL, updated_at=? WHERE id=?").run(`released by ${by}`, now, id);
      this.event(id, p.state, 'available', `released by ${by}${p.reserved_for_application_id ? ` (was held for application ${p.reserved_for_application_id.slice(0, 8)})` : ''}`);
    } else {
      this.db.prepare("UPDATE profiles SET state='taken', state_reason=?, reserved_at=COALESCE(reserved_at, ?), updated_at=? WHERE id=?").run(`verified by ${by}`, now, now, id);
      this.event(id, p.state, 'taken', `marked verified by ${by}`);
    }
  }

  /** Replace the storageState of an existing profile (re-seed) and put it back into rotation. */
  reseed(id: string, storageStateJson: string): void {
    const p = this.get(id);
    if (!p) throw new Error(`profile ${id} not found`);
    const e = this.vault.encrypt(id, storageStateJson);
    this.db.prepare(`UPDATE profiles SET storage_state_enc=?, nonce=?, data_key_enc=?, key_version=?, state='available', state_reason=NULL,
      consecutive_failures=0, needs_verify=0, cooldown_until=NULL, updated_at=? WHERE id=?`).run(e.ciphertext, e.nonce, e.dataKeyEnc, e.keyVersion, Date.now(), id);
    this.event(id, p.state, 'available', 'reseeded');
  }

  get(id: string): ProfileRow | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined;
  }
  byLabelOrId(ref: string): ProfileRow | undefined {
    return (this.db.prepare('SELECT * FROM profiles WHERE id = ? OR label = ? OR account_key = ?').get(ref, ref, ref) as ProfileRow | undefined);
  }
  list(): ProfileRow[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY created_at').all() as ProfileRow[];
  }
  remove(id: string): void {
    // the account's proxy stays held (the provider may still count the session); the operator releases it explicitly
    this.egress.unbindAccount(id, 'account removed');
    this.db.prepare('DELETE FROM assignments WHERE profile_id = ?').run(id);
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  decryptStorageState(p: ProfileRow): string {
    return this.vault.decrypt(p.id, { ciphertext: p.storage_state_enc, nonce: p.nonce, dataKeyEnc: p.data_key_enc, keyVersion: p.key_version });
  }

  /**
   * Replace the saved session with the storageState exported from a workflow's context after a
   * successful run (rotated cookies, new expiries, storage): same account, same record, re-encrypted.
   * Marks the session current and clears any persist-failure note.
   */
  refreshStorageState(id: string, storageStateJson: string, workflowId?: string): void {
    const e = this.vault.encrypt(id, storageStateJson);
    const now = Date.now();
    // Fenced: only the workflow whose assignment still names this account may write its session (a zombie after
    // reassignment or lease loss writes nothing).
    const r = workflowId
      ? this.db.prepare(`UPDATE profiles SET storage_state_enc=?, nonce=?, data_key_enc=?, key_version=?, session_saved_at=?, last_verified_at=?, session_note=NULL, updated_at=?
          WHERE id=? AND EXISTS (SELECT 1 FROM assignments WHERE workflow_id=? AND profile_id=?)`).run(e.ciphertext, e.nonce, e.dataKeyEnc, e.keyVersion, now, now, now, id, workflowId, id)
      : this.db.prepare(`UPDATE profiles SET storage_state_enc=?, nonce=?, data_key_enc=?, key_version=?, session_saved_at=?, last_verified_at=?, session_note=NULL, updated_at=? WHERE id=?`).run(e.ciphertext, e.nonce, e.dataKeyEnc, e.keyVersion, now, now, now, id);
    if (r.changes === 0) throw new Error('session write fenced: this workflow no longer holds the account');
    this.event(id, null, 'session_refreshed', 'session exported from the workflow context after a successful run', workflowId);
  }

  /** The refreshed session could not be exported/persisted: flag the account so an operator checks it. */
  markSessionPersistFailed(id: string, workflowId?: string, why?: string): void {
    this.db.prepare("UPDATE profiles SET session_note='SESSION_PERSIST_FAILED', needs_verify=1, updated_at=? WHERE id=?").run(Date.now(), id);
    this.event(id, null, 'session_persist_failed', why ?? 'storageState export failed after a successful run', workflowId);
  }

  /** Operator state changes (disable / enable / mark). */
  setState(id: string, state: ProfileState, reason: string): void {
    const p = this.get(id);
    if (!p) throw new Error(`profile ${id} not found`);
    this.db.prepare('UPDATE profiles SET state=?, state_reason=?, cooldown_until=NULL, updated_at=? WHERE id=?').run(state, reason, Date.now(), id);
    this.event(id, p.state, state, reason);
  }

  markVerified(id: string): void {
    this.db.prepare('UPDATE profiles SET last_verified_at=?, needs_verify=0, consecutive_failures=0, updated_at=? WHERE id=?').run(Date.now(), Date.now(), id);
  }

  // ---------- allocation ----------

  /**
   * Atomically reserve one available profile for a workflow. Returns the profile
   * and assignment, or null when none is available. Calling it again with the same
   * workflowId returns the existing assignment (idempotent).
   */
  reserve(workflowId: string, leaseMs: number, clientIp?: string, applicationId?: string): { profile: ProfileRow; assignment: AssignmentRow } | null {
    const now = Date.now();
    return this.db.transaction(() => {
      const existing = this.getAssignment(workflowId);
      if (existing && LIVE.includes(existing.state)) return { profile: this.get(existing.profile_id)!, assignment: existing };

      // Account first, then ITS egress: an account bound to a proxy reuses that proxy (never a new one); an unbound
      // account takes one unused proxy and binds it; direct only when allowed. An account whose proxy is down,
      // retired or in use is skipped, never given another proxy. Both resources or neither.
      const candidates = this.db.prepare(`
        SELECT id FROM profiles
        WHERE state='available' AND session_saved_at IS NOT NULL AND (cooldown_until IS NULL OR cooldown_until <= ?)
        ORDER BY CASE WHEN egress_id IS NOT NULL THEN 0 ELSE 1 END, last_used_at ASC NULLS FIRST, created_at ASC`).all(now) as { id: string }[];
      for (const c of candidates) {
        const pick = this.egress.pickForAccount(c.id, this.directAllowed);
        if (pick.id === null) {
          if (pick.blocked) this.event(c.id, null, 'skipped', `cannot run: ${pick.blocked}`, workflowId);
          continue;
        }
        const row = this.db.prepare(`UPDATE profiles SET state='reserved', last_used_at=?, use_count=use_count+1, updated_at=? WHERE id=? AND state='available' RETURNING *`).get(now, now, c.id) as ProfileRow | undefined;
        if (!row) continue;
        this.db.prepare(`INSERT INTO assignments (workflow_id,profile_id,state,instance_id,lease_expires_at,client_ip,egress_id,application_id,lease_token,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(workflowId, row.id, 'allocating', this.instanceId, now + leaseMs, clientIp ?? null, pick.id, applicationId ?? null, randomBytes(16).toString('hex'), now, now);
        this.egress.markInUse(pick.id, workflowId);
        this.event(row.id, 'available', 'reserved', 'allocated', workflowId);
        const egressLabel = this.egress.get(pick.id)?.label ?? pick.id;
        this.wfEvent(workflowId, null, 'allocating', `profile ${row.label}, egress ${egressLabel} (${pick.bound === 'reused' ? 'the account\'s own proxy, reused' : pick.bound === 'new' ? 'unused proxy, now bound to this account' : 'direct'})`);
        return { profile: row, assignment: this.getAssignment(workflowId)! };
      }
      return null;
    })();
  }

  getAssignment(workflowId: string): AssignmentRow | undefined {
    return this.db.prepare('SELECT * FROM assignments WHERE workflow_id = ?').get(workflowId) as AssignmentRow | undefined;
  }

  /** Move the workflow (and, where it follows, the profile) to the next live state. */
  setAssignmentState(workflowId: string, state: AssignmentState, reason?: string): void {
    const a = this.getAssignment(workflowId);
    if (!a) return;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('UPDATE assignments SET state=?, updated_at=? WHERE workflow_id=?').run(state, now, workflowId);
      this.wfEvent(workflowId, a.state, state, reason);
      const p = this.get(a.profile_id)!;
      const next: ProfileState | null = state === 'preparing' ? 'starting' : state === 'ready' ? 'active' : null;
      if (next && p.state !== next) {
        this.db.prepare('UPDATE profiles SET state=?, updated_at=? WHERE id=?').run(next, now, p.id);
        this.event(p.id, p.state, next, reason, workflowId);
      }
    })();
  }

  renewLease(workflowId: string, leaseMs: number): void {
    this.db.prepare('UPDATE assignments SET lease_expires_at=?, updated_at=? WHERE workflow_id=? AND state IN (' + LIVE.map(() => '?').join(',') + ')')
      .run(Date.now() + leaseMs, Date.now(), workflowId, ...LIVE);
  }

  recordSubmit(workflowId: string, submitState: 'submitting' | 'succeeded' | 'uncertain', extra: { idempotencyKey?: string; snapshotHash?: string; resultUrl?: string } = {}): void {
    this.db.prepare(`UPDATE assignments SET submit_state=?, idempotency_key=COALESCE(?, idempotency_key), snapshot_hash=COALESCE(?, snapshot_hash),
      submitted_at=COALESCE(submitted_at, ?), result_url=COALESCE(?, result_url), updated_at=? WHERE workflow_id=?`)
      .run(submitState, extra.idempotencyKey ?? null, extra.snapshotHash ?? null, submitState === 'submitting' ? Date.now() : null, extra.resultUrl ?? null, Date.now(), workflowId);
  }

  /** The user opened the generated link (visited), or the success text appeared on Website B (verified). */
  setLinkState(workflowId: string, state: 'visited' | 'verified'): void {
    const now = Date.now();
    if (state === 'visited') {
      this.db.prepare("UPDATE assignments SET link_state=CASE WHEN link_state='verified' THEN 'verified' ELSE 'visited' END, visited_at=COALESCE(visited_at, ?), updated_at=? WHERE workflow_id=?").run(now, now, workflowId);
    } else {
      this.db.prepare("UPDATE assignments SET link_state='verified', visited_at=COALESCE(visited_at, ?), verified_at=COALESCE(verified_at, ?), updated_at=? WHERE workflow_id=?").run(now, now, now, workflowId);
      // verified after the workflow already released the account for review: it is taken by that applicant now
      const a = this.getAssignment(workflowId);
      if (a?.application_id && this.reserveAfterUse) {
        const p = this.get(a.profile_id);
        if (p && p.state === 'review' && p.reserved_for_application_id === a.application_id) {
          this.db.prepare("UPDATE profiles SET state='taken', state_reason='verified: taken by this applicant', updated_at=? WHERE id=?").run(now, p.id);
          this.event(p.id, 'review', 'taken', 'verified after release', workflowId);
        }
      }
    }
    this.wfEvent(workflowId, null, `link:${state}`);
  }

  listAssignments(limit = 30): (AssignmentRow & { profile_label: string })[] {
    return this.db.prepare('SELECT a.*, p.label AS profile_label FROM assignments a JOIN profiles p ON p.id = a.profile_id ORDER BY a.created_at DESC LIMIT ?').all(limit) as any;
  }

  /**
   * End a workflow and decide the profile's next state:
   *   completed / abandoned / failed / lost / uncertain -> cooldown (needs_verify after lost/uncertain)
   *   auth_expired -> expired (out of rotation until re-seeded)
   *   invalid      -> invalid (out of rotation until re-seeded)
   * Under a workflow that is switching profiles (reassign=true) the assignment stays live on the new profile.
   */
  release(workflowId: string, outcome: ReleaseOutcome, cooldownMs: number, opts: { outcomeCode?: string; reason?: string; reassign?: boolean } = {}): void {
    const a = this.getAssignment(workflowId);
    if (!a) return;
    const now = Date.now();
    this.db.transaction(() => {
      const p = this.get(a.profile_id)!;
      if (a.egress_id) this.egress.markUsed(a.egress_id, workflowId, outcome);
      const wfState: AssignmentState = outcome === 'auth_expired' || outcome === 'invalid' ? 'failed' : outcome === 'lost' ? 'lost' : outcome;
      if (!opts.reassign) {
        this.db.prepare('UPDATE assignments SET state=?, outcome_code=?, ended_at=?, updated_at=? WHERE workflow_id=?').run(wfState, opts.outcomeCode ?? null, now, now, workflowId);
        this.wfEvent(workflowId, a.state, wfState, opts.reason);
      } else {
        // detach the old profile from this workflow; caller reserves a new one under the same workflow id
        this.db.prepare('UPDATE assignments SET state=?, reassign_count=reassign_count+1, ended_at=?, updated_at=? WHERE workflow_id=?').run('failed', now, now, workflowId);
        this.db.prepare('INSERT INTO workflow_events (workflow_id, from_state, to_state, reason, at) VALUES (?,?,?,?,?)').run(workflowId, a.state, 'reassigning', opts.reason ?? null, now);
        this.db.prepare('DELETE FROM assignments WHERE workflow_id=?').run(workflowId); // primary key must be free for the new reservation
      }
      let next: ProfileState; let needsVerify = 0; let failures = p.consecutive_failures;
      switch (outcome) {
        case 'auth_expired': next = 'expired'; break;
        case 'invalid': next = 'invalid'; break;
        case 'lost': case 'uncertain': next = 'cooldown'; needsVerify = 1; break;
        case 'failed': next = 'cooldown'; failures += 1; break;
        default: next = 'cooldown'; failures = 0;
      }
      if (next === 'cooldown' && failures >= 3) { next = 'invalid'; opts.reason = `${opts.reason ?? outcome}; 3 consecutive failures`; }
      // Applicant workflows: once the applicant has opened the role link the outcome is unknown, so the account is
      // held for operator review instead of returning to rotation; a verified run takes the account for that applicant.
      let reservedFor: string | null = null;
      if (this.reserveAfterUse && a.application_id && !opts.reassign && next === 'cooldown') {
        if (a.link_state === 'verified') { next = 'taken'; reservedFor = a.application_id; opts.reason = 'verified: taken by this applicant'; }
        else if (a.visited_at !== null) { next = 'review'; reservedFor = a.application_id; opts.reason = 'applicant opened the role link: held until the operator releases or verifies'; }
      }
      this.db.prepare('UPDATE profiles SET state=?, cooldown_until=?, needs_verify=?, consecutive_failures=?, state_reason=?, reserved_for_application_id=COALESCE(?, reserved_for_application_id), reserved_at=CASE WHEN ? IS NULL THEN reserved_at ELSE ? END, updated_at=? WHERE id=?')
        .run(next, next === 'cooldown' ? now + cooldownMs : null, needsVerify, failures, opts.reason ?? outcome, reservedFor, reservedFor, now, now, p.id);
      this.event(p.id, p.state, next, opts.reason ?? outcome, workflowId);
    })();
  }

  /** cooldown -> available once the cooldown has passed. Returns how many were promoted. */
  promoteCooledDown(): number {
    const now = Date.now();
    const rows = this.db.prepare("SELECT id, state FROM profiles WHERE state='cooldown' AND cooldown_until <= ?").all(now) as { id: string; state: ProfileState }[];
    for (const r of rows) {
      this.db.prepare("UPDATE profiles SET state='available', cooldown_until=NULL, updated_at=? WHERE id=?").run(now, r.id);
      this.event(r.id, 'cooldown', 'available', 'cooldown elapsed');
    }
    return rows.length;
  }

  /** Assignments whose lease lapsed (workflow runtime stopped renewing) -> lost, profile -> cooldown + verify. */
  reapExpiredLeases(cooldownMs: number): string[] {
    const rows = this.db.prepare('SELECT workflow_id FROM assignments WHERE lease_expires_at < ? AND state IN (' + LIVE.map(() => '?').join(',') + ')')
      .all(Date.now(), ...LIVE) as { workflow_id: string }[];
    for (const r of rows) this.release(r.workflow_id, 'lost', cooldownMs, { reason: 'lease expired' });
    return rows.map((r) => r.workflow_id);
  }

  /** On boot: every live assignment belongs to a dead process; mark lost and release its profile. */
  recoverOrphans(cooldownMs: number): string[] {
    const rows = this.db.prepare('SELECT workflow_id, state, submit_state FROM assignments WHERE state IN (' + LIVE.map(() => '?').join(',') + ')')
      .all(...LIVE) as { workflow_id: string; state: string; submit_state: string }[];
    for (const r of rows) {
      const outcome: ReleaseOutcome = r.submit_state === 'submitting' ? 'uncertain' : 'lost';
      this.release(r.workflow_id, outcome, cooldownMs, { reason: 'service restarted' });
    }
    // profiles stuck in a transient state with no live assignment
    const stuck = this.db.prepare("SELECT id, state FROM profiles WHERE state IN ('reserved','starting','active')").all() as { id: string; state: ProfileState }[];
    for (const p of stuck) {
      this.db.prepare("UPDATE profiles SET state='cooldown', cooldown_until=?, needs_verify=1, updated_at=? WHERE id=?").run(Date.now() + cooldownMs, Date.now(), p.id);
      this.event(p.id, p.state, 'cooldown', 'service restarted (no live assignment)');
    }
    return rows.map((r) => r.workflow_id);
  }

  status(): PoolStatus {
    const rows = this.db.prepare('SELECT state, COUNT(*) n FROM profiles GROUP BY state').all() as { state: ProfileState; n: number }[];
    const c = (s: ProfileState) => rows.find((r) => r.state === s)?.n ?? 0;
    const now = Date.now();
    const availableNow = (this.db.prepare("SELECT COUNT(*) n FROM profiles WHERE state='available' AND session_saved_at IS NOT NULL AND (cooldown_until IS NULL OR cooldown_until <= ?)").get(now) as { n: number }).n;
    const noSession = (this.db.prepare('SELECT COUNT(*) n FROM profiles WHERE session_saved_at IS NULL').get() as { n: number }).n;
    const next = (this.db.prepare("SELECT MIN(cooldown_until) t FROM profiles WHERE state='cooldown' AND session_saved_at IS NOT NULL").get() as { t: number | null }).t;
    return {
      total: rows.reduce((a, r) => a + r.n, 0), available: availableNow,
      live: c('reserved') + c('starting') + c('active'), cooldown: c('cooldown'), expired: c('expired'), invalid: c('invalid'), disabled: c('disabled'),
      review: c('review'), taken: c('taken'),
      noSession, nextAvailableInMs: next ? Math.max(0, next - now) : null,
    };
  }

  events(profileId: string, limit = 20): { from_state: string | null; to_state: string; reason: string | null; workflow_id: string | null; at: number }[] {
    return this.db.prepare('SELECT from_state,to_state,reason,workflow_id,at FROM profile_events WHERE profile_id=? ORDER BY id DESC LIMIT ?').all(profileId, limit) as any;
  }

  // ---------- events ----------

  private event(profileId: string, from: string | null, to: string, reason?: string, workflowId?: string): void {
    this.db.prepare('INSERT INTO profile_events (profile_id, from_state, to_state, reason, workflow_id, at) VALUES (?,?,?,?,?,?)')
      .run(profileId, from, to, reason ?? null, workflowId ?? null, Date.now());
  }
  private wfEvent(workflowId: string, from: string | null, to: string, reason?: string): void {
    this.db.prepare('INSERT INTO workflow_events (workflow_id, from_state, to_state, reason, at) VALUES (?,?,?,?,?)')
      .run(workflowId, from, to, reason ?? null, Date.now());
  }
}
