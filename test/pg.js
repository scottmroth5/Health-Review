// PostgreSQL for tests (v3 Phase 1C): DATABASE_URL names a server where the test user may create databases (CI's
// postgres service, or a local container). Each caller gets its own new database, created with C collation like
// production's, and dropped afterwards. Without DATABASE_URL, pgSkip says why the PostgreSQL tests are skipped.
//
// freshPgStore (the whole suite on PostgreSQL, TEST_DB=postgres; slice 4): a migrated template database is built once per
// schema version (its name carries a hash of the baseline and the runner) and kept on the server, and each store is a
// copy of it, which takes milliseconds where migrating takes about a second.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createPostgresPool } from '../db/postgres.ts';
import { openPostgresStore } from '../db/pg/migrate.js';
import { OWNER_ID, ownerEmailFromEnv } from '../db/users.js';

export const pgSkip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set (PostgreSQL tests run in CI and with a local server)';

const C_LOCALE = "TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'";
/** The advisory lock held while a template is built, so parallel test files build it once. */
const TEMPLATE_LOCK_KEY = 7120260003;

async function withAdmin(fn) {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

function urlFor(name) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabase(name) {
  await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

/**
 * A new empty database: { pool, url, drop }.
 * @param {{ options?: string }} [opts]  CREATE DATABASE options in place of the C locale (a test of the collation check)
 */
export async function freshPgDatabase({ options = C_LOCALE } = {}) {
  const name = `hr_test_${randomBytes(6).toString('hex')}`;
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${name} ${options}`));
  const url = urlFor(name);
  const pool = createPostgresPool(url);
  return {
    pool,
    url,
    async drop() {
      await pool.end();
      await dropDatabase(name);
    },
  };
}

const SCHEMA_HASH = createHash('sha256')
  .update(readFileSync(new URL('../db/pg/001-baseline.sql', import.meta.url)))
  .update(readFileSync(new URL('../db/pg/migrate.js', import.meta.url)))
  .digest('hex').slice(0, 12);
const TEMPLATE = `hr_tpl_${SCHEMA_HASH}`;
let templateReady;

// Many tests never close their store (a SQLite memory store needs no closing). Test pools let the process exit when idle,
// and the stores still open then are closed, which drops their databases.
const TEST_POOL = { max: 4, allowExitOnIdle: true };
const open = new Set();
process.on('beforeExit', () => {
  if (open.size) void Promise.all([...open].map((s) => s.close())); // runs before exit; beforeExit fires again after
});

/** The migrated template for this schema version, built (under a lock, then renamed into place) when missing. */
function template() {
  templateReady ??= withAdmin(async (admin) => {
    await admin.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK_KEY]);
    try {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEMPLATE]);
      if (rowCount) return;
      const building = `hr_build_${randomBytes(6).toString('hex')}`;
      await admin.query(`CREATE DATABASE ${building} ${C_LOCALE}`);
      try {
        const store = await openPostgresStore(urlFor(building));
        await store.close();
        await admin.query(`ALTER DATABASE ${building} RENAME TO ${TEMPLATE}`);
      } catch (err) {
        await admin.query(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
        throw err;
      }
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_LOCK_KEY]);
    }
  });
  return templateReady;
}

/**
 * A migrated PostgreSQL store on its own new database (a copy of the template), unscoped like openHealthStore(':memory:');
 * close() ends its pool and drops the database. The owner row's email follows the environment as a new SQLite database's
 * does (the template was migrated with whatever it had then).
 */
export async function freshPgStore() {
  await template();
  const name = `hr_test_${randomBytes(6).toString('hex')}`;
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`));
  let store;
  try {
    store = await openPostgresStore(urlFor(name), { pool: TEST_POOL });
    await store.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(ownerEmailFromEnv(), OWNER_ID);
  } catch (err) {
    await store?.close();
    await dropDatabase(name);
    throw err;
  }
  let closing;
  const fresh = {
    ...store,
    close() {
      closing ??= (async () => {
        open.delete(fresh);
        await store.close();
        await dropDatabase(name);
      })();
      return closing;
    },
  };
  open.add(fresh);
  return fresh;
}
