// Multi-user guard (phase 1), the behavioral half: with user A's data in the database, user B (signed in, approved) sees
// none of it on any GET route, and no write route sent by B changes any of A's rows. Routes come from the app's own
// route table, so a new route is covered without editing this test. Made-up demo data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { sign, sessionKey } from '../server/session.js';
import { refreshDemoDatabase, loadDemoCatalog } from '../demo/generate.js';
import { USER_TABLES } from '../db/migrations-users.js';
import { OWNER_ID } from '../db/users.js';

const TODAY = '2026-10-07';
const SITE = 'http://localhost:5188';
const B = '00000000-0000-4000-8000-0000000000b2';
// Strings only user A's made-up data holds (medications, labs, prompts, reviews, notes, drinks). Program names are left out:
// the catalog's own names are not user data (the MAPS catalog becomes the owner's and family's only in phase 5).
const MARKERS = ['Sample Creatine', 'Sample Fish Oil', 'Total Cholesterol', 'Sample profile', 'Sample review',
  'Sample note', 'Dinner out', 'Sample reply'];
// A date and ids that A's data has, so B's writes aim at A's rows.
const PARAMS = { date: '2026-10-06', id: '1', metric: 'hrv_ms' };
const QUERIES = {
  '/api/history': '?from=2025-01-01&to=2026-10-07', '/api/training': '?view=all', '/api/vo2max': '?view=all',
  '/api/cardio-zones': '?view=1y', '/api/runs': '?limit=100', '/api/medications/checkoffs': '?weeks=52',
};

async function setup() {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({
    AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'client.apps.example', GOOGLE_WEB_CLIENT_SECRET: 'secret',
    AUTH_ALLOWED_EMAILS: 'a@example.com, b@example.com', SESSION_SECRET: secret,
  });
  const store = openHealthStore(':memory:');
  refreshDemoDatabase(store, { today: TODAY }); // user A (the owner) gets the demo's made-up data
  store.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES (?, 'b@example.com', 'user', 'approved', 'x')").run(B);
  const app = await buildApp({ store, authMode: 'google', auth: { settings }, clock: () => new Date(`${TODAY}T16:00:00Z`), catalog: loadDemoCatalog() });
  const cookie = (email) => `hr_session=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`;
  return { store, app, asA: cookie('a@example.com'), asB: cookie('b@example.com') };
}

const fill = (url) => url.replace(/:(\w+)/g, (_, k) => PARAMS[k] ?? '1');
const snapshot = (db, uid) => JSON.stringify(USER_TABLES.map((t) => db.prepare(`SELECT * FROM "${t}" WHERE user_id = ? ORDER BY rowid`).all(uid)));

test('isolation: B sees none of A\'s data on any GET route; A sees it', async () => {
  const { store, app, asA, asB } = await setup();
  const gets = app.routeList.filter((r) => r.method === 'GET' && r.url.startsWith('/api/') && r.url !== '/api/openapi.json');
  assert.ok(gets.length >= 25, 'the route table lists the GET routes');
  const seenByA = new Set();
  for (const r of gets) {
    const url = fill(r.url) + (QUERIES[r.url] ?? '');
    const asUser = async (cookie) => (await app.inject({ url, headers: { cookie } })).body;
    const bodyB = await asUser(asB);
    for (const m of MARKERS) assert.ok(!bodyB.includes(m), `${r.url} shows A's "${m}" to B`);
    const bodyA = await asUser(asA);
    for (const m of MARKERS) if (bodyA.includes(m)) seenByA.add(m);
  }
  assert.ok(seenByA.size >= 6, `A sees their own data (${[...seenByA].join(', ')})`);
  await app.close();
  store.close();
});

test('isolation: no write route sent by B changes any of A\'s rows', async () => {
  const { store, app, asB } = await setup();
  const before = snapshot(store.db, OWNER_ID);
  const writes = app.routeList.filter((r) => ['PUT', 'POST', 'DELETE'].includes(r.method) && r.url.startsWith('/api/') && !r.url.startsWith('/api/ingest/'));
  assert.ok(writes.length >= 20);
  // Plausible bodies for the routes that edit an existing row, so they get past validation and try A's row.
  const BODIES = {
    'PUT /api/medications/:id': { name: 'Changed by B' },
    'PUT /api/prompt/sections/:id': { text: 'Changed by B' },
    'PUT /api/labs/results/:id': { value: '1' },
    'PUT /api/labs/tests/:id': { unit: 'x' },
    'POST /api/medications/:id/stop': { stopped_on: '2026-10-06' },
    'POST /api/medications/:id/changes': { dose: '9 g', timings: ['morning'], effective_on: '2026-10-06' },
    'POST /api/medications/combine': { ids: [1, 2], name: 'Combined by B', timing: 'morning' },
    'PUT /api/doses/:date': { doses: [{ medication_id: 1, timing: 'morning', taken: false }] },
  };
  for (const r of writes) {
    const body = BODIES[`${r.method} ${r.url}`] ?? (r.method === 'DELETE' ? undefined : {});
    await app.inject({ method: r.method, url: fill(r.url), headers: { cookie: asB, origin: SITE }, ...(body ? { payload: body } : {}) });
  }
  assert.equal(snapshot(store.db, OWNER_ID), before, "A's rows are unchanged");
  await app.close();
  store.close();
});
