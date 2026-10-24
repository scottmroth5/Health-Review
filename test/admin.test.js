// Multi-user phase 4: the admin's Users screen. Who pays for a user's AI (server/ai-access.js), the owner's key with a
// monthly cap and its emails, sharing the MAPS catalog, pause and resume, and what the admin never sees. Synthetic
// accounts, a fake Google exchange and a fake mailer; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { OWNER_ID, getUser } from '../db/users.js';
import { activeUserIds } from '../server/admin-queries.js';
import { aiAccess, createAiAccess, monthStartIso, spentThisMonth } from '../server/ai-access.js';
import { loadDemoCatalog } from '../demo/generate.js';

const SITE = 'http://localhost:5188';
const NOW = new Date('2026-10-24T16:00:00Z');
const health = JSON.parse(readFileSync(new URL('./fixtures/ingest/health.json', import.meta.url), 'utf8'));

async function setup() {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare(`INSERT INTO users (id, email, name, role, status, created_at) VALUES
    ('lee', 'lee@example.com', 'Lee', 'user', 'approved', '2026-10-01T00:00:00Z'),
    ('kim', 'kim@example.com', 'Kim', 'user', 'pending', '2026-10-02T00:00:00Z')`).run();
  const mail = [];
  const mailer = { configured: true, send: async (m) => { mail.push(m); return true; } };
  const ai = createAiAccess({ db: store.db, mailer, adminEmail: () => 'owner@example.com', appUrl: () => SITE, clock: () => NOW, log: { info() {} } });
  const services = { aiAccess: (uid) => ai.check(uid), hasAi: (uid) => ai.check(uid).source !== null, claude: () => ({}), sync: async () => ({ counts: {}, warnings: [] }) };
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', mailer, services, clock: () => NOW, catalog: loadDemoCatalog(),
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
  const spend = (uid, cost, startedAt = NOW.toISOString()) => store.db.prepare("INSERT INTO runs (name, status, started_at, cost_usd, user_id) VALUES ('advisor-chat', 'ok', ?, ?, ?)").run(startedAt, cost, uid);
  return { app, store, mail, signIn, spend };
}

test('aiAccess: the owner, a user\'s own key first, the owner\'s key under its cap, and none', () => {
  const user = (over) => ({ id: 'u', status: 'approved', claude_key_enc: null, uses_owner_key: 0, owner_key_cap_usd: null, ...over });
  assert.deepEqual(aiAccess({ id: OWNER_ID, status: 'approved' }), { source: 'owner', reason: null, capReached: false });
  assert.equal(aiAccess(user({ claude_key_enc: 'sealed' })).source, 'own');
  assert.equal(aiAccess(user({ claude_key_enc: 'sealed', uses_owner_key: 1, owner_key_cap_usd: 5 }), { spent: 9 }).source, 'own', 'their own key always first');
  assert.equal(aiAccess(user({ uses_owner_key: 1, owner_key_cap_usd: 5 }), { spent: 4.99 }).source, 'owner-for-user');
  assert.deepEqual(aiAccess(user({ uses_owner_key: 1, owner_key_cap_usd: 5 }), { spent: 5 }), { source: null, reason: 'cap', capReached: true });
  assert.equal(aiAccess(user({ uses_owner_key: 1, owner_key_cap_usd: null })).reason, 'no_key', 'no cap, no allowance');
  assert.equal(aiAccess(user({})).reason, 'no_key');
  assert.equal(aiAccess(user({ status: 'paused', claude_key_enc: 'sealed' })).reason, 'paused');
  assert.equal(aiAccess(null).source, null);
});

test('spend counts this month in the owner\'s time zone', () => {
  assert.equal(monthStartIso(NOW), '2026-10-01T04:00:00.000Z');
  assert.equal(monthStartIso(new Date('2026-11-01T02:00:00Z')), '2026-10-01T04:00:00.000Z', 'still October in New York');
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x')").run();
  const add = (at, cost, uid = 'lee') => store.db.prepare("INSERT INTO runs (name, status, started_at, cost_usd, user_id) VALUES ('review', 'ok', ?, ?, ?)").run(at, cost, uid);
  add('2026-10-01T03:59:00Z', 7); // September 30 in New York
  add('2026-10-01T04:00:00Z', 1.25);
  add('2026-10-20T12:00:00Z', 0.5);
  add('2026-10-20T12:00:00Z', 9, OWNER_ID);
  assert.equal(spentThisMonth(store.db, 'lee', NOW), 1.75);
});

test('the owner\'s key: confirmed with the user\'s email and a cap; at the cap AI stops and both get one email a month', async () => {
  const { app, store, mail, signIn, spend } = await setup();
  const owner = await signIn('owner@example.com');
  const lee = await signIn('lee@example.com');
  assert.equal((await lee.get('/api/account')).json().aiReason, 'no_key');

  const turnOn = (id, body) => owner.send('POST', `/api/admin/users/${id}/owner-key`, body);
  assert.equal((await turnOn('lee', { on: true, cap: 10, confirmEmail: 'someone@example.com' })).statusCode, 400, 'wrong email');
  assert.equal((await turnOn('lee', { on: true, confirmEmail: 'lee@example.com' })).statusCode, 400, 'no cap');
  assert.equal((await turnOn('lee', { on: true, cap: 500, confirmEmail: 'lee@example.com' })).statusCode, 400, 'cap over the limit');
  assert.equal((await turnOn('lee', { on: true, cap: 0, confirmEmail: 'lee@example.com' })).statusCode, 400, 'cap under the limit');
  assert.equal((await turnOn('kim', { on: true, cap: 10, confirmEmail: 'kim@example.com' })).statusCode, 409, 'not for a pending user');
  assert.equal((await turnOn(OWNER_ID, { on: true, cap: 10, confirmEmail: 'owner@example.com' })).statusCode, 409, 'not for the admin');
  assert.equal(getUser(store.db, 'lee').uses_owner_key, 0);

  const on = await turnOn('lee', { on: true, cap: 10, confirmEmail: ' LEE@example.com ' });
  assert.equal(on.statusCode, 200);
  assert.equal(on.json().uses_owner_key, true);
  assert.equal(on.json().owner_key_cap_usd, 10);
  assert.equal(mail.at(-1).to, 'lee@example.com');
  assert.match(mail.at(-1).text, /\$10\.00 a month/);
  let acct = (await lee.get('/api/account')).json();
  assert.equal(acct.ai, true);
  assert.deepEqual(acct.ownerKey, { cap: 10, spent: 0 });
  assert.equal((await lee.get('/api/advisor/chat')).json().aiReason, null);

  spend('lee', 6);
  spend('lee', 3.5, '2026-09-20T12:00:00Z'); // last month: not counted
  assert.equal((await lee.get('/api/account')).json().ai, true, 'under the cap');
  spend('lee', 4.25);
  const sent = mail.length;
  acct = (await lee.get('/api/account')).json();
  assert.equal(acct.ai, false);
  assert.equal(acct.aiReason, 'cap');
  assert.equal(acct.ownerKey.spent, 10.25);
  assert.equal(mail.length, sent + 2, 'the user and the admin are emailed');
  assert.deepEqual(mail.slice(-2).map((m) => m.to).sort(), ['lee@example.com', 'owner@example.com']);
  const chat = await lee.send('POST', '/api/advisor/chat', { text: 'what next?' });
  assert.equal(chat.statusCode, 503);
  assert.equal(chat.json().aiReason, 'cap');
  assert.equal((await lee.get('/api/reviews/status')).json().aiReason, null, 'no review service in this test');
  await lee.get('/api/account');
  assert.equal(mail.length, sent + 2, 'once a month');
  const listed = (await owner.get('/api/admin/users')).json().find((u) => u.id === 'lee');
  assert.equal(listed.spent_month, 10.25);

  // Raising the cap turns AI back on; turning the key off ends it and says so.
  await turnOn('lee', { on: true, cap: 20, confirmEmail: 'lee@example.com' });
  assert.equal((await lee.get('/api/account')).json().ai, true);
  const off = await turnOn('lee', { on: false });
  assert.equal(off.json().uses_owner_key, false);
  assert.equal(off.json().owner_key_cap_usd, null);
  assert.match(mail.at(-1).subject, /ended/);
  assert.equal((await lee.get('/api/account')).json().aiReason, 'no_key');
});

test('sharing the MAPS catalog gives a user the Advisor; stopping takes it away', async () => {
  const { signIn } = await setup();
  const owner = await signIn('owner@example.com');
  const lee = await signIn('lee@example.com');
  assert.equal((await lee.get('/api/advisor')).json().available, false);
  const shared = await owner.send('POST', '/api/admin/users/lee/maps', { shared: true });
  assert.equal(shared.json().maps_shared, true);
  assert.equal((await lee.get('/api/advisor')).json().available, true);
  await owner.send('POST', '/api/admin/users/lee/maps', { shared: false });
  assert.equal((await lee.get('/api/advisor')).json().available, false);
  assert.equal((await owner.send('POST', `/api/admin/users/${OWNER_ID}/maps`, { shared: false })).statusCode, 409);
  assert.equal((await owner.send('POST', '/api/admin/users/kim/maps', { shared: true })).statusCode, 409, 'not for a pending user');
});

test('pause: still signs in and sees their data; posts, syncs, AI and scheduled jobs stop; resume brings them back', async () => {
  const { app, store, signIn } = await setup();
  const owner = await signIn('owner@example.com');
  const lee = await signIn('lee@example.com');
  const token = (await lee.send('POST', '/api/account/ingest-token')).json().token;
  const post = () => app.inject({ method: 'POST', url: '/api/ingest/health', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: health });
  assert.equal((await post()).statusCode, 200);

  assert.equal((await owner.send('POST', '/api/admin/users/lee/resume')).statusCode, 409, 'only a paused user resumes');
  const paused = await owner.send('POST', '/api/admin/users/lee/pause');
  assert.equal(paused.json().status, 'paused');
  assert.equal((await owner.send('POST', '/api/admin/users/lee/pause')).statusCode, 409);
  assert.equal((await owner.send('POST', `/api/admin/users/${OWNER_ID}/pause`)).statusCode, 409, 'never the admin');
  assert.equal((await lee.get('/api/status')).statusCode, 200, 'still signs in');
  assert.ok((await lee.get('/api/history?from=2020-01-01&to=2030-12-31')).statusCode === 200);
  assert.equal((await lee.get('/api/account')).json().status, 'paused');
  assert.equal((await lee.get('/api/account')).json().aiReason, 'paused');
  assert.equal((await post()).statusCode, 401, 'posts refused');
  assert.equal((await lee.send('POST', '/api/sync')).statusCode, 403);
  assert.ok(!activeUserIds(store.db).includes('lee'), 'no scheduled sync or review');

  assert.equal((await owner.send('POST', '/api/admin/users/lee/resume')).json().status, 'approved');
  assert.equal((await post()).statusCode, 200);
  assert.equal((await lee.send('POST', '/api/sync')).statusCode, 200);
  assert.ok(activeUserIds(store.db).includes('lee'));
});

test('the Users screen: feeds and counts as yes or no, never a key, token or sheet ID; admin routes are admins only', async () => {
  const { app, store, signIn } = await setup();
  const owner = await signIn('owner@example.com');
  const lee = await signIn('lee@example.com');
  await lee.send('PUT', '/api/account/feeds', { appleHealth: true, workoutLog: true, manual: true });
  const token = (await lee.send('POST', '/api/account/ingest-token')).json().token;
  await app.inject({ method: 'POST', url: '/api/ingest/health', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: health });
  const SHEET = 'made-up-sheet-id-0123456789abcdef';
  store.db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES ('lee', 'workout_log_sheet_id', ?, 'x')").run(SHEET);
  store.db.prepare("UPDATE users SET claude_key_enc = 'sealed-made-up-key', google_refresh_enc = 'sealed-made-up-refresh' WHERE id = 'lee'").run();

  const users = (await owner.get('/api/admin/users')).json();
  assert.equal(users[0].id, 'kim', 'pending first');
  const row = users.find((u) => u.id === 'lee');
  assert.equal(row.has_key, true);
  assert.equal(row.has_token, true);
  assert.equal(row.google_connected, true);
  assert.equal(row.sheet_set, true);
  assert.deepEqual(row.feeds, { appleHealth: true, workoutLog: true, manual: true });
  assert.ok(row.last_post);
  assert.ok(row.health_days > 0);
  assert.equal(row.reviews, 0);
  const text = JSON.stringify(users);
  for (const secret of [token, SHEET, 'sealed-made-up-key', 'sealed-made-up-refresh', getUser(store.db, 'lee').ingest_token_hash]) {
    assert.ok(!text.includes(secret), 'never on the admin screen');
  }
  assert.ok(!/claude_key_enc|ingest_token_hash|google_refresh_enc/.test(text));

  const routes = app.routeList.filter((r) => r.url.startsWith('/api/admin/'));
  assert.ok(routes.length >= 7);
  for (const r of routes) {
    const res = await lee.send(r.method, r.url.replace(':id', 'kim'), r.method === 'GET' ? undefined : {});
    assert.equal(res.statusCode, 403, `${r.method} ${r.url} is admins only`);
  }
});
