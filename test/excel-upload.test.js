// The Excel Workout Log: the template download, and uploading a workbook (ingest/excel-upload.js). Only .xlsx is taken,
// the year tabs replace those years' rows (other years and app workouts stay), and every refusal leaves nothing behind.
// Synthetic accounts and made-up workouts; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { OWNER_ID } from '../db/users.js';
import { readXlsx, writeXlsx, XLSX_TYPE } from '../tools/xlsx.js';
import { WORKOUT_LOG_HEADER } from '../ingest/create-sheet.js';
import { MAX_UPLOAD_BYTES } from '../ingest/excel-upload.js';

const SITE = 'http://localhost:5188';
const NOW = new Date('2026-03-20T16:00:00Z');
const row = (date, workout, exercise, w1, s1, w2 = '', s2 = '') => {
  const r = Array(WORKOUT_LOG_HEADER.length).fill('');
  Object.assign(r, { 0: date, 1: workout, 2: exercise, 3: w1, 4: s1, 5: w2, 6: s2 });
  return r;
};
const book = (tabs) => writeXlsx([...Object.entries(tabs).map(([name, rows]) => ({ name, rows: [WORKOUT_LOG_HEADER, ...rows] })), { name: 'How to use', rows: [['x']] }]);

async function setup({ authMode = 'google', instance = 'main' } = {}) {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x'), ('kim', 'kim@example.com', 'user', 'approved', 'x')").run();
  const lines = [];
  let email;
  let nonce;
  const app = await buildApp({ store, authMode, instance, clock: () => NOW, mailer: { send: async () => true }, log: { info: (l) => lines.push(l), warn: (l) => lines.push(l), error() {} },
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login');
    const url = new URL(login.headers.location);
    nonce = url.searchParams.get('nonce');
    const res = await app.inject({ url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: cookies(login) } });
    const cookie = cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
    return {
      get: (u) => app.inject({ url: u, headers: { cookie } }),
      send: (method, u, payload) => app.inject({ method, url: u, headers: { cookie, origin: SITE }, ...(payload ? { payload } : {}) }),
      upload: (buf, { name = 'Workout Log.xlsx', type = XLSX_TYPE } = {}) => app.inject({ method: 'POST', url: '/api/workout-log/upload',
        headers: { cookie, origin: SITE, 'content-type': type, 'x-file-name': encodeURIComponent(name) }, payload: buf }),
    };
  };
  const count = (uid, year) => store.db.prepare('SELECT COUNT(*) FROM strength_exercises WHERE user_id = ? AND tab_year = ?').pluck().get(uid, year);
  return { app, store, signIn, count, lines };
}

test('template: the year tab with the Workout Log columns and How to use; opens as a workbook', async () => {
  const { signIn } = await setup();
  const lee = await signIn('lee@example.com');
  const res = await lee.get('/api/workout-log/template.xlsx');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], XLSX_TYPE);
  assert.match(res.headers['content-disposition'], /attachment; filename="Health Review Workout Log\.xlsx"/);
  const wb = readXlsx(res.rawPayload);
  assert.deepEqual(wb.sheets.map((s) => s.name), ['2026', 'How to use']);
  assert.deepEqual(wb.sheets[0].rows, [WORKOUT_LOG_HEADER]);
  assert.match(wb.sheets[1].rows.flat().join(' '), /upload this file in Health Review/);
});

test('upload: year tabs replace those years; other years and app workouts stay; a run with counts only', async () => {
  const { store, signIn, count, lines } = await setup();
  const lee = await signIn('lee@example.com');
  await lee.send('PUT', '/api/workouts/2026-03-18', { workout: 'In the app', exercises: [{ name: 'Barbell Bench Press', sets: [{ weight: '135', reps: '8' }] }] });
  const first = await lee.upload(book({
    2025: [row('12/1/2025', 'Old', 'Barbell Squat', 175, 5)],
    2026: [row(46083, 'Garage 5x5 Phase 1 A', 'Barbell Squat', 185, 5, 185, 5), row('', '', 'Pullups', 'BW', 8), row('Sick', '', '', '', '')],
  }));
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().years, [2025, 2026]);
  assert.equal(first.json().exercises, 3);
  assert.equal(first.json().sets, 4);
  assert.equal(first.json().notes, 1);
  assert.equal(count('lee', 2026), 2);
  assert.equal(count('lee', 0), 1, 'the app workout stays');
  assert.equal((await lee.get('/api/training?view=month')).json().totals.volumeLbs, 185 * 5 * 2 + 135 * 8);

  // Uploading only 2026 again replaces 2026 and keeps 2025.
  await lee.upload(book({ 2026: [row(46090, 'Garage 5x5 Phase 1 B', 'Barbell Deadlift', 225, 5)] }));
  assert.equal(count('lee', 2026), 1);
  assert.equal(count('lee', 2025), 1);
  assert.deepEqual(store.db.prepare("SELECT exercise FROM strength_exercises WHERE user_id = 'lee' AND tab_year = 2026").pluck().all(), ['Barbell Deadlift']);
  assert.equal(count('kim', 2026), 0, 'never another user');

  const run = store.db.prepare("SELECT * FROM runs WHERE name = 'workout-upload' AND user_id = 'lee' ORDER BY id DESC").get();
  assert.equal(run.status, 'ok');
  const traces = JSON.stringify(run) + lines.join('\n');
  assert.ok(!/Deadlift|Garage|Squat/.test(traces), 'no file content in the run or the log');
});

test('refused before anything changes: other file types, a renamed CSV, an .xls, no year tab, bad columns, too big', async () => {
  const { signIn, count } = await setup();
  const lee = await signIn('lee@example.com');
  const good = book({ 2026: [row(46083, 'A', 'Barbell Squat', 185, 5)] });
  assert.equal((await lee.upload(good, { type: 'text/csv' })).statusCode, 415);
  assert.equal((await lee.upload(good, { type: 'application/octet-stream' })).statusCode, 415);
  assert.equal((await lee.send('POST', '/api/workout-log/upload', { rows: [] })).statusCode, 415, 'JSON is not a workbook');
  assert.equal((await lee.upload(good, { name: 'log.xlsm' })).statusCode, 415, 'the name must end .xlsx');
  assert.equal((await lee.upload(good, { name: 'log.csv' })).statusCode, 415);
  const csv = await lee.upload(Buffer.from('Date,Workout,Exercise\n3/2/2026,A,Squat\n'), { name: 'renamed.xlsx' });
  assert.equal(csv.statusCode, 400);
  assert.match(csv.json().error, /not an Excel workbook/);
  const xls = await lee.upload(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]), { name: 'old.xlsx' });
  assert.match(xls.json().error, /\.xls/);
  const macro = await lee.upload(readFileSync(new URL('./fixtures/excel/macro-enabled.xlsm', import.meta.url)), { name: 'm.xlsx' });
  assert.match(macro.json().error, /macros/);
  const noYear = await lee.upload(writeXlsx([{ name: 'Sheet1', rows: [WORKOUT_LOG_HEADER, row(46083, 'A', 'Squat', 1, 1)] }]));
  assert.match(noYear.json().error, /No tab named with a year/);
  const badColumns = await lee.upload(writeXlsx([{ name: '2026', rows: [['Day', 'Lift'], ['x', 'y']] }]));
  assert.equal(badColumns.statusCode, 400);
  assert.match(badColumns.json().error, /Row 1 needs the Workout Log columns/);
  assert.equal((await lee.upload(Buffer.alloc(MAX_UPLOAD_BYTES + 1))).statusCode, 413);
  assert.equal(count('lee', 2026), 0, 'nothing was stored');
});

test('refused for the owner, paused users, users syncing a Google Sheet, past 10 an hour, and in the demo', async () => {
  const { store, signIn } = await setup();
  const good = book({ 2026: [row(46083, 'A', 'Barbell Squat', 185, 5)] });
  const owner = await signIn('owner@example.com');
  assert.equal((await owner.upload(good)).statusCode, 409);
  const kim = await signIn('kim@example.com');
  store.db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES ('kim', 'workout_log_sheet_id', 'made-up-sheet-id', 'x')").run();
  assert.match((await kim.upload(good)).json().error, /Google Sheet/);
  const lee = await signIn('lee@example.com');
  await lee.send('POST', '/api/account/pause');
  assert.equal((await lee.upload(good)).statusCode, 403);
  await lee.send('POST', '/api/account/resume');
  for (let i = 0; i < 10; i++) assert.equal((await lee.upload(good)).statusCode, 200);
  assert.equal((await lee.upload(good)).statusCode, 429);
  assert.ok(OWNER_ID);

  const demo = await setup({ authMode: 'demo', instance: 'demo' });
  const res = await demo.app.inject({ method: 'POST', url: '/api/workout-log/upload', headers: { 'content-type': XLSX_TYPE, 'x-file-name': 'log.xlsx' }, payload: good });
  assert.equal(res.statusCode, 403);
  assert.equal((await demo.app.inject('/api/workout-log/template.xlsx')).statusCode, 200, 'the demo may download the empty template');
});
