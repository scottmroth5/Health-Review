// GET /api/spend: reviews and chat from the tracer's runs, the review eval priced from its saved token counts.
// Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { spend } from '../server/queries.js';

const TODAY = new Date(2026, 9, 13, 12, 0);
// $1 per 1,000 input tokens for 'fake-model'; any other model has no price.
const price = (model, usage) => (model === 'fake-model' ? usage.input_tokens / 1000 : null);

function addRun(db, name, startedAt, cost) {
  db.prepare("INSERT INTO runs (name, status, started_at, cost_usd) VALUES (?, 'ok', ?, ?)").run(name, startedAt, cost);
}

function evalFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'hr-spend-'));
  mkdirSync(join(dir, 'v1'));
  const rows = [
    { model: 'fake-model', usage: { input_tokens: 250 } },
    { model: 'fake-model', usage: { input_tokens: 100 } },
    { model: 'other-model', usage: { input_tokens: 999 } },
  ];
  const file = join(dir, 'v1', 'results.jsonl');
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const sept = new Date(2026, 8, 20, 12, 0);
  utimesSync(file, sept, sept);
  return dir;
}

test('spend: runs by kind, month and year, plus evals dated by their results file', () => {
  const store = openHealthStore(':memory:');
  const { db } = store;
  addRun(db, 'review', '2026-10-04T12:00:00.000Z', 0.3);
  addRun(db, 'review', '2026-10-11T12:00:00.000Z', 0.32);
  addRun(db, 'advisor-chat', '2026-10-07T15:00:00.000Z', 0.1);
  addRun(db, 'review', '2025-12-07T12:00:00.000Z', 0.25);
  addRun(db, 'sync', '2026-10-12T11:00:00.000Z', 0);
  addRun(db, 'other-thing', '2026-10-12T11:00:00.000Z', 0.05);
  const dir = evalFolder();

  const s = spend(db, { evalDir: dir, price, today: '2026-10-13' });
  assert.equal(s.thisMonth, 0.77);
  assert.equal(s.thisYear, 1.12); // 0.77 + evals 0.35 in September
  assert.equal(s.allTime, 1.37);
  assert.equal(s.unpricedEvalRows, 1);
  assert.equal(s.months.length, 12);
  assert.deepEqual(s.months[0], { month: '2026-10', reviews: 0.62, chat: 0.1, evals: 0, other: 0.05, total: 0.77 });
  assert.deepEqual(s.months[1], { month: '2026-09', reviews: 0, chat: 0, evals: 0.35, other: 0, total: 0.35 });
  assert.equal(s.months[11].month, '2025-11');
  assert.deepEqual(s.years.map((y) => [y.year, y.total]), [['2026', 1.12], ['2025', 0.25]]);

  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test('spend: no eval folder (the demo) counts runs only, and an empty database is all zeros', async () => {
  const store = openHealthStore(':memory:');
  const app = await buildApp({ store, clock: () => TODAY, instance: 'demo' });
  const s = (await app.inject('/api/spend')).json();
  assert.equal(s.allTime, 0);
  assert.deepEqual(s.years, []);
  assert.equal(s.months[0].month, '2026-10');
  await app.close();
  store.close();
});

test('api: /api/spend reads the eval folder the server was given', async () => {
  const store = openHealthStore(':memory:');
  addRun(store.db, 'review', '2026-10-04T12:00:00.000Z', 0.3);
  const dir = evalFolder();
  const app = await buildApp({ store, clock: () => TODAY, evalDir: dir, price });
  const res = await app.inject('/api/spend');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().thisYear, 0.65);
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  store.close();
});
