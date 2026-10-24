// The monthly backup restore test as a job: npm run backup:test (scripts/backup-verify.js) and the in-app scheduler
// (SCHEDULE_RESTORE_TEST) run this. Downloads the newest backup from Google Drive (or reads a file), runs restoreTest
// (tools/backup/restore-check.js), and records a 'restore-test' run with the backup's name and counts; a failure is an
// error run, which the Today tab shows as a warning until a later test passes.
import { readFileSync } from 'node:fs';
import { createDriveClient } from '../tools/backup/drive.js';
import { DRIVE_FOLDER } from '../tools/backup/run.js';
import { newestBackup, restoreTest } from '../tools/backup/restore-check.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { startUserRun } from '../db/users.js';

const quiet = { info() {}, warn() {}, error() {}, log() {} };

/**
 * @param {object} o
 * @param {{ db: object }} o.store
 * @param {object} [o.drive]  a Drive client (tests pass a fake); default: Google Drive with the saved sign-in
 * @param {string} [o.fromFile]  test this backup file instead of the newest one in Drive
 */
export async function restoreTestJob({ store, passphrase = process.env.HEALTH_BACKUP_PASSPHRASE, drive, fromFile }) {
  const run = startUserRun(store, 'restore-test', { from: fromFile ? 'file' : 'google-drive' }, quiet);
  try {
    let name;
    let file;
    if (fromFile) {
      name = fromFile.split(/[\\/]/).pop();
      file = readFileSync(fromFile);
    } else {
      const client = drive ?? createDriveClient(getGoogleAuth());
      const newest = await newestBackup(client, DRIVE_FOLDER);
      if (!newest) throw new Error(`No backups found in the "${DRIVE_FOLDER}" folder`);
      name = newest.name;
      file = await client.download(newest.id);
    }
    const r = restoreTest({ file, passphrase, live: store.db });
    const summary = { file: name, tables: r.tables, rowsBackup: r.rowsBackup, rowsLive: r.rowsLive, differences: r.differences.length, problems: r.problems };
    run.finish(r.ok ? 'ok' : 'error', summary);
    return { ...r, file: name };
  } catch (err) {
    run.finish('error', { error: err.message });
    throw err;
  }
}
