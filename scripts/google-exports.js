// Counts Health Auto Export's files in the Drive folder (HEALTH_EXPORT_FOLDER_ID) before the sync reads them directly.
// Prints counts and file dates only: never file names beyond the two kinds, and never contents.
//   npm run google:exports
import { getGoogleAuth } from '../tools/google/auth.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { openHealthStore } from '../db/store.js';
import { EXPORT_FILES_PER_SYNC } from '../ingest/sync.js';

async function main() {
  const folderId = process.env.HEALTH_EXPORT_FOLDER_ID;
  if (!folderId) throw new Error('HEALTH_EXPORT_FOLDER_ID is not set in .env (the export folder id from its Drive URL).');
  const files = await createSheetsSource(getGoogleAuth()).listExports(folderId);
  const store = openHealthStore();
  let known;
  try {
    known = new Map(store.db.prepare('SELECT file_id, modified_time FROM drive_exports').all().map((r) => [r.file_id, r.modified_time]));
  } finally {
    store.close();
  }
  for (const kind of ['health', 'workouts']) {
    const list = files.filter((f) => f.kind === kind);
    const dates = list.map((f) => f.modifiedTime.slice(0, 10)).sort();
    const done = list.filter((f) => known.get(f.id) === f.modifiedTime).length;
    const label = kind === 'health' ? 'Health metrics files' : 'Workout files';
    console.log(`${label}: ${list.length}${list.length ? ` (modified ${dates[0]} to ${dates.at(-1)})` : ''}, ${done} already read`);
  }
  const left = files.filter((f) => known.get(f.id) !== f.modifiedTime).length;
  console.log(left
    ? `${left} files to read: about ${Math.ceil(left / EXPORT_FILES_PER_SYNC)} sync(s) at ${EXPORT_FILES_PER_SYNC} files each.`
    : 'Nothing new to read.');
}

main().catch((err) => {
  const status = err.response?.status ?? err.code;
  if (status === 403) console.error('Drive refused the listing: run "npm run google:login" again to grant the folder-listing permission.');
  else console.error(`Export check failed: ${err.message}`);
  process.exitCode = 1;
});
