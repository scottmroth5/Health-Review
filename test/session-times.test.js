// The consolidated Workout Sessions sheet ran 3 hours late; the one-off fix of stored rows. Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { fixSessionTimes, moveHours } from '../ingest/session-times.js';

const EXPORT_STAMP = '2026-10-15T16:10:54.853Z';
const SHEET_STAMP = '2026-10-15T11:00:03.386Z';

function seed() {
  const store = openHealthStore(':memory:');
  const add = store.db.prepare(`INSERT INTO workout_sessions (type, start, end, duration_sec, updated_at) VALUES (?, ?, ?, 600, ?)`);
  store.db.prepare(`INSERT INTO drive_exports (file_id, kind, name, modified_time, rows, synced_at) VALUES ('w1', 'workouts', 'Workout session metrics-a', 'x', 2, ?)`).run(EXPORT_STAMP);
  add.run('Walk', '2026-10-13T11:00:00', '2026-10-13T11:30:00', EXPORT_STAMP); // from the export files: right
  add.run('Walk', '2026-10-13T14:00:00', '2026-10-13T14:30:00', SHEET_STAMP); // its late twin from the sheet
  add.run('Run', '2026-09-01T07:00:00', '2026-09-01T07:40:00', SHEET_STAMP); // sheet only: moves to 04:00
  add.run('Elliptical', '2026-08-02T01:30:00', '2026-08-02T02:00:00', SHEET_STAMP); // sheet only: moves to Aug 1, 22:30
  add.run('Swim', '2026-10-14T09:00:00', '2026-10-14T09:45:00', EXPORT_STAMP); // export only: stays
  return store;
}
const all = (store) => store.db.prepare('SELECT type, start, end FROM workout_sessions ORDER BY start').all().map((r) => `${r.type} ${r.start}-${r.end.slice(11)}`);

test('moveHours shifts a local wall-clock time across midnight', () => {
  assert.equal(moveHours('2026-08-02T01:30:00', -3), '2026-08-01T22:30:00');
  assert.equal(moveHours('2026-03-01T07:00:00', -3), '2026-03-01T04:00:00');
});

test('the fix: a dry run counts and changes nothing', () => {
  const store = seed();
  const before = all(store);
  assert.deepEqual(fixSessionTimes(store), { total: 5, fromExports: 2, lateTwins: 1, toMove: 2, movedToEarlierDate: 1, collisions: 0, alreadyApplied: false, applied: false });
  assert.deepEqual(all(store), before);
  store.close();
});

test('the fix: late twins are deleted, other sheet workouts move back 3 hours, export workouts stay; never twice', () => {
  const store = seed();
  assert.equal(fixSessionTimes(store, { apply: true }).applied, true);
  assert.deepEqual(all(store), [
    'Elliptical 2026-08-01T22:30:00-23:00:00',
    'Run 2026-09-01T04:00:00-04:40:00',
    'Walk 2026-10-13T11:00:00-11:30:00',
    'Swim 2026-10-14T09:00:00-09:45:00',
  ]);
  assert.equal(fixSessionTimes(store).alreadyApplied, true);
  assert.throws(() => fixSessionTimes(store, { apply: true }), /already applied/);
  store.close();
});

test('the fix: a move that would land on an export workout of the same type and start is refused', () => {
  const store = seed();
  // A sheet row 3 hours after an export row with the same start but a different end: not a twin, and a clash if moved.
  store.db.prepare(`INSERT INTO workout_sessions (type, start, end, duration_sec, updated_at) VALUES ('Swim', '2026-10-14T12:00:00', '2026-10-14T12:50:00', 600, ?)`).run(SHEET_STAMP);
  assert.equal(fixSessionTimes(store).collisions, 1);
  const before = all(store);
  assert.throws(() => fixSessionTimes(store, { apply: true }), /would land on stored ones/);
  assert.deepEqual(all(store), before);
  store.close();
});
