// Metric fixtures (evals/fixtures/metrics) hold synthetic inputs with hand-computed expectations
// (see each file's notes). Every metric change must keep these passing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';
import { computeWeek } from '../metrics/index.js';
import { loadWeekData, loadMetricSettings } from '../metrics/load.js';
import { round, mean, sd, pearson, lastWeekEnd, windows } from '../metrics/stats.js';
import { sessionKind } from '../metrics/cardio.js';
import { medicationEvents } from '../metrics/medications.js';
import { trainingView } from '../metrics/volume.js';
import { exerciseKey, exerciseName } from '../metrics/exercises.js';
import { volumeByExercise } from '../metrics/volume.js';
import { strength } from '../metrics/strength.js';
import { vo2maxReport } from '../metrics/vo2max.js';
import { openHealthStore } from '../db/store.js';
import { saveSettings } from '../server/queries.js';

/** Every key in expected must match actual; arrays must match in length and order. */
function assertSubset(actual, expected, path = '') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} should be an array`);
    assert.equal(actual.length, expected.length, `${path} length`);
    expected.forEach((e, i) => assertSubset(actual[i], e, `${path}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${path} should be an object`);
    for (const [k, v] of Object.entries(expected)) assertSubset(actual[k], v, `${path}.${k}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

const EMPTY = { daily_metrics: [], workout_sessions: [], strength_sets: [], drinking_days: [], checkins: [] };
const dir = repoPath('evals', 'fixtures', 'metrics');

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  test(`fixture ${file}: ${fx.description}`, () => {
    const result = computeWeek({ ...EMPTY, ...fx.input }, { weekEnd: fx.weekEnd, ...fx.options });
    assertSubset(result, fx.expected);
    // Dashboard views (training volume): expected values per view, and the number of bars.
    for (const [view, expected] of Object.entries(fx.views ?? {})) {
      const v = trainingView(fx.input.strength_sets, view, fx.today);
      assertSubset(v, expected, view);
      assert.equal(v.buckets.length, fx.viewBucketCounts[view], `${view} bucket count`);
    }
  });
}

test('rounding is half away from zero and never returns -0', () => {
  assert.equal(round(2.5), 3);
  assert.equal(round(-2.5), -3);
  assert.equal(round(6.875, 1), 6.9);
  assert.equal(round(-0.04, 1), 0);
  assert.equal(round(null), null);
});

test('mean and sd skip missing values; sd needs two values', () => {
  assert.equal(mean([1, null, 3]), 2);
  assert.equal(mean([]), null);
  assert.equal(sd([5]), null);
  assert.equal(round(sd([48, 52, 48, 52]), 3), 2.309);
});

test('pearson needs enough pairs and variation on both sides', () => {
  const up = Array.from({ length: 10 }, (_, i) => [i, 2 * i + 1]);
  assert.equal(round(pearson(up), 6), 1);
  assert.equal(round(pearson(up.map(([a, b]) => [a, -b])), 6), -1);
  assert.equal(pearson(up.slice(0, 9)), null);
  assert.equal(pearson(up.map(([a]) => [a, 5])), null);
});

test('the review week ends on the most recent Saturday before today', () => {
  assert.equal(lastWeekEnd('2026-03-08'), '2026-03-07'); // Sunday
  assert.equal(lastWeekEnd('2026-03-09'), '2026-03-07'); // Monday
  assert.equal(lastWeekEnd('2026-03-07'), '2026-02-28'); // Saturday: that week is not over
  assert.deepEqual(windows('2026-03-07').baseline, { from: '2026-02-01', to: '2026-02-28' });
});

test('session kinds: strength and core, mobility, everything else is cardio', () => {
  assert.equal(sessionKind('Traditional Strength Training'), 'strength');
  assert.equal(sessionKind('Functional Strength Training'), 'strength');
  assert.equal(sessionKind('Yoga'), 'mobility');
  for (const t of ['Outdoor Walk', 'Elliptical', 'High Intensity Interval Training', 'Hiking', 'Cross Training']) assert.equal(sessionKind(t), 'cardio');
});

test('medication events: start, change on the same day as a stop, stop, and a later restart', () => {
  const meds = [{ id: 1, name: 'Creatine', kind: 'supplement' }];
  const p = (id, dose, started_on, stopped_on = null) => ({ id, medication_id: 1, dose, timings: '["daily"]', started_on, stopped_on, stop_reason: null });
  const events = medicationEvents(meds, [p(3, '5 g', '2026-05-01'), p(1, '3 g', '2026-01-01', '2026-02-01'), p(2, '5 g', '2026-02-01', '2026-03-01')]);
  assert.deepEqual(events.map((e) => [e.date, e.type, e.from?.dose ?? null, e.to?.dose ?? null]), [
    ['2026-01-01', 'start', null, '3 g'],
    ['2026-02-01', 'change', '3 g', '5 g'],
    ['2026-03-01', 'stop', '5 g', null],
    ['2026-05-01', 'start', null, '5 g'],
  ]);
});

test('medication events: an estimated start is not an event, but a later change is', () => {
  const meds = [{ id: 1, name: 'Fish oil', kind: 'supplement' }];
  const periods = [
    { id: 1, medication_id: 1, dose: '1 g', timings: '["morning"]', started_on: '2026-01-01', stopped_on: '2026-04-01', start_estimated: 1 },
    { id: 2, medication_id: 1, dose: '2 g', timings: '["morning"]', started_on: '2026-04-01', stopped_on: null, start_estimated: 0 },
  ];
  assert.deepEqual(medicationEvents(meds, periods).map((e) => [e.date, e.type]), [['2026-04-01', 'change']]);
});

test('without a Zone 2 range, Zone 2 is reported as unset rather than zero', () => {
  const r = computeWeek(EMPTY, { weekEnd: '2026-03-07' });
  assert.deepEqual(r.cardio.zone2, { range: null, sessions: null, minutes: null, belowSessions: null, aboveSessions: null });
});

test('from the database: settings, joined strength sets, and planned sets left out', () => {
  const store = openHealthStore(':memory:');
  const { db } = store;
  assert.equal(loadMetricSettings(db).zone2, null);
  saveSettings(db, { zone2_low_bpm: 110, zone2_high_bpm: 125 });
  assert.deepEqual(loadMetricSettings(db).zone2, { low: 110, high: 125 });

  const ex = db.prepare("INSERT INTO strength_exercises (tab_year, row_no, date, exercise) VALUES (2026, ?, ?, ?)");
  const set = db.prepare('INSERT INTO strength_sets (exercise_id, set_no, weight_lbs, per_hand, reps, reps_text) VALUES (?, 1, ?, ?, ?, ?)');
  set.run(ex.run(2, '2026-03-03', 'Squat').lastInsertRowid, 175, 0, 3, '3');
  set.run(ex.run(3, '2026-03-06', 'Deadlift').lastInsertRowid, 225, 0, null, null); // planned
  set.run(ex.run(4, '2026-03-09', 'Squat').lastInsertRowid, 185, 0, 5, '5'); // after the week
  db.prepare("INSERT INTO daily_metrics (date, hrv_ms, updated_at) VALUES ('2026-03-02', 50, 'x'), ('2026-03-08', 60, 'x')").run();

  const data = loadWeekData(db, '2026-03-07');
  assert.equal(data.strength_sets.length, 2, 'rows after the week are not loaded');
  assert.equal(data.daily_metrics.length, 2, 'the morning after the week is loaded for next-morning recovery');
  const result = computeWeek(data, { weekEnd: '2026-03-07', ...loadMetricSettings(db) });
  assert.deepEqual([result.strength.week.sets, result.strength.week.volumeLbs], [1, 525]);
  assert.equal(result.recovery.hrv_ms.mean, 50, 'the morning after the week is not part of the week');
  store.close();
});

test('programs: workout names map to programs; specific names win; notes and one-offs map to nothing', async () => {
  const { programOf } = await import('../metrics/programs.js');
  assert.equal(programOf('Anabolic Foundation 1 - Phase 3'), 'MAPS Anabolic');
  assert.equal(programOf('MAPS Anabolic Advanced Phase 1 Day 1'), 'MAPS Anabolic Advanced');
  assert.equal(programOf('Symmetry Foundation 1 - Performance Mobility Session 1'), 'MAPS Symmetry', 'not MAPS Performance');
  assert.equal(programOf('HITT workout. 23 minutes'), 'HIIT');
  assert.equal(programOf('Trigger Session'), null);
  assert.equal(programOf('do 155'), null);
  assert.equal(programOf(null), null);
});

test('programs: unnamed days take the program from up to 7 days before; Trigger Sessions also look ahead', async () => {
  const { programsByDay } = await import('../metrics/programs.js');
  const sets = [
    { date: '2026-03-02', workout: 'Symmetry Foundation 1' },
    { date: '2026-03-03', workout: null },
    { date: '2026-03-12', workout: null }, // 10 days after the last named day: unknown
    { date: '2026-04-01', workout: 'Trigger Session' }, // a program starts 3 days later
    { date: '2026-04-04', workout: 'Anabolic Foundation 1 - Phase 1' },
  ];
  const byDay = programsByDay(sets, ['2026-03-02', '2026-03-03', '2026-03-12', '2026-04-01', '2026-04-04']);
  assert.deepEqual(Object.fromEntries(byDay), {
    '2026-03-02': 'MAPS Symmetry',
    '2026-03-03': 'MAPS Symmetry',
    '2026-03-12': null,
    '2026-04-01': 'MAPS Anabolic',
    '2026-04-04': 'MAPS Anabolic',
  });
});

test('programs: each dashboard bar lists its programs by days, and the days with none', () => {
  const S = (date, workout) => ({ date, exercise: 'Squat', workout, set_no: 1, weight_lbs: 100, per_hand: 0, reps: 5 });
  const v = trainingView([S('2026-03-02', 'Symmetry Foundation 1'), S('2026-03-03', null), S('2026-03-05', 'In between programs'), S('2026-02-01', null)], 'month', '2026-03-07');
  const week = v.buckets.filter((b) => b.programs.length || b.noProgramDays);
  assert.deepEqual(week.map((b) => [b.start, b.programs, b.noProgramDays]), [
    ['2026-03-02', [{ name: 'MAPS Symmetry', days: 1 }], 0],
    ['2026-03-03', [{ name: 'MAPS Symmetry', days: 1 }], 0],
    ['2026-03-05', [{ name: 'Between programs', days: 1 }], 0],
  ]);
  const year = trainingView([S('2026-03-02', 'Symmetry Foundation 1'), S('2026-03-03', null), S('2026-03-05', 'In between programs')], 'year', '2026-03-07');
  assert.deepEqual(year.buckets.at(-1).programs, [{ name: 'MAPS Symmetry', days: 2 }, { name: 'Between programs', days: 1 }]);
});

test('exercise names: spelling, plural, hyphen, typo and word-order variants share a key', () => {
  const same = (...names) => assert.equal(new Set(names.map(exerciseKey)).size, 1, names.join(' / '));
  const differ = (a, b) => assert.notEqual(exerciseKey(a), exerciseKey(b), `${a} vs ${b}`);
  same('Pullups', 'Pull ups', 'Pull-ups', 'Pullup', ' pull  UP ');
  same('Dumbell Shrugs', 'Dumbbell Shrug');
  same('Decline Sit-ups', 'Decline Situps', 'decline sit up');
  same('Incline Dumbbell Press', 'Dumbbell Incline Press');
  same('Dumbbell Flyes', 'Dumbbell Fly', 'Dumbbell Flys', 'Dumbbell Flies');
  same('Reverse Crunches', 'Reverse Crunch');
  same('Handcuff w/ Rotation', 'handcuff with rotation');
  assert.equal(exerciseKey('Press'), 'press', 'a double s is not a plural');
  differ('Barbell Front Squat', 'Front Squat');
  differ('Dumbbell Shoulder Press', 'Barbell Shoulder Press');
});

test('exercise names: listed lifts merge under one name; others show their most used spelling', () => {
  const same = (...names) => assert.equal(new Set(names.map(exerciseKey)).size, 1, names.join(' / '));
  same('Barbell Bench Press', 'Bench Press', 'Barbell Bench');
  same('Barbell Squat', 'Barbell Squats', 'Barbell Back Squat', 'Squats');
  same('Barbell Deadlift', 'Barbell Deadlifts', 'Deadlift', 'Deadlifts');
  same('Barbell Z Press', 'Barbell Z-Press', 'Z Press', 'Z-Press');
  same('Incline Barbell Bench Press', 'Incline Bench', 'Barbell Incline Bench Press', 'Incline Press', 'Barbell Incline Chest Press');
  assert.equal(exerciseName(exerciseKey('Bench Press'), [{ exercise: 'Bench Press', date: '2026-03-01' }]), 'Barbell Bench Press');
  const rows = [
    { exercise: 'Pull-ups', date: '2026-01-01' }, { exercise: 'Pullups', date: '2026-02-01' },
    { exercise: 'Pullups', date: '2026-02-02' }, { exercise: 'Pull ups', date: '2026-03-01' },
  ];
  assert.equal(exerciseName(exerciseKey('Pullups'), rows), 'Pullups');
  assert.equal(exerciseName(exerciseKey('Pullups'), rows.slice(0, 2).concat(rows.slice(3))), 'Pull ups', 'a tie goes to the latest');
});

test('exercise names: volume by exercise and the strength summary merge variant names', () => {
  const S = (date, exercise, weight, reps) => ({ date, exercise, set_no: 1, weight_lbs: weight, per_hand: 0, reps });
  const sets = [S('2026-03-02', 'Bench Press', 100, 5), S('2026-03-04', 'Barbell Bench', 100, 5), S('2026-03-06', 'Pull-ups', 0, 8),
    S('2026-03-06', 'Deadlifts', 200, 5), S('2026-03-07', 'Barbell Deadlift', 200, 5)];
  const byEx = volumeByExercise(sets, { from: '2026-03-01', to: '2026-03-07' });
  assert.deepEqual(byEx.map((e) => [e.exercise, e.volumeLbs, e.sets]), [['Barbell Deadlift', 2000, 2], ['Barbell Bench Press', 1000, 2]]);
  const st = strength(sets, '2026-03-07');
  assert.equal(st.week.exercises, 3);
  assert.deepEqual(st.exercises.map((e) => [e.exercise, e.sessions]).sort(), [['Barbell Bench Press', 2], ['Barbell Deadlift', 2], ['Pull-ups', 1]]);
});

test('VO2 max: readings for short views; weekly and monthly averages for long ones; empty buckets left out', () => {
  const R = (date, vo2max) => ({ date, vo2max });
  const rows = [
    R('2025-03-01', 40), R('2025-06-02', 42), R('2025-06-30', 44),
    R('2026-02-20', 45), R('2026-02-21', 46), // same week (ends Sat Feb 21)
    R('2026-03-02', 47), R('2026-03-04', 48), R('2026-03-05', null), R('2026-03-20', 50.04), R('2026-04-01', 99),
  ];
  const today = '2026-03-21';
  const d90 = vo2maxReport(rows, '90d', today);
  assert.equal(d90.bucket, 'reading');
  assert.deepEqual(d90.range, { from: '2025-12-22', to: today });
  assert.deepEqual(d90.points.map((p) => [p.date, p.value]), [['2026-02-20', 45], ['2026-02-21', 46], ['2026-03-02', 47], ['2026-03-04', 48], ['2026-03-20', 50]]);
  assert.equal(d90.readings, 5);
  assert.equal(d90.rangeAvg, 47.2);

  const y2 = vo2maxReport(rows, '2y', today);
  assert.equal(y2.bucket, 'week');
  const feb = y2.points.find((p) => p.date === '2026-02-15');
  assert.deepEqual([feb.value, feb.n, feb.label], [45.5, 2, 'Week ending Feb 21, 2026']);
  assert.equal(y2.points.length, 6, 'one point per week with readings; empty weeks are not zeros');

  const all = vo2maxReport(rows, 'all', today);
  assert.equal(all.bucket, 'month');
  assert.equal(all.range.from, '2025-03-01');
  assert.deepEqual(all.points.map((p) => [p.date, p.value, p.n]), [
    ['2025-03-01', 40, 1], ['2025-06-01', 43, 2], ['2026-02-01', 45.5, 2], ['2026-03-01', 48.3, 3],
  ]);
  assert.equal(all.points[0].label, 'Mar 2025');
  assert.equal(vo2maxReport(rows, '5y', today).range.from, '2021-03-01');
});

test('VO2 max: latest, changes vs the nearest earlier reading within 30 days, and best on record', () => {
  const R = (date, vo2max) => ({ date, vo2max });
  const today = '2026-03-21';
  const r = vo2maxReport([R('2025-03-01', 40), R('2025-12-10', 44), R('2026-03-20', 47), R('2026-03-30', 60)], '1y', today);
  assert.deepEqual(r.latest, { date: '2026-03-20', value: 47 }, 'future readings are ignored');
  assert.deepEqual(r.change90d, { value: 3, from: { date: '2025-12-10', value: 44 } }); // today-90 is 2025-12-21
  assert.deepEqual(r.change1y, { value: 7, from: { date: '2025-03-01', value: 40 } }, 'the reading before 2025-03-21 is 20 days older: within 30 days');
  assert.deepEqual(vo2maxReport([R('2025-02-01', 40), R('2026-03-20', 47)], '1y', today).change1y, null, 'more than 30 days older: none');
  assert.deepEqual(r.best, { date: '2026-03-20', value: 47 });
  assert.throws(() => vo2maxReport([], 'week', today));
  const none = vo2maxReport([], '90d', today);
  assert.deepEqual([none.latest, none.best, none.rangeAvg, none.points], [null, null, null, []]);
});
