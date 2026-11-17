// Applies pending PostgreSQL migrations as the migration role (v3 Phase 1G, docs/adr/0010). The app connects as hr_app,
// which has no DDL and refuses to start with pending migrations, so deploy/deploy.sh runs this with the new image, after
// the backup container's pre-migrate step has taken a checked pg_dump and migrated a scratch copy without error.
//   MIGRATE_DATABASE_URL=postgres://hr_migrate:...@host/health_review?sslmode=verify-full&sslrootcert=... node scripts/migrate.js
// Prints the ids applied (or none) and never the URL. Exit 0 done, 1 failed (each migration rolls back on its own).
import { checkCollation, migratePostgres } from '../db/pg/migrate.ts';
import { createPostgresPool } from '../db/postgres.ts';

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  console.error('migrate: MIGRATE_DATABASE_URL is not set');
  process.exit(1);
}
const pool = createPostgresPool(url, { max: 1 });
try {
  await checkCollation(pool);
  const applied = await migratePostgres(pool);
  console.log(`migrate: ${applied.length ? `applied ${applied.length} (${applied.join(', ')})` : 'nothing to apply'}`);
} catch (err) {
  console.error(`migrate: failed: ${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
