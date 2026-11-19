// The weekly review as a job: npm run review (scripts/review.js) and the in-app scheduler (SCHEDULE_REVIEW) run this.
//   scheduled  a Monday or Tuesday catch-up does nothing once the week's review exists (no sync, no call, no run)
//   the gate   without force, a week with any day missing from Apple Health (or a likely partial export) is skipped:
//              nothing is sent, and a 'skipped' review run is recorded with the dates only
import { randomUUID } from 'node:crypto';
import { addDays, lastWeekEnd } from '../metrics/stats.ts';
import { reviewStatus } from './review-status.ts';
import { localDate } from '../tools/time.ts';
import { DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from '../agent/claude.js';
import { runReview } from '../agent/review.js';
import { startUserRun } from '../db/users.ts';
import type { UserDb, UserStore } from '../ingest/types.ts';
import type { Catalog } from '../metrics/catalog.ts';

const quiet = { info() {}, warn() {}, error() {} };

/**
 * Writes a week's review again without losing the one it replaces: a review the week already has is copied into
 * review_versions (archived now) before `write` runs, and the copy is removed if `write` fails, since the current review
 * was then never replaced. No transaction spans the Claude call.
 * db: a user's scoped database.
 */
export async function withArchive<T>(db: UserDb, weekEnd: string, write: () => Promise<T>, { now = new Date() }: { now?: Date } = {}): Promise<T> {
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
 * claude: the review's Claude client, made on first use. sync: runs first unless noSync; a failed sync reviews the data
 * already stored. weekEnd: default the week ending last Saturday (owner's time). scheduled: do nothing when the week's
 * review exists. force: write it although days are missing or partial.
 */
export async function weeklyReview({ store, claude, sync = null, weekEnd, catalog, scheduled = false, force = false, noSync = false, today = localDate(),
  model = process.env.REVIEW_MODEL || DEFAULT_REVIEW_MODEL, effort = process.env.REVIEW_EFFORT || DEFAULT_REVIEW_EFFORT }: {
  store: UserStore, claude: () => any, sync?: (() => Promise<unknown>) | null, weekEnd?: string, catalog?: Catalog | null,
  scheduled?: boolean, force?: boolean, noSync?: boolean, today?: string, model?: string, effort?: string,
}) {
  const week = weekEnd ?? lastWeekEnd(today);
  // The async handle (docs/adr/0006; v3 Phase 1B slice 3): nothing here opens a transaction, and none spans the Claude call.
  const { db } = store;
  if (scheduled && await db.prepare('SELECT 1 FROM reviews WHERE user_id = @uid AND week_ending = ?').get(week)) return { status: 'exists', weekEnd: week };
  let syncError: string | undefined;
  if (sync && !noSync) {
    try { await sync(); } catch (err: any) { syncError = err.message; }
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
  // runReview's JSDoc (agent/review.js, harness-gated, so unchanged until the agent/ step) names better-sqlite3's
  // Database and leaves out catalog, which it passes on; the call is as before.
  const options: any = { store, claude: client, weekEnd: week, today, catalog, model, effort, logger: quiet };
  const result = await withArchive(db, week, () => runReview(options));
  return { status: 'written', weekEnd: week, result, syncError };
}
