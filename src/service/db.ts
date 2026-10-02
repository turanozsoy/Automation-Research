import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE profiles (
    id                   TEXT PRIMARY KEY,
    label                TEXT NOT NULL,
    account_key          TEXT NOT NULL UNIQUE,
    state                TEXT NOT NULL,
    storage_state_enc    BLOB NOT NULL,
    nonce                BLOB NOT NULL,
    data_key_enc         BLOB NOT NULL,
    key_version          INTEGER NOT NULL DEFAULT 1,
    needs_verify         INTEGER NOT NULL DEFAULT 0,
    cooldown_until       INTEGER,
    last_verified_at     INTEGER,
    last_used_at         INTEGER,
    use_count            INTEGER NOT NULL DEFAULT 0,
    usage_window         TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    state_reason         TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  CREATE TABLE assignments (
    workflow_id      TEXT PRIMARY KEY,
    profile_id       TEXT NOT NULL REFERENCES profiles(id),
    state            TEXT NOT NULL,
    instance_id      TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    client_ip        TEXT,
    egress           TEXT NOT NULL DEFAULT 'none',
    reassign_count   INTEGER NOT NULL DEFAULT 0,
    submit_state     TEXT NOT NULL DEFAULT 'none',
    idempotency_key  TEXT,
    snapshot_hash    TEXT,
    submitted_at     INTEGER,
    result_url       TEXT,
    outcome_code     TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    ended_at         INTEGER
  );
  -- A profile can be held by at most ONE live workflow, enforced by the database itself.
  CREATE UNIQUE INDEX assignments_live_profile
    ON assignments(profile_id)
    WHERE state IN ('allocating','preparing','ready','submitting','paused');
  CREATE TABLE profile_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
    reason TEXT, workflow_id TEXT, at INTEGER NOT NULL
  );
  CREATE TABLE workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
    reason TEXT, at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE assignments ADD COLUMN link_state TEXT NOT NULL DEFAULT 'none';  -- none | visited | verified
  ALTER TABLE assignments ADD COLUMN visited_at INTEGER;
  ALTER TABLE assignments ADD COLUMN verified_at INTEGER;
  `,
  `
  -- An account can exist before it has a saved session. session_saved_at IS NULL = no session yet.
  ALTER TABLE profiles ADD COLUMN session_saved_at INTEGER;
  -- Reserved for the per-account network configuration (proxy / egress IP); not used yet.
  ALTER TABLE profiles ADD COLUMN proxy_json TEXT;
  UPDATE profiles SET session_saved_at = updated_at;
  `,
  `
  -- Shipzora applications: the applicant's persistent record. Independent of workflows (automation runs)
  -- and profiles (Website B accounts). workflow_id is the CURRENT automation run, if any; history lives
  -- in application_events. The verification code is never stored: only verification_step metadata.
  CREATE TABLE applications (
    id                     TEXT PRIMARY KEY,
    session_token_hash     TEXT NOT NULL UNIQUE,   -- sha256 of the applicant's opaque session token; the token itself is never stored
    state                  TEXT NOT NULL,          -- started | processing | link_ready | completed | problem
    current_step           TEXT NOT NULL,
    first_name             TEXT,
    last_name              TEXT,
    email                  TEXT,
    phone                  TEXT,
    date_of_birth          TEXT,
    address1               TEXT,
    city                   TEXT,
    address_state          TEXT,
    zip                    TEXT,
    answers_json           TEXT NOT NULL DEFAULT '{}',
    verification_step      TEXT NOT NULL DEFAULT 'required',   -- required | completed | failed
    workflow_id            TEXT,
    workflow_count         INTEGER NOT NULL DEFAULT 0,
    generated_url          TEXT,
    generated_url_ready_at INTEGER,
    final_link_clicked_at  INTEGER,
    link_state             TEXT NOT NULL DEFAULT 'none',       -- none | visited | verified
    visited_at             INTEGER,
    verified_at            INTEGER,
    problem_code           TEXT,
    problem_message        TEXT,
    problem_at             INTEGER,
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL,
    last_activity_at       INTEGER NOT NULL
  );
  CREATE INDEX applications_workflow ON applications(workflow_id);
  CREATE TABLE application_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    workflow_id    TEXT,
    type           TEXT NOT NULL,
    step           TEXT,
    stage          TEXT,
    code           TEXT,
    message        TEXT,
    detail         TEXT,
    retry_count    INTEGER,
    at             INTEGER NOT NULL
  );
  CREATE INDEX application_events_app ON application_events(application_id, id);
  `,
  `
  -- Which account processed an application, kept on the application itself so it survives assignment
  -- cleanup and account removal (the label is a snapshot). Set when the generated link is captured.
  ALTER TABLE applications ADD COLUMN processed_workflow_id TEXT;
  ALTER TABLE applications ADD COLUMN processed_profile_id TEXT;
  ALTER TABLE applications ADD COLUMN processed_profile_label TEXT;
  CREATE INDEX applications_verified ON applications(verified_at);
  CREATE INDEX applications_processed_workflow ON applications(processed_workflow_id);
  -- Operator-facing note about the saved session (e.g. SESSION_PERSIST_FAILED); cleared when a session is saved.
  ALTER TABLE profiles ADD COLUMN session_note TEXT;
  `,
  `
  -- Egress: where a workflow's traffic leaves from. 'direct' is the server's own IP. Proxy rows are exclusive
  -- sessions (max_concurrent, default 1) that are HELD after use until an operator releases them. Credentials
  -- use the same envelope encryption as sessions.
  CREATE TABLE egress (
    id                   TEXT PRIMARY KEY,
    label                TEXT NOT NULL,
    kind                 TEXT NOT NULL,            -- direct | http | socks5
    host                 TEXT,
    port                 INTEGER,
    fingerprint          TEXT NOT NULL UNIQUE,     -- sha256 of kind|host|port|username|password: the same proxy is never stored twice
    cred_enc             BLOB, cred_nonce BLOB, cred_key_enc BLOB, cred_key_version INTEGER,
    has_auth             INTEGER NOT NULL DEFAULT 0,
    max_concurrent       INTEGER NOT NULL DEFAULT 1,
    hold_after_use       INTEGER NOT NULL DEFAULT 1,
    state                TEXT NOT NULL,            -- available | in_use | held | down | retired
    state_reason         TEXT,
    health               TEXT NOT NULL DEFAULT 'unknown',   -- unknown | healthy | degraded | down
    last_check_at        INTEGER,
    last_error           TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    use_count            INTEGER NOT NULL DEFAULT 0,
    last_used_at         INTEGER,
    held_since           INTEGER,
    released_at          INTEGER,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  CREATE TABLE egress_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, egress_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
    reason TEXT, workflow_id TEXT, at INTEGER NOT NULL
  );
  INSERT INTO egress (id, label, kind, fingerprint, has_auth, max_concurrent, hold_after_use, state, health, created_at, updated_at)
    VALUES ('direct', 'Direct (server IP)', 'direct', 'direct', 0, 1000, 0, 'available', 'healthy', strftime('%s','now') * 1000, strftime('%s','now') * 1000);
  -- Which egress a workflow ran through, which application it belongs to, and a lease token that fences late writes.
  ALTER TABLE assignments ADD COLUMN egress_id TEXT;
  ALTER TABLE assignments ADD COLUMN application_id TEXT;
  ALTER TABLE assignments ADD COLUMN lease_token TEXT;
  CREATE UNIQUE INDEX assignments_live_application ON assignments(application_id)
    WHERE application_id IS NOT NULL AND state IN ('allocating','preparing','ready','submitting','paused');
  `,
  // 7: applicant-facing copy overrides edited from the operations page (copy only; defaults live in code)
  `
  CREATE TABLE site_content (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 8: an account is bound to one proxy egress on first use and keeps it until an operator releases the proxy
  `
  ALTER TABLE profiles ADD COLUMN egress_id TEXT;
  ALTER TABLE profiles ADD COLUMN egress_bound_at INTEGER;
  CREATE UNIQUE INDEX profiles_egress_binding ON profiles(egress_id) WHERE egress_id IS NOT NULL;
  `,
];

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version as number));
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    })();
  });
  return db;
}
