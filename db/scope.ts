// One user's view of the shared database (multi-user, phase 1). scopeDb(db, uid) behaves like the better-sqlite3
// database, but every statement whose SQL names @uid gets that user's id bound for it. So every query on a user table
// writes "user_id = @uid" (and inserts user_id with @uid), functions keep taking `db`, and a statement prepared on the
// raw, unscoped database fails with "Missing named parameters" instead of reading everyone's rows.
// test/user-scope.test.js checks that every query on a user table names user_id.
import type BetterSqlite3 from 'better-sqlite3';
import type { Database, Statement } from './database.ts';

/** The async database as one user sees it: the shared one, plus who it is for and the database underneath. */
export interface ScopedDatabase extends Database {
  readonly uid: string;
  readonly unscoped: Database;
}

/** A sync better-sqlite3 database as one user sees it (scopeDb). */
export type ScopedSyncDatabase = BetterSqlite3.Database & { uid: string, unscoped: BetterSqlite3.Database };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);

/** The statement's arguments with uid bound, when its SQL names @uid. */
function uidBinder(source: string, uid: string): (args: unknown[]) => unknown[] {
  if (!source.includes('@uid')) return (args) => args;
  // Named values travel in one plain object; add uid to it, or pass one holding only uid after the positional values.
  return (args) => {
    const i = args.findIndex(isPlainObject);
    if (i < 0) return [...args, { uid }];
    const copy = [...args];
    copy[i] = { ...(args[i] as Record<string, unknown>), uid };
    return copy;
  };
}

function scopeStatement(stmt: BetterSqlite3.Statement, uid: string) {
  const bind = uidBinder(stmt.source, uid);
  const scoped = {
    run: (...args: unknown[]) => stmt.run(...bind(args)),
    get: (...args: unknown[]) => stmt.get(...bind(args)),
    all: (...args: unknown[]) => stmt.all(...bind(args)),
    iterate: (...args: unknown[]) => stmt.iterate(...bind(args)),
    pluck: (on = true) => { stmt.pluck(on); return scoped; },
    raw: (on = true) => { stmt.raw(on); return scoped; },
    expand: (on = true) => { stmt.expand(on); return scoped; },
    columns: () => stmt.columns(),
    get source() { return stmt.source; },
    get reader() { return stmt.reader; },
  };
  return scoped;
}

/**
 * The database as seen by one user.
 * @param db  the shared database (a scoped one, which carries unscoped, is unwrapped first)
 * @param uid  users.id
 */
export function scopeDb(db: BetterSqlite3.Database & { unscoped?: BetterSqlite3.Database }, uid: string): ScopedSyncDatabase {
  if (!uid) throw new TypeError('scopeDb: uid is required');
  const raw = db.unscoped ?? db;
  return new Proxy(raw, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => scopeStatement(target.prepare(sql), uid);
      if (prop === 'uid') return uid;
      if (prop === 'unscoped') return target;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ScopedSyncDatabase;
}

/**
 * The async database (db/database.ts) as seen by one user: the same @uid binding as scopeDb, so a statement naming @uid
 * on the unscoped database still fails instead of reading everyone's rows.
 * @param database  the shared database (a scoped one is unwrapped)
 * @param uid  users.id
 */
export function scopeDatabase(database: Database & { unscoped?: Database }, uid: string): ScopedDatabase {
  if (!uid) throw new TypeError('scopeDatabase: uid is required');
  const base = database.unscoped ?? database;
  // On PostgreSQL the statements run as this user under row-level security too (v3 Phase 1I), so one that forgets
  // user_id = @uid still sees only this user's rows.
  const inner = base.forUser ? base.forUser(uid) : base;
  const scopeAsync = (stmt: Statement): Statement => {
    const bind = uidBinder(stmt.source, uid);
    const scoped: Statement = {
      get source() { return stmt.source; },
      get: (...args) => stmt.get(...bind(args)),
      all: (...args) => stmt.all(...bind(args)),
      run: (...args) => stmt.run(...bind(args)),
      pluck: (on = true) => { stmt.pluck(on); return scoped; },
    };
    return scoped;
  };
  return {
    engine: base.engine,
    raw: base.raw,
    prepare: (sql) => scopeAsync(inner.prepare(sql)),
    exec: (sql) => inner.exec(sql),
    tx: (fn) => base.tx(fn),
    uid,
    unscoped: base,
  };
}

/**
 * A store whose db (async, db/database.ts) and syncDb (the guarded sync handle, when the store has one) are scoped to
 * one user; tx, raw and close are the shared store's.
 */
export function scopeStore<S extends { db: Database, syncDb?: BetterSqlite3.Database | null }>(store: S, uid: string)
  : S & { db: ScopedDatabase, uid: string } {
  return { ...store, db: scopeDatabase(store.db, uid), ...(store.syncDb && { syncDb: scopeDb(store.syncDb, uid) }), uid };
}
