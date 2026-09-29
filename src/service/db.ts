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
