// Guided setup and the Home summary (UX roadmap phase 2, 2026-10-26): the checklist guides and never blocks, entering
// data by hand counts fully, and someone with no Apple Health data gets no Apple Health warnings or review gate.
// Made-up values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openHealthStore, openOwnerStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { sign, sessionKey } from '../server/session.js';
import { nextReviewDay, setupSteps, sheetProblem } from '../server/setup.js';
import { reviewStatus, dataCheckWarnings } from '../server/queries.js';
import { scopeDb } from '../db/scope.js';
import { computeWeek } from '../metrics/index.js';

const TODAY = '2026-10-21'; // a Wednesday
const step = (r, id) => r.steps.find((s) => s.id === id);

test('setupSteps: a new user has everything to do, and nothing is required to use the app', () => {
  const r = setupSteps({ chosen: { manual: true } }, { today: TODAY });
  assert.deepEqual(r.steps.map((s) => s.id), ['goals', 'profile', 'data', 'ai', 'firstResult']);
  assert.equal(r.doneCount, 0);
  assert.equal(r.complete, false);
  assert.equal(step(r, 'ai').optional, true);
  assert.equal(step(r, 'firstResult').needsAi, true);
});

test('setupSteps: entering by hand completes the data and first result steps on its own', () => {
  const r = setupSteps({ chosen: { manual: true }, ai: true, manual: { checkins: 3 }, firstDataDate: '2026-10-19' }, { today: TODAY });
  assert.equal(step(r, 'data').done, true);
  assert.equal(step(r, 'firstResult').done, true);
  assert.equal(step(r, 'firstResult').link, '#health');
  assert.equal(step(r, 'firstResult').nextReview, '2026-10-25');
  assert.equal(step(r, 'data').ways.appleHealth.ready, false, 'Apple Health is simply not set up, never a problem');
});

test('setupSteps: Apple Health waits for the first post, then says what arrived', () => {
  const waiting = setupSteps({ chosen: { appleHealth: true }, apple: { token: true, days: 0 } }, { today: TODAY });
  assert.equal(step(waiting, 'data').done, true, 'a token is a way set up');
  assert.equal(step(waiting, 'data').ways.appleHealth.received, false);
  assert.equal(step(waiting, 'firstResult').done, false);
  const received = setupSteps({ chosen: { appleHealth: true }, apple: { token: true, days: 14, workouts: 3, firstPost: '2026-10-20T07:02' } }, { today: TODAY });
  assert.deepEqual({ ...step(received, 'data').ways.appleHealth }, { chosen: true, ready: true, received: true, firstPost: '2026-10-20T07:02', lastPost: null, days: 14, workouts: 3 });
  assert.equal(step(received, 'firstResult').done, true);
});

test('setupSteps: a Workout Log sheet reports lifting days, and a failed sync in plain words', () => {
  const r = setupSteps({ chosen: { workoutLog: true }, sheet: { connected: true, sheetSet: true, liftingDays: 38, tabsRead: 2 } }, { today: TODAY });
  assert.equal(step(r, 'data').ways.workoutLog.liftingDays, 38);
  assert.equal(step(r, 'firstResult').link, '#training');
  assert.match(sheetProblem('Request failed with status code 403'), /reconnect Google Sheets/);
  assert.match(sheetProblem('Requested entity was not found.'), /wasn't found/);
  assert.equal(sheetProblem(null), null);
  assert.doesNotMatch(sheetProblem('Tab "Secret plan 2026" broke'), /Secret plan/, 'never the error text itself');
});

test('setupSteps: skipped steps and a hidden list count as settled', () => {
  const skipped = setupSteps({ goalsSet: true, profileSet: true, ai: true, manual: { checkins: 1 }, dismissed: ['ai'] }, { today: TODAY });
  assert.equal(skipped.complete, true);
  const partly = setupSteps({ goalsSet: true, dismissed: ['profile'] }, { today: TODAY });
  assert.equal(step(partly, 'profile').dismissed, true);
  assert.equal(partly.complete, false);
  assert.equal(setupSteps({ hidden: true }, { today: TODAY }).complete, true);
  assert.equal(step(setupSteps({ goalsSet: true, dismissed: ['goals'] }, { today: TODAY }), 'goals').dismissed, false, 'a done step is never shown as skipped');
});

test('nextReviewDay: the coming Sunday, or today on a Sunday', () => {
  assert.equal(nextReviewDay('2026-10-21'), '2026-10-25');
  assert.equal(nextReviewDay('2026-10-25'), '2026-10-25');
  assert.equal(nextReviewDay('2026-10-24'), '2026-10-25');
});

test('hand entry only: no Apple Health warnings, the review runs on check-ins, and an empty week is never sent', () => {
  const store = openOwnerStore(':memory:');
  const db = store.db;
  assert.deepEqual(dataCheckWarnings(db, TODAY, { apple: 'rest', now: new Date(`${TODAY}T12:00:00Z`) }), []);
  const none = reviewStatus(db, TODAY, new Date(`${TODAY}T12:00:00Z`));
  assert.equal(none.reason, 'no_data');
  assert.equal(none.overdue, false, 'nothing to review is never due');
  db.prepare("INSERT INTO checkins (user_id, date, cadence, readiness, source, updated_at) VALUES (@uid, '2026-10-14', 'daily', 7, 'ui', 'x')").run();
  const status = reviewStatus(db, TODAY, new Date(`${TODAY}T12:00:00Z`));
  assert.equal(status.ready, true);
  assert.equal(status.reason, null);
  assert.deepEqual(status.missingDays, []);
  store.close();
});

test('computeWeek: no dataQuality without any Apple Health day, so the review does not call every day missing', () => {
  const empty = { daily_metrics: [], workout_sessions: [], strength_sets: [], drinking_days: [], checkins: [{ date: '2026-10-14', readiness: 7 }] };
  assert.equal(computeWeek(empty, { weekEnd: '2026-10-17' }).dataQuality, null);
  const some = { ...empty, daily_metrics: [{ date: '2026-10-12', steps: 9000 }] };
  assert.equal(computeWeek(some, { weekEnd: '2026-10-17' }).dataQuality.missingDays.length, 6);
});

test('/api/home and PUT /api/account/setup: a new user sees the checklist; skipping, restoring and hiding stick; the demo cannot write', async () => {
  const secret = randomBytes(48).toString('base64');
  const SITE = 'http://localhost:5188';
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: secret });
  const store = openHealthStore(':memory:');
  const KIM = '00000000-0000-4000-8000-0000000000c3';
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at, feeds) VALUES (?, 'kim@example.com', 'user', 'approved', 'x', '{\"manual\":true}')").run(KIM);
  const app = await buildApp({ store, authMode: 'google', auth: { settings }, clock: () => new Date(`${TODAY}T16:00:00Z`), services: { hasAi: () => false } });
  const kim = { cookie: `hr_session=${sign({ email: 'kim@example.com', exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE };

  let home = (await app.inject({ url: '/api/home', headers: kim })).json();
  assert.equal(home.setup.complete, false);
  assert.equal(home.setup.doneCount, 0);
  assert.equal(home.summary.checkin.done, false);
  assert.equal(home.summary.latestReview, null);
  assert.deepEqual(home.summary.feeds.map((f) => f.feed), ['manual']);

  // A check-in completes the data and first result steps.
  scopeDb(store.db, KIM).prepare("INSERT INTO checkins (user_id, date, cadence, readiness, source, updated_at) VALUES (@uid, ?, 'daily', 6, 'ui', 'x')").run(TODAY);
  home = (await app.inject({ url: '/api/home', headers: kim })).json();
  assert.equal(home.setup.doneCount, 2);
  assert.equal(home.summary.checkin.done, true);

  const put = (payload) => app.inject({ method: 'PUT', url: '/api/account/setup', headers: kim, payload });
  assert.equal((await put({ dismiss: 'goals' })).json().setup.steps[0].dismissed, true);
  assert.equal((await put({ restore: 'goals' })).json().setup.steps[0].dismissed, false);
  assert.equal((await put({ dismiss: 'nonsense' })).statusCode, 400);
  assert.equal((await put({})).statusCode, 400);
  assert.equal((await put({ hidden: true })).json().setup.complete, true);
  assert.equal((await app.inject({ url: '/api/home', headers: kim })).json().setup.hidden, true);
  assert.equal((await app.inject({ url: '/api/account', headers: kim })).json().setupHidden, true, 'Settings offers it back');
  assert.equal((await put({ hidden: false })).json().setup.hidden, false);
  await app.close();

  const demo = await buildApp({ store: openHealthStore(':memory:'), authMode: 'demo' });
  assert.equal((await demo.inject({ method: 'PUT', url: '/api/account/setup', payload: { hidden: true } })).statusCode, 403);
  assert.equal((await demo.inject('/api/home')).statusCode, 200);
  await demo.close();
  store.close();
});
