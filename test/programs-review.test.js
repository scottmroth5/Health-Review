// Reviewing program blocks: confirm, edit, merge, split, unassign. Synthetic names and dates only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import {
  ReviewError, confirmBlocks, detect, editBlock, findBlock, listBlocks, mergeBlocks, sessionCoverage, splitBlock,
  unassignDays, writeDetected,
} from '../ingest/program-blocks.js';
import { addDays } from '../metrics/stats.js';

const TODAY = '2025-12-31';
const opts = { today: TODAY };

// Two programs a week apart, every other day; then an unnamed day long after.
function setup() {
  const store = openHealthStore(':memory:');
  const db = store.db;
  const ex = db.prepare('INSERT INTO strength_exercises (tab_year, row_no, date, workout, exercise) VALUES (2025, ?, ?, ?, ?)');
  const set = db.prepare("INSERT INTO strength_sets (exercise_id, set_no, weight_lbs, reps, reps_text) VALUES (?, 1, 100, 5, '5')");
  let row = 2;
  const day = (date, workout) => set.run(ex.run(row++, date, workout, 'Squat').lastInsertRowid);
  for (let i = 0; i < 8; i++) day(addDays('2025-01-06', i * 2), i % 3 === 0 ? 'Symmetry Foundation 1 - Phase 1' : null); // Jan 6 to Jan 20
  for (let i = 0; i < 8; i++) day(addDays('2025-01-27', i * 2), i % 3 === 0 ? 'Anabolic Foundation 1 - Phase 1' : null); // Jan 27 to Feb 10
  day('2025-06-01', 'Getting back at it');
  writeDetected(db, detect(db, TODAY));
  const ids = Object.fromEntries(listBlocks(db).map((b) => [b.program, b.id]));
  return { store, db, sym: ids['MAPS Symmetry'], ana: ids['MAPS Anabolic'] };
}
const sessions = (db, id) => db.prepare('SELECT date, week, program, source FROM log_sessions WHERE block_id = ? ORDER BY date').all(id);

test('review: confirming a block confirms its sessions; all-detected confirms the rest; blocks are found by id prefix', () => {
  const { store, db, sym } = setup();
  assert.equal(findBlock(db, sym.slice(0, 8)).id, sym);
  assert.throws(() => findBlock(db, 'zzzz'), ReviewError);
  assert.equal(confirmBlocks(db, sym.slice(0, 8), opts), 1);
  assert.ok(sessions(db, sym).every((s) => s.source === 'confirmed'));
  assert.equal(listBlocks(db, { unconfirmed: true }).length, 1);
  assert.equal(confirmBlocks(db, 'all-detected', opts), 1);
  assert.deepEqual(sessionCoverage(db, TODAY), { liftingDays: 17, confirmed: 16, unassigned: 1, detected: 0, missing: 0 });
  store.close();
});

test('review: editing dates moves sessions in and out and renumbers weeks; bad edits are refused', () => {
  const { store, db, sym, ana } = setup();
  editBlock(db, ana, { start: '2025-02-02', status: 'abandoned', notes: 'stopped early' }, opts);
  const a = sessions(db, ana);
  assert.deepEqual([a[0].date, a[0].week, a.length], ['2025-02-02', 1, 5]);
  assert.equal(db.prepare("SELECT assignment FROM log_sessions WHERE date = '2025-01-27'").get().assignment, 'unassigned');
  assert.deepEqual(db.prepare('SELECT status, notes FROM program_blocks WHERE id = ?').get(ana), { status: 'abandoned', notes: 'stopped early' });
  assert.throws(() => editBlock(db, sym, { end: '2024-01-01' }, opts), /end is before the start/);
  assert.throws(() => editBlock(db, sym, { status: 'paused' }, opts), /Status must be one of/);
  assert.throws(() => editBlock(db, sym, { end: '' }, opts), /Only an in-progress block/);
  store.close();
});

test('review: confirmed blocks may not overlap', () => {
  const { store, db, sym, ana } = setup();
  confirmBlocks(db, 'all-detected', opts);
  assert.throws(() => editBlock(db, sym, { end: '2025-02-01' }, opts), /Overlaps confirmed block/);
  store.close();
});

test('review: merge joins two blocks and their sessions; split makes a new block from a date on', () => {
  const { store, db, sym, ana } = setup();
  const merged = mergeBlocks(db, sym, ana, opts);
  assert.deepEqual([merged.start_date, merged.end_date], ['2025-01-06', '2025-02-10']);
  assert.equal(sessions(db, sym).length, 16);
  assert.equal(listBlocks(db).length, 1);
  assert.equal(sessions(db, sym)[15].week, 6, 'weeks renumbered from the merged start');

  const second = splitBlock(db, sym, '2025-01-27', opts);
  assert.deepEqual([sessions(db, sym).length, sessions(db, second).length], [8, 8]);
  assert.deepEqual(db.prepare('SELECT end_date FROM program_blocks WHERE id = ?').get(sym), { end_date: '2025-01-20' });
  assert.equal(sessions(db, second)[0].week, 1);
  assert.throws(() => splitBlock(db, second, '2025-01-27', opts), /does not fall between two sessions/);
  store.close();
});

test('review: unassigned days are confirmed, survive re-detection, and are not pulled back into a block', () => {
  const { store, db, sym } = setup();
  assert.equal(unassignDays(db, '2025-01-18', '2025-01-20', opts), 2);
  confirmBlocks(db, sym, opts);
  assert.equal(sessions(db, sym).length, 6);
  writeDetected(db, detect(db, TODAY));
  assert.deepEqual(db.prepare("SELECT assignment, source FROM log_sessions WHERE date = '2025-01-20'").get(), { assignment: 'unassigned', source: 'confirmed' });
  assert.equal(sessionCoverage(db, TODAY).unassigned, 3);
  store.close();
});
