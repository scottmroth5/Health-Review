// Health tab targets API: suggestions from the profile and 90 days of data, the owner's own target, reset, and
// validation. Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { addDays } from '../metrics/stats.js';

const TODAY = new Date(2026, 2, 9, 12, 0); // 2026-03-09

async function setup() {
  const store = openHealthStore(':memory:');
  const add = store.db.prepare("INSERT INTO daily_metrics (date, steps, resting_hr, updated_at) VALUES (?, 6500, 64, 'x')");
  for (let d = '2025-12-10'; d <= '2026-03-09'; d = addDays(d, 1)) add.run(d); // 90 days
  store.db.prepare("INSERT INTO daily_metrics (date, steps, updated_at) VALUES ('2025-11-01', 100, 'x')").run(); // before the 90 days
  const app = await buildApp({ store, clock: () => TODAY });
  return { app, db: store.db, done: async () => { await app.close(); store.close(); } };
}
const req = (app, method, url, payload) => app.inject({ method, url, payload });
const target = (body, metric) => body.targets.find((t) => t.metric === metric);

test('targets: personal until the profile is set, then from the norm for the owner\'s age; owner targets win until reset', async () => {
  const { app, done } = await setup();
  let body = (await app.inject('/api/targets')).json();
  assert.deepEqual(body.profile, { birthYear: null, sex: null, heightIn: null, age: null });
  // Steps' norm applies to adults of any sex, but its age bands need an age: without a profile, it is the adult norm only
  // when the band covers every age, so steps (two bands) is personal: 6500 + 1000.
  assert.deepEqual([target(body, 'steps').suggested, target(body, 'steps').basis], [7500, 'personal']);
  assert.equal(target(body, 'resting_hr').suggested, 62); // adult norm: 64 -> 62
  assert.equal(target(body, 'weight_lbs').current, null);

  assert.equal((await req(app, 'PUT', '/api/profile', { birth_year: 1975, sex: 'male', height_in: 70 })).statusCode, 200);
  body = (await app.inject('/api/targets')).json();
  assert.equal(body.profile.age, 51);
  const steps = target(body, 'steps');
  assert.deepEqual([steps.current, steps.suggested, steps.target, steps.setBy, steps.basis], [6500, 7500, 7500, 'suggested', 'norm']);
  assert.match(steps.reason, /Healthy for adults under 60: 8,000 steps or more/);

  const mine = (await req(app, 'PUT', '/api/targets/steps', { target: 9000 })).json();
  assert.deepEqual([mine.target, mine.suggested, mine.setBy], [9000, 7500, 'owner']);
  const reset = (await req(app, 'DELETE', '/api/targets/steps')).json();
  assert.deepEqual([reset.target, reset.setBy], [7500, 'suggested']);
  await done();
});

test('targets: unknown metrics, out-of-range targets and bad profiles are refused', async () => {
  const { app, done } = await setup();
  assert.equal((await req(app, 'PUT', '/api/targets/nope', { target: 1 })).statusCode, 400);
  assert.equal((await req(app, 'PUT', '/api/targets/steps', { target: -1 })).statusCode, 400);
  assert.equal((await req(app, 'PUT', '/api/targets/steps', {})).statusCode, 400);
  assert.equal((await req(app, 'PUT', '/api/profile', { sex: 'other' })).statusCode, 400);
  assert.equal((await req(app, 'PUT', '/api/profile', { height_in: 20 })).statusCode, 400);
  assert.equal((await req(app, 'PUT', '/api/profile', { birth_year: 2030 })).statusCode, 400);
  assert.equal((await req(app, 'PUT', '/api/profile', {})).statusCode, 400);
  // null clears a profile value
  await req(app, 'PUT', '/api/profile', { birth_year: 1975, sex: 'male' });
  assert.equal((await req(app, 'PUT', '/api/profile', { sex: null })).json().sex, null);
  await done();
});
