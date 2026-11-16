// The PostgreSQL adapter (v3 Phase 1C, docs/adr/0007): the same async Database interface as the SQLite one
// (db/database.ts), over a node-postgres pool. The app's SQL is written once with better-sqlite3's placeholders;
// db/placeholders.ts rewrites them to $n at prepare.
//
// Transactions: tx(fn) checks out one client, and an AsyncLocalStorage routes every statement fn awaits to that client; a
// nested tx is a savepoint. Each transaction first takes one database-wide advisory lock (held until it ends), so write
// transactions run one at a time, as SQLite's BEGIN IMMEDIATE makes them: the read-then-write sequences audited in 1B
// keep their guarantee. Statements outside a transaction run in parallel on the pool. Never hold a transaction across an
// external call (Claude, Google).
//
// Numbers: count and sum (int8) and avg (numeric) come back as JS numbers, as better-sqlite3 gives them; an int8 past
// 2^53 throws rather than round. Set on this pool only (createPostgresPool), never on pg's global parsers.
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { Database, Statement } from './database.ts';
import { toPositional } from './placeholders.ts';

const INT8 = 20;
const NUMERIC = 1700;
/** The advisory lock every transaction takes first; any constant works, as long as nothing else uses it. */
export const TX_LOCK_KEY = 7120260001;

function parseInt8(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new RangeError('A bigint result is too large for a JavaScript number');
  return n;
}

const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8) return parseInt8;
    if (oid === NUMERIC) return (text: string) => Number(text);
    return pg.types.getTypeParser(oid, format);
  },
};

/**
 * A pool for one database URL: every session in UTC, numbers parsed as above.
 * @param connectionString  postgres://... (never logged)
 */
export function createPostgresPool(connectionString: string, extra: pg.PoolConfig = {}): pg.Pool {
  checkTls(connectionString);
  return new pg.Pool({ connectionString, max: 10, ...extra, types, options: '-c TimeZone=UTC' });
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * In production a database on another machine must be reached over verified TLS (v3 Phase 1G): the URL carries
 * sslmode=verify-full with an sslrootcert (the image's RDS bundle, /app/certs/rds-global-bundle.pem), so a wrong
 * certificate or a downgrade fails rather than sending health data in the clear. Loopback and Unix sockets (a host
 * starting with /, as the backup container's scratch cluster uses) are exempt. Throws without echoing the URL.
 */
export function checkTls(connectionString: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('The database URL is not a valid postgres:// URL');
  }
  const host = decodeURIComponent(url.hostname);
  if (!host || host.startsWith('/') || LOOPBACK.has(host) || url.searchParams.get('host')?.startsWith('/')) return;
  if (url.searchParams.get('sslmode') !== 'verify-full' || !url.searchParams.get('sslrootcert')) {
    throw new Error('A remote database URL needs sslmode=verify-full and sslrootcert in production');
  }
}

interface TxState {
  client: pg.PoolClient;
  savepoints: number;
}

/** The async interface over a pool. The caller owns the pool (and ends it). */
export function createPostgresDatabase(pool: pg.Pool): Database {
  const context = new AsyncLocalStorage<TxState>();

  /** Runs on the open transaction's client when this context holds one, else on the pool. */
  const query = (text: string, values?: unknown[], rowMode?: 'array') => {
    const state = context.getStore();
    const config: pg.QueryArrayConfig | pg.QueryConfig = rowMode ? { text, values, rowMode } : { text, values };
    return state ? state.client.query(config) : pool.query(config);
  };

  const prepare = (sql: string): Statement => {
    const { text, bind } = toPositional(sql);
    let pluck = false;
    const statement: Statement = {
      get source() { return sql; },
      get: async (...params) => {
        const res = await query(text, bind(params), pluck ? 'array' : undefined);
        const row = res.rows[0];
        return pluck ? row?.[0] : row;
      },
      all: async (...params) => {
        const res = await query(text, bind(params), pluck ? 'array' : undefined);
        return pluck ? res.rows.map((r) => r[0]) : res.rows;
      },
      run: async (...params) => ({ changes: (await query(text, bind(params))).rowCount ?? 0 }),
      pluck: (on = true) => { pluck = on; return statement; },
    };
    return statement;
  };

  async function tx<T>(fn: () => Promise<T>): Promise<T> {
    const open = context.getStore();
    if (open) {
      open.savepoints += 1;
      const name = `sp_${open.savepoints}`;
      await open.client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        await open.client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        await open.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await open.client.query(`RELEASE SAVEPOINT ${name}`);
        throw err;
      } finally {
        open.savepoints -= 1;
      }
    }
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [TX_LOCK_KEY]);
        const result = await context.run({ client, savepoints: 0 }, fn);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // the original error matters more; the client is discarded below
        }
        throw err;
      }
    } finally {
      client.release(broken);
    }
  }

  return {
    engine: 'postgres',
    raw: null,
    prepare,
    exec: async (sql) => { await query(sql); },
    tx,
  };
}
