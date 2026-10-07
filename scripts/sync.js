// Copies new rows from the Google Sheets into data/health.db. Prints counts and warnings only
// (row numbers and kinds, never cell contents).
//   npm run sync                 incremental: new health and workout rows, current Workout Log tab
//   npm run sync -- --backfill   one-time full import, including the drinking log and weekly check-ins
import { getGoogleAuth } from '../tools/google/auth.js';
import { openHealthStore } from '../db/store.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { runSync } from '../ingest/sync.js';

const DETAILED = new Set(['year corrected', 'unknown column', 'several rows for one day']);

async function main() {
  const backfill = process.argv.includes('--backfill');
  const store = openHealthStore();
  try {
    const { counts, warnings } = await runSync({ store, source: createSheetsSource(getGoogleAuth()), backfill });
    for (const [source, c] of Object.entries(counts)) console.log(`${source}: ${JSON.stringify(c)}`);

    const groups = new Map();
    for (const w of warnings) {
      const key = `${w.source}: ${w.kind}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }
    if (groups.size) console.log('\nWarnings:');
    for (const [key, list] of groups) {
      console.log(`  ${key} (${list.length})`);
      if (DETAILED.has(list[0].kind) || list[0].source === 'data_check') {
        for (const w of list) console.log(`    ${w.tab && w.row ? `${w.tab} row ${w.row}: ` : w.tab ? `${w.tab}: ` : ''}${w.detail}`);
      }
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`Sync failed: ${err.message}`);
  if (/invalid_grant/.test(err.message)) console.error('The saved Google sign-in is no longer valid. Run "npm run google:login".');
  process.exitCode = 1;
});
