import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialToDate, serialToDateTime, serialToSeconds, parseUsDate } from '../ingest/serial.js';
import {
  parseHealthMetrics,
  parseWorkoutSessions,
  parseWorkoutLogTab,
  parseWeight,
  parseSet,
  parseDrinkingLog,
  parseWeeklyCheckins,
} from '../ingest/parsers.js';
import { serial } from './helpers.js';

const at = (header, rows) => ({ header, rows, firstRowNumber: 2, tab: 'Sheet1' });

// ---- serial dates ----
test('serials convert to wall-clock text without time zone shifts', () => {
  assert.equal(serialToDateTime(serial('2026-03-02', 6, 15)), '2026-03-02T06:15:00');
  assert.equal(serialToDate(serial('2026-03-02', 3)), '2026-03-02');
  assert.equal(serialToDate(serial('2026-03-02', 23, 59, 59)), '2026-03-02');
  assert.equal(serialToSeconds(37.5 / 1440), 2250);
});

test('US text dates parse; invalid ones are null', () => {
  assert.equal(parseUsDate('03/07/2021'), '2021-03-07');
  assert.equal(parseUsDate('3/7/2021'), '2021-03-07');
  assert.equal(parseUsDate('02/30/2021'), null);
  assert.equal(parseUsDate('Vacation'), null);
});

// ---- health metrics ----
const HEALTH_HEADER = ['Date/Time', 'Heart Rate Variability (ms)', 'Resting Heart Rate (bpm)', 'Step Count (steps)', '', 3197];

test('health rows map known columns; stray headers are reported once', () => {
  const { records, warnings } = parseHealthMetrics(at(HEALTH_HEADER, [[serial('2026-03-02', 3), 48.5, 55, 8123]]));
  assert.equal(records.length, 1);
  assert.equal(records[0].date, '2026-03-02');
  assert.equal(records[0].hrv_ms, 48.5);
  assert.equal(records[0].resting_hr, 55);
  assert.equal(records[0].steps, 8123);
  assert.equal(records[0].vo2max, null, 'a column the sheet does not have is null');
  assert.deepEqual(warnings.map((w) => [w.kind, w.detail]), [['unknown column', '3197']]);
});

test('health rows without a numeric date are skipped with a warning; bad numbers become null', () => {
  const { records, warnings } = parseHealthMetrics(at(HEALTH_HEADER, [['not a date', 1, 2, 3], [serial('2026-03-03', 3), 'n/a', 54, 9000], []]));
  assert.equal(records.length, 1);
  assert.equal(records[0].hrv_ms, null);
  const kinds = warnings.filter((w) => w.row).map((w) => [w.row, w.kind]);
  assert.deepEqual(kinds, [[2, 'missing or text date'], [3, 'not a number']]);
});

// ---- workout sessions ----
test('workout sessions keep full start and end times and convert duration to seconds', () => {
  const header = ['Type', 'Start', 'End', 'Duration', 'Avg Heart Rate (bpm)', 'Swim Stoke Cadence (spm)'];
  const { records } = parseWorkoutSessions(at(header, [['Outdoor Run', serial('2026-03-02', 6, 15), serial('2026-03-02', 6, 52, 30), 37.5 / 1440, 148.2]]));
  assert.deepEqual(
    { type: records[0].type, start: records[0].start, end: records[0].end, duration_sec: records[0].duration_sec, avg_hr: records[0].avg_hr },
    { type: 'Outdoor Run', start: '2026-03-02T06:15:00', end: '2026-03-02T06:52:30', duration_sec: 2250, avg_hr: 148.2 },
  );
});

// ---- workout log ----
test('weights: pounds, per hand, bands, bodyweight, and unparsed text kept as text', () => {
  assert.deepEqual(parseWeight(135), { weight_text: '135', weight_lbs: 135, per_hand: 0, band: null, bodyweight: 0 });
  assert.equal(parseWeight('95ea').weight_lbs, 95);
  assert.equal(parseWeight('95 ea').per_hand, 1);
  assert.equal(parseWeight('Band-Black').band, 'black');
  assert.equal(parseWeight('band-blackband').band, 'black');
  assert.equal(parseWeight('Orange').band, 'orange');
  assert.equal(parseWeight('BW').bodyweight, 1);
  assert.deepEqual(parseWeight('24"'), { weight_text: '24"', weight_lbs: null, per_hand: 0, band: null, bodyweight: 0 });
  assert.equal(parseWeight('').weight_text, null);
});

test('sets: reps, seconds, minutes (with typos), yards; other text kept as text', () => {
  assert.equal(parseSet(10).reps, 10);
  assert.equal(parseSet('12').reps, 12);
  assert.equal(parseSet(':30').duration_sec, 30);
  assert.equal(parseSet('45 seconds').duration_sec, 45);
  assert.equal(parseSet('30 secoonds').duration_sec, 30);
  assert.equal(parseSet('2 miutes').duration_sec, 120);
  assert.equal(parseSet('40 yards').distance_yd, 40);
  assert.deepEqual(parseSet('10/10'), { reps_text: '10/10', reps: null, duration_sec: null, distance_yd: null });
  assert.equal(parseSet('x').reps, null);
});

const LOG_HEADER = ['Date', 'Prime', 'Exercise', 'Weight 1', 'Set 1', 'Weight 2', 'Set 2', 'Post', 'Workout', 'Comment'];

test('workout log carries the date down to every exercise of a workout', () => {
  const { records, warnings } = parseWorkoutLogTab({
    header: LOG_HEADER, firstRowNumber: 2, tab: '2024',
    rows: [
      [serial('2024-03-04'), 'A1', 'Squat', 135, 5, 155, 5, '', 'Legs A'],
      ['', 'A2', 'Plank', '', ':45'],
      [],
      [serial('2024-03-06'), '', 'Bench', '65ea', 10],
    ],
  });
  assert.deepEqual(records.map((r) => [r.row_no, r.date, r.exercise, r.sets.length]), [
    [2, '2024-03-04', 'Squat', 2], [3, '2024-03-04', 'Plank', 1], [5, '2024-03-06', 'Bench', 1],
  ]);
  assert.equal(records[0].workout, 'Legs A');
  assert.equal(records[1].sets[0].duration_sec, 45);
  assert.equal(records[2].sets[0].per_hand, 1);
  assert.deepEqual(warnings, []);
});

test('workout log: a blank or mistyped date header means the first column is the date', () => {
  for (const first of ['', 'o']) {
    const { records } = parseWorkoutLogTab({ header: [first, ...LOG_HEADER.slice(1)], firstRowNumber: 2, tab: '2025', rows: [[serial('2025-01-06'), '', 'Row', 50, 10]] });
    assert.equal(records[0].date, '2025-01-06', `header ${JSON.stringify(first)}`);
  }
});

test('workout log: FilledDate is used when present', () => {
  const { records } = parseWorkoutLogTab({
    header: ['FilledDate', ...LOG_HEADER], firstRowNumber: 2, tab: '2026',
    rows: [[serial('2026-02-02'), serial('2026-02-02'), '', 'Deadlift', 225, 3], [serial('2026-02-02'), '', '', 'Row', 50, 10]],
  });
  assert.deepEqual(records.map((r) => r.date), ['2026-02-02', '2026-02-02']);
});

test('workout log: dates in the wrong year are corrected to the tab year with a warning', () => {
  const { records, warnings } = parseWorkoutLogTab({ header: LOG_HEADER, firstRowNumber: 2, tab: '2022', rows: [[serial('2021-01-10'), '', 'Squat', 135, 5]] });
  assert.equal(records[0].date, '2022-01-10');
  assert.deepEqual(warnings.map((w) => [w.row, w.kind, w.detail]), [[2, 'year corrected', '2021-01-10 to 2022-01-10']]);
});

test('workout log: text dates parse; other text in the date column becomes a note', () => {
  const { records, notes } = parseWorkoutLogTab({
    header: LOG_HEADER, firstRowNumber: 2, tab: '2021',
    rows: [[serial('2021-05-01'), '', 'Squat', 135, 5], ['Vacation'], ['05/10/2021', '', 'Bench', 135, 5]],
  });
  assert.deepEqual(notes, [{ tab_year: 2021, row_no: 3, date: '2021-05-01', text: 'Vacation' }]);
  assert.deepEqual(records.map((r) => r.date), ['2021-05-01', '2021-05-10']);
});

test('workout log: exercises before any date are skipped with a warning', () => {
  const { records, warnings } = parseWorkoutLogTab({ header: LOG_HEADER, firstRowNumber: 2, tab: '2024', rows: [['', '', 'Squat', 135, 5]] });
  assert.equal(records.length, 0);
  assert.deepEqual(warnings.map((w) => w.kind), ['exercise before the first date']);
});

// ---- drinking log and check-ins ----
const DRINK_HEADER = ['Date', 'Number of Beers', 'Number of glasses of wine', 'Number of glasses of bourbon', 'Other Mixed Drink', 'Total Drinks', 'Setting', 'Mood before Drinking (1-10)', 'Mood After Drinking (1-10)', 'Notes'];

test('drinking days: counts default to zero, zero-drink days are kept, a wrong sheet total is flagged', () => {
  const { records, warnings } = parseDrinkingLog(at(DRINK_HEADER, [
    [serial('2026-03-06'), 2, 1, 0, 0, 3, 'Dinner out', 7, 8, 'fun'],
    [serial('2026-03-07'), 0, 0, 0, 0, 0],
    [serial('2026-03-08'), 1, '', '', '', 2],
  ]));
  assert.deepEqual(records.map((r) => [r.date, r.beers + r.wine + r.bourbon + r.other]), [['2026-03-06', 3], ['2026-03-07', 0], ['2026-03-08', 1]]);
  assert.equal(records[0].mood_after, 8);
  assert.equal(records[1].setting, null);
  assert.deepEqual(warnings.map((w) => [w.row, w.kind]), [[4, 'sheet total differs from the sum of drinks']]);
});

test('weekly check-ins: trailing space in the header is tolerated; rows are weekly', () => {
  const header = ['Week Ending (Saturday) ', 'Morning Readiness (1-10)', 'Avg Energy (1-10)', 'Avg Mood (1-10)', 'Stress Level (1-10)', 'Nutrition Quality (1-10)', 'Body Weight (lbs)', 'Body Fat %', 'Muscle Mass (lbs)', 'Visceral Fat (rating 1-59)', 'Date of Body Weight', 'Notes'];
  const { records, warnings } = parseWeeklyCheckins(at(header, [[serial('2026-03-07'), 7, 6, 8, 4, 7, 180.5, 18, 140, 9, serial('2026-03-05'), 'ok week']]));
  assert.deepEqual(warnings, []);
  assert.equal(records[0].date, '2026-03-07');
  assert.equal(records[0].cadence, 'weekly');
  assert.equal(records[0].weight_lbs, 180.5);
  assert.equal(records[0].body_measured_on, '2026-03-05');
});

// ---- lab sheet ----
test('lab sheet: panels from capitalized rows, one result per draw column, text values kept, bad header dates warned', async () => {
  const { parseLabSheet } = await import('../ingest/parsers.js');
  const { tests, results, warnings } = parseLabSheet({
    header: ['Lab Test', serial('2026-03-23'), '09/15/2025', 'next time'],
    firstRowNumber: 2,
    tab: 'Sheet1',
    rows: [
      ['LIPID PANEL'],
      ['Cholesterol', 165, 180],
      ['LDL Calculated', 84, ''],
      [],
      ['OTHER'],
      ['PSA', '0.6', '<0.5'],
      ['Homocysteine'],
      ['psa', 1, 1],
    ],
  });
  assert.deepEqual(tests, [
    { name: 'Cholesterol', panel: 'LIPID PANEL', position: 1 },
    { name: 'LDL Calculated', panel: 'LIPID PANEL', position: 2 },
    { name: 'PSA', panel: 'OTHER', position: 3 },
    { name: 'Homocysteine', panel: 'OTHER', position: 4 },
  ]);
  assert.deepEqual(results, [
    { test: 'Cholesterol', drawn_on: '2026-03-23', value: 165, value_text: '165' },
    { test: 'Cholesterol', drawn_on: '2025-09-15', value: 180, value_text: '180' },
    { test: 'LDL Calculated', drawn_on: '2026-03-23', value: 84, value_text: '84' },
    { test: 'PSA', drawn_on: '2026-03-23', value: 0.6, value_text: '0.6' },
    { test: 'PSA', drawn_on: '2025-09-15', value: null, value_text: '<0.5' },
  ]);
  assert.deepEqual(warnings.map((w) => [w.row, w.kind]), [[1, 'header is not a date'], [9, 'duplicate test name (later row skipped)']]);
});

test('workout log: "12/12" typed into a set or weight cell (stored by Sheets as a date) is kept as that text, not a huge number', () => {
  const dec12 = serial('2026-12-12');
  assert.deepEqual(parseSet(dec12), { reps_text: '12/12', reps: null, duration_sec: null, distance_yd: null });
  assert.deepEqual(parseWeight(dec12), { weight_text: '12/12', weight_lbs: null, per_hand: 0, band: null, bodyweight: 0 });
  assert.equal(parseSet(serial('2018-03-05')).reps_text, '3/5');
  assert.equal(parseSet(250).reps, 250, 'ordinary large counts are untouched');
  assert.equal(parseWeight(495).weight_lbs, 495);
});
