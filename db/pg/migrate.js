// The PostgreSQL store and its migrations (v3 Phase 1C slice 2, docs/adr/0007). Production stays on SQLite until 1H;
// for now only the tests open a PostgreSQL store.
//
// Migrations: 000-baseline (001-baseline.sql) is the whole SQLite schema after BASELINE_THROUGH. Every later SQLite
// migration in db/migrations.js gets a twin here under the same id, written for PostgreSQL, and
// test/schema-parity.test.js fails until it has one and the two schemas match. Applied ids go in schema_migrations under
// the app name, as on SQLite.
//
// Back up before every database change (owner's rule): nothing here backs up yet, since only throwaway test databases
// are opened. 1G adds the pre-migration snapshot before production opens one.
import { readFileSync } from 'node:fs';
import { createPostgresDatabase, createPostgresPool } from '../postgres.ts';
import { OWNER_ID, ownerEmailFromEnv } from '../users.js';

/** The app's migration namespace, the same as SQLite's (db/store.js). */
export const APP = 'health-review';
/** The last SQLite migration the baseline covers; later ones need a twin below with the same id. */
export const BASELINE_THROUGH = '033-usage-totals-browser';
/** The session-level advisory lock the migration runner holds, so two processes never migrate at once. */
export const MIGRATE_LOCK_KEY = 7120260002;

const BASELINE_SQL = readFileSync(new URL('./001-baseline.sql', import.meta.url), 'utf8');

export const PG_MIGRATIONS = [
  {
    id: '000-baseline',
    // The schema, then the rows SQLite's migrations leave in a new database: the owner as user 1 and admin (024).
    up: async (client) => {
      await client.query(BASELINE_SQL);
      const now = new Date().toISOString();
      await client.query("INSERT INTO users (id, email, role, status, created_at, approved_at) VALUES ($1, $2, 'admin', 'approved', $3, $3)",
        [OWNER_ID, ownerEmailFromEnv(), now]);
    },
  },
];

const CREATE_DATABASE = "CREATE DATABASE <name> TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'";

/**
 * Refuses a database whose text sorting or case folding differs from SQLite's: SQLite compares text byte by byte and
 * folds ASCII case only (LOWER, NOCASE), which on PostgreSQL is the C collation and ctype. Checked by behavior, so any
 * locale provider that sorts or folds otherwise is refused.
 */
export async function checkCollation(pool) {
  const { rows: [r] } = await pool.query(
    "SELECT ('a' < 'B') AS a_first, lower('É') = 'É' AS ascii_fold, " +
    'datcollate, datctype FROM pg_database WHERE datname = current_database()');
  if (r.a_first || !r.ascii_fold) {
    throw new Error(`This database sorts or folds text unlike SQLite (collate ${r.datcollate}, ctype ${r.datctype}); ` +
      `create it with ${CREATE_DATABASE}`);
  }
}

/**
 * Applies the migrations not yet recorded, in order, each in its own transaction, while holding MIGRATE_LOCK_KEY.
 * @param {import('pg').Pool} pool
 * @param {Array<{ id: string, up: string | ((client: import('pg').PoolClient) => Promise<void>) }>} migrations
 * @returns {Promise<string[]>} the ids applied now
 */
export async function migratePostgres(pool, migrations = PG_MIGRATIONS) {
  const seen = new Set();
  for (const m of migrations) {
    if (!m?.id || !m.up) throw new TypeError('openPostgresStore: every migration needs an id and an up');
    if (seen.has(m.id)) throw new TypeError(`openPostgresStore: duplicate migration id "${m.id}"`);
    seen.add(m.id);
  }
  const client = await pool.connect();
  const added = [];
  let failed = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        app text NOT NULL, id text NOT NULL, applied_at text NOT NULL, PRIMARY KEY (app, id))`);
      const { rows } = await client.query('SELECT id FROM schema_migrations WHERE app = $1', [APP]);
      const applied = new Set(rows.map((r) => r.id));
      for (const m of migrations) {
        if (applied.has(m.id)) continue;
        await client.query('BEGIN');
        try {
          if (typeof m.up === 'function') await m.up(client);
          else await client.query(m.up);
          await client.query('INSERT INTO schema_migrations (app, id, applied_at) VALUES ($1, $2, $3)',
            [APP, m.id, new Date().toISOString()]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${APP}:${m.id} failed and was rolled back: ${err.message}`, { cause: err });
        }
        added.push(m.id);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]);
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // After a failure the connection is closed rather than reused; closing it also frees the session's lock.
    client.release(failed);
  }
  return added;
}

/**
 * Opens a PostgreSQL database as a store: checks its collation, applies any new migrations, and returns the same async
 * interface as openHealthStore ({ db, tx }). syncDb and raw are null: the SQLite-only jobs (backup, restore test, demo
 * refresh) refuse it until 1G.
 * @param {string} connectionString  postgres://... (never logged)
 * @param {{ migrations?: typeof PG_MIGRATIONS, pool?: import('pg').PoolConfig }} [options]  pool: extra pool settings (the tests')
 */
export async function openPostgresStore(connectionString, { migrations = PG_MIGRATIONS, pool: poolOptions = {} } = {}) {
  const pool = createPostgresPool(connectionString, poolOptions);
  let applied;
  try {
    await checkCollation(pool);
    applied = await migratePostgres(pool, migrations);
  } catch (err) {
    await pool.end();
    throw err;
  }
  const db = createPostgresDatabase(pool);
  return { db, tx: db.tx, raw: null, syncDb: null, applied, close: () => pool.end() };
}
