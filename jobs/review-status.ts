// Whether a week's review exists and whether its data is complete enough to write it (the review gate): shared by the
// scheduled and manual review job (jobs/review.ts), npm run review, and the Reviews notice (server/queries.js re-exports
// it). Lives under jobs, not server, so the job never imports the UI's queries (docs/adr/0012).
import { jsonText } from '../db/dialect.ts';
import { zonedParts } from '../tools/time.ts';
import { addDays, lastWeekEnd } from '../metrics/stats.ts';
import { weekDataQuality } from '../metrics/dataquality.ts';
import type { UserDb } from '../ingest/types.ts';

/** The hour on the Sunday after a review week from which a missing review counts as overdue (the task runs at 8). */
export const REVIEW_DUE_HOUR = 9;

/**
 * Whether last week's review exists, and whether its Apple Health data is complete enough to write it: every day of
 * the week has a row and none looks like a partial export. Shared by npm run review (the gate) and the Reviews notice.
 * Dates only, never values.
 * now: the clock, for overdue (no review, and a run was tried or it is past 9am on the Sunday after).
 */
export async function reviewStatus(db: UserDb, today: string, now = new Date()) {
  const weekEnd = lastWeekEnd(today);
  const weekFrom = addDays(weekEnd, -6);
  const daily = await db.prepare('SELECT date, steps, exported_through FROM daily_metrics WHERE user_id = @uid AND date BETWEEN ? AND ? ORDER BY date').all(addDays(weekFrom, -28), weekEnd);
  // The Apple Health gate applies only to someone with Apple Health days in the week or its baseline; someone entering by
  // hand gets their review from what they have. A week with no data of any kind is never sent (no_data).
  const usesApple = daily.length > 0;
  const { missingDays, suspectedPartialDays }: { missingDays: string[], suspectedPartialDays: string[] } = usesApple ? weekDataQuality(daily, weekFrom, weekEnd) : { missingDays: [], suspectedPartialDays: [] };
  let anyData = usesApple;
  for (const sql of usesApple ? [] : [
    'SELECT 1 FROM checkins WHERE user_id = @uid AND date BETWEEN ? AND ? LIMIT 1',
    'SELECT 1 FROM drinking_days WHERE user_id = @uid AND date BETWEEN ? AND ? LIMIT 1',
    'SELECT 1 FROM strength_exercises WHERE user_id = @uid AND date BETWEEN ? AND ? LIMIT 1',
    'SELECT 1 FROM medication_doses WHERE user_id = @uid AND date BETWEEN ? AND ? LIMIT 1',
  ]) {
    if (await db.prepare(sql).get(weekFrom, weekEnd)) { anyData = true; break; }
  }
  const saved = await db.prepare('SELECT summary_json FROM reviews WHERE user_id = @uid AND week_ending = ?').get(weekEnd);
  const hasReview = !!saved;
  // The saved summary carries dataQuality only when the review was written with missing or partial days.
  let gaps: { missingDays?: string[], suspectedPartialDays?: string[] } | null = null;
  try { gaps = saved ? JSON.parse(saved.summary_json).dataQuality ?? null : null; } catch { gaps = null; }
  const writtenWithGaps = gaps ? { missingDays: gaps.missingDays ?? [], partialDays: gaps.suspectedPartialDays ?? [] } : null;
  const run = await db.prepare(`SELECT status, started_at, finished_at, summary FROM runs
    WHERE user_id = @uid AND name = 'review' AND ${jsonText(db, 'meta', 'weekEnd')} = ? ORDER BY id DESC LIMIT 1`).get(weekEnd);
  const lastRun = run ? { ...run, summary: run.summary ? JSON.parse(run.summary) : null } : null;
  const due = today > addDays(weekEnd, 1) || zonedParts(now).hour >= REVIEW_DUE_HOUR;
  return {
    weekEnd,
    hasReview,
    lastRun,
    missingDays,
    partialDays: suspectedPartialDays,
    ready: anyData && !missingDays.length && !suspectedPartialDays.length,
    reason: !anyData ? 'no_data' : missingDays.length || suspectedPartialDays.length ? 'incomplete' : null,
    // A week with no data of any kind is never due: there is nothing to review.
    overdue: !hasReview && anyData && (!!lastRun || due),
    writtenWithGaps,
    // Written while days were missing or partial, and the week is complete now: offer to write it again.
    rewriteAvailable: !!writtenWithGaps && !missingDays.length && !suspectedPartialDays.length,
  };
}
