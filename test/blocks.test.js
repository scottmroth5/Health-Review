// Program block detection. Synthetic workout names and dates only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBlocks, phaseOf, weekOf } from '../metrics/blocks.js';
import { openHealthStore } from '../db/store.js';
import { detect, writeDetected, sessionCoverage, uuidV5, sessionId } from '../ingest/program-blocks.js';
import { addDays } from '../metrics/stats.js';

// Lifting every other day from start for n sessions; the first day of each week carries the name.
function run(start, n, name) {
  return Array.from({ length: n }, (_, i) => ({ date: addDays(start, i * 2), workout: i % 3 === 0 ? name : null }));
}
const datesOf = (rows) => [...new Set(rows.map((r) => r.date))];

test('blocks: phases parse from numbers, roman numerals and deloads', () => {
  assert.equal(phaseOf('Anabolic Foundation 1 - Phase 3'), 'Phase 3');
  assert.equal(phaseOf('MAPS 15 Advanced Phase II Day 4'), 'Phase 2');
  assert.equal(phaseOf('MAPS Anabolic Advanced Deload'), 'Deload');
  assert.equal(phaseOf('Trigger Session'), null);
  assert.equal(weekOf('2026-01-05', '2026-01-11'), 1);
  assert.equal(weekOf('2026-01-05', '2026-01-12'), 2);
});

test('blocks: a synthetic history splits into its known program runs, phases in notes, between-program stretch kept', () => {
  const rows = [
    ...run('2025-01-06', 12, 'Symmetry Foundation 1 - Phase 1'),
    ...run('2025-01-30', 12, 'Symmetry Foundation 1 - Phase 2'), // same program, next phase: same block
    ...run('2025-02-23', 4, 'In between programs'),
    ...run('2025-03-03', 15, 'Anabolic Foundation 1 - Phase 1'),
  ];
  const d = detectBlocks(rows, datesOf(rows), '2025-12-31');
  assert.deepEqual(d.blocks.map((b) => [b.program, b.start_date, b.end_date, b.sessions.length, b.notes, b.status]), [
    ['MAPS Symmetry', '2025-01-06', '2025-02-21', 24, 'Phases: Phase 1, Phase 2', 'completed'],
    ['Between programs', '2025-02-23', '2025-03-01', 4, null, 'completed'],
    ['MAPS Anabolic', '2025-03-03', '2025-03-31', 15, 'Phases: Phase 1', 'completed'],
  ]);
  assert.deepEqual(d.unassigned, []);
});

test('blocks: a gap of 21 days or more ends a block; shorter breaks do not', () => {
  const rows = [
    ...run('2025-01-06', 6, 'Aesthetic Foundation - Phase 1'),
    { date: '2025-01-30', workout: 'Aesthetic Foundation - Phase 2' }, // 14 days after the last session: same block
    { date: '2025-02-25', workout: 'Aesthetic Foundation - Phase 1' }, // 26 days later: a new run
  ];
  const d = detectBlocks(rows, datesOf(rows), '2025-12-31');
  assert.deepEqual(d.blocks.map((b) => [b.program, b.start_date, b.sessions.length]), [
    ['MAPS Aesthetic', '2025-01-06', 7], ['MAPS Aesthetic', '2025-02-25', 1],
  ]);
});

test('blocks: unnamed days join a block only between its own days; others are unassigned; trigger sessions follow the program', () => {
  const rows = [
    { date: '2025-01-01', workout: 'Getting back at it' }, // no program anywhere near: unassigned
    { date: '2025-01-20', workout: 'Trigger Session' }, // the program starts 3 days later
    { date: '2025-01-23', workout: 'Powerlift - Phase I' },
    { date: '2025-02-04', workout: null }, // 12 days on: beyond the 7-day back-fill, but between two Powerlift days
    { date: '2025-02-06', workout: 'Powerlift - Phase II' },
    { date: '2025-02-16', workout: null }, // after the last named day and the fill: no later Powerlift day
  ];
  const d = detectBlocks(rows, datesOf(rows), '2025-12-31');
  assert.deepEqual(d.blocks.map((b) => [b.program, b.sessions, b.notes]), [
    ['MAPS Powerlift', ['2025-01-20', '2025-01-23', '2025-02-04', '2025-02-06'], 'Phases: Phase 1, Phase 2'],
  ]);
  assert.deepEqual(d.unassigned, ['2025-01-01', '2025-02-16']);
});

test('blocks: a run whose last session is within 14 days of today is in progress with no end date', () => {
  const rows = run('2026-03-02', 5, 'Anabolic Foundation 1 - Phase 1');
  const [b] = detectBlocks(rows, datesOf(rows), '2026-03-20').blocks;
  assert.deepEqual([b.status, b.end_date, b.last_session], ['in_progress', null, '2026-03-10']);
});

function seedLog(db, rows) {
  const ex = db.prepare('INSERT INTO strength_exercises (tab_year, row_no, date, workout, exercise) VALUES (?, ?, ?, ?, ?)');
  const set = db.prepare("INSERT INTO strength_sets (exercise_id, set_no, weight_lbs, reps, reps_text) VALUES (?, 1, 100, 5, '5')");
  rows.forEach((r, i) => set.run(ex.run(Number(r.date.slice(0, 4)), i + 2, r.date, r.workout, 'Squat').lastInsertRowid));
}

test('blocks: saving a detection twice adds nothing; confirmed blocks and their sessions survive re-detection', () => {
  const store = openHealthStore(':memory:');
  const db = store.db;
  seedLog(db, [...run('2025-01-06', 6, 'Symmetry Foundation 1 - Phase 1'), ...run('2025-03-03', 6, 'Anabolic Foundation 1 - Phase 1'),
    { date: '2025-06-01', workout: 'Getting back at it' }]);
  const today = '2025-12-31';
  writeDetected(db, detect(db, today));
  writeDetected(db, detect(db, today));
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.deepEqual([count('program_blocks'), count('log_sessions')], [2, 13]);
  assert.deepEqual(sessionCoverage(db, today), { liftingDays: 13, confirmed: 0, unassigned: 1, detected: 12, missing: 0 });
  assert.equal(db.prepare("SELECT id FROM log_sessions WHERE date = '2025-01-06'").get().id, sessionId('2025-01-06'));

  // The owner confirms the first block (the review command does this in the next step).
  const first = db.prepare("SELECT id FROM program_blocks WHERE program = 'MAPS Symmetry'").get().id;
  db.prepare("UPDATE program_blocks SET source = 'confirmed', notes = 'kept' WHERE id = ?").run(first);
  db.prepare("UPDATE log_sessions SET source = 'confirmed' WHERE block_id = ?").run(first);
  writeDetected(db, detect(db, today));
  assert.deepEqual(db.prepare('SELECT program, source, notes FROM program_blocks ORDER BY start_date').all(), [
    { program: 'MAPS Symmetry', source: 'confirmed', notes: 'kept' },
    { program: 'MAPS Anabolic', source: 'detected', notes: 'Phases: Phase 1' },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM log_sessions WHERE block_id = ?").get(first).n, 6);
  assert.deepEqual(sessionCoverage(db, today), { liftingDays: 13, confirmed: 6, unassigned: 1, detected: 6, missing: 0 });
  store.close();
});

test('blocks: session ids are UUID v5, stable for a date and distinct across dates', () => {
  const id = uuidV5('session:2025-01-06');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, sessionId('2025-01-06'));
  assert.notEqual(id, sessionId('2025-01-07'));
});

test('blocks: add-on stretches (HIIT) between two parts of one block join it and are noted; phases listed once', () => {
  const rows = [
    { date: '2026-06-01', workout: 'In between programs' }, { date: '2026-06-03', workout: null },
    { date: '2026-06-04', workout: 'HIIT workout' },
    { date: '2026-06-05', workout: 'In between programs' },
    { date: '2026-06-08', workout: 'HIIT' }, { date: '2026-06-09', workout: 'HIIT' },
    { date: '2026-06-10', workout: 'In between programs' },
    { date: '2026-07-20', workout: 'HIIT' }, // 40 days on: its own block
    ...run('2026-08-03', 6, 'Symmetry Foundation 1 - Phase 1'), { date: '2026-08-20', workout: 'Symmetry Foundation 1 - Phase 2' },
    { date: '2026-08-22', workout: 'Symmetry Foundation 1 - Phase 1' },
  ];
  const d = detectBlocks(rows, datesOf(rows), '2026-12-31');
  assert.deepEqual(d.blocks.map((b) => [b.program, b.sessions.length, b.notes]), [
    ['Between programs', 7, 'includes 3 HIIT sessions'],
    ['HIIT', 1, null],
    ['MAPS Symmetry', 8, 'Phases: Phase 1, Phase 2'],
  ]);
});
