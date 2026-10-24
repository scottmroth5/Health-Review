import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from '@scottmroth5/agent-core';
import { dataPath } from '../tools/paths.js';
import { MIGRATIONS } from './migrations.js';
import { scopeStore } from './scope.js';
import { OWNER_ID, syncOwnerEmail } from './users.js';

export const DEFAULT_DB_PATH = dataPath('health.db');
/** How many pre-migration copies are kept in data/backups (newest first). */
export const KEEP_MIGRATION_COPIES = 5;

const appliedIds = (db) => db.prepare("SELECT app || ':' || id FROM schema_migrations ORDER BY app, id").pluck().all();

/**
 * A consistent single-file copy of a database (VACUUM INTO), checked with PRAGMA integrity_check. Throws when the copy
 * is not sound, after deleting it.
 */
export function copyDatabase(path, to) {
  mkdirSync(dirname(to), { recursive: true });
  const src = new Database(path, { readonly: true, fileMustExist: true });
  try {
    src.prepare('VACUUM INTO ?').run(to);
  } finally {
    src.close();
  }
  const copy = new Database(to, { readonly: true });
  let ok;
  try {
    ok = copy.pragma('integrity_check', { simple: true }) === 'ok';
  } finally {
    copy.close();
  }
  if (!ok) {
    rmSync(to, { force: true });
    throw new Error(`The copy of ${path} failed its integrity check; not migrating`);
  }
  return to;
}

/** The schema_migrations entries a database has (empty for a new or migration-less file). */
function appliedIn(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get() ? appliedIds(db) : [];
  } finally {
    db.close();
  }
}

/**
 * Opens the health database (agent-core's runs tables plus this app's tables), applying any new migrations.
 * Before any migration changes an existing file, a checked copy is taken (owner's rule, 2026-10-24: back up before every
 * database change): data/backups/pre-migration-<UTC stamp>.db next to the database, kept only when something migrated
 * (the newest KEEP_MIGRATION_COPIES stay), so the database is never changed without a copy to go back to.
 * @param {string} [path]  HEALTH_DB_PATH, else data/health.db; ':memory:' for tests
 * @param {{ snapshot?: boolean, log?: { info: Function } }} [options]  snapshot false: no copy (a throwaway copy itself)
 */
export function openHealthStore(path = process.env.HEALTH_DB_PATH || DEFAULT_DB_PATH, { snapshot = true, log = console } = {}) {
  let copy = null;
  let before = null;
  if (snapshot && path !== ':memory:' && existsSync(path)) {
    before = appliedIn(path);
    const stamp = new Date().toISOString().replace(/[-:.]/g, ''); // 20261024T153012123Z: milliseconds keep names apart
    copy = copyDatabase(path, join(dirname(path), 'backups', `pre-migration-${stamp}.db`));
  }
  const store = openStore(path, { app: 'health-review', migrations: MIGRATIONS });
  if (copy) {
    const added = appliedIds(store.db).filter((id) => !before.includes(id));
    if (!added.length) {
      rmSync(copy, { force: true });
    } else {
      log.info?.(`[migrate] applied ${added.join(', ')}; the database before them is ${copy}`);
      pruneMigrationCopies(dirname(copy));
    }
  }
  syncOwnerEmail(store.db);
  return store;
}

/** Keeps the newest KEEP_MIGRATION_COPIES pre-migration copies in a folder; other files are never touched. */
export function pruneMigrationCopies(dir, keep = KEEP_MIGRATION_COPIES) {
  const copies = readdirSync(dir).filter((n) => /^pre-migration-\d{8}T\d{6,9}Z\.db$/.test(n)).sort().reverse();
  for (const name of copies.slice(keep)) rmSync(join(dir, name), { force: true });
}

/**
 * Which migrations opening a database would apply, found by applying them to a throwaway copy (so a migration that would
 * fail on this data fails here, before the real file is touched). The copy lives in the OS temp folder and is deleted.
 * @returns {{ pending: string[] }}  'app:id' entries; empty when the database is current
 */
export function pendingMigrations(path, tempDir) {
  if (!existsSync(path)) return { pending: [] };
  const to = join(tempDir, `hr-pending-${process.pid}-${Date.now()}.db`);
  try {
    const before = appliedIn(path);
    copyDatabase(path, to);
    const store = openHealthStore(to, { snapshot: false });
    const after = appliedIds(store.db);
    store.close();
    return { pending: after.filter((id) => !before.includes(id)) };
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(to + suffix, { force: true });
  }
}

/**
 * The database as the owner (user 1) sees it: every query scoped to the owner (db/scope.js). The command-line scripts
 * act as the owner; the server scopes each request and job to its own user instead.
 */
export function openOwnerStore(path, options) {
  return scopeStore(openHealthStore(path, options), OWNER_ID);
}
