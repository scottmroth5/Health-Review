// Generates the weekly review and saves it (read it on the Reviews tab). Prints metadata only.
//   npm run review                       sync, then review the week ending last Saturday
//   npm run review -- --week 2026-09-26  a specific week (ending on that Saturday)
//   npm run review -- --dry-run          build the summary and prompt, report sizes, call nothing
//   npm run review -- --no-sync          skip the sync first
//   npm run review -- --force            write it even when Apple Health days are missing or partial
//   npm run review -- --scheduled        what the schedule runs (Sunday, with Monday and Tuesday catch-ups): do nothing
//                                        when the week's review already exists
// Without --force, a week with any day missing from Apple Health (or a likely partial export) is skipped: nothing is
// sent, a 'skipped' review run is recorded with the dates, and the Reviews tab offers a manual run. The same job runs in
// the server on SCHEDULE_REVIEW (jobs/review.js). REVIEW_MODEL and REVIEW_EFFORT in .env override the defaults.
import { openOwnerStore } from '../db/store.js';
import { addDays, lastWeekEnd } from '../metrics/stats.js';
import { isValidDate, localDate, reviewStatus } from '../server/queries.js';
import { createReviewClaude, DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from '../agent/claude.js';
import { prepareReview } from '../agent/review.js';
import { weeklyReview } from '../jobs/review.js';
import { syncJob } from '../jobs/sync.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const weekArg = args.indexOf('--week');
const today = localDate();
const weekEnd = weekArg >= 0 ? args[weekArg + 1] : lastWeekEnd(today);
const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const model = process.env.REVIEW_MODEL || DEFAULT_REVIEW_MODEL;
const effort = process.env.REVIEW_EFFORT || DEFAULT_REVIEW_EFFORT;
const gapsText = (missing, partial) => [
  missing.length ? `no Apple Health data for ${missing.map(shortDate).join(', ')}` : '',
  partial.length ? `a likely partial export on ${partial.map(shortDate).join(', ')}` : '',
].filter(Boolean).join('; ');

async function main() {
  if (!isValidDate(weekEnd)) throw new Error(`Not a date: ${weekEnd}. Use --week YYYY-MM-DD.`);
  const store = openOwnerStore();
  try {
    if (flag('--dry-run')) {
      const gate = reviewStatus(store.db, weekArg >= 0 ? addDays(weekEnd, 1) : today);
      console.log(gate.ready ? 'Data gate: Apple Health data is complete for the week.' : `Data gate: ${gapsText(gate.missingDays, gate.partialDays)} (a scheduled run would skip).`);
      const prep = prepareReview(store.db, { weekEnd, today });
      console.log(`Week ending ${weekEnd} (dry run, nothing sent)`);
      console.log(`  instructions: ${prep.system.length.toLocaleString()} characters from sections ${prep.sectionNames.join(', ')}`);
      console.log(`  sensitive sections included: ${prep.sensitiveSent.join(', ') || 'none'}`);
      console.log(`  summary: ${JSON.stringify(prep.summary).length.toLocaleString()} characters, ${prep.summary.notes.length} notes`);
      console.log(`  model: ${model}, effort: ${effort}`);
      return;
    }
    let claude;
    const r = await weeklyReview({
      store, today, weekEnd: weekArg >= 0 ? weekEnd : undefined, scheduled: flag('--scheduled'), force: flag('--force'),
      noSync: flag('--no-sync'), sync: () => syncJob({ store }), claude: () => (claude ??= createReviewClaude()), model, effort,
    });
    if (r.syncError) console.warn(`Sync failed (${r.syncError}); reviewed the data already stored.`);
    if (r.status === 'exists') return console.log(`Already written for the week ending ${r.weekEnd}; nothing to do.`);
    if (r.status === 'skipped') {
      console.log(`Skipped the week ending ${r.weekEnd}: ${gapsText(r.missingDays, r.partialDays)}. Nothing was sent.`);
      console.log('Run it from the Reviews tab once the data arrives, or: npm run review -- --force');
      return;
    }
    const x = r.result;
    console.log(`Saved the week ending ${r.weekEnd}: ${x.sections} sections, ${x.physicianItems} physician discussion items, ${x.attempts} attempt(s), $${x.costUsd.toFixed(4)} (${x.model}).`);
    if (x.warnings.length) console.log(`  ${x.warnings.length} check(s) still failing; they are shown with the report.`);
    console.log('Read it on the Reviews tab.');
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`Review failed: ${err.name === 'Error' ? '' : `${err.name}: `}${err.message}`);
  process.exitCode = 1;
});
