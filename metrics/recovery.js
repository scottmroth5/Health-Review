// Recovery and activity from daily_metrics: the week against the previous week and a 28-day baseline.
import { mean, sd, round, inRange, windows, addDays } from './stats.js';

/** Daily metrics reported, with the decimals each is rounded to. */
export const RECOVERY_METRICS = {
  hrv_ms: 0,
  resting_hr: 1,
  respiratory_rate: 1,
  sleep_total_hr: 1,
  sleep_deep_hr: 2,
  sleep_rem_hr: 2,
  sleep_core_hr: 1,
  sleep_awake_hr: 2,
  steps: 0,
  active_energy_kcal: 0,
  exercise_min: 0,
  stand_hours: 1,
  // Turned on in Health Auto Export 2026-10-15.
  cardio_recovery_bpm: 1,
  walking_hr_avg: 0,
  walking_speed_mph: 2,
  hr_avg: 0,
  wrist_temp_f: 1,
  physical_effort: 1,
  walking_asymmetry_pct: 1, // lower is more even
};

/**
 * Blood oxygen and breathing disturbances: the same week and baseline numbers, but no unusual-day flags (no high or low
 * labels, as with labs), and in the review only for physician discussion.
 */
export const NIGHT_BREATHING_METRICS = {
  spo2_pct: 1,
  breathing_disturbances: 1,
};

const MIN_BASELINE_DAYS = 14; // unusual-day flags need at least two weeks of baseline

/**
 * @param {Array<object>} rows  daily_metrics rows covering at least the baseline and week
 * @param {string} weekEnd
 */
export function recovery(rows, weekEnd) {
  const w = windows(weekEnd);
  const metrics = {};
  for (const [key, d] of Object.entries(RECOVERY_METRICS)) metrics[key] = weekStats(rows, w, key, d);

  // VO2 max changes slowly and is sparse: latest reading, and the change from the latest one at least 28 days older.
  const vo2 = rows.filter((r) => r.vo2max !== null && r.vo2max !== undefined && r.date <= weekEnd).sort((a, b) => a.date.localeCompare(b.date));
  const latest = vo2[vo2.length - 1] ?? null;
  const cutoff = latest ? addDays(latest.date, -28) : null;
  const older = latest ? [...vo2].reverse().find((r) => r.date <= cutoff) ?? null : null;
  metrics.vo2max = {
    latest: latest ? round(latest.vo2max, 1) : null,
    latestDate: latest?.date ?? null,
    change28d: latest && older ? round(latest.vo2max - older.vo2max, 1) : null,
    comparedWith: older?.date ?? null,
  };

  return metrics;
}

/** One daily metric's week against the previous week and the 28-day baseline; unusual days (2 SD) only when flagged. */
function weekStats(rows, w, key, d, { flagUnusual = true } = {}) {
  const pick = (range) => rows.filter((r) => inRange(r.date, range.from, range.to) && r[key] !== null && r[key] !== undefined);
  const week = pick(w.week);
  const prev = pick(w.prevWeek);
  const base = pick(w.baseline);
  const values = week.map((r) => r[key]);
  const weekMean = mean(values);
  const prevMean = mean(prev.map((r) => r[key]));
  const baseMean = mean(base.map((r) => r[key]));
  const baseSd = sd(base.map((r) => r[key]));

  let unusualDays = [];
  if (flagUnusual && base.length >= MIN_BASELINE_DAYS && baseSd) {
    unusualDays = week
      .filter((r) => Math.abs(r[key] - baseMean) > 2 * baseSd)
      .map((r) => ({ date: r.date, value: round(r[key], d), direction: r[key] > baseMean ? 'high' : 'low' }));
  }

  return {
    days: week.length,
    mean: round(weekMean, d),
    min: values.length ? round(Math.min(...values), d) : null,
    max: values.length ? round(Math.max(...values), d) : null,
    prevWeekMean: round(prevMean, d),
    changeVsPrevWeek: weekMean !== null && prevMean !== null ? round(weekMean - prevMean, d) : null,
    baselineDays: base.length,
    baselineMean: round(baseMean, d),
    changeVsBaseline: weekMean !== null && baseMean !== null ? round(weekMean - baseMean, d) : null,
    changeVsBaselinePct: weekMean !== null && baseMean ? round(((weekMean - baseMean) / baseMean) * 100, 0) : null,
    ...(flagUnusual ? { unusualDays } : {}),
  };
}

/** Blood oxygen and breathing disturbances for the weekly review (physician discussion only); null with no data. */
export function nightBreathing(rows, weekEnd) {
  const w = windows(weekEnd);
  const out = {};
  for (const [key, d] of Object.entries(NIGHT_BREATHING_METRICS)) {
    const stats = weekStats(rows, w, key, d, { flagUnusual: false });
    if (stats.days || stats.baselineDays) out[key] = stats;
  }
  return Object.keys(out).length ? out : null;
}
