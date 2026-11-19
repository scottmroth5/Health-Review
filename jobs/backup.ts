// The encrypted backup as a job: npm run backup (scripts/backup.js) and the in-app scheduler (SCHEDULE_BACKUP) run this.
// data/health.db and the MAPS catalog, encrypted with HEALTH_BACKUP_PASSPHRASE, to Google Drive (or a folder), recorded
// as a 'backup' run with the file name, size and counts only (tools/backup). On PostgreSQL (pgUrl, the backup
// container's BACKUP_DATABASE_URL; v3 Phase 1G) a checked pg_dump replaces the SQLite snapshot.
import { existsSync } from 'node:fs';
import { migrationCopiesDir, pruneMigrationCopies } from '../db/store.ts';
import { checkPassphrase } from '../tools/backup/crypto.ts';
import { createDriveClient } from '../tools/backup/drive.ts';
import { runBackup } from '../tools/backup/run.ts';
import { getGoogleAuth } from '../tools/google/auth.ts';
import { dataPath } from '../tools/paths.ts';
import { localDate } from '../tools/time.ts';
import { startUserRun } from '../db/users.ts';
import type { DriveClient } from '../tools/backup/drive.ts';
import type { UserStore } from '../ingest/types.ts';

const quiet = { info() {}, warn() {}, error() {}, log() {} };

/**
 * toDir: write the encrypted file to this folder instead of uploading. drive: a Drive client (tests pass a fake); default:
 * Google Drive with the saved sign-in. copiesDir: the pre-migration copies to age out after a backup (default: the
 * database's; null: none). pgUrl: back up this PostgreSQL database (the backup role's URL) instead of the store's SQLite file.
 */
export async function backupJob({ store, passphrase = process.env.HEALTH_BACKUP_PASSPHRASE, toDir, drive, date = localDate(), copiesDir = migrationCopiesDir(), pgUrl }: {
  store: UserStore, passphrase?: string, toDir?: string, drive?: DriveClient, date?: string, copiesDir?: string | null, pgUrl?: string,
}) {
  checkPassphrase(passphrase);
  const run = await startUserRun(store, 'backup', { to: toDir ? 'folder' : 'google-drive' }, quiet);
  try {
    const r = await runBackup({
      // SQLite: the guarded sync handle (better-sqlite3's backup API), which throws rather than copy another request's
      // open transaction. PostgreSQL: pg_dump's own consistent snapshot.
      ...(pgUrl ? { pgUrl } : { db: store.syncDb as NonNullable<UserStore['syncDb']> }), // SQLite stores always have it
      passphrase,
      extras: [{ name: 'programs.json', path: dataPath('maps', 'programs.json') }],
      drive: (toDir ? null : drive ?? createDriveClient(getGoogleAuth())) as DriveClient | undefined, // null with toDir, as before
      toDir,
      date,
    });
    // With a fresh encrypted backup made, pre-migration copies past their age go too, even on a server that has not
    // restarted for weeks (db/store.js MAX_COPY_AGE_DAYS).
    const prunedCopies = copiesDir && existsSync(copiesDir) ? pruneMigrationCopies(copiesDir).length : 0;
    await run.finish('ok', { file: r.name, bytes: r.bytes, contents: r.files, ...(toDir ? { savedTo: r.savedTo } : { kept: r.kept, deleted: r.deleted }), prunedCopies });
    return r;
  } catch (err: any) {
    await run.finish('error', { error: err.message });
    throw err;
  }
}
