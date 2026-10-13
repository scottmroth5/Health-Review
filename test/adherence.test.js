// Called for vs logged: workout name parsing and GET /api/program/adherence. Synthetic values only (the full
// comparison is pinned by evals/fixtures/metrics/adherence.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { createCatalog } from '../metrics/catalog.js';
import { createDictionary } from '../metrics/dictionary.js';
import { workoutNumber, isFocusSession } from '../metrics/adherence.js';

test('workoutNumber: the number in logged and catalog workout names', () => {
  assert.deepEqual(workoutNumber('Symmetry Foundation 2 - Phase 4'), { from: 2, to: 2 });
  assert.deepEqual(workoutNumber('Symmetry Foundation 2- Phase 3'), { from: 2, to: 2 });
  assert.deepEqual(workoutNumber('Anabolic Foundational 1 - Phase 2'), { from: 1, to: 1 });
  assert.deepEqual(workoutNumber('Anywhere Foundational Workout 2'), { from: 2, to: 2 });
  assert.deepEqual(workoutNumber('MAPS 15 Advanced Phase I Day 4'), { from: 4, to: 4 });
  assert.deepEqual(workoutNumber('Day 3: back, biceps, abs'), { from: 3, to: 3 });
  assert.deepEqual(workoutNumber('Workouts 1-3'), { from: 1, to: 3 });
  assert.deepEqual(workoutNumber('Sample Strength Phase 1 Day B'), { from: 2, to: 2 });
  assert.equal(workoutNumber('In between programs'), null);
  assert.equal(workoutNumber('Workout in between programs'), null);
  assert.equal(isFocusSession('Symmetry Focus Sesssion 1 (Quads)'), true);
  assert.equal(isFocusSession('Trigger Session'), true);
  assert.equal(isFocusSession('Symmetry Foundation 1 - Phase 4'), false);
});

const catalog = createCatalog({ version: 1, programs: [{ name: 'MAPS Symmetry', weeks: 2, phases: [
  { name: 'Phase 1', weeks: [1, 2], sets: '3', reps: '5', workouts: [
    { name: 'Workout 1', exercises: [{ name: 'Squat' }, { name: 'Row' }] },
    { name: 'Workout 2', exercises: [{ name: 'Press' }] }] }] }] }, { programs: ['MAPS Symmetry'] });
const dictionary = createDictionary({ version: 1, exercises: [
  { id: 'squat', name: 'Squat', implement: 'barbell', pattern: 'squat', primary: true },
  { id: 'row', name: 'Row', implement: 'dumbbell', pattern: 'horizontal pull', primary: false },
  { id: 'press', name: 'Press', implement: 'barbell', pattern: 'vertical press', primary: true },
] });
const TODAY = new Date(2026, 2, 9, 12, 0);

function seed(db) {
  const now = new Date().toISOString();
  const block = db.prepare(`INSERT INTO program_blocks (id, program, start_date, end_date, status, source, created_at, updated_at)
    VALUES (?, 'MAPS Symmetry', ?, ?, ?, 'confirmed', ?, ?)`);
  block.run('b-old', '2026-01-05', '2026-01-20', 'completed', now, now);
  block.run('b-now', '2026-03-02', null, 'in_progress', now, now);
  const session = db.prepare(`INSERT INTO log_sessions (id, date, block_id, assignment, program, week, source, updated_at, phase)
    VALUES (?, ?, ?, 'block', 'MAPS Symmetry', ?, 'forward', ?, 'Phase 1')`);
  session.run('s1', '2026-03-02', 'b-now', 1, now);
  session.run('s2', '2026-03-12', 'b-now', 2, now); // after today: left out
  session.run('s3', '2026-01-06', 'b-old', 1, now);
  const ex = db.prepare(`INSERT INTO strength_exercises (tab_year, row_no, date, workout, exercise, canonical_id, implement, movement_pattern)
    VALUES (2026, ?, ?, ?, ?, ?, ?, ?)`);
  const set = db.prepare('INSERT INTO strength_sets (exercise_id, set_no, weight_lbs, reps) VALUES (?, ?, 100, ?)');
  const add = (row, date, workout, name, id, implement, pattern, reps) => {
    const { lastInsertRowid } = ex.run(row, date, workout, name, id, implement, pattern);
    reps.forEach((r, i) => set.run(lastInsertRowid, i + 1, r));
  };
  add(1, '2026-03-02', 'Symmetry Foundation 1 - Phase 1', 'Squats', 'squat', 'barbell', 'squat', [5, 5, 5]);
  add(2, '2026-03-02', null, 'Row', 'row', 'dumbbell', 'horizontal pull', [5, 5]);
  add(3, '2026-03-12', 'Symmetry Foundation 2 - Phase 1', 'Press', 'press', 'barbell', 'vertical press', [5, 5, 5]);
  add(4, '2026-01-06', 'Symmetry Foundation 2 - Phase 1', 'Press', 'press', 'barbell', 'vertical press', [5, 5, 5]);
}

test('api: called for vs logged for the block in progress by default, another block by id', async () => {
  const store = openHealthStore(':memory:');
  seed(store.db);
  const app = await buildApp({ store, clock: () => TODAY, catalog, dictionary, substitutions: { swaps: [] } });

  const a = (await app.inject('/api/program/adherence')).json();
  assert.equal(a.available, true);
  assert.equal(a.block.id, 'b-now');
  assert.deepEqual(a.blocks.map((b) => b.id), ['b-now', 'b-old']);
  assert.deepEqual(a.coverage, { days: 1, matched: 1, focus: 0, notMatched: 0 });
  const [s] = a.weeks[0].sessions;
  assert.equal(s.catalogWorkout, 'Workout 1');
  assert.deepEqual(s.counts, { as_called: 2, swapped: 0, changed: 0, skipped: 0, added: 0 });
  assert.deepEqual(s.rows.map((r) => r.setsStatus), ['within', 'under']);

  const old = (await app.inject('/api/program/adherence?block=b-old')).json();
  assert.equal(old.block.id, 'b-old');
  assert.equal(old.weeks[0].sessions[0].catalogWorkout, 'Workout 2');

  assert.equal((await app.inject('/api/program/adherence?block=nope')).statusCode, 404);
  await app.close();
  store.close();
});

test('api: called for vs logged without a catalog, and with no confirmed block', async () => {
  const store = openHealthStore(':memory:');
  const none = await buildApp({ store, clock: () => TODAY, catalog: null });
  assert.deepEqual((await none.inject('/api/program/adherence')).json(), { available: false });
  await none.close();
  const empty = await buildApp({ store, clock: () => TODAY, catalog, dictionary, substitutions: { swaps: [] } });
  assert.deepEqual((await empty.inject('/api/program/adherence')).json(), { available: true, blocks: [], block: null });
  await empty.close();
  store.close();
});
