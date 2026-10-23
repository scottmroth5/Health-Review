// The encrypted backup as a job: npm run backup (scripts/backup.js) and the in-app scheduler (SCHEDULE_BACKUP) run this.
// data/health.db and the MAPS catalog, encrypted with HEALTH_BACKUP_PASSPHRASE, to Google Drive (or a folder), recorded
// as a 'backup' run with the file name, size and counts only (tools/backup).
import { createTracer } from '@scottmroth5/agent-core';
import { checkPassphrase } from '../tools/backup/crypto.js';
import { createDriveClient } from '../tools/backup/drive.js';
import { runBackup } from '../tools/backup/run.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { repoPath } from '../tools/paths.js';
import { localDate } from '../server/queries.js';

const quiet = { info() {}, warn() {}, error() {}, log() {} };

/**
 * @param {object} o
 * @param {{ db: object }} o.store
 * @param {string} [o.passphrase]
 * @param {string} [o.toDir]  write the encrypted file to this folder instead of uploading
 * @param {object} [o.drive]  a Drive client (tests pass a fake); default: Google Drive with the saved sign-in
 */
export async function backupJob({ store, passphrase = process.env.HEALTH_BACKUP_PASSPHRASE, toDir, drive, date = localDate() }) {
  checkPassphrase(passphrase);
  const run = createTracer({ store, logger: quiet }).startRun('backup', { to: toDir ? 'folder' : 'google-drive' });
  try {
    const r = await runBackup({
      db: store.db,
      passphrase,
      extras: [{ name: 'programs.json', path: repoPath('data', 'maps', 'programs.json') }],
      drive: toDir ? null : drive ?? createDriveClient(getGoogleAuth()),
      toDir,
      date,
    });
    run.finish('ok', { file: r.name, bytes: r.bytes, contents: r.files, ...(toDir ? { savedTo: r.savedTo } : { kept: r.kept, deleted: r.deleted }) });
    return r;
  } catch (err) {
    run.finish('error', { error: err.message });
    throw err;
  }
}
