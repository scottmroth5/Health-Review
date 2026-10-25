// Workouts logged in the app (no Google Sheets needed): stored in the Workout Log's own tables, strength_exercises and
// strength_sets, under tab_year 0 ("entered in the app"), so volume, lift progress, program blocks, phases, adherence and
// the weekly review use them exactly like sheet rows (they all read by date). The Sheets sync replaces only the year tabs
// it reads (tab_year = the year), so it never touches these. One app workout per day; weights and reps are read with
// the sheet's own parsers, so "BW", "40ea", a band color or "30s" mean the same here. Takes a scoped database.
import { parseSet, parseWeight, SET_PAIRS } from './parsers.js';
import { detect, writeDetected, assignForward, refreshPhases } from './program-blocks.js';
import { performed } from '../metrics/strength.js';

export const APP_TAB_YEAR = 0;
export const MAX_EXERCISES = 30;
export class WorkoutError extends Error {}

const clean = (v, max) => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, max) : null;
};

/** The days with workouts between two dates, newest first: each with its source (app: editable; sheet: read only). */
export function listWorkouts(db, { from, to }) {
  const rows = db.prepare(`SELECT e.id, e.tab_year, e.row_no, e.date, e.workout, e.exercise, e.comment
    FROM strength_exercises e WHERE e.user_id = @uid AND e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.tab_year, e.row_no`).all(from, to);
  const sets = db.prepare(`SELECT s.exercise_id, s.set_no, s.weight_text, s.reps_text, s.weight_lbs, s.reps, s.duration_sec, s.distance_yd, s.bodyweight, s.band
    FROM strength_sets s JOIN strength_exercises e ON e.id = s.exercise_id AND e.user_id = s.user_id
    WHERE s.user_id = @uid AND e.date BETWEEN ? AND ? ORDER BY s.exercise_id, s.set_no`).all(from, to);
  const setsOf = new Map();
  for (const s of sets) setsOf.set(s.exercise_id, [...(setsOf.get(s.exercise_id) ?? []), s]);
  const days = new Map();
  for (const r of rows) {
    const source = r.tab_year === APP_TAB_YEAR ? 'app' : 'sheet';
    const k = `${r.date}|${source}`;
    if (!days.has(k)) days.set(k, { date: r.date, source, workout: null, exercises: [] });
    const day = days.get(k);
    day.workout ??= r.workout;
    const own = setsOf.get(r.id) ?? [];
    day.exercises.push({ name: r.exercise, comment: r.comment, sets: own.map((s) => ({ weight: s.weight_text, reps: s.reps_text })), performed: own.some(performed) });
  }
  return [...days.values()];
}

/**
 * Checks a submitted workout and parses its sets like the sheet's. Throws WorkoutError with what is wrong.
 * @returns {{ workout: string|null, exercises: Array<{ name, comment, sets: object[] }> }}
 */
export function checkWorkout(body) {
  const exercises = (body?.exercises ?? []).map((ex, i) => {
    const name = clean(ex?.name, 120);
    if (!name) throw new WorkoutError(`Exercise ${i + 1} needs a name`);
    const raw = (ex.sets ?? []).filter((s) => clean(s?.weight, 40) || clean(s?.reps, 40));
    if (raw.length > SET_PAIRS) throw new WorkoutError(`${name}: at most ${SET_PAIRS} sets`);
    return { name, comment: clean(ex.comment, 500), sets: raw.map((s, k) => ({ set_no: k + 1, ...parseWeight(clean(s.weight, 40)), ...parseSet(clean(s.reps, 40)) })) };
  });
  if (!exercises.length) throw new WorkoutError('Add at least one exercise');
  if (exercises.length > MAX_EXERCISES) throw new WorkoutError(`At most ${MAX_EXERCISES} exercises`);
  return { workout: clean(body.workout, 200), exercises };
}

/** After a change: the dictionary onto the new names, then blocks and phases as a sync does (confirmed blocks untouched). */
function afterChange(db, names, { today, now, dictionary, catalog }) {
  const update = db.prepare(`UPDATE strength_exercises SET canonical_id = ?, implement = ?, movement_pattern = ?, is_primary = ?, map_status = ?, normalized_at = ?
    WHERE user_id = @uid AND exercise = ?`);
  for (const name of new Set(names)) {
    const m = dictionary.lookup(name);
    update.run(m.id, m.implement, m.pattern, m.primary ? 1 : 0, m.status, now.toISOString(), name);
  }
  writeDetected(db, detect(db, today), { now });
  assignForward(db, today, { now });
  refreshPhases(db, catalog());
}

/**
 * Saves a day's app workout, replacing any earlier one that day (sheet rows that day are left as they are).
 * @param {{ today: string, now?: Date, dictionary: object, catalog: () => object|null }} ctx
 */
export function saveWorkout(db, date, body, ctx) {
  if (date > ctx.today) throw new WorkoutError('Log workouts up to today, not ahead');
  const w = checkWorkout(body);
  const now = ctx.now ?? new Date();
  db.transaction(() => {
    db.prepare('DELETE FROM strength_exercises WHERE user_id = @uid AND tab_year = ? AND date = ?').run(APP_TAB_YEAR, date);
    let rowNo = db.prepare('SELECT COALESCE(MAX(row_no), 0) FROM strength_exercises WHERE user_id = @uid AND tab_year = ?').pluck().get(APP_TAB_YEAR);
    const insertExercise = db.prepare(`INSERT INTO strength_exercises (user_id, tab_year, row_no, date, workout, exercise, comment)
      VALUES (@uid, ?, ?, ?, ?, ?, ?)`);
    const insertSet = db.prepare(`INSERT INTO strength_sets (user_id, exercise_id, set_no, weight_text, weight_lbs, per_hand, band, bodyweight, reps_text, reps, duration_sec, distance_yd)
      VALUES (@uid, @exercise_id, @set_no, @weight_text, @weight_lbs, @per_hand, @band, @bodyweight, @reps_text, @reps, @duration_sec, @distance_yd)`);
    for (const ex of w.exercises) {
      rowNo += 1;
      const id = insertExercise.run(APP_TAB_YEAR, rowNo, date, w.workout, ex.name, ex.comment).lastInsertRowid;
      for (const s of ex.sets) insertSet.run({ exercise_id: id, ...s });
    }
    afterChange(db, w.exercises.map((e) => e.name), { ...ctx, now });
  })();
  return listWorkouts(db, { from: date, to: date }).find((d) => d.source === 'app');
}

/** Deletes a day's app workout; returns whether there was one. */
export function deleteWorkout(db, date, ctx) {
  let gone = 0;
  db.transaction(() => {
    gone = db.prepare('DELETE FROM strength_exercises WHERE user_id = @uid AND tab_year = ? AND date = ?').run(APP_TAB_YEAR, date).changes;
    if (gone) afterChange(db, [], { ...ctx, now: ctx.now ?? new Date() });
  })();
  return gone > 0;
}

/**
 * Help for the form: exercise names from their own history (most logged first) and the dictionary, and their own
 * programs' workouts to start from (never a shared catalog's contents).
 */
export function workoutSuggestions(db, { dictionary, ownPrograms }) {
  const history = db.prepare(`SELECT exercise, COUNT(*) AS n FROM strength_exercises WHERE user_id = @uid GROUP BY exercise ORDER BY n DESC LIMIT 300`).all().map((r) => r.exercise);
  const names = [...new Set([...history, ...dictionary.exercises.map((e) => e.name)])];
  const templates = ownPrograms.flatMap((p) => p.phases.flatMap((ph) => (ph.workouts ?? []).map((wo) => ({
    label: `${p.name}, ${ph.name}, ${wo.name}`,
    workout: `${p.name} ${ph.name} ${wo.name}`,
    exercises: (wo.exercises ?? []).map((ex) => ({ name: ex.name, sets: ex.sets ?? null, reps: ex.reps ?? null })),
  }))));
  return { names, templates };
}
