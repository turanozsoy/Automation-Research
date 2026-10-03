import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { Vault } from '../crypto.js';
import { AuditLog } from '../audit.js';
import { EgressStore } from '../egress/store.js';
import { pidStartOf } from '../proc.js';

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
  /** Persistent Chromium profile: directory name under BROWSER_PROFILE_DIR (from the id, never operator text) and its seeding marker. */
  user_data_dir: string | null; profile_dir_initialized_at: number | null;
  /** Stable, operator-configured browser environment (NULL = service default). Never randomized. */
  browser_locale: string | null; browser_timezone: string | null; browser_viewport: string | null;
}

export type RuntimeType = 'workflow' | 'manual_login';
export interface RuntimeRow {
  profile_id: string; account_id: string; runtime_type: RuntimeType; workflow_id: string | null; instance_id: string;
  pid: number | null; pid_start: string | null; lease_token: string; started_at: number; heartbeat_at: number;
}
/** Proof of exclusive runtime ownership of a profile; the browser layer must present it to launch. */
export interface RuntimeHandle { profileId: string; runtimeType: RuntimeType; workflowId: string | null; leaseToken: string }
export interface BrowserEnvironment { locale: string | null; timezone: string | null; viewport: { width: number; height: number } | null }

export class ProfileRuntimeError extends Error {
  constructor(public code: 'PROFILE_IN_USE' | 'RUNTIME_LEASE_LOST' | 'PROFILE_NOT_FOUND', message: string) { super(message); }
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
  /** Persistent browser profile + environment (configuration only; never browser contents). */
  browser: { profileDir: string | null; initialized: boolean; locale: string | null; timezone: string | null; viewport: string | null; running: { type: RuntimeType; workflowId: string | null; since: number } | null };
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
/** Directory name for a profile: from the internal id only (a UUID), never from operator-entered text. */
export const profileDirName = (id: string) => `profile-${id}`;

/**
 * All profile/assignment persistence. Every mutation is a synchronous SQLite
 * transaction, so two concurrent workflow.start calls can never reserve the same
 * profile: the UPDATE selects exactly one 'available' row and flips it in one
 * statement, and the partial unique index on live assignments backs that up.
 */
export class ProfileStore {
  /** Egress rows live in the same database, so account + egress + runtime are acquired in ONE transaction. */
  readonly egress: EgressStore;
  readonly audit: AuditLog;
  /** False under STRICT_ACCOUNT_EGRESS (or per-context proxy mode): no account browser ever goes direct. */
  private directAllowed = true;

  constructor(private db: Db, private vault: Vault, readonly instanceId: string) {
    this.audit = new AuditLog(db);
    this.egress = new EgressStore(db, vault, this.audit);
  }

  setDirectAllowed(v: boolean): void { this.directAllowed = v; }
  isDirectAllowed(): boolean { return this.directAllowed; }

  // ---------- CRUD ----------

  insert(label: string, accountKey: string, storageStateJson: string): ProfileRow {
    const id = randomUUID();
    const e = this.vault.encrypt(id, storageStateJson);
    const now = Date.now();
    this.db.prepare(`INSERT INTO profiles (id,label,account_key,state,storage_state_enc,nonce,data_key_enc,key_version,session_saved_at,created_at,updated_at,user_data_dir)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, label, accountKey, 'available', e.ciphertext, e.nonce, e.dataKeyEnc, e.keyVersion, now, now, now, profileDirName(id));
    this.event(id, null, 'available', 'seeded');
    this.audit.record('PROFILE_CREATED', { profileId: id, code: 'seeded', detail: `profile dir ${profileDirName(id)}` });
    return this.get(id)!;
  }

  /** Create an account record with NO session yet (the manual login flow fills it in). */
  createAccount(name: string, email: string): ProfileRow {
    const id = randomUUID();
    const e = this.vault.encrypt(id, JSON.stringify({ cookies: [], origins: [] }));
    const now = Date.now();
    this.db.prepare(`INSERT INTO profiles (id,label,account_key,state,storage_state_enc,nonce,data_key_enc,key_version,session_saved_at,created_at,updated_at,user_data_dir)
      VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?)`).run(id, name, email, 'available', e.ciphertext, e.nonce, e.dataKeyEnc, e.keyVersion, now, now, profileDirName(id));
    this.event(id, null, 'available', 'account created (no session yet)');
    this.audit.record('PROFILE_CREATED', { profileId: id, code: 'created', detail: `profile dir ${profileDirName(id)}` });
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
      browser: (() => {
        const rt = this.getRuntime(r.id);
        return { profileDir: r.user_data_dir, initialized: r.profile_dir_initialized_at !== null, locale: r.browser_locale, timezone: r.browser_timezone, viewport: r.browser_viewport,
          running: rt ? { type: rt.runtime_type, workflowId: rt.workflow_id, since: rt.started_at } : null };
      })(),
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
    const p = this.get(id);
    if (!p) return;
    if (this.getRuntime(id)) throw new ProfileRuntimeError('PROFILE_IN_USE', 'the account browser is running; close it before removing the account');
    this.db.transaction(() => {
      // the account's proxy stays held (the provider may still count the session); the operator releases it explicitly.
      // Its assignment history survives this delete (no FK), so the proxy never looks clean again.
      this.egress.unbindAccount(id, 'account removed');
      this.db.prepare('DELETE FROM assignments WHERE profile_id = ?').run(id);
      this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      // the persistent Chromium directory is NOT deleted by ordinary cleanup; the operator removes it deliberately
      this.audit.record('PROFILE_DIR_RETAINED', { profileId: id, detail: `account removed; browser profile dir ${p.user_data_dir ?? '(none)'} retained on disk` });
    })();
  }

  // ---------- persistent browser profile + stable environment ----------

  /** Directory name of the account's Chromium profile (derived from the id). */
  profileDirName(id: string): string {
    const p = this.get(id);
    if (!p) throw new ProfileRuntimeError('PROFILE_NOT_FOUND', `account ${id} not found`);
    if (!p.user_data_dir) {
      // accounts created before the isolation migration (should have been backfilled; idempotent repair)
      this.db.prepare('UPDATE profiles SET user_data_dir = ?, updated_at = ? WHERE id = ? AND user_data_dir IS NULL').run(profileDirName(id), Date.now(), id);
      return profileDirName(id);
    }
    return p.user_data_dir;
  }

  /** Marks the persistent directory seeded (idempotent). `seeded` says whether a saved session was imported. */
  markProfileDirInitialized(id: string, seeded: boolean): void {
    const r = this.db.prepare('UPDATE profiles SET profile_dir_initialized_at = ?, updated_at = ? WHERE id = ? AND profile_dir_initialized_at IS NULL').run(Date.now(), Date.now(), id);
    if (r.changes) this.audit.record(seeded ? 'PROFILE_MIGRATED' : 'PROFILE_CREATED', { profileId: id, code: seeded ? 'seeded_from_storage_state' : 'empty_profile_dir', detail: `persistent profile dir initialized (${this.get(id)?.user_data_dir ?? '?'})` });
  }

  /** Operator-set environment. Validated; stored; identical on every launch. Nothing is inferred or randomized. */
  setEnvironment(id: string, env: Partial<BrowserEnvironment>, operator = 'operator'): BrowserEnvironment {
    const p = this.get(id);
    if (!p) throw new ProfileRuntimeError('PROFILE_NOT_FOUND', `account ${id} not found`);
    if (this.getRuntime(id)) throw new ProfileRuntimeError('PROFILE_IN_USE', 'the account browser is running; close it before changing its environment');
    const next = { locale: p.browser_locale, timezone: p.browser_timezone, viewport: p.browser_viewport };
    if (env.locale !== undefined) {
      if (env.locale !== null) { try { const [c] = Intl.getCanonicalLocales(env.locale); if (!c || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(c)) throw new Error(); next.locale = c; } catch { throw new Error(`invalid locale "${String(env.locale).slice(0, 40)}" (expected e.g. en-US)`); } }
      else next.locale = null;
    }
    if (env.timezone !== undefined) {
      if (env.timezone !== null) { try { new Intl.DateTimeFormat('en-US', { timeZone: env.timezone }); next.timezone = env.timezone; } catch { throw new Error(`invalid IANA time zone "${String(env.timezone).slice(0, 40)}"`); } }
      else next.timezone = null;
    }
    if (env.viewport !== undefined) {
      if (env.viewport !== null) {
        const { width, height } = env.viewport;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 320 || width > 7680 || height > 4320) throw new Error('viewport must be WxH between 320 and 7680x4320');
        next.viewport = `${width}x${height}`;
      } else next.viewport = null;
    }
    this.db.prepare('UPDATE profiles SET browser_locale = ?, browser_timezone = ?, browser_viewport = ?, updated_at = ? WHERE id = ?').run(next.locale, next.timezone, next.viewport, Date.now(), id);
    this.audit.record('PROFILE_ENVIRONMENT_SET', { profileId: id, operator, detail: `locale=${next.locale ?? 'default'} timezone=${next.timezone ?? 'default'} viewport=${next.viewport ?? 'default'}` });
    return this.environmentOf(this.get(id)!);
  }

  environmentOf(p: ProfileRow): BrowserEnvironment {
    const m = p.browser_viewport ? /^(\d+)x(\d+)$/.exec(p.browser_viewport) : null;
    return { locale: p.browser_locale, timezone: p.browser_timezone, viewport: m ? { width: Number(m[1]), height: Number(m[2]) } : null };
  }

  // ---------- exclusive runtime ownership ----------

  getRuntime(profileId: string): RuntimeRow | undefined {
    return this.db.prepare('SELECT * FROM profile_runtimes WHERE profile_id = ?').get(profileId) as RuntimeRow | undefined;
  }
  listRuntimes(): RuntimeRow[] { return this.db.prepare('SELECT * FROM profile_runtimes ORDER BY started_at').all() as RuntimeRow[]; }

  /**
   * Take exclusive runtime ownership of a profile for a manual login (workflows take theirs inside reserve()).
   * One immediate transaction: refused while a live workflow assignment or any runtime row exists.
   */
  acquireRuntime(profileId: string, runtimeType: RuntimeType, opts: { workflowId?: string | null; pid?: number | null; pidStart?: string | null } = {}): RuntimeHandle {
    let conflict: { code: string; detail: string; workflowId: string | null } | null = null;
    try {
      return this.db.transaction(() => {
        const p = this.get(profileId);
        if (!p) throw new ProfileRuntimeError('PROFILE_NOT_FOUND', `account ${profileId} not found`);
        const existing = this.getRuntime(profileId);
        if (existing) {
          conflict = { code: existing.runtime_type, workflowId: opts.workflowId ?? null, detail: `requested ${runtimeType}; held by ${existing.runtime_type} on instance ${existing.instance_id.slice(0, 8)} since ${new Date(existing.started_at).toISOString()}` };
          throw new ProfileRuntimeError('PROFILE_IN_USE', `profile already in use by ${existing.runtime_type === 'manual_login' ? 'a manual login browser' : `workflow ${existing.workflow_id?.slice(0, 8) ?? '?'}`}`);
        }
        const live = this.db.prepare('SELECT workflow_id FROM assignments WHERE profile_id = ? AND state IN (' + LIVE.map(() => '?').join(',') + ')').get(profileId, ...LIVE) as { workflow_id: string } | undefined;
        if (live && live.workflow_id !== opts.workflowId) {
          conflict = { code: 'workflow', workflowId: live.workflow_id, detail: `requested ${runtimeType}; a live workflow assignment holds the account` };
          throw new ProfileRuntimeError('PROFILE_IN_USE', `profile already in use by workflow ${live.workflow_id.slice(0, 8)}`);
        }
        return this.insertRuntime(profileId, runtimeType, opts.workflowId ?? null, opts.pid ?? null, opts.pidStart ?? null);
      }).immediate();
    } catch (e) {
      // recorded AFTER the rollback so the audit row survives the failed transaction
      if (conflict) { const c = conflict as { code: string; detail: string; workflowId: string | null }; this.audit.record('PROFILE_RUNTIME_LOCK_CONFLICT', { profileId, workflowId: c.workflowId, code: c.code, detail: c.detail }); }
      throw e;
    }
  }

  /** Inside a transaction. The PRIMARY KEY on profile_id is the final arbiter. */
  private insertRuntime(profileId: string, runtimeType: RuntimeType, workflowId: string | null, pid: number | null, pidStart: string | null): RuntimeHandle {
    const now = Date.now();
    const leaseToken = randomBytes(16).toString('hex');
    // the owner process is THIS service (it heartbeats the lease); recorded with its start time so a reused pid is not mistaken for it
    this.db.prepare('INSERT INTO profile_runtimes (profile_id, account_id, runtime_type, workflow_id, instance_id, pid, pid_start, lease_token, started_at, heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(profileId, profileId, runtimeType, workflowId, this.instanceId, pid ?? process.pid, pidStart ?? pidStartOf(process.pid), leaseToken, now, now);
    this.audit.record('PROFILE_RUNTIME_LOCK_ACQUIRED', { profileId, workflowId, code: runtimeType, detail: `instance ${this.instanceId.slice(0, 8)}` });
    return { profileId, runtimeType, workflowId, leaseToken };
  }

  /** Renew ownership. False when the lease is gone (recovered by another instance or released): the holder must stop. */
  heartbeatRuntime(h: RuntimeHandle): boolean {
    return this.db.prepare('UPDATE profile_runtimes SET heartbeat_at = ? WHERE profile_id = ? AND lease_token = ?').run(Date.now(), h.profileId, h.leaseToken).changes === 1;
  }
  /** Record the Chromium process once Playwright reports it (informational; never trusted alone). */
  setRuntimeProcess(h: RuntimeHandle, pid: number | null, pidStart: string | null): void {
    this.db.prepare('UPDATE profile_runtimes SET pid = ?, pid_start = ? WHERE profile_id = ? AND lease_token = ?').run(pid, pidStart, h.profileId, h.leaseToken);
  }
  /** Give the profile back. Fenced by the lease token; idempotent. */
  releaseRuntime(h: RuntimeHandle, reason: string): boolean {
    const r = this.db.prepare('DELETE FROM profile_runtimes WHERE profile_id = ? AND lease_token = ?').run(h.profileId, h.leaseToken);
    if (r.changes) this.audit.record('PROFILE_RUNTIME_LOCK_RELEASED', { profileId: h.profileId, workflowId: h.workflowId, code: h.runtimeType, detail: reason });
    return r.changes === 1;
  }

  /**
   * Stale-lock recovery (boot and periodic). A runtime row of ANOTHER instance whose heartbeat lapsed is reclaimed
   * only when `ownerAlive` says its process is genuinely gone (pid dead, or pid reused: start time differs).
   * A lapsed heartbeat with a live owner is a conflict that is logged and left alone (fail closed). The persistent
   * profile directory is never touched here.
   */
  recoverStaleRuntimes(leaseMs: number, ownerAlive: (pid: number | null, pidStart: string | null) => boolean | 'unknown'): { recovered: string[]; conflicts: string[] } {
    const now = Date.now();
    const out = { recovered: [] as string[], conflicts: [] as string[] };
    const rows = this.db.prepare('SELECT * FROM profile_runtimes WHERE instance_id != ? AND heartbeat_at < ?').all(this.instanceId, now - leaseMs) as RuntimeRow[];
    for (const r of rows) {
      const alive = ownerAlive(r.pid, r.pid_start);
      const age = Math.round((now - r.heartbeat_at) / 1000);
      if (alive === true) {
        this.audit.record('PROFILE_RUNTIME_LOCK_CONFLICT', { profileId: r.profile_id, workflowId: r.workflow_id, code: 'STALE_HEARTBEAT_OWNER_ALIVE', detail: `heartbeat ${age}s old but pid ${r.pid} is alive; not reclaimed` });
        out.conflicts.push(r.profile_id);
        continue;
      }
      if (alive === 'unknown' && now - r.heartbeat_at < leaseMs * 3) { out.conflicts.push(r.profile_id); continue; } // no pid to check: wait 3 leases
      const del = this.db.prepare('DELETE FROM profile_runtimes WHERE profile_id = ? AND lease_token = ?').run(r.profile_id, r.lease_token);
      if (del.changes) {
        this.audit.record('PROFILE_RUNTIME_LOCK_RECOVERED', { profileId: r.profile_id, workflowId: r.workflow_id, code: r.runtime_type, detail: `stale lease of instance ${r.instance_id.slice(0, 8)} (heartbeat ${age}s old, pid ${r.pid ?? '?'} ${alive === false ? 'dead or reused' : 'unknown'}); profile data untouched` });
        out.recovered.push(r.profile_id);
      }
    }
    return out;
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

      // Account first, then ITS egress, then the runtime lock: an account bound to a proxy reuses that proxy (never a
      // new one); an unbound account takes one CLEAN proxy and binds it; direct only when allowed (never for a bound
      // account). An account whose proxy is retired or in use is skipped, never given another proxy; one whose proxy
      // is down is tried last and only while a clean replacement exists (the launch preflight decides). A profile
      // with any runtime owner (manual login, another instance) is not a candidate. All three resources or none.
      const candidates = this.db.prepare(`
        SELECT p.id FROM profiles p
        WHERE p.state='available' AND p.session_saved_at IS NOT NULL AND (p.cooldown_until IS NULL OR p.cooldown_until <= ?)
          AND NOT EXISTS (SELECT 1 FROM profile_runtimes r WHERE r.profile_id = p.id)
        ORDER BY CASE WHEN p.egress_id IS NOT NULL THEN 0 ELSE 1 END,
                 CASE WHEN EXISTS (SELECT 1 FROM egress e WHERE e.id = p.egress_id AND e.state = 'down') THEN 1 ELSE 0 END,
                 p.last_used_at ASC NULLS FIRST, p.created_at ASC`).all(now) as { id: string }[];
      for (const c of candidates) {
        const pick = this.egress.pickForAccount(c.id, this.directAllowed, workflowId);
        if (pick.id === null) {
          if (pick.blocked) this.event(c.id, null, 'skipped', `cannot run: ${pick.blocked}`, workflowId);
          continue;
        }
        const row = this.db.prepare(`UPDATE profiles SET state='reserved', last_used_at=?, use_count=use_count+1, updated_at=? WHERE id=? AND state='available' RETURNING *`).get(now, now, c.id) as ProfileRow | undefined;
        if (!row) continue;
        this.db.prepare(`INSERT INTO assignments (workflow_id,profile_id,state,instance_id,lease_expires_at,client_ip,egress_id,application_id,lease_token,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(workflowId, row.id, 'allocating', this.instanceId, now + leaseMs, clientIp ?? null, pick.id, applicationId ?? null, randomBytes(16).toString('hex'), now, now);
        this.egress.markInUse(pick.id, workflowId);
        this.insertRuntime(row.id, 'workflow', workflowId, null, null); // PRIMARY KEY: a concurrent owner makes this throw and the transaction roll back
        this.event(row.id, 'available', 'reserved', 'allocated', workflowId);
        const egressLabel = this.egress.get(pick.id)?.label ?? pick.id;
        this.wfEvent(workflowId, null, 'allocating', `profile ${row.label}, egress ${egressLabel} (${pick.bound === 'reused' ? (pick.needsFailover ? 'the account\'s own proxy, currently down: preflight + clean failover at launch' : 'the account\'s own proxy, reused') : pick.bound === 'new' ? 'clean proxy, now bound to this account' : 'direct'})`);
        return { profile: row, assignment: this.getAssignment(workflowId)! };
      }
      return null;
    }).immediate();
  }

  /** The runtime handle a workflow's reservation created (the browser layer launches only with it). */
  runtimeHandleFor(workflowId: string): RuntimeHandle | null {
    const r = this.db.prepare("SELECT * FROM profile_runtimes WHERE workflow_id = ? AND runtime_type = 'workflow'").get(workflowId) as RuntimeRow | undefined;
    return r ? { profileId: r.profile_id, runtimeType: 'workflow', workflowId, leaseToken: r.lease_token } : null;
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
  release(workflowId: string, outcome: ReleaseOutcome, cooldownMs: number, opts: { outcomeCode?: string; reason?: string; reassign?: boolean; /** false: the failure was the network's (egress), not the account's: no strike against it */ countFailure?: boolean } = {}): void {
    const a = this.getAssignment(workflowId);
    if (!a) return;
    const now = Date.now();
    this.db.transaction(() => {
      const p = this.get(a.profile_id)!;
      if (a.egress_id) this.egress.markUsed(a.egress_id, workflowId, outcome);
      const rt = this.db.prepare("DELETE FROM profile_runtimes WHERE profile_id = ? AND runtime_type = 'workflow' AND workflow_id = ?").run(p.id, workflowId);
      if (rt.changes) this.audit.record('PROFILE_RUNTIME_LOCK_RELEASED', { profileId: p.id, workflowId, code: 'workflow', detail: `assignment released (${outcome})` });
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
        case 'failed': next = 'cooldown'; if (opts.countFailure !== false) failures += 1; break;
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
