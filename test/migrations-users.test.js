// Migrations 024 and 025 on a database built before users: every row is kept, every row becomes the owner's, foreign
// keys and the integrity check pass, and an insert that forgets user_id fails. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@scottmroth5/agent-core';
import { MIGRATIONS } from '../db/migrations.js';
import { openHealthStore } from '../db/store.js';
import { OWNER_ID } from '../db/users.js';
import { USER_TABLES } from '../db/migrations-users.js';

test('024 and 025: rows kept and given to the owner, children intact, user_id required from then on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-users-mig-'));
  const path = join(dir, 'h.db');
  try {
    const before = MIGRATIONS.slice(0, MIGRATIONS.findIndex((m) => m.id === '024-users')); // the database before users
    const old = openStore(path, { app: 'health-review', migrations: before });
    const x = 'x';
    old.db.exec(`
      INSERT INTO daily_metrics (date, steps, updated_at) VALUES ('2026-01-01', 1000, '${x}'), ('2026-01-02', 2000, '${x}');
      INSERT INTO checkins (date, cadence, readiness, source, updated_at) VALUES ('2026-01-01', 'daily', 7, 'ui', '${x}');
      INSERT INTO medications (id, name, kind, created_at) VALUES (1, 'Test Item', 'supplement', '${x}');
      INSERT INTO medication_periods (medication_id, dose, timings, started_on, created_at) VALUES (1, '1 g', '["morning"]', '2026-01-01', '${x}');
      INSERT INTO medication_doses (date, medication_id, timing, taken, updated_at) VALUES ('2026-01-01', 1, 'morning', 1, '${x}');
      INSERT INTO lab_tests (id, name, created_at) VALUES (1, 'Test Lab', '${x}');
      INSERT INTO lab_results (test_id, drawn_on, value, value_text, source, updated_at) VALUES (1, '2026-01-01', 5, '5', 'ui', '${x}');
      INSERT INTO strength_exercises (id, tab_year, row_no, date, exercise) VALUES (1, 2026, 2, '2026-01-01', 'Squat');
      INSERT INTO strength_sets (exercise_id, set_no, reps) VALUES (1, 1, 5), (1, 2, 5);
      INSERT INTO program_blocks (id, program, start_date, status, source, created_at, updated_at) VALUES ('b1', 'P', '2026-01-01', 'in_progress', 'confirmed', '${x}', '${x}');
      INSERT INTO log_sessions (id, date, block_id, assignment, source, updated_at) VALUES ('s1', '2026-01-01', 'b1', 'block', 'confirmed', '${x}');
      INSERT INTO runs (name, started_at) VALUES ('sync', '${x}');
    `);
    const count = (db, t) => db.prepare(`SELECT COUNT(*) FROM "${t}"`).pluck().get();
    // The tables 025 rebuilt (later user tables, like user_programs, did not exist yet).
    const rebuilt = USER_TABLES.filter((t) => old.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    const counts = Object.fromEntries(rebuilt.map((t) => [t, count(old.db, t)]));
    old.close();

    const store = openHealthStore(path);
    for (const t of rebuilt) {
      assert.equal(count(store.db, t), counts[t], `${t} keeps its rows`);
      assert.equal(store.db.prepare(`SELECT COUNT(*) FROM "${t}" WHERE user_id <> ?`).pluck().get(OWNER_ID), 0, `${t} rows are the owner's`);
    }
    assert.equal(store.db.prepare('SELECT user_id FROM runs').pluck().get(), OWNER_ID);
    assert.equal(store.db.prepare("SELECT role || '/' || status FROM users WHERE id = ?").pluck().get(OWNER_ID), 'admin/approved');
    assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
    assert.throws(() => store.db.prepare("INSERT INTO checkins (date, cadence, source, updated_at) VALUES ('2026-02-01', 'daily', 'ui', 'x')").run(), /NOT NULL/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('030: skips saved before the check-off recorded only what was marked become not logged; later skips and taken stay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-skips-mig-'));
  const path = join(dir, 'h.db');
  try {
    const before = MIGRATIONS.slice(0, MIGRATIONS.findIndex((m) => m.id === '030-clear-automatic-skips'));
    const old = openStore(path, { app: 'health-review', migrations: before });
    old.db.prepare("INSERT INTO medications (id, user_id, name, kind, created_at) VALUES (1, ?, 'Test Item', 'supplement', 'x')").run(OWNER_ID);
    const ins = old.db.prepare('INSERT INTO medication_doses (user_id, date, medication_id, timing, taken, updated_at) VALUES (?, ?, 1, ?, ?, ?)');
    ins.run(OWNER_ID, '2026-10-28', 'morning', 1, '2026-10-28T12:00:00.000Z');
    ins.run(OWNER_ID, '2026-10-28', 'before_bed', 0, '2026-10-28T12:00:00.000Z'); // unchecked at a save: automatic
    ins.run(OWNER_ID, '2026-10-30', 'before_bed', 0, '2026-10-30T12:00:00.000Z'); // the Skip control
    old.close();

    const store = openHealthStore(path);
    const rows = store.db.prepare('SELECT date, timing, taken FROM medication_doses ORDER BY date, timing').all();
    assert.deepEqual(rows.map((r) => `${r.date} ${r.timing} ${r.taken}`), ['2026-10-28 morning 1', '2026-10-30 before_bed 0']);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
