// Encrypted backup of data/health.db and the MAPS catalog (data/maps/programs.json), uploaded to the
// "Health-Review backups" folder in Google Drive, keeping 7 nightly, 3 weekly and 1 monthly copies.
// Prints the file name, size and counts only; never contents or the passphrase.
//   npm run backup                          back up now and upload
//   npm run backup -- --to E:\HealthBackups  write the encrypted file to a folder (e.g. a USB drive), no upload
//   npm run backup -- --check-passphrase    check HEALTH_BACKUP_PASSPHRASE in .env, then stop
import { createTracer } from '@scottmroth5/agent-core';
import { openHealthStore } from '../db/store.js';
import { checkPassphrase } from '../tools/backup/crypto.js';
import { createDriveClient } from '../tools/backup/drive.js';
import { runBackup } from '../tools/backup/run.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { repoPath } from '../tools/paths.js';
import { localDate } from '../server/queries.js';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const passphrase = process.env.HEALTH_BACKUP_PASSPHRASE;

async function main() {
  checkPassphrase(passphrase);
  if (process.argv.includes('--check-passphrase')) {
    console.log('The backup passphrase is set and long enough. Keep a copy in your password manager: without it the backups cannot be read.');
    return;
  }
  const toDir = arg('--to');
  const store = openHealthStore();
  const run = createTracer({ store, logger: { info() {}, warn() {}, error() {}, log() {} } }).startRun('backup', { to: toDir ? 'folder' : 'google-drive' });
  try {
    const r = await runBackup({
      db: store.db,
      passphrase,
      extras: [{ name: 'programs.json', path: repoPath('data', 'maps', 'programs.json') }],
      drive: toDir ? null : createDriveClient(getGoogleAuth()),
      toDir,
      date: localDate(),
    });
    run.finish('ok', { file: r.name, bytes: r.bytes, contents: r.files, ...(toDir ? { savedTo: r.savedTo } : { kept: r.kept, deleted: r.deleted }) });
    const kb = Math.round(r.bytes / 1024).toLocaleString();
    console.log(toDir
      ? `Encrypted backup written: ${r.savedTo} (${kb} KB; ${r.files.join(', ')})`
      : `Encrypted backup uploaded to Google Drive: ${r.name} (${kb} KB; ${r.files.join(', ')}). Kept ${r.kept}, deleted ${r.deleted}.`);
  } catch (err) {
    run.finish('error', { error: err.message });
    throw err;
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`Backup failed: ${err.message}`);
  if (/invalid_grant/.test(err.message)) console.error('The saved Google sign-in is no longer valid. Run "npm run google:login".');
  process.exitCode = 1;
});
