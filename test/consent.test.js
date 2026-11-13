// The separate health data consent (PostHog guide section 7, 2026-11-03): the one-time step for users approved before it,
// the sign-in page and the Consumer Health Data Privacy Policy page. Synthetic accounts and data, a fake Google exchange
// and a fake mailer; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { HEALTH_CONSENT_VERSION, OWNER_ID, getUser, newIngestToken } from '../db/users.js';
import { activeUserIds } from '../server/admin-queries.js';
import { aiAccess } from '../server/ai-access.js';
import { openTestStore } from './helpers.js';

const SITE = 'http://localhost:5188';
const NOW = new Date('2026-11-03T16:00:00Z');
const health = JSON.parse(readFileSync(new URL('./fixtures/ingest/health.json', import.meta.url), 'utf8'));

async function setup() {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = await openTestStore();
  // Lee was approved before the consent existed; Kim already gave it; the owner is never asked.
  await store.db.prepare(`INSERT INTO users (id, email, name, role, status, created_at, health_consent_at) VALUES
    ('lee', 'lee@example.com', 'Lee', 'user', 'approved', 'x', NULL),
    ('kim', 'kim@example.com', 'Kim', 'user', 'approved', 'x', 'x')`).run();
  const mail = [];
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', services: { sync: async () => ({ counts: {}, warnings: [] }) }, clock: () => NOW,
    mailer: { send: async (m) => { mail.push(m); return true; } }, supportEmail: 'help@example.com',
    ingest: { token: 'owner-ingest-token-made-up-0123456789', apple: 'rest' }, log: { info() {}, warn() {}, error() {} },
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login?go=1');
    const url = new URL(login.headers.location);
    nonce = url.searchParams.get('nonce');
    const res = await app.inject({ url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: cookies(login) } });
    const cookie = cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
    return {
      get: (u) => app.inject({ url: u, headers: { cookie } }),
      send: (method, u, payload) => app.inject({ method, url: u, headers: { cookie, origin: SITE }, ...(payload ? { payload } : {}) }),
      form: (u, payload) => app.inject({ method: 'POST', url: u, headers: { cookie, origin: SITE, 'content-type': 'application/x-www-form-urlencoded' }, payload }),
    };
  };
  return { app, store, mail, signIn };
}

test('before the consent: only the consent step and the export; no posts, AI or scheduled jobs; agreeing lets them in', async () => {
  const { app, store, signIn } = await setup();
  const token = (await newIngestToken(store.db, 'lee'));
  const post = () => app.inject({ method: 'POST', url: '/api/ingest/health', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: health });
  const lee = await signIn('lee@example.com');
  assert.equal((await lee.get('/')).headers.location, '/auth/consent');
  const api = await lee.get('/api/status');
  assert.equal(api.statusCode, 403);
  assert.equal(api.json().consentRequired, true);
  assert.equal((await lee.send('PUT', '/api/checkins/2026-11-02', { readiness: 7 })).statusCode, 403, 'no new data');
  assert.equal((await post()).statusCode, 401, 'their Health Auto Export token is refused');
  assert.equal(aiAccess((await getUser(store.db, 'lee'))).reason, 'consent');
  assert.ok(!(await activeUserIds(store.db)).includes('lee'));
  // They can save their data first: the export carries the consent fields (still empty).
  const exported = await lee.get('/api/account/export');
  assert.equal(exported.statusCode, 200);
  assert.ok('health_consent_at' in exported.json().account && 'health_consent_version' in exported.json().account);

  // The page: the consent text word for word, unticked, with the policy link, and the way to delete instead.
  const page = await lee.get('/auth/consent');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /I consent to Health Review collecting and using the health information I provide/);
  assert.match(page.body, /emailing <a href="mailto:help@example\.com">help@example\.com<\/a>/);
  assert.match(page.body, /<input type="checkbox" name="healthConsent" required>/);
  assert.match(page.body, /Delete my account/);
  assert.doesNotMatch(page.body, /—|–|--/, 'no dashes');
  // Agreeing needs the box ticked, and only from this site.
  assert.equal((await app.inject({ method: 'POST', url: '/auth/consent', payload: 'action=agree&healthConsent=on', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode, 403);
  assert.match((await lee.form('/auth/consent', 'action=agree')).body, /Tick the box/);
  assert.equal((await getUser(store.db, 'lee')).health_consent_at, null);
  assert.equal((await lee.form('/auth/consent', 'action=agree&healthConsent=on')).headers.location, '/');
  const u = (await getUser(store.db, 'lee'));
  assert.equal(u.health_consent_at, NOW.toISOString());
  assert.equal(u.health_consent_version, HEALTH_CONSENT_VERSION);
  assert.equal((await lee.get('/api/status')).statusCode, 200);
  assert.equal((await lee.get('/auth/consent')).headers.location, '/', 'asked once');
  assert.equal((await post()).statusCode, 200);
  assert.ok((await activeUserIds(store.db)).includes('lee'));
  assert.equal(aiAccess((await getUser(store.db, 'lee'))).reason, 'no_key');
  assert.equal((await lee.get('/api/account/export')).json().account.health_consent_version, HEALTH_CONSENT_VERSION);
});

test('the owner and users who already agreed are never asked; delete from the consent step needs the typed email', async () => {
  const { store, mail, signIn } = await setup();
  const owner = await signIn('owner@example.com');
  assert.equal((await getUser(store.db, OWNER_ID)).health_consent_at, null);
  assert.equal((await owner.get('/api/status')).statusCode, 200);
  assert.equal((await owner.get('/auth/consent')).headers.location, '/');
  const kim = await signIn('kim@example.com');
  assert.equal((await kim.get('/api/status')).statusCode, 200);

  const lee = await signIn('lee@example.com');
  assert.match((await lee.form('/auth/consent', 'action=delete&confirmEmail=wrong%40example.com')).body, /Type your email exactly/);
  assert.ok((await getUser(store.db, 'lee')));
  const gone = await lee.form('/auth/consent', 'action=delete&confirmEmail=LEE%40example.com');
  assert.equal(gone.statusCode, 200);
  assert.match(gone.body, /Your account was deleted/);
  assert.match(String(gone.headers['set-cookie']), /hr_session=;/);
  assert.equal((await getUser(store.db, 'lee')), null);
  assert.ok(mail.some((m) => /deleted their Health Review account/.test(m.text)));
});

test('the sign-in page links each policy; Continue with Google goes to Google; the policy page is open', async () => {
  const { app } = await setup();
  const page = await app.inject('/auth/login?next=%2F%23training');
  assert.equal(page.statusCode, 200);
  for (const link of ['href="/privacy"', 'href="/consumer-health-data"', 'href="/terms"']) assert.ok(page.body.includes(link), link);
  assert.ok(page.body.includes('href="/auth/login?go=1&amp;next=%2F%23training"'));
  assert.match(page.body, /Anyone can request access, and the owner approves each request by hand/);
  assert.match((await app.inject('/auth/login?go=1')).headers.location, /^https:\/\/accounts\.google\.com\//);
  // Unsigned visitors to the app land on the sign-in page.
  assert.match((await app.inject('/')).headers.location, /^\/auth\/login/);

  const policy = await app.inject('/consumer-health-data');
  assert.equal(policy.statusCode, 200);
  assert.match(policy.body, /<h1>Consumer Health Data Privacy Policy<\/h1>/);
  assert.match(policy.body, /Effective date: November 3, 2026/);
  assert.match(policy.body, /mailto:help@example\.com/);
  assert.doesNotMatch(policy.body, /\{\{|\[\[/, 'every placeholder filled');
  for (const file of ['CONSUMER-HEALTH-DATA.md', 'PRIVACY.md', 'TERMS.md']) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /—|–|--|\[\[/, `${file}: no dashes or open brackets`);
  }
});

test('the demo never asks for consent and serves the policies', async () => {
  const store = await openTestStore();
  const app = await buildApp({ store, authMode: 'demo', instance: 'demo', features: { chat: false } });
  assert.equal((await app.inject('/auth/consent')).statusCode, 404);
  assert.equal((await app.inject('/consumer-health-data')).statusCode, 200);
  assert.equal((await app.inject('/privacy')).statusCode, 200);
  await app.close();
  await store.close();
});
