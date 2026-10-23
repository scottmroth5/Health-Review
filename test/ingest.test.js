// Health Auto Export JSON through both ways in: the Drive files (ingest/sync.js) and the REST posts (POST /api/ingest/*),
// which share the parsers and writers (ingest/health-json.js, ingest/apply.js). Made-up values only (test/fixtures/ingest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openHealthStore } from '../db/store.js';
import { buildApp, INGEST_BODY_LIMIT, INGEST_RATE_LIMIT } from '../server/app.js';
import { runSync } from '../ingest/sync.js';
import { parseHealthJson } from '../ingest/health-json.js';
import { applyHealthDays } from '../ingest/apply.js';
import { repoPath } from '../tools/paths.js';
import { fakeSource, silentLogger } from './helpers.js';

const fixture = (name) => JSON.parse(readFileSync(repoPath('test', 'fixtures', 'ingest', `${name}.json`), 'utf8'));
const TOKEN = 'test-ingest-token-0123456789abcdef';
const NOW = new Date('2026-03-03T14:00:00Z'); // Tue Mar 3, 9am New York
const rowOf = (db, date) => db.prepare('SELECT * FROM daily_metrics WHERE date = ?').get(date);
const strip = ({ updated_at, exported_through, ...r }) => r;

async function server({ token = TOKEN, authMode = 'none', auth = {} } = {}) {
  const store = openHealthStore(':memory:');
  const app = await buildApp({ store, authMode, auth, ingest: { token, apple: 'rest' }, clock: () => NOW, log: silentLogger });
  const post = (route, payload, headers = {}) => app.inject({
    method: 'POST', url: `/api/ingest/${route}`, payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
  });
  return { store, db: store.db, app, post, done: async () => { await app.close(); store.close(); } };
}

test('health JSON: each metric to its column, steps whole, a metric the app does not store skipped; Day-grouped stand hours ignored', () => {
  const { records, standHours, warnings } = parseHealthJson(fixture('health'));
  assert.deepEqual(warnings, []);
  assert.deepEqual(standHours, [], 'a Day-grouped stand hour count (above 1) undercounts, so it is ignored');
  const d1 = records.find((r) => r.date === '2026-03-01');
  assert.deepEqual(d1, {
    date: '2026-03-01', steps: 8123, active_energy_kcal: 610.5, exercise_min: 41, stand_min: 120, hrv_ms: 44.5, resting_hr: 56,
    respiratory_rate: 14.2, hr_min: 50, hr_avg: 71.5, hr_max: 150, sleep_total_hr: 7.25, sleep_asleep_hr: 0, sleep_in_bed_hr: 0,
    sleep_core_hr: 4.1, sleep_deep_hr: 1.05, sleep_rem_hr: 2.1, sleep_awake_hr: 0.4, vo2max: 41.3, walking_speed_mph: 3.1,
    walking_hr_avg: 98, walking_asymmetry_pct: 2.5, spo2_pct: 96.5, physical_effort: 1.9, cardio_recovery_bpm: 25,
  });
  assert.deepEqual(records.find((r) => r.date === '2026-03-02'), { date: '2026-03-02', steps: 9500, active_energy_kcal: 702.25 });
});

test('health JSON: wrong units and readings not grouped by day are skipped with a warning, never converted by guess', () => {
  const { records, warnings } = parseHealthJson({ data: { metrics: [
    { name: 'walking_speed', units: 'km/hr', data: [{ date: '2026-03-01 00:00:00 -0500', qty: 5 }] },
    { name: 'step_count', units: 'count', data: [{ date: '2026-03-01 08:00:00 -0500', qty: 100 }, { date: '2026-03-01 09:00:00 -0500', qty: 200 }] },
  ] } });
  assert.deepEqual(records, []);
  assert.deepEqual(warnings.map((w) => w.kind), ['unexpected units', 'not grouped by day']);
  assert.throws(() => parseHealthJson({ data: { workouts: [] } }), /no data.metrics/);
});

test('stand hours: hour-grouped entries counted per day (0 does not count); parts of a day add up; a re-sent hour counts once', () => {
  const { standHours } = parseHealthJson(fixture('stand'));
  assert.deepEqual(standHours, [{ date: '2026-03-01', hour: 8 }, { date: '2026-03-01', hour: 9 }, { date: '2026-03-01', hour: 14 }, { date: '2026-03-02', hour: 7 }]);
  const store = openHealthStore(':memory:');
  const { db } = store;
  const apply = (p) => store.tx(() => applyHealthDays(db, p, 'x'));
  apply({ records: parseHealthJson(fixture('health')).records }); // the days exist
  apply({ records: [], standHours: standHours.slice(0, 2) }); // the morning
  assert.equal(rowOf(db, '2026-03-01').stand_hours, 2);
  apply({ records: [], standHours }); // a later export with the whole day, the morning again
  assert.equal(rowOf(db, '2026-03-01').stand_hours, 3);
  assert.equal(rowOf(db, '2026-03-02').stand_hours, 1);
  // A larger value already stored (the old Sheets export, which counted correctly) is kept.
  db.prepare("UPDATE daily_metrics SET stand_hours = 12 WHERE date = '2026-03-01'").run();
  apply({ records: [], standHours });
  assert.equal(rowOf(db, '2026-03-01').stand_hours, 12);
  // A stand hour alone never creates a day.
  apply({ records: [], standHours: [{ date: '2026-03-09', hour: 9 }] });
  assert.equal(rowOf(db, '2026-03-09'), undefined);
  store.close();
});

test('a day without steps never erases stored steps; a fuller day replaces a partial one', () => {
  const store = openHealthStore(':memory:');
  const { db } = store;
  const apply = (records) => store.tx(() => applyHealthDays(db, { records }, 'x'));
  apply([{ date: '2026-03-01', steps: 9000, hrv_ms: 40 }]);
  apply([{ date: '2026-03-01', hrv_ms: 45 }]); // a past-range export without the day's totals
  assert.deepEqual([rowOf(db, '2026-03-01').steps, rowOf(db, '2026-03-01').hrv_ms], [9000, 40], 'the fuller stored day wins; its gaps fill from the new');
  apply([{ date: '2026-03-01', steps: 12000, hrv_ms: 46 }]);
  assert.deepEqual([rowOf(db, '2026-03-01').steps, rowOf(db, '2026-03-01').hrv_ms], [12000, 46]);
  store.close();
});

test('the REST posts store exactly what the Drive files store; posting the same body twice changes nothing', async () => {
  // Drive: the health JSON and the stand hours file in the health folder, the workouts in theirs.
  const drive = openHealthStore(':memory:');
  const src = fakeSource({ workout_log: { 2026: [['Date', 'Exercise']] } });
  src.exports = [
    { folder: 'H', id: 'h1', name: 'Apple Health Metrics-2026-03-02.json', modifiedTime: '2026-03-03T14:00:00Z', json: fixture('health') },
    { folder: 'H', id: 's1', name: 'Stand Hours-2026-03-02.json', modifiedTime: '2026-03-03T14:00:00Z', json: fixture('stand') },
    { folder: 'W', id: 'w1', name: 'HealthAutoExport-2026-03-02.json', modifiedTime: '2026-03-03T14:00:00Z', json: fixture('workouts') },
  ];
  await runSync({ store: drive, source: src, now: NOW, logger: silentLogger, catalog: null, apple: 'drive', exportFolders: { health: 'H', workouts: 'W' } });

  const rest = await server();
  for (const [route, name] of [['health', 'health'], ['health', 'stand'], ['workouts', 'workouts']]) {
    const res = await rest.post(route, fixture(name));
    assert.equal(res.statusCode, 200, `${route} ${name}: ${res.body}`);
  }
  const snapshot = (db) => ({
    days: db.prepare('SELECT * FROM daily_metrics ORDER BY date').all().map(strip),
    workouts: db.prepare('SELECT * FROM workout_sessions ORDER BY start').all().map(({ updated_at, ...w }) => w),
    hr: db.prepare('SELECT * FROM workout_hr_samples ORDER BY t').all(),
    stand: db.prepare('SELECT * FROM stand_hour_samples ORDER BY date, hour').all(),
  });
  const viaRest = snapshot(rest.db);
  assert.deepEqual(viaRest, snapshot(drive.db));
  assert.equal(viaRest.days.find((d) => d.date === '2026-03-01').stand_hours, 3);
  assert.equal(viaRest.hr.length, 3);

  // Again: nothing changes.
  for (const [route, name] of [['health', 'health'], ['health', 'stand'], ['workouts', 'workouts']]) await rest.post(route, fixture(name));
  assert.deepEqual(snapshot(rest.db), viaRest);

  // The post's receipt time is the export time: Mar 3 9am, so Mar 1 and 2 are full days.
  assert.equal(rowOf(rest.db, '2026-03-01').exported_through, '2026-03-03T09:00');
  // The log holds metadata only.
  const log = rest.db.prepare('SELECT route, result, counts, error FROM ingest_log ORDER BY received_at').all();
  assert.equal(log.length, 6);
  assert.deepEqual(JSON.parse(log[0].counts), { days: 2, standHours: 0, warnings: 0 });
  assert.doesNotMatch(JSON.stringify(log), /8123|Outdoor Walk|Sample Watch/);
  drive.close();
  await rest.done();
});

test('ingest refuses: no token set up, a missing or wrong token, not JSON, too big, too often, a wrong shape', async () => {
  const off = await server({ token: null });
  assert.equal((await off.post('health', fixture('health'))).statusCode, 503);
  await off.done();

  const s = await server();
  assert.equal((await s.post('health', fixture('health'), { authorization: '' })).statusCode, 401);
  assert.equal((await s.post('health', fixture('health'), { authorization: 'Bearer wrong-token' })).statusCode, 401);
  assert.equal((await s.post('health', 'steps=1', { 'content-type': 'text/plain' })).statusCode, 415);
  const big = JSON.stringify({ data: { metrics: [], pad: 'x'.repeat(INGEST_BODY_LIMIT + 10) } });
  assert.equal((await s.post('health', big)).statusCode, 413);
  const shape = await s.post('health', { data: { workouts: [] } });
  assert.equal(shape.statusCode, 400);
  assert.equal(s.db.prepare("SELECT result, error FROM ingest_log").get().result, 'error');
  await s.done();

  const r = await server();
  let last;
  for (let i = 0; i < INGEST_RATE_LIMIT.max + 1; i++) last = await r.post('workouts', { data: { workouts: [] } });
  assert.equal(last.statusCode, 429);
  await r.done();
});

test('ingest under sign-in: no Google session needed (its own token); the demo refuses it; with APPLE_SOURCE=rest the sync reads no Drive folder', async () => {
  const google = await server({ authMode: 'google', auth: { settings: {
    mode: 'google', publicUrl: 'http://localhost:5188', clientId: 'id', clientSecret: 'secret', allowed: ['pat@example.com'], secret: 'x'.repeat(48),
  } } });
  assert.equal((await google.post('workouts', fixture('workouts'))).statusCode, 200);
  assert.equal((await google.app.inject('/api/status')).statusCode, 401, 'everything else still needs sign-in');
  await google.done();

  const demo = await server({ authMode: 'demo' });
  assert.equal((await demo.post('workouts', fixture('workouts'))).statusCode, 403);
  await demo.done();

  const store = openHealthStore(':memory:');
  const src = fakeSource({ workout_log: { 2026: [['Date', 'Exercise']] } });
  src.exports = [{ folder: 'H', id: 'h1', name: 'Apple Health Metrics-2026-03-02.json', modifiedTime: '2026-03-03T14:00:00Z', json: fixture('health') }];
  const { counts, warnings } = await runSync({ store, source: src, now: NOW, logger: silentLogger, catalog: null, apple: 'rest', exportFolders: { health: 'H', workouts: 'W' } });
  assert.equal(counts.health_exports, undefined);
  assert.ok(!src.reads.some((x) => x.file), 'no export file read');
  assert.ok(!warnings.some((w) => w.kind === 'folder not set'));
  store.close();
});

test('with APPLE_SOURCE=rest the "export stopped" warning counts from the last accepted post', async () => {
  const s = await server();
  await s.post('health', fixture('health'));
  const status = (at) => buildApp({ store: s.store, ingest: { token: TOKEN, apple: 'rest' }, clock: () => at })
    .then((app) => app.inject('/api/status').then((r) => { app.close(); return r.json().dataChecks.map((c) => c.kind); }));
  assert.ok(!(await status(new Date('2026-03-04T12:00:00Z'))).includes('export_stale'), '22 hours after the post');
  assert.ok((await status(new Date('2026-03-04T18:00:00Z'))).includes('export_stale'), '28 hours after the post');
  await s.done();
});
