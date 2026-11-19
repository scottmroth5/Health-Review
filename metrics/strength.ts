// Strength from the Workout Log over the 28-day window v1 used, with the review week broken out.
// Only performed sets count: a set needs reps, time, distance or any set text, and a date no
// later than the week's end (the log also holds planned workouts with weights but no reps).
// "95ea" is logged per hand: total load is twice the logged weight; both are reported.
import { round, sum, inRange, windows } from './stats.ts';
import type { Row } from './stats.ts';
import { exerciseKey, exerciseName } from './exercises.ts';

export const performed = (s: Row): boolean => s.reps != null || s.duration_sec != null || s.distance_yd != null || (s.reps_text ?? '') !== '';
export const totalLbs = (s: Row): number | null => (s.weight_lbs == null ? null : s.weight_lbs * (s.per_hand ? 2 : 1));
export const volumeOf = (sets: Row[]): number => sum(sets.filter((s) => s.reps != null && totalLbs(s) != null).map((s) => s.reps * (totalLbs(s) as number)));

function sessionSummary(date: string, sets: Row[]) {
  const weighted = sets.filter((s) => totalLbs(s) != null);
  const top = weighted.length ? Math.max(...weighted.map((s) => totalLbs(s) as number)) : null;
  const atTop = weighted.filter((s) => totalLbs(s) === top);
  const topReps = atTop.map((s) => s.reps).filter((r) => r != null);
  const perHand = atTop.find((s) => s.per_hand);
  return {
    date,
    sets: sets.length,
    topLbs: round(top, 1),
    topPerHandLbs: perHand ? round(perHand.weight_lbs, 1) : null,
    topReps: topReps.length ? Math.max(...topReps) : null,
    volumeLbs: round(volumeOf(sets), 0),
  };
}

/**
 * sets: one row per set: date, exercise, set_no, weight_lbs, per_hand, band, bodyweight, reps, reps_text, duration_sec,
 * distance_yd.
 */
export function strength(sets: Row[], weekEnd: string) {
  const w = windows(weekEnd);
  const done = sets.filter((s) => inRange(s.date, w.strength.from, w.strength.to) && performed(s));
  const week = done.filter((s) => inRange(s.date, w.week.from, w.week.to));
  const before = done.filter((s) => s.date < w.week.from);

  const byExercise = new Map<string, { key: string, dates: Map<string, Row[]> }>();
  for (const s of done) {
    const key = exerciseKey(s); // canonical exercise, or spelling variants when unmapped (metrics/exercises.ts)
    const e = byExercise.get(key) ?? { key, dates: new Map<string, Row[]>() };
    byExercise.set(key, e);
    const list = e.dates.get(s.date) ?? [];
    e.dates.set(s.date, list);
    list.push(s);
  }

  const exercises = [...byExercise.values()].map((e) => {
    const dates = [...e.dates.keys()].sort();
    const first = sessionSummary(dates[0], e.dates.get(dates[0]) ?? []);
    const last = sessionSummary(dates[dates.length - 1], e.dates.get(dates[dates.length - 1]) ?? []);
    const two = dates.length >= 2;
    return {
      exercise: exerciseName([...e.dates.values()].flat() as { exercise: string, date: string }[]),
      sessions: dates.length,
      inWeek: dates.some((d) => d >= w.week.from),
      first,
      last,
      topLbsChange: two && first.topLbs != null && last.topLbs != null ? round(last.topLbs - first.topLbs, 1) : null,
      volumeChangeLbs: two ? round(last.volumeLbs - first.volumeLbs, 0) : null,
    };
  }).sort((a, b) => b.last.date.localeCompare(a.last.date) || a.exercise.localeCompare(b.exercise));

  const weekVolume = volumeOf(week);
  const prevWeeklyVolume = volumeOf(before) / 3;
  return {
    week: {
      days: new Set(week.map((s) => s.date)).size,
      exercises: new Set(week.map(exerciseKey)).size,
      sets: week.length,
      volumeLbs: round(weekVolume, 0),
      bandSets: week.filter((s) => s.band).length,
      bodyweightSets: week.filter((s) => s.bodyweight).length,
      timedSets: week.filter((s) => s.duration_sec != null).length,
    },
    previous3WeeksAvgVolumeLbs: round(prevWeeklyVolume, 0),
    volumeChangeVsPrevious3WeeksPct: prevWeeklyVolume ? round(((weekVolume - prevWeeklyVolume) / prevWeeklyVolume) * 100, 0) : null,
    days28: new Set(done.map((s) => s.date)).size,
    exercises,
  };
}
