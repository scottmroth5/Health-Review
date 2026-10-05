// Restores an encrypted backup into NEW files; it never touches data/health.db.
//   npm run backup:restore -- --file latest --out data/restored.db          newest backup in Google Drive
//   npm run backup:restore -- --file E:\HealthBackups\health-2026-10-05.hrbk --out data/restored.db
// The catalog, if the backup has one, is written next to the database as restored-programs.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDriveClient } from '../tools/backup/drive.js';
import { DRIVE_FOLDER, restoreBackup } from '../tools/backup/run.js';
import { getGoogleAuth } from '../tools/google/auth.js';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const which = arg('--file');
  const out = arg('--out');
  if (!which || !out) throw new Error('Give --file <path or latest> and --out <new database file>');
  let file;
  if (which === 'latest') {
    const drive = createDriveClient(getGoogleAuth());
    const folder = await drive.ensureFolder(DRIVE_FOLDER);
    const newest = (await drive.list(folder)).filter((f) => /^health-\d{4}-\d{2}-\d{2}\.hrbk$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
    if (!newest) throw new Error(`No backups found in the "${DRIVE_FOLDER}" folder`);
    console.log(`Downloading ${newest.name}...`);
    file = await drive.download(newest.id);
  } else {
    file = readFileSync(which);
  }
  const r = restoreBackup({ file, passphrase: process.env.HEALTH_BACKUP_PASSPHRASE, outPath: resolve(out) });
  console.log(`Restored and checked: ${r.database}${r.others.length ? `, plus ${r.others.join(', ')}` : ''}`);
  console.log('To use it: stop the server (Stop-ScheduledTask -TaskName "Health-Review server"), move data\\health.db aside,');
  console.log('rename the restored file to data\\health.db, then start the server again (Start-ScheduledTask -TaskName "Health-Review server").');
}

main().catch((err) => {
  console.error(`Restore failed: ${err.message}`);
  process.exitCode = 1;
});
