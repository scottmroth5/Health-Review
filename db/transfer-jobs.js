// The two whole-database copies (v3 Phase 1E, docs/adr/0008), as functions for the scripts that run them by hand
// (scripts/export-to-sqlite.js, scripts/migrate-to-postgres.js) and the backup container's rollback export and load
// (tools/backup/pg-deploy.js). Here, under db, so the platform code never imports a script (docs/adr/0012).
// Both print table and column names, counts, and PASS or FAIL only: never a value, a user id, an email or the
// connection string. Both read every user's rows (all-users mode under row-level security, docs/adr/0011).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyDatabase, openHealthStore } from './store.js';
import { openPostgresStore } from './pg/migrate.js';
import { audit, reportLines, transfer } from './transfer.js';

const quiet = { info() {} };
const removeFile = (path) => { for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true }); };

/**
 * PostgreSQL back into a NEW SQLite file: the rollback path. The file is made with the SQLite migrations, filled in one
 * transaction, then both sides are fingerprinted and compared; if they do not match, the new file is deleted, so a
 * half-made rollback file never exists. An existing file is never touched.
 * @param {{ url: string, out: string, log?: (line: string) => void, migrate?: boolean }} o  migrate false: opens without
 *   migrating (a role with no DDL rights, such as the backup role; refuses a database with pending migrations)
 * @returns {Promise<number>} the exit code: 0 pass, 1 fail
 */
export async function exportToSqlite({ url, out, log = console.log, migrate = true }) {
  if (!url) throw new Error('Set DATABASE_URL to the PostgreSQL database to export');
  if (!out) throw new Error('Give --out <new SQLite file>');
  if (existsSync(out)) throw new Error('The --out file already exists; give a new file name');
  let source = null;
  let target = null;
  let ok = false;
  let created = false; // only a file this run made is ever removed
  try {
    source = await openPostgresStore(url, { migrate, allUsers: true }); // every user's rows (row-level security, v3 Phase 1I)
    created = true;
    target = openHealthStore(out, { snapshot: false, log: quiet });
    const result = await transfer(source, target);
    for (const line of reportLines({ result })) log(line);
    ok = result.ok;
    return ok ? 0 : 1;
  } finally {
    target?.close();
    await source?.close();
    if (created && !ok) removeFile(out);
  }
}

/**
 * SQLite into PostgreSQL, or only an audit of what would not survive. The source is never opened in place: a checked
 * copy (VACUUM INTO, integrity checked) goes into a new OS temp folder, deleted on every exit path. The target must be a
 * new, empty database; it is migrated first, then filled in one transaction, then both sides are fingerprinted and
 * compared.
 * @param {{ from: string, url?: string, auditOnly?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<number>} the exit code: 0 pass (or a clean audit), 1 fail, 2 audit failures
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
    target = await openPostgresStore(url, { allUsers: true }); // every user's rows (row-level security, v3 Phase 1I)
    const result = await transfer(source, target);
    for (const line of reportLines({ findings, result })) log(line);
    return result.ok ? 0 : 1;
  } finally {
    source?.close();
    await target?.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
