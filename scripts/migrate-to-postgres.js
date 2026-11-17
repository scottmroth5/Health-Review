// Copies the SQLite database into PostgreSQL (v3 Phase 1E, docs/adr/0008), or only audits it for what would not survive:
//   node scripts/migrate-to-postgres.js --audit                  [--from <sqlite file>]   no PostgreSQL needed
//   DATABASE_URL=postgres://... node scripts/migrate-to-postgres.js [--from <sqlite file>]
// The work is db/transfer-jobs.js migrateToPostgres: a checked temp copy of the source, a new empty target migrated
// first, filled in one transaction, fingerprinted and compared. Prints table and column names, counts, and PASS or FAIL
// only: never a value, a user id, an email or the connection string. Exit 0 pass (or a clean audit), 1 fail, 2 audit
// failures.
import { resolve } from 'node:path';
import { DEFAULT_DB_PATH } from '../db/store.ts';
import { migrateToPostgres } from '../db/transfer-jobs.ts';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };

migrateToPostgres({
  from: resolve(arg('--from') ?? process.env.HEALTH_DB_PATH ?? DEFAULT_DB_PATH),
  url: process.env.DATABASE_URL,
  auditOnly: process.argv.includes('--audit'),
}).then((code) => { process.exitCode = code; }, (err) => {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
});
