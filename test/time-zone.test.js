// A time zone per user (tools/time.js withTimeZone): a user's "today" and receipt times follow their own zone; the owner
// stays on OWNER_TZ. Also: one user's manual review or sync never blocks or shows for another. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { localDate, withTimeZone, isTimeZone } from '../tools/time.js';

const SITE = 'http://localhost:5188';
// 1:00 am Friday March 20 in New York; still Thursday March 19 (10:00 pm) in Los Angeles.
const NOW = new Date('2026-03-20T05:00:00Z');
const health = JSON.parse(readFileSync(new URL('./fixtures/ingest/health.json', import.meta.url), 'utf8'));

test('withTimeZone sets every default zone inside it; outside, OWNER_TZ', async () => {
  assert.equal(localDate(NOW), '2026-03-20');
  assert.equal(withTimeZone('America/Los_Angeles', () => localDate(NOW)), '2026-03-19');
  assert.equal(await withTimeZone('Asia/Tokyo', async () => { await new Promise((r) => setImmediate(r)); return localDate(NOW); }), '2026-03-20', 'across awaits');
  assert.equal(withTimeZone(null, () => localDate(NOW)), '2026-03-20');
  assert.equal(isTimeZone('America/Chicago'), true);
  assert.equal(isTimeZone('Mars/Olympus'), false);
});

async function setup({ services = {} } = {}) {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x'), ('kim', 'kim@example.com', 'user', 'approved', 'x')").run();
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', services, clock: () => NOW, mailer: { send: async () => true }, log: { info() {}, warn() {}, error() {} },
    ingest: { token: 'owner-ingest-token-made-up-0123456789', apple: 'rest' },
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

test('a user\'s own time zone: their today, their receipt times; the owner keeps OWNER_TZ; bad zones refused', async () => {
  const { app, store, signIn } = await setup();
  const lee = await signIn('lee@example.com');
  const owner = await signIn('owner@example.com');
  assert.equal((await lee.get('/api/status')).json().today, '2026-03-20', 'the server default before choosing');
  assert.equal((await lee.send('PUT', '/api/account/time-zone', { timeZone: 'Mars/Olympus' })).statusCode, 400);
  const set = (await lee.send('PUT', '/api/account/time-zone', { timeZone: 'America/Los_Angeles' })).json();
  assert.deepEqual(set.timeZone, { zone: 'America/Los_Angeles', own: true, fromServer: false });
  assert.equal((await lee.get('/api/status')).json().today, '2026-03-19');
  assert.equal((await owner.get('/api/status')).json().today, '2026-03-20');
  assert.equal((await owner.send('PUT', '/api/account/time-zone', { timeZone: 'America/Los_Angeles' })).statusCode, 409, 'the owner uses OWNER_TZ');

  // Their Health Auto Export posts are stamped in their zone.
  const token = (await lee.send('POST', '/api/account/ingest-token')).json().token;
  await app.inject({ method: 'POST', url: '/api/ingest/health', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: health });
  const stamp = store.db.prepare("SELECT MAX(exported_through) FROM daily_metrics WHERE user_id = 'lee'").pluck().get();
  assert.equal(stamp, '2026-03-19T22:00');
  assert.equal((await lee.send('PUT', '/api/account/time-zone', { timeZone: null })).json().timeZone.own, false);
  assert.equal((await lee.get('/api/status')).json().today, '2026-03-20');
});

test('one user\'s running review or sync never blocks or shows for another', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  const services = {
    review: async () => { await hold; },
    sync: async () => ({ counts: {}, warnings: [] }),
    aiAccess: () => ({ source: 'own', reason: null }),
    hasAi: () => true,
  };
  const { store, signIn } = await setup({ services });
  // A full week for both, so the review is not gated on missing days.
  for (const uid of ['lee', 'kim']) {
    for (let d = 8; d <= 14; d++) store.db.prepare("INSERT INTO daily_metrics (user_id, date, steps, exported_through, updated_at) VALUES (?, ?, 9000, '2026-03-20T00:30', 'x')").run(uid, `2026-03-${String(d).padStart(2, '0')}`);
  }
  const lee = await signIn('lee@example.com');
  const kim = await signIn('kim@example.com');
  assert.equal((await lee.send('POST', '/api/reviews/run', {})).statusCode, 202);
  assert.equal((await lee.get('/api/reviews/status')).json().running, true);
  assert.equal((await lee.send('POST', '/api/reviews/run', {})).statusCode, 409, 'one at a time for lee');
  assert.equal((await kim.get('/api/reviews/status')).json().running, false, "lee's run is not kim's");
  assert.equal((await kim.send('POST', '/api/reviews/run', {})).statusCode, 202, 'kim is not blocked');
  assert.equal((await kim.send('POST', '/api/sync')).statusCode, 200);
  release();
});
