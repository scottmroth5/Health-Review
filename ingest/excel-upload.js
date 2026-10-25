// The Excel Workout Log: the template to download, and ingesting an uploaded workbook. The workbook is read in memory
// with tools/xlsx.js (strict limits; never stored or logged), each tab named with a year goes through the same parser as
// the Google Sheet (parseWorkoutLogTab), and replaces that year's rows, as a sheet sync does. Years not in the file and
// workouts logged in the app (tab_year 0) are left alone. Takes a scoped database.
import { readXlsx, writeXlsx } from '../tools/xlsx.js';
import { parseWorkoutLogTab } from './parsers.js';
import { WORKOUT_LOG_HEADER, HOW_TO_USE } from './create-sheet.js';
import { afterChange } from './app-workouts.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const TEMPLATE_NAME = 'Health Review Workout Log.xlsx';
const DAYS_1904 = 1462; // a 1904-system date serial plus this is the 1900-system serial Google and the parser use
export class UploadError extends Error {}

/** The Excel Workout Log for a year: the year tab with the column row, and How to use. */
export function workoutTemplate(year) {
  const widths = WORKOUT_LOG_HEADER.map((h) => (h === 'Date' ? 12 : h === 'Workout' ? 30 : h === 'Exercise' ? 28 : h === 'Comment' ? 34 : 9));
  const howTo = HOW_TO_USE.map((line) => line.replace('Health Review reads this sheet every morning, or when you tap Sync now on Home. It never changes it.',
    'When you have logged some workouts, upload this file in Health Review: Settings, Data feeds, Workout Log, Upload. Each upload replaces the years in the file.'));
  return writeXlsx([
    { name: String(year), rows: [WORKOUT_LOG_HEADER], boldFirstRow: true, freezeFirstRow: true, widths, dateColumn: 0 },
    { name: 'How to use', rows: howTo.map((l) => [l]), boldFirstRow: true, widths: [120] },
  ]);
}

/**
 * Reads an uploaded workbook and replaces the years it holds. Throws UploadError (or XlsxError) with a message to show.
 * @param {{ today: string, now?: Date, dictionary: object, catalog: () => object|null }} ctx
 * @returns {{ years: number[], exercises: number, sets: number, notes: number, warnings: Record<string, number> }}
 */
export function ingestWorkbook(db, buf, ctx) {
  const { sheets, date1904 } = readXlsx(buf);
  const thisYear = Number(ctx.today.slice(0, 4));
  const tabs = sheets.filter((s) => /^\d{4}$/.test(s.name.trim()) && Number(s.name) >= 2000 && Number(s.name) <= thisYear + 1);
  if (!tabs.length) throw new UploadError('No tab named with a year (like 2026). Log in the year tab of the Excel Workout Log, or rename your tab to the year.');
  const parsed = tabs.map((s) => {
    const header = (s.rows[0] ?? []).map((v) => (typeof v === 'string' ? v : String(v ?? '')));
    let rows = s.rows.slice(1);
    if (date1904) {
      const col = header.findIndex((h) => h.trim().toLowerCase() === 'date');
      if (col >= 0) rows = rows.map((r) => r.map((v, i) => (i === col && typeof v === 'number' ? v + DAYS_1904 : v)));
    }
    try {
      return parseWorkoutLogTab({ header, rows, firstRowNumber: 2, tab: s.name.trim() });
    } catch (err) {
      throw new UploadError(`Tab ${s.name}: ${err.message}. Row 1 needs the Workout Log columns (Date, Workout, Exercise, Weight 1, Set 1, ...).`);
    }
  });
  const result = { years: tabs.map((s) => Number(s.name)), exercises: 0, sets: 0, notes: 0, warnings: {} };
  const insertExercise = db.prepare(`INSERT INTO strength_exercises (user_id, tab_year, row_no, date, workout, prime, exercise, post, comment)
    VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSet = db.prepare(`INSERT INTO strength_sets (user_id, exercise_id, set_no, weight_text, weight_lbs, per_hand, band, bodyweight, reps_text, reps, duration_sec, distance_yd)
    VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertNote = db.prepare('INSERT INTO workout_log_notes (user_id, tab_year, row_no, date, text) VALUES (@uid, ?, ?, ?, ?)');
  const names = new Set();
  db.transaction(() => {
    parsed.forEach(({ records, notes, warnings }, i) => {
      const year = result.years[i];
      db.prepare('DELETE FROM strength_exercises WHERE user_id = @uid AND tab_year = ?').run(year);
      db.prepare('DELETE FROM workout_log_notes WHERE user_id = @uid AND tab_year = ?').run(year);
      for (const e of records) {
        const id = insertExercise.run(e.tab_year, e.row_no, e.date, e.workout, e.prime, e.exercise, e.post, e.comment).lastInsertRowid;
        for (const s of e.sets) insertSet.run(id, s.set_no, s.weight_text, s.weight_lbs, s.per_hand, s.band, s.bodyweight, s.reps_text, s.reps, s.duration_sec, s.distance_yd);
        result.sets += e.sets.length;
        names.add(e.exercise);
      }
      for (const n of notes) insertNote.run(n.tab_year, n.row_no, n.date, n.text);
      result.exercises += records.length;
      result.notes += notes.length;
      for (const w of warnings) result.warnings[w.kind] = (result.warnings[w.kind] ?? 0) + 1;
    });
    afterChange(db, [...names], { ...ctx, now: ctx.now ?? new Date() });
  })();
  return result;
}
