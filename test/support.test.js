// The published support address (SUPPORT_EMAIL): filled in on the policies, guides, sign-in waiting pages, the US-only
// page, Help (via /api/status) and emails to users; never written in the repo; unset, pages name the administrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';

const SUPPORT = 'help-desk@example.com';
const SITE = 'http://localhost:5188';

test('with SUPPORT_EMAIL: policies, guides, status and the US-only page show it as a mailto link', async () => {
  const app = await buildApp({ store: openHealthStore(':memory:'), supportEmail: SUPPORT, trustProxy: true, geo: { allow: ['US'], lookup: () => 'GB' } });
  for (const url of ['/privacy', '/terms', '/guides']) {
    const body = (await app.inject({ url, headers: { 'x-forwarded-for': '10.0.0.1' } })).body;
    assert.match(body, new RegExp(`<a href="mailto:${SUPPORT}">${SUPPORT}</a>`), url);
    assert.ok(!body.includes('{{SUPPORT}}'), url);
  }
  assert.equal((await app.inject({ url: '/api/status', headers: { 'x-forwarded-for': '10.0.0.1' } })).json().supportEmail, SUPPORT);
  const blocked = await app.inject({ url: '/', headers: { 'x-forwarded-for': '81.2.69.142' } });
  assert.equal(blocked.statusCode, 403);
  assert.match(blocked.body, new RegExp(`mailto:${SUPPORT}`));
});

test('unset or not an address: no address anywhere, "the administrator" instead, no placeholder left', async () => {
  for (const supportEmail of [null, 'not-an-address', '"><script>@x.com']) {
    const app = await buildApp({ store: openHealthStore(':memory:'), supportEmail });
    const body = (await app.inject('/terms')).body;
    assert.match(body, /email the administrator/);
    assert.ok(!body.includes('{{SUPPORT}}') && !body.includes('mailto:') && !body.includes('<script>'));
    assert.equal((await app.inject('/api/status')).json().supportEmail, null);
  }
});

test('the waiting page and the "you\'re in" email carry it', async () => {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('kim', 'kim@example.com', 'user', 'pending', 'x')").run();
  const mail = [];
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', supportEmail: SUPPORT, mailer: { send: async (m) => { mail.push(m); return true; } }, log: { info() {}, warn() {}, error() {} },
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login');
    const url = new URL(login.headers.location);
    nonce = url.searchParams.get('nonce');
    const res = await app.inject({ url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: cookies(login) } });
    return cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
  };
  const kim = await signIn('kim@example.com');
  assert.match((await app.inject({ url: '/auth/waiting', headers: { cookie: kim } })).body, new RegExp(`mailto:${SUPPORT}`));
  const owner = await signIn('owner@example.com');
  await app.inject({ method: 'POST', url: '/api/admin/users/kim/approve', headers: { cookie: owner, origin: SITE } });
  assert.match(mail.at(-1).text, new RegExp(`Questions or problems: ${SUPPORT}`));
});
