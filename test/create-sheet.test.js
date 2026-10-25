// "Create my Workout Log": the sheet Health Review makes in a user's Drive (drive.file), laid out for the Workout Log
// parser, and the consent flow that creates it. A fake Google exchange and a fake Sheets client; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings, SHEETS_CALLBACK_PATH, SHEETS_SCOPE, DRIVE_FILE_SCOPE } from '../server/auth.js';
import { boxKey } from '../tools/secret-box.js';
import { OWNER_ID } from '../db/users.js';
import { createWorkoutSheet, workoutSheetBody, WORKOUT_LOG_HEADER, WORKOUT_LOG_TITLE } from '../ingest/create-sheet.js';
import { parseWorkoutLogTab } from '../ingest/parsers.js';

const SITE = 'http://localhost:5188';

test('the sheet: a year tab whose row 1 the Workout Log parser reads, a How to use tab, no example rows', async () => {
  assert.deepEqual(WORKOUT_LOG_HEADER.slice(0, 5), ['Date', 'Workout', 'Exercise', 'Weight 1', 'Set 1']);
  assert.equal(WORKOUT_LOG_HEADER.at(-2), 'Set 8');
  assert.equal(WORKOUT_LOG_HEADER.at(-1), 'Comment');
  const body = workoutSheetBody('2026');
  assert.equal(body.properties.title, WORKOUT_LOG_TITLE);
  assert.deepEqual(body.sheets.map((s) => s.properties.title), ['2026', 'How to use']);
  const rows = body.sheets[0].data[0].rowData;
  assert.equal(rows.length, 1, 'only the column row');
  const header = rows[0].values.map((v) => v.userEnteredValue.stringValue);
  assert.deepEqual(header, WORKOUT_LOG_HEADER);
  // The parser takes the header with no rows, and with a logged row reads its sets.
  const empty = parseWorkoutLogTab({ header, rows: [], firstRowNumber: 2, tab: '2026' });
  assert.deepEqual([empty.records, empty.warnings], [[], []]);
  const row = Array(header.length).fill('');
  Object.assign(row, { 0: '3/2/2026', 1: 'Garage 5x5 Phase 1 A', 2: 'Barbell Squat', 3: '185', 4: '5', 5: '185', 6: '4', [header.length - 1]: 'last set hard' });
  const parsed = parseWorkoutLogTab({ header, rows: [row], firstRowNumber: 2, tab: '2026' });
  assert.deepEqual(parsed.warnings, []);
  const [ex] = parsed.records;
  assert.equal(ex.date, '2026-03-02');
  assert.equal(ex.workout, 'Garage 5x5 Phase 1 A');
  assert.deepEqual(ex.sets.map((s) => [s.weight_lbs, s.reps]), [[185, 5], [185, 4]]);
  assert.equal(ex.comment, 'last set hard');

  const calls = [];
  const api = { spreadsheets: {
    create: async (a) => { calls.push(['create', a]); return { data: { spreadsheetId: 'made-up-new-sheet-0000000000', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/made-up-new-sheet-0000000000/edit' } }; },
    batchUpdate: async (a) => { calls.push(['format', a]); return { data: {} }; },
  } };
  const made = await createWorkoutSheet({ api, year: '2026' });
  assert.equal(made.id, 'made-up-new-sheet-0000000000');
  assert.deepEqual(calls.map(([k]) => k), ['create', 'format']);
  assert.equal(calls[1][1].spreadsheetId, made.id);
});

async function setup({ granted }) {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x')").run();
  const created = [];
  const services = { createWorkoutSheet: async (uid) => { created.push(uid); return { id: `made-up-sheet-for-${uid}-000000` }; } };
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', keyBox: boxKey('test-user-key-secret-long-enough-32+'), services, mailer: { send: async () => true },
    log: { info() {}, warn() {}, error() {} },
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }), sheetsExchange: async () => ({ refresh_token: 'made-up-refresh', scope: granted }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login');
    const url = new URL(login.headers.location);
    nonce = url.searchParams.get('nonce');
    const res = await app.inject({ url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: cookies(login) } });
    return cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
  };
  const consent = async (cookie, path) => {
    const start = await app.inject({ url: path, headers: { cookie } });
    const url = new URL(start.headers.location);
    const back = await app.inject({ url: `${SHEETS_CALLBACK_PATH}?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: `${cookie}; ${cookies(start)}` } });
    return { scope: url.searchParams.get('scope'), location: back.headers.location };
  };
  const sheetOf = (uid) => store.db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'workout_log_sheet_id'").pluck().get(uid) ?? null;
  return { app, created, signIn, consent, sheetOf };
}

test('Create my Workout Log: asks for read-only Sheets plus drive.file, creates the sheet and saves it as theirs', async () => {
  const { app, created, signIn, consent, sheetOf } = await setup({ granted: `${SHEETS_SCOPE} ${DRIVE_FILE_SCOPE}` });
  const lee = await signIn('lee@example.com');
  const r = await consent(lee, '/auth/google/sheets?create=1');
  assert.equal(r.scope, `${SHEETS_SCOPE} ${DRIVE_FILE_SCOPE}`);
  assert.equal(r.location, '/#settings/sheets-created');
  assert.deepEqual(created, ['lee']);
  assert.equal(sheetOf('lee'), 'made-up-sheet-for-lee-000000');
  const wl = (await app.inject({ url: '/api/account', headers: { cookie: lee } })).json().feeds.workoutLog;
  assert.equal(wl.sheetSet, true);
  assert.equal(wl.canCreate, true);
  assert.equal(wl.sheetUrl, 'https://docs.google.com/spreadsheets/d/made-up-sheet-for-lee-000000/edit');
  // Plain Connect still asks for read-only Sheets only, and creates nothing.
  const plain = await consent(lee, '/auth/google/sheets');
  assert.equal(plain.scope, SHEETS_SCOPE);
  assert.equal(plain.location, '/#settings/sheets-connected');
  assert.equal(created.length, 1);
});

test('Create my Workout Log: refused when drive.file is not granted, and never for the owner', async () => {
  const a = await setup({ granted: SHEETS_SCOPE });
  const lee = await a.signIn('lee@example.com');
  assert.equal((await a.consent(lee, '/auth/google/sheets?create=1')).location, '/#settings/sheets-incomplete');
  assert.equal(a.created.length, 0);
  assert.equal(a.sheetOf('lee'), null);

  const b = await setup({ granted: `${SHEETS_SCOPE} ${DRIVE_FILE_SCOPE}` });
  const owner = await b.signIn('owner@example.com');
  assert.equal((await b.consent(owner, '/auth/google/sheets?create=1')).location, '/#settings/sheets-create-failed');
  assert.equal(b.created.length, 0);
  assert.equal(b.sheetOf(OWNER_ID), null);
});
