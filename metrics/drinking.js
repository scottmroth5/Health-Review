// Drinking for the week and its relation to next-morning recovery. Alcohol totals never include CBD.
// A day with no row is unknown, not zero: only logged days (including logged zero days) count.
// Next-morning values come from the following day's daily_metrics row (Health Auto Export dates
// sleep and overnight HRV to the day you wake up).
import { mean, round, sum, inRange, windows, addDays, pearson } from './stats.js';

export const ALCOHOL_TYPES = ['beers', 'wine', 'bourbon', 'other'];
export const alcoholOf = (d) => sum(ALCOHOL_TYPES.map((t) => d[t] ?? 0));
const MIN_GROUP = 3;
const NEXT_MORNING = { hrv_ms: 0, resting_hr: 1, sleep_total_hr: 1 };

/**
 * @param {Array<object>} days     drinking_days rows
 * @param {Array<object>} metrics  daily_metrics rows (for next-morning comparisons)
 * @param {string} weekEnd
 */
export function drinking(days, metrics, weekEnd) {
  const w = windows(weekEnd);
  const week = days.filter((d) => inRange(d.date, w.week.from, w.week.to));
  const base = days.filter((d) => inRange(d.date, w.baseline.from, w.baseline.to));
  const drinkingDays = week.filter((d) => alcoholOf(d) > 0);
  const alcohol = week.map(alcoholOf);

  const moods = (key) => round(mean(drinkingDays.map((d) => d[key]).filter((v) => v != null)), 1);

  // Next-morning recovery over the last 90 days.
  const byDate = new Map(metrics.map((m) => [m.date, m]));
  const long = days.filter((d) => inRange(d.date, w.long.from, w.long.to));
  const nextMorning = {};
  for (const [key, d] of Object.entries(NEXT_MORNING)) {
    const after = (list) => list.map((day) => byDate.get(addDays(day.date, 1))?.[key]).filter((v) => typeof v === 'number');
    const onDrinking = after(long.filter((day) => alcoholOf(day) > 0));
    const onFree = after(long.filter((day) => alcoholOf(day) === 0));
    const enough = onDrinking.length >= MIN_GROUP && onFree.length >= MIN_GROUP;
    nextMorning[key] = {
      afterDrinkingDays: onDrinking.length,
      afterAlcoholFreeDays: onFree.length,
      meanAfterDrinking: enough ? round(mean(onDrinking), d) : null,
      meanAfterAlcoholFree: enough ? round(mean(onFree), d) : null,
      difference: enough ? round(mean(onDrinking) - mean(onFree), d) : null,
    };
  }
  const dosePairs = long
    .map((day) => [alcoholOf(day), byDate.get(addDays(day.date, 1))?.hrv_ms])
    .filter(([, hrv]) => typeof hrv === 'number');

  return {
    week: {
      loggedDays: week.length,
      unloggedDays: 7 - week.length,
      drinkingDays: drinkingDays.length,
      alcoholFreeDays: week.length - drinkingDays.length,
      totalDrinks: sum(alcohol),
      maxInOneDay: alcohol.length ? Math.max(...alcohol) : null,
      byType: Object.fromEntries(ALCOHOL_TYPES.map((t) => [t, sum(week.map((d) => d[t] ?? 0))])),
      cbdDrinks: sum(week.map((d) => d.cbd ?? 0)),
      moodBeforeMean: moods('mood_before'),
      moodAfterMean: moods('mood_after'),
    },
    baseline: {
      loggedDays: base.length,
      // Per 7 logged days, so unlogged days are not counted as zero.
      drinksPer7Days: base.length ? round((sum(base.map(alcoholOf)) / base.length) * 7, 1) : null,
    },
    nextMorning90d: nextMorning,
    drinksVsNextMorningHrvCorrelation90d: { pairs: dosePairs.length, r: round(pearson(dosePairs), 2) },
  };
}
