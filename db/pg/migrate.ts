// The PostgreSQL store and its migrations (v3 Phase 1C slice 2, docs/adr/0007). Production stays on SQLite until 1H;
// for now only the tests open a PostgreSQL store.
//
// Migrations: 000-baseline (001-baseline.sql) is the whole SQLite schema after BASELINE_THROUGH. Every later SQLite
// migration in db/migrations.js gets a twin here under the same id, written for PostgreSQL, and
// test/schema-parity.test.js fails until it has one and the two schemas match. Applied ids go in schema_migrations under
// the app name, as on SQLite.
//
// Back up before every database change (owner's rule): production never migrates on open. The app opens with
// migrate: false (hr_app has no DDL) and refuses pending migrations; deploy.sh first runs the backup container's
// pre-migrate (a pg_dump restored into a scratch cluster and migrated there), then scripts/migrate.js as hr_migrate
// (v3 Phase 1G, docs/adr/0010). Tests and the transfer scripts still migrate on open.
import { readFileSync } from 'node:fs';
import { createPostgresDatabase, createPostgresPool } from '../postgres.ts';
import { OWNER_ID, ownerEmailFromEnv } from '../users.ts';
import type pg from 'pg';
import type { Store } from '../store.ts';

/** One PostgreSQL migration: SQL text, or a function given the migration's client (inside its transaction). */
export interface PgMigration {
  id: string;
  up: string | ((client: pg.PoolClient) => Promise<void>);
}

/** The app's migration namespace, the same as SQLite's (db/store.js). */
export const APP = 'health-review';
/** The last SQLite migration the baseline covers; later ones need a twin below with the same id. */
export const BASELINE_THROUGH = '033-usage-totals-browser';
/** The session-level advisory lock the migration runner holds, so two processes never migrate at once. */
export const MIGRATE_LOCK_KEY = 7120260002;

const BASELINE_SQL = readFileSync(new URL('./001-baseline.sql', import.meta.url), 'utf8');

/**
 * The row-level security policy for a table with a user_id column (v3 Phase 1I): its user's rows, or every row in
 * all-users mode. A missing setting reads as NULL and an empty one as '', so neither matches a row. With no WITH CHECK,
 * the same test applies to the rows an insert or update writes.
 */
export const userRowsPolicy = (table: string): string => `
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY user_rows ON ${table}
        USING (user_id = current_setting('app.user_id', true) OR current_setting('app.all_users', true) = 'on');`;

const RLS_TABLES_035 = ['daily_metrics', 'workout_sessions', 'workout_hr_samples', 'stand_hour_samples', 'strength_exercises',
  'strength_sets', 'workout_log_notes', 'sync_state', 'drive_exports', 'ingest_log', 'checkins', 'drinking_days', 'settings',
  'health_targets', 'reviews', 'prompt_sections', 'prompt_section_versions', 'advisor_notes', 'program_blocks',
  'log_sessions', 'medications', 'medication_periods', 'medication_doses', 'lab_tests', 'lab_results', 'user_programs',
  'feedback', 'review_versions', 'runs'];

export const PG_MIGRATIONS: PgMigration[] = [
  {
    id: '000-baseline',
    // The schema, then the rows SQLite's migrations leave in a new database: the owner as user 1 and admin (024).
    up: async (client: pg.PoolClient) => {
      await client.query(BASELINE_SQL);
      const now = new Date().toISOString();
      await client.query("INSERT INTO users (id, email, role, status, created_at, approved_at) VALUES ($1, $2, 'admin', 'approved', $3, $3)",
        [OWNER_ID, ownerEmailFromEnv(), now]);
    },
  },
  {
    // SQLite's 034: earlier versions of a week's review.
    id: '034-review-versions',
    up: `
      CREATE TABLE review_versions (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id),
        week_ending text NOT NULL,
        report_md text NOT NULL,
        run_id bigint,
        created_at text NOT NULL,
        model text,
        warnings text,
        sensitive_sections text,
        archived_at text NOT NULL
      );
      CREATE INDEX review_versions_week ON review_versions(user_id, week_ending);
    `,
  },
  {
    // Row-level security (v3 Phase 1I, docs/adr/0011): every user table and runs answer only the rows of the user the
    // session names (app.user_id, set per statement by db/postgres.ts), or every row in all-users mode (app.all_users
    // 'on': the admin screens, backups, whole-database tools). Neither set (the unscoped app database), no rows.
    // run_calls follows its run. No role is named, so dumps restore anywhere. ENABLE, not FORCE: the owner (hr_migrate)
    // still sees every row, as its data migrations need; hr_app and hr_backup are held to the policies.
    // The tables are listed here, not taken from USER_TABLES, so this migration never changes: a later user table
    // enables RLS and adds the same policy in its own migration (test/rls.test.js checks every table with user_id).
    id: '035-row-level-security',
    up: [...RLS_TABLES_035.map(userRowsPolicy), `
      ALTER TABLE run_calls ENABLE ROW LEVEL SECURITY;
      CREATE POLICY user_rows ON run_calls USING (EXISTS (SELECT 1 FROM runs r WHERE r.id = run_calls.run_id));
    `].join('\n'),
  },
];

const CREATE_DATABASE = "CREATE DATABASE <name> TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'";

/**
 * Refuses a database whose text sorting or case folding differs from SQLite's: SQLite compares text byte by byte and
 * folds ASCII case only (LOWER, NOCASE), which on PostgreSQL is the C collation and ctype. Checked by behavior, so any
 * locale provider that sorts or folds otherwise is refused.
 */
export async function checkCollation(pool: pg.Pool): Promise<void> {
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
export async function migratePostgres(pool: pg.Pool, migrations: PgMigration[] = PG_MIGRATIONS): Promise<string[]> {
  const seen = new Set();
  for (const m of migrations) {
    if (!m?.id || !m.up) throw new TypeError('openPostgresStore: every migration needs an id and an up');
    if (seen.has(m.id)) throw new TypeError(`openPostgresStore: duplicate migration id "${m.id}"`);
    seen.add(m.id);
  }
  const client = await pool.connect();
  const added: string[] = [];
  let failed = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        app text NOT NULL, id text NOT NULL, applied_at text NOT NULL, PRIMARY KEY (app, id))`);
      const { rows } = await client.query('SELECT id FROM schema_migrations WHERE app = $1', [APP]);
      const applied = new Set(rows.map((r: { id: string }) => r.id));
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
          throw new Error(`migration ${APP}:${m.id} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
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
 * The migration ids not yet recorded, in order; every one when schema_migrations does not exist yet.
 * @param {import('pg').Pool} pool
 * @returns {Promise<string[]>}
 */
export async function pendingPostgres(pool: pg.Pool, migrations: PgMigration[] = PG_MIGRATIONS): Promise<string[]> {
  const { rows: [t] } = await pool.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  if (!t.present) return migrations.map((m) => m.id);
  const { rows } = await pool.query('SELECT id FROM schema_migrations WHERE app = $1', [APP]);
  const applied = new Set(rows.map((r: { id: string }) => r.id));
  return migrations.filter((m) => !applied.has(m.id)).map((m) => m.id);
}

/**
 * Opens a PostgreSQL database as a store: checks its collation, applies any new migrations, and returns the same async
 * interface as openHealthStore ({ db, tx }). syncDb and raw are null: backup and the restore test run in the backup
 * container (tools/backup/pg.ts), and the demo stays on SQLite.
 * With migrate false (production's app, as hr_app) nothing is applied: pending migrations refuse the open, naming the ids.
 * @param {string} connectionString  postgres://... (never logged)
 * @param {{ migrations?: typeof PG_MIGRATIONS, pool?: import('pg').PoolConfig, migrate?: boolean, allUsers?: boolean }} [options]
 *   pool: extra pool settings (the tests'); allUsers: every user's rows unscoped (row-level security, v3 Phase 1I),
 *   for the whole-database tools only (the backup service, the transfer scripts), never the app
 */
export async function openPostgresStore(connectionString: string, { migrations = PG_MIGRATIONS, pool: poolOptions = {}, migrate = true, allUsers = false }: { migrations?: PgMigration[], pool?: pg.PoolConfig, migrate?: boolean, allUsers?: boolean } = {}): Promise<Store> {
  const pool = createPostgresPool(connectionString, poolOptions);
  let applied: string[] = [];
  try {
    await checkCollation(pool);
    if (migrate) applied = await migratePostgres(pool, migrations);
    else {
      const pending = await pendingPostgres(pool, migrations);
      if (pending.length) throw new Error(`The database has ${pending.length} pending migration(s) (${pending.join(', ')}); run scripts/migrate.js first`);
    }
  } catch (err) {
    await pool.end();
    throw err;
  }
  const db = createPostgresDatabase(pool, { allUsers });
  return { db, tx: db.tx, raw: null, syncDb: null, applied, close: () => pool.end() };
}
