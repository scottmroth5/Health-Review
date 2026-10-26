import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnerStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { buildDemoDatabase, refreshDemoDatabase, demoBuiltFor, loadDemoCatalog, DEMO_SUBSTITUTIONS_PATH } from '../demo/generate.js';
import { zonedInstant } from '../tools/time.js';
import { writeDemoReview } from '../demo/reviews.js';
import { renderReport } from '../agent/instructions.js';
import { allowedNumbers, checkReport } from '../agent/validate.js';
import { NIGHT_BREATHING_NAMES } from '../agent/review.js';

const TODAY = '2026-10-07';
const dir = mkdtempSync(join(tmpdir(), 'health-demo-'));

/** Values that change if the generated data changes (ids from block detection are random, so they are left out). */
function fingerprint(path) {
  const store = openOwnerStore(path);
  const one = (sql) => store.db.prepare(sql).pluck().get();
  const out = {
    days: one('SELECT COUNT(*) FROM daily_metrics'), steps: one('SELECT SUM(steps) FROM daily_metrics'),
    sets: one('SELECT COUNT(*) FROM strength_sets'), load: one('SELECT SUM(weight_lbs) FROM strength_sets'),
    sessions: one('SELECT COUNT(*) FROM workout_sessions'), blocks: one("SELECT GROUP_CONCAT(program || ':' || start_date || ':' || status, ',') FROM (SELECT * FROM program_blocks ORDER BY start_date)"),
    unmapped: one("SELECT COUNT(*) FROM strength_exercises WHERE map_status <> 'mapped'"),
    medications: one("SELECT COUNT(*) FROM medications WHERE kind = 'medication'"),
  };
  store.close();
  return out;
}

test('demo data: the same seed and day give the same data; every exercise maps; supplements only; two years of MAPS runs, one in progress', () => {
  const started = Date.now();
  buildDemoDatabase({ path: join(dir, 'a.db'), today: TODAY });
  console.log(`# demo build: ${Date.now() - started} ms`);
  buildDemoDatabase({ path: join(dir, 'b.db'), today: TODAY });
  const a = fingerprint(join(dir, 'a.db'));
  assert.deepEqual(fingerprint(join(dir, 'b.db')), a);
  assert.ok(a.days > 700 && a.sets > 3000, 'two years of data');
  assert.equal(a.unmapped, 0);
  assert.equal(a.medications, 0, 'no prescription medicines in the demo');
  assert.match(a.blocks, /MAPS Split:\d{4}-\d{2}-\d{2}:in_progress$/);
  assert.ok(a.blocks.split(',').length >= 10, 'ten or more program runs');
  // MAPS program names only (owner's choice, 2026-10-24); the catalog says its structure is made up.
  assert.ok(loadDemoCatalog().programs.every((p) => /^(MAPS |HIIT$)/.test(p.name)));
  assert.match(JSON.parse(readFileSync(new URL('../demo/catalog.json', import.meta.url), 'utf8')).note, /made up for the demo/);
});

test('demo instance: reports itself, refuses sync and chat, shows only its own runs, ranks the catalog programs', async () => {
  const store = openOwnerStore(join(dir, 'a.db'));
  const app = await buildApp({ store, clock: () => new Date(2026, 9, 7, 12), instance: 'demo', features: { chat: false },
    catalog: loadDemoCatalog(), substitutions: JSON.parse(readFileSync(DEMO_SUBSTITUTIONS_PATH, 'utf8')) });
  const status = (await app.inject('/api/status')).json();
  assert.equal(status.instance, 'demo');
  assert.equal(status.sync, false);
  assert.ok(status.dataChecks.length >= 1, 'the planted gap or partial day shows');
  assert.equal((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode, 503);
  assert.equal((await app.inject('/api/advisor/chat')).json().enabled, false);
  assert.equal((await app.inject('/api/reviews/status')).json().canRun, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/reviews/run', payload: {} })).statusCode, 503);
  assert.equal((await app.inject({ method: 'POST', url: '/api/advisor/chat', payload: { text: 'hi' } })).statusCode, 503);
  assert.deepEqual((await app.inject('/api/jobs')).json().ingest, [], 'its own database only');
  const advisor = (await app.inject('/api/advisor')).json();
  assert.equal(advisor.available, true);
  const names = new Set(loadDemoCatalog().programs.map((p) => p.name));
  assert.ok(advisor.ranking.length >= 5 && advisor.ranking.every((r) => names.has(r.program)));
  assert.deepEqual(advisor.excluded, [{ program: 'MAPS Split', reason: 'run last' }]);
  assert.equal((await app.inject('/api/program')).json().program.program, 'MAPS Split');
  const statuses = new Set((await app.inject('/api/lifts')).json().map((l) => l.status));
  for (const s of ['progressing', 'stalled', 'regressing']) assert.ok(statuses.has(s), `Lift progress shows ${s}`);
  // 26 weekly reviews, each written from its week's summary and passing the review's own checks.
  const reviews = store.db.prepare('SELECT week_ending, summary_json, report_md FROM reviews WHERE user_id = @uid ORDER BY week_ending').all();
  assert.equal(reviews.length, 26);
  const labNames = [...store.db.prepare('SELECT name FROM lab_tests WHERE user_id = @uid').pluck().all(), ...NIGHT_BREATHING_NAMES];
  for (const r of reviews) {
    const summary = JSON.parse(r.summary_json);
    const report = writeDemoReview(summary);
    assert.equal(renderReport(report), r.report_md);
    assert.deepEqual(checkReport(report, { allowed: allowedNumbers(summary), medicationNames: [], labNames }), [], r.week_ending);
    assert.ok(report.sections.length >= 7, `${r.week_ending}: a full review`);
    assert.doesNotMatch(r.report_md, /\b[a-z]+_[a-z]+(_[a-z]+)*\b/, `${r.week_ending}: readable names, never metric keys`);
  }
  assert.ok(store.db.prepare('SELECT COUNT(*) FROM advisor_notes WHERE user_id = @uid').pluck().get() >= 8, 'a chat thread');
  // The sample chat keeps the boundary the chat states: pain goes to a physician before any program talk.
  const replies = store.db.prepare("SELECT text FROM advisor_notes WHERE user_id = @uid AND role = 'claude'").pluck().all();
  assert.ok(replies.some((t) => /shoulder pain .* physician/.test(t)), 'the shoulder reply points to a physician');
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('demo database: builds with no arguments (the demo container starts with an empty data folder)', () => {
  const path = join(dir, 'defaults.db');
  const counts = buildDemoDatabase({ path });
  assert.ok(counts.days > 700, 'about two years of made-up days, ending today');
});

test('demo refresh: made again in place equals a fresh build, and moves forward with the day', () => {
  const own = mkdtempSync(join(tmpdir(), 'health-demo-refresh-'));
  try {
    buildDemoDatabase({ path: join(own, 'fresh.db'), today: '2026-10-08' });
    buildDemoDatabase({ path: join(own, 'old.db'), today: TODAY });
    const store = openOwnerStore(join(own, 'old.db'));
    assert.equal(demoBuiltFor(store), TODAY);
    refreshDemoDatabase(store, { today: '2026-10-08' });
    assert.equal(demoBuiltFor(store), '2026-10-08');
    const one = (sql) => store.db.prepare(sql).pluck().get();
    assert.equal(one('SELECT MAX(date) FROM daily_metrics'), '2026-10-07', 'Apple Health days run through yesterday');
    assert.equal(one("SELECT COUNT(*) FROM checkins WHERE date = '2026-10-08'"), 1, "today's check-in is logged");
    assert.ok(one("SELECT COUNT(*) FROM medication_doses WHERE date = '2026-10-08' AND timing = 'morning' AND taken = 1") >= 1);
    assert.equal(one("SELECT COUNT(*) FROM daily_metrics WHERE date = '2026-10-08'"), 0, 'no Apple Health day for today yet');
    store.close();
    assert.deepEqual(fingerprint(join(own, 'old.db')), fingerprint(join(own, 'fresh.db')));
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});

test('demo clock: pinned to the build day, the demo shows that day as today and no "data stopped" check', async () => {
  const own = mkdtempSync(join(tmpdir(), 'health-demo-clock-'));
  const store = openOwnerStore(join(own, 'd.db'));
  try {
    refreshDemoDatabase(store, { today: TODAY });
    const app = await buildApp({ store, clock: () => zonedInstant(demoBuiltFor(store), 12, 0), instance: 'demo', authMode: 'demo',
      features: { chat: false }, catalog: loadDemoCatalog(), substitutions: JSON.parse(readFileSync(DEMO_SUBSTITUTIONS_PATH, 'utf8')) });
    const status = (await app.inject('/api/status')).json();
    assert.equal(status.today, TODAY);
    assert.ok(!status.dataChecks.some((c) => /stale|stopped/.test(`${c.kind ?? ''} ${c.message ?? ''}`)), JSON.stringify(status.dataChecks));
    assert.equal((await app.inject(`/api/days/${TODAY}`)).json().checkin.date, TODAY);
    await app.close();
  } finally {
    store.close();
    rmSync(own, { recursive: true, force: true });
  }
});
