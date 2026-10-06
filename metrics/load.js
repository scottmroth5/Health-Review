// Reads what computeWeek needs from the database: about 120 days up to the week's end (90 days of
// medication changes plus their 28-day before windows), plus the following morning for
// next-morning recovery after the last day of the week.
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { addDays } from './stats.js';
import { DICTIONARY_PATH, loadDictionary } from './dictionary.js';
import { loadCatalog } from './catalog.js';
import { programAt, programProgress } from './blocks.js';
import { liftProgress } from './plateau.js';
import { advisorDue } from './advisor.js';
import { repoPath } from '../tools/paths.js';

export const SUBSTITUTIONS_PATH = repoPath('config', 'substitutions.json');
/** config/substitutions.json: home equipment, swaps and the avoid list. */
export const loadSubstitutions = (path = SUBSTITUTIONS_PATH) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * @param {{ catalog?: object|null, dictionary?: object, substitutions?: object }} [options]  MAPS catalog (defaults to
 * data/maps/programs.json when present), exercise dictionary and substitutions (default to config/)
 */
// The confirmed program block the week ends in, with phase and finish from its logged workout names.
function programForWeek(db, weekEnd, catalog) {
  const block = db.prepare(`SELECT program, start_date, status FROM program_blocks WHERE source = 'confirmed'
    AND start_date <= ? AND COALESCE(end_date, ?) >= ? ORDER BY start_date DESC LIMIT 1`).get(weekEnd, weekEnd, addDays(weekEnd, -6));
  if (!block) return null;
  const rows = db.prepare('SELECT date, workout FROM strength_exercises WHERE date BETWEEN ? AND ?').all(block.start_date, weekEnd);
  return programAt(block, catalog, weekEnd, rows);
}

export function loadWeekData(db, weekEnd, { catalog, dictionary, substitutions } = {}) {
  const from = addDays(weekEnd, -125);
  const cat = catalog === undefined ? loadCatalog() : catalog;
  const program = programForWeek(db, weekEnd, cat);
  // The Program Advisor's input, only when the review should carry the ranking (near the end of a block or between).
  const advisorInput = cat && advisorDue(program, weekEnd)
    ? { ...loadAdvisorInput(db, weekEnd, cat), programs: cat.programs, lookup: (dictionary ?? loadDictionary()).lookup,
      substitutions: substitutions ?? loadSubstitutions() }
    : null;
  const nextMorning = addDays(weekEnd, 1);
  return {
    daily_metrics: db.prepare('SELECT * FROM daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date').all(from, nextMorning),
    workout_sessions: db.prepare('SELECT * FROM workout_sessions WHERE start >= ? AND start < ? ORDER BY start')
      .all(from, `${nextMorning}`),
    // About 13 months, for the 12-month volume trend (the 28-day strength metrics filter their own window).
    strength_sets: loadStrengthSets(db, addDays(weekEnd, -400), weekEnd),
    drinking_days: db.prepare('SELECT * FROM drinking_days WHERE date BETWEEN ? AND ? ORDER BY date').all(from, weekEnd),
    checkins: db.prepare('SELECT * FROM checkins WHERE date <= ? ORDER BY date').all(weekEnd),
    ...loadMedications(db),
    lab_tests: db.prepare('SELECT id, name, panel, unit, position FROM lab_tests').all(),
    lab_results: db.prepare('SELECT test_id, drawn_on, value, value_text FROM lab_results WHERE drawn_on <= ?').all(weekEnd),
    medication_doses: db.prepare('SELECT date, medication_id, timing, taken FROM medication_doses WHERE date BETWEEN ? AND ?')
      .all(addDays(weekEnd, -6), weekEnd),
    // The confirmed program block the week ends in, with its phase and week from the catalog.
    program,
    advisor_input: advisorInput,
    primary_sets: loadPrimarySets(db, weekEnd),
    session_phases: loadSessionPhases(db),
  };
}

/**
 * The owner's own notes from the review week, oldest first: check-ins, drinking days, Workout Log
 * comments and text typed in its date column. Sent to the review by the owner's choice (life context
 * and symptoms); device data never takes this path.
 */
export function loadWeekNotes(db, weekEnd) {
  const from = addDays(weekEnd, -6);
  const rows = [
    ...db.prepare("SELECT date, 'check-in' AS source, notes AS text FROM checkins WHERE date BETWEEN ? AND ? AND notes IS NOT NULL").all(from, weekEnd),
    ...db.prepare("SELECT date, 'drinking' AS source, notes AS text FROM drinking_days WHERE date BETWEEN ? AND ? AND notes IS NOT NULL").all(from, weekEnd),
    ...db.prepare("SELECT date, 'workout: ' || exercise AS source, comment AS text FROM strength_exercises WHERE date BETWEEN ? AND ? AND comment IS NOT NULL").all(from, weekEnd),
    ...db.prepare("SELECT date, 'workout log' AS source, text FROM workout_log_notes WHERE date BETWEEN ? AND ?").all(from, weekEnd),
  ];
  return rows.filter((r) => r.text?.trim()).sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));
}

/** One row per Workout Log set (with its exercise and date) between two dates. */
// Dictionary names by canonical id, read once per process (the file changes only between runs).
let canonicalNames;
function canonicalName(id) {
  if (!id) return null;
  if (canonicalNames === undefined) {
    try {
      canonicalNames = existsSync(DICTIONARY_PATH) ? new Map(loadDictionary().exercises.map((e) => [e.id, e.name])) : new Map();
    } catch {
      canonicalNames = new Map(); // an invalid dictionary is reported by sync and log:normalize
    }
  }
  return canonicalNames.get(id) ?? null;
}

/** Performed and planned sets with their normalized exercise (canonical_id, canonical_name, implement). */
export function loadStrengthSets(db, from, to) {
  return db.prepare(`SELECT e.date, e.exercise, e.workout, e.canonical_id, e.implement, e.is_primary, s.set_no, s.weight_lbs, s.per_hand,
      s.band, s.bodyweight, s.reps, s.reps_text, s.duration_sec, s.distance_yd
    FROM strength_exercises e JOIN strength_sets s ON s.exercise_id = e.id
    WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.row_no, s.set_no`).all(from, to)
    .map((s) => ({ ...s, canonical_name: canonicalName(s.canonical_id) }));
}

/** Every primary-lift set up to a date (records need the full history), with the dictionary name. */
export function loadPrimarySets(db, to) {
  return db.prepare(`SELECT e.date, e.exercise, e.workout, e.canonical_id, e.implement, e.is_primary, s.set_no, s.weight_lbs, s.per_hand,
      s.band, s.bodyweight, s.reps, s.reps_text, s.duration_sec, s.distance_yd
    FROM strength_exercises e JOIN strength_sets s ON s.exercise_id = e.id
    WHERE e.is_primary = 1 AND e.date <= ? ORDER BY e.date, e.row_no, s.set_no`).all(to)
    .map((s) => ({ ...s, canonical_name: canonicalName(s.canonical_id) }));
}

/** The stored phase of each session (log_sessions), as { date: phase }. */
export function loadSessionPhases(db) {
  return Object.fromEntries(db.prepare('SELECT date, phase FROM log_sessions WHERE phase IS NOT NULL').all().map((r) => [r.date, r.phase]));
}

/**
 * What the Program Advisor ranks from, as of a date: confirmed blocks with the share of the program each reached
 * (the in-progress one as of the date, others at their last session), every primary-lift set, VO2 max readings,
 * Apple Watch strength and HIIT minutes per lifting day by program, the lifts' current status, and the program run
 * last (the in-progress confirmed block, else the latest one started).
 */
export function loadAdvisorInput(db, asOf, catalog) {
  const blocks = db.prepare(`SELECT b.program, b.start_date, b.end_date, b.status, (SELECT MAX(date) FROM log_sessions WHERE block_id = b.id) AS last
    FROM program_blocks b WHERE b.source = 'confirmed' AND b.start_date <= ? ORDER BY b.start_date`).all(asOf)
    .map((b) => {
      const at = b.status === 'in_progress' ? asOf : (b.last ?? b.start_date);
      const rows = db.prepare('SELECT date, workout FROM strength_exercises WHERE date BETWEEN ? AND ?').all(b.start_date, at);
      const p = programProgress(b, rows, catalog, at);
      return { program: b.program, start_date: b.start_date, end_date: b.end_date, status: b.status,
        percent: p.week && p.programWeeks ? Math.min(100, Math.round((p.week / p.programWeeks) * 100)) : null };
    });
  const sets = loadPrimarySets(db, asOf);
  return {
    blocks,
    sets,
    vo2: db.prepare('SELECT date, vo2max AS value FROM daily_metrics WHERE vo2max IS NOT NULL AND date <= ? ORDER BY date').all(asOf),
    watchMinutes: db.prepare(`SELECT ls.program, w.minutes FROM log_sessions ls
      JOIN (SELECT substr(start, 1, 10) AS day, SUM(duration_sec) / 60.0 AS minutes FROM workout_sessions
        WHERE (type LIKE '%Strength%' OR type LIKE '%High Intensity%') AND duration_sec IS NOT NULL GROUP BY day) w ON w.day = ls.date
      WHERE ls.program IS NOT NULL AND ls.date <= ?`).all(asOf),
    lifts: liftProgress(sets, asOf, { phases: new Map(Object.entries(loadSessionPhases(db))) }),
    lastProgram: (blocks.filter((b) => b.status === 'in_progress').at(-1) ?? blocks.at(-1))?.program ?? null,
    asOf,
  };
}

/** All medications and their periods (small tables, read whole). */
export function loadMedications(db) {
  return {
    medications: db.prepare('SELECT id, name, kind, purpose, prescribed, notes FROM medications ORDER BY name').all(),
    medication_periods: db.prepare('SELECT * FROM medication_periods ORDER BY medication_id, started_on, id').all(),
  };
}

/** Personal settings the metrics use. Zone 2 is null until both ends are set. */
export function loadMetricSettings(db) {
  const get = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const low = Number(get('zone2_low_bpm'));
  const high = Number(get('zone2_high_bpm'));
  return { zone2: low > 0 && high > low ? { low, high } : null };
}
