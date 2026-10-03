import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { Vault } from '../crypto.js';
import { AuditLog } from '../audit.js';

/**
 * Egress = where a workflow's traffic leaves from. `direct` (the server's own IP) is the first row and
 * never holds credentials. Proxy rows are exclusive sessions bound to ONE account: the first workflow (or
 * login capture) on an account takes an unused proxy and binds it (profiles.egress_id); every later run on
 * that account reuses the same proxy, so the provider never sees the account on a new session. After use the
 * proxy is HELD for its account; only the operator's Release clears the binding and returns it to the pool.
 *
 *   available (unbound) -> in_use (bound) -> held (bound) -> in_use (same account) ... -> (Release) -> available (unbound)
 *   available/held -> down     (health / workflow network failures; keeps its binding; needs Restore)
 *   any (not in_use) -> retired (Retire; needs Reinstate)
 *
 * Credentials are stored with the same envelope encryption as sessions and never leave this module
 * except into Playwright's context options.
 *
 * Provenance (egress_assignment_history) is separate from state and immutable under normal operations: every
 * proxy -> account assignment is recorded forever (also by connection fingerprint, so delete + re-import cannot
 * launder it). "Available" does NOT mean "clean": a proxy is a CLEAN automatic candidate only when it is a real
 * proxy, enabled, not down, currently unassigned, not in use, and has NEVER appeared in the history.
 */
export type EgressKind = 'direct' | 'http' | 'socks5';
export type EgressState = 'available' | 'in_use' | 'held' | 'down' | 'retired';
export type EgressHealth = 'unknown' | 'healthy' | 'degraded' | 'down';
export const DIRECT_ID = 'direct';

export interface EgressRow {
  id: string; label: string; kind: EgressKind; host: string | null; port: number | null; fingerprint: string;
  cred_enc: Buffer | null; cred_nonce: Buffer | null; cred_key_enc: Buffer | null; cred_key_version: number | null; has_auth: number;
  max_concurrent: number; hold_after_use: number; state: EgressState; state_reason: string | null;
  health: EgressHealth; last_check_at: number | null; last_error: string | null; consecutive_failures: number;
  use_count: number; last_used_at: number | null; held_since: number | null; released_at: number | null;
  created_at: number; updated_at: number;
}

/** What the operations page may see. Never a username or password. */
export interface EgressMeta {
  id: string; label: string; kind: EgressKind; host: string | null; port: number | null; hasAuth: boolean;
  /** The account this proxy is bound to (null for direct and for unbound proxies). */
  boundTo: { id: string; label: string; since: number | null } | null;
  maxConcurrent: number; holdAfterUse: boolean; state: EgressState; stateReason: string | null;
  health: EgressHealth; lastCheckAt: number | null; lastError: string | null; consecutiveFailures: number;
  useCount: number; lastUsedAt: number | null; heldSince: number | null; releasedAt: number | null;
  liveWorkflows: number; lastWorkflowId: string | null; lastWorkflowAt: number | null; createdAt: number;
  /** Provenance: how many accounts this proxy has ever been assigned to; clean = eligible for AUTOMATIC assignment. */
  historicalAssignments: number; clean: boolean;
}

export type HistoryReason = 'initial' | 'automatic_failover' | 'manual_replace' | 'manual_bind' | 'migration_existing_binding';
export interface HistoryRow {
  id: number; egress_id: string; egress_fingerprint: string | null; profile_id: string; profile_label: string | null; workflow_id: string | null;
  reason: HistoryReason; assigned_at: number; ended_at: number | null; ended_reason: string | null;
}

/** Thrown by the strict allocation paths; `code` is safe to show operators and applicants. */
export class EgressError extends Error {
  constructor(public code: 'NO_CLEAN_EGRESS_AVAILABLE' | 'EGRESS_BINDING_CHANGED' | 'EGRESS_NOT_ELIGIBLE' | 'HISTORICAL_PROXY_REQUIRES_CONFIRMATION' | 'DIRECT_EGRESS_FORBIDDEN', message: string) { super(message); }
}

export interface ParsedProxy { kind: 'http' | 'socks5'; host: string; port: number; username?: string; password?: string }
export type ParseResult = { ok: true; proxy: ParsedProxy } | { ok: false; reason: string };

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$|^\d{1,3}(?:\.\d{1,3}){3}$|^\[[0-9a-f:]+\]$/i;

/**
 * One proxy per line. Accepted forms:
 *   host:port
 *   host:port:username:password           (IPRoyal export; the password may itself contain ':')
 *   http://username:password@host:port    socks5://username:password@host:port
 *   username:password@host:port
 * The username may carry provider parameters (e.g. _country-us_session-abc123); it is kept verbatim.
 */
export function parseProxyLine(raw: string): ParseResult {
  const line = raw.trim();
  if (!line) return { ok: false, reason: 'empty line' };
  let kind: 'http' | 'socks5' = 'http';
  let rest = line;
  const scheme = /^(https?|socks5h?):\/\//i.exec(rest);
  if (scheme) { kind = scheme[1].toLowerCase().startsWith('socks') ? 'socks5' : 'http'; rest = rest.slice(scheme[0].length); }
  let username: string | undefined; let password: string | undefined; let hostPort: string;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const cred = rest.slice(0, at); hostPort = rest.slice(at + 1);
    const c = cred.indexOf(':');
    if (c < 0) return { ok: false, reason: 'credentials must be username:password' };
    username = decodeURIComponent(cred.slice(0, c)); password = decodeURIComponent(cred.slice(c + 1));
    const hp = hostPort.split(':');
    if (hp.length !== 2) return { ok: false, reason: 'expected host:port after @' };
    hostPort = `${hp[0]}:${hp[1]}`;
  } else {
    const parts = rest.split(':');
    if (parts.length === 2) hostPort = rest;
    else if (parts.length >= 4) { hostPort = `${parts[0]}:${parts[1]}`; username = parts[2]; password = parts.slice(3).join(':'); }
    else return { ok: false, reason: 'expected host:port or host:port:username:password' };
  }
  const [host, portStr] = hostPort.split(':');
  const port = Number(portStr);
  if (!HOST_RE.test(host)) return { ok: false, reason: 'invalid host' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'invalid port' };
  if ((username !== undefined && username === '') || (password !== undefined && password === '')) return { ok: false, reason: 'empty username or password' };
  if (username && username.length > 256 || password && password.length > 256) return { ok: false, reason: 'credentials too long' };
  return { ok: true, proxy: { kind, host: host.toLowerCase(), port, username, password } };
}

export const fingerprintOf = (p: ParsedProxy) => createHash('sha256').update(`${p.kind}|${p.host}|${p.port}|${p.username ?? ''}|${p.password ?? ''}`).digest('hex');

const LIVE = "('allocating','preparing','ready','submitting','paused')";
/** A CLEAN automatic candidate (see the module doc). `e` is the egress alias. */
const CLEAN_WHERE = `e.kind != 'direct' AND e.state = 'available' AND e.health NOT IN ('down','degraded')
        AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.egress_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM profile_runtimes r JOIN profiles rp ON rp.id = r.profile_id WHERE rp.egress_id = e.id)
        AND (SELECT COUNT(*) FROM assignments a WHERE a.egress_id = e.id AND a.state IN ${LIVE}) = 0
        AND NOT EXISTS (SELECT 1 FROM egress_assignment_history h WHERE h.egress_id = e.id OR h.egress_fingerprint = e.fingerprint)`;

export class EgressStore {
  readonly audit: AuditLog;
  constructor(private db: Db, private vault: Vault, audit?: AuditLog) { this.audit = audit ?? new AuditLog(db); }

  // ---------- import ----------

  add(p: ParsedProxy, label?: string): { id: string } | { duplicate: true } {
    const fp = fingerprintOf(p);
    if (this.db.prepare('SELECT id FROM egress WHERE fingerprint = ?').get(fp)) return { duplicate: true };
    const id = randomUUID();
    const now = Date.now();
    const cred = p.username !== undefined ? this.vault.encrypt(`egress:${id}`, JSON.stringify({ username: p.username, password: p.password })) : null;
    this.db.prepare(`INSERT INTO egress (id,label,kind,host,port,fingerprint,cred_enc,cred_nonce,cred_key_enc,cred_key_version,has_auth,max_concurrent,hold_after_use,state,health,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,'available','unknown',?,?)`)
      .run(id, label ?? `${p.host}:${p.port}`, p.kind, p.host, p.port, fp, cred?.ciphertext ?? null, cred?.nonce ?? null, cred?.dataKeyEnc ?? null, cred?.keyVersion ?? null, cred ? 1 : 0, now, now);
    this.event(id, null, 'available', 'added');
    return { id };
  }

  /** Bulk import, one proxy per line. Returns counts and the reasons for invalid lines (never the line's credentials). */
  importLines(text: string): { added: number; duplicates: number; invalid: { line: number; reason: string }[] } {
    const out = { added: 0, duplicates: 0, invalid: [] as { line: number; reason: string }[] };
    const seen = new Set<string>();
    const lines = text.split(/\r?\n/);
    this.db.transaction(() => {
      lines.forEach((raw, i) => {
        if (!raw.trim()) return;
        const r = parseProxyLine(raw);
        if (!r.ok) { out.invalid.push({ line: i + 1, reason: r.reason }); return; }
        const fp = fingerprintOf(r.proxy);
        if (seen.has(fp)) { out.duplicates++; return; }
        seen.add(fp);
        const res = this.add(r.proxy);
        if ('duplicate' in res) out.duplicates++; else out.added++;
      });
    })();
    return out;
  }

  // ---------- read ----------

  get(id: string): EgressRow | undefined { return this.db.prepare('SELECT * FROM egress WHERE id = ?').get(id) as EgressRow | undefined; }

  list(): EgressMeta[] {
    const rows = this.db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM assignments a WHERE a.egress_id = e.id AND a.state IN ${LIVE}) AS live,
      (SELECT workflow_id FROM assignments a WHERE a.egress_id = e.id ORDER BY created_at DESC LIMIT 1) AS last_wf,
      (SELECT created_at FROM assignments a WHERE a.egress_id = e.id ORDER BY created_at DESC LIMIT 1) AS last_wf_at
      FROM egress e ORDER BY CASE WHEN e.kind = 'direct' THEN 0 ELSE 1 END, e.created_at`).all() as (EgressRow & { live: number; last_wf: string | null; last_wf_at: number | null })[];
    return rows.map((r) => this.meta(r, r.live, r.last_wf, r.last_wf_at));
  }

  // ---------- provenance (immutable under normal operations) ----------

  /** Has this proxy EVER been assigned to an account (by id or by connection fingerprint)? Direct is never clean. */
  hasHistory(id: string): boolean {
    const e = this.get(id);
    if (!e) return false;
    return !!this.db.prepare('SELECT 1 FROM egress_assignment_history WHERE egress_id = ? OR egress_fingerprint = ? LIMIT 1').get(id, e.fingerprint);
  }
  historyCount(id: string): number {
    const e = this.get(id);
    if (!e) return 0;
    return (this.db.prepare('SELECT COUNT(DISTINCT profile_id) n FROM egress_assignment_history WHERE egress_id = ? OR egress_fingerprint = ?').get(id, e.fingerprint) as { n: number }).n;
  }
  history(filter: { egressId?: string; profileId?: string }, limit = 50): HistoryRow[] {
    if (filter.egressId) return this.db.prepare('SELECT * FROM egress_assignment_history WHERE egress_id = ? ORDER BY id DESC LIMIT ?').all(filter.egressId, limit) as HistoryRow[];
    if (filter.profileId) return this.db.prepare('SELECT * FROM egress_assignment_history WHERE profile_id = ? ORDER BY id DESC LIMIT ?').all(filter.profileId, limit) as HistoryRow[];
    return this.db.prepare('SELECT * FROM egress_assignment_history ORDER BY id DESC LIMIT ?').all(limit) as HistoryRow[];
  }
  /** Is this egress a clean automatic candidate right now? */
  isClean(id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM egress e WHERE e.id = ? AND ${CLEAN_WHERE}`).get(id);
  }
  private openHistory(egressId: string, profileId: string, reason: HistoryReason, workflowId: string | null): void {
    const e = this.get(egressId);
    const p = this.db.prepare('SELECT label FROM profiles WHERE id = ?').get(profileId) as { label: string } | undefined;
    this.db.prepare('INSERT INTO egress_assignment_history (egress_id, egress_fingerprint, profile_id, profile_label, workflow_id, reason, assigned_at) VALUES (?,?,?,?,?,?,?)')
      .run(egressId, e?.fingerprint ?? null, profileId, p?.label ?? null, workflowId, reason, Date.now());
  }
  /** Close the open history row(s) of a binding. The rows stay forever; only ended_at is filled in. */
  private closeHistory(egressId: string, profileId: string, reason: string): void {
    this.db.prepare('UPDATE egress_assignment_history SET ended_at = ?, ended_reason = ? WHERE egress_id = ? AND profile_id = ? AND ended_at IS NULL').run(Date.now(), reason.slice(0, 200), egressId, profileId);
  }

  /** The account a proxy is bound to, if any. */
  boundAccount(id: string): { id: string; label: string; since: number | null } | null {
    const r = this.db.prepare('SELECT id, label, egress_bound_at FROM profiles WHERE egress_id = ?').get(id) as { id: string; label: string; egress_bound_at: number | null } | undefined;
    return r ? { id: r.id, label: r.label, since: r.egress_bound_at } : null;
  }

  meta(r: EgressRow, live = 0, lastWf: string | null = null, lastWfAt: number | null = null): EgressMeta {
    return {
      id: r.id, label: r.label, kind: r.kind, host: r.host, port: r.port, hasAuth: !!r.has_auth,
      boundTo: r.kind === 'direct' ? null : this.boundAccount(r.id),
      maxConcurrent: r.max_concurrent, holdAfterUse: !!r.hold_after_use, state: r.state, stateReason: r.state_reason,
      health: r.health, lastCheckAt: r.last_check_at, lastError: r.last_error, consecutiveFailures: r.consecutive_failures,
      useCount: r.use_count, lastUsedAt: r.last_used_at, heldSince: r.held_since, releasedAt: r.released_at,
      liveWorkflows: live, lastWorkflowId: lastWf, lastWorkflowAt: lastWfAt, createdAt: r.created_at,
      historicalAssignments: r.kind === 'direct' ? 0 : this.historyCount(r.id), clean: r.kind !== 'direct' && this.isClean(r.id),
    };
  }

  /** Playwright context proxy options for a row. Only ever handed to the browser; never logged. */
  proxyOptions(id: string): { server: string; username?: string; password?: string } | null {
    const r = this.get(id);
    if (!r || r.kind === 'direct') return null;
    const server = `${r.kind === 'socks5' ? 'socks5' : 'http'}://${r.host}:${r.port}`;
    if (!r.has_auth || !r.cred_enc || !r.cred_nonce || !r.cred_key_enc) return { server };
    const c = JSON.parse(this.vault.decrypt(`egress:${id}`, { ciphertext: r.cred_enc, nonce: r.cred_nonce, dataKeyEnc: r.cred_key_enc, keyVersion: r.cred_key_version ?? 1 })) as { username: string; password: string };
    return { server, username: c.username, password: c.password };
  }

  // ---------- allocation (called INSIDE ProfileStore.reserve's transaction) ----------

  /**
   * One CLEAN proxy for automatic assignment (never used by any account, ever), healthy first, oldest first;
   * when none exists and direct is allowed (development only), direct. Historical, bound, in-use, down or
   * degraded proxies are never handed out here, whatever their state says.
   */
  pickAvailable(directAllowed: boolean): string | null {
    const clean = this.pickClean();
    if (clean) return clean;
    if (!directAllowed) return null;
    const direct = this.db.prepare(`SELECT id FROM egress WHERE id = ? AND state = 'available'`).get(DIRECT_ID) as { id: string } | undefined;
    return direct?.id ?? null;
  }

  /** One clean proxy (see CLEAN_WHERE), or null. Never direct. */
  pickClean(): string | null {
    const row = this.db.prepare(`SELECT e.id FROM egress e WHERE ${CLEAN_WHERE}
      ORDER BY CASE WHEN e.health = 'healthy' THEN 0 ELSE 1 END, e.created_at ASC LIMIT 1`).get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * The egress an account must use: its bound proxy when it has one (reusable while available or held and not
   * down / retired / in use), else an unused proxy, which is then bound to the account, else direct when allowed.
   * `blocked` says why a bound account cannot run right now (its proxy is down, retired or in use) — the caller
   * must NOT allocate another proxy for it.
   */
  pickForAccount(profileId: string, directAllowed: boolean, workflowId: string | null = null): { id: string; bound: 'reused' | 'new' | 'direct'; needsFailover?: boolean } | { id: null; blocked: string | null } {
    const p = this.db.prepare('SELECT egress_id FROM profiles WHERE id = ?').get(profileId) as { egress_id: string | null } | undefined;
    if (p?.egress_id) {
      const e = this.get(p.egress_id);
      if (!e) { this.db.prepare('UPDATE profiles SET egress_id = NULL, egress_bound_at = NULL WHERE id = ?').run(profileId); }
      else if (e.state === 'available' || e.state === 'held') {
        const live = (this.db.prepare(`SELECT COUNT(*) n FROM assignments a WHERE a.egress_id = ? AND a.state IN ${LIVE}`).get(e.id) as { n: number }).n;
        if (live < e.max_concurrent) return { id: e.id, bound: 'reused' };
        return { id: null, blocked: `its proxy ${e.label} is in use` };
      } else if (e.state === 'down' && this.pickClean()) {
        // A down proxy is retried at launch (preflight); when that fails the launch performs ONE clean failover.
        // Only worth reserving while a clean replacement exists; otherwise the account waits for the operator.
        return { id: e.id, bound: 'reused', needsFailover: true };
      } else return { id: null, blocked: `its proxy ${e.label} is ${e.state === 'in_use' ? 'in use' : e.state}${e.state === 'down' ? ' and no clean replacement proxy exists' : ''}` };
    }
    const fresh = this.pickAvailable(directAllowed);
    if (!fresh) return { id: null, blocked: null };
    if (fresh === DIRECT_ID) return { id: fresh, bound: 'direct' };
    this.bind(fresh, profileId, 'initial', workflowId);
    return { id: fresh, bound: 'new' };
  }

  /**
   * Bind a proxy to an account (one proxy per account, one account per proxy; enforced by the unique index) and
   * record the assignment in the immutable history. Direct is never bound.
   */
  bind(egressId: string, profileId: string, reason: HistoryReason = 'initial', workflowId: string | null = null, operator: string | null = null): void {
    if (egressId === DIRECT_ID) throw new EgressError('DIRECT_EGRESS_FORBIDDEN', 'the direct egress is never bound to an account');
    const now = Date.now();
    this.db.prepare('UPDATE profiles SET egress_id = ?, egress_bound_at = ?, updated_at = ? WHERE id = ?').run(egressId, now, now, profileId);
    this.openHistory(egressId, profileId, reason, workflowId);
    const acct = this.boundAccount(egressId);
    this.event(egressId, null, 'bound', `bound to account ${acct?.label ?? profileId} (${reason})`, workflowId ?? undefined);
    this.audit.record('PROXY_ASSIGNED', { profileId, egressId, workflowId, operator, code: reason });
  }

  /** The proxy bound to an account, if any. */
  boundEgressOf(profileId: string): EgressRow | null {
    const p = this.db.prepare('SELECT egress_id FROM profiles WHERE id = ?').get(profileId) as { egress_id: string | null } | undefined;
    return p?.egress_id ? this.get(p.egress_id) ?? null : null;
  }

  markInUse(id: string, workflowId: string): void {
    const r = this.get(id)!;
    const now = Date.now();
    if (r.hold_after_use) {
      this.db.prepare("UPDATE egress SET state='in_use', use_count=use_count+1, last_used_at=?, updated_at=? WHERE id=?").run(now, now, id);
      this.event(id, r.state, 'in_use', 'allocated', workflowId);
    } else {
      this.db.prepare('UPDATE egress SET use_count=use_count+1, last_used_at=?, updated_at=? WHERE id=?').run(now, now, id);
    }
  }

  /**
   * Take the account's egress exclusively for something that is not a workflow (the manual login capture
   * browser): the account's bound proxy, else an unused proxy that becomes bound, else direct when allowed.
   * The session is in_use until releaseExclusive(), then held for the account.
   */
  acquireExclusive(profileId: string, directAllowed: boolean, tag: string): { id: string } | { id: null; blocked: string | null } {
    return this.db.transaction(() => {
      const pick = this.pickForAccount(profileId, directAllowed);
      if (!pick.id) return pick;
      this.markInUse(pick.id, tag);
      return { id: pick.id };
    })();
  }

  releaseExclusive(id: string, tag: string, reason: string): void {
    this.markUsed(id, tag, reason);
  }

  /** The workflow that used it ended: the session is HELD for its account (the binding stays); direct stays available. */
  markUsed(id: string, workflowId: string, reason: string): void {
    const r = this.get(id);
    if (!r || !r.hold_after_use || r.state !== 'in_use') return;
    const now = Date.now();
    const acct = this.boundAccount(id);
    this.db.prepare("UPDATE egress SET state='held', held_since=?, state_reason=?, updated_at=? WHERE id=?").run(now, `held for ${acct ? acct.label : 'its account'} (${reason})`, now, id);
    this.event(id, 'in_use', 'held', reason, workflowId);
  }

  // ---------- operator actions ----------

  /**
   * Release (held): clears the account binding and returns the proxy to the unused pool — only after the operator
   * confirmed with the provider that the session may be reused elsewhere. Restore (down) / Reinstate (retired):
   * back into rotation, keeping the binding so the account keeps its proxy. Never from in_use.
   */
  release(id: string, by = 'operator'): EgressMeta {
    const r = this.get(id);
    if (!r) throw new Error('egress not found');
    if (r.state === 'in_use') throw new Error('this egress is attached to a running workflow');
    const now = Date.now();
    const acct = this.boundAccount(id);
    if (r.state === 'held') {
      this.db.prepare("UPDATE egress SET state='available', state_reason=NULL, held_since=NULL, released_at=?, updated_at=? WHERE id=?").run(now, now, id);
      if (acct) {
        this.db.prepare('UPDATE profiles SET egress_id = NULL, egress_bound_at = NULL, updated_at = ? WHERE id = ?').run(now, acct.id);
        this.closeHistory(id, acct.id, `released by ${by}`); // provenance stays: this proxy is never clean again
        this.event(id, 'held', 'available', `released by ${by}: unbound from account ${acct.label} (history kept)`);
      } else this.event(id, 'held', 'available', `released by ${by}`);
      this.audit.record('PROXY_RELEASED', { egressId: id, profileId: acct?.id ?? null, operator: by, detail: acct ? 'unbound from its account; assignment history retained' : 'released' });
      return this.meta(this.get(id)!);
    }
    if (r.state === 'available') return this.meta(r);
    // down / retired -> back into rotation: held when bound to an account, available when unbound
    const next: EgressState = acct && r.kind !== 'direct' ? 'held' : 'available';
    this.db.prepare("UPDATE egress SET state=?, state_reason=?, held_since=CASE WHEN ?='held' THEN COALESCE(held_since, ?) ELSE NULL END, released_at=?, consecutive_failures=0, health=CASE WHEN health='down' THEN 'unknown' ELSE health END, updated_at=? WHERE id=?")
      .run(next, next === 'held' ? `held for ${acct!.label}` : null, next, now, now, now, id);
    this.event(id, r.state, next, `${r.state === 'down' ? 'restored' : 'reinstated'} by ${by}${acct ? ` (still bound to ${acct.label})` : ''}`);
    this.audit.record('PROXY_ENABLED', { egressId: id, profileId: acct?.id ?? null, operator: by, code: r.state === 'down' ? 'restored' : 'reinstated' });
    return this.meta(this.get(id)!);
  }

  /** Remove the binding without touching the proxy (used when an account is deleted). */
  unbindAccount(profileId: string, reason: string): void {
    const e = this.boundEgressOf(profileId);
    if (!e) return;
    this.db.prepare('UPDATE profiles SET egress_id = NULL, egress_bound_at = NULL WHERE id = ?').run(profileId);
    this.closeHistory(e.id, profileId, reason); // the history row itself survives the account
    this.event(e.id, null, 'unbound', `${reason} (history kept)`);
  }

  // ---------- failure + replacement (same account, same profile, same userDataDir; only the network changes) ----------

  /**
   * The assigned proxy failed its launch preflight (or launch): take it down now, keep its binding history.
   * Unlike a single health probe, this is an explicit launch-time decision made after the preflight attempts.
   */
  markFailed(id: string, reason: string, workflowId?: string): void {
    const r = this.get(id);
    if (!r || r.kind === 'direct') return;
    const now = Date.now();
    this.db.prepare("UPDATE egress SET state='down', health='down', state_reason=?, last_error=?, last_check_at=?, updated_at=? WHERE id=?")
      .run(`launch preflight failed: ${reason}`.slice(0, 200), reason.slice(0, 200), now, now, id);
    this.event(id, r.state, 'down', `launch preflight failed: ${reason}`.slice(0, 200), workflowId);
    this.audit.record('PROXY_FAILURE', { egressId: id, profileId: this.boundAccount(id)?.id ?? null, workflowId: workflowId ?? null, code: 'PREFLIGHT_FAILED', detail: reason });
  }

  /**
   * Automatic clean failover for ONE account: in a single immediate transaction, verify the account still has the
   * failed proxy, pick a CLEAN proxy (zero assignment history, never direct), move the binding and the live
   * assignment to it, mark it in use, record history + audit. Throws NO_CLEAN_EGRESS_AVAILABLE when none exists
   * (the account, its profile and its old binding are left intact for the operator).
   */
  replaceProxyAutomatically(profileId: string, failedEgressId: string, workflowId: string | null): { oldEgressId: string; newEgressId: string } {
    try {
      return this.db.transaction(() => {
        const p = this.db.prepare('SELECT id, label, egress_id FROM profiles WHERE id = ?').get(profileId) as { id: string; label: string; egress_id: string | null } | undefined;
        if (!p) throw new EgressError('EGRESS_BINDING_CHANGED', 'account not found');
        if (p.egress_id !== failedEgressId) throw new EgressError('EGRESS_BINDING_CHANGED', `the account is no longer bound to the failed proxy`);
        const fresh = this.pickClean();
        if (!fresh) throw new EgressError('NO_CLEAN_EGRESS_AVAILABLE', 'No clean replacement proxy (never assigned to any account, healthy, unassigned) is available. The account keeps its profile and waits for an operator.');
        return this.moveBinding(p.id, failedEgressId, fresh, 'automatic_failover', workflowId, null);
      }).immediate();
    } catch (e) {
      // recorded AFTER the rollback so the audit row survives the failed transaction
      if (e instanceof EgressError && e.code === 'NO_CLEAN_EGRESS_AVAILABLE') this.audit.record('NO_CLEAN_EGRESS_AVAILABLE', { profileId, egressId: failedEgressId, workflowId, code: e.code, detail: 'no never-assigned healthy proxy; account left intact, no direct fallback' });
      throw e;
    }
  }

  /**
   * Operator replacement. The new proxy must be a real proxy, available, unbound and not in use; a proxy with
   * assignment history is accepted ONLY with allowHistorical=true (an explicit decision, never automatic).
   */
  replaceProxyManually(profileId: string, newEgressId: string, operator: string, opts: { allowHistorical?: boolean } = {}): { oldEgressId: string | null; newEgressId: string } {
    return this.db.transaction(() => {
      const p = this.db.prepare('SELECT id, label, egress_id FROM profiles WHERE id = ?').get(profileId) as { id: string; label: string; egress_id: string | null } | undefined;
      if (!p) throw new Error('account not found');
      if (this.db.prepare('SELECT 1 FROM profile_runtimes WHERE profile_id = ?').get(profileId)) throw new Error('the account browser is running; close it before changing its proxy');
      const e = this.get(newEgressId);
      if (!e) throw new Error('egress not found');
      if (e.kind === 'direct') throw new EgressError('DIRECT_EGRESS_FORBIDDEN', 'the direct egress cannot be bound to an account');
      if (e.state !== 'available') throw new EgressError('EGRESS_NOT_ELIGIBLE', `proxy ${e.label} is ${e.state}`);
      if (this.boundAccount(e.id)) throw new EgressError('EGRESS_NOT_ELIGIBLE', `proxy ${e.label} is bound to another account`);
      const live = (this.db.prepare(`SELECT COUNT(*) n FROM assignments a WHERE a.egress_id = ? AND a.state IN ${LIVE}`).get(e.id) as { n: number }).n;
      if (live > 0) throw new EgressError('EGRESS_NOT_ELIGIBLE', `proxy ${e.label} is attached to a running workflow`);
      if (this.hasHistory(e.id) && !opts.allowHistorical) throw new EgressError('HISTORICAL_PROXY_REQUIRES_CONFIRMATION', `proxy ${e.label} was assigned to an account before; confirm explicitly to reuse it`);
      if (p.egress_id === newEgressId) return { oldEgressId: p.egress_id, newEgressId };
      if (!p.egress_id) {
        const now = Date.now();
        const taken = this.db.prepare("UPDATE egress SET state='held', held_since=?, state_reason=?, updated_at=? WHERE id=? AND state='available'").run(now, `held for ${p.label} (manual_bind)`, now, newEgressId);
        if (taken.changes !== 1) throw new EgressError('EGRESS_NOT_ELIGIBLE', 'the proxy was taken concurrently');
        this.bind(newEgressId, profileId, 'manual_bind', null, operator);
        this.event(newEgressId, 'available', 'held', `assigned by ${operator} (manual_bind)`);
        return { oldEgressId: null, newEgressId };
      }
      return this.moveBinding(p.id, p.egress_id, newEgressId, 'manual_replace', null, operator);
    }).immediate();
  }

  /** Inside a transaction: old binding closed (proxy stays down/available but unbound, history kept), new one opened. */
  private moveBinding(profileId: string, oldId: string, newId: string, reason: HistoryReason, workflowId: string | null, operator: string | null): { oldEgressId: string; newEgressId: string } {
    const now = Date.now();
    const old = this.get(oldId);
    // the old proxy loses its binding; a held/in_use one becomes plain available (historical, so never clean), a down one stays down
    const oldNext: EgressState = reason === 'automatic_failover' ? 'down' : old && (old.state === 'held' || old.state === 'in_use') ? 'available' : old?.state ?? 'available';
    this.db.prepare('UPDATE profiles SET egress_id = NULL, egress_bound_at = NULL, updated_at = ? WHERE id = ?').run(now, profileId);
    this.closeHistory(oldId, profileId, reason);
    if (old) {
      this.db.prepare("UPDATE egress SET state=?, held_since=NULL, state_reason=COALESCE(?, state_reason), updated_at=? WHERE id=?")
        .run(oldNext, oldNext === 'available' ? `replaced (${reason}); historical, never automatically reassigned` : null, now, oldId);
      this.event(oldId, old.state, oldNext, `replaced by ${reason}`, workflowId ?? undefined);
    }
    // the new proxy is taken with a guarded UPDATE: a concurrent replacement that won the race leaves changes=0
    const taken = this.db.prepare("UPDATE egress SET state=CASE WHEN ? IS NULL THEN 'held' ELSE 'in_use' END, use_count=use_count+CASE WHEN ? IS NULL THEN 0 ELSE 1 END, last_used_at=CASE WHEN ? IS NULL THEN last_used_at ELSE ? END, held_since=CASE WHEN ? IS NULL THEN ? ELSE NULL END, state_reason=?, updated_at=? WHERE id=? AND state='available'")
      .run(workflowId, workflowId, workflowId, now, workflowId, now, workflowId ? null : `held for its account (${reason})`, now, newId);
    if (taken.changes !== 1) throw new EgressError('EGRESS_NOT_ELIGIBLE', 'the replacement proxy was taken concurrently');
    this.bind(newId, profileId, reason, workflowId, operator);
    if (workflowId) {
      this.db.prepare(`UPDATE assignments SET egress_id = ?, updated_at = ? WHERE workflow_id = ? AND profile_id = ? AND state IN ${LIVE}`).run(newId, now, workflowId, profileId);
      this.event(newId, 'available', 'in_use', `allocated by ${reason}`, workflowId);
    }
    this.audit.record(reason === 'automatic_failover' ? 'PROXY_AUTOMATIC_FAILOVER' : 'PROXY_MANUAL_REPLACEMENT', { profileId, oldEgressId: oldId, newEgressId: newId, workflowId, operator, code: reason });
    return { oldEgressId: oldId, newEgressId: newId };
  }

  retire(id: string, by = 'operator'): EgressMeta {
    const r = this.get(id);
    if (!r) throw new Error('egress not found');
    if (r.state === 'in_use') throw new Error('this egress is attached to a running workflow');
    const now = Date.now();
    this.db.prepare("UPDATE egress SET state='retired', state_reason=?, updated_at=? WHERE id=?").run(`retired by ${by}`, now, id);
    this.event(id, r.state, 'retired', `retired by ${by}`);
    this.audit.record('PROXY_DISABLED', { egressId: id, profileId: this.boundAccount(id)?.id ?? null, operator: by, code: 'retired' });
    return this.meta(this.get(id)!);
  }

  remove(id: string): void {
    const r = this.get(id);
    if (!r) throw new Error('egress not found');
    if (r.kind === 'direct') throw new Error('the direct egress cannot be removed; retire it instead');
    if (r.state === 'in_use') throw new Error('this egress is attached to a running workflow');
    const acct = this.boundAccount(id);
    this.db.transaction(() => {
      if (acct) { this.db.prepare('UPDATE profiles SET egress_id = NULL, egress_bound_at = NULL WHERE egress_id = ?').run(id); this.closeHistory(id, acct.id, 'proxy removed'); }
      this.db.prepare('DELETE FROM egress_events WHERE egress_id = ?').run(id);
      this.db.prepare('DELETE FROM egress WHERE id = ?').run(id);
      // egress_assignment_history rows are kept on purpose (by id and fingerprint): a re-import of the same proxy is not clean
      this.audit.record('PROXY_REMOVED', { egressId: id, profileId: acct?.id ?? null, detail: 'assignment history retained' });
    })();
  }

  // ---------- health ----------

  /** Active check result. Three consecutive failures take an available/held egress out of rotation (down). */
  recordCheck(id: string, ok: boolean, error?: string): void {
    const r = this.get(id);
    if (!r) return;
    const now = Date.now();
    if (ok) {
      this.db.prepare("UPDATE egress SET health='healthy', last_check_at=?, last_error=NULL, consecutive_failures=0, updated_at=? WHERE id=?").run(now, now, id);
      return;
    }
    const failures = r.consecutive_failures + 1;
    const health: EgressHealth = failures >= 3 ? 'down' : 'degraded';
    const takeDown = failures >= 3 && (r.state === 'available' || r.state === 'held');
    this.db.prepare(`UPDATE egress SET health=?, last_check_at=?, last_error=?, consecutive_failures=?, ${takeDown ? "state='down', state_reason='health check failed 3 times'," : ''} updated_at=? WHERE id=?`)
      .run(health, now, (error ?? 'check failed').slice(0, 200), failures, now, id);
    if (takeDown) this.event(id, r.state, 'down', 'health check failed 3 times');
  }

  /** A workflow could not get through this egress (network error during prepare). Counts like a failed check; a held/available egress goes down at 3. */
  recordWorkflowFailure(id: string, workflowId: string, error: string): void {
    const r = this.get(id);
    if (!r || r.kind === 'direct') return;
    this.recordCheck(id, false, `workflow ${workflowId.slice(0, 8)}: ${error}`);
    const after = this.get(id)!;
    if (after.state === 'in_use' && after.consecutive_failures >= 3) {
      // it will be released by the assignment; mark it so the release lands on 'down' instead of 'held'
      this.db.prepare("UPDATE egress SET state_reason='network failures' WHERE id=?").run(id);
    }
    this.event(id, null, 'workflow_failed', error.slice(0, 200), workflowId);
  }

  /** Rows worth checking actively. */
  checkable(): EgressRow[] {
    return this.db.prepare("SELECT * FROM egress WHERE kind != 'direct' AND state IN ('available','held','down')").all() as EgressRow[];
  }

  counts(): { total: number; available: number; clean: number; inUse: number; held: number; down: number; retired: number } {
    const rows = this.db.prepare("SELECT state, COUNT(*) n FROM egress WHERE kind != 'direct' GROUP BY state").all() as { state: EgressState; n: number }[];
    const c = (s: EgressState) => rows.find((r) => r.state === s)?.n ?? 0;
    const clean = (this.db.prepare(`SELECT COUNT(*) n FROM egress e WHERE ${CLEAN_WHERE}`).get() as { n: number }).n;
    return { total: rows.reduce((a, r) => a + r.n, 0), available: c('available'), clean, inUse: c('in_use'), held: c('held'), down: c('down'), retired: c('retired') };
  }

  events(id: string, limit = 20): { from_state: string | null; to_state: string; reason: string | null; workflow_id: string | null; at: number }[] {
    return this.db.prepare('SELECT from_state,to_state,reason,workflow_id,at FROM egress_events WHERE egress_id=? ORDER BY id DESC LIMIT ?').all(id, limit) as any;
  }

  private event(id: string, from: string | null, to: string, reason?: string, workflowId?: string): void {
    this.db.prepare('INSERT INTO egress_events (egress_id, from_state, to_state, reason, workflow_id, at) VALUES (?,?,?,?,?,?)').run(id, from, to, reason ?? null, workflowId ?? null, Date.now());
  }
}
