// The same data on both engines answers every GET route byte for byte the same (v3 Phase 1C slice 4): the demo's made-up
// database is built on SQLite, copied row for row into PostgreSQL (db/transfer.js copyAll), and each route's status and body
// compared. This is the proof the shared SQL means the same on both, including the order of rows (NULLs sort first on
// SQLite and last on PostgreSQL unless a query says otherwise). Made-up data only; needs DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { refreshDemoDatabase } from '../demo/generate.js';
import { answers, TODAY } from './route-answers.js';
import { copyAll } from '../db/transfer.js';
import { freshPgStore, pgSkip } from './pg.js';

test('every GET route answers the same on SQLite and on PostgreSQL, given the same rows', { skip: pgSkip, timeout: 300_000 }, async () => {
  const sqlite = openHealthStore(':memory:');
  const pg = await freshPgStore();
  try {
    await refreshDemoDatabase(sqlite, { today: TODAY });
    const copied = await copyAll(sqlite, pg);
    assert.ok(copied.daily_metrics > 300 && copied.strength_sets > 1000, 'the demo data is there to compare');
    const [a, b] = [await answers(sqlite), await answers(pg)];
    assert.deepEqual(Object.keys(b), Object.keys(a));
    assert.ok(Object.keys(a).length >= 60, `the routes and views (${Object.keys(a).length})`);
    const differ = Object.keys(a).filter((u) => a[u] !== b[u]);
    for (const u of differ) {
      const i = [...a[u]].findIndex((c, k) => c !== b[u][k]);
      console.log(`${u}\n  sqlite:   ${a[u].slice(Math.max(0, i - 120), i + 120)}\n  postgres: ${b[u].slice(Math.max(0, i - 120), i + 120)}`);
    }
    assert.deepEqual(differ, [], 'routes answering differently');
    const ok = Object.values(a).filter((v) => v.startsWith('200 ')).length;
    assert.ok(ok >= Object.keys(a).length - 6, `most routes answer 200 (${ok})`);
  } finally {
    sqlite.close();
    await pg.close();
  }
});
