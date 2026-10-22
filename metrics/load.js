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
import { suggestTarget, loadTargetConfig } from './targets.js';
import { loadLabRanges } from './labs.js';
import { repoPath } from '../tools/paths.js';

export const SUBSTITUTIONS_PATH = repoPath('config', 'substitutions.json');
/** config/substitutions.json: home equipment, swaps and the avoid list. */
export const loadSubstitutions = (path = SUBSTITUTIONS_PATH) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * @param {{ catalog?: object|null, dictionary?: object, substitutions?: object }} [options]  MAPS catalog (defaults to
 * data/maps/programs.json when present), exercise dictionary and substitutions (default to config/)
 */
// The confirmed program block the week ends in, with phase and finish from its logged workout names.
export function programForWeek(db, weekEnd, catalog) {
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
  // Called for vs logged for the week (metrics/adherence.js): the confirmed block the week ends in, when its program is in
  // the catalog. computeWeek reduces it to counts and the owner's logged names.
  const block = cat ? db.prepare(`SELECT id, program FROM program_blocks WHERE source = 'confirmed' AND start_date <= ?
    AND COALESCE(end_date, ?) >= ? ORDER BY start_date DESC LIMIT 1`).get(weekEnd, weekEnd, addDays(weekEnd, -6)) : null;
  const adherenceInput = block && cat.find(block.program)
    ? { program: cat.find(block.program), programName: block.program, days: loadAdherenceInput(db, block.id, weekEnd),
      lookup: (dictionary ?? loadDictionary()).lookup, substitutions: substitutions ?? loadSubstitutions() }
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
    lab_tests: db.prepare('SELECT id, name, panel, unit, position, ref_low, ref_high, ref_set FROM lab_tests').all(),
    lab_ranges: loadLabRanges(),
    lab_results: db.prepare('SELECT test_id, drawn_on, value, value_text FROM lab_results WHERE drawn_on <= ?').all(weekEnd),
    medication_doses: db.prepare('SELECT date, medication_id, timing, taken FROM medication_doses WHERE date BETWEEN ? AND ?')
      .all(addDays(weekEnd, -6), weekEnd),
    // The confirmed program block the week ends in, with its phase and week from the catalog.
    program,
    advisor_input: advisorInput,
    // Health targets as of the week's end (owner-set, or suggested from the 90 days to it).
    targets: loadTargets(db, weekEnd, loadTargetConfig()),
    adherence_input: adherenceInput,
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

/** Confirmed program blocks, newest first, for the Called for vs logged picker. */
export function loadConfirmedBlocks(db) {
  return db.prepare(`SELECT id, program, start_date, end_date, status FROM program_blocks
    WHERE source = 'confirmed' ORDER BY start_date DESC`).all();
}

/**
 * A block's lifting days up to today for metrics/adherence.js: week, phase, the day's Workout name (its first named
 * row), and each exercise with its performed sets and their reps (planned rows with no reps, time or distance count 0).
 */
export function loadAdherenceInput(db, blockId, today) {
  const days = db.prepare(`SELECT date, week, phase FROM log_sessions
    WHERE block_id = ? AND assignment = 'block' AND date <= ? ORDER BY date`).all(blockId, today);
  const rows = db.prepare(`SELECT e.id, e.row_no, e.workout, e.exercise, e.canonical_id, e.implement, e.movement_pattern,
      s.reps, s.reps_text, s.duration_sec, s.distance_yd
    FROM strength_exercises e LEFT JOIN strength_sets s ON s.exercise_id = e.id
    WHERE e.date = ? ORDER BY e.row_no, s.set_no`);
  return days.map((d) => {
    const byExercise = new Map();
    let workout = null;
    for (const r of rows.all(d.date)) {
      workout ??= r.workout?.trim() || null;
      if (!r.exercise) continue;
      const key = r.canonical_id ?? r.exercise.trim().toLowerCase();
      if (!byExercise.has(key)) {
        byExercise.set(key, { name: r.exercise.trim(), canonical_id: r.canonical_id, canonicalName: canonicalName(r.canonical_id),
          implement: r.implement, pattern: r.movement_pattern, sets: 0, reps: [] });
      }
      const e = byExercise.get(key);
      if (r.reps != null || r.duration_sec != null || r.distance_yd != null || (r.reps_text ?? '') !== '') {
        e.sets += 1;
        if (r.reps != null) e.reps.push(r.reps);
      }
    }
    return { ...d, workout, exercises: [...byExercise.values()] };
  });
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

/** What the data checks (metrics/dataquality.js) read as of a date: 45 days of health rows, 30 days of workouts, the
 * Workout Log days with performed sets in the last 14 days, and for each export folder the newest file with when a sync
 * last looked for one. lookedAt and workoutsLookedAt: a sync passes its own time (or null without that folder);
 * otherwise the latest ok sync that read that folder. */
export function loadDataCheckInput(db, today, { lookedAt, workoutsLookedAt } = {}) {
  const newest = (kind, key, given) => {
    const file = db.prepare(`SELECT MAX(modified_time) AS at, strftime('%Y-%m-%dT%H:%M', MAX(modified_time), 'localtime') AS local
      FROM drive_exports WHERE kind = ?`).get(kind);
    const looked = given !== undefined ? given
      : db.prepare(`SELECT started_at FROM runs WHERE name = 'sync' AND status = 'ok' AND summary LIKE ?
        ORDER BY id DESC LIMIT 1`).pluck().get(`%"${key}"%`) ?? null;
    return file?.at && looked ? { lastFileAt: file.at, lastFileLocal: file.local, lookedAt: looked } : null;
  };
  return {
    exports: newest('health', 'health_exports', lookedAt),
    workoutExports: newest('workouts', 'workout_exports', workoutsLookedAt),
    daily: db.prepare(`SELECT date, steps, resting_hr, sleep_total_hr, exercise_min, exported_through FROM daily_metrics
      WHERE date BETWEEN ? AND ? ORDER BY date`).all(addDays(today, -45), today),
    sessions: db.prepare('SELECT type, start, end, duration_sec FROM workout_sessions WHERE start >= ? ORDER BY start').all(addDays(today, -30)),
    liftingDays: db.prepare(`SELECT DISTINCT e.date FROM strength_exercises e JOIN strength_sets s ON s.exercise_id = e.id
      WHERE e.date BETWEEN ? AND ? AND (s.reps IS NOT NULL OR s.duration_sec IS NOT NULL OR s.distance_yd IS NOT NULL OR COALESCE(s.reps_text, '') <> '')`)
      .all(addDays(today, -14), today).map((r) => r.date),
    today,
  };
}

/**
 * Names that mark a sentence as medication talk for the review's routing check: every medication's name and the names
 * of its ingredients in any period (an ingredient named alone is caught, not only the full name of the pill).
 */
export function medicationNames(db) {
  const meds = db.prepare("SELECT id, name FROM medications WHERE kind = 'medication'").all();
  const ingredients = db.prepare(`SELECT p.ingredients FROM medication_periods p JOIN medications m ON m.id = p.medication_id
    WHERE m.kind = 'medication' AND p.ingredients IS NOT NULL`).pluck().all()
    .flatMap((json) => JSON.parse(json).map((i) => i.name));
  const seen = new Set();
  return [...meds.map((m) => m.name), ...ingredients].filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
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

// ---- Health tab targets (metrics/targets.js) ----

/** The owner's profile for age-based targets (settings: birth_year, sex, height_in), with age on today. */
export const PROFILE_KEYS = ['birth_year', 'sex', 'height_in'];
export function loadProfile(db, today) {
  const rows = Object.fromEntries(db.prepare(`SELECT key, value FROM settings WHERE key IN (${PROFILE_KEYS.map(() => '?').join(', ')})`)
    .all(...PROFILE_KEYS).map((r) => [r.key, r.value]));
  const birthYear = rows.birth_year ? Number(rows.birth_year) : null;
  return {
    birthYear,
    sex: rows.sex ?? null,
    heightIn: rows.height_in ? Number(rows.height_in) : null,
    age: birthYear ? Number(today.slice(0, 4)) - birthYear : null,
  };
}

const TARGET_DAILY = ['hrv_ms', 'resting_hr', 'sleep_total_hr', 'steps', 'exercise_min', 'cardio_recovery_bpm', 'walking_hr_avg',
  'walking_speed_mph', 'walking_asymmetry_pct', 'wrist_temp_f', 'spo2_pct', 'breathing_disturbances'];
const TARGET_CHECKIN = ['weight_lbs', 'body_fat_pct', 'muscle_mass_lbs', 'visceral_fat', 'readiness'];

/**
 * Each target metric's current value: the average of its days in the 90 days to today (alcohol per logged drinking
 * day), and VO2 max's latest reading. Null when there is none.
 */
export function targetCurrents(db, today) {
  const from = addDays(today, -89);
  const avg = (table, col) => db.prepare(`SELECT AVG(${col}) FROM ${table} WHERE date BETWEEN ? AND ? AND ${col} IS NOT NULL`).pluck().get(from, today);
  const out = {};
  for (const c of TARGET_DAILY) out[c] = avg('daily_metrics', c);
  for (const c of TARGET_CHECKIN) out[c] = avg('checkins', c);
  out.alcohol = db.prepare(`SELECT AVG(COALESCE(beers, 0) + COALESCE(wine, 0) + COALESCE(bourbon, 0) + COALESCE(other, 0)) FROM drinking_days
    WHERE date BETWEEN ? AND ?`).pluck().get(from, today);
  out.vo2max = db.prepare('SELECT vo2max FROM daily_metrics WHERE vo2max IS NOT NULL AND date <= ? ORDER BY date DESC LIMIT 1').pluck().get(today) ?? null;
  return out;
}

/**
 * Every target metric: its suggestion (suggestTarget) and the target in effect, the owner's where set (health_targets).
 * @returns {Array<object>} config order; setBy 'owner' or 'suggested'
 */
export function loadTargets(db, today, config) {
  const profile = loadProfile(db, today);
  const currents = targetCurrents(db, today);
  const owned = new Map(db.prepare('SELECT metric, target FROM health_targets').all().map((r) => [r.metric, r.target]));
  return Object.entries(config.metrics).map(([metric, def]) => {
    const s = suggestTarget({ metric, current: currents[metric] ?? null, profile, config });
    const mine = owned.get(metric);
    return {
      ...s, label: def.label, unit: def.unit, decimals: def.decimals, direction: def.direction,
      target: mine ?? s.suggested, setBy: mine === undefined ? 'suggested' : 'owner',
    };
  });
}
