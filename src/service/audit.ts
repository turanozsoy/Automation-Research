import type { Db } from './db.js';

/**
 * Operator-facing audit trail for the isolation layer: who ran which account through which proxy, lock
 * conflicts and recoveries, proxy failures and replacements. Rows carry identifiers and safe codes only.
 * Never cookies, storage, session tokens, passwords, proxy usernames/passwords or page contents.
 */
export type AuditType =
  | 'ACCOUNT_LAUNCHED' | 'ACCOUNT_CLOSED'
  | 'PROFILE_RUNTIME_LOCK_ACQUIRED' | 'PROFILE_RUNTIME_LOCK_CONFLICT' | 'PROFILE_RUNTIME_LOCK_RECOVERED' | 'PROFILE_RUNTIME_LOCK_RELEASED'
  | 'PROFILE_CREATED' | 'PROFILE_MIGRATED' | 'PROFILE_ENVIRONMENT_SET' | 'PROFILE_DIR_RETAINED'
  | 'PROXY_ASSIGNED' | 'PROXY_FAILURE' | 'PROXY_AUTOMATIC_FAILOVER' | 'PROXY_MANUAL_REPLACEMENT' | 'PROXY_RELEASED'
  | 'PROXY_DISABLED' | 'PROXY_ENABLED' | 'PROXY_REMOVED'
  | 'BROWSER_CRASHED' | 'NO_CLEAN_EGRESS_AVAILABLE';

export interface AuditEntry {
  profileId?: string | null; egressId?: string | null; oldEgressId?: string | null; newEgressId?: string | null;
  workflowId?: string | null; operator?: string | null; code?: string | null; detail?: string | null;
}
export interface AuditRow extends Required<AuditEntry> { id: number; type: AuditType; at: number }

/** Strip anything that looks like a URL with credentials or a long token before it lands in the audit table. */
export function safeDetail(s: string | undefined | null): string | null {
  if (!s) return null;
  return s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s@/]+@/gi, '<credentials>@').replace(/[A-Za-z0-9_-]{48,}/g, '<token>').slice(0, 300);
}

export class AuditLog {
  constructor(private db: Db) {}

  record(type: AuditType, e: AuditEntry = {}): void {
    this.db.prepare(`INSERT INTO audit_events (type, profile_id, egress_id, old_egress_id, new_egress_id, workflow_id, operator, code, detail, at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(type, e.profileId ?? null, e.egressId ?? null, e.oldEgressId ?? null, e.newEgressId ?? null, e.workflowId ?? null, e.operator ?? null, e.code ?? null, safeDetail(e.detail), Date.now());
  }

  list(filter: { profileId?: string; egressId?: string; type?: AuditType } = {}, limit = 50): AuditRow[] {
    const where: string[] = []; const args: unknown[] = [];
    if (filter.profileId) { where.push('profile_id = ?'); args.push(filter.profileId); }
    if (filter.egressId) { where.push('(egress_id = ? OR old_egress_id = ? OR new_egress_id = ?)'); args.push(filter.egressId, filter.egressId, filter.egressId); }
    if (filter.type) { where.push('type = ?'); args.push(filter.type); }
    const rows = this.db.prepare(`SELECT * FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(500, Math.max(1, limit))) as any[];
    return rows.map((r) => ({ id: r.id, type: r.type, at: r.at, profileId: r.profile_id, egressId: r.egress_id, oldEgressId: r.old_egress_id, newEgressId: r.new_egress_id, workflowId: r.workflow_id, operator: r.operator, code: r.code, detail: r.detail }));
  }
}
