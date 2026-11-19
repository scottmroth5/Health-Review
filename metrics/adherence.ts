// What the program calls for against what was logged, per lifting day of a program block. Pure: the caller loads the
// block's days (metrics/load.ts loadAdherenceInput), the catalog program, the dictionary lookup and substitutions.
//
// A day finds its catalog workout by program, stored phase and the number in its logged Workout name ("Foundation 2",
// "Foundational 1", "Day 3", "Workout 2"); a phase with a single workout matches every day. Focus, Trigger and
// Mobility sessions have no fixed list. Anything else is not matched, never guessed.
// Each exercise gets one status: as_called (same canonical exercise), swapped (one of the owner's swaps, or the fill
// rule: a cable or machine slot filled by a band, dumbbell or bodyweight exercise with the same movement pattern),
// changed (a missed exercise paired with one done instead with the same movement pattern), skipped, or added.
import { parseRange, parseReps } from './catalog.ts';
import type { Program, Span } from './catalog.ts';

type Status = 'as_called' | 'swapped' | 'changed' | 'skipped' | 'added';
type Lookup = (name: string) => { id: string | null, name: string | null, implement: string | null, pattern: string | null };
/** An exercise logged on the day, with at least one performed set. */
export interface LoggedExercise {
  name: string, canonical_id: string | null, canonicalName?: string | null, implement: string | null, pattern: string | null,
  sets: number, reps: number[],
}
interface Want { name: string, id: string | null, implement: string | null, pattern: string | null, sets: Span | null, reps: (Span & { unit: string }) | null }
type Did = LoggedExercise & { key: string };
/** The owner's swaps (config/substitutions.json). */
export interface Substitutions { swaps?: { prescribed: string, use: string[] }[], [more: string]: any }
/** A block's lifting day as metrics/load.ts loadAdherenceInput gives it. */
export interface AdherenceDay { date: string, week: number | null, phase: string | null, workout: string | null, exercises: LoggedExercise[] }
type Match = { status: 'matched', phase: any, workout: any } | { status: 'focus' | 'not_matched', reason: string };

export const STATUSES: Status[] = ['as_called', 'swapped', 'changed', 'skipped', 'added'];
const FILL_FROM = new Set<string | null>(['machine', 'cable']);
const FILL_WITH = new Set<string | null>(['band', 'dumbbell', 'bodyweight']);
const USUAL_LIMIT = 5;

const NUMBERED = /\b(?:foundation(?:al)?|day|workout)s?\s*(?:workout\s*)?(\d+)(?:\s*-\s*(\d+))?/i;

// A capital letter in place of the number ("Day A" is workout 1, "Day B" workout 2).
const LETTERED = /\b(?:[Ff]oundation(?:al)?|[Dd]ay|[Ww]orkout)\s+([A-H])\b/;

/**
 * The workout number in a name: "Symmetry Foundation 2 - Phase 4" -> { from: 2, to: 2 }; "Workouts 1-3" -> 1 to 3;
 * "Day B" -> 2.
 */
export function workoutNumber(name: string | null | undefined): { from: number, to: number } | null {
  const m = NUMBERED.exec(String(name ?? ''));
  if (!m) {
    const letter = LETTERED.exec(String(name ?? ''));
    if (!letter) return null;
    const n = letter[1].charCodeAt(0) - 64;
    return { from: n, to: n };
  }
  const from = Number(m[1]);
  // A range only in the catalog's own names ("Workouts 1-3"); a logged "Foundation 2 - Phase 4" is a single number.
  const to = m[2] !== undefined && /workouts\s*\d+\s*-\s*\d+/i.test(name as string) ? Number(m[2]) : from;
  return { from, to };
}

export const isFocusSession = (name: string | null | undefined): boolean => /\b(focus|trigger|mobility)\b/i.test(String(name ?? ''));

/**
 * The catalog workout a logged day was following.
 */
export function matchWorkout(day: { phase?: string | null, workout?: string | null }, program: Program | null | undefined): Match {
  if (isFocusSession(day.workout)) return { status: 'focus', reason: 'focus, trigger or mobility session (no fixed list)' };
  if (!program) return { status: 'not_matched', reason: 'program not in the catalog' };
  const phase = program.phases.find((p: any) => p.name.toLowerCase() === String(day.phase ?? '').toLowerCase());
  if (!phase) return { status: 'not_matched', reason: day.phase ? `no ${day.phase} in the catalog` : 'phase unknown' };
  const workouts: any[] = (phase.workouts ?? []).filter((w: any) => w.exercises?.length);
  if (!workouts.length) return { status: 'not_matched', reason: 'no workouts listed for the phase' };
  if (workouts.length === 1) return { status: 'matched', phase, workout: workouts[0] };
  const n = workoutNumber(day.workout);
  if (!n) return { status: 'not_matched', reason: day.workout ? 'no workout number in the name' : 'no workout name' };
  const workout = workouts.find((w) => {
    const c = workoutNumber(w.name);
    return c && n.from >= c.from && n.from <= c.to;
  });
  return workout ? { status: 'matched', phase, workout } : { status: 'not_matched', reason: `no workout ${n.from} in ${phase.name}` };
}

const rangeStatus = (n: number, r: Span | null): 'under' | 'over' | 'within' | null => (!r ? null : n < r.min ? 'under' : n > r.max ? 'over' : 'within');

/**
 * One day: the called-for exercises against the logged ones.
 * called: catalog exercises (phase sets and reps as defaults); logged: exercises with at least one performed set.
 */
export function compareSession({ called, logged, lookup, substitutions = {} }: {
  called: { name: string, sets?: string, reps?: string }[], logged: LoggedExercise[], lookup: Lookup, substitutions?: Substitutions,
}) {
  const swaps = new Map((substitutions.swaps ?? []).map((s) => [s.prescribed, new Set(s.use)]));
  const want = called.map((c): Want => {
    const d = lookup(c.name);
    return { name: d.name ?? c.name, id: d.id, implement: d.implement, pattern: d.pattern, sets: parseRange(c.sets), reps: parseReps(c.reps) };
  });
  const did: Did[] = logged.map((l) => ({ ...l, key: l.canonical_id ?? l.name.toLowerCase() }));
  const rows: AdherenceRow[] = [];
  const usedWant = new Set<number>();
  const usedDid = new Set<number>();
  const pair = (status: Status, test: (w: Want, d: Did) => unknown, reason?: string) => {
    want.forEach((w, i) => {
      if (usedWant.has(i)) return;
      const j = did.findIndex((d, k) => !usedDid.has(k) && test(w, d));
      if (j < 0) return;
      usedWant.add(i);
      usedDid.add(j);
      rows.push(row(status, w, did[j], reason));
    });
  };
  pair('as_called', (w, d) => w.id && w.id === d.canonical_id);
  pair('swapped', (w, d) => w.id && d.canonical_id && swaps.get(w.id)?.has(d.canonical_id), 'your swap');
  pair('swapped', (w, d) => FILL_FROM.has(w.implement) && FILL_WITH.has(d.implement) && w.pattern && w.pattern === d.pattern, 'fills the cable or machine slot');
  pair('changed', (w, d) => w.pattern && w.pattern === d.pattern);
  want.forEach((w, i) => { if (!usedWant.has(i)) rows.push(row('skipped', w, null)); });
  did.forEach((d, k) => { if (!usedDid.has(k)) rows.push(row('added', null, d)); });
  return rows;
}

export type AdherenceRow = ReturnType<typeof row>;

function row(status: Status, w: Want | null, d: Did | null, reason: string | null = null) {
  const span = w?.reps?.unit === 'reps' ? w.reps : null;
  const inRange = span && d?.reps.length
    ? d.reps.filter((r) => r >= span.min && r <= span.max).length : null;
  return {
    status,
    reason,
    called: w ? { name: w.name, sets: w.sets, reps: w.reps } : null,
    logged: d ? { name: d.canonicalName ?? d.name, sets: d.sets, reps: d.reps } : null,
    setsStatus: w && d ? rangeStatus(d.sets, w.sets) : null,
    repsInRange: inRange === null || !d ? null : { inRange, of: d.reps.length },
  };
}

const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
const top = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, USUAL_LIMIT).map(([what, times]) => ({ what, times }));

/**
 * A block's days, newest first, each matched and compared; the days grouped by block week; the usual changes across
 * the block; and how many days matched.
 * program: the catalog program, or null.
 */
export function blockAdherence({ days, program, lookup, substitutions = {} }: {
  days: AdherenceDay[], program: Program | null | undefined, lookup: Lookup, substitutions?: Substitutions,
}) {
  // A day's facts; a matched day adds its catalog workout, counts, sets and rows.
  const sessions: Record<string, any>[] = [];
  const swapsSeen = new Map<string, number>();
  const skipped = new Map<string, number>();
  const added = new Map<string, number>();
  const coverage = { days: days.length, matched: 0, focus: 0, notMatched: 0 };
  for (const day of [...days].sort((a, b) => b.date.localeCompare(a.date))) {
    const exercises = day.exercises.filter((e) => e.sets > 0);
    const m = matchWorkout(day, program);
    const base = { date: day.date, week: day.week, phase: day.phase, workout: day.workout, exercisesLogged: exercises.length };
    if (m.status !== 'matched') {
      coverage[m.status === 'focus' ? 'focus' : 'notMatched'] += 1;
      sessions.push({ ...base, match: m.status, reason: m.reason, setsLogged: exercises.reduce((s, e) => s + e.sets, 0) });
      continue;
    }
    coverage.matched += 1;
    const called = m.workout.exercises.map((e: any) => ({ name: e.name, sets: e.sets ?? m.phase.sets, reps: e.reps ?? m.phase.reps }));
    const rows = compareSession({ called, logged: exercises, lookup, substitutions });
    const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
    const calledRows = rows.filter((r) => r.called?.sets);
    for (const r of rows) {
      if ((r.status === 'swapped' || r.status === 'changed') && r.called && r.logged) count(swapsSeen, `${r.called.name} → ${r.logged.name}`);
      if (r.status === 'skipped' && r.called) count(skipped, r.called.name);
      if (r.status === 'added' && r.logged) count(added, r.logged.name);
    }
    sessions.push({
      ...base,
      match: 'matched',
      catalogWorkout: m.workout.name,
      catalogPhase: m.phase.name,
      counts,
      setsCalled: { min: calledRows.reduce((s, r) => s + (r.called?.sets as Span).min, 0), max: calledRows.reduce((s, r) => s + (r.called?.sets as Span).max, 0) },
      setsLogged: rows.reduce((s, r) => s + (r.logged?.sets ?? 0), 0),
      rows,
    });
  }
  const weeks: { week: number | null, sessions: Record<string, any>[] }[] = [];
  for (const s of sessions) {
    const last = weeks[weeks.length - 1];
    if (last && last.week === s.week) last.sessions.push(s);
    else weeks.push({ week: s.week, sessions: [s] });
  }
  return { coverage, weeks, usualChanges: { swaps: top(swapsSeen), skipped: top(skipped), added: top(added) } };
}

/**
 * The review week's part of a block's adherence, for the weekly summary: counts, sets, and the names of exercises the
 * owner logged instead of or on top of the program. The program's own exercise names (transcribed from the MAPS PDFs)
 * never appear, so nothing from the catalog leaves the machine. Null when the week has no lifting days in the block.
 * from and to: the week's first and last days; program: the block's program name.
 */
export function weekAdherence(result: ReturnType<typeof blockAdherence>, from: string, to: string, program: string) {
  const days = result.weeks.flatMap((w) => w.sessions).filter((s) => s.date >= from && s.date <= to);
  if (!days.length) return null;
  const matched = days.filter((s) => s.match === 'matched');
  const counts = Object.fromEntries(STATUSES.map((st) => [st, matched.reduce((n, s) => n + s.counts[st], 0)]));
  const tally = (statuses: string[]) => {
    const seen = new Map<string, number>();
    for (const s of matched) for (const r of s.rows) if (statuses.includes(r.status)) seen.set(r.logged.name, (seen.get(r.logged.name) ?? 0) + 1);
    return top(seen).map(({ what, times }) => ({ name: what, times }));
  };
  return {
    program,
    days: days.length,
    matched: matched.length,
    focus: days.filter((s) => s.match === 'focus').length,
    notMatched: days.filter((s) => s.match === 'not_matched').length,
    counts,
    setsLogged: matched.reduce((n, s) => n + s.setsLogged, 0),
    setsCalled: { min: matched.reduce((n, s) => n + s.setsCalled.min, 0), max: matched.reduce((n, s) => n + s.setsCalled.max, 0) },
    doneInstead: tally(['swapped', 'changed']),
    added: tally(['added']),
  };
}
