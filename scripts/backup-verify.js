// The backup restore test: decrypts the newest backup into the OS temp folder, checks it, compares its tables with the
// live database by row count, then deletes it. Prints counts only. Monthly in the server on SCHEDULE_RESTORE_TEST.
//   npm run backup:test                          the newest backup in Google Drive
//   npm run backup:test -- --file E:\HealthBackups\health-2026-10-05.hrbk
import { openHealthStore } from '../db/store.js';
import { restoreTestJob } from '../jobs/restore-check.js';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const store = openHealthStore();
  try {
    const r = await restoreTestJob({ store, fromFile: arg('--file') });
    console.log(`${r.ok ? 'Passed' : 'FAILED'}: ${r.file} decrypted and passed its integrity check; ${r.tables} tables, `
      + `${r.rowsBackup.toLocaleString()} rows in the backup and ${r.rowsLive.toLocaleString()} live (${r.differences.length} tables differ, as expected since the backup).`);
    for (const p of r.problems) console.log(`  problem: ${p}`);
    if (!r.ok) process.exitCode = 1;
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`Restore test failed: ${err.message}`);
  if (/invalid_grant/.test(err.message)) console.error('The saved Google sign-in is no longer valid. Run "npm run google:login".');
  process.exitCode = 1;
});
