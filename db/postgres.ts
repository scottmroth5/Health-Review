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
// Row-level security (v3 Phase 1I): every statement first makes its client's session settings its own scope (one user,
// every user, or none), sent only when they differ from what that client last had and forgotten on any rollback, so a
// pooled client never carries one user's settings into another's statement.
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

/**
 * Whose rows a statement may see under row-level security (v3 Phase 1I, docs/adr/0011, migration
 * 035-row-level-security): one user's (their id), every user's (ALL_USERS: the admin screens, backups and the
 * whole-database tools), or none (NO_USER: the unscoped app database, which reads only app-wide tables such as users).
 * It reaches the server as the session settings app.user_id and app.all_users, which the policies read.
 */
type Scope = string;
const NO_USER: Scope = '';
const ALL_USERS: Scope = '*all';

/** The scope each pooled client's settings hold, so the settings are sent only when a statement needs others. */
const lastScope = new WeakMap<pg.PoolClient, Scope>();

async function applyScope(client: pg.PoolClient, scope: Scope): Promise<void> {
  if (lastScope.get(client) === scope) return;
  lastScope.delete(client); // unknown until the call succeeds
  const all = scope === ALL_USERS;
  await client.query("SELECT set_config('app.user_id', $1, false), set_config('app.all_users', $2, false)",
    [all ? '' : scope, all ? 'on' : '']);
  lastScope.set(client, scope);
}

interface TxState {
  client: pg.PoolClient;
  savepoints: number;
}

/**
 * The async interface over a pool. The caller owns the pool (and ends it). Unscoped, it sees no user's rows on a table
 * under row-level security; forUser(uid) (db/scope.js scopeDatabase) gives one user's view and allUsers() everyone's.
 * allUsers true makes everyone's the default: only for whole-database tools (backups, the transfer scripts), never the app.
 */
export function createPostgresDatabase(pool: pg.Pool, { allUsers = false }: { allUsers?: boolean } = {}): Database {
  const context = new AsyncLocalStorage<TxState>();

  /**
   * Runs on the open transaction's client when this context holds one, else on a client of its own. Either way the
   * client's settings are made this statement's scope first, so a pooled client never carries another user's into it.
   */
  const query = async (scope: Scope, text: string, values?: unknown[], rowMode?: 'array') => {
    const config: pg.QueryArrayConfig | pg.QueryConfig = rowMode ? { text, values, rowMode } : { text, values };
    const state = context.getStore();
    if (state) {
      await applyScope(state.client, scope);
      return state.client.query(config);
    }
    const client = await pool.connect();
    let broken = false;
    try {
      await applyScope(client, scope);
      return await client.query(config);
    } catch (err) {
      broken = !lastScope.has(client); // its settings call failed: the session is in an unknown state, so discard it
      throw err;
    } finally {
      client.release(broken);
    }
  };

  const prepareIn = (scope: Scope) => (sql: string): Statement => {
    const { text, bind } = toPositional(sql);
    let pluck = false;
    const statement: Statement = {
      get source() { return sql; },
      get: async (...params) => {
        const res = await query(scope, text, bind(params), pluck ? 'array' : undefined);
        const row = res.rows[0];
        return pluck ? row?.[0] : row;
      },
      all: async (...params) => {
        const res = await query(scope, text, bind(params), pluck ? 'array' : undefined);
        return pluck ? res.rows.map((r) => r[0]) : res.rows;
      },
      run: async (...params) => ({ changes: (await query(scope, text, bind(params))).rowCount ?? 0 }),
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
        lastScope.delete(open.client); // a rollback undoes settings made inside it: set them again before the next statement
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
        lastScope.delete(client);
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

  const views = new Map<Scope, Database>();
  const view = (scope: Scope): Database => {
    let v = views.get(scope);
    if (!v) {
      v = {
        engine: 'postgres',
        raw: null,
        prepare: prepareIn(scope),
        exec: async (sql) => { await query(scope, sql); },
        tx,
        forUser: (uid: string) => {
          if (typeof uid !== 'string' || !uid || uid === ALL_USERS) throw new TypeError('forUser: a user id is required');
          return view(uid);
        },
        allUsers: () => view(ALL_USERS),
      };
      views.set(scope, v);
    }
    return v;
  };
  return view(allUsers ? ALL_USERS : NO_USER);
}
