// Reads what computeWeek needs from the database: about 120 days up to the week's end (90 days of
// medication changes plus their 28-day before windows), plus the following morning for
// next-morning recovery after the last day of the week.
import { addDays } from './stats.js';

export function loadWeekData(db, weekEnd) {
  const from = addDays(weekEnd, -125);
  const nextMorning = addDays(weekEnd, 1);
  return {
    daily_metrics: db.prepare('SELECT * FROM daily_metrics WHERE date BETWEEN ? AND ? ORDER BY date').all(from, nextMorning),
    workout_sessions: db.prepare('SELECT * FROM workout_sessions WHERE start >= ? AND start < ? ORDER BY start')
      .all(from, `${nextMorning}`),
    strength_sets: db.prepare(`SELECT e.date, e.exercise, e.workout, s.set_no, s.weight_lbs, s.per_hand, s.band, s.bodyweight,
        s.reps, s.reps_text, s.duration_sec, s.distance_yd
      FROM strength_exercises e JOIN strength_sets s ON s.exercise_id = e.id
      WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.row_no, s.set_no`).all(from, weekEnd),
    drinking_days: db.prepare('SELECT * FROM drinking_days WHERE date BETWEEN ? AND ? ORDER BY date').all(from, weekEnd),
    checkins: db.prepare('SELECT * FROM checkins WHERE date <= ? ORDER BY date').all(weekEnd),
    ...loadMedications(db),
    lab_tests: db.prepare('SELECT id, name, panel, unit, position FROM lab_tests').all(),
    lab_results: db.prepare('SELECT test_id, drawn_on, value, value_text FROM lab_results WHERE drawn_on <= ?').all(weekEnd),
    medication_doses: db.prepare('SELECT date, medication_id, timing, taken FROM medication_doses WHERE date BETWEEN ? AND ?')
      .all(addDays(weekEnd, -6), weekEnd),
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
