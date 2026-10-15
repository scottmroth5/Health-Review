// One-off: moves workouts from the consolidated Workout Sessions sheet back the 3 hours that sheet added to their start
// and end, and deletes their late twins of workouts already read from Health Auto Export's files (ingest/session-times.js).
// Prints counts only.
//   npm run fix:session-times             dry run: what would change
//   npm run fix:session-times -- --apply  do it (once; back up data/health.db first)
import { openHealthStore } from '../db/store.js';
import { fixSessionTimes } from '../ingest/session-times.js';

const apply = process.argv.includes('--apply');
const store = openHealthStore();
try {
  const r = fixSessionTimes(store, { apply });
  console.log(`Workouts: ${r.total}. From the export files (kept as they are): ${r.fromExports}.`);
  console.log(`From the consolidated sheet: ${r.lateTwins} late duplicates of export workouts to delete; ${r.toMove} to move back 3 hours`
    + ` (${r.movedToEarlierDate} of them to the previous day); collisions: ${r.collisions}.`);
  if (r.alreadyApplied) console.log('This fix was already applied.');
  else console.log(r.applied ? 'Applied. Restart the server: npm run server:restart' : 'Dry run: nothing changed. Run with -- --apply to do it.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  store.close();
}
