// Data checks run after every sync (pure). They catch the kinds of problems that went unnoticed before: an Apple
// Health export that stopped or skipped days, a partial day kept instead of the full one, workouts not exported,
// a workout duration longer than the workout (the 3-hour shift coming back) and impossible values. Findings name
// dates and counts only. Today is never expected to be complete.
import { addDays, daysBetween } from './stats.js';

export const LOOKBACK_DAYS = 14;
export const PARTIAL_SHARE = 0.25; // steps under a quarter of the 28-day median look like a partial export
export const MEDIAN_DAYS = 28;
export const MIN_MEDIAN_DAYS = 10;
const SPAN_SLACK_SEC = 120;
const STRENGTH_TYPES = /strength|core|functional|high intensity|hiit|cross training/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const list = (dates) => dates.map(short).join(', ');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Days from `from` to `to` inclusive. */
function days(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Days whose steps are under a quarter of the median of the 28 days before them (at least 10 of those days logged).
 * @param {Array<{date: string, steps?: number|null}>} daily
 */
export function partialDays(daily, from, to) {
  const steps = new Map(daily.filter((r) => r.steps !== null && r.steps !== undefined).map((r) => [r.date, r.steps]));
  return days(from, to).filter((d) => {
    if (!steps.has(d)) return false;
    const before = days(addDays(d, -MEDIAN_DAYS), addDays(d, -1)).filter((x) => steps.has(x)).map((x) => steps.get(x));
    return before.length >= MIN_MEDIAN_DAYS && steps.get(d) < PARTIAL_SHARE * median(before);
  });
}

/**
 * @param {object} input
 * @param {Array<object>} input.daily  daily_metrics rows (date, steps, resting_hr, sleep_total_hr, exercise_min), at least 42 days
 * @param {Array<object>} input.sessions  workout_sessions rows (type, start, end, duration_sec) for the last 14 days or more
 * @param {string[]} input.liftingDays  Workout Log days with performed sets
 * @param {string} input.today
 * @returns {Array<{kind: string, severity: 'warn'|'info', dates: string[], message: string}>}
 */
export function dataChecks({ daily = [], sessions = [], liftingDays = [], today }) {
  const yesterday = addDays(today, -1);
  const from = addDays(today, -LOOKBACK_DAYS);
  const have = new Set(daily.map((r) => r.date));
  const out = [];
  const add = (kind, severity, dates, message) => out.push({ kind, severity, dates, message });

  const latest = daily.map((r) => r.date).filter((d) => d <= today).sort().at(-1) ?? null;
  if (!latest) add('health_stale', 'warn', [], 'No Apple Health data at all. Check the Health Auto Export automation and the sync.');
  else if (latest < yesterday) {
    const missing = daysBetween(latest, yesterday);
    add('health_stale', 'warn', [latest], `No Apple Health data after ${short(latest)} (${plural(missing, 'day')} missing so far). Check the Health Auto Export automation.`);
  }

  // Missing days between the first and latest health days (days before the first row are not gaps).
  const first = daily.map((r) => r.date).sort()[0];
  const gaps = latest ? days(from, yesterday).filter((d) => d > first && d < latest && !have.has(d)) : [];
  if (gaps.length) add('health_gap', 'warn', gaps, `No Apple Health data on ${list(gaps)}.`);

  const partial = partialDays(daily, from, yesterday);
  if (partial.length) {
    add('partial_day', 'warn', partial, `${list(partial)} ${partial.length === 1 ? 'looks' : 'look'} like a partial Apple Health export (steps under a quarter of your usual day).`);
  }

  const watched = new Set(sessions.filter((s) => STRENGTH_TYPES.test(s.type ?? '')).map((s) => s.start.slice(0, 10)));
  const unwatched = [...new Set(liftingDays)].filter((d) => d >= from && d <= yesterday && !watched.has(d)).sort();
  if (unwatched.length) {
    add('workouts_missing', 'info', unwatched, `Lifting logged with no Apple Watch strength workout on ${list(unwatched)}. Fine if you didn't wear the watch; otherwise check the Workout Sessions export.`);
  }

  const long = sessions.filter((s) => s.duration_sec !== null && s.duration_sec !== undefined
    && s.duration_sec > (Date.parse(`${s.end}Z`) - Date.parse(`${s.start}Z`)) / 1000 + SPAN_SLACK_SEC);
  if (long.length) {
    const dates = [...new Set(long.map((s) => s.start.slice(0, 10)))].sort();
    add('duration_over_span', 'warn', dates, `${plural(long.length, 'workout')} (${list(dates)}) ${long.length === 1 ? 'is' : 'are'} stored longer than ${long.length === 1 ? 'its' : 'their'} start-to-end time. The Duration time shift may be back.`);
  }

  const odd = daily.filter((r) => r.date >= from && r.date <= today && (
    (r.resting_hr != null && (r.resting_hr < 30 || r.resting_hr > 120))
    || (r.sleep_total_hr != null && (r.sleep_total_hr < 0 || r.sleep_total_hr > 16))
    || (r.steps != null && r.steps < 0)
    || (r.exercise_min != null && (r.exercise_min < 0 || r.exercise_min > 1440)))).map((r) => r.date).sort();
  if (odd.length) add('implausible_value', 'warn', odd, `Impossible values on ${list(odd)} (resting heart rate, sleep, steps or exercise minutes out of range).`);

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
}

/**
 * The review week's data quality, for the weekly summary: days with no Apple Health row and days that look like a
 * partial export. Dates only.
 */
export function weekDataQuality(daily, weekFrom, weekTo) {
  const have = new Set(daily.map((r) => r.date));
  return { missingDays: days(weekFrom, weekTo).filter((d) => !have.has(d)), suspectedPartialDays: partialDays(daily, weekFrom, weekTo) };
}
