// Sign-in (google), the public read-only demo, the open local mode, security headers and the health check.
// Synthetic accounts and a fake Google exchange; no network. Ported from Job-Agent's auth and demo tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openOwnerStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { assertSafeBinding, authSettings, CALLBACK_PATH, DEMO_REFUSAL, SESSION_DAYS } from '../server/auth.js';

const SITE = 'http://localhost:5188';
const settings = authSettings({
  AUTH_MODE: 'google',
  PUBLIC_URL: SITE,
  GOOGLE_WEB_CLIENT_ID: 'client.apps.example',
  GOOGLE_WEB_CLIENT_SECRET: 'secret',
  AUTH_ALLOWED_EMAILS: 'Pat@Example.com, sam@example.com',
  SESSION_SECRET: randomBytes(48).toString('base64'),
});

async function setup({ claims = {}, exchangeError = null, now } = {}) {
  const store = openOwnerStore(':memory:');
  const seen = [];
  let currentNonce = null;
  const exchange = async (req) => {
    seen.push(req);
    if (exchangeError) throw exchangeError;
    return { email: 'pat@example.com', email_verified: true, nonce: claims.nonce ?? currentNonce, ...claims };
  };
  const clock = { t: Date.now() };
  const app = await buildApp({ store, authMode: 'google', auth: { settings, exchange, now: now ?? (() => clock.t) } });
  const cookiesFrom = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const startLogin = async (next = '/') => {
    const res = await app.inject(`/auth/login?next=${encodeURIComponent(next)}`);
    const url = new URL(res.headers.location);
    currentNonce = url.searchParams.get('nonce');
    return { res, url, loginCookie: cookiesFrom(res), state: url.searchParams.get('state') };
  };
  const signIn = async (next = '/') => {
    const { loginCookie, state } = await startLogin(next);
    const res = await app.inject({ url: `${CALLBACK_PATH}?state=${state}&code=abc`, headers: { cookie: loginCookie } });
    return { res, session: cookiesFrom(res).split('; ').find((c) => c.startsWith('hr_session=')) };
  };
  const done = async () => { await app.close(); store.close(); };
  return { app, store, seen, clock, startLogin, signIn, done };
}

test('signed out: API routes return 401, pages redirect to sign-in; /api/health and ingest stay open', async () => {
  const { app, done } = await setup();
  assert.equal((await app.inject('/api/status')).statusCode, 401);
  const pageRes = await app.inject('/some/page?x=1');
  assert.equal(pageRes.statusCode, 302);
  assert.equal(pageRes.headers.location, '/auth/login?next=%2Fsome%2Fpage%3Fx%3D1');
  const health = await app.inject('/api/health');
  assert.equal(health.statusCode, 200);
  assert.deepEqual(Object.keys(health.json()).sort(), ['status', 'version']);
  assert.equal(health.json().status, 'ok');
  // Ingest carries its own token (step 3); the sign-in check never answers it with 401.
  assert.notEqual((await app.inject({ method: 'POST', url: '/api/ingest/workouts', payload: {} })).statusCode, 401);
  await done();
});

test('login sends you to Google with state, nonce, PKCE and openid email profile; the callback is /auth/google/callback', async () => {
  const { startLogin, done } = await setup();
  const { res, url } = await startLogin('/#training');
  assert.equal(res.statusCode, 302);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('redirect_uri'), `${SITE}/auth/google/callback`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  for (const p of ['state', 'nonce', 'code_challenge', 'client_id']) assert.ok(url.searchParams.get(p), p);
  assert.match(res.headers['set-cookie'], /^hr_login=.*HttpOnly; SameSite=Lax; Max-Age=600$/);
  await done();
});

test('an allowed, verified account gets a session and reaches the API; writes need this site; sign out ends it', async () => {
  const { app, signIn, seen, done } = await setup();
  const { res, session } = await signIn('/#labs');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/#labs');
  assert.ok(session);
  assert.equal(seen[0].redirectUri, `${SITE}/auth/google/callback`);
  assert.ok(seen[0].codeVerifier.length >= 43, 'the PKCE verifier is sent with the code');
  assert.deepEqual((await app.inject({ url: '/api/me', headers: { cookie: session } })).json(), { authMode: 'google', email: 'pat@example.com', name: null });
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: session } })).statusCode, 200);

  const write = (origin) => app.inject({ method: 'PUT', url: '/api/checkins/2026-03-02', headers: { cookie: session, ...(origin ? { origin } : {}) }, payload: { readiness: 7 } });
  assert.equal((await write('https://evil.example')).statusCode, 403);
  assert.equal((await write(null)).statusCode, 403);
  assert.ok([200, 400].includes((await write(SITE)).statusCode), 'allowed through to the route');

  const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: session, origin: SITE } });
  assert.equal(out.statusCode, 204);
  assert.match(out.headers['set-cookie'], /^hr_session=; .*Max-Age=0/);
  await done();
});

test('refused: unverified email, wrong state or nonce, no login cookie, Google errors', async () => {
  for (const [claims, status, text] of [
    [{ email_verified: false }, 403, /not verified/],
    [{ nonce: 'other' }, 400, /did not match/],
  ]) {
    const { signIn, done } = await setup({ claims });
    const { res, session } = await signIn();
    assert.equal(res.statusCode, status, JSON.stringify(claims));
    assert.match(res.body, text);
    assert.equal(session, undefined, 'no session is set');
    await done();
  }
  const { app, startLogin, done } = await setup();
  const { loginCookie, state } = await startLogin();
  assert.equal((await app.inject({ url: `${CALLBACK_PATH}?state=wrong&code=abc`, headers: { cookie: loginCookie } })).statusCode, 400);
  assert.equal((await app.inject({ url: `${CALLBACK_PATH}?state=${state}&code=abc` })).statusCode, 400, 'no login cookie');
  assert.match((await app.inject({ url: `${CALLBACK_PATH}?error=access_denied`, headers: { cookie: loginCookie } })).body, /access_denied/);
  await done();
  const failing = await setup({ exchangeError: new Error('bad code') });
  assert.equal((await failing.signIn()).res.statusCode, 502);
  await failing.done();
});

test('a session expires after its days; rejecting a user locks them out at once; a forged or tampered cookie is refused', async () => {
  const { app, signIn, clock, done } = await setup();
  const { session } = await signIn();
  const status = () => app.inject({ url: '/api/status', headers: { cookie: session } }).then((r) => r.statusCode);
  assert.equal(await status(), 200);
  clock.t += (SESSION_DAYS * 86_400 + 60) * 1000;
  assert.equal(await status(), 401, 'expired');
  clock.t -= (SESSION_DAYS * 86_400 + 60) * 1000;

  // A second, approved user is locked out the moment the admin rejects them (the users row is read on every request).
  const sam = await setup({ claims: { email: 'sam@example.com' } });
  sam.store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('sam', 'sam@example.com', 'user', 'approved', 'x')").run();
  const samSession = (await sam.signIn()).session;
  const samStatus = () => sam.app.inject({ url: '/api/status', headers: { cookie: samSession } }).then((r) => r.statusCode);
  assert.equal(await samStatus(), 200);
  sam.store.db.prepare("UPDATE users SET status = 'rejected' WHERE id = 'sam'").run();
  assert.equal(await samStatus(), 403, 'rejected');
  await sam.done();

  const forged = `hr_session=${Buffer.from(JSON.stringify({ email: 'pat@example.com', exp: Date.now() + 1e9 })).toString('base64url')}.AAAA`;
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: forged } })).statusCode, 401);
  const [data, sig] = session.slice('hr_session='.length).split('.');
  const tampered = `hr_session=${Buffer.from(JSON.stringify({ email: 'sam@example.com', exp: Date.now() + 1e9 })).toString('base64url')}.${sig}`;
  assert.ok(data);
  assert.equal((await app.inject({ url: '/api/status', headers: { cookie: tampered } })).statusCode, 401);
  await done();
});

test('a return path can only be on this site', async () => {
  const { signIn, done } = await setup();
  for (const next of ['//evil.example', 'https://evil.example', '/auth/logout']) {
    assert.equal((await signIn(next)).res.headers.location, '/', next);
  }
  await done();
});

test('binding rules: none stays on localhost; google needs complete settings and https off localhost; demo needs https off localhost', () => {
  assert.doesNotThrow(() => assertSafeBinding({ host: '127.0.0.1' }));
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0' }), /only allows localhost/);
  assert.throws(() => assertSafeBinding({ host: '127.0.0.1', mode: 'magic' }), /not supported/);
  assert.throws(() => assertSafeBinding({ host: '127.0.0.1', mode: 'google', settings: { ...settings, clientId: '' } }), /GOOGLE_WEB_CLIENT_ID/);
  assert.throws(() => assertSafeBinding({ host: '127.0.0.1', mode: 'google', settings: { ...settings, secret: 'short' } }), /32 bytes/);
  assert.doesNotThrow(() => assertSafeBinding({ host: '127.0.0.1', mode: 'google', settings }));
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0', mode: 'google', settings }), /must use https/);
  assert.doesNotThrow(() => assertSafeBinding({ host: '0.0.0.0', mode: 'google', settings: { ...settings, publicUrl: 'https://health.example.com' } }));
  assert.doesNotThrow(() => assertSafeBinding({ host: '127.0.0.1', mode: 'demo' }));
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0', mode: 'demo', settings: {} }), /needs PUBLIC_URL/);
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0', mode: 'demo', settings: { publicUrl: 'http://demo.example.com' } }), /must use https/);
});

test('demo mode refuses every route that would change data, generated from the route table; reads work without sign-in', async () => {
  const store = openOwnerStore(':memory:');
  const app = await buildApp({ store, authMode: 'demo', instance: 'demo', features: { chat: false } });
  await app.ready();
  const fill = (url) => url.replace(/:date/g, '2026-03-02').replace(/:metric/g, 'steps').replace(/:[a-z]+/gi, '1');
  const writes = app.routeList.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
  assert.ok(writes.length >= 25, `found ${writes.length} write routes`);
  for (const r of writes) {
    const res = await app.inject({ method: r.method, url: fill(r.url), payload: {} });
    assert.equal(res.statusCode, 403, `${r.method} ${r.url}`);
    assert.equal(res.json().error, DEMO_REFUSAL);
  }
  const status = await app.inject('/api/status');
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().readOnly, true);
  assert.deepEqual((await app.inject('/api/me')).json(), { authMode: 'demo', email: null, name: null, demo: true });
  await app.close();
  store.close();
});

test('open local mode: no login, only localhost; security headers on every response', async () => {
  const store = openOwnerStore(':memory:');
  const app = await buildApp({ store });
  assert.deepEqual((await app.inject('/api/me')).json(), { authMode: 'none', email: null, name: null });
  const res = await app.inject('/api/status');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().readOnly, false);
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['strict-transport-security'], undefined, 'no HSTS without https');
  assert.equal((await app.inject({ url: '/api/status', headers: { host: 'evil.example' } })).statusCode, 403);
  await app.close();
  store.close();
});

test('the first name from Google rides in the signed session and /api/me; the icon and manifest open without a session', async () => {
  const { app, signIn, done } = await setup({ claims: { given_name: 'Pat', name: 'Pat Example' } });
  const { session } = await signIn();
  assert.deepEqual((await app.inject({ url: '/api/me', headers: { cookie: session } })).json(), { authMode: 'google', email: 'pat@example.com', name: 'Pat' });
  const fallback = await setup({ claims: { name: '  Pat Example  ' } });
  const second = await fallback.signIn();
  assert.equal((await fallback.app.inject({ url: '/api/me', headers: { cookie: second.session } })).json().name, 'Pat Example');
  await fallback.done();
  for (const url of ['/manifest.webmanifest', '/icon-180.png']) {
    assert.notEqual((await app.inject(url)).statusCode, 302, `${url} is not sent to sign-in`);
  }
  assert.equal((await app.inject('/index.html')).statusCode, 302, 'pages still need a session');
  await done();
});
