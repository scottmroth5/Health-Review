// Workouts logged in the app (ingest/app-workouts.js): stored at tab_year 0 with the sheet's own parsing, used by
// volume and program blocks like sheet rows, never touched by a Workout Log sync, one per day, the user's own only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openHealthStore } from '../db/store.js';
import { scopeStore } from '../db/scope.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { runSync } from '../ingest/sync.js';
import { fakeSource } from './helpers.js';
import { WORKOUT_LOG_HEADER } from '../ingest/create-sheet.js';

const SITE = 'http://localhost:5188';
const NOW = new Date('2026-03-20T16:00:00Z');

async function setup() {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x'), ('kim', 'kim@example.com', 'user', 'approved', 'x')").run();
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', clock: () => NOW, mailer: { send: async () => true }, log: { info() {}, warn() {}, error() {} },
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login');
    const url = new URL(login.headers.location);
    nonce = url.searchParams.get('nonce');
    const res = await app.inject({ url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: cookies(login) } });
    const cookie = cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
    return { get: (u) => app.inject({ url: u, headers: { cookie } }), send: (method, u, payload) => app.inject({ method, url: u, headers: { cookie, origin: SITE }, ...(payload ? { payload } : {}) }) };
  };
  return { app, store, signIn };
}

const squatDay = (workout = 'Garage 5x5 A') => ({ workout, exercises: [
  { name: 'Barbell Squat', sets: [{ weight: '185', reps: '5' }, { weight: '185', reps: '5' }, { weight: '', reps: '' }], comment: 'felt good' },
  { name: 'Pullups', sets: [{ weight: 'BW', reps: '8' }] },
  { name: 'Planks', sets: [{ weight: null, reps: '30 seconds' }] },
] });

test('save: rows at tab_year 0 parsed like the sheet; volume and lists see them; edit replaces, delete removes', async () => {
  const { store, signIn } = await setup();
  const lee = await signIn('lee@example.com');
  const saved = await lee.send('PUT', '/api/workouts/2026-03-18', squatDay());
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().source, 'app');
  assert.deepEqual(saved.json().exercises.map((e) => e.sets.length), [2, 1, 1], 'blank sets dropped');
  const rows = store.db.prepare("SELECT tab_year, workout, exercise, canonical_id FROM strength_exercises WHERE user_id = 'lee' ORDER BY row_no").all();
  assert.ok(rows.every((r) => r.tab_year === 0));
  assert.equal(rows[0].workout, 'Garage 5x5 A');
  assert.ok(rows[0].canonical_id, 'the dictionary applied');
  const sets = store.db.prepare("SELECT weight_lbs, bodyweight, reps, duration_sec FROM strength_sets WHERE user_id = 'lee' ORDER BY exercise_id, set_no").all();
  assert.deepEqual(sets, [
    { weight_lbs: 185, bodyweight: 0, reps: 5, duration_sec: null }, { weight_lbs: 185, bodyweight: 0, reps: 5, duration_sec: null },
    { weight_lbs: null, bodyweight: 1, reps: 8, duration_sec: null }, { weight_lbs: null, bodyweight: 0, reps: null, duration_sec: 30 },
  ]);
  const week = (await lee.get('/api/training?view=week')).json();
  assert.equal(week.totals.volumeLbs, 185 * 5 * 2, 'volume counts them');

  const list = (await lee.get('/api/workouts')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].date, '2026-03-18');
  // Edit replaces the day; delete removes it.
  await lee.send('PUT', '/api/workouts/2026-03-18', { workout: null, exercises: [{ name: 'Barbell Bench Press', sets: [{ weight: '135', reps: '8' }] }] });
  assert.deepEqual(store.db.prepare("SELECT exercise FROM strength_exercises WHERE user_id = 'lee'").pluck().all(), ['Barbell Bench Press']);
  assert.equal((await lee.send('DELETE', '/api/workouts/2026-03-18')).statusCode, 200);
  assert.equal(store.db.prepare("SELECT COUNT(*) FROM strength_sets WHERE user_id = 'lee'").pluck().get(), 0);
  assert.equal((await lee.send('DELETE', '/api/workouts/2026-03-18')).statusCode, 404);
});

test('refused: future days, no exercises, nameless exercises, more than 8 sets', async () => {
  const { signIn } = await setup();
  const lee = await signIn('lee@example.com');
  assert.equal((await lee.send('PUT', '/api/workouts/2026-03-21', squatDay())).statusCode, 400, 'tomorrow');
  assert.equal((await lee.send('PUT', '/api/workouts/2026-03-18', { exercises: [] })).statusCode, 400);
  assert.equal((await lee.send('PUT', '/api/workouts/2026-03-18', { exercises: [{ name: ' ', sets: [] }] })).statusCode, 400);
  const nine = Array.from({ length: 9 }, () => ({ weight: '100', reps: '5' }));
  assert.equal((await lee.send('PUT', '/api/workouts/2026-03-18', { exercises: [{ name: 'Squat', sets: nine }] })).statusCode, 400);
  assert.equal((await lee.send('PUT', '/api/workouts/not-a-date', squatDay())).statusCode, 400);
});

test('a Workout Log sync never touches app workouts; another user never sees or changes them', async () => {
  const { store, signIn } = await setup();
  const lee = await signIn('lee@example.com');
  const kim = await signIn('kim@example.com');
  await lee.send('PUT', '/api/workouts/2026-03-18', squatDay());
  const sheet = fakeSource({ workout_log: { 2026: [WORKOUT_LOG_HEADER, ['3/19/2026', 'Sheet day', 'Deadlift', '225', '5']] } });
  await runSync({ store: scopeStore(store, 'lee'), source: sheet, apple: 'rest', exportFolders: {}, now: NOW });
  const days = (await lee.get('/api/workouts')).json();
  assert.deepEqual(days.map((d) => [d.date, d.source]), [['2026-03-19', 'sheet'], ['2026-03-18', 'app']]);
  assert.deepEqual((await kim.get('/api/workouts')).json(), []);
  assert.equal((await kim.send('DELETE', '/api/workouts/2026-03-18')).statusCode, 404);
  assert.equal(store.db.prepare("SELECT COUNT(*) FROM strength_exercises WHERE user_id = 'lee' AND tab_year = 0").pluck().get(), 3);
});

test('their own programs pre-fill a workout, and a logged program name makes a block', async () => {
  const { signIn } = await setup();
  const lee = await signIn('lee@example.com');
  const program = { name: 'Garage 5x5', weeks: 4, phases: [{ name: 'Phase 1', weeks: [1, 4], workouts: [{ name: 'A', exercises: [{ name: 'Barbell Squat', sets: '5', reps: '5' }] }] }] };
  await lee.send('POST', '/api/programs', { program, match: '5x5' });
  const s = (await lee.get('/api/workouts/suggest')).json();
  assert.deepEqual(s.templates.map((t) => t.label), ['Garage 5x5, Phase 1, A']);
  assert.ok(s.names.includes('Barbell Squat'));
  for (const d of ['2026-03-10', '2026-03-12', '2026-03-17']) await lee.send('PUT', `/api/workouts/${d}`, squatDay('Garage 5x5 Phase 1 A'));
  const blocks = (await lee.get('/api/program/blocks')).json();
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].program, 'Garage 5x5');
});
