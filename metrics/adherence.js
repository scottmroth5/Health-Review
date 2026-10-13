// What the program calls for against what was logged, per lifting day of a program block. Pure: the caller loads the
// block's days (metrics/load.js loadAdherenceInput), the catalog program, the dictionary lookup and substitutions.
//
// A day finds its catalog workout by program, stored phase and the number in its logged Workout name ("Foundation 2",
// "Foundational 1", "Day 3", "Workout 2"); a phase with a single workout matches every day. Focus, Trigger and
// Mobility sessions have no fixed list. Anything else is not matched, never guessed.
// Each exercise gets one status: as_called (same canonical exercise), swapped (one of the owner's swaps, or the fill
// rule: a cable or machine slot filled by a band, dumbbell or bodyweight exercise with the same movement pattern),
// changed (a missed exercise paired with one done instead with the same movement pattern), skipped, or added.
import { parseRange, parseReps } from './catalog.js';

export const STATUSES = ['as_called', 'swapped', 'changed', 'skipped', 'added'];
const FILL_FROM = new Set(['machine', 'cable']);
const FILL_WITH = new Set(['band', 'dumbbell', 'bodyweight']);
const USUAL_LIMIT = 5;

const NUMBERED = /\b(?:foundation(?:al)?|day|workout)s?\s*(?:workout\s*)?(\d+)(?:\s*-\s*(\d+))?/i;

// A capital letter in place of the number ("Day A" is workout 1, "Day B" workout 2).
const LETTERED = /\b(?:[Ff]oundation(?:al)?|[Dd]ay|[Ww]orkout)\s+([A-H])\b/;

/**
 * The workout number in a name: "Symmetry Foundation 2 - Phase 4" -> { from: 2, to: 2 }; "Workouts 1-3" -> 1 to 3;
 * "Day B" -> 2.
 */
export function workoutNumber(name) {
  const m = NUMBERED.exec(String(name ?? ''));
  if (!m) {
    const letter = LETTERED.exec(String(name ?? ''));
    if (!letter) return null;
    const n = letter[1].charCodeAt(0) - 64;
    return { from: n, to: n };
  }
  const from = Number(m[1]);
  // A range only in the catalog's own names ("Workouts 1-3"); a logged "Foundation 2 - Phase 4" is a single number.
  const to = m[2] !== undefined && /workouts\s*\d+\s*-\s*\d+/i.test(name) ? Number(m[2]) : from;
  return { from, to };
}

export const isFocusSession = (name) => /\b(focus|trigger|mobility)\b/i.test(String(name ?? ''));

/**
 * The catalog workout a logged day was following.
 * @returns {{ status: 'matched', phase: object, workout: object } | { status: 'focus'|'not_matched', reason: string }}
 */
export function matchWorkout(day, program) {
  if (isFocusSession(day.workout)) return { status: 'focus', reason: 'focus, trigger or mobility session (no fixed list)' };
  if (!program) return { status: 'not_matched', reason: 'program not in the catalog' };
  const phase = program.phases.find((p) => p.name.toLowerCase() === String(day.phase ?? '').toLowerCase());
  if (!phase) return { status: 'not_matched', reason: day.phase ? `no ${day.phase} in the catalog` : 'phase unknown' };
  const workouts = (phase.workouts ?? []).filter((w) => w.exercises?.length);
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

const rangeStatus = (n, r) => (!r ? null : n < r.min ? 'under' : n > r.max ? 'over' : 'within');

/**
 * One day: the called-for exercises against the logged ones.
 * @param {object} input
 * @param {Array<{name: string, sets?: string, reps?: string}>} input.called  catalog exercises (phase sets and reps as defaults)
 * @param {Array<{name: string, canonical_id: string|null, implement: string|null, pattern: string|null, sets: number, reps: number[]}>} input.logged
 *   exercises with at least one performed set
 * @param {(name: string) => {id: string|null, name: string|null, implement: string|null, pattern: string|null}} input.lookup
 * @param {{ swaps?: Array<{prescribed: string, use: string[]}> }} [input.substitutions]
 */
export function compareSession({ called, logged, lookup, substitutions = {} }) {
  const swaps = new Map((substitutions.swaps ?? []).map((s) => [s.prescribed, new Set(s.use)]));
  const want = called.map((c) => {
    const d = lookup(c.name);
    return { name: d.name ?? c.name, id: d.id, implement: d.implement, pattern: d.pattern, sets: parseRange(c.sets), reps: parseReps(c.reps) };
  });
  const did = logged.map((l) => ({ ...l, key: l.canonical_id ?? l.name.toLowerCase() }));
  const rows = [];
  const usedWant = new Set();
  const usedDid = new Set();
  const pair = (status, test, reason) => {
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
  pair('swapped', (w, d) => w.id && swaps.get(w.id)?.has(d.canonical_id), 'your swap');
  pair('swapped', (w, d) => FILL_FROM.has(w.implement) && FILL_WITH.has(d.implement) && w.pattern && w.pattern === d.pattern, 'fills the cable or machine slot');
  pair('changed', (w, d) => w.pattern && w.pattern === d.pattern);
  want.forEach((w, i) => { if (!usedWant.has(i)) rows.push(row('skipped', w, null)); });
  did.forEach((d, k) => { if (!usedDid.has(k)) rows.push(row('added', null, d)); });
  return rows;
}

function row(status, w, d, reason = null) {
  const inRange = w?.reps?.unit === 'reps' && d?.reps.length
    ? d.reps.filter((r) => r >= w.reps.min && r <= w.reps.max).length : null;
  return {
    status,
    reason,
    called: w ? { name: w.name, sets: w.sets, reps: w.reps } : null,
    logged: d ? { name: d.canonicalName ?? d.name, sets: d.sets, reps: d.reps } : null,
    setsStatus: w && d ? rangeStatus(d.sets, w.sets) : null,
    repsInRange: inRange === null ? null : { inRange, of: d.reps.length },
  };
}

const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const top = (map) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, USUAL_LIMIT).map(([what, times]) => ({ what, times }));

/**
 * A block's days, newest first, each matched and compared; the days grouped by block week; the usual changes across
 * the block; and how many days matched.
 * @param {object} input
 * @param {Array<{date: string, week: number|null, phase: string|null, workout: string|null, exercises: Array<object>}>} input.days
 * @param {object|null} input.program  the catalog program
 */
export function blockAdherence({ days, program, lookup, substitutions = {} }) {
  const sessions = [];
  const swapsSeen = new Map();
  const skipped = new Map();
  const added = new Map();
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
    const called = m.workout.exercises.map((e) => ({ name: e.name, sets: e.sets ?? m.phase.sets, reps: e.reps ?? m.phase.reps }));
    const rows = compareSession({ called, logged: exercises, lookup, substitutions });
    const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
    const calledRows = rows.filter((r) => r.called?.sets);
    for (const r of rows) {
      if (r.status === 'swapped' || r.status === 'changed') count(swapsSeen, `${r.called.name} → ${r.logged.name}`);
      if (r.status === 'skipped') count(skipped, r.called.name);
      if (r.status === 'added') count(added, r.logged.name);
    }
    sessions.push({
      ...base,
      match: 'matched',
      catalogWorkout: m.workout.name,
      catalogPhase: m.phase.name,
      counts,
      setsCalled: { min: calledRows.reduce((s, r) => s + r.called.sets.min, 0), max: calledRows.reduce((s, r) => s + r.called.sets.max, 0) },
      setsLogged: rows.reduce((s, r) => s + (r.logged?.sets ?? 0), 0),
      rows,
    });
  }
  const weeks = [];
  for (const s of sessions) {
    const last = weeks.at(-1);
    if (last && last.week === s.week) last.sessions.push(s);
    else weeks.push({ week: s.week, sessions: [s] });
  }
  return { coverage, weeks, usualChanges: { swaps: top(swapsSeen), skipped: top(skipped), added: top(added) } };
}
