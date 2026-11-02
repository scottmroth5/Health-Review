// Usage totals (server/usage-totals.js, migration 032): device, location and source classification, once-a-day visits,
// what never counts, and what the table never holds. Made-up names, addresses from the documentation ranges, a fake
// location database, a fake Google exchange; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { SOURCES, browserOf, deviceOf, locationOf, sourceOf, hostnameOrNull } from '../server/usage-totals.js';
import { MIGRATIONS } from '../db/migrations.js';
import { USER_TABLES } from '../db/migrations-users.js';
import { usageTotals } from '../server/admin-queries.js';

const SITE = 'http://localhost:5188';
const PUBLIC = fileURLToPath(new URL('../server/public', import.meta.url));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const fakePlace = (ip) => {
  if (ip === '203.0.113.9') throw new Error('lookup failed');
  if (ip === '198.51.100.7') return { city: null, state: null, country: null };
  return { city: 'Springfield', state: 'Ohio', country: 'United States' };
};

test('deviceOf: phone, tablet or computer', () => {
  assert.equal(deviceOf(IPHONE), 'phone');
  assert.equal(deviceOf(ANDROID_PHONE), 'phone');
  assert.equal(deviceOf(DESKTOP, '?1'), 'phone', 'the mobile client hint');
  assert.equal(deviceOf(IPAD), 'tablet');
  assert.equal(deviceOf(ANDROID_TABLET), 'tablet');
  assert.equal(deviceOf(DESKTOP, '?0'), 'computer');
  assert.equal(deviceOf(undefined), 'computer');
});

test('browserOf: the browser and its main version only, most specific first', () => {
  const cases = [
    [DESKTOP, 'Chrome 130'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68', 'Edge 130'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 EdgA/130.0.2849.65', 'Edge 130'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/130.2849.80 Version/18.0 Mobile/15E148 Safari/604.1', 'Edge 130'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox 132'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15', 'Firefox 132'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'Safari 18'],
    [IPHONE, 'Safari 18'],
    [IPAD, 'Safari 18'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1', 'Chrome 130'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36', 'Samsung Internet 27'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0', 'Opera 114'],
    [ANDROID_PHONE, 'Chrome 130'],
    ['', 'Other'],
    [undefined, 'Other'],
    ['curl/8.4.0', 'Other'],
    ['Mozilla/5.0 Chrome/1300000.0 Safari/537.36', 'Chrome'],
    ['Mozilla/5.0 Chrome/0130.0', 'Chrome 130'],
  ];
  for (const [ua, want] of cases) assert.equal(browserOf(ua), want, String(ua));
  for (const [ua] of cases) assert.match(browserOf(ua), /^(Edge|Opera|Samsung Internet|Firefox|Chrome|Safari)( \d{1,4})?$|^Other$/);
});

test('migration 033: the usage totals keep their rows and accept browser', () => {
  // The table as migration 032 made it, with a row, then 033 on top.
  const store = openHealthStore(':memory:');
  const db = store.db;
  db.exec(`DROP TABLE usage_totals;
    CREATE TABLE usage_totals (day TEXT NOT NULL, dimension TEXT NOT NULL CHECK (dimension IN ('device', 'location', 'source')),
      value TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, dimension, value));`);
  db.prepare("INSERT INTO usage_totals (day, dimension, value, count) VALUES ('2026-11-02', 'device', 'phone', 3)").run();
  assert.throws(() => db.prepare("INSERT INTO usage_totals (day, dimension, value, count) VALUES ('2026-11-02', 'browser', 'Chrome 130', 1)").run());
  db.exec(MIGRATIONS.find((m) => m.id === '033-usage-totals-browser').up);
  assert.deepEqual(db.prepare('SELECT day, dimension, value, count FROM usage_totals').all(), [{ day: '2026-11-02', dimension: 'device', value: 'phone', count: 3 }]);
  db.prepare("INSERT INTO usage_totals (day, dimension, value, count) VALUES ('2026-11-02', 'browser', 'Chrome 130', 1)").run();
  assert.throws(() => db.prepare("INSERT INTO usage_totals (day, dimension, value, count) VALUES ('2026-11-02', 'email', 'x', 1)").run());
  store.close();
});

test('locationOf: City, State, Country from the local database; a failed or private lookup is unknown', () => {
  assert.equal(locationOf(fakePlace, '192.0.2.10'), 'Springfield, Ohio, United States');
  assert.equal(locationOf(() => ({ city: 'St. Louis, City', state: null, country: 'United States' }), '192.0.2.10'), 'St. Louis City, Unknown, United States');
  assert.equal(locationOf(fakePlace, '203.0.113.9'), 'unknown', 'the lookup throws');
  assert.equal(locationOf(fakePlace, '198.51.100.7'), 'unknown', 'no country');
  assert.equal(locationOf(fakePlace, '127.0.0.1'), 'unknown', 'loopback');
  assert.equal(locationOf(fakePlace, '10.0.0.4'), 'unknown', 'private');
  assert.equal(locationOf(null, '192.0.2.10'), 'unknown', 'no database');
  assert.equal(locationOf(fakePlace, 'not an address'), 'unknown');
});

test('sourceOf: each value, utm_source first, whole hostnames only', () => {
  const hosts = { siteHost: 'example.test', demoHost: 'demo.example.test' };
  const of = (referer, query = '') => sourceOf({ query, referer, ...hosts });
  assert.equal(of('', 'utm_source=linkedin'), 'linkedin');
  assert.equal(of('', 'utm_source=GitHub'), 'github');
  assert.equal(of('', 'utm_source=site'), 'site');
  assert.equal(of('https://www.linkedin.com/', 'utm_source=demo'), 'demo', 'the tag beats the referrer');
  for (const utm of ['linkedin.evil', 'https://x', 'google_signin_return', 'other', '']) assert.equal(of('', `utm_source=${encodeURIComponent(utm)}`), 'direct', `spoofed ${utm}`);
  assert.equal(of('https://www.linkedin.com/feed/'), 'linkedin');
  assert.equal(of('https://lnkd.in/x'), 'linkedin');
  assert.equal(of('https://github.com/someone'), 'github');
  assert.equal(of('https://www.example.test/about'), 'site');
  assert.equal(of('https://demo.example.test/#home'), 'demo');
  assert.equal(of('https://accounts.google.com/'), 'google_signin_return');
  assert.equal(of('https://news.example.org/'), 'other');
  assert.equal(of(''), 'direct');
  for (const lookalike of ['https://linkedin.com.example.com/', 'https://evil-linkedin.com/', 'https://gist.github.com/', 'https://accounts.google.com.evil.test/', 'https://example.test.evil.test/']) {
    assert.equal(of(lookalike), 'other', lookalike);
  }
  // The demo's host is a subdomain of the site's: exactly that host is demo, any other subdomain is the site.
  assert.equal(of('https://x.demo.example.test/'), 'site');
  assert.equal(of('not a url'), 'other');
  assert.equal(sourceOf({ referer: 'https://example.test/' }), 'other', 'site unset');
  assert.equal(sourceOf({ referer: 'https://demo.example.test/' }), 'other', 'demo unset');
  assert.equal(hostnameOrNull('https://example.test'), null);
  assert.equal(hostnameOrNull('Example.Test'), 'example.test');
  for (const q of ['', 'utm_source=linkedin']) assert.ok(SOURCES.includes(of('x', q)));
});

async function setup({ clock }) {
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'x', GOOGLE_WEB_CLIENT_SECRET: 'y',
    AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const store = openHealthStore(':memory:');
  store.db.prepare(`INSERT INTO users (id, email, role, status, created_at, health_consent_at) VALUES
    ('lee', 'lee@example.com', 'user', 'approved', 'x', 'x'), ('kim', 'kim@example.com', 'user', 'pending', 'x', 'x')`).run();
  let email;
  let nonce;
  const app = await buildApp({ store, authMode: 'google', publicDir: PUBLIC, clock: () => clock.now, log: { info() {}, warn() {}, error() {} },
    ingest: { token: 'owner-ingest-token-made-up-0123456789', apple: 'rest' },
    usage: { place: fakePlace, siteHost: 'example.test', demoHost: 'demo.example.test' },
    auth: { settings, exchange: async () => ({ email, email_verified: true, nonce }) } });
  const cookies = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const signIn = async (as) => {
    email = as;
    const login = await app.inject('/auth/login?go=1');
    const url = new URL(login.headers.location);
    nonce = url.searchParams.get('nonce');
    const res = await app.inject({ url: `/auth/google/callback?state=${url.searchParams.get('state')}&code=c`, headers: { cookie: cookies(login) } });
    const cookie = cookies(res).split('; ').find((c) => c.startsWith('hr_session='));
    return (url2, headers = {}, remoteAddress = '192.0.2.10') => app.inject({ url: url2, remoteAddress, headers: { cookie, 'user-agent': IPHONE, ...headers } });
  };
  const table = () => store.db.prepare('SELECT * FROM usage_totals ORDER BY dimension, value').all();
  const totals = (dimension) => Object.fromEntries(table().filter((r) => r.dimension === dimension).map((r) => [r.value, r.count]));
  return { app, store, signIn, table, totals };
}

test('visits: once per account per owner day, by device and location; nothing else counts', async () => {
  const clock = { now: new Date('2026-11-03T16:00:00Z') };
  const { app, store, signIn, table, totals } = await setup({ clock });
  const lee = await signIn('lee@example.com');
  // Files, the sign-in steps and the health check never count as visits.
  await lee('/app.js');
  await app.inject('/api/health');
  assert.deepEqual(totals('device'), {});
  // The first API call of the day counts; more the same day do not.
  assert.equal((await lee('/api/status')).statusCode, 200);
  await lee('/api/status', { 'user-agent': DESKTOP }, '203.0.113.9');
  await lee('/api/home');
  assert.deepEqual(totals('device'), { phone: 1 });
  assert.deepEqual(totals('browser'), { 'Safari 18': 1 }, 'the later desktop request the same day is not counted');
  assert.deepEqual(totals('location'), { 'Springfield, Ohio, United States': 1 });
  // Another account counts on its own; a failed lookup is unknown.
  const owner = await signIn('owner@example.com');
  await owner('/api/status', { 'user-agent': DESKTOP }, '203.0.113.9');
  assert.deepEqual(totals('device'), { computer: 1, phone: 1 });
  assert.deepEqual(totals('browser'), { 'Chrome 130': 1, 'Safari 18': 1 });
  assert.deepEqual(totals('location'), { 'Springfield, Ohio, United States': 1, unknown: 1 });
  // A refused request (a pending account) and ingest posts never count.
  const kim = await signIn('kim@example.com');
  assert.equal((await kim('/api/status')).statusCode, 403);
  const posted = await app.inject({ method: 'POST', url: '/api/ingest/health', remoteAddress: '192.0.2.50',
    headers: { authorization: 'Bearer owner-ingest-token-made-up-0123456789', 'content-type': 'application/json', 'user-agent': ANDROID_TABLET }, payload: { data: { metrics: [] } } });
  assert.equal(posted.statusCode, 200);
  assert.deepEqual(totals('device'), { computer: 1, phone: 1 });
  // The next day in the owner's zone (midnight in New York is 05:00 UTC) counts again.
  clock.now = new Date('2026-11-04T04:59:00Z');
  await lee('/api/status');
  assert.deepEqual(totals('device'), { computer: 1, phone: 1 });
  clock.now = new Date('2026-11-04T05:01:00Z');
  await lee('/api/status');
  assert.deepEqual(table().filter((r) => r.dimension === 'device').map((r) => [r.day, r.value, r.count]),
    [['2026-11-03', 'computer', 1], ['2026-11-03', 'phone', 1], ['2026-11-04', 'phone', 1]]);
  await app.close();
  store.close();
});

test('arrivals: the sign-in page and the app page only, by source; the table holds no address, browser, referrer or user', async () => {
  const clock = { now: new Date('2026-11-03T16:00:00Z') };
  const { app, store, signIn, table, totals } = await setup({ clock });
  const visit = (url, headers = {}) => app.inject({ url, remoteAddress: '192.0.2.10', headers: { 'user-agent': IPHONE, ...headers } });
  await visit('/auth/login?utm_source=linkedin&utm_campaign=made-up-campaign', { 'sec-fetch-dest': 'document' });
  await visit('/auth/login', { referer: 'https://www.example.test/projects', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' });
  await visit('/auth/login', { referer: 'https://linkedin.com.example.com/x' });
  await visit('/auth/login', { referer: 'https://demo.example.test/#home' });
  await visit('/auth/login');
  // Not arrivals: Google's sign-in step, a script or image fetch, internal navigation, the signed-out app page (a redirect).
  await visit('/auth/login?go=1', { referer: 'https://www.linkedin.com/' });
  await visit('/auth/login', { referer: 'https://www.linkedin.com/', 'sec-fetch-dest': 'script' });
  await visit('/auth/login', { referer: 'http://localhost:5188/auth/register', 'sec-fetch-site': 'same-origin' });
  await visit('/auth/login', { referer: 'http://localhost:5188/auth/register' });
  assert.equal((await visit('/', { referer: 'https://github.com/someone' })).statusCode, 302);
  // Back from Google's sign-in, the app page counts as google_signin_return, which the dashboard leaves out.
  const lee = await signIn('lee@example.com');
  assert.equal((await lee('/', { referer: 'https://accounts.google.com/', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' })).statusCode, 200);
  assert.equal((await lee('/', { referer: 'https://github.com/someone' })).statusCode, 200);
  assert.deepEqual(totals('source'), { demo: 1, direct: 1, github: 1, google_signin_return: 1, linkedin: 1, other: 1, site: 1 });
  const period = usageTotals(store.db, { from: '2026-11-01', to: '2026-11-03' });
  assert.ok(!period.arrivals.some((r) => r.value === 'google_signin_return'));
  assert.equal(period.arrivals.reduce((n, r) => n + r.count, 0), 6);
  // The whole table: only day, dimension, value and count, and nothing that points back to a request or a person.
  const rows = table();
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['count', 'day', 'dimension', 'value']);
  const text = JSON.stringify(rows);
  for (const leak of ['192.0.2', 'Mozilla', 'iPhone', 'http', 'example.test', 'made-up-campaign', 'utm', 'lee', '@', 'someone']) assert.ok(!text.includes(leak), leak);
  assert.ok(!USER_TABLES.includes('usage_totals'), 'not a user table: not exported or deleted with an account');
  assert.equal(store.db.prepare("SELECT COUNT(*) FROM pragma_table_info('usage_totals') WHERE name = 'user_id'").pluck().get(), 0);
  await app.close();
  store.close();
});

test('the demo and local mode count nothing', async () => {
  for (const authMode of ['demo', 'none']) {
    const store = openHealthStore(':memory:');
    const app = await buildApp({ store, authMode, instance: authMode === 'demo' ? 'demo' : 'main', features: { chat: false }, publicDir: PUBLIC,
      usage: { place: fakePlace, siteHost: 'example.test', demoHost: 'demo.example.test' } });
    await app.inject({ url: '/', headers: { host: 'localhost', referer: 'https://github.com/x', 'user-agent': IPHONE } });
    await app.inject({ url: '/api/status', headers: { host: 'localhost' } });
    assert.equal(store.db.prepare('SELECT COUNT(*) FROM usage_totals').pluck().get(), 0, authMode);
    await app.close();
    store.close();
  }
});

test('the period totals: devices, locations rolled up to countries and states with the top cities, sources', () => {
  const store = openHealthStore(':memory:');
  const add = store.db.prepare('INSERT INTO usage_totals (day, dimension, value, count) VALUES (?, ?, ?, ?)');
  add.run('2026-11-02', 'device', 'phone', 3);
  add.run('2026-11-03', 'device', 'phone', 1);
  add.run('2026-11-03', 'device', 'computer', 2);
  add.run('2026-10-01', 'device', 'tablet', 9); // outside the period
  add.run('2026-11-03', 'browser', 'Safari 18', 2);
  add.run('2026-11-02', 'browser', 'Chrome 130', 1);
  add.run('2026-11-02', 'location', 'Springfield, Ohio, United States', 2);
  add.run('2026-11-03', 'location', 'Dayton, Ohio, United States', 1);
  add.run('2026-11-03', 'location', 'Austin, Texas, United States', 1);
  add.run('2026-11-03', 'location', 'unknown', 1);
  add.run('2026-11-03', 'source', 'linkedin', 2);
  add.run('2026-11-03', 'source', 'google_signin_return', 5);
  const t = usageTotals(store.db, { from: '2026-10-27', to: '2026-11-03' });
  assert.deepEqual(t.visits.device, [{ value: 'phone', count: 4 }, { value: 'computer', count: 2 }]);
  assert.deepEqual(t.visits.browser, [{ value: 'Safari 18', count: 2 }, { value: 'Chrome 130', count: 1 }]);
  assert.deepEqual(t.visits.location.countries, [{ value: 'United States', count: 4 }, { value: 'Unknown', count: 1 }]);
  assert.deepEqual(t.visits.location.states, [{ value: 'Ohio, United States', count: 3 }, { value: 'Texas, United States', count: 1 }, { value: 'Unknown', count: 1 }]);
  assert.deepEqual(t.visits.location.cities[0], { value: 'Springfield, Ohio, United States', count: 2 });
  assert.deepEqual(t.arrivals, [{ value: 'linkedin', count: 2 }]);
  store.close();
});
