// PostgreSQL for tests (v3 Phase 1C): DATABASE_URL names a server where the test user may create databases (CI's
// postgres service, or a local container). Each caller gets its own new database, created with C collation like
// production's, and dropped afterwards. Without DATABASE_URL, pgSkip says why the PostgreSQL tests are skipped.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPostgresPool } from '../db/postgres.ts';

export const pgSkip = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set (PostgreSQL tests run in CI and with a local server)';

/** A new empty database: { pool, url, drop }. */
export async function freshPgDatabase() {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const name = `hr_test_${randomBytes(6).toString('hex')}`;
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  } finally {
    await admin.end();
  }
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPostgresPool(url.toString());
  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const again = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await again.connect();
      try {
        await again.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await again.end();
      }
    },
  };
}
