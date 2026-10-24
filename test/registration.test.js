// Multi-user phase 2: requesting access, approval by the admin, emails, the Claude key in Settings, and no AI without
// one. Synthetic accounts, a fake Google exchange, a fake mailer and a fake key check; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings, CALLBACK_PATH } from '../server/auth.js';
import { boxKey, open } from '../tools/secret-box.js';
import { userByEmail } from '../db/users.js';

const SITE = 'http://localhost:5188';
// Made-up key shapes, built here so no key-shaped string sits in the code (the personal-data check looks for those).
const fakeKey = (tail) => ['sk', 'ant', 'api03', tail].join('-');
const KEY = fakeKey('made-up-test-value-0000000000');

async function setup({ services = {} } = {}) {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  const mail = [];
  const mailer = { configured: true, send: async (m) => { mail.push(m); return true; } };
  const keyBox = boxKey('test-user-key-secret-long-enough-32+');
  let email = 'owner@example.com';
  let nonce;
  const app = await buildApp({ store, authMode: 'google', mailer, keyBox, keyCheck: async (k) => k === KEY, services,
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce, given_name: email.split('@')[0] }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login');
    nonce = new URL(login.headers.location).searchParams.get('nonce');
    const state = new URL(login.headers.location).searchParams.get('state');
    const res = await app.inject({ url: `${CALLBACK_PATH}?state=${state}&code=c`, headers: { cookie: cookies(login) } });
    return cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
  };
  const as = (cookie) => ({ cookie, get: (url) => app.inject({ url, headers: { cookie } }),
    form: (url, payload) => app.inject({ method: 'POST', url, headers: { cookie, origin: SITE, 'content-type': 'application/x-www-form-urlencoded' }, payload }),
    send: (method, url, payload) => app.inject({ method, url, headers: { cookie, origin: SITE }, ...(payload ? { payload } : {}) }) });
  return { app, store, mail, keyBox, signIn, as };
}

test('registration: request access, wait, get approved by the admin with emails both ways; reject locks out', async () => {
  const { app, store, mail, signIn, as } = await setup();
  const kim = as(await signIn('kim@example.com'));
  assert.equal((await kim.get('/')).headers.location, '/auth/register', 'an unknown address is sent to request access');
  assert.equal((await kim.get('/api/status')).statusCode, 403);
  const page = await kim.get('/auth/register');
  assert.match(page.body, /Request access/);
  assert.match(page.body, /No AI is used/);
  // The form: refused without agreeing, then a pending user and one email to the admin.
  const post = (body) => kim.form('/auth/register', body);
  assert.equal((await post('')).headers.location, '/auth/register');
  assert.equal(userByEmail(store.db, 'kim@example.com'), null);
  assert.equal((await post('agree=on')).headers.location, '/auth/waiting');
  assert.equal(userByEmail(store.db, 'kim@example.com').status, 'pending');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'owner@example.com');
  assert.match(mail[0].text, /kim@example\.com/);
  assert.equal((await kim.get('/')).headers.location, '/auth/waiting');
  await post('agree=on');
  assert.equal(mail.length, 1, 'registering again sends nothing more');

  // Only the admin may list and approve.
  assert.equal((await kim.get('/api/admin/users')).statusCode, 403);
  const owner = as(await signIn('owner@example.com'));
  const users = (await owner.get('/api/admin/users')).json();
  assert.equal(users[0].email, 'kim@example.com', 'pending first');
  assert.ok(!JSON.stringify(users).includes('claude_key_enc'));
  const approved = await owner.send('POST', `/api/admin/users/${users[0].id}/approve`);
  assert.equal(approved.statusCode, 200);
  assert.equal(mail.at(-1).to, 'kim@example.com');
  assert.equal((await kim.get('/api/status')).statusCode, 200, 'approved: in');
  assert.ok((await kim.get('/api/prompt/sections')).json().length >= 3, 'default prompt sections');
  assert.equal((await kim.send('POST', `/api/admin/users/${users[0].id}/reject`)).statusCode, 403);

  await owner.send('POST', `/api/admin/users/${users[0].id}/reject`);
  assert.equal((await kim.get('/api/status')).statusCode, 403, 'rejected: locked out at once');
  assert.equal((await kim.get('/')).headers.location, '/auth/not-approved');
  assert.equal((await app.inject('/privacy')).statusCode, 200);
  assert.match((await app.inject('/terms')).body, /Not medical advice/);
  await app.close();
  store.close();
});

test('claude key: checked, sealed per user, never returned; no key means no AI; the owner key is the server\'s', async () => {
  const services = { claude: () => ({}), hasAi: (uid) => uid === '00000000-0000-4000-8000-000000000001' || Boolean(store.db.prepare('SELECT claude_key_enc FROM users WHERE id = ?').pluck().get(uid)), review: async () => ({}) };
  const { app, store, keyBox, signIn, as } = await setup({ services });
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('lee', 'lee@example.com', 'user', 'approved', 'x')").run();
  const lee = as(await signIn('lee@example.com'));
  assert.equal((await lee.get('/api/account')).json().claudeKey, null);
  assert.equal((await lee.get('/api/advisor/chat')).json().needsKey, true);
  assert.equal((await lee.get('/api/reviews/status')).json().needsKey, true);
  assert.equal((await lee.send('POST', '/api/reviews/run', {})).statusCode, 503);

  assert.equal((await lee.send('PUT', '/api/account/claude-key', { key: fakeKey('wrong-value-0000000000000') })).statusCode, 400);
  const saved = await lee.send('PUT', '/api/account/claude-key', { key: KEY });
  assert.equal(saved.statusCode, 200);
  assert.ok(!saved.body.includes(KEY), 'never echoed');
  assert.equal(saved.json().claudeKey.source, 'yours');
  const sealed = store.db.prepare("SELECT claude_key_enc FROM users WHERE id = 'lee'").pluck().get();
  assert.ok(sealed && !sealed.includes('made-up'));
  assert.equal(open(sealed, 'lee', keyBox), KEY);
  assert.equal((await lee.get('/api/advisor/chat')).json().needsKey, false);
  for (const url of ['/api/account', '/api/advisor/chat', '/api/reviews/status']) assert.ok(!(await lee.get(url)).body.includes(KEY));
  await lee.send('DELETE', '/api/account/claude-key');
  assert.equal(store.db.prepare("SELECT claude_key_enc FROM users WHERE id = 'lee'").pluck().get(), null);

  const owner = as(await signIn('owner@example.com'));
  assert.equal((await owner.get('/api/account')).json().claudeKey.source, 'server');
  assert.equal((await owner.send('PUT', '/api/account/claude-key', { key: KEY })).statusCode, 409);
  await app.close();
  store.close();
});
