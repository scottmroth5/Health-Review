// Multi-user phase 3: each user's own Health Auto Export token and Google Sheets Workout Log, the sync that reads only
// their sheet, and the setup guides. Synthetic accounts, a fake Google exchange and a fake Sheets source; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openHealthStore } from '../db/store.js';
import { scopeStore } from '../db/scope.js';
import { buildApp } from '../server/app.js';
import { authSettings, SHEETS_CALLBACK_PATH } from '../server/auth.js';
import { boxKey, open } from '../tools/secret-box.js';
import { OWNER_ID } from '../db/users.js';
import { syncJob } from '../jobs/sync.js';

const SITE = 'http://localhost:5188';
const OWNER_TOKEN = 'owner-ingest-token-made-up-0123456789';
const health = JSON.parse(readFileSync(new URL('./fixtures/ingest/health.json', import.meta.url), 'utf8'));

async function setup() {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x'), ('kim', 'kim@example.com', 'user', 'pending', 'x')").run();
  const keyBox = boxKey('test-user-key-secret-long-enough-32+');
  let email;
  let nonce;
  const sheetTabs = { good: ['2025', '2026', 'Notes'], none: ['Sheet1'] };
  const services = { sheetTabs: async (uid, id) => { if (!sheetTabs[id.slice(0, 4)]) throw new Error('no access'); return sheetTabs[id.slice(0, 4)]; } };
  const app = await buildApp({ store, authMode: 'google', keyBox, services, ingest: { token: OWNER_TOKEN, apple: 'rest' }, mailer: { send: async () => true },
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }), sheetsExchange: async () => ({ refresh_token: 'made-up-refresh', scope: 'https://www.googleapis.com/auth/spreadsheets.readonly' }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login');
    const url = new URL(login.headers.location);
    nonce = url.searchParams.get('nonce');
    const res = await app.inject({ url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: cookies(login) } });
    const cookie = cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
    return { cookie, get: (u) => app.inject({ url: u, headers: { cookie } }), send: (method, u, payload) => app.inject({ method, url: u, headers: { cookie, origin: SITE }, ...(payload ? { payload } : {}) }) };
  };
  const post = (token, body = health) => app.inject({ method: 'POST', url: '/api/ingest/health', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: body });
  const days = (uid) => store.db.prepare('SELECT COUNT(*) FROM daily_metrics WHERE user_id = ?').pluck().get(uid);
  return { app, store, keyBox, signIn, post, days, cookies };
}

test('ingest tokens: a user\'s posts are theirs; shown once, only the hash kept; replaced or pending tokens refused', async () => {
  const { app, store, signIn, post, days } = await setup();
  const lee = await signIn('lee@example.com');
  const made = (await lee.send('POST', '/api/account/ingest-token')).json();
  assert.ok(typeof made.token === 'string' && made.token.length > 30 && made.urls.health.endsWith('/api/ingest/health'));
  const acct = JSON.stringify((await lee.get('/api/account')).json());
  assert.ok(!acct.includes(made.token), 'shown only once');
  assert.ok(!JSON.stringify(store.db.prepare("SELECT * FROM users WHERE id = 'lee'").get()).includes(made.token), 'only the hash is stored');

  assert.equal((await post(made.token)).statusCode, 200);
  assert.ok(days('lee') > 0);
  assert.equal(days(OWNER_ID), 0, "never lands on the owner's account");
  assert.equal((await post(OWNER_TOKEN)).statusCode, 200);
  assert.ok(days(OWNER_ID) > 0, "the owner's INGEST_TOKEN still works");

  const replaced = (await lee.send('POST', '/api/account/ingest-token')).json().token;
  assert.equal((await post(made.token)).statusCode, 401, 'the old token stops working');
  assert.equal((await post(replaced)).statusCode, 200);
  store.db.prepare("UPDATE users SET status = 'paused' WHERE id = 'lee'").run();
  assert.equal((await post(replaced)).statusCode, 401, "a paused user's token is refused");
  const owner = await signIn('owner@example.com');
  assert.equal((await owner.send('POST', '/api/account/ingest-token')).statusCode, 409);
  await app.close();
  store.close();
});

test('google sheets: consent stores a sealed refresh token; the sheet is checked for year tabs; disconnect forgets both', async () => {
  const { app, store, keyBox, signIn, cookies } = await setup();
  const lee = await signIn('lee@example.com');
  assert.equal((await lee.send('PUT', '/api/account/workout-sheet', { sheet: 'good-sheet-id-0000000000000' })).statusCode, 409, 'connect first');
  const start = await app.inject({ url: '/auth/google/sheets', headers: { cookie: lee.cookie } });
  const url = new URL(start.headers.location);
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  const back = await app.inject({ url: `${SHEETS_CALLBACK_PATH}?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: `${lee.cookie}; ${cookies(start)}` } });
  assert.equal(back.headers.location, '/#settings/sheets-connected');
  const sealed = store.db.prepare("SELECT google_refresh_enc FROM users WHERE id = 'lee'").pluck().get();
  assert.equal(open(sealed, 'lee', keyBox), 'made-up-refresh');
  assert.ok(!(await lee.get('/api/account')).body.includes('made-up-refresh'));

  assert.equal((await lee.send('PUT', '/api/account/workout-sheet', { sheet: 'https://docs.google.com/spreadsheets/d/none-sheet-id-000000000000/edit' })).statusCode, 400, 'no year tabs');
  const saved = await lee.send('PUT', '/api/account/workout-sheet', { sheet: 'https://docs.google.com/spreadsheets/d/good-sheet-id-0000000000000/edit#gid=0' });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().yearTabs, ['2025', '2026']);
  assert.equal(saved.json().feeds.workoutLog.sheetSet, true);
  const users = (await (await signIn('owner@example.com')).get('/api/admin/users')).json();
  assert.ok(!JSON.stringify(users).includes('good-sheet-id'), 'the sheet ID is never on the admin screen');

  await lee.send('DELETE', '/api/account/google');
  assert.equal(store.db.prepare("SELECT google_refresh_enc FROM users WHERE id = 'lee'").pluck().get(), null);
  assert.equal((await lee.get('/api/account')).json().feeds.workoutLog.sheetSet, false);
  // Without a session the consent cannot start; a pending user cannot either.
  assert.equal((await app.inject('/auth/google/sheets')).headers.location, '/auth/login');
  const kim = await signIn('kim@example.com');
  assert.equal((await app.inject({ url: '/auth/google/sheets', headers: { cookie: kim.cookie } })).headers.location, '/auth/login');
  await app.close();
  store.close();
});

test("sync: another user's sync reads only their sheet and writes only their rows; without one it reads nothing", async () => {
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x')").run();
  const asked = [];
  const source = {
    has: (s) => s === 'workout_log',
    listTabs: async (s) => { asked.push(s); return ['2026']; },
    readRows: async (s, tab) => { asked.push(`${s}:${tab}`); return { header: ['Date', 'Workout', 'Exercise', 'Weight 1', 'Set 1'], rows: [[46082, 'Day A', 'Barbell Squat', 185, 8]], firstRowNumber: 2, tab }; },
  };
  const lee = scopeStore(store, 'lee');
  assert.deepEqual(await syncJob({ store: lee, source }), { counts: {}, warnings: [] }, 'no sheet: nothing read');
  const r = await syncJob({ store: lee, source, userFeed: { sheetId: 'x', catalog: null }, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(r.counts.workout_log.exercises, 1);
  assert.deepEqual([...new Set(asked.map((a) => a.split(':')[0]))], ['workout_log'], 'only the Workout Log');
  assert.equal(store.db.prepare("SELECT COUNT(*) FROM strength_exercises WHERE user_id = 'lee'").pluck().get(), 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM strength_exercises WHERE user_id <> ?').pluck().get('lee'), 0);
  store.close();
});

test('guides: every guide renders without signing in, with the site address filled in', async () => {
  const { app, store } = await setup();
  for (const name of ['', '/health-auto-export', '/workout-log', '/manual-entry', '/claude-key']) {
    const res = await app.inject(`/guides${name}`);
    assert.equal(res.statusCode, 200, name);
    assert.ok(!res.body.includes('{{SITE}}'));
  }
  assert.match((await app.inject('/guides/health-auto-export')).body, new RegExp(`${SITE}/api/ingest/health`));
  assert.equal((await app.inject('/guides/nope')).statusCode, 404);
  await app.close();
  store.close();
});
