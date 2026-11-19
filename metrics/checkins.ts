// Check-ins: the week's daily scores against the 28-day baseline, body measurements, and how
// readiness tracks recovery. v1 weekly rows count as one point each (their date is the week's end).
import { mean, sd, round, inRange, windows, addDays, pearson } from './stats.ts';
import { trend } from './recovery.ts';
import type { Row } from './stats.ts';

export const SCALES = ['readiness', 'energy', 'mood', 'stress', 'nutrition'];
const MIN_BASELINE_ENTRIES = 7; // a scale's trend needs a week of baseline entries and 3 in the week
const BODY: Record<string, number> = { weight_lbs: 1, body_fat_pct: 1, muscle_mass_lbs: 1, visceral_fat: 0 };

/**
 * rows: checkins rows; metrics: daily_metrics rows (for readiness against HRV and sleep).
 */
export function checkins(rows: Row[], metrics: Row[], weekEnd: string) {
  const w = windows(weekEnd);
  const week = rows.filter((r) => inRange(r.date, w.week.from, w.week.to));
  const base = rows.filter((r) => inRange(r.date, w.baseline.from, w.baseline.to));

  const scales: Record<string, unknown> = {};
  for (const key of SCALES) {
    const wv = week.map((r) => r[key]).filter((v) => v != null);
    const bv = base.map((r) => r[key]).filter((v) => v != null);
    const wm = mean(wv);
    const bm = mean(bv);
    scales[key] = {
      entries: wv.length,
      mean: round(wm, 1),
      min: wv.length ? Math.min(...wv) : null,
      max: wv.length ? Math.max(...wv) : null,
      baselineEntries: bv.length,
      baselineMean: round(bm, 1),
      changeVsBaseline: wm !== null && bm !== null ? round(wm - bm, 1) : null,
      trend: trend(wm, wv.length, bm, sd(bv), bv.length, { minBase: MIN_BASELINE_ENTRIES }),
    };
  }

  // Body: the latest measurement up to the week's end, compared with the latest one at least 28 days older.
  const body: Record<string, unknown> = {};
  for (const [key, d] of Object.entries(BODY)) {
    const series = rows
      .filter((r) => r[key] != null && r.date <= weekEnd)
      .map((r): { date: string, value: number } => ({ date: r.body_measured_on ?? r.date, value: r[key] }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const latest = series[series.length - 1] ?? null;
    const older = latest ? [...series].reverse().find((p) => p.date <= addDays(latest.date, -28)) ?? null : null;
    body[key] = {
      latest: latest ? round(latest.value, d) : null,
      latestDate: latest?.date ?? null,
      change: latest && older ? round(latest.value - older.value, d) : null,
      comparedWith: older?.date ?? null,
    };
  }

  // Same-day readiness against overnight HRV and sleep, daily check-ins in the last 90 days.
  const byDate = new Map<string, Row>(metrics.map((m) => [m.date, m]));
  const daily = rows.filter((r) => r.cadence === 'daily' && r.readiness != null && inRange(r.date, w.long.from, w.long.to));
  const pairs = (key: string) => daily.map((r): [number, unknown] => [r.readiness, byDate.get(r.date)?.[key]]).filter((p): p is [number, number] => typeof p[1] === 'number');
  const correlation = (key: string) => {
    const p = pairs(key);
    return { pairs: p.length, r: round(pearson(p), 2) };
  };

  return {
    week: { entries: week.length, dailyEntries: week.filter((r) => r.cadence === 'daily').length },
    scales,
    body,
    readinessCorrelation90d: { hrv_ms: correlation('hrv_ms'), sleep_total_hr: correlation('sleep_total_hr') },
  };
}
