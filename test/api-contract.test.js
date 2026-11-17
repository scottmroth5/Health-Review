// The API contract (v3 Phase 2 step 3): the running API against its recorded OpenAPI document (docs/api/openapi.json,
// docs/api/CHANGELOG.md), every route documented, real responses valid against their documented schemas, and /api/v1
// the same API as /api. Made-up data only (the demo's), on the test engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import Ajv from 'ajv';
import { CHANGELOG_PATH, SNAPSHOT_PATH, currentDocument, snapshotHash, snapshotText } from '../scripts/api-snapshot.js';
import { apiV1Alias, buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { openHealthStore } from '../db/store.ts';
import { refreshDemoDatabase } from '../demo/generate.js';
import { answers, TODAY } from './route-answers.js';

const quiet = { info() {}, warn() {}, error() {} };
const toOpenApiPath = (url) => url.replace(/:(\w+)/g, '{$1}');

test('the recorded contract is current: docs/api/openapi.json matches the running API, and the changelog names it', async () => {
  const live = snapshotText(await currentDocument());
  const recorded = readFileSync(SNAPSHOT_PATH, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(live === recorded, 'the API contract changed: run npm run api:snapshot and add a docs/api/CHANGELOG.md entry');
  const newest = /^## .*\(([0-9a-f]{12})\)$/m.exec(readFileSync(CHANGELOG_PATH, 'utf8'));
  assert.equal(newest?.[1], snapshotHash(live), 'the newest changelog entry names the current snapshot hash');
});

test('every API route is in the document, and every documented path is a real route', async () => {
  const store = openHealthStore(':memory:', { log: {} });
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: 'http://localhost:5188', GOOGLE_WEB_CLIENT_ID: 'x',
    GOOGLE_WEB_CLIENT_SECRET: 'y', AUTH_ALLOWED_EMAILS: 'a@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const app = await buildApp({ store, authMode: 'google', auth: { settings }, log: quiet });
  try {
    await app.ready();
    const doc = app.swagger();
    const documented = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
    const hidden = new Set(['/api/openapi.json']);
    const routes = new Set(app.routeList.filter((r) => r.url.startsWith('/api/') && !hidden.has(r.url) && r.method !== 'HEAD')
      .map((r) => `${r.method} ${toOpenApiPath(r.url)}`));
    assert.deepEqual([...routes].filter((r) => !documented.has(r)), [], 'routes missing from the document');
    assert.deepEqual([...documented].filter((d) => !routes.has(d)), [], 'documented paths with no route');
    assert.ok(routes.size >= 100, `the comparison saw the API (${routes.size} routes)`);
  } finally {
    await app.close();
    store.close();
  }
});

/** An OpenAPI 3.0 schema as JSON Schema for ajv: nullable becomes a null type (and a null enum value). */
function jsonSchema(node) {
  if (Array.isArray(node)) return node.map(jsonSchema);
  if (!node || typeof node !== 'object') return node;
  const { nullable, ...rest } = node;
  const out = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, jsonSchema(v)]));
  if (nullable) {
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    if (!out.type && !out.enum) return { anyOf: [out, { type: 'null' }] };
  }
  return out;
}

test('every GET answers with what the document says, and /api/v1 answers the same as /api (demo data)', { timeout: 300_000 }, async () => {
  const store = openHealthStore(':memory:', { log: {} });
  try {
    await refreshDemoDatabase(store, { today: TODAY });
    const doc = await currentDocument();
    const ajv = new Ajv({ strict: false, allErrors: false, allowUnionTypes: true });
    const problems = [];
    let checked = 0;
    const legacy = await answers(store, {
      onAnswer: (route, url, res) => {
        if (route.url === '/api/openapi.json') return; // the document itself, hidden from itself
        if (res.statusCode !== 200 || !String(res.headers['content-type'] ?? '').startsWith('application/json')) return;
        const schema = doc.paths[toOpenApiPath(route.url)]?.get?.responses?.['200']?.content?.['application/json']?.schema;
        if (!schema) { problems.push(`${url}: no documented 200 schema`); return; }
        const validate = ajv.compile(jsonSchema(schema));
        if (!validate(JSON.parse(res.body))) problems.push(`${url}: ${ajv.errorsText(validate.errors)}`);
        checked += 1;
      },
    });
    assert.deepEqual(problems, [], 'responses that do not match their documented schema');
    assert.ok(checked >= 50, `bodies checked against the document (${checked})`);
    const v1 = await answers(store, { prefix: '/api/v1/' });
    const differ = Object.keys(legacy).filter((u) => legacy[u] !== v1[u]);
    assert.deepEqual(differ, [], '/api/v1 answers differently from /api');
  } finally {
    store.close();
  }
});

test('/api/v1 is an alias: every check sees the /api path; ingest keeps its one URL', async () => {
  assert.equal(apiV1Alias({ url: '/api/v1/status' }), '/api/status');
  assert.equal(apiV1Alias({ url: '/api/v1/reviews/versions/abc?x=1' }), '/api/reviews/versions/abc?x=1');
  assert.equal(apiV1Alias({ url: '/api/v1/ingest/health' }), '/api/v1/ingest/health', 'ingest is never under v1');
  assert.equal(apiV1Alias({ url: '/api/status' }), '/api/status');
  assert.equal(apiV1Alias({ url: '/api/v1' }), '/api/v1', 'only paths under /api/v1/');
  assert.equal(apiV1Alias({ url: '/api/v1/v1/status' }), '/api/v1/status', 'rewritten once, never twice');

  // The demo refuses writes under /api/v1 as under /api.
  const demo = openHealthStore(':memory:', { log: {} });
  const demoApp = await buildApp({ store: demo, authMode: 'demo', log: quiet });
  try {
    for (const url of ['/api/checkins/2026-01-01', '/api/v1/checkins/2026-01-01']) {
      const res = await demoApp.inject({ method: 'PUT', url, payload: { mood: 5 }, headers: { host: 'localhost:5189' } });
      assert.equal(res.statusCode, 403, url);
    }
  } finally {
    await demoApp.close();
    demo.close();
  }

  // Google mode: no session is refused under /api/v1 too, and ingest answers only at its own URL.
  const store = openHealthStore(':memory:', { log: {} });
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: 'http://localhost:5188', GOOGLE_WEB_CLIENT_ID: 'x',
    GOOGLE_WEB_CLIENT_SECRET: 'y', AUTH_ALLOWED_EMAILS: 'a@example.com', SESSION_SECRET: randomBytes(48).toString('base64') });
  const app = await buildApp({ store, authMode: 'google', auth: { settings }, ingest: { token: 'made-up-token-for-tests' }, log: quiet });
  try {
    assert.equal((await app.inject({ url: '/api/v1/status' })).statusCode, 401, 'sign-in still required');
    assert.equal((await app.inject({ url: '/api/v1/health' })).statusCode, 200, 'the open health check is open under v1 too');
    const post = (url) => app.inject({ method: 'POST', url, headers: { authorization: 'Bearer made-up-token-for-tests', 'content-type': 'application/json' }, payload: { data: { metrics: [] } } });
    assert.notEqual((await post('/api/ingest/health')).statusCode, 404, 'ingest answers at /api/ingest');
    // Not a route under v1: the sign-in check refuses it before routing could answer 404; either way it is never served.
    assert.ok([401, 404].includes((await post('/api/v1/ingest/health')).statusCode), 'and nowhere else');
  } finally {
    await app.close();
    store.close();
  }
});
