// The weekly review's data gate (reviewStatus) and the manual run (GET /api/reviews/status, POST /api/reviews/run).
// Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOwnerStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { reviewStatus } from '../server/queries.js';
import { addDays } from '../metrics/stats.js';
import { OWNER_ID } from '../db/users.js';

// Monday 2026-03-09: the review week is Sunday Mar 1 to Saturday Mar 7.
const MONDAY = new Date(2026, 2, 9, 12, 0);
const WEEK_END = '2026-03-07';

/** Steps for every day from Jan 30 to Mar 7 (the week plus 28 days of median history), minus skipped dates. */
function fillDays(db, { skip = [], steps = {} } = {}) {
  const add = db.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (@uid, ?, ?, 'x')");
  for (let d = '2026-01-30'; d <= WEEK_END; d = addDays(d, 1)) if (!skip.includes(d)) add.run(d, steps[d] ?? 8000);
}

function store() {
  return openOwnerStore(':memory:');
}

test('reviewStatus: a complete week is ready', () => {
  const s = store();
  fillDays(s.db);
  const r = reviewStatus(s.db, '2026-03-09', MONDAY);
  assert.deepEqual({ weekEnd: r.weekEnd, missingDays: r.missingDays, partialDays: r.partialDays, ready: r.ready, hasReview: r.hasReview, lastRun: r.lastRun },
    { weekEnd: WEEK_END, missingDays: [], partialDays: [], ready: true, hasReview: false, lastRun: null });
  assert.equal(r.overdue, true); // Monday, no review
  s.close();
});

test('reviewStatus: any missing day of the week blocks it, not just Saturday', () => {
  const s = store();
  fillDays(s.db, { skip: ['2026-03-03'] });
  const r = reviewStatus(s.db, '2026-03-09', MONDAY);
  assert.deepEqual(r.missingDays, ['2026-03-03']);
  assert.equal(r.ready, false);
  s.close();
});

test('reviewStatus: a likely partial export blocks it (under a quarter of the 28-day median)', () => {
  const s = store();
  fillDays(s.db, { steps: { '2026-03-07': 1500 } }); // median 8000, quarter 2000
  const r = reviewStatus(s.db, '2026-03-09', MONDAY);
  assert.deepEqual(r.partialDays, ['2026-03-07']);
  assert.equal(r.ready, false);
  s.close();
});

test('reviewStatus: overdue only from 9am on the Sunday after, or once a run was tried', () => {
  const s = store();
  fillDays(s.db);
  assert.equal(reviewStatus(s.db, '2026-03-08', new Date('2026-03-08T07:00:00-04:00')).overdue, false);
  assert.equal(reviewStatus(s.db, '2026-03-08', new Date('2026-03-08T09:00:00-04:00')).overdue, true);
  s.db.prepare("INSERT INTO runs (user_id, name, meta, status, started_at, summary) VALUES (@uid, 'review', ?, 'skipped', 'x', ?)")
    .run(JSON.stringify({ weekEnd: WEEK_END }), JSON.stringify({ weekEnd: WEEK_END, missingDays: ['2026-03-07'], partialDays: [] }));
  const early = reviewStatus(s.db, '2026-03-08', new Date('2026-03-08T08:05:00-04:00'));
  assert.equal(early.overdue, true);
  assert.equal(early.lastRun.status, 'skipped');
  assert.deepEqual(early.lastRun.summary.missingDays, ['2026-03-07']);
  s.db.prepare("INSERT INTO reviews (user_id, week_ending, summary_json, report_md, created_at) VALUES (@uid, ?, '{}', 'x', 'x')").run(WEEK_END);
  assert.equal(reviewStatus(s.db, '2026-03-09', MONDAY).overdue, false);
  s.close();
});

test('reviewStatus: a review written with a missing day is offered for a rewrite once the day arrives', () => {
  const s = store();
  fillDays(s.db, { skip: ['2026-03-07'] });
  const save = s.db.prepare("INSERT OR REPLACE INTO reviews (user_id, week_ending, summary_json, report_md, created_at) VALUES (@uid, ?, ?, 'x', 'x')");
  save.run(WEEK_END, JSON.stringify({ dataQuality: { missingDays: ['2026-03-07'], suspectedPartialDays: [] } }));
  let r = reviewStatus(s.db, '2026-03-09', MONDAY);
  assert.deepEqual(r.writtenWithGaps, { missingDays: ['2026-03-07'], partialDays: [] });
  assert.equal(r.rewriteAvailable, false); // still missing
  assert.equal(r.overdue, false);

  s.db.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (@uid, '2026-03-07', 8000, 'x')").run();
  r = reviewStatus(s.db, '2026-03-09', MONDAY);
  assert.equal(r.rewriteAvailable, true);

  save.run(WEEK_END, JSON.stringify({ week: {} })); // rewritten with the full week: no dataQuality
  r = reviewStatus(s.db, '2026-03-09', MONDAY);
  assert.equal(r.writtenWithGaps, null);
  assert.equal(r.rewriteAvailable, false);
  s.close();
});

test('reviewStatus: a run for another week is not this week\'s run', () => {
  const s = store();
  fillDays(s.db);
  s.db.prepare("INSERT INTO runs (user_id, name, meta, status, started_at) VALUES (@uid, 'review', ?, 'ok', 'x')").run(JSON.stringify({ weekEnd: '2026-02-28' }));
  assert.equal(reviewStatus(s.db, '2026-03-08', new Date(2026, 2, 8, 7, 0)).lastRun, null);
  s.close();
});

async function setup(services = {}) {
  const s = store();
  const app = await buildApp({ store: s, services, clock: () => MONDAY });
  return { db: s.db, app, done: async () => { await app.close(); s.close(); } };
}

const run = (app, payload = {}) => app.inject({ method: 'POST', url: '/api/reviews/run', payload });
const settle = () => new Promise((r) => setImmediate(r));

test('api: the status reports the gate, whether a run is going, and whether this server can run one', async () => {
  const { db, app, done } = await setup();
  fillDays(db, { skip: ['2026-03-07'] });
  const s = (await app.inject('/api/reviews/status')).json();
  assert.equal(s.weekEnd, WEEK_END);
  assert.deepEqual(s.missingDays, ['2026-03-07']);
  assert.equal(s.ready, false);
  assert.equal(s.running, false);
  assert.equal(s.canRun, false); // no review service (the demo instance)
  assert.equal((await run(app)).statusCode, 503);
  await done();
});

test('api: a manual run syncs, refuses incomplete weeks unless forced, and runs in the background', async () => {
  const calls = [];
  let finish;
  const services = {
    sync: async () => { calls.push('sync'); return { counts: {}, warnings: [] }; },
    review: (o) => { calls.push(o); return new Promise((resolve) => { finish = resolve; }); },
  };
  const { db, app, done } = await setup(services);
  fillDays(db, { skip: ['2026-03-07'] });

  const refused = await run(app);
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(refused.json().missingDays, ['2026-03-07']);
  assert.deepEqual(calls, ['sync']);

  const started = await run(app, { force: true });
  assert.equal(started.statusCode, 202);
  assert.deepEqual(calls.at(-1), { uid: OWNER_ID, weekEnd: WEEK_END, today: '2026-03-09' });
  assert.equal((await app.inject('/api/reviews/status')).json().running, true);
  assert.equal((await run(app, { force: true })).statusCode, 409); // one at a time

  finish({});
  await settle();
  const after = (await app.inject('/api/reviews/status')).json();
  assert.equal(after.running, false);
  assert.equal(after.error, null);
  await done();
});

test('api: a complete week runs without force; a failure is kept as its error name only', async () => {
  const services = { review: async () => { throw Object.assign(new Error('secret detail'), { name: 'ClaudeRefusalError' }); } };
  const { db, app, done } = await setup(services);
  fillDays(db);
  assert.equal((await run(app)).statusCode, 202);
  await settle();
  const s = (await app.inject('/api/reviews/status')).json();
  assert.equal(s.running, false);
  assert.equal(s.error, 'ClaudeRefusalError');
  assert.equal(JSON.stringify(s).includes('secret detail'), false);
  await done();
});

test('api: the run body is checked', async () => {
  const { app, done } = await setup({ review: async () => ({}) });
  assert.equal((await run(app, { force: 'yes' })).statusCode, 400);
  await done();
});
