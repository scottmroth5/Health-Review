// The weekly review as a job: npm run review (scripts/review.js) and the in-app scheduler (SCHEDULE_REVIEW) run this.
//   scheduled  a Monday or Tuesday catch-up does nothing once the week's review exists (no sync, no call, no run)
//   the gate   without force, a week with any day missing from Apple Health (or a likely partial export) is skipped:
//              nothing is sent, and a 'skipped' review run is recorded with the dates only
import { addDays, lastWeekEnd } from '../metrics/stats.js';
import { localDate, reviewStatus } from '../server/queries.js';
import { DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from '../agent/claude.js';
import { runReview } from '../agent/review.js';
import { startUserRun } from '../db/users.js';

const quiet = { info() {}, warn() {}, error() {} };

/**
 * @param {object} o
 * @param {{ db: object }} o.store
 * @param {() => { send: Function }} o.claude  the review's Claude client, made on first use
 * @param {(() => Promise<object>)|null} [o.sync]  runs first unless noSync; a failed sync reviews the data already stored
 * @param {string} [o.weekEnd]  default: the week ending last Saturday (owner's time)
 * @param {boolean} [o.scheduled]  do nothing when the week's review exists
 * @param {boolean} [o.force]  write it although days are missing or partial
 * @returns {Promise<{ status: 'exists'|'skipped'|'written', weekEnd: string, missingDays?: string[], partialDays?: string[], syncError?: string, result?: object }>}
 */
export async function weeklyReview({ store, claude, sync = null, weekEnd, catalog, scheduled = false, force = false, noSync = false, today = localDate(),
  model = process.env.REVIEW_MODEL || DEFAULT_REVIEW_MODEL, effort = process.env.REVIEW_EFFORT || DEFAULT_REVIEW_EFFORT }) {
  const week = weekEnd ?? lastWeekEnd(today);
  if (scheduled && store.db.prepare('SELECT 1 FROM reviews WHERE user_id = @uid AND week_ending = ?').get(week)) return { status: 'exists', weekEnd: week };
  let syncError;
  if (sync && !noSync) {
    try { await sync(); } catch (err) { syncError = err.message; }
  }
  // reviewStatus works from today's last week; for an explicit week it is asked as of the Sunday after that week.
  const gate = reviewStatus(store.db, weekEnd ? addDays(week, 1) : today);
  if (!gate.ready && !force) {
    startUserRun(store, 'review', { weekEnd: week, gate: true }, quiet)
      .finish('skipped', { weekEnd: week, missingDays: gate.missingDays, partialDays: gate.partialDays });
    return { status: 'skipped', weekEnd: week, missingDays: gate.missingDays, partialDays: gate.partialDays, syncError };
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
  const result = await runReview({ store, claude: claude(), weekEnd: week, today, catalog, model, effort, logger: quiet });
  return { status: 'written', weekEnd: week, result, syncError };
}
