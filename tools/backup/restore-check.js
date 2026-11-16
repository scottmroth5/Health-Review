// The monthly backup restore test: proves the newest backup can be decrypted and read. A SQLite backup (health.db) is
// decrypted into a new folder in the OS temp folder and checked with SQLite's integrity check (restoreBackup); a
// PostgreSQL backup (health.dump, v3 Phase 1G) is restored into a throwaway local cluster (tools/backup/pg.js), never into
// the production database. Its tables are then compared with the live database by row count, and the folder or cluster
// is deleted on every exit path. Counts and table names only; no row is read.
// It fails when the backup cannot be decrypted or read, fails the integrity check or the restore, is missing a table the
// live database has (unless the backup predates a migration that added it, by schema_migrations), or has a table empty
// that holds 10 or more rows live (a backup missing its data). A backup is from the night before and rows are also
// deleted on purpose (a re-sent workout replaces its heart rate, an edited Workout Log tab replaces its sets), so other
// count differences are recorded, not failures.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSqliteDatabase } from '../../db/database.ts';
import { createPostgresDatabase, createPostgresPool } from '../../db/postgres.ts';
import { listTables } from '../../db/dialect.js';
import { schemaVersion } from '../../db/transfer.js';
import { decrypt, unpack } from './crypto.js';
import { restoreBackup } from './run.js';

export const EMPTY_TABLE_MIN_ROWS = 10;

/** Row counts per table on either engine (the async interface). */
export async function tableCounts(db) {
  const counts = {};
  for (const t of await listTables(db)) counts[t] = Number(await db.prepare(`SELECT COUNT(*) FROM "${t.replace(/"/g, '""')}"`).pluck().get());
  return counts;
}

const lastMigration = async (db) => {
  try { return await schemaVersion(db); } catch { return null; }
};

/** Counts and schema version of a restored database, then closes it. */
async function readRestored(open) {
  const { db, close } = await open();
  try {
    return { counts: await tableCounts(db), schema: await lastMigration(db) };
  } finally {
    await close();
  }
}

/**
 * @param {object} o
 * @param {Buffer} o.file  the encrypted backup
 * @param {string} o.passphrase
 * @param {import('../../db/database.ts').Database} o.live  the live database's async interface (only counted)
 * @returns {Promise<{ ok: boolean, problems: string[], tables: number, rowsBackup: number, rowsLive: number, differences: Array<{table, backup, live}> }>}
 *   rejects when the backup cannot be decrypted, holds no database, fails the integrity check or the restore
 */
export async function restoreTest({ file, passphrase, live }) {
  const dir = mkdtempSync(join(tmpdir(), 'hr-restore-test-'));
  try {
    const files = unpack(decrypt(file, passphrase));
    let restored;
    if (files.some((f) => f.name === 'health.dump')) {
      const dumpPath = join(dir, 'health.dump');
      writeFileSync(dumpPath, files.find((f) => f.name === 'health.dump').data, { flag: 'wx', mode: 0o600 });
      const { withScratchCluster, restoreInto } = await import('./pg.js');
      restored = await withScratchCluster(async (url) => {
        await restoreInto(url, dumpPath);
        return readRestored(async () => {
          const pool = createPostgresPool(url, { max: 1 });
          return { db: createPostgresDatabase(pool), close: () => pool.end() };
        });
      });
    } else {
      const { database } = restoreBackup({ file, passphrase, outPath: join(dir, 'restored.db') });
      restored = await readRestored(async () => {
        const raw = new Database(database, { readonly: true });
        return { db: createSqliteDatabase(raw), close: () => raw.close() };
      });
    }
    const { counts: backupCounts, schema: backupSchema } = restored;
    const liveCounts = await tableCounts(live);
    // A backup taken before a migration lacks that migration's new tables; that is expected, not a fault.
    const liveSchema = await lastMigration(live);
    const olderSchema = backupSchema !== null && liveSchema !== null && backupSchema < liveSchema;
    const problems = [];
    const differences = [];
    for (const [table, n] of Object.entries(liveCounts)) {
      if (!(table in backupCounts)) {
        if (olderSchema) differences.push({ table, backup: null, live: n });
        else problems.push(`table ${table} is missing from the backup`);
        continue;
      }
      const b = backupCounts[table];
      if (b === 0 && n >= EMPTY_TABLE_MIN_ROWS) problems.push(`table ${table} is empty in the backup but has ${n} rows`);
      if (b !== n) differences.push({ table, backup: b, live: n });
    }
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    return { ok: problems.length === 0, problems, tables: Object.keys(backupCounts).length, rowsBackup: sum(backupCounts), rowsLive: sum(liveCounts), differences };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The newest backup in the Drive folder ({ id, name }), or null. */
export async function newestBackup(drive, folderName) {
  const folder = await drive.ensureFolder(folderName);
  return (await drive.list(folder)).filter((f) => /^health-\d{4}-\d{2}-\d{2}\.hrbk$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name))[0] ?? null;
}
