// Encrypted backup of data/health.db and the MAPS catalog (data/maps/programs.json), uploaded to the
// "Health-Review backups" folder in Google Drive, keeping 7 nightly, 3 weekly and 1 monthly copies.
// Prints the file name, size and counts only; never contents or the passphrase. The same job runs in the server on
// SCHEDULE_BACKUP (jobs/backup.js).
//   npm run backup                          back up now and upload
//   npm run backup -- --to E:\HealthBackups  write the encrypted file to a folder (e.g. a USB drive), no upload
//   npm run backup -- --check-passphrase    check HEALTH_BACKUP_PASSPHRASE in .env, then stop
import { openOwnerStore } from '../db/store.js';
import { checkPassphrase } from '../tools/backup/crypto.js';
import { backupJob } from '../jobs/backup.js';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  checkPassphrase(process.env.HEALTH_BACKUP_PASSPHRASE);
  if (process.argv.includes('--check-passphrase')) {
    console.log('The backup passphrase is set and long enough. Keep a copy in your password manager: without it the backups cannot be read.');
    return;
  }
  const toDir = arg('--to');
  const store = openOwnerStore();
  try {
    const r = await backupJob({ store, toDir });
    const kb = Math.round(r.bytes / 1024).toLocaleString();
    console.log(toDir
      ? `Encrypted backup written: ${r.savedTo} (${kb} KB; ${r.files.join(', ')})`
      : `Encrypted backup uploaded to Google Drive: ${r.name} (${kb} KB; ${r.files.join(', ')}). Kept ${r.kept}, deleted ${r.deleted}.`);
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`Backup failed: ${err.message}`);
  if (/invalid_grant/.test(err.message)) console.error('The saved Google sign-in is no longer valid. Run "npm run google:login".');
  process.exitCode = 1;
});
