import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as AsyncDatabase } from './database.ts';
import { openSqliteStore, type SqliteStore } from './migrate.ts';
import { dataPath } from '../tools/paths.ts';
import { createSqliteDatabase, guardSyncDatabase } from './database.ts';
import { MIGRATIONS } from './migrations.ts';
import { scopeStore } from './scope.ts';
import { OWNER_ID, syncOwnerEmail } from './users.ts';

/**
 * An open store on either engine: db and tx are the async interface every caller uses (db/database.ts); raw and syncDb
 * are SQLite's own handles (null on PostgreSQL); applied lists the PostgreSQL migrations an open ran.
 */
export interface Store {
  db: AsyncDatabase;
  tx: AsyncDatabase['tx'];
  raw: Database.Database | null;
  syncDb: Database.Database | null;
  applied?: string[];
  close: () => void | Promise<void>;
}

/** A SQLite store: its raw and guarded sync handles are always there. */
export interface SqliteHealthStore extends Store {
  raw: Database.Database;
  syncDb: Database.Database;
  close: () => void;
}

export const DEFAULT_DB_PATH = dataPath('health.db');
/** How many pre-migration copies are kept in data/backups (newest first). */
export const KEEP_MIGRATION_COPIES = 5;
/**
 * The oldest a pre-migration copy may get, in days (2026-11-13): the copies hold every user's data unencrypted, so a
 * deleted account must age out of them as it does from the encrypted backups. Far past a deploy's rollback window
 * (deploy.sh uses the copy taken minutes before); after it, the nightly encrypted backups are the way back.
 */
export const MAX_COPY_AGE_DAYS = 14;

/** The folder that holds a database's pre-migration copies (HEALTH_DB_PATH, else data/health.db). */
export const migrationCopiesDir = (path: string = process.env.HEALTH_DB_PATH || DEFAULT_DB_PATH): string => join(dirname(path), 'backups');

const appliedIds = (db: Database.Database): string[] => db.prepare("SELECT app || ':' || id FROM schema_migrations ORDER BY app, id").pluck().all() as string[];

/**
 * A consistent single-file copy of a database (VACUUM INTO), checked with PRAGMA integrity_check. Throws when the copy
 * is not sound, after deleting it.
 */
export function copyDatabase(path: string, to: string): string {
  mkdirSync(dirname(to), { recursive: true });
  const src = new Database(path, { readonly: true, fileMustExist: true });
  try {
    src.prepare('VACUUM INTO ?').run(to);
  } finally {
    src.close();
  }
  const copy = new Database(to, { readonly: true });
  let ok: boolean;
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
function appliedIn(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get() ? appliedIds(db) : [];
  } finally {
    db.close();
  }
}

/**
 * Opens the health database (the runs tables plus this app's tables; db/migrate.js), applying any new migrations.
 * Before any migration changes an existing file, a checked copy is taken (owner's rule, 2026-10-24: back up before every
 * database change): data/backups/pre-migration-<UTC stamp>.db next to the database, kept only when something migrated
 * (the newest KEEP_MIGRATION_COPIES stay, none older than MAX_COPY_AGE_DAYS; old ones are pruned on every open), so the
 * database is never changed without a copy to go back to.
 * @param {string} [path]  HEALTH_DB_PATH, else data/health.db; ':memory:' for tests
 * @param {{ snapshot?: boolean, log?: { info: Function } }} [options]  snapshot false: no copy (a throwaway copy itself)
 */
export function openHealthStore(path: string = process.env.HEALTH_DB_PATH || DEFAULT_DB_PATH, { snapshot = true, log = console }: { snapshot?: boolean, log?: { info?: (line: string) => void } } = {}): SqliteHealthStore {
  let copy: string | null = null;
  let before: string[] = [];
  if (snapshot && path !== ':memory:' && existsSync(path)) {
    before = appliedIn(path);
    const stamp = new Date().toISOString().replace(/[-:.]/g, ''); // 20261024T153012123Z: milliseconds keep names apart
    copy = copyDatabase(path, join(migrationCopiesDir(path), `pre-migration-${stamp}.db`));
  }
  const store = openSqliteStore(path, { app: 'health-review', migrations: MIGRATIONS });
  if (copy) {
    const added = appliedIds(store.db).filter((id) => !before.includes(id));
    if (!added.length) {
      rmSync(copy, { force: true });
    } else {
      log.info?.(`[migrate] applied ${added.join(', ')}; the database before them is ${copy}`);
    }
  }
  // Every open of a file prunes, so a restart ages old copies out even when nothing migrates.
  if (snapshot && path !== ':memory:' && existsSync(migrationCopiesDir(path))) pruneMigrationCopies(migrationCopiesDir(path));
  return withAsyncDatabase(store);
}

/**
 * Opens the health database on either engine (v3 Phase 1C): PostgreSQL when url (DATABASE_URL) is set
 * (db/pg/migrate.js), else SQLite (openHealthStore), then brings the owner's email in step with the environment. The
 * server calls it only with DB_ENGINE=postgres (server/index.js), so a stray DATABASE_URL never moves a SQLite server.
 * migrate false (the server, as hr_app): pending PostgreSQL migrations refuse the open instead of running.
 * allUsers (PostgreSQL): every user's rows unscoped, for the whole-database tools (the backup service), never the app.
 * @param {{ url?: string, path?: string, snapshot?: boolean, migrate?: boolean, allUsers?: boolean, log?: { info: Function } }} [options]
 */
export async function openStore({ url = process.env.DATABASE_URL, path, migrate = true, allUsers = false, ...options }: { url?: string, path?: string, snapshot?: boolean, migrate?: boolean, allUsers?: boolean, log?: { info?: (line: string) => void } } = {}): Promise<Store> {
  let store: Store;
  if (url) {
    const { openPostgresStore } = await import('./pg/migrate.ts');
    store = await openPostgresStore(url, { migrate, allUsers });
  } else {
    store = openHealthStore(path, options);
  }
  await syncOwnerEmail(store.db);
  return store;
}

/**
 * The store's handles on its one connection (v3 Phase 1, docs/adr/0006): db and tx, the async interface
 * (db/database.ts) every caller uses; syncDb, the better-sqlite3 handle for the few SQLite-only jobs left on it (the
 * backup and the restore test, until 1G), guarded so a statement throws while another request holds an async
 * transaction; raw, the unguarded handle for the migrations and SQLite's own tables and pragmas.
 */
function withAsyncDatabase(store: SqliteStore): SqliteHealthStore {
  const raw = store.db;
  const db = createSqliteDatabase(raw);
  return { ...store, raw, db, tx: db.tx, syncDb: guardSyncDatabase(raw) };
}

const COPY_NAME = /^pre-migration-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{0,3})Z\.(?:db|dump)$/; // .dump: the backup container's pre-migrate dumps (PostgreSQL, v3 Phase 1G)

/**
 * Keeps the newest `keep` pre-migration copies in a folder, and none older than `maxAgeDays` (by the UTC stamp in the
 * name, so a copied file keeps its age). Other files are never touched. Returns the names removed.
 */
export function pruneMigrationCopies(dir: string, { keep = KEEP_MIGRATION_COPIES, maxAgeDays = MAX_COPY_AGE_DAYS, now = new Date() }: { keep?: number, maxAgeDays?: number, now?: Date } = {}): string[] {
  const copies = readdirSync(dir).filter((n) => COPY_NAME.test(n)).sort().reverse();
  const oldest = now.getTime() - maxAgeDays * 86_400_000;
  const stampOf = (n: string): number => {
    const [, y, mo, d, h, mi, s, ms] = COPY_NAME.exec(n)!; // every name here matched COPY_NAME above
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Number(ms.padEnd(3, '0')));
  };
  const removed = copies.filter((n, i) => i >= keep || stampOf(n) < oldest);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}

/**
 * Which migrations opening a database would apply, found by applying them to a throwaway copy (so a migration that would
 * fail on this data fails here, before the real file is touched). The copy lives in the OS temp folder and is deleted.
 * @returns {{ pending: string[] }}  'app:id' entries; empty when the database is current
 */
export function pendingMigrations(path: string, tempDir: string): { pending: string[] } {
  if (!existsSync(path)) return { pending: [] };
  const to = join(tempDir, `hr-pending-${process.pid}-${Date.now()}.db`);
  try {
    const before = appliedIn(path);
    copyDatabase(path, to);
    const store = openHealthStore(to, { snapshot: false });
    const after = appliedIds(store.raw);
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
export function openOwnerStore(path?: string, options?: { snapshot?: boolean, log?: { info?: (line: string) => void } }) {
  return scopeStore(openHealthStore(path, options), OWNER_ID);
}
