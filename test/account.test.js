// Multi-user phase 6: export your data, pause and resume yourself, delete your account (and the admin's delete), Help's
// Ask, and the demo's Request access link. Synthetic accounts and data, a fake Google exchange, a fake mailer and a fake
// Claude; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openHealthStore } from '../db/store.js';
import { scopeDb } from '../db/scope.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { OWNER_ID, getUser } from '../db/users.js';
import { activeUserIds } from '../server/admin-queries.js';
import { HELP_MODEL } from '../agent/help.js';

const SITE = 'http://localhost:5188';
const NOW = new Date('2026-03-20T16:00:00Z');
const health = JSON.parse(readFileSync(new URL('./fixtures/ingest/health.json', import.meta.url), 'utf8'));

async function setup({ claude = null, access = {} } = {}) {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare(`INSERT INTO users (id, email, name, role, status, created_at, claude_key_enc, google_refresh_enc) VALUES
    ('lee', 'lee@example.com', 'Lee', 'user', 'approved', 'x', 'sealed-made-up-key', 'sealed-made-up-refresh'),
    ('kim', 'kim@example.com', 'Kim', 'user', 'approved', 'x', NULL, NULL)`).run();
  const mail = [];
  const services = {
    sync: async () => ({ counts: {}, warnings: [] }),
    ...(claude ? { claude: () => claude } : {}),
    aiAccess: (uid) => (getUser(store.db, uid)?.status === 'paused' ? { source: null, reason: 'paused' } : access[uid] ?? { source: 'own', reason: null }),
  };
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', services, clock: () => NOW, mailer: { send: async (m) => { mail.push(m); return true; } },
    ingest: { token: 'owner-ingest-token-made-up-0123456789', apple: 'rest' }, log: { info() {}, warn() {}, error() {} },
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
  // A little made-up data in several tables for a user.
  const seed = (uid) => {
    const db = scopeDb(store.db, uid);
    db.prepare("INSERT INTO checkins (user_id, date, cadence, readiness, source, updated_at) VALUES (@uid, '2026-03-19', 'daily', 7, 'ui', 'x')").run();
    db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'workout_log_sheet_id', 'made-up-sheet', 'x')").run();
    const med = db.prepare("INSERT INTO medications (user_id, name, kind, created_at) VALUES (@uid, 'Made-up Supplement', 'supplement', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO medication_periods (user_id, medication_id, timings, started_on, created_at) VALUES (@uid, ?, '[\"morning\"]', '2026-01-01', 'x')").run(med);
    db.prepare("INSERT INTO medication_doses (user_id, date, medication_id, timing, taken, updated_at) VALUES (@uid, '2026-03-19', ?, 'morning', 1, 'x')").run(med);
    const ex = db.prepare("INSERT INTO strength_exercises (user_id, tab_year, row_no, date, workout, exercise) VALUES (@uid, 2026, 2, '2026-03-18', 'A', 'Barbell Squat')").run().lastInsertRowid;
    db.prepare("INSERT INTO strength_sets (user_id, exercise_id, set_no, weight_lbs, reps) VALUES (@uid, ?, 1, 100, 5)").run(ex);
    const run = store.db.prepare("INSERT INTO runs (name, status, started_at, user_id) VALUES ('sync', 'ok', 'x', ?)").run(uid).lastInsertRowid;
    store.db.prepare("INSERT INTO run_calls (run_id, label, model, created_at) VALUES (?, 'made-up', 'm', 'x')").run(run);
  };
  const userTables = () => store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all()
    .filter((t) => store.db.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === 'user_id'));
  const rowsOf = (uid) => Object.fromEntries(userTables().map((t) => [t, store.db.prepare(`SELECT COUNT(*) FROM "${t}" WHERE user_id = ?`).pluck().get(uid)]));
  return { app, store, mail, signIn, seed, rowsOf };
}

test('export: every row of theirs, none of anyone else\'s, never a sealed key, token hash or Google permission', async () => {
  const { store, signIn, seed } = await setup();
  seed('lee');
  seed('kim');
  const lee = await signIn('lee@example.com');
  await lee.send('POST', '/api/account/ingest-token');
  const res = await lee.get('/api/account/export');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-disposition'], /attachment; filename="health-review-export-2026-03-20\.json"/);
  const data = res.json();
  assert.equal(data.account.email, 'lee@example.com');
  for (const c of ['claude_key_enc', 'ingest_token_hash', 'google_refresh_enc']) assert.equal(data.account[c], undefined, `${c} left out`);
  assert.equal(data.tables.checkins.length, 1);
  assert.equal(data.tables.medication_doses.length, 1);
  assert.equal(data.tables.settings.find((s) => s.key === 'workout_log_sheet_id').value, 'made-up-sheet', 'their own sheet setting is theirs');
  assert.equal(data.tables.run_calls.length, 1);
  assert.ok(data.tables.user_programs, 'later tables are included too');
  const text = JSON.stringify(data);
  assert.ok(!text.includes('kim@example.com') && !text.includes('"kim"'), 'nothing of another user');
  assert.ok(!text.includes('sealed-made-up') && !text.includes(getUser(store.db, 'lee').ingest_token_hash));
});

test('delete: typed email, every table emptied for them, the other user untouched, admin emailed, signed out', async () => {
  const { app, store, mail, signIn, seed, rowsOf } = await setup();
  seed('lee');
  seed('kim');
  const kimBefore = rowsOf('kim');
  const lee = await signIn('lee@example.com');
  assert.equal((await lee.send('POST', '/api/account/delete', { confirmEmail: 'someone@example.com' })).statusCode, 400);
  const res = await lee.send('POST', '/api/account/delete', { confirmEmail: ' LEE@example.com ' });
  assert.equal(res.statusCode, 200);
  assert.match([res.headers['set-cookie']].flat().join(';'), /hr_session=;/);
  assert.ok(Object.values(rowsOf('lee')).every((n) => n === 0), 'nothing of theirs left');
  assert.equal(getUser(store.db, 'lee'), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM run_calls').pluck().get(), 1, "only kim's run call is left");
  assert.deepEqual(rowsOf('kim'), kimBefore, 'the other user untouched');
  assert.equal(mail.at(-1).to, 'owner@example.com');
  assert.match(mail.at(-1).text, /lee@example\.com/);
  assert.equal((await lee.get('/api/status')).statusCode, 403, 'their session no longer gets in');
  assert.equal((await lee.get('/')).headers.location, '/auth/register');
  const owner = await signIn('owner@example.com');
  assert.equal((await owner.send('POST', '/api/account/delete', { confirmEmail: 'owner@example.com' })).statusCode, 409, 'never the owner');
  assert.ok(app);
});

test('admin delete: confirmed with their email, only admins, never an admin', async () => {
  const { store, signIn, seed, rowsOf } = await setup();
  seed('lee');
  seed('kim');
  const kim = await signIn('kim@example.com');
  assert.equal((await kim.send('POST', '/api/admin/users/lee/delete', { confirmEmail: 'lee@example.com' })).statusCode, 403);
  const owner = await signIn('owner@example.com');
  assert.equal((await owner.send('POST', '/api/admin/users/lee/delete', { confirmEmail: 'kim@example.com' })).statusCode, 400);
  assert.equal((await owner.send('POST', `/api/admin/users/${OWNER_ID}/delete`, { confirmEmail: 'owner@example.com' })).statusCode, 409);
  assert.equal((await owner.send('POST', '/api/admin/users/lee/delete', { confirmEmail: 'lee@example.com' })).statusCode, 200);
  assert.equal(getUser(store.db, 'lee'), null);
  assert.ok(Object.values(rowsOf('lee')).every((n) => n === 0));
  assert.ok(Object.values(rowsOf('kim')).some((n) => n > 0));
});

test('pause yourself: posts and syncs stop; you can resume your own pause, never the administrator\'s', async () => {
  const { app, store, signIn } = await setup();
  const lee = await signIn('lee@example.com');
  const token = (await lee.send('POST', '/api/account/ingest-token')).json().token;
  const post = () => app.inject({ method: 'POST', url: '/api/ingest/health', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: health });
  const paused = (await lee.send('POST', '/api/account/pause')).json();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pausedBySelf, true);
  assert.equal((await post()).statusCode, 401);
  assert.equal((await lee.send('POST', '/api/sync')).statusCode, 403);
  assert.ok(!activeUserIds(store.db).includes('lee'));
  assert.equal((await lee.send('POST', '/api/account/resume')).json().status, 'approved');
  assert.equal((await post()).statusCode, 200);

  // The administrator's pause: only the administrator resumes it.
  const owner = await signIn('owner@example.com');
  await lee.send('POST', '/api/account/pause');
  await owner.send('POST', '/api/admin/users/lee/resume');
  await owner.send('POST', '/api/admin/users/lee/pause');
  assert.equal((await lee.get('/api/account')).json().pausedBySelf, false);
  assert.equal((await lee.send('POST', '/api/account/resume')).statusCode, 409);
  assert.equal((await owner.send('POST', '/api/account/pause')).statusCode, 409, 'never the owner');
});

test('Ask: the guides and the question only, on the user\'s AI; refused without AI; 20 an hour', async () => {
  const calls = [];
  const claude = { send: async (opts) => { calls.push(opts); return { text: 'Open Settings — then Data feeds.', model: opts.model }; } };
  const { store, signIn, seed } = await setup({ claude, access: { kim: { source: null, reason: 'no_key' } } });
  seed('lee');
  const lee = await signIn('lee@example.com');
  const kim = await signIn('kim@example.com');
  assert.deepEqual((await lee.get('/api/help')).json(), { ask: true, aiReason: null });
  assert.deepEqual((await kim.get('/api/help')).json(), { ask: false, aiReason: 'no_key' });
  assert.equal((await kim.send('POST', '/api/help/ask', { question: 'How do I sync?' })).statusCode, 503);

  const res = await lee.send('POST', '/api/help/ask', { question: 'How do I connect my Workout Log?' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().answer, 'Open Settings, then Data feeds.', 'dashes replaced');
  assert.equal(calls[0].model, HELP_MODEL);
  assert.equal(calls[0].prompt, 'How do I connect my Workout Log?');
  assert.match(calls[0].system, /Connect Google Sheets/, 'the guides are the context');
  const sent = JSON.stringify(calls[0]);
  for (const mine of ['Made-up Supplement', 'made-up-sheet', 'lee@example.com', 'Barbell Squat 100']) assert.ok(!sent.includes(mine), `never their data (${mine})`);
  const runRow = store.db.prepare("SELECT * FROM runs WHERE name = 'help-ask'").get();
  assert.equal(runRow.user_id, 'lee');
  assert.ok(!JSON.stringify(runRow).includes('Workout Log?'), 'the question is not in the run record');

  for (let i = 1; i < 20; i++) await lee.send('POST', '/api/help/ask', { question: `Question ${i}` });
  assert.equal((await lee.send('POST', '/api/help/ask', { question: 'One more' })).statusCode, 429);
});

test('the demo carries its Request access link only when it is given one', async () => {
  const store = openHealthStore(':memory:');
  const withLink = await buildApp({ store, authMode: 'demo', instance: 'demo', requestAccessUrl: 'https://app.example.com/auth/login', features: { chat: false } });
  assert.equal((await withLink.inject('/api/status')).json().requestAccessUrl, 'https://app.example.com/auth/login');
  const without = await buildApp({ store, authMode: 'demo', instance: 'demo', features: { chat: false } });
  assert.equal((await without.inject('/api/status')).json().requestAccessUrl, undefined);
  const main = await buildApp({ store, requestAccessUrl: 'https://app.example.com/auth/login' });
  assert.equal((await main.inject('/api/status')).json().requestAccessUrl, undefined, 'only the demo shows it');
});
