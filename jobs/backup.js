// The encrypted backup as a job: npm run backup (scripts/backup.js) and the in-app scheduler (SCHEDULE_BACKUP) run this.
// data/health.db and the MAPS catalog, encrypted with HEALTH_BACKUP_PASSPHRASE, to Google Drive (or a folder), recorded
// as a 'backup' run with the file name, size and counts only (tools/backup).
import { existsSync } from 'node:fs';
import { migrationCopiesDir, pruneMigrationCopies } from '../db/store.js';
import { checkPassphrase } from '../tools/backup/crypto.js';
import { createDriveClient } from '../tools/backup/drive.js';
import { runBackup } from '../tools/backup/run.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { dataPath } from '../tools/paths.js';
import { localDate } from '../server/queries.js';
import { startUserRun } from '../db/users.js';

const quiet = { info() {}, warn() {}, error() {}, log() {} };

/**
 * @param {object} o
 * @param {{ db: object }} o.store
 * @param {string} [o.passphrase]
 * @param {string} [o.toDir]  write the encrypted file to this folder instead of uploading
 * @param {object} [o.drive]  a Drive client (tests pass a fake); default: Google Drive with the saved sign-in
 * @param {string|null} [o.copiesDir]  the pre-migration copies to age out after a backup (default: the database's; null: none)
 */
export async function backupJob({ store, passphrase = process.env.HEALTH_BACKUP_PASSPHRASE, toDir, drive, date = localDate(), copiesDir = migrationCopiesDir() }) {
  checkPassphrase(passphrase);
  const run = await startUserRun(store, 'backup', { to: toDir ? 'folder' : 'google-drive' }, quiet);
  try {
    const r = await runBackup({
      db: store.syncDb, // the guarded sync handle until 1G (better-sqlite3's backup API): it throws rather than copy another request's open transaction
      passphrase,
      extras: [{ name: 'programs.json', path: dataPath('maps', 'programs.json') }],
      drive: toDir ? null : drive ?? createDriveClient(getGoogleAuth()),
      toDir,
      date,
    });
    // With a fresh encrypted backup made, pre-migration copies past their age go too, even on a server that has not
    // restarted for weeks (db/store.js MAX_COPY_AGE_DAYS).
    const prunedCopies = copiesDir && existsSync(copiesDir) ? pruneMigrationCopies(copiesDir).length : 0;
    await run.finish('ok', { file: r.name, bytes: r.bytes, contents: r.files, ...(toDir ? { savedTo: r.savedTo } : { kept: r.kept, deleted: r.deleted }), prunedCopies });
    return r;
  } catch (err) {
    await run.finish('error', { error: err.message });
    throw err;
  }
}
