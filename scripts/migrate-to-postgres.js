// Copies the SQLite database into PostgreSQL (v3 Phase 1E, docs/adr/0008), or only audits it for what would not survive:
//   node scripts/migrate-to-postgres.js --audit                  [--from <sqlite file>]   no PostgreSQL needed
//   DATABASE_URL=postgres://... node scripts/migrate-to-postgres.js [--from <sqlite file>]
// The source is never opened in place: a checked copy (VACUUM INTO, integrity checked) goes into a new OS temp folder,
// deleted on every exit path. The target must be a new, empty database; it is migrated first, then filled in one
// transaction, then both sides are fingerprinted and compared. Prints table and column names, counts, and PASS or FAIL
// only: never a value, a user id, an email or the connection string. Exit 0 pass (or a clean audit), 1 fail, 2 audit
// failures.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DB_PATH, copyDatabase, openHealthStore } from '../db/store.js';
import { openPostgresStore } from '../db/pg/migrate.js';
import { audit, reportLines, transfer } from '../db/transfer.js';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const quiet = { info() {} };

/**
 * The whole run, for the script and the tests.
 * @param {{ from: string, url?: string, auditOnly?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<number>} the exit code
 */
export async function migrateToPostgres({ from, url, auditOnly = false, log = console.log }) {
  const tmp = mkdtempSync(join(tmpdir(), 'hr-migrate-'));
  let source = null;
  let target = null;
  try {
    const copy = copyDatabase(from, join(tmp, 'health.db'));
    source = openHealthStore(copy, { snapshot: false, log: quiet });
    const findings = audit(source.raw);
    const failed = findings.some((f) => f.severity === 'fail');
    if (auditOnly || failed) {
      for (const line of reportLines({ findings })) log(line);
      if (failed) log('Fix the audit failures before copying; nothing was copied.');
      return failed ? 2 : 0;
    }
    if (!url) throw new Error('Set DATABASE_URL to the new PostgreSQL database (or pass --audit)');
    target = await openPostgresStore(url);
    const result = await transfer(source, target);
    for (const line of reportLines({ findings, result })) log(line);
    return result.ok ? 0 : 1;
  } finally {
    source?.close();
    await target?.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateToPostgres({
    from: resolve(arg('--from') ?? process.env.HEALTH_DB_PATH ?? DEFAULT_DB_PATH),
    url: process.env.DATABASE_URL,
    auditOnly: process.argv.includes('--audit'),
  }).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`Migration failed: ${err.message}`);
    process.exitCode = 1;
  });
}
