// Applies config/exercise-dictionary.json to the whole Workout Log history and prints coverage.
// Prints counts only: no names, weights or dates.
//   npm run log:normalize
import { openHealthStore } from '../db/store.js';
import { loadDictionary } from '../metrics/dictionary.js';
import { normalizeAll } from '../ingest/normalize.js';

let dictionary;
try {
  dictionary = loadDictionary();
} catch (err) {
  console.error(err.code === 'ENOENT' ? 'No config/exercise-dictionary.json yet.' : err.message);
  process.exit(1);
}

const store = openHealthStore();
try {
  const c = normalizeAll(store.db, dictionary);
  console.log(`Sets mapped to a canonical exercise and implement: ${c.mappedSets} of ${c.sets} (${c.mappedPct}%)`);
  for (const [status, n] of Object.entries(c.byStatus)) console.log(`  ${status.padEnd(9)} ${n.sets} sets, ${n.exercises} exercise rows`);
  console.log('Run npm run log:unmapped to see the names still needing an entry.');
} finally {
  store.close();
}
