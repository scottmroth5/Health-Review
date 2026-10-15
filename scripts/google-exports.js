// Counts Health Auto Export's files in its two Drive folders (HEALTH_EXPORT_FOLDER_ID for health metrics,
// WORKOUT_EXPORT_FOLDER_ID for workout sessions) before the sync reads them directly. Prints counts and file dates only,
// never file names or contents.
//   npm run google:exports
import { getGoogleAuth } from '../tools/google/auth.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { openHealthStore } from '../db/store.js';
import { EXPORT_FILES_PER_SYNC } from '../ingest/sync.js';

const FOLDERS = [
  { kind: 'health', env: 'HEALTH_EXPORT_FOLDER_ID', label: 'Health metrics folder' },
  { kind: 'workouts', env: 'WORKOUT_EXPORT_FOLDER_ID', label: 'Workout sessions folder' },
];

async function main() {
  const set = FOLDERS.filter((f) => process.env[f.env]);
  if (!set.length) throw new Error(`Neither ${FOLDERS.map((f) => f.env).join(' nor ')} is set in .env (each is the long id in the folder's Drive URL).`);
  const source = createSheetsSource(getGoogleAuth());
  const store = openHealthStore();
  let known;
  try {
    known = new Map(store.db.prepare('SELECT file_id, modified_time FROM drive_exports').all().map((r) => [r.file_id, r.modified_time]));
  } finally {
    store.close();
  }
  for (const f of FOLDERS) {
    if (!process.env[f.env]) {
      console.log(`${f.label}: ${f.env} is not set, so this kind still comes from its consolidated sheet.`);
      continue;
    }
    const files = await source.listExports(process.env[f.env], f.kind);
    const dates = files.map((x) => x.modifiedTime.slice(0, 10)).sort();
    const left = files.filter((x) => known.get(x.id) !== x.modifiedTime).length;
    console.log(`${f.label}: ${files.length} export files${files.length ? ` (modified ${dates[0]} to ${dates.at(-1)})` : ''}, `
      + `${files.length - left} already read${left ? `, ${left} to read in about ${Math.ceil(left / EXPORT_FILES_PER_SYNC)} sync(s)` : ''}.`);
    if (!files.length) console.log('  No files matched. Check the folder id, and that the file names are the ones Health Auto Export writes.');
  }
}

main().catch((err) => {
  const status = err.response?.status ?? err.code;
  if (status === 403) console.error('Drive refused the listing: run "npm run google:login" again to grant the folder-listing permission.');
  else if (status === 404) console.error('Drive could not find a folder: check the folder ids in .env.');
  else console.error(`Export check failed: ${err.message}`);
  process.exitCode = 1;
});
