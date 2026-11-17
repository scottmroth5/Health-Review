// The SQLite store and migration runner (v3 Phase 1D): taken over from agent-core's openStore (0.4.0) with the same
// behavior, so this repo owns its whole schema, the runs and run_calls tables included (db/runs.js writes them).
// Those two tables keep their original migration name, "agent-core:001-runs" in schema_migrations, so a database
// created before the move sees it as applied and nothing reruns. 1C's PostgreSQL baseline schema includes them too.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The namespace the runs tables were migrated under while agent-core owned them; kept for existing databases. */
export const RUNS_NAMESPACE = 'agent-core';

/** One SQLite migration: SQL text, or a function given the database; foreignKeys false runs it with enforcement off. */
export interface SqliteMigration {
  id: string;
  up: string | ((db: Database.Database) => void);
  foreignKeys?: boolean;
}

/** What openSqliteStore opens: the sync database, a sync transaction, and close. */
export interface SqliteStore {
  db: Database.Database;
  tx: <T>(fn: () => T) => T;
  close: () => void;
}

const RUNS_MIGRATIONS: SqliteMigration[] = [
  {
    id: '001-runs',
    up: `
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        meta TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        calls INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        summary TEXT
      );
      CREATE TABLE run_calls (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        label TEXT,
        model TEXT,
        stop_reason TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        duration_ms INTEGER,
        error_name TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX run_calls_run_id ON run_calls(run_id);
    `,
  },
];

/**
 * Opens (or creates) a SQLite database and applies migrations: the runs tables first (under RUNS_NAMESPACE), then the
 * app's under options.app. Each migration runs once, in array order, inside its own transaction; applied ids are
 * recorded in schema_migrations.
 *
 * A migration with foreignKeys: false runs with foreign key enforcement off, for SQLite's documented table rebuild
 * (create the new table, copy, drop the old one, rename): with enforcement on, dropping a parent table would run its
 * children's ON DELETE actions. It still runs in its own transaction, and before commit foreign_key_check must find
 * no broken references and integrity_check must pass, or the whole migration rolls back. Enforcement is back on
 * afterwards either way.
 *
 * @param {string} path  file path, or ':memory:' for tests; parent folders are created
 * @param {object} [options]
 * @param {string} [options.app]  namespace for the app's migrations (required when migrations are given)
 * @param {Array<{id: string, up: string | ((db: import('better-sqlite3').Database) => void), foreignKeys?: boolean}>} [options.migrations]
 * @returns {{ db: import('better-sqlite3').Database, tx: <T>(fn: () => T) => T, close: () => void }}
 */
export function openSqliteStore(path: string, { app, migrations = [] }: { app?: string, migrations?: SqliteMigration[] } = {}): SqliteStore {
  if (migrations.length && !app) throw new TypeError('openSqliteStore: app is required when migrations are given');
  if (app === RUNS_NAMESPACE) throw new TypeError(`openSqliteStore: "${RUNS_NAMESPACE}" is a reserved migration namespace`);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    app TEXT NOT NULL,
    id TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (app, id)
  )`);

  try {
    migrate(db, RUNS_NAMESPACE, RUNS_MIGRATIONS);
    if (migrations.length) migrate(db, app!, migrations); // app is checked above whenever migrations are given
  } catch (err) {
    db.close();
    throw err;
  }

  return {
    db,
    tx: <T>(fn: () => T): T => db.transaction(fn)(),
    close: () => db.close(),
  };
}

function migrate(db: Database.Database, app: string, migrations: SqliteMigration[]): void {
  const seen = new Set();
  for (const m of migrations) {
    if (!m?.id || !m.up) throw new TypeError(`openSqliteStore: every ${app} migration needs an id and an up`);
    if (seen.has(m.id)) throw new TypeError(`openSqliteStore: duplicate ${app} migration id "${m.id}"`);
    seen.add(m.id);
  }
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations WHERE app = ?').pluck().all(app) as string[]);
  const mark = db.prepare('INSERT INTO schema_migrations (app, id, applied_at) VALUES (?, ?, ?)');
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const apply = () => {
      if (typeof m.up === 'function') m.up(db);
      else db.exec(m.up);
      mark.run(app, m.id, new Date().toISOString());
    };
    if (m.foreignKeys === false) withoutForeignKeys(db, `${app}:${m.id}`, apply);
    else db.transaction(apply)();
  }
}

// PRAGMA foreign_keys is ignored inside a transaction, so it is switched off before the migration's transaction starts.
function withoutForeignKeys(db: Database.Database, name: string, apply: () => void): void {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      apply();
      const broken = db.pragma('foreign_key_check') as Array<{ table: string }>;
      if (broken.length) {
        const tables = [...new Set(broken.map((b) => b.table))].join(', ');
        throw new Error(`migration ${name}: ${broken.length} row(s) in ${tables} would break a foreign key; rolled back`);
      }
      const check = db.pragma('integrity_check', { simple: true });
      if (check !== 'ok') throw new Error(`migration ${name}: integrity check failed (${check}); rolled back`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
