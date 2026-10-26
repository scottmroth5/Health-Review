// Guided setup (UX roadmap phase 2, 2026-10-26): the Home checklist that walks a new user through goals, profile, a way
// for their data to come in, optional AI and their first result. It guides and never blocks: entering data by hand is a
// full way to use the app (owner's choice, 2026-10-26). setupSteps is pure (the admin Users screen uses it too, with the
// same facts read across users); loadSetupFacts reads one user's facts, counts and flags only, never values.
import { addDays } from '../metrics/stats.js';

export const SETUP_STEPS = ['goals', 'profile', 'data', 'ai', 'firstResult'];
const OPTIONAL = new Set(['ai']);

/** The Sunday the next weekly review is written for the week before it (a Sunday today counts until the review exists). */
export function nextReviewDay(today) {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, weekday === 0 ? 0 : 7 - weekday);
}

/** Plain words for a failed Workout Log sync: never the error's own text (it can name sheets or tabs). */
export function sheetProblem(error) {
  const e = String(error ?? '');
  if (!e) return null;
  if (/permission|forbidden|403|invalid_grant|unauthorized|401/i.test(e)) return "Health Review can't open your sheet anymore: reconnect Google Sheets in Settings.";
  if (/not found|404|Requested entity/i.test(e)) return "Your sheet wasn't found: set it again in Settings.";
  if (/year tab|tab named/i.test(e)) return 'Your sheet needs a tab named with the year, like 2026: see the Workout Log guide.';
  return 'The last Workout Log sync failed. Try Sync now on Home, or see the Workout Log guide.';
}

/**
 * The checklist from one user's facts.
 * @param {object} f  see loadSetupFacts
 * @param {{ today: string }} o
 * @returns {{ steps: object[], doneCount: number, total: number, complete: boolean, hidden: boolean }}
 */
export function setupSteps(f, { today }) {
  const apple = f.apple ?? {};
  const sheet = f.sheet ?? {};
  const manual = f.manual ?? {};
  const appleData = (apple.days ?? 0) + (apple.workouts ?? 0) > 0;
  const manualData = (manual.checkins ?? 0) + (manual.appWorkouts ?? 0) + (manual.meds ?? 0) + (manual.labs ?? 0) + (manual.drinks ?? 0) > 0;
  const sheetData = (sheet.liftingDays ?? 0) > 0;
  const anyData = appleData || manualData || sheetData;
  const dismissed = new Set(f.dismissed ?? []);
  const ways = {
    appleHealth: { chosen: Boolean(f.chosen?.appleHealth), ready: Boolean(f.owner || apple.token), received: appleData,
      firstPost: apple.firstPost ?? null, lastPost: apple.lastPost ?? null, days: apple.days ?? 0, workouts: apple.workouts ?? 0 },
    workoutLog: { chosen: Boolean(f.chosen?.workoutLog), ready: Boolean(f.owner || sheet.sheetSet), connected: Boolean(f.owner || sheet.connected),
      lastSync: sheet.lastSync ?? null, tabsRead: sheet.tabsRead ?? null, liftingDays: sheet.liftingDays ?? 0, problem: sheetProblem(sheet.error) },
    manual: { chosen: f.chosen?.manual !== false, checkins: manual.checkins ?? 0, workouts: manual.appWorkouts ?? 0, meds: manual.meds ?? 0,
      labs: manual.labs ?? 0, drinks: manual.drinks ?? 0 },
  };
  const firstLink = manual.checkins || appleData ? '#health' : (manual.appWorkouts || sheetData) ? '#training' : '#today';
  const steps = [
    { id: 'goals', done: Boolean(f.goalsSet) },
    { id: 'profile', done: Boolean(f.profileSet), zone2Set: Boolean(f.zone2Set) },
    { id: 'data', done: ways.appleHealth.ready || ways.workoutLog.ready || manualData, ways },
    { id: 'ai', done: Boolean(f.ai) },
    { id: 'firstResult', done: anyData, firstDataDate: f.firstDataDate ?? null, link: firstLink,
      nextReview: f.ai ? nextReviewDay(today) : null, needsAi: !f.ai },
  ].map((s) => ({ ...s, optional: OPTIONAL.has(s.id), dismissed: !s.done && dismissed.has(s.id) }));
  const doneCount = steps.filter((s) => s.done).length;
  const settled = steps.every((s) => s.done || s.dismissed);
  return { steps, doneCount, total: steps.length, complete: Boolean(f.hidden) || settled, hidden: Boolean(f.hidden) };
}

const json = (text, fallback) => { try { return JSON.parse(text ?? '') ?? fallback; } catch { return fallback; } };

/**
 * One user's setup facts, read on their scoped database (every statement names user_id = @uid).
 * @param {object} db  a scoped database (db/scope.js)
 * @param {{ owner: boolean, chosen: object, ai: boolean, appleToken: boolean, sheetConnected: boolean }} o
 */
export function loadSetupFacts(db, { owner, chosen, ai, appleToken, sheetConnected }) {
  const one = (sql, ...args) => db.prepare(sql).pluck().get(...args);
  const setting = (key) => one('SELECT value FROM settings WHERE user_id = @uid AND key = ?', key) ?? null;
  const lastSync = db.prepare("SELECT status, finished_at, summary FROM runs WHERE user_id = @uid AND name = 'sync' AND status IN ('ok', 'error') ORDER BY started_at DESC, id DESC LIMIT 1").get();
  const syncSummary = json(lastSync?.summary, {});
  const firstDates = [
    one('SELECT MIN(date) FROM daily_metrics WHERE user_id = @uid'),
    one('SELECT MIN(date) FROM checkins WHERE user_id = @uid'),
    one('SELECT MIN(date) FROM strength_exercises WHERE user_id = @uid'),
    one('SELECT MIN(date) FROM drinking_days WHERE user_id = @uid'),
  ].filter(Boolean).sort();
  return {
    owner,
    chosen,
    ai,
    goalsSet: Boolean(setting('goal_primary')),
    profileSet: ['birth_year', 'sex', 'height_in'].every((k) => setting(k)),
    zone2Set: Boolean(setting('zone2_low_bpm') && setting('zone2_high_bpm')),
    apple: {
      token: appleToken,
      firstPost: one("SELECT MIN(received_at) FROM ingest_log WHERE user_id = @uid AND result = 'ok'") ?? null,
      lastPost: one("SELECT MAX(received_at) FROM ingest_log WHERE user_id = @uid AND result = 'ok'") ?? null,
      days: one('SELECT COUNT(*) FROM daily_metrics WHERE user_id = @uid'),
      workouts: one('SELECT COUNT(*) FROM workout_sessions WHERE user_id = @uid'),
      latestDay: one('SELECT MAX(date) FROM daily_metrics WHERE user_id = @uid') ?? null,
    },
    sheet: {
      connected: sheetConnected,
      sheetSet: Boolean(setting('workout_log_sheet_id')),
      lastSync: lastSync?.status === 'ok' ? lastSync.finished_at : null,
      tabsRead: lastSync?.status === 'ok' ? syncSummary.counts?.workout_log?.tabsRead ?? null : null,
      liftingDays: one('SELECT COUNT(DISTINCT date) FROM strength_exercises WHERE user_id = @uid AND tab_year <> 0'),
      error: lastSync?.status === 'error' ? syncSummary.error ?? 'failed' : null,
    },
    manual: {
      checkins: one('SELECT COUNT(*) FROM checkins WHERE user_id = @uid'),
      lastCheckin: one('SELECT MAX(date) FROM checkins WHERE user_id = @uid') ?? null,
      appWorkouts: one('SELECT COUNT(DISTINCT date) FROM strength_exercises WHERE user_id = @uid AND tab_year = 0'),
      meds: one('SELECT COUNT(*) FROM medications WHERE user_id = @uid'),
      labs: one('SELECT COUNT(*) FROM lab_results WHERE user_id = @uid'),
      drinks: one('SELECT COUNT(*) FROM drinking_days WHERE user_id = @uid'),
    },
    firstDataDate: firstDates[0] ?? null,
    dismissed: json(setting('setup_dismissed'), []).filter((s) => SETUP_STEPS.includes(s)),
    hidden: setting('setup_hidden') === '1',
  };
}
