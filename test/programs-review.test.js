// Reviewing program blocks: confirm, edit, merge, split, unassign. Synthetic names and dates only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOwnerStore } from '../db/store.js';
import {
  ReviewError, confirmBlocks, detect, editBlock, findBlock, listBlocks, mergeBlocks, sessionCoverage, splitBlock,
  unassignDays, writeDetected,
} from '../ingest/program-blocks.js';
import { addDays } from '../metrics/stats.js';

const TODAY = '2025-12-31';
const opts = { today: TODAY };

// Two programs a week apart, every other day; then an unnamed day long after.
async function setup() {
  const store = openOwnerStore(':memory:');
  const db = store.db;
  const adb = store.adb;
  const ex = db.prepare('INSERT INTO strength_exercises (user_id, tab_year, row_no, date, workout, exercise) VALUES (@uid, 2025, ?, ?, ?, ?)');
  const set = db.prepare("INSERT INTO strength_sets (user_id, exercise_id, set_no, weight_lbs, reps, reps_text) VALUES (@uid, ?, 1, 100, 5, '5')");
  let row = 2;
  const day = (date, workout) => set.run(ex.run(row++, date, workout, 'Squat').lastInsertRowid);
  for (let i = 0; i < 8; i++) day(addDays('2025-01-06', i * 2), i % 3 === 0 ? 'Symmetry Foundation 1 - Phase 1' : null); // Jan 6 to Jan 20
  for (let i = 0; i < 8; i++) day(addDays('2025-01-27', i * 2), i % 3 === 0 ? 'Anabolic Foundation 1 - Phase 1' : null); // Jan 27 to Feb 10
  day('2025-06-01', 'Getting back at it');
  await writeDetected(adb, await detect(adb, TODAY));
  const ids = Object.fromEntries((await listBlocks(adb)).map((b) => [b.program, b.id]));
  return { store, db, adb, sym: ids['MAPS Symmetry'], ana: ids['MAPS Anabolic'] };
}
const sessions = (db, id) => db.prepare('SELECT date, week, program, source FROM log_sessions WHERE block_id = ? ORDER BY date').all(id);

test('review: confirming a block confirms its sessions; all-detected confirms the rest; blocks are found by id prefix', async () => {
  const { store, db, adb, sym } = await setup();
  assert.equal((await findBlock(adb, sym.slice(0, 8))).id, sym);
  await assert.rejects(() => findBlock(adb, 'zzzz'), ReviewError);
  assert.equal(await confirmBlocks(adb, sym.slice(0, 8), opts), 1);
  assert.ok(sessions(db, sym).every((s) => s.source === 'confirmed'));
  assert.equal((await listBlocks(adb, { unconfirmed: true })).length, 1);
  assert.equal(await confirmBlocks(adb, 'all-detected', opts), 1);
  assert.deepEqual(await sessionCoverage(adb, TODAY), { liftingDays: 17, confirmed: 16, unassigned: 1, detected: 0, missing: 0 });
  store.close();
});

test('review: editing dates moves sessions in and out and renumbers weeks; bad edits are refused', async () => {
  const { store, db, adb, sym, ana } = await setup();
  await editBlock(adb, ana, { start: '2025-02-02', status: 'abandoned', notes: 'stopped early' }, opts);
  const a = sessions(db, ana);
  assert.deepEqual([a[0].date, a[0].week, a.length], ['2025-02-02', 1, 5]);
  assert.equal(db.prepare("SELECT assignment FROM log_sessions WHERE date = '2025-01-27'").get().assignment, 'unassigned');
  assert.deepEqual(db.prepare('SELECT status, notes FROM program_blocks WHERE id = ?').get(ana), { status: 'abandoned', notes: 'stopped early' });
  await assert.rejects(() => editBlock(adb, sym, { end: '2024-01-01' }, opts), /end is before the start/);
  await assert.rejects(() => editBlock(adb, sym, { status: 'paused' }, opts), /Status must be one of/);
  await assert.rejects(() => editBlock(adb, sym, { end: '' }, opts), /Only an in-progress block/);
  store.close();
});

test('review: confirmed blocks may not overlap', async () => {
  const { store, db, adb, sym, ana } = await setup();
  await confirmBlocks(adb, 'all-detected', opts);
  await assert.rejects(() => editBlock(adb, sym, { end: '2025-02-01' }, opts), /Overlaps confirmed block/);
  store.close();
});

test('review: merge joins two blocks and their sessions; split makes a new block from a date on', async () => {
  const { store, db, adb, sym, ana } = await setup();
  const merged = await mergeBlocks(adb, sym, ana, opts);
  assert.deepEqual([merged.start_date, merged.end_date], ['2025-01-06', '2025-02-10']);
  assert.equal(sessions(db, sym).length, 16);
  assert.equal((await listBlocks(adb)).length, 1);
  assert.equal(sessions(db, sym)[15].week, 6, 'weeks renumbered from the merged start');

  const second = await splitBlock(adb, sym, '2025-01-27', opts);
  assert.deepEqual([sessions(db, sym).length, sessions(db, second).length], [8, 8]);
  assert.deepEqual(db.prepare('SELECT end_date FROM program_blocks WHERE id = ?').get(sym), { end_date: '2025-01-20' });
  assert.equal(sessions(db, second)[0].week, 1);
  await assert.rejects(() => splitBlock(adb, second, '2025-01-27', opts), /does not fall between two sessions/);
  store.close();
});

test('review: unassigned days are confirmed, survive re-detection, and are not pulled back into a block', async () => {
  const { store, db, adb, sym } = await setup();
  assert.equal(await unassignDays(adb, '2025-01-18', '2025-01-20', opts), 2);
  await confirmBlocks(adb, sym, opts);
  assert.equal(sessions(db, sym).length, 6);
  await writeDetected(adb, await detect(adb, TODAY));
  assert.deepEqual(db.prepare("SELECT assignment, source FROM log_sessions WHERE date = '2025-01-20'").get(), { assignment: 'unassigned', source: 'confirmed' });
  assert.equal((await sessionCoverage(adb, TODAY)).unassigned, 3);
  store.close();
});

test('forward: new lifting days join the in-progress confirmed block with program and week; nothing without one', async () => {
  const { runSync } = await import('../ingest/sync.js');
  const { assignForward } = await import('../ingest/program-blocks.js');
  const { fakeSource, serial, silentLogger } = await import('./helpers.js');
  const store = openOwnerStore(':memory:');
  const db = store.db;
  const adb = store.adb;
  const LOG = ['Date', 'Prime', 'Exercise', 'Weight 1', 'Set 1', 'Workout'];
  const data = {
    workout_log: { 2026: [LOG, [serial('2026-03-02'), '', 'Squat', 100, 5, 'Symmetry Foundation 1 - Phase 1']] },
  };
  const source = fakeSource(data);
  const sync = (date) => runSync({ store, source, now: new Date(`${date}T07:00:00`), logger: silentLogger, dictionary: null, catalog: null });
  await sync('2026-03-03');
  assert.deepEqual(await assignForward(adb, '2026-03-03'), { assigned: 0, block: null }, 'no confirmed block yet');

  await writeDetected(adb, await detect(adb, '2026-03-03'));
  await confirmBlocks(adb, 'all-detected', { today: '2026-03-03' });
  data.workout_log[2026].push([serial('2026-03-10'), '', 'Squat', 100, 5, ''], [serial('2026-03-17'), '', 'Squat', 100, 5, '']);
  const { counts } = await sync('2026-03-17');
  assert.deepEqual(counts.sessions, { assigned: 2, block: 'MAPS Symmetry' });
  assert.deepEqual(db.prepare("SELECT date, program, week, source FROM log_sessions WHERE source = 'forward' ORDER BY date").all(), [
    { date: '2026-03-10', program: 'MAPS Symmetry', week: 2, source: 'forward' },
    { date: '2026-03-17', program: 'MAPS Symmetry', week: 3, source: 'forward' },
  ]);
  await writeDetected(adb, await detect(adb, '2026-03-17'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM log_sessions WHERE source = 'forward'").get().n, 2, 're-detection keeps forward sessions');
  store.close();
});

test('phases: sessions take the logged phase; status reports phase week, program week and finish from the names', async () => {
  const { createCatalog } = await import('../metrics/catalog.js');
  const { refreshPhases, blockStatus, currentProgram } = await import('../ingest/program-blocks.js');
  const catalog = createCatalog({ version: 1, programs: [{ name: 'MAPS Symmetry', weeks: 4, phases: [
    { name: 'Phase 1', weeks: [1, 2] }, { name: 'Phase 2', weeks: [3, 4], special_weeks: { deload: [4] } }] }] }, { programs: ['MAPS Symmetry', 'MAPS Anabolic'] });
  const { store, db, adb, sym, ana } = await setup(); // Symmetry Jan 6 to Jan 20, every name "Phase 1"; Anabolic Jan 27 to Feb 10
  await refreshPhases(adb, catalog);
  assert.ok(db.prepare('SELECT phase FROM log_sessions WHERE block_id = ?').all(sym).every((r) => r.phase === 'Phase 1'), 'named Phase 1 throughout');
  assert.equal(db.prepare('SELECT program_weeks FROM program_blocks WHERE id = ?').get(sym).program_weeks, 4);
  assert.equal(db.prepare('SELECT program_weeks FROM program_blocks WHERE id = ?').get(ana).program_weeks, null, 'not in the catalog');

  const done = await blockStatus(adb, await findBlock(adb, sym), TODAY, catalog);
  assert.deepEqual([done.phase, done.phase_week, done.week, done.percent, done.earliest_finish], ['Phase 1', 3, 2, 50, null]);

  await editBlock(adb, sym, { status: 'in_progress' }, { today: '2025-01-21' });
  await confirmBlocks(adb, sym, { today: '2025-01-21' });
  const now = await currentProgram(adb, '2025-01-21', catalog);
  assert.deepEqual([now.phase, now.phase_started, now.week, now.earliest_finish, now.days_left], ['Phase 1', '2025-01-06', 2, '2025-02-02', 12]);
  const noCatalog = await currentProgram(adb, '2025-01-21', null);
  assert.deepEqual([noCatalog.phase, noCatalog.week, noCatalog.earliest_finish], ['Phase 1', null, null], 'names still give the phase');
  store.close();
});
