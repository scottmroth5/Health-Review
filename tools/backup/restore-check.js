// The monthly backup restore test: proves the newest backup can be decrypted and read. The backup is decrypted into a new
// folder in the OS temp folder (never next to data/health.db), checked with SQLite's integrity check (restoreBackup), and
// its tables compared with the live database by row count; the folder is deleted on every exit path. Counts and table
// names only; no row is read.
// It fails when the backup cannot be decrypted or read, fails the integrity check, is missing a table the live database
// has (unless the backup predates a migration that added it, by schema_migrations),
// or has a table empty that holds 10 or more rows live (a backup missing its data). A backup is from the night before
// and rows are also deleted on purpose (a re-sent workout replaces its heart rate, an edited Workout Log tab replaces its
// sets), so other count differences are recorded, not failures.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { restoreBackup } from './run.js';

export const EMPTY_TABLE_MIN_ROWS = 10;

const tableCounts = (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .pluck().all().map((t) => [t, db.prepare(`SELECT COUNT(*) FROM "${t.replace(/"/g, '""')}"`).pluck().get()]));

/**
 * @param {object} o
 * @param {Buffer} o.file  the encrypted backup
 * @param {string} o.passphrase
 * @param {import('better-sqlite3').Database} o.live  the live database (only counted)
 * @returns {{ ok: boolean, problems: string[], tables: number, rowsBackup: number, rowsLive: number, differences: Array<{table, backup, live}> }}
 *   throws when the backup cannot be decrypted, is not a database, or fails the integrity check
 */
export function restoreTest({ file, passphrase, live }) {
  const dir = mkdtempSync(join(tmpdir(), 'hr-restore-test-'));
  try {
    const { database } = restoreBackup({ file, passphrase, outPath: join(dir, 'restored.db') });
    const restored = new Database(database, { readonly: true });
    const lastMigration = (db) => {
      try { return db.prepare('SELECT MAX(id) FROM schema_migrations').pluck().get() ?? null; } catch { return null; }
    };
    let backupCounts;
    let backupSchema;
    try {
      backupCounts = tableCounts(restored);
      backupSchema = lastMigration(restored);
    } finally {
      restored.close();
    }
    const liveCounts = tableCounts(live);
    // A backup taken before a migration lacks that migration's new tables; that is expected, not a fault.
    const olderSchema = backupSchema !== null && backupSchema < lastMigration(live);
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
