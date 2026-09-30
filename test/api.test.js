import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { assertSafeBinding } from '../server/auth.js';

const TODAY = new Date(2026, 2, 9, 12, 0); // local 2026-03-09

async function setup(services = {}) {
  const store = openHealthStore(':memory:');
  const app = await buildApp({ store, services, clock: () => TODAY });
  return { store, app, db: store.db, done: async () => { await app.close(); store.close(); } };
}

const put = (app, url, payload) => app.inject({ method: 'PUT', url, payload });
const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });

test('the server refuses to listen beyond localhost without a login mode', () => {
  assert.doesNotThrow(() => assertSafeBinding({ host: '127.0.0.1' }));
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0' }), /only allows localhost/);
});

test('requests addressed to another host are rejected (DNS rebinding)', async () => {
  const { app, done } = await setup();
  assert.equal((await app.inject({ url: '/api/status', headers: { host: 'localhost:5188' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers: { host: '127.0.0.1:5188' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers: { host: 'evil.example:5188' } })).statusCode, 403);
  await done();
});

test('check-in: saves a daily entry, marks body measurements with the day, and reads back', async () => {
  const { app, done } = await setup();
  const res = await put(app, '/api/checkins/2026-03-09', { readiness: 7, energy: 6, mood: 8, stress: 3, nutrition: 7, weight_lbs: 181.2, notes: ' good ' });
  assert.equal(res.statusCode, 200);
  const day = (await app.inject('/api/days/2026-03-09')).json();
  assert.equal(day.checkin.readiness, 7);
  assert.equal(day.checkin.cadence, 'daily');
  assert.equal(day.checkin.source, 'ui');
  assert.equal(day.checkin.body_measured_on, '2026-03-09');
  assert.equal(day.checkin.notes, 'good');
  await done();
});

test('check-in: scales are 1 to 10, empty saves and future dates are refused', async () => {
  const { app, done } = await setup();
  assert.equal((await put(app, '/api/checkins/2026-03-09', { readiness: 11 })).statusCode, 400);
  assert.equal((await put(app, '/api/checkins/2026-03-09', { readiness: 0 })).statusCode, 400);
  assert.match((await put(app, '/api/checkins/2026-03-09', { notes: '' })).json().error, /Nothing to save/);
  assert.match((await put(app, '/api/checkins/2026-03-10', { readiness: 5 })).json().error, /future/);
  assert.equal((await put(app, '/api/checkins/2026-02-30', { readiness: 5 })).statusCode, 400);
  await done();
});

test('check-in: saving over a v1 weekly row makes it a daily UI row', async () => {
  const { app, db, done } = await setup();
  db.prepare("INSERT INTO checkins (date, cadence, readiness, source, updated_at) VALUES ('2026-03-07', 'weekly', 5, 'v1-sheet', 'x')").run();
  await put(app, '/api/checkins/2026-03-07', { readiness: 8 });
  assert.deepEqual(db.prepare("SELECT cadence, readiness, source FROM checkins WHERE date = '2026-03-07'").get(), { cadence: 'daily', readiness: 8, source: 'ui' });
  await done();
});

test('drinking: CBD is stored but never counted as alcohol; zeros are a real no-drink day', async () => {
  const { app, done } = await setup();
  const saved = (await put(app, '/api/drinking/2026-03-08', { beers: 2, wine: 1, cbd: 2, setting: 'Dinner', mood_before: 6, mood_after: 7 })).json();
  assert.equal(saved.alcohol, 3);
  assert.equal(saved.cbd, 2);
  const zero = (await put(app, '/api/drinking/2026-03-09', {})).json();
  assert.equal(zero.alcohol, 0);
  assert.equal(zero.source, 'ui');
  const history = (await app.inject('/api/history?from=2026-03-01&to=2026-03-09')).json();
  assert.deepEqual(history.drinking, [{ date: '2026-03-08', alcohol: 3, cbd: 2 }, { date: '2026-03-09', alcohol: 0, cbd: 0 }]);
  await done();
});

test('drinking: counts are validated and days can be deleted', async () => {
  const { app, done } = await setup();
  assert.equal((await put(app, '/api/drinking/2026-03-08', { beers: -1 })).statusCode, 400);
  assert.equal((await put(app, '/api/drinking/2026-03-08', { mood_after: 12 })).statusCode, 400);
  await put(app, '/api/drinking/2026-03-08', { beers: 1 });
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/drinking/2026-03-08' })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/drinking/2026-03-08' })).statusCode, 404);
  await done();
});

test('history returns metrics, check-ins and drinks in the range', async () => {
  const { app, db, done } = await setup();
  db.prepare("INSERT INTO daily_metrics (date, hrv_ms, resting_hr, sleep_total_hr, steps, updated_at) VALUES ('2026-03-02', 48, 55, 7.2, 8000, 'x'), ('2026-01-01', 40, 60, 6, 5000, 'x')").run();
  const h = (await app.inject('/api/history?from=2026-03-01&to=2026-03-09')).json();
  assert.deepEqual(h.metrics, [{ date: '2026-03-02', hrv_ms: 48, resting_hr: 55, sleep_total_hr: 7.2, steps: 8000 }]);
  assert.equal((await app.inject('/api/history?from=2026-03-09&to=2026-03-01')).statusCode, 400);
  await done();
});

test('prompt sections: create, edit keeps the previous version, delete keeps a copy', async () => {
  const { app, db, done } = await setup();
  const created = await post(app, '/api/prompt/sections', { position: 1, name: 'profile', text: 'Profile on {{TODAY}}.' });
  assert.equal(created.statusCode, 201);
  const { id } = created.json();
  assert.equal((await post(app, '/api/prompt/sections', { position: 2, name: 'profile', text: 'dup' })).statusCode, 409);

  const edited = (await put(app, `/api/prompt/sections/${id}`, { text: 'Profile v2 on {{TODAY}}.' })).json();
  assert.equal(edited.text, 'Profile v2 on {{TODAY}}.');
  assert.deepEqual(db.prepare('SELECT text FROM prompt_section_versions WHERE section_id = ?').all(id), [{ text: 'Profile on {{TODAY}}.' }]);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/prompt/sections/${id}` })).statusCode, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_section_versions WHERE section_id = ?').get(id).n, 2);
  assert.equal((await put(app, `/api/prompt/sections/${id}`, { text: 'x' })).statusCode, 404);
  await done();
});

test('prompt preview: position order, {{TODAY}} filled in, sensitive sections left out', async () => {
  const { app, done } = await setup();
  await post(app, '/api/prompt/sections', { position: 10, name: 'rules', text: 'Rules.' });
  await post(app, '/api/prompt/sections', { position: 2, name: 'medical', text: 'Medications.', sensitive: true });
  await post(app, '/api/prompt/sections', { position: 1, name: 'profile', text: 'Profile on {{TODAY}}.' });
  const preview = (await app.inject('/api/prompt/preview')).json();
  assert.equal(preview.text, 'Profile on 2026-03-09.\n\nRules.');
  assert.deepEqual(preview.included, ['profile', 'rules']);
  assert.deepEqual(preview.leftOut, ['medical']);
  await done();
});

test('prompt sections: names are restricted and a body is required', async () => {
  const { app, done } = await setup();
  assert.equal((await post(app, '/api/prompt/sections', { position: 1, name: '../x', text: 't' })).statusCode, 400);
  const { id } = (await post(app, '/api/prompt/sections', { position: 1, name: 'a', text: 't' })).json();
  assert.equal((await put(app, `/api/prompt/sections/${id}`, {})).statusCode, 400);
  await done();
});

test('sync: runs the injected sync, reports counts only, and refuses to overlap', async () => {
  let release;
  const sync = () => new Promise((resolve) => { release = () => resolve({ counts: { health_metrics: { upserted: 1 } }, warnings: [{ kind: 'x' }] }); });
  const { app, done } = await setup({ sync });
  const first = app.inject({ method: 'POST', url: '/api/sync' });
  await new Promise((r) => setImmediate(r));
  assert.equal((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode, 409);
  release();
  assert.deepEqual((await first).json(), { counts: { health_metrics: { upserted: 1 } }, warnings: 1 });
  await done();
});

test('status reports today and the last sync run', async () => {
  const { app, db, done } = await setup();
  db.prepare("INSERT INTO runs (name, status, started_at, finished_at, summary) VALUES ('sync', 'ok', '2026-03-09T12:00:00Z', '2026-03-09T12:00:03Z', '{\"counts\":{}}')").run();
  const status = (await app.inject('/api/status')).json();
  assert.equal(status.today, '2026-03-09');
  assert.equal(status.lastSync.status, 'ok');
  await done();
});
