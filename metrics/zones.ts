// Cardio minutes by heart rate zone (pure). Zones come from the owner's saved tops (settings zone2_low_bpm, zone2_high_bpm,
// zone3_high_bpm, zone4_high_bpm): Zone 1 is below Zone 2, each later zone starts one above the zone before, so there is
// never a gap, and Zone 5 is above Zone 4's top. Unset tops of Zones 3 and 4 take their age defaults
// (server/public/zone-defaults.js: Zones 3 to 5 split the span from Zone 2's top to 208 - 0.7 x age, birth year from the
// profile). Time in zone comes from Health Auto Export's per-minute heart rate (workout_hr_samples): each sample counts
// one minute in the zone of its average.
// Workout minutes with no sample (gaps, or workouts from before the JSON export) are "no heart rate detail", never
// guessed from the workout's average.
import { addDays, windows } from './stats.ts';
import type { Row, Window } from './stats.ts';
import { sessionKind, minutesOf } from './cardio.ts';
import { maxHrFor, upperTops } from '../server/public/zone-defaults.js';

/** One zone's whole-bpm range; Zone 1 has no low and Zone 5 no high. */
export interface Zone { zone: number, low: number | null, high: number | null }
export interface ZoneBounds { maxHr: number | null, custom: { zone3: boolean, zone4: boolean }, zones: Zone[] }

/** Null without a Zone 2 range, or without a birth year when Zone 3's or Zone 4's top is not set. */
export function zoneBounds({ zone2Low, zone2High, zone3High = null, zone4High = null, birthYear, year }: {
  zone2Low?: number | null, zone2High?: number | null, zone3High?: number | null, zone4High?: number | null,
  birthYear?: number | null, year: number,
}): ZoneBounds | null {
  if (!(zone2Low != null && zone2Low > 0) || !(zone2High != null && zone2High >= zone2Low)) return null;
  const maxHr = maxHrFor(birthYear, year);
  const tops = upperTops({ maxHr, zone2High, zone3High: zone3High || null, zone4High: zone4High || null });
  if (!tops) return null;
  const { zone3High: t3, zone4High: t4 } = tops;
  return {
    maxHr,
    custom: { zone3: Boolean(zone3High), zone4: Boolean(zone4High) },
    zones: [
      { zone: 1, low: null, high: zone2Low - 1 },
      { zone: 2, low: zone2Low, high: zone2High },
      { zone: 3, low: zone2High + 1, high: t3 },
      { zone: 4, low: t3 + 1, high: t4 },
      { zone: 5, low: t4 + 1, high: null },
    ],
  };
}

/** The zone (1 to 5) of a heart rate; bounds are inclusive on whole bpm, so 125.5 over a Zone 2 top of 125 is Zone 3. */
export function zoneOf(bpm: number, bounds: ZoneBounds): number {
  // Zones 2 to 4 always have both ends (zoneBounds).
  const z = bounds.zones as { low: number, high: number }[];
  if (bpm < z[1].low) return 1;
  if (bpm <= z[1].high) return 2;
  if (bpm <= z[2].high) return 3;
  if (bpm <= z[3].high) return 4;
  return 5;
}

/**
 * Cardio minutes per bucket, split by zone.
 * sessions: workout_sessions rows (type, start, end, duration_sec); samples: workout_hr_samples rows (type, start,
 * avg_bpm); bounds from zoneBounds, null putting every minute under noDetail; buckets: inclusive date ranges, in order.
 * zones[0] is Zone 1; total = zones + noDetail.
 */
export function cardioZones({ sessions, samples, bounds, buckets }: {
  sessions: Row[], samples: Row[], bounds: ZoneBounds | null, buckets: Window[],
}): { from: string, to: string, total: number, zones: number[], noDetail: number }[] {
  const byWorkout = new Map<string, number[]>();
  for (const s of samples) {
    const key = `${s.type}|${s.start}`;
    const list = byWorkout.get(key) ?? [];
    list.push(s.avg_bpm);
    byWorkout.set(key, list);
  }
  return buckets.map(({ from, to }) => {
    const zones = [0, 0, 0, 0, 0];
    let noDetail = 0;
    for (const s of sessions) {
      const day = s.start.slice(0, 10);
      if (day < from || day > to || sessionKind(s.type) !== 'cardio') continue;
      const hr = bounds ? byWorkout.get(`${s.type}|${s.start}`) ?? [] : [];
      if (bounds) for (const bpm of hr) zones[zoneOf(bpm, bounds) - 1] += 1;
      noDetail += Math.max(0, Math.round(minutesOf(s)) - hr.length);
    }
    return { from, to, total: zones.reduce((a, b) => a + b, 0) + noDetail, zones, noDetail };
  });
}

/**
 * Day buckets for the last `days` days ending today, `weeks` Sunday-to-Saturday weeks ending with this one, or the
 * calendar months overlapping the last `monthsOver` days (whole months from the 1st; the current month runs to today).
 */
export function zoneBuckets(today: string, { days = null, weeks = null, monthsOver = null }: { days?: number | null, weeks?: number | null, monthsOver?: number | null }): Window[] {
  if (days) return Array.from({ length: days }, (_, i) => addDays(today, i - days + 1)).map((d) => ({ from: d, to: d }));
  if (monthsOver) {
    const out: Window[] = [];
    let first = `${addDays(today, 1 - monthsOver).slice(0, 7)}-01`;
    while (first <= today) {
      const [y, m] = first.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const last = addDays(next, -1);
      out.push({ from: first, to: last < today ? last : today });
      first = next;
    }
    return out;
  }
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 Sunday
  const lastSat = addDays(today, 6 - dow);
  const n = weeks ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const to = addDays(lastSat, -7 * (n - 1 - i));
    return { from: addDays(to, -6), to };
  });
}

/**
 * The weekly review's heart rate zones: the review week's cardio minutes per zone and the 28-day baseline's weekly
 * average (each whole-minute figure rounded on its own), with the zone bounds. Null without bounds or with no cardio in
 * either window.
 */
export function weekZones({ sessions, samples, bounds, weekEnd }: { sessions: Row[], samples: Row[], bounds: ZoneBounds | null, weekEnd: string }) {
  if (!bounds) return null;
  const w = windows(weekEnd);
  const [week, base] = cardioZones({ sessions, samples, bounds, buckets: [w.week, w.baseline] });
  if (!week.total && !base.total) return null;
  const perWeek = (n: number): number => Math.round(n / 4); // the baseline is 28 days
  return {
    zones: bounds.zones,
    maxHr: bounds.maxHr,
    week: { minutes: week.zones, noDetail: week.noDetail, total: week.total },
    baselineWeeklyAvg: { minutes: base.zones.map(perWeek), noDetail: perWeek(base.noDetail), total: perWeek(base.total) },
  };
}
