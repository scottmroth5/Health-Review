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
