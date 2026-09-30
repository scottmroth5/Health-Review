// Prints the computed summary for a week as JSON: the exact numbers the weekly review will use.
//   npm run metrics                      the most recent full week (ending last Saturday)
//   npm run metrics -- --week 2026-09-26 the week ending on that Saturday
import { openHealthStore } from '../db/store.js';
import { computeWeek } from '../metrics/index.js';
import { loadWeekData, loadMetricSettings } from '../metrics/load.js';
import { lastWeekEnd } from '../metrics/stats.js';
import { isValidDate, localDate } from '../server/queries.js';

const arg = process.argv.indexOf('--week');
const weekEnd = arg > 0 ? process.argv[arg + 1] : lastWeekEnd(localDate());
if (!isValidDate(weekEnd)) {
  console.error(`Not a date: ${weekEnd}. Use --week YYYY-MM-DD.`);
  process.exit(1);
}

const store = openHealthStore();
try {
  const summary = computeWeek(loadWeekData(store.db, weekEnd), { weekEnd, ...loadMetricSettings(store.db) });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  store.close();
}
