// Telemetry (tools/telemetry.ts, docs/adr/0013): only allowlisted attributes are ever recorded, and nothing from a
// request's URL, query, headers or body, nor a user's id or email, reaches a span or a metric. Made-up values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { AggregationTemporality, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  ALLOWED, InMemoryMetricExporter, InMemorySpanExporter, TelemetryAttributeError, clean, createTelemetry, installTelemetry, summarize,
} from '../tools/telemetry.ts';
import { openTestStore } from './helpers.js';
import { buildApp } from '../server/app.js';
import { createScheduler, parseSchedule } from '../server/scheduler.js';
import { scopeStore } from '../db/scope.ts';
import { OWNER_ID, startUserRun } from '../db/users.ts';

const MARKER = 'MARKER-7f3a';
const EMAIL = 'made-up-person@example.com';

/** Telemetry that keeps everything in memory, strict: a disallowed attribute throws instead of being dropped. */
function memoryTelemetry() {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 3_600_000 });
  const t = createTelemetry({ strict: true, spanExporter: spans, metricReader, log: {} });
  installTelemetry(t);
  return {
    t, spans, metrics,
    /** Everything exported, as one text, and every attribute key seen. */
    async collected() {
      await t.flush();
      const finished = spans.getFinishedSpans();
      const resourceMetrics = metrics.getMetrics();
      const keys = new Set([
        ...finished.flatMap((s) => Object.keys(s.attributes)),
        ...resourceMetrics.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics.flatMap((m) => m.dataPoints.flatMap((p) => Object.keys(p.attributes)))))]);
      const text = JSON.stringify({
        spans: finished.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, resource: s.resource.attributes })),
        metrics: resourceMetrics,
      });
      return { finished, resourceMetrics, keys, text };
    },
  };
}

test('the allowlist: unknown keys and values that fail their check are dropped, and throw when strict', () => {
  assert.deepEqual(clean({ 'http.request.method': 'GET', 'http.route': '/api/days/:date', 'user.id': OWNER_ID }),
    { 'http.request.method': 'GET', 'http.route': '/api/days/:date' });
  assert.deepEqual(clean({ 'http.route': `/api/days/2026-01-01?q=${MARKER}` }), {}, 'a filled-in URL with a query is not a route template');
  assert.deepEqual(clean({ 'http.route': EMAIL }), {});
  assert.deepEqual(clean({ 'job.name': 'sync', 'job.result': 'ok' }), { 'job.name': 'sync', 'job.result': 'ok' });
  assert.deepEqual(clean({ 'job.name': MARKER }), {});
  assert.deepEqual(clean({ 'http.response.status_code': 200.5 }), {});
  assert.deepEqual(clean({ toString: 'x', __proto__: { 'http.request.method': 'GET' } }), {}, 'never from the prototype');
  assert.throws(() => clean({ 'user.email': EMAIL }, true), (err) => err instanceof TelemetryAttributeError && !err.message.includes(EMAIL));
  assert.throws(() => clean({ 'http.route': MARKER }, true), TelemetryAttributeError);
});

test('requests: method, route template, status and duration only; nothing from the URL, query, headers, body or user', async () => {
  const mem = memoryTelemetry();
  const store = await openTestStore();
  const app = await buildApp({ store, log: { info() {}, warn() {}, error() {} } });
  try {
    const headers = { host: 'localhost:5188', origin: 'http://localhost:5188', 'x-made-up': MARKER, 'user-agent': MARKER };
    await app.inject({ url: `/api/days/2026-01-01?q=${MARKER}&email=${encodeURIComponent(EMAIL)}&uid=${OWNER_ID}`, headers });
    await app.inject({ method: 'PUT', url: '/api/checkins/2026-01-01', headers, payload: { mood: 5, notes: `${MARKER} ${EMAIL}` } });
    await app.inject({ url: `/no/such/${MARKER}/${EMAIL}`, headers });
    await app.inject({ url: '/api/v1/status', headers });
    const { finished, keys, text } = await mem.collected();
    assert.ok(finished.length >= 4, `a span per request (${finished.length})`);
    assert.deepEqual([...keys].filter((k) => !Object.hasOwn(ALLOWED, k)), [], 'only allowlisted attribute keys');
    for (const secret of [MARKER, EMAIL, OWNER_ID, '2026-01-01']) assert.ok(!text.includes(secret), `never recorded: ${secret}`);
    const routes = finished.map((s) => s.attributes['http.route']);
    assert.ok(routes.includes('/api/days/:date') && routes.includes('/api/checkins/:date') && routes.includes('/api/status'));
    assert.ok(routes.includes('unmatched'), 'an unknown URL is recorded as unmatched, never by its path');
  } finally {
    await app.close();
    await store.close();
    await mem.t.shutdown();
    installTelemetry(null);
  }
});

test('scheduled jobs and Claude calls: by name and outcome only', async () => {
  const mem = memoryTelemetry();
  const store = await openTestStore();
  try {
    await createScheduler({
      jobs: [{ name: 'sync', schedule: parseSchedule('daily 07:00'), run: async () => {} },
        { name: 'backup', schedule: parseSchedule('daily 07:00'), run: async () => { throw new Error(MARKER); } }],
      runs: { lastRanAt: () => '2026-10-24T07:00:00.000Z', isRunning: () => false },
      now: () => new Date('2026-10-25T08:00:00Z'), tz: 'UTC', log: {}, every: () => null,
    }).start();
    await tick();
    const run = await startUserRun(scopeStore(store, OWNER_ID), 'advisor-chat', {}, { info() {}, warn() {} });
    await run.recordCall({ label: MARKER, model: 'made-up-model', inputTokens: 12, durationMs: 40 });
    await run.recordCall({ label: 'x', error: { name: 'Error', message: MARKER }, durationMs: 5 });
    await run.finish('ok');
    const { keys, text, finished } = await mem.collected();
    assert.deepEqual([...keys].filter((k) => !Object.hasOwn(ALLOWED, k)), []);
    assert.ok(!text.includes(MARKER) && !text.includes('made-up-model'), 'no labels, models or error text');
    const jobs = finished.filter((s) => s.attributes['job.name']).map((s) => `${s.attributes['job.name']} ${s.attributes['job.result']}`).sort();
    assert.deepEqual(jobs, ['backup failed', 'sync ok']);
    const ai = finished.filter((s) => s.attributes['ai.capability']).map((s) => `${s.attributes['ai.capability']} ${s.attributes['ai.outcome']}`).sort();
    assert.deepEqual(ai, ['advisor-chat error', 'advisor-chat ok']);
  } finally {
    await store.close();
    await mem.t.shutdown();
    installTelemetry(null);
  }
});

test('the log summary: route templates and numbers only', async () => {
  const mem = memoryTelemetry();
  try {
    mem.t.request('GET', '/api/days/:date', 200, 30);
    mem.t.request('GET', '/api/days/:date', 500, 1200);
    mem.t.request('GET', null, 404, 3);
    mem.t.job('sync', 'ok', 900);
    const { resourceMetrics } = await mem.collected();
    const line = summarize(resourceMetrics.at(-1));
    assert.match(line, /^requests 3 errors 1; GET \/api\/days\/:date 2 avg 615ms max 1200ms errors 1; GET unmatched 1 avg 3ms max 3ms; job sync ok 1$/);
  } finally {
    await mem.t.shutdown();
    installTelemetry(null);
  }
});

test('TELEMETRY off records nothing, and an unknown mode refuses to start', () => {
  const off = createTelemetry({ mode: 'off' });
  off.request('GET', '/api/status', 200, 1);
  assert.throws(() => createTelemetry({ mode: 'cloud' }), /TELEMETRY must be log or off/);
});
