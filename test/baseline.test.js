// The v3 baseline (scripts/baseline.js) keeps counts and milliseconds only, never anything read from a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { OWNER_ID } from '../db/users.js';
import { baseline } from '../scripts/baseline.js';

test('baseline: sizes, run durations and query timings, with no row content', () => {
  const store = openHealthStore(':memory:');
  try {
    const db = store.db;
    const secret = 'made-up-note-that-must-not-appear';
    db.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (?, '2026-10-30', 4321, '2026-10-31T00:00:00Z')").run(OWNER_ID);
    const run = db.prepare("INSERT INTO runs (name, meta, status, started_at, duration_ms, user_id) VALUES (?, ?, ?, ?, ?, ?)");
    run.run('sync', JSON.stringify({ note: secret }), 'ok', '2026-10-30T11:00:00Z', 1200, OWNER_ID);
    run.run('sync', null, 'failed', '2026-10-31T11:00:00Z', 3000, OWNER_ID);
    run.run('review', null, 'ok', '2026-01-01T11:00:00Z', 9000, OWNER_ID); // older than 90 days

    const b = baseline(db, { now: new Date('2026-11-02T15:00:00Z') });
    assert.equal(b.rowCounts.daily_metrics, 1);
    assert.equal(b.rowCounts.runs, 3);
    assert.deepEqual(b.runs90d, { sync: { count: 2, failed: 1, medianMs: 1200, p95Ms: 3000 } });
    assert.ok(b.database.pageCount > 0 && b.database.tables === Object.keys(b.rowCounts).length);
    assert.equal(Object.keys(b.queriesMs).length, 7);
    for (const ms of Object.values(b.queriesMs)) assert.ok(Number.isFinite(ms) && ms >= 0);

    // Only numbers (and null) at the leaves, apart from the time and Node version; names only as keys.
    const leaves = [];
    const walk = (v, path) => (v && typeof v === 'object' ? Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`)) : leaves.push([path, v]));
    walk(b, '');
    for (const [path, v] of leaves) {
      if (path === '.takenAt' || path === '.node') continue;
      assert.ok(v === null || typeof v === 'number', `${path} is ${typeof v}`);
    }
    const text = JSON.stringify(b);
    assert.ok(!text.includes(secret) && !text.includes('4321') && !text.includes('2026-10-30'));
  } finally {
    store.close();
  }
});
