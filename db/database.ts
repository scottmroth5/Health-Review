// The one async database interface (v3 Phase 1A, docs/adr/0006): the store's db and tx. Every caller awaits each statement:
//   const row = await db.prepare('SELECT ... WHERE user_id = @uid AND id = ?').get(id);
//   await db.tx(async () => { ... });
// createSqliteDatabase wraps today's better-sqlite3 connection; the PostgreSQL adapter (1C) implements the same interface.
// Only get, all, run (changes only: inserts use RETURNING id) and pluck are offered, as nothing else is used.
//
// Transactions on one SQLite connection: an async transaction stays open across awaits, so statements from other
// requests could land inside it. One transaction runs at a time (a promise-chain lock); an AsyncLocalStorage marks the
// context that holds it. Its own statements run inside it, a nested tx is a SAVEPOINT, and statements from any other
// context wait for the lock. Sync statements cannot wait, so the store's sync handle (syncDb, guardSyncDatabase)
// throws TransactionConflictError rather than join another context's transaction. Never hold a transaction across an
// external call (Claude, Google): everything else on the connection waits for it.
import { AsyncLocalStorage } from 'node:async_hooks';
import type BetterSqlite3 from 'better-sqlite3';

export interface RunResult {
  changes: number;
}

export interface Statement {
  readonly source: string;
  get(...params: unknown[]): Promise<any>;
  all(...params: unknown[]): Promise<any[]>;
  run(...params: unknown[]): Promise<RunResult>;
  /** Return the first column only, as better-sqlite3's pluck does. */
  pluck(on?: boolean): Statement;
}

export interface Database {
  readonly engine: 'sqlite' | 'postgres';
  /** The better-sqlite3 handle, for the SQLite-only tools (backup, copies, pragmas) until 1G replaces them; null on PostgreSQL. */
  readonly raw: BetterSqlite3.Database | null;
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  /** Runs fn in a transaction: committed when it resolves, rolled back when it throws. Nested, a savepoint. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
}

/** A sync statement ran while another async context held a transaction on the same connection. */
export class TransactionConflictError extends Error {
  constructor() {
    super('A synchronous statement ran while another request held a database transaction');
    this.name = 'TransactionConflictError';
  }
}

interface Connection {
  /** Settles when the last queued holder of the lock releases it. */
  tail: Promise<void>;
  /** The token of the context holding the open transaction, or null. */
  owner: object | null;
  savepoints: number;
  db: Database | null;
}

const context = new AsyncLocalStorage<object>();
const connections = new WeakMap<BetterSqlite3.Database, Connection>();

function connectionOf(raw: BetterSqlite3.Database): Connection {
  let c = connections.get(raw);
  if (!c) {
    c = { tail: Promise.resolve(), owner: null, savepoints: 0, db: null };
    connections.set(raw, c);
  }
  return c;
}

const ownsTransaction = (c: Connection): boolean => c.owner !== null && context.getStore() === c.owner;

/** Runs fn once every earlier holder has released the lock; the lock is released however fn ends. */
async function withLock<T>(c: Connection, fn: () => Promise<T>): Promise<T> {
  const before = c.tail;
  let release!: () => void;
  c.tail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await before;
    return await fn();
  } finally {
    release();
  }
}

/** A statement outside any transaction runs now; one from outside an open transaction waits until it ends. */
function gate<T>(c: Connection, fn: () => T): Promise<T> {
  if (c.owner === null || ownsTransaction(c)) {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  }
  return withLock(c, async () => fn());
}

function wrapStatement(c: Connection, stmt: BetterSqlite3.Statement): Statement {
  const statement: Statement = {
    get source() { return stmt.source; },
    get: (...params) => gate(c, () => stmt.get(...params)),
    all: (...params) => gate(c, () => stmt.all(...params)),
    run: (...params) => gate(c, () => ({ changes: stmt.run(...params).changes })),
    pluck: (on = true) => { stmt.pluck(on); return statement; },
  };
  return statement;
}

async function transaction<T>(c: Connection, raw: BetterSqlite3.Database, fn: () => Promise<T>): Promise<T> {
  if (ownsTransaction(c)) {
    c.savepoints += 1;
    const name = `sp_${c.savepoints}`;
    raw.exec(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      raw.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      raw.exec(`ROLLBACK TO ${name}`);
      raw.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      c.savepoints -= 1;
    }
  }
  return withLock(c, async () => {
    const token = {};
    raw.exec('BEGIN IMMEDIATE');
    c.owner = token;
    try {
      const result = await context.run(token, fn);
      raw.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        if (raw.inTransaction) raw.exec('ROLLBACK');
      } catch {
        // The original error matters more; the lock is still released below.
      }
      throw err;
    } finally {
      c.owner = null;
      c.savepoints = 0;
    }
  });
}

/** The async interface over a better-sqlite3 connection (one per connection, shared by every caller). */
export function createSqliteDatabase(raw: BetterSqlite3.Database): Database {
  const c = connectionOf(raw);
  c.db ??= {
    engine: 'sqlite',
    raw,
    prepare: (sql) => wrapStatement(c, raw.prepare(sql)),
    exec: (sql) => gate(c, () => { raw.exec(sql); }),
    tx: (fn) => transaction(c, raw, fn),
  };
  return c.db;
}

/** Throws TransactionConflictError when another async context holds a transaction on this connection. */
function assertNoForeignTransaction(c: Connection): void {
  if (c.owner !== null && !ownsTransaction(c)) throw new TransactionConflictError();
}

const RUNS = new Set(['run', 'get', 'all', 'iterate']);
const CHAINS = new Set(['pluck', 'raw', 'expand', 'safeIntegers', 'bind']);

/**
 * The store's syncDb, the sync better-sqlite3 handle for the SQLite-only jobs left on it (backup and the restore test,
 * until 1G) and for tests' seeding: the same connection, but every statement, exec and transaction throws TransactionConflictError while another context holds an async transaction.
 */
export function guardSyncDatabase(raw: BetterSqlite3.Database): BetterSqlite3.Database {
  const c = connectionOf(raw);
  const guardStatement = (stmt: BetterSqlite3.Statement): BetterSqlite3.Statement => {
    const guarded: BetterSqlite3.Statement = new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (typeof prop === 'string' && RUNS.has(prop)) {
          return (...args: unknown[]) => { assertNoForeignTransaction(c); return value.apply(target, args); };
        }
        if (typeof prop === 'string' && CHAINS.has(prop)) {
          return (...args: unknown[]) => { value.apply(target, args); return guarded; };
        }
        return value.bind(target);
      },
    });
    return guarded;
  };
  const guardedDb: BetterSqlite3.Database = new Proxy(raw, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => guardStatement(target.prepare(sql));
      // better-sqlite3's exec returns the database; this returns the guarded one.
      if (prop === 'exec') return (sql: string) => { assertNoForeignTransaction(c); target.exec(sql); return guardedDb; };
      if (prop === 'transaction') {
        return (fn: (...a: unknown[]) => unknown) => {
          const run = target.transaction(fn);
          return (...args: unknown[]) => { assertNoForeignTransaction(c); return run(...args); };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return guardedDb;
}
