// The same data on both engines answers every GET route byte for byte the same (v3 Phase 1C slice 4): the demo's made-up
// database is built on SQLite, copied row for row into PostgreSQL (db/transfer.js copyAll), and each route's status and body
// compared. This is the proof the shared SQL means the same on both, including the order of rows (NULLs sort first on
// SQLite and last on PostgreSQL unless a query says otherwise). Made-up data only; needs DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { loadDemoCatalog, refreshDemoDatabase } from '../demo/generate.js';
import { copyAll } from '../db/transfer.js';
import { freshPgStore, pgSkip } from './pg.js';

const TODAY = '2026-10-07';
const PARAMS = { date: '2026-10-06', id: '1', metric: 'hrv_ms' };
const QUERIES = {
  '/api/history': `?from=2024-01-01&to=${TODAY}`, '/api/training': '?view=all', '/api/vo2max': '?view=all',
  '/api/cardio-zones': '?view=1y', '/api/runs': '?limit=100', '/api/medications/checkoffs': '?weeks=52',
};
// Each view of the routes that take one, so every query behind them runs.
const VIEWS = {
  '/api/training': ['week', 'month', '3m', '6m', 'year', '2y', '5y', 'all'].map((v) => `?view=${v}`),
  '/api/vo2max': ['90d', '1y', '2y', '5y', 'all'].map((v) => `?view=${v}`),
  '/api/cardio-zones': ['30d', '90d', '1y'].flatMap((v) => ['day', 'week', 'month'].map((g) => `?view=${v}&group=${g}`)),
};

async function answers(store) {
  const catalog = loadDemoCatalog();
  const app = await buildApp({ store, clock: () => new Date(`${TODAY}T16:00:00Z`), catalog, log: { info() {}, warn() {}, error() {} } });
  const out = {};
  try {
    const gets = app.routeList.filter((r) => r.method === 'GET' && r.url.startsWith('/api/')).sort((a, b) => a.url.localeCompare(b.url));
    for (const r of gets) {
      for (const q of VIEWS[r.url] ?? [QUERIES[r.url] ?? '']) {
        const url = r.url.replace(/:(\w+)/g, (_, k) => PARAMS[k] ?? '1') + q;
        const res = await app.inject({ url, headers: { host: 'localhost:5188' } });
        out[url] = `${res.statusCode} ${res.body}`;
      }
    }
  } finally {
    await app.close();
  }
  return out;
}

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
