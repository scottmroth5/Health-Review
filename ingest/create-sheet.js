// "Create my Workout Log" (Settings, Workout Log): a new Google Sheet in the user's own Drive, laid out the way
// parseWorkoutLogTab reads it, made with their drive.file permission (the app can open only files it created). A tab
// named with the year holds the column row; a "How to use" tab explains it (the sync reads only year tabs). No example
// rows, since they would count as a real workout.
import { sheets as sheetsApi } from '@googleapis/sheets';
import { SET_PAIRS } from './parsers.js';

export const WORKOUT_LOG_TITLE = 'Health Review Workout Log';
export const WORKOUT_LOG_HEADER = ['Date', 'Workout', 'Exercise',
  ...Array.from({ length: SET_PAIRS }, (_, i) => [`Weight ${i + 1}`, `Set ${i + 1}`]).flat(), 'Comment'];

export const HOW_TO_USE = [
  'How to use this Workout Log with Health Review',
  'Log in the tab named with the year (2026, 2027, ...). Each January add a new tab named with the new year and copy row 1 into it.',
  'One row per exercise. Put the date on the first row of a workout only; the rows below it belong to the same day.',
  'Workout: the workout\'s name on its first row, with the program and phase, for example "Garage 5x5 Phase 1 A".',
  'Weight 1 and Set 1 are your first set, Weight 2 and Set 2 the second, and so on (up to 8 sets).',
  'Weight: pounds (185), per hand with "ea" (40ea), BW for bodyweight, or a band color.',
  'Set: the reps (8), or a time for holds (30 seconds or :45).',
  'Comment: anything about the exercise. Text typed in the Date column (Sick, Vacation) is kept as a note for that day.',
  'Health Review reads this sheet every morning, or when you tap Sync now on Home. It never changes it.',
];

const text = (v) => ({ userEnteredValue: { stringValue: v } });

/** The spreadsheets.create body: the year tab with its bold, frozen column row, and the How to use tab. */
export function workoutSheetBody(year) {
  return {
    properties: { title: WORKOUT_LOG_TITLE },
    sheets: [
      {
        properties: { sheetId: 0, title: String(year), gridProperties: { frozenRowCount: 1, columnCount: WORKOUT_LOG_HEADER.length } },
        data: [{ startRow: 0, startColumn: 0, rowData: [{ values: WORKOUT_LOG_HEADER.map((h) => ({ ...text(h), userEnteredFormat: { textFormat: { bold: true } } })) }] }],
      },
      {
        properties: { sheetId: 1, title: 'How to use' },
        data: [{ startRow: 0, startColumn: 0, rowData: HOW_TO_USE.map((line, i) => ({ values: [{ ...text(line), ...(i === 0 ? { userEnteredFormat: { textFormat: { bold: true } } } : {}) }] })) }],
      },
    ],
  };
}

/** Formats the Date column (below row 1) as dates, and widens the Exercise and Comment columns. */
export function workoutSheetFormat() {
  const width = (col, pixelSize) => ({ updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 }, properties: { pixelSize }, fields: 'pixelSize' } });
  return {
    requests: [
      { repeatCell: { range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'm/d/yyyy' } } }, fields: 'userEnteredFormat.numberFormat' } },
      width(1, 220), width(2, 200), width(WORKOUT_LOG_HEADER.length - 1, 240),
      { updateDimensionProperties: { range: { sheetId: 1, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 900 }, fields: 'pixelSize' } },
    ],
  };
}

/**
 * Creates the Workout Log in the user's Drive with their Google permission (drive.file). Returns its id and link.
 * @param {{ auth?: object, year: string|number, api?: object }} o  api: a fake Sheets client for tests
 */
export async function createWorkoutSheet({ auth, year, api = sheetsApi({ version: 'v4', auth }) }) {
  const { data } = await api.spreadsheets.create({ requestBody: workoutSheetBody(year) });
  await api.spreadsheets.batchUpdate({ spreadsheetId: data.spreadsheetId, requestBody: workoutSheetFormat() });
  return { id: data.spreadsheetId, url: data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}/edit` };
}
