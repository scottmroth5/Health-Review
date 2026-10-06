// Parsers from raw sheet values (UNFORMATTED_VALUE, dates as serial numbers) to table records.
// Each takes { header, rows, firstRowNumber, tab } and returns { records, warnings }.
// Warnings carry sheet row numbers and a kind, never cell text, so they are safe to print.
import { serialToDate, serialToDateTime, serialToSeconds, parseUsDate } from './serial.js';

const isEmpty = (v) => v === '' || v === null || v === undefined;
const isBlankRow = (row) => !row?.some((c) => !isEmpty(c));
const cleanHeader = (h) => String(h ?? '').trim();

/** Number, numeric text, or null for an empty cell; undefined when the cell is not a number. */
function toNumber(v) {
  if (isEmpty(v)) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined;
}

const text = (v) => (isEmpty(v) ? null : String(v).trim() || null);

/**
 * Maps known headers to fields. Unknown non-empty headers become one warning each, so new
 * Health Auto Export columns are noticed rather than silently dropped.
 */
function columnIndex(header, fields, source) {
  const names = header.map(cleanHeader);
  const index = {};
  for (const [field, name] of Object.entries(fields)) index[field] = names.indexOf(name);
  const known = new Set(Object.values(fields));
  const warnings = names
    .filter((n) => n && !known.has(n))
    .map((n) => ({ source, kind: 'unknown column', detail: n }));
  return { index, warnings };
}

function numericFields(row, index, fields, warn) {
  const out = {};
  for (const field of fields) {
    const n = index[field] >= 0 ? toNumber(row[index[field]]) : null;
    if (n === undefined) {
      warn('not a number', field);
      out[field] = null;
    } else out[field] = n;
  }
  return out;
}

// ---- Consolidated Apple Health Metrics ----
const HEALTH_FIELDS = {
  date: 'Date/Time',
  active_energy_kcal: 'Active Energy (kcal)',
  exercise_min: 'Apple Exercise Time (min)',
  move_min: 'Apple Move Time (min)',
  stand_hours: 'Apple Stand Hour (hr)',
  stand_min: 'Apple Stand Time (min)',
  hrv_ms: 'Heart Rate Variability (ms)',
  respiratory_rate: 'Respiratory Rate (count/min)',
  resting_hr: 'Resting Heart Rate (bpm)',
  sleep_total_hr: 'Sleep Analysis [Total] (hr)',
  sleep_asleep_hr: 'Sleep Analysis [Asleep] (hr)',
  sleep_in_bed_hr: 'Sleep Analysis [In Bed] (hr)',
  sleep_core_hr: 'Sleep Analysis [Core] (hr)',
  sleep_deep_hr: 'Sleep Analysis [Deep] (hr)',
  sleep_rem_hr: 'Sleep Analysis [REM] (hr)',
  sleep_awake_hr: 'Sleep Analysis [Awake] (hr)',
  steps: 'Step Count (steps)',
  vo2max: 'VO2 Max (ml/(kg·min))',
};
export const HEALTH_METRIC_COLUMNS = Object.keys(HEALTH_FIELDS).filter((f) => f !== 'date');

/** One record per sheet row. Duplicate days are merged on upsert (later non-empty values win). */
export function parseHealthMetrics({ header, rows, firstRowNumber, tab }) {
  const source = 'health_metrics';
  const { index, warnings } = columnIndex(header, HEALTH_FIELDS, source);
  if (index.date < 0) throw new Error('Health metrics sheet has no "Date/Time" column');
  const records = [];
  rows.forEach((row, i) => {
    if (isBlankRow(row)) return;
    const rowNo = firstRowNumber + i;
    const warn = (kind, detail) => warnings.push({ source, tab, row: rowNo, kind, detail });
    const when = row[index.date];
    if (typeof when !== 'number') return warn('missing or text date');
    records.push({ date: serialToDate(when), ...numericFields(row, index, HEALTH_METRIC_COLUMNS, warn) });
  });
  return { records, warnings };
}

// ---- Consolidated Apple Workout Sessions ----
const SESSION_FIELDS = {
  type: 'Type',
  start: 'Start',
  end: 'End',
  duration: 'Duration',
  total_energy_kcal: 'Total Energy (kcal)',
  active_energy_kcal: 'Active Energy (kcal)',
  max_hr: 'Max Heart Rate (bpm)',
  avg_hr: 'Avg Heart Rate (bpm)',
  distance_mi: 'Distance (mi)',
  avg_speed_mph: 'Avg Speed (mi/hr)',
  step_count: 'Step Count (count)',
  step_cadence_spm: 'Step Cadence (spm)',
  swim_stroke_count: 'Swimming Stroke Count (count)',
  swim_stroke_cadence_spm: 'Swim Stoke Cadence (spm)', // Health Auto Export's spelling
  flights_climbed: 'Flights Climbed (count)',
  elevation_up_ft: 'Elevation Ascended (ft)',
  elevation_down_ft: 'Elevation Descended (ft)',
};
const SESSION_NUMBERS = Object.keys(SESSION_FIELDS).filter((f) => !['type', 'start', 'end', 'duration'].includes(f));

// The sheet's Duration cells carry a 3-hour time zone shift from the v1 consolidation (every session since 2018: the
// cell minus 3 hours is the active time, at most the start-to-end span, less when the workout was paused).
// Migration 012 applies the same rule to stored rows.
const DURATION_SHIFT_SEC = 3 * 3600;
const SPAN_SLACK_SEC = 120; // start and end are whole minutes

/**
 * Active seconds of a session from the sheet's Duration (seconds) and its start and end serials: the shifted value
 * repaired, an unshifted value kept, and null when neither fits inside the span (minutes then come from start to end).
 */
export function sessionDuration(rawSec, start, end) {
  const span = Math.round((end - start) * 86400);
  const fits = (s) => s > 0 && s <= span + SPAN_SLACK_SEC;
  if (fits(rawSec - DURATION_SHIFT_SEC)) return rawSec - DURATION_SHIFT_SEC;
  return fits(rawSec) ? rawSec : null;
}

export function parseWorkoutSessions({ header, rows, firstRowNumber, tab }) {
  const source = 'workout_sessions';
  const { index, warnings } = columnIndex(header, SESSION_FIELDS, source);  for (const f of ['type', 'start', 'end']) if (index[f] < 0) throw new Error(`Workout sessions sheet has no "${SESSION_FIELDS[f]}" column`);
  const records = [];
  rows.forEach((row, i) => {
    if (isBlankRow(row)) return;
    const rowNo = firstRowNumber + i;
    const warn = (kind, detail) => warnings.push({ source, tab, row: rowNo, kind, detail });
    const type = text(row[index.type]);
    const start = row[index.start];
    const end = row[index.end];
    if (!type || typeof start !== 'number' || typeof end !== 'number') return warn('missing type, start or end');
    const duration = index.duration >= 0 ? row[index.duration] : null;
    records.push({
      type,
      start: serialToDateTime(start),
      end: serialToDateTime(end),
      duration_sec: typeof duration === 'number' ? sessionDuration(serialToSeconds(duration), start, end) : null,
      ...numericFields(row, index, SESSION_NUMBERS, warn),
    });
  });
  return { records, warnings };
}

// ---- Workout Log (one tab per year) ----
const BAND_COLORS = ['black', 'red', 'purple', 'orange', 'gray', 'grey', 'blue', 'green', 'yellow'];
const BAND = new RegExp(`^(?:band-?)?(${BAND_COLORS.join('|')})(?:band)?$`);

// Typing "12/12" (reps per side) into a Workout Log cell makes Google Sheets store a date, which the
// API returns as a serial number (about 43,000 to 47,000 for 2018 to 2028). No real weight or rep
// count is that large, so such a number is turned back into the text that was typed, month/day.
const DATE_SERIAL = { min: 36526, max: 73051 }; // 2000-01-01 .. 2099-12-31
const typedAsDate = (cell) => typeof cell === 'number' && cell >= DATE_SERIAL.min && cell <= DATE_SERIAL.max;
const asTypedText = (serial) => {
  const [, m, d] = serialToDate(serial).split('-').map(Number);
  return `${m}/${d}`;
};

/** Parses a Weight N cell: pounds, per-hand ("95ea"), a band color, or bodyweight ("bw"). */
export function parseWeight(cell) {
  if (typedAsDate(cell)) return { weight_text: asTypedText(cell), weight_lbs: null, per_hand: 0, band: null, bodyweight: 0 };
  const out = { weight_text: text(cell), weight_lbs: null, per_hand: 0, band: null, bodyweight: 0 };
  if (out.weight_text === null) return out;
  if (typeof cell === 'number') return { ...out, weight_lbs: cell };
  const s = out.weight_text.toLowerCase().replace(/\s+/g, '');
  let m;
  if ((m = /^(\d+(?:\.\d+)?)$/.exec(s))) out.weight_lbs = Number(m[1]);
  else if ((m = /^(\d+(?:\.\d+)?)ea$/.exec(s))) Object.assign(out, { weight_lbs: Number(m[1]), per_hand: 1 });
  else if (s === 'bw') out.bodyweight = 1;
  else if ((m = BAND.exec(s))) out.band = m[1] === 'grey' ? 'gray' : m[1];
  return out;
}

/** Parses a Set N cell: reps, seconds (":30", "30 seconds", "2 minutes") or yards ("40 yards"). */
export function parseSet(cell) {
  if (typedAsDate(cell)) return { reps_text: asTypedText(cell), reps: null, duration_sec: null, distance_yd: null };
  const out = { reps_text: text(cell), reps: null, duration_sec: null, distance_yd: null };
  if (out.reps_text === null) return out;
  if (typeof cell === 'number') return Number.isInteger(cell) ? { ...out, reps: cell } : out;
  const s = out.reps_text.toLowerCase();
  let m;
  if ((m = /^(\d+)$/.exec(s))) out.reps = Number(m[1]);
  else if ((m = /^:(\d+)$/.exec(s))) out.duration_sec = Number(m[1]);
  else if ((m = /^(\d+(?:\.\d+)?)\s*([a-z]+)/.exec(s))) {
    // Units are typed by hand ("secoonds", "miutes"), so match on their first letters.
    const [, amount, unit] = m;
    if (unit.startsWith('se')) out.duration_sec = Math.round(Number(amount));
    else if (unit.startsWith('mi')) out.duration_sec = Math.round(Number(amount) * 60);
    else if (unit.startsWith('y')) out.distance_yd = Number(amount);
  }
  return out;
}

const SET_PAIRS = 8;

/**
 * One tab of the Workout Log. Each non-blank row with an Exercise is one exercise; its
 * Weight N / Set N pairs are its sets. The date is only filled on a workout's first row, so it
 * is carried forward (2026+ tabs have a FilledDate column that already does this). Tabs whose
 * date header is blank or mistyped use the first column. Dates in the wrong year are corrected
 * to the tab's year; text in the date column that is not a date is kept as a note.
 */
export function parseWorkoutLogTab({ header, rows, firstRowNumber, tab }) {
  const source = 'workout_log';
  const tabYear = Number(tab);
  const names = header.map(cleanHeader);
  if (!names.includes('Date') && !names.includes('FilledDate') && !['Prime', 'Exercise'].includes(names[0])) names[0] = 'Date';
  const col = (n) => names.indexOf(n);
  const iDate = col('FilledDate') >= 0 ? col('FilledDate') : col('Date');
  const iRawDate = col('Date');
  const iExercise = col('Exercise');
  if (iDate < 0 || iExercise < 0) throw new Error(`Workout Log tab ${tab} has no date or Exercise column`);

  const exercises = [];
  const notes = [];
  const warnings = [];
  let carried = null;

  rows.forEach((row, i) => {
    if (isBlankRow(row)) return;
    const rowNo = firstRowNumber + i;
    const warn = (kind, detail) => warnings.push({ source, tab, row: rowNo, kind, detail });

    const readDate = (cell) => (typeof cell === 'number' ? serialToDate(cell) : isEmpty(cell) ? null : parseUsDate(cell));
    let date = readDate(row[iDate]);
    if (date) {
      if (Number(date.slice(0, 4)) !== tabYear) {
        const fixed = `${tabYear}${date.slice(4)}`;
        warn('year corrected', `${date} to ${fixed}`);
        date = fixed;
      }
      carried = date;
    }
    const raw = row[iRawDate >= 0 ? iRawDate : iDate];
    if (!isEmpty(raw) && readDate(raw) === null) {
      notes.push({ tab_year: tabYear, row_no: rowNo, date: carried, text: String(raw).trim() });
    }

    const exercise = text(row[iExercise]);
    if (!exercise) return;
    if (!carried) return warn('exercise before the first date');

    const sets = [];
    for (let k = 1; k <= SET_PAIRS; k++) {
      const w = row[col(`Weight ${k}`)];
      const s = row[col(`Set ${k}`)];
      if (isEmpty(w) && isEmpty(s)) continue;
      sets.push({ set_no: k, ...parseWeight(w), ...parseSet(s) });
    }
    exercises.push({
      tab_year: tabYear,
      row_no: rowNo,
      date: carried,
      workout: text(row[col('Workout')]),
      prime: text(row[col('Prime')]),
      exercise,
      post: text(row[col('Post')]),
      comment: text(row[col('Comment')]),
      sets,
    });
  });
  return { records: exercises, notes, warnings };
}

// ---- Drinking Log (one row per day) ----
const DRINK_FIELDS = {
  date: 'Date',
  beers: 'Number of Beers',
  wine: 'Number of glasses of wine',
  bourbon: 'Number of glasses of bourbon',
  other: 'Other Mixed Drink',
  total: 'Total Drinks',
  setting: 'Setting',
  mood_before: 'Mood before Drinking (1-10)',
  mood_after: 'Mood After Drinking (1-10)',
  notes: 'Notes',
};

/** The sheet's Total Drinks is only checked; totals are always computed in code. */
export function parseDrinkingLog({ header, rows, firstRowNumber, tab }) {
  const source = 'drinking_log';
  const { index, warnings } = columnIndex(header, DRINK_FIELDS, source);
  if (index.date < 0) throw new Error('Drinking log has no "Date" column');
  const records = [];
  rows.forEach((row, i) => {
    if (isBlankRow(row)) return;
    const rowNo = firstRowNumber + i;
    const warn = (kind, detail) => warnings.push({ source, tab, row: rowNo, kind, detail });
    if (typeof row[index.date] !== 'number') return warn('missing or text date');
    const n = numericFields(row, index, ['beers', 'wine', 'bourbon', 'other', 'total', 'mood_before', 'mood_after'], warn);
    const counts = { beers: n.beers ?? 0, wine: n.wine ?? 0, bourbon: n.bourbon ?? 0, other: n.other ?? 0 };
    const sum = counts.beers + counts.wine + counts.bourbon + counts.other;
    if (n.total !== null && n.total !== sum) warn('sheet total differs from the sum of drinks');
    records.push({
      date: serialToDate(row[index.date]),
      ...counts,
      setting: text(row[index.setting]),
      mood_before: n.mood_before,
      mood_after: n.mood_after,
      notes: text(row[index.notes]),
    });
  });
  return { records, warnings };
}

// ---- Lab results (tests in rows, one column per draw date) ----

/** Parses a lab cell: numbers (or numeric text) get a value; anything else is kept as text only. */
export function parseLabValue(cell) {
  if (isEmpty(cell)) return null;
  const value_text = String(cell).trim();
  if (!value_text) return null;
  const n = toNumber(cell);
  return { value: n === undefined ? null : n, value_text };
}

const LAB_HEADER_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The lab sheet: A1 "Lab Test", B1.. draw dates. A row with a name and no values is a panel heading
 * when written in capitals (LIPID PANEL); otherwise it is a test with no results yet. Blank rows
 * are skipped. Returns { tests: [{ name, panel, position }], results: [{ test, drawn_on, value, value_text }] }.
 */
export function parseLabSheet({ header, rows, firstRowNumber, tab }) {
  const source = 'lab_results';
  const warnings = [];
  const dateCols = [];
  header.forEach((cell, j) => {
    if (j === 0 || isEmpty(cell)) return;
    const date = typeof cell === 'number' ? serialToDate(cell) : LAB_HEADER_DATE.test(String(cell).trim()) ? String(cell).trim() : parseUsDate(cell);
    if (date) dateCols.push({ j, date });
    else warnings.push({ source, tab, row: 1, kind: 'header is not a date', detail: `column ${j + 1}` });
  });

  const tests = [];
  const results = [];
  const seen = new Set();
  let panel = null;
  rows.forEach((row, i) => {
    const name = text(row?.[0]);
    if (!name) return;
    const values = dateCols.map(({ j, date }) => ({ date, parsed: parseLabValue(row[j]) })).filter((v) => v.parsed);
    if (!values.length && name === name.toUpperCase() && /[A-Z]/.test(name)) {
      panel = name;
      return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      warnings.push({ source, tab, row: firstRowNumber + i, kind: 'duplicate test name (later row skipped)' });
      return;
    }
    seen.add(key);
    tests.push({ name, panel, position: tests.length + 1 });
    for (const { date, parsed } of values) results.push({ test: name, drawn_on: date, ...parsed });
  });
  return { tests, results, warnings };
}

// ---- Weekly Check-In (v1, one row per week) ----
const CHECKIN_FIELDS = {
  date: 'Week Ending (Saturday)',
  readiness: 'Morning Readiness (1-10)',
  energy: 'Avg Energy (1-10)',
  mood: 'Avg Mood (1-10)',
  stress: 'Stress Level (1-10)',
  nutrition: 'Nutrition Quality (1-10)',
  weight_lbs: 'Body Weight (lbs)',
  body_fat_pct: 'Body Fat %',
  muscle_mass_lbs: 'Muscle Mass (lbs)',
  visceral_fat: 'Visceral Fat (rating 1-59)',
  body_measured_on: 'Date of Body Weight',
  notes: 'Notes',
};

export function parseWeeklyCheckins({ header, rows, firstRowNumber, tab }) {
  const source = 'weekly_checkin';
  const { index, warnings } = columnIndex(header, CHECKIN_FIELDS, source);
  if (index.date < 0) throw new Error('Weekly check-in has no "Week Ending (Saturday)" column');
  const records = [];
  rows.forEach((row, i) => {
    if (isBlankRow(row)) return;
    const rowNo = firstRowNumber + i;
    const warn = (kind, detail) => warnings.push({ source, tab, row: rowNo, kind, detail });
    if (typeof row[index.date] !== 'number') return warn('missing or text date');
    const measured = index.body_measured_on >= 0 ? row[index.body_measured_on] : null;
    records.push({
      date: serialToDate(row[index.date]),
      cadence: 'weekly',
      ...numericFields(row, index, ['readiness', 'energy', 'mood', 'stress', 'nutrition', 'weight_lbs', 'body_fat_pct', 'muscle_mass_lbs', 'visceral_fat'], warn),
      body_measured_on: typeof measured === 'number' ? serialToDate(measured) : null,
      notes: text(row[index.notes]),
    });
  });
  return { records, warnings };
}
