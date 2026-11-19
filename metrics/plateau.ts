// Plateau detection for primary lifts (pure). Each lift (one canonical exercise and implement, so barbell and
// dumbbell versions never mix) is compared within one rep range, because MAPS phases change rep ranges:
//   1-5 and 6-12 reps: the session's best estimated 1-rep max (Epley: load x (1 + reps / 30))
//   13+ reps: the heaviest load lifted for 13 or more reps (estimated maxes are unreliable that high)
//   bodyweight lifts with no added load (pullups): the most reps in one set
// Deload sessions, and a lift's first session back after 21+ days without it, are left out. As of a date:
// recent is the last 42 days, baseline the 84 before; progressing at +2.5% or more, regressing at -5% or
// worse, stalled in between; at least 4 recent and 2 baseline sessions in the range, else not enough data;
// a range trained recently but not in the baseline is a new rep range (usually a phase change), never a stall.
import { addDays, daysBetween, round } from './stats.ts';
import { totalLbs, performed } from './strength.ts';
import type { Row } from './stats.ts';

type Status = 'regressing' | 'stalled' | 'progressing' | 'new_rep_range' | 'not_enough_data' | 'not_trained';
interface Best { date: string, range: string, value: number }

export const RECENT_DAYS = 42;
export const BASELINE_DAYS = 84;
export const RETURN_GAP_DAYS = 21;
export const PROGRESS_PCT = 2.5;
export const REGRESS_PCT = -5;
const MIN_RECENT = 4;
const MIN_BASELINE = 2;
const ORDER: Status[] = ['regressing', 'stalled', 'progressing', 'new_rep_range', 'not_enough_data', 'not_trained'];

export const rangeOf = (reps: number): string => (reps <= 5 ? '1-5' : reps <= 12 ? '6-12' : '13+');
export const epley = (load: number, reps: number): number => round(load * (1 + reps / 30), 0);
const weekStart = (d: string): string => addDays(d, -new Date(`${d}T00:00:00Z`).getUTCDay()); // Sunday-start weeks ending Saturday

/** Session bests for one lift: [{ date, range, value }], deloads and returns from a break left out. */
function sessionBests(sets: Row[], measure: 'reps' | 'load', phases: Map<string, string> | undefined): Best[] {
  const byDate = new Map<string, Row[]>();
  for (const s of sets) {
    const list = byDate.get(s.date) ?? [];
    byDate.set(s.date, list);
    list.push(s);
  }
  const out: Best[] = [];
  let prev: string | null = null;
  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date) as Row[];
    const returning = prev && daysBetween(prev, date) >= RETURN_GAP_DAYS;
    prev = date;
    const deload = phases?.get(date) === 'Deload' || day.some((s) => /deload/i.test(s.workout ?? ''));
    if (returning || deload) continue;
    const best = new Map<string, number>();
    for (const s of day) {
      if (s.reps == null || s.reps < 1) continue;
      let range: string;
      let value: number;
      if (measure === 'reps') {
        range = 'reps';
        value = s.reps;
      } else {
        const load = totalLbs(s);
        if (load == null || load <= 0) continue;
        range = rangeOf(s.reps);
        value = range === '13+' ? round(load, 0) : epley(load, s.reps);
      }
      if (!best.has(range) || value > (best.get(range) as number)) best.set(range, value);
    }
    for (const [range, value] of best) out.push({ date, range, value });
  }
  return out;
}

/**
 * sets: set rows with date, canonical_id, canonical_name, implement, weight_lbs, per_hand, reps, workout, is_primary
 * (other rows are ignored); phases: the stored session phase by date.
 */
export function liftProgress(sets: Row[], asOf: string, { phases }: { phases?: Map<string, string> } = {}) {
  const lifts = new Map<string, Row[]>();
  for (const s of sets) {
    if (!s.is_primary || !s.canonical_id || s.date > asOf || !performed(s)) continue;
    const list = lifts.get(s.canonical_id) ?? [];
    lifts.set(s.canonical_id, list);
    list.push(s);
  }
  const recentFrom = addDays(asOf, -(RECENT_DAYS - 1));
  const baseFrom = addDays(recentFrom, -BASELINE_DAYS);
  const out: any[] = [];
  for (const [id, liftSets] of lifts) {
    const withReps = liftSets.filter((s) => s.reps != null);
    const loaded = withReps.filter((s) => (totalLbs(s) ?? 0) > 0);
    const measure: 'reps' | 'load' = loaded.length * 2 < withReps.length ? 'reps' : 'load';
    const bests = sessionBests(measure === 'reps' ? withReps : loaded, measure, phases);
    const recent = bests.filter((b) => b.date >= recentFrom);
    const lastSession: string = liftSets.map((s) => s.date).sort().at(-1);
    const base = { id, name: liftSets.find((s) => s.canonical_name)?.canonical_name ?? liftSets[0].exercise, implement: liftSets[0].implement ?? null,
      measure, lastSession, phase: phases?.get(lastSession) ?? null };
    if (!recent.length) {
      out.push({ ...base, status: 'not_trained', range: null, recentBest: null, baselineBest: null, changePct: null,
        recentSessions: 0, baselineSessions: 0, record: null, weeksSinceRecord: null, trend: [] });
      continue;
    }
    // The range used most in the recent window (ties go to the most recent session's range).
    const counts = new Map<string, number>();
    for (const b of recent) counts.set(b.range, (counts.get(b.range) ?? 0) + 1);
    const latest = recent[recent.length - 1].range;
    const range = [...counts].sort((a, b) => b[1] - a[1] || (a[0] === latest ? -1 : b[0] === latest ? 1 : 0))[0][0];
    const inRange = bests.filter((b) => b.range === range);
    const r = inRange.filter((b) => b.date >= recentFrom);
    const bl = inRange.filter((b) => b.date >= baseFrom && b.date < recentFrom);
    const recentBest = Math.max(...r.map((b) => b.value));
    const baselineBest = bl.length ? Math.max(...bl.map((b) => b.value)) : null;
    const changePct = baselineBest ? round(((recentBest - baselineBest) / baselineBest) * 100, 1) : null;
    let status: Status;
    if (!bl.length) status = 'new_rep_range';
    else if (r.length < MIN_RECENT || bl.length < MIN_BASELINE) status = 'not_enough_data';
    else if ((changePct as number) >= PROGRESS_PCT) status = 'progressing';
    else if ((changePct as number) <= REGRESS_PCT) status = 'regressing';
    else status = 'stalled';
    const recordValue = Math.max(...inRange.map((b) => b.value));
    const recordDate = (inRange.find((b) => b.value === recordValue) as Best).date;
    const trendFrom = addDays(weekStart(asOf), -25 * 7);
    const weekly = new Map<string, number>();
    for (const b of inRange.filter((x) => x.date >= trendFrom)) {
      const k = weekStart(b.date);
      if (!weekly.has(k) || b.value > (weekly.get(k) as number)) weekly.set(k, b.value);
    }
    out.push({
      ...base, status, range, recentBest, baselineBest, changePct, recentSessions: r.length, baselineSessions: bl.length,
      record: { value: recordValue, date: recordDate }, weeksSinceRecord: Math.floor(daysBetween(recordDate, asOf) / 7),
      trend: [...weekly].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value })),
    });
  }
  return out.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
}

/** The weekly review's view: recently trained lifts only, without the trend points. */
export function liftsForReview(sets: Row[], weekEnd: string, options?: { phases?: Map<string, string> }) {
  return liftProgress(sets, weekEnd, options).filter((l) => l.status !== 'not_trained').map(({ trend, ...l }) => l);
}
