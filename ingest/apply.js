// Writes parsed Apple Health data, the same way whichever way it arrived: Health Auto Export's files in Drive
// (ingest/sync.js) or its REST posts (POST /api/ingest/*, server/app.js).
//   Health days: merged with the stored day (mergeHealthDays: the fullest row wins, gaps filled), so a partial export never
//     lowers a full day and a value missing from the new data never erases a stored one; exported_through keeps the latest
//     write time (a day exported before it ended is partial, metrics/dataquality.js).
//   Stand hours: each { date, hour } with standing is kept (stand_hour_samples); a day's stand_hours is the larger of the
//     stored value and the distinct hours recorded, so exports holding part of a day add up and a re-sent hour counts once.
//   Workouts: one row per workout (same type, start within a minute is the same one) and its per-minute heart rate.
import { HEALTH_METRIC_COLUMNS, mergeHealthDays } from './parsers.js';

/** Upsert of one daily_metrics row; a column the record lacks keeps its stored value. */
export function upsertDailyMetrics(db, stamp) {
  const cols = HEALTH_METRIC_COLUMNS;
  const stmt = db.prepare(`INSERT INTO daily_metrics (user_id, date, ${cols.join(', ')}, updated_at)
    VALUES (@uid, @date, ${cols.map((c) => `@${c}`).join(', ')}, @updated_at)
    ON CONFLICT (user_id, date) DO UPDATE SET ${cols.map((c) => `${c} = COALESCE(excluded.${c}, daily_metrics.${c})`).join(', ')},
      updated_at = excluded.updated_at`);
  return (r) => stmt.run({ ...Object.fromEntries(cols.map((c) => [c, r[c] ?? null])), date: r.date, updated_at: stamp });
}

/**
 * Writes health days, their export times and stand hours. Call inside a transaction.
 * @param {object} p
 * @param {object[]} p.records  one per date (parseHealthMetrics or parseHealthJson)
 * @param {Map<string, string>} [p.exportedThrough]  date -> local write time (YYYY-MM-DDTHH:MM) of the data
 * @param {Array<{date: string, hour: number}>} [p.standHours]
 * @returns {{ days: string[], standDays: string[] }}
 */
export function applyHealthDays(db, { records, exportedThrough = new Map(), standHours = [] }, stamp) {
  const storedDay = db.prepare(`SELECT date, ${HEALTH_METRIC_COLUMNS.join(', ')} FROM daily_metrics WHERE user_id = @uid AND date = ?`);
  const writeDay = upsertDailyMetrics(db, stamp);
  // The latest write time holding each day; an older one read later never lowers it (MAX, NULL treated as earliest).
  const markExported = db.prepare("UPDATE daily_metrics SET exported_through = MAX(COALESCE(exported_through, ''), ?) WHERE user_id = @uid AND date = ?");
  const addHour = db.prepare('INSERT OR IGNORE INTO stand_hour_samples (user_id, date, hour) VALUES (@uid, ?, ?)');
  const countStand = db.prepare(`UPDATE daily_metrics SET stand_hours = MAX(COALESCE(stand_hours, 0),
    (SELECT COUNT(*) FROM stand_hour_samples s WHERE s.user_id = daily_metrics.user_id AND s.date = daily_metrics.date))
    WHERE user_id = @uid AND date = ? AND EXISTS (SELECT 1 FROM stand_hour_samples s WHERE s.user_id = daily_metrics.user_id AND s.date = daily_metrics.date)`);

  // Each day merged with the stored day (stored first, so a tie goes to the newer data).
  const dates = [...new Set(records.map((r) => r.date))];
  const stored = dates.map((d) => storedDay.get(d)).filter(Boolean);
  const days = mergeHealthDays([...stored, ...records]).filter((r) => dates.includes(r.date));
  for (const d of days) writeDay(d);
  for (const [date, at] of exportedThrough) markExported.run(at, date);
  for (const s of standHours) addHour.run(s.date, s.hour);
  // Stand hours for every day touched, once its daily row exists (a stand hour alone never creates a day).
  const standDays = [...new Set([...dates, ...standHours.map((s) => s.date)])];
  for (const d of standDays) countStand.run(d);
  return { days: dates, standDays: [...new Set(standHours.map((s) => s.date))] };
}

export const WORKOUT_COLUMNS = ['duration_sec', 'total_energy_kcal', 'active_energy_kcal', 'max_hr', 'avg_hr', 'distance_mi', 'avg_speed_mph',
  'step_count', 'step_cadence_spm', 'swim_stroke_count', 'swim_stroke_cadence_spm', 'flights_climbed', 'elevation_up_ft', 'elevation_down_ft'];
/** Local wall-clock text (YYYY-MM-DDTHH:MM:SS) moved by whole minutes. */
const shiftMinutes = (t, n) => new Date(Date.parse(`${t}Z`) + n * 60000).toISOString().slice(0, 19);

/**
 * Writes one JSON workout and its per-minute heart rate. A stored workout of the same type starting within a minute
 * (the earlier Sheets export rounded times its own way) is the same workout: its values fill this one's gaps, then it
 * is replaced, so a re-export never duplicates. Values the file lacks never erase stored ones (COALESCE).
 */
export function writeJsonWorkout(db, stamp) {
  const cols = WORKOUT_COLUMNS;
  const near = db.prepare('SELECT * FROM workout_sessions WHERE user_id = @uid AND type = ? AND start BETWEEN ? AND ? AND NOT (start = ? AND end = ?)');
  const drop = db.prepare('DELETE FROM workout_sessions WHERE user_id = @uid AND type = ? AND start = ? AND end = ?');
  const dropSamples = db.prepare('DELETE FROM workout_hr_samples WHERE user_id = @uid AND type = ? AND start = ?');
  const upsert = db.prepare(`INSERT INTO workout_sessions (user_id, type, start, end, ${cols.join(', ')}, updated_at)
    VALUES (@uid, @type, @start, @end, ${cols.map((c) => `@${c}`).join(', ')}, @updated_at)
    ON CONFLICT (user_id, type, start, end) DO UPDATE SET ${cols.map((c) => `${c} = COALESCE(excluded.${c}, workout_sessions.${c})`).join(', ')},
      updated_at = excluded.updated_at`);
  const sample = db.prepare('INSERT OR REPLACE INTO workout_hr_samples (user_id, type, start, t, avg_bpm, min_bpm, max_bpm) VALUES (@uid, ?, ?, ?, ?, ?, ?)');
  return (w, samples) => {
    const merged = { ...w };
    for (const old of near.all(w.type, shiftMinutes(w.start, -1), shiftMinutes(w.start, 1), w.start, w.end)) {
      for (const c of cols) if (merged[c] === null || merged[c] === undefined) merged[c] = old[c];
      drop.run(old.type, old.start, old.end);
      dropSamples.run(old.type, old.start);
    }
    upsert.run({ ...merged, updated_at: stamp });
    dropSamples.run(w.type, w.start);
    for (const s of samples) sample.run(s.type, s.start, s.t, s.avg_bpm, s.min_bpm, s.max_bpm);
  };
}

/** Writes JSON workouts with their per-minute heart rate. Call inside a transaction. Returns the workout count. */
export function applyWorkouts(db, records, samples, stamp) {
  const write = writeJsonWorkout(db, stamp);
  for (const w of records) write(w, samples.filter((h) => h.type === w.type && h.start === w.start));
  return records.length;
}
