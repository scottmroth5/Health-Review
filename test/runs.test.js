// The run tracer (db/runs.js): run rows owned by the store's user, call rows, totals, an idempotent finish, and its writes
// going through the async interface's lock rather than into another request's open transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startUserRun } from '../db/runs.js';
import { OWNER_ID } from '../db/users.js';
import { memoryStore } from './helpers.js';

const quiet = { info() {}, warn() {}, error() {} };
const SECOND = '00000000-0000-4000-8000-0000000000b2';

const call = (over = {}) => ({ label: 'x', model: 'claude-sonnet-5-5', stopReason: 'end_turn', inputTokens: 100, outputTokens: 20,
  cacheReadTokens: 5, cacheWriteTokens: 7, costUsd: 0.25, durationMs: 40, error: null, ...over });

test('a run row belongs to the store user, with its calls and totals', async () => {
  const store = memoryStore({ uid: SECOND });
  const run = await startUserRun(store, 'help-ask', { model: 'm' }, quiet);
  assert.equal(typeof run.id, 'number');
  await run.recordCall(call());
  await run.recordCall(call({ costUsd: null, error: { name: 'Boom', message: 'failed' }, label: null }));
  const totals = await run.finish('ok', { answerChars: 3 });
  assert.deepEqual({ ...totals, durationMs: 0 }, { status: 'ok', calls: 2, errors: 1, inputTokens: 200, outputTokens: 40,
    cacheReadTokens: 10, cacheWriteTokens: 14, costUsd: 0.25, unpricedCalls: 1, durationMs: 0 });

  const row = store.shared.syncDb.prepare('SELECT * FROM runs WHERE id = ?').get(run.id);
  assert.equal(row.user_id, SECOND);
  assert.equal(row.name, 'help-ask');
  assert.deepEqual(JSON.parse(row.meta), { model: 'm' });
  assert.equal(row.status, 'ok');
  assert.equal(row.calls, 2);
  assert.equal(row.errors, 1);
  assert.equal(row.cost_usd, 0.25);
  assert.deepEqual(JSON.parse(row.summary), { answerChars: 3 });
  assert.ok(row.finished_at);
  const calls = store.shared.syncDb.prepare('SELECT * FROM run_calls WHERE run_id = ? ORDER BY id').all(run.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].label, 'x');
  assert.equal(calls[0].cost_usd, 0.25);
  assert.equal(calls[1].label, null);
  assert.equal(calls[1].cost_usd, null);
  assert.equal(calls[1].error_name, 'Boom');
  store.close();
});

test('finish is idempotent, even when called twice before either settles', async () => {
  const store = memoryStore();
  const run = await startUserRun(store, 'sync', {}, quiet);
  const [a, b] = await Promise.all([run.finish('ok', { n: 1 }), run.finish('error', { n: 2 })]);
  assert.equal(a, b);
  assert.equal(a.status, 'ok');
  const row = store.syncDb.prepare('SELECT status, summary, user_id FROM runs WHERE id = ?').get(run.id);
  assert.deepEqual(row, { status: 'ok', summary: '{"n":1}', user_id: OWNER_ID });
  assert.equal(await run.finish('skipped'), a);
  store.close();
});

test('finish writes no summary when none is given, and logs one line', async () => {
  const store = memoryStore();
  const lines = [];
  const run = await startUserRun(store, 'backup', {}, { info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) });
  await run.finish('skipped');
  assert.equal(store.syncDb.prepare('SELECT summary FROM runs WHERE id = ?').pluck().get(run.id), null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'warn');
  assert.match(lines[0][1], /^\[backup\] skipped: 0 calls, 0 errors, 0 in \/ 0 out, 0 cache read \/ 0 cache write, \$0\.0000, \d+ ms$/);
  store.close();
});

test('an unscoped store is refused', async () => {
  const store = memoryStore();
  await assert.rejects(startUserRun({ db: store.shared.db }, 'sync', {}, quiet), /not scoped to a user/);
  await assert.rejects(startUserRun(store, '', {}, quiet), /name is required/);
  store.close();
});

test("a run started during another request's transaction waits for it and is not rolled back with it", async () => {
  const store = memoryStore();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const other = store.tx(async () => {
    await store.db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'k', 'v', 'x')").run();
    entered();
    await held;
    throw new Error('rolled back');
  });
  await inside;
  const starting = startUserRun(store, 'workout-upload', {}, quiet);
  let started = false;
  void starting.then(() => { started = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, false, 'the run insert waits for the open transaction');
  release();
  await assert.rejects(other, /rolled back/);
  const run = await starting;
  await run.finish('ok');
  assert.equal(store.syncDb.prepare("SELECT COUNT(*) FROM settings WHERE key = 'k'").pluck().get(), 0);
  assert.equal(store.syncDb.prepare('SELECT status FROM runs WHERE id = ?').pluck().get(run.id), 'ok');
  store.close();
});
