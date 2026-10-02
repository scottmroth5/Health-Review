// Lists exercise names with no dictionary entry, grouped by spelling variants, most sets first.
// Prints names, set counts and years only; never weights or dates.
//   npm run log:unmapped               every group
//   npm run log:unmapped -- --top 50   the 50 groups with the most sets
import { openHealthStore } from '../db/store.js';
import { unmappedNames } from '../ingest/normalize.js';

const topArg = process.argv.indexOf('--top');
const top = topArg > 0 ? Number(process.argv[topArg + 1]) : Infinity;

const store = openHealthStore();
try {
  const groups = unmappedNames(store.db);
  if (!groups.length) {
    console.log('Every exercise name is mapped or ignored.');
  } else {
    const total = groups.reduce((a, g) => a + g.sets, 0);
    console.log(`${groups.length} names to map, covering ${total} sets (inferred = implement read from the name, exercise still unknown):`);
    for (const g of groups.slice(0, top)) {
      const years = g.first === g.last ? `${g.first}` : `${g.first}-${g.last}`;
      const status = g.status === 'inferred' ? `inferred ${g.implement}` : g.status;
      console.log(`${String(g.sets).padStart(5)} sets  ${years}  [${status}]  ${g.spellings.join(' | ')}`);
    }
  }
} finally {
  store.close();
}
