// Generates the weekly review and saves it (read it on the Reviews tab). Prints metadata only.
//   npm run review                       sync, then review the week ending last Saturday
//   npm run review -- --week 2026-09-26  a specific week (ending on that Saturday)
//   npm run review -- --dry-run          build the summary and prompt, report sizes, call nothing
//   npm run review -- --no-sync          skip the sync first
//   npm run review -- --force            write it even when Apple Health days are missing or partial
//   npm run review -- --scheduled        the scheduled task (Sunday, with Monday and Tuesday catch-ups): do nothing
//                                        when the week's review already exists
// Without --force, a week with any day missing from Apple Health (or a likely partial export) is skipped: nothing is
// sent, a 'skipped' review run is recorded with the dates, and the Reviews tab offers a manual run.
// REVIEW_MODEL and REVIEW_EFFORT in .env override the defaults (claude-opus-5-5, high).
import { openHealthStore } from '../db/store.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { runSync } from '../ingest/sync.js';
import { addDays, lastWeekEnd } from '../metrics/stats.js';
import { isValidDate, localDate, reviewStatus } from '../server/queries.js';
import { createTracer } from '@scottmroth5/agent-core';
import { createReviewClaude, DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from '../agent/claude.js';
import { prepareReview, runReview } from '../agent/review.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const weekArg = args.indexOf('--week');
const today = localDate();
const weekEnd = weekArg >= 0 ? args[weekArg + 1] : lastWeekEnd(today);
const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const model = process.env.REVIEW_MODEL || DEFAULT_REVIEW_MODEL;
const effort = process.env.REVIEW_EFFORT || DEFAULT_REVIEW_EFFORT;
const quiet = { info() {}, warn() {}, error() {} };

async function main() {
  if (!isValidDate(weekEnd)) throw new Error(`Not a date: ${weekEnd}. Use --week YYYY-MM-DD.`);
  const store = openHealthStore();
  try {
    // A catch-up run after Sunday's review was written: no sync, no call, no run recorded.
    if (flag('--scheduled') && store.db.prepare('SELECT 1 FROM reviews WHERE week_ending = ?').get(weekEnd)) {
      console.log(`Already written for the week ending ${weekEnd}; nothing to do.`);
      return;
    }
    if (!flag('--no-sync') && !flag('--dry-run')) {
      try {
        await runSync({ store, source: createSheetsSource(getGoogleAuth()), logger: quiet });
        console.log('Synced.');
      } catch (err) {
        console.warn(`Sync failed (${err.message}); reviewing the data already stored.`);
      }
    }

    // The gate: every day of the week needs Apple Health data (dates only are printed and recorded).
    // reviewStatus works from today's last week; for --week it is asked as of the Sunday after that week.
    const gate = reviewStatus(store.db, weekArg >= 0 ? addDays(weekEnd, 1) : today);
    const gaps = [
      gate.missingDays.length ? `no Apple Health data for ${gate.missingDays.map(shortDate).join(', ')}` : '',
      gate.partialDays.length ? `a likely partial export on ${gate.partialDays.map(shortDate).join(', ')}` : '',
    ].filter(Boolean).join('; ');

    if (flag('--dry-run')) {
      console.log(gate.ready ? 'Data gate: Apple Health data is complete for the week.' : `Data gate: ${gaps} (a scheduled run would skip).`);
      const prep = prepareReview(store.db, { weekEnd, today });
      const summaryText = JSON.stringify(prep.summary);
      console.log(`Week ending ${weekEnd} (dry run, nothing sent)`);
      console.log(`  instructions: ${prep.system.length.toLocaleString()} characters from sections ${prep.sectionNames.join(', ')}`);
      console.log(`  sensitive sections included: ${prep.sensitiveSent.join(', ') || 'none'}`);
      console.log(`  summary: ${summaryText.length.toLocaleString()} characters, ${prep.summary.notes.length} notes`);
      console.log(`  model: ${model}, effort: ${effort}`);
      return;
    }

    if (!gate.ready && !flag('--force')) {
      const run = createTracer({ store, logger: quiet }).startRun('review', { weekEnd, gate: true });
      run.finish('skipped', { weekEnd, missingDays: gate.missingDays, partialDays: gate.partialDays });
      console.log(`Skipped the week ending ${weekEnd}: ${gaps}. Nothing was sent.`);
      console.log('Run it from the Reviews tab once the data arrives, or: npm run review -- --force');
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    console.log(`Reviewing the week ending ${weekEnd} with ${model} (${effort} effort)...`);
    const r = await runReview({ store, claude: createReviewClaude(), weekEnd, today, model, effort, logger: quiet });
    console.log(`Saved: ${r.sections} sections, ${r.physicianItems} physician discussion items, ${r.attempts} attempt(s), $${r.costUsd.toFixed(4)} (${r.model}).`);
    if (r.warnings.length) console.log(`  ${r.warnings.length} check(s) still failing; they are shown with the report.`);
    console.log('Read it on the Reviews tab: http://localhost:5188/#reviews');
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`Review failed: ${err.name === 'Error' ? '' : `${err.name}: `}${err.message}`);
  process.exitCode = 1;
});
