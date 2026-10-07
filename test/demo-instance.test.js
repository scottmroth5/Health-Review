import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { buildDemoDatabase, loadDemoCatalog, DEMO_SUBSTITUTIONS_PATH } from '../demo/generate.js';

const TODAY = '2026-10-07';
const dir = mkdtempSync(join(tmpdir(), 'health-demo-'));

/** Values that change if the generated data changes (ids from block detection are random, so they are left out). */
function fingerprint(path) {
  const store = openHealthStore(path);
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

test('demo data: the same seed and day give the same data; every exercise maps; supplements only; one block in progress', () => {
  buildDemoDatabase({ path: join(dir, 'a.db'), today: TODAY });
  buildDemoDatabase({ path: join(dir, 'b.db'), today: TODAY });
  const a = fingerprint(join(dir, 'a.db'));
  assert.deepEqual(fingerprint(join(dir, 'b.db')), a);
  assert.ok(a.days > 400 && a.sets > 1000, 'about 15 months of data');
  assert.equal(a.unmapped, 0);
  assert.equal(a.medications, 0, 'no prescription medicines in the demo');
  assert.match(a.blocks, /Sample Balance:\d{4}-\d{2}-\d{2}:in_progress$/);
  assert.ok(loadDemoCatalog().programs.every((p) => p.name.startsWith('Sample ')), 'made-up program names only');
});

test('demo instance: reports itself, refuses sync and chat, reads its own logs, ranks the made-up programs', async () => {
  const store = openHealthStore(join(dir, 'a.db'));
  const app = await buildApp({ store, clock: () => new Date(2026, 9, 7, 12), instance: 'demo', features: { chat: false },
    catalog: loadDemoCatalog(), substitutions: JSON.parse(readFileSync(DEMO_SUBSTITUTIONS_PATH, 'utf8')), logDir: join(dir, 'logs') });
  const status = (await app.inject('/api/status')).json();
  assert.equal(status.instance, 'demo');
  assert.equal(status.sync, false);
  assert.ok(status.dataChecks.length >= 1, 'the planted gap or partial day shows');
  assert.equal((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode, 503);
  assert.equal((await app.inject('/api/advisor/chat')).json().enabled, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/advisor/chat', payload: { text: 'hi' } })).statusCode, 503);
  assert.deepEqual((await app.inject('/api/logs/sync')).json().lines, [], 'never the main instance logs');
  const advisor = (await app.inject('/api/advisor')).json();
  assert.equal(advisor.available, true);
  assert.ok(advisor.ranking.length >= 2 && advisor.ranking.every((r) => r.program.startsWith('Sample ')));
  assert.deepEqual(advisor.excluded, [{ program: 'Sample Balance', reason: 'run last' }]);
  assert.equal((await app.inject('/api/program')).json().program.program, 'Sample Balance');
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
