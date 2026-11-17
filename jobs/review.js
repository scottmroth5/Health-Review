// The weekly review as a job: npm run review (scripts/review.js) and the in-app scheduler (SCHEDULE_REVIEW) run this.
//   scheduled  a Monday or Tuesday catch-up does nothing once the week's review exists (no sync, no call, no run)
//   the gate   without force, a week with any day missing from Apple Health (or a likely partial export) is skipped:
//              nothing is sent, and a 'skipped' review run is recorded with the dates only
import { randomUUID } from 'node:crypto';
import { addDays, lastWeekEnd } from '../metrics/stats.js';
import { reviewStatus } from './review-status.js';
import { localDate } from '../tools/time.ts';
import { DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from '../agent/claude.js';
import { runReview } from '../agent/review.js';
import { startUserRun } from '../db/users.ts';

const quiet = { info() {}, warn() {}, error() {} };

/**
 * Writes a week's review again without losing the one it replaces: a review the week already has is copied into
 * review_versions (archived now) before `write` runs, and the copy is removed if `write` fails, since the current review
 * was then never replaced. No transaction spans the Claude call.
 * @param {{ prepare: Function }} db  a user's scoped database
 * @param {string} weekEnd
 * @param {() => Promise<any>} write
 */
export async function withArchive(db, weekEnd, write, { now = new Date() } = {}) {
  const id = randomUUID();
  const archived = await db.prepare(`INSERT INTO review_versions (id, user_id, week_ending, report_md, run_id, created_at, model, warnings, sensitive_sections, archived_at)
    SELECT CAST(? AS TEXT), user_id, week_ending, report_md, run_id, created_at, model, warnings, sensitive_sections, CAST(? AS TEXT)
    FROM reviews WHERE user_id = @uid AND week_ending = ?`).run(id, now.toISOString(), weekEnd);
  try {
    return await write();
  } catch (err) {
    if (archived.changes) await db.prepare('DELETE FROM review_versions WHERE user_id = @uid AND id = ?').run(id);
    throw err;
  }
}

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
  // The async handle (docs/adr/0006; v3 Phase 1B slice 3): nothing here opens a transaction, and none spans the Claude call.
  const { db } = store;
  if (scheduled && await db.prepare('SELECT 1 FROM reviews WHERE user_id = @uid AND week_ending = ?').get(week)) return { status: 'exists', weekEnd: week };
  let syncError;
  if (sync && !noSync) {
    try { await sync(); } catch (err) { syncError = err.message; }
  }
  // reviewStatus works from today's last week; for an explicit week it is asked as of the Sunday after that week.
  const gate = await reviewStatus(db, weekEnd ? addDays(week, 1) : today);
  if (!gate.ready && !force) {
    await (await startUserRun(store, 'review', { weekEnd: week, gate: true }, quiet))
      .finish('skipped', { weekEnd: week, reason: gate.reason, missingDays: gate.missingDays, partialDays: gate.partialDays });
    return { status: 'skipped', weekEnd: week, reason: gate.reason, missingDays: gate.missingDays, partialDays: gate.partialDays, syncError };
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
  const client = await claude();
  const result = await withArchive(db, week, () => runReview({ store, claude: client, weekEnd: week, today, catalog, model, effort, logger: quiet }));
  return { status: 'written', weekEnd: week, result, syncError };
}
