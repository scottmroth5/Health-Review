// Training volume from the Workout Log: reps x total load (per-hand weights doubled), using the same
// rules as metrics/strength.js. Only performed sets on or before "today" count, so planned workouts
// in the log are left out. A day or week with no lifting is a real zero, not missing data.
// Sets with no weight to count (bands, bodyweight, timed, unparsed reps) are reported as set counts.
import { addDays, inRange, round, sum } from './stats.js';
import { performed, totalLbs, volumeOf } from './strength.js';
import { programsByDay, programSummary } from './programs.js';

const isWeighted = (s) => s.reps != null && totalLbs(s) != null;

/** Why a performed set adds no volume, or null when it does. */
export function unweightedKind(s) {
  if (isWeighted(s)) return null;
  if (s.band) return 'band';
  if (s.bodyweight) return 'bodyweight';
  if (s.duration_sec != null || s.distance_yd != null) return 'timed';
  return 'other';
}

const doneIn = (sets, { from, to }) => sets.filter((s) => inRange(s.date, from, to) && performed(s));

export function volumeTotals(sets, range) {
  const done = doneIn(sets, range);
  return {
    volumeLbs: round(volumeOf(done), 0),
    sets: done.length,
    weightedSets: done.filter(isWeighted).length,
    reps: sum(done.map((s) => s.reps).filter((r) => r != null)),
    liftingDays: new Set(done.map((s) => s.date)).size,
  };
}

export function unweightedCounts(sets, range) {
  const counts = { band: 0, bodyweight: 0, timed: 0, other: 0 };
  for (const s of doneIn(sets, range)) {
    const kind = unweightedKind(s);
    if (kind) counts[kind] += 1;
  }
  return counts;
}

/** Top exercises by volume in the range; spellings merge by trimmed, lowercased name. */
export function volumeByExercise(sets, range, top = 10) {
  const groups = new Map();
  for (const s of doneIn(sets, range)) {
    const key = s.exercise.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { exercise: s.exercise.trim(), sets: [] });
    groups.get(key).sets.push(s);
  }
  return [...groups.values()]
    .map((g) => ({ exercise: g.exercise, volumeLbs: round(volumeOf(g.sets), 0), sets: g.sets.length }))
    .filter((e) => e.volumeLbs > 0)
    .sort((a, b) => b.volumeLbs - a.volumeLbs || a.exercise.localeCompare(b.exercise))
    .slice(0, top);
}

const dow = (date) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
export const saturdayOnOrAfter = (date) => addDays(date, 6 - dow(date));
const monthStart = (date) => `${date.slice(0, 7)}-01`;
const nextMonth = (date) => {
  const d = new Date(`${monthStart(date)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The bucket periods covering from..to, each clipped to the range. Weeks end on Saturday. */
function periods(from, to, bucket) {
  const out = [];
  if (bucket === 'day') {
    for (let d = from; d <= to; d = addDays(d, 1)) out.push({ start: d, end: d, label: d });
  } else if (bucket === 'week') {
    for (let sat = saturdayOnOrAfter(from); addDays(sat, -6) <= to; sat = addDays(sat, 7)) {
      out.push({ start: addDays(sat, -6) < from ? from : addDays(sat, -6), end: sat > to ? to : sat, label: `Week ending ${sat}`, weekEnding: sat });
    }
  } else {
    for (let m = monthStart(from); m <= to; m = nextMonth(m)) {
      const last = addDays(nextMonth(m), -1);
      out.push({ start: m < from ? from : m, end: last > to ? to : last, label: `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`, month: m.slice(0, 7) });
    }
  }
  return out;
}

/** Volume per day, week (ending Saturday) or calendar month across the range, empty buckets included. */
export function volumeBuckets(sets, { from, to, bucket }) {
  const done = doneIn(sets, { from, to });
  return periods(from, to, bucket).map((p) => {
    const inside = done.filter((s) => inRange(s.date, p.start, p.end));
    return {
      ...p,
      volumeLbs: round(volumeOf(inside), 0),
      sets: inside.length,
      reps: sum(inside.map((s) => s.reps).filter((r) => r != null)),
      liftingDays: new Set(inside.map((s) => s.date)).size,
    };
  });
}

export const VIEWS = ['week', 'month', 'year', '2y', '5y', 'all'];

/** The first day of the month k months before the month of date. */
const monthsBack = (date, k) => {
  let m = monthStart(date);
  for (let i = 0; i < k; i++) m = monthStart(addDays(m, -1));
  return m;
};

/** Adds each bucket's training programs (by lifting day, gaps filled from nearby named days). */
function withPrograms(sets, buckets, range) {
  const liftingDates = [...new Set(doneIn(sets, range).map((s) => s.date))];
  const byDay = programsByDay(sets, liftingDates);
  return buckets.map((b) => ({ ...b, ...programSummary(liftingDates.filter((d) => inRange(d, b.start, b.end)), byDay) }));
}

/** Everything the training dashboard shows for one view, ending today. */
export function trainingView(sets, view, today) {
  let range;
  let previous = null;
  let bucket;
  if (view === 'week') {
    range = { from: addDays(today, -6), to: today };
    previous = { from: addDays(today, -13), to: addDays(today, -7) };
    bucket = 'day';
  } else if (view === 'month') {
    range = { from: addDays(today, -29), to: today };
    previous = { from: addDays(today, -59), to: addDays(today, -30) };
    bucket = 'day';
  } else if (view === 'year') {
    const from = addDays(saturdayOnOrAfter(today), -52 * 7 + 1); // 52 weeks, the current one included
    range = { from, to: today };
    previous = { from: addDays(from, -364), to: addDays(from, -1) };
    bucket = 'week';
  } else if (view === '2y' || view === '5y') {
    // The current month and the 23 (or 59) before it, one bar per month; compared with the same span before.
    const months = view === '2y' ? 24 : 60;
    const from = monthsBack(today, months - 1);
    range = { from, to: today };
    previous = { from: monthsBack(from, months), to: addDays(from, -1) };
    bucket = 'month';
  } else if (view === 'all') {
    const dates = sets.filter((s) => s.date <= today && performed(s)).map((s) => s.date).sort();
    range = { from: monthStart(dates[0] ?? today), to: today };
    bucket = 'month';
  } else {
    throw new Error(`Unknown view: ${view}`);
  }
  return {
    view,
    range,
    bucket,
    buckets: withPrograms(sets, volumeBuckets(sets, { ...range, bucket }), range),
    totals: volumeTotals(sets, range),
    previous: previous && { range: previous, totals: volumeTotals(sets, previous) },
    weeklyTotals: view === 'month' ? volumeBuckets(sets, { ...range, bucket: 'week' }) : null,
    byExercise: volumeByExercise(sets, range),
    unweighted: unweightedCounts(sets, range),
  };
}

/** Longer-term load for the weekly review: the last 12 weeks and the last 12 calendar months. */
export function volumeTrend(sets, weekEnd) {
  const weeks = volumeBuckets(sets, { from: addDays(weekEnd, -12 * 7 + 1), to: weekEnd, bucket: 'week' })
    .map((b) => ({ weekEnding: b.weekEnding, volumeLbs: b.volumeLbs, liftingDays: b.liftingDays }));
  let first = monthStart(weekEnd);
  for (let i = 0; i < 11; i++) first = monthStart(addDays(first, -1));
  const months = volumeBuckets(sets, { from: first, to: weekEnd, bucket: 'month' })
    .map((b) => ({ month: b.month, volumeLbs: b.volumeLbs, liftingDays: b.liftingDays, partial: b.end < addDays(nextMonth(b.start), -1) }));
  return { weeks, months };
}
