// Normalizing the Workout Log against the exercise dictionary. Synthetic names and values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { createDictionary } from '../metrics/dictionary.js';
import { normalizeAll, unmappedNames } from '../ingest/normalize.js';
import { runSync } from '../ingest/sync.js';
import { fakeSource, serial, silentLogger } from './helpers.js';

const DICT = createDictionary({
  version: 1,
  exercises: [
    { id: 'barbell-squat', name: 'Barbell Squat', implement: 'barbell', pattern: 'squat', primary: true, variants: ['Squat'] },
    { id: 'dumbbell-row', name: 'Dumbbell Row', implement: 'dumbbell', pattern: 'horizontal pull', primary: false },
  ],
  ignore: ['superset'],
});

function seed(db) {
  const ex = db.prepare('INSERT INTO strength_exercises (tab_year, row_no, date, exercise) VALUES (?, ?, ?, ?)');
  const set = db.prepare('INSERT INTO strength_sets (exercise_id, set_no, weight_lbs, reps) VALUES (?, ?, 100, 5)');
  const add = (row, date, name, sets) => {
    const id = ex.run(2026, row, date, name).lastInsertRowid;
    for (let i = 1; i <= sets; i++) set.run(id, i);
  };
  add(2, '2026-03-02', 'Squats', 3);
  add(3, '2026-03-02', 'Dumbell Rows', 2);
  add(4, '2026-03-04', 'Cable Fly', 2); // implement word, no entry
  add(5, '2026-03-04', 'Zercher Thing', 1); // nothing to go on
  add(6, '2026-03-04', 'superset', 0);
  add(7, '2026-03-06', 'Barbell Squat', 2);
}

const columns = (db) => db.prepare(`SELECT exercise, canonical_id, implement, movement_pattern, is_primary, map_status
  FROM strength_exercises ORDER BY row_no`).all();

test('normalize: writes canonical exercise, implement, pattern and status next to the raw name', () => {
  const store = openHealthStore(':memory:');
  seed(store.db);
  const c = normalizeAll(store.db, DICT, { now: new Date('2026-03-07T12:00:00Z') });
  assert.deepEqual(columns(store.db), [
    { exercise: 'Squats', canonical_id: 'barbell-squat', implement: 'barbell', movement_pattern: 'squat', is_primary: 1, map_status: 'mapped' },
    { exercise: 'Dumbell Rows', canonical_id: 'dumbbell-row', implement: 'dumbbell', movement_pattern: 'horizontal pull', is_primary: 0, map_status: 'mapped' },
    { exercise: 'Cable Fly', canonical_id: null, implement: 'cable', movement_pattern: null, is_primary: 0, map_status: 'inferred' },
    { exercise: 'Zercher Thing', canonical_id: null, implement: null, movement_pattern: null, is_primary: 0, map_status: 'unmapped' },
    { exercise: 'superset', canonical_id: null, implement: null, movement_pattern: null, is_primary: 0, map_status: 'ignored' },
    { exercise: 'Barbell Squat', canonical_id: 'barbell-squat', implement: 'barbell', movement_pattern: 'squat', is_primary: 1, map_status: 'mapped' },
  ]);
  assert.deepEqual([c.sets, c.mappedSets, c.mappedPct], [10, 7, 70]);
  assert.equal(store.db.prepare('SELECT normalized_at FROM strength_exercises LIMIT 1').get().normalized_at, '2026-03-07T12:00:00.000Z');
  store.close();
});

test('normalize: rerunning changes nothing and adds no rows; a dictionary change is picked up', () => {
  const store = openHealthStore(':memory:');
  seed(store.db);
  normalizeAll(store.db, DICT);
  const first = columns(store.db);
  const rows = (t) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const before = [rows('strength_exercises'), rows('strength_sets')];
  normalizeAll(store.db, DICT);
  assert.deepEqual(columns(store.db), first);
  assert.deepEqual([rows('strength_exercises'), rows('strength_sets')], before);

  const more = createDictionary({ version: 1, exercises: [...DICT.exercises,
    { id: 'cable-fly', name: 'Cable Fly', implement: 'cable', pattern: 'horizontal press', primary: false }] });
  normalizeAll(store.db, more);
  assert.equal(columns(store.db)[2].map_status, 'mapped');
  store.close();
});

test('normalize: unmapped names are listed by variant group with set counts and years, most sets first', () => {
  const store = openHealthStore(':memory:');
  seed(store.db);
  store.db.prepare("INSERT INTO strength_exercises (tab_year, row_no, date, exercise) VALUES (2025, 9, '2025-05-01', 'Cable Flyes')").run();
  normalizeAll(store.db, DICT);
  assert.deepEqual(unmappedNames(store.db).map((g) => [g.spellings.sort(), g.status, g.sets, g.first, g.last]), [
    [['Cable Fly', 'Cable Flyes'], 'inferred', 2, 2025, 2026],
    [['Zercher Thing'], 'unmapped', 1, 2026, 2026],
  ]);
  store.close();
});

test('normalize: sync rewrites the normalized columns after a Workout Log tab is replaced', async () => {
  const store = openHealthStore(':memory:');
  const LOG = ['Date', 'Prime', 'Exercise', 'Weight 1', 'Set 1'];
  const data = {
    health_metrics: { Sheet1: [['Date/Time']] }, workout_sessions: { Sheet1: [['Type', 'Start', 'End']] },
    workout_log: { 2026: [LOG, [serial('2026-03-02'), '', 'Squats', 100, 5]] },
  };
  const source = fakeSource(data);
  const sync = () => runSync({ store, source, now: new Date(2026, 2, 9), logger: silentLogger, dictionary: DICT, catalog: null });
  const first = await sync();
  assert.equal(first.counts.normalized.mappedPct, 100);
  data.workout_log[2026].push([serial('2026-03-04'), '', 'Dumbbell Row', 50, 8]);
  await sync();
  assert.deepEqual(store.db.prepare('SELECT exercise, canonical_id FROM strength_exercises ORDER BY row_no').all(),
    [{ exercise: 'Squats', canonical_id: 'barbell-squat' }, { exercise: 'Dumbbell Row', canonical_id: 'dumbbell-row' }]);
  const unchanged = await sync();
  assert.equal(unchanged.counts.normalized, undefined, 'no tab replaced: nothing to rewrite');
  store.close();
});
