// The monthly backup restore test as a job: npm run backup:test (scripts/backup-verify.js) and the in-app scheduler
// (SCHEDULE_RESTORE_TEST) run this. Downloads the newest backup from Google Drive (or reads a file), runs restoreTest
// (tools/backup/restore-check.ts), and records a 'restore-test' run with the backup's name and counts; a failure is an
// error run, which the Today tab shows as a warning until a later test passes.
import { readFileSync } from 'node:fs';
import { createDriveClient } from '../tools/backup/drive.ts';
import { DRIVE_FOLDER } from '../tools/backup/run.ts';
import { newestBackup, restoreTest } from '../tools/backup/restore-check.ts';
import { getGoogleAuth } from '../tools/google/auth.ts';
import { startUserRun } from '../db/users.ts';
import type { DriveClient } from '../tools/backup/drive.ts';
import type { UserStore } from '../ingest/types.ts';

const quiet = { info() {}, warn() {}, error() {}, log() {} };

/**
 * drive: a Drive client (tests pass a fake); default: Google Drive with the saved sign-in. fromFile: test this backup file
 * instead of the newest one in Drive.
 */
export async function restoreTestJob({ store, passphrase = process.env.HEALTH_BACKUP_PASSPHRASE, drive, fromFile }: {
  store: UserStore, passphrase?: string, drive?: DriveClient, fromFile?: string,
}) {
  const run = await startUserRun(store, 'restore-test', { from: fromFile ? 'file' : 'google-drive' }, quiet);
  try {
    let name: string | undefined;
    let file: Buffer;
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
    const r = await restoreTest({ file, passphrase: passphrase as string, live: store.db }); // either engine: counts through the async interface
    const summary = { file: name, tables: r.tables, rowsBackup: r.rowsBackup, rowsLive: r.rowsLive, differences: r.differences.length, problems: r.problems };
    await run.finish(r.ok ? 'ok' : 'error', summary);
    return { ...r, file: name };
  } catch (err: any) {
    await run.finish('error', { error: err.message });
    throw err;
  }
}
