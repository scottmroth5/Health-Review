// Cardio minutes by heart rate zone (pure). Zones come from the owner's saved Zone 2 range (settings zone2_low_bpm and
// zone2_high_bpm): Zone 1 is below it, and Zones 3 to 5 split the span from its top to an age-based maximum heart rate
// (208 - 0.7 x age; birth year from the profile) evenly; above the maximum is Zone 5. Time in zone comes from Health
// Auto Export's per-minute heart rate (workout_hr_samples): each sample counts one minute in the zone of its average.
// Workout minutes with no sample (gaps, or workouts from before the JSON export) are "no heart rate detail", never
// guessed from the workout's average.
import { addDays, windows } from './stats.js';
import { sessionKind, minutesOf } from './cardio.js';

/**
 * @param {{ zone2Low?: number|null, zone2High?: number|null, birthYear?: number|null, year: number }} p
 * @returns {{ maxHr: number, zones: Array<{ zone: number, low: number|null, high: number|null }> } | null}
 *   null without a Zone 2 range or a birth year
 */
export function zoneBounds({ zone2Low, zone2High, birthYear, year }) {
  if (!(zone2Low > 0) || !(zone2High >= zone2Low) || !(birthYear > 1900)) return null;
  const maxHr = Math.round(208 - 0.7 * (year - birthYear));
  const top = Math.max(maxHr, zone2High + 3); // always room for Zones 3 to 5
  const step = (top - zone2High) / 3;
  const t3 = Math.round(zone2High + step);
  const t4 = Math.round(zone2High + 2 * step);
  return {
    maxHr,
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
export function zoneOf(bpm, bounds) {
  const z = bounds.zones;
  if (bpm < z[1].low) return 1;
  if (bpm <= z[1].high) return 2;
  if (bpm <= z[2].high) return 3;
  if (bpm <= z[3].high) return 4;
  return 5;
}

/**
 * Cardio minutes per bucket, split by zone.
 * @param {object} p
 * @param {Array<object>} p.sessions  workout_sessions rows (type, start, end, duration_sec)
 * @param {Array<{type, start, avg_bpm}>} p.samples  workout_hr_samples rows
 * @param {object|null} p.bounds  from zoneBounds; null puts every minute under noDetail
 * @param {Array<{from: string, to: string}>} p.buckets  inclusive date ranges, in order
 * @returns {Array<{ from, to, total, zones: number[], noDetail }>}  zones[0] is Zone 1; total = zones + noDetail
 */
export function cardioZones({ sessions, samples, bounds, buckets }) {
  const byWorkout = new Map();
  for (const s of samples) {
    const key = `${s.type}|${s.start}`;
    if (!byWorkout.has(key)) byWorkout.set(key, []);
    byWorkout.get(key).push(s.avg_bpm);
  }
  return buckets.map(({ from, to }) => {
    const zones = [0, 0, 0, 0, 0];
    let noDetail = 0;
    for (const s of sessions) {
      const day = s.start.slice(0, 10);
      if (day < from || day > to || sessionKind(s.type) !== 'cardio') continue;
      const hr = bounds ? byWorkout.get(`${s.type}|${s.start}`) ?? [] : [];
      for (const bpm of hr) zones[zoneOf(bpm, bounds) - 1] += 1;
      noDetail += Math.max(0, Math.round(minutesOf(s)) - hr.length);
    }
    return { from, to, total: zones.reduce((a, b) => a + b, 0) + noDetail, zones, noDetail };
  });
}

/**
 * Day buckets for the last `days` days ending today, `weeks` Sunday-to-Saturday weeks ending with this one, or the
 * calendar months overlapping the last `monthsOver` days (whole months from the 1st; the current month runs to today).
 */
export function zoneBuckets(today, { days = null, weeks = null, monthsOver = null }) {
  if (days) return Array.from({ length: days }, (_, i) => addDays(today, i - days + 1)).map((d) => ({ from: d, to: d }));
  if (monthsOver) {
    const out = [];
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
  return Array.from({ length: weeks }, (_, i) => {
    const to = addDays(lastSat, -7 * (weeks - 1 - i));
    return { from: addDays(to, -6), to };
  });
}

/**
 * The weekly review's heart rate zones: the review week's cardio minutes per zone and the 28-day baseline's weekly
 * average (each whole-minute figure rounded on its own), with the zone bounds. Null without bounds or with no cardio in
 * either window.
 */
export function weekZones({ sessions, samples, bounds, weekEnd }) {
  if (!bounds) return null;
  const w = windows(weekEnd);
  const [week, base] = cardioZones({ sessions, samples, bounds, buckets: [w.week, w.baseline] });
  if (!week.total && !base.total) return null;
  const perWeek = (n) => Math.round(n / 4); // the baseline is 28 days
  return {
    zones: bounds.zones,
    maxHr: bounds.maxHr,
    week: { minutes: week.zones, noDetail: week.noDetail, total: week.total },
    baselineWeeklyAvg: { minutes: base.zones.map(perWeek), noDetail: perWeek(base.noDetail), total: perWeek(base.total) },
  };
}
