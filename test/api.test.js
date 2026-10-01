import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { assertSafeBinding } from '../server/auth.js';

const TODAY = new Date(2026, 2, 9, 12, 0); // local 2026-03-09

async function setup(services = {}) {
  const store = openHealthStore(':memory:');
  const app = await buildApp({ store, services, clock: () => TODAY });
  return { store, app, db: store.db, done: async () => { await app.close(); store.close(); } };
}

const put = (app, url, payload) => app.inject({ method: 'PUT', url, payload });
const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });

test('the server refuses to listen beyond localhost without a login mode', () => {
  assert.doesNotThrow(() => assertSafeBinding({ host: '127.0.0.1' }));
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0' }), /only allows localhost/);
});

test('requests addressed to another host are rejected (DNS rebinding)', async () => {
  const { app, done } = await setup();
  assert.equal((await app.inject({ url: '/api/status', headers: { host: 'localhost:5188' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers: { host: '127.0.0.1:5188' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers: { host: 'evil.example:5188' } })).statusCode, 403);
  await done();
});

test('check-in: saves a daily entry, marks body measurements with the day, and reads back', async () => {
  const { app, done } = await setup();
  const res = await put(app, '/api/checkins/2026-03-09', { readiness: 7, energy: 6, mood: 8, stress: 3, nutrition: 7, weight_lbs: 181.2, notes: ' good ' });
  assert.equal(res.statusCode, 200);
  const day = (await app.inject('/api/days/2026-03-09')).json();
  assert.equal(day.checkin.readiness, 7);
  assert.equal(day.checkin.cadence, 'daily');
  assert.equal(day.checkin.source, 'ui');
  assert.equal(day.checkin.body_measured_on, '2026-03-09');
  assert.equal(day.checkin.notes, 'good');
  await done();
});

test('check-in: scales are 1 to 10, empty saves and future dates are refused', async () => {
  const { app, done } = await setup();
  assert.equal((await put(app, '/api/checkins/2026-03-09', { readiness: 11 })).statusCode, 400);
  assert.equal((await put(app, '/api/checkins/2026-03-09', { readiness: 0 })).statusCode, 400);
  assert.match((await put(app, '/api/checkins/2026-03-09', { notes: '' })).json().error, /Nothing to save/);
  assert.match((await put(app, '/api/checkins/2026-03-10', { readiness: 5 })).json().error, /future/);
  assert.equal((await put(app, '/api/checkins/2026-02-30', { readiness: 5 })).statusCode, 400);
  await done();
});

test('check-in: saving over a v1 weekly row makes it a daily UI row', async () => {
  const { app, db, done } = await setup();
  db.prepare("INSERT INTO checkins (date, cadence, readiness, source, updated_at) VALUES ('2026-03-07', 'weekly', 5, 'v1-sheet', 'x')").run();
  await put(app, '/api/checkins/2026-03-07', { readiness: 8 });
  assert.deepEqual(db.prepare("SELECT cadence, readiness, source FROM checkins WHERE date = '2026-03-07'").get(), { cadence: 'daily', readiness: 8, source: 'ui' });
  await done();
});

test('drinking: CBD is stored but never counted as alcohol; zeros are a real no-drink day', async () => {
  const { app, done } = await setup();
  const saved = (await put(app, '/api/drinking/2026-03-08', { beers: 2, wine: 1, cbd: 2, setting: 'Dinner', mood_before: 6, mood_after: 7 })).json();
  assert.equal(saved.alcohol, 3);
  assert.equal(saved.cbd, 2);
  const zero = (await put(app, '/api/drinking/2026-03-09', {})).json();
  assert.equal(zero.alcohol, 0);
  assert.equal(zero.source, 'ui');
  const history = (await app.inject('/api/history?from=2026-03-01&to=2026-03-09')).json();
  assert.deepEqual(history.drinking, [{ date: '2026-03-08', alcohol: 3, cbd: 2 }, { date: '2026-03-09', alcohol: 0, cbd: 0 }]);
  await done();
});

test('drinking: counts are validated and days can be deleted', async () => {
  const { app, done } = await setup();
  assert.equal((await put(app, '/api/drinking/2026-03-08', { beers: -1 })).statusCode, 400);
  assert.equal((await put(app, '/api/drinking/2026-03-08', { mood_after: 12 })).statusCode, 400);
  await put(app, '/api/drinking/2026-03-08', { beers: 1 });
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/drinking/2026-03-08' })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/drinking/2026-03-08' })).statusCode, 404);
  await done();
});

test('history returns metrics, check-ins and drinks in the range', async () => {
  const { app, db, done } = await setup();
  db.prepare("INSERT INTO daily_metrics (date, hrv_ms, resting_hr, sleep_total_hr, steps, updated_at) VALUES ('2026-03-02', 48, 55, 7.2, 8000, 'x'), ('2026-01-01', 40, 60, 6, 5000, 'x')").run();
  const h = (await app.inject('/api/history?from=2026-03-01&to=2026-03-09')).json();
  assert.deepEqual(h.metrics, [{ date: '2026-03-02', hrv_ms: 48, resting_hr: 55, sleep_total_hr: 7.2, steps: 8000 }]);
  assert.equal((await app.inject('/api/history?from=2026-03-09&to=2026-03-01')).statusCode, 400);
  await done();
});

test('prompt sections: create, edit keeps the previous version, delete keeps a copy', async () => {
  const { app, db, done } = await setup();
  const created = await post(app, '/api/prompt/sections', { position: 1, name: 'profile', text: 'Profile on {{TODAY}}.' });
  assert.equal(created.statusCode, 201);
  const { id } = created.json();
  assert.equal((await post(app, '/api/prompt/sections', { position: 2, name: 'profile', text: 'dup' })).statusCode, 409);

  const edited = (await put(app, `/api/prompt/sections/${id}`, { text: 'Profile v2 on {{TODAY}}.' })).json();
  assert.equal(edited.text, 'Profile v2 on {{TODAY}}.');
  assert.deepEqual(db.prepare('SELECT text FROM prompt_section_versions WHERE section_id = ?').all(id), [{ text: 'Profile on {{TODAY}}.' }]);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/prompt/sections/${id}` })).statusCode, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_section_versions WHERE section_id = ?').get(id).n, 2);
  assert.equal((await put(app, `/api/prompt/sections/${id}`, { text: 'x' })).statusCode, 404);
  await done();
});

test('prompt preview: position order, {{TODAY}} filled in, sensitive sections sent every week and named', async () => {
  const { app, done } = await setup();
  await post(app, '/api/prompt/sections', { position: 10, name: 'rules', text: 'Rules.' });
  await post(app, '/api/prompt/sections', { position: 2, name: 'medical', text: 'Medications.', sensitive: true });
  await post(app, '/api/prompt/sections', { position: 1, name: 'profile', text: 'Profile on {{TODAY}}.' });
  const preview = (await app.inject('/api/prompt/preview')).json();
  assert.equal(preview.text, 'Profile on 2026-03-09.\n\nMedications.\n\nRules.');
  assert.deepEqual(preview.included, ['profile', 'medical', 'rules']);
  assert.deepEqual(preview.sensitiveIncluded, ['medical']);
  assert.deepEqual(preview.leftOut, []);
  await done();
});

test('buildInstructions leaves sensitive sections out unless the caller opts in', async () => {
  const { buildInstructions } = await import('../agent/prompts.js');
  const sections = [{ position: 1, name: 'profile', text: 'P' }, { position: 2, name: 'genetics', text: 'G', sensitive: 1 }];
  assert.equal(buildInstructions(sections, '2026-03-09'), 'P');
  assert.equal(buildInstructions(sections, '2026-03-09', { includeSensitive: true }), 'P\n\nG');
});

test('prompt sections: names are restricted and a body is required', async () => {
  const { app, done } = await setup();
  assert.equal((await post(app, '/api/prompt/sections', { position: 1, name: '../x', text: 't' })).statusCode, 400);
  const { id } = (await post(app, '/api/prompt/sections', { position: 1, name: 'a', text: 't' })).json();
  assert.equal((await put(app, `/api/prompt/sections/${id}`, {})).statusCode, 400);
  await done();
});

test('sync: runs the injected sync, reports counts only, and refuses to overlap', async () => {
  let release;
  const sync = () => new Promise((resolve) => { release = () => resolve({ counts: { health_metrics: { upserted: 1 } }, warnings: [{ kind: 'x' }] }); });
  const { app, done } = await setup({ sync });
  const first = app.inject({ method: 'POST', url: '/api/sync' });
  await new Promise((r) => setImmediate(r));
  assert.equal((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode, 409);
  release();
  assert.deepEqual((await first).json(), { counts: { health_metrics: { upserted: 1 } }, warnings: 1 });
  await done();
});

test('settings: Zone 2 range saves, validates order and bounds, and clears with null', async () => {
  const { app, done } = await setup();
  assert.deepEqual((await app.inject('/api/settings')).json(), { zone2_low_bpm: null, zone2_high_bpm: null });
  assert.deepEqual((await put(app, '/api/settings', { zone2_low_bpm: 110, zone2_high_bpm: 125 })).json(), { zone2_low_bpm: 110, zone2_high_bpm: 125 });
  assert.match((await put(app, '/api/settings', { zone2_low_bpm: 130 })).json().error, /below the high end/);
  assert.equal((await put(app, '/api/settings', { zone2_high_bpm: 300 })).statusCode, 400);
  assert.deepEqual((await put(app, '/api/settings', { zone2_low_bpm: null })).json(), { zone2_low_bpm: null, zone2_high_bpm: 125 });
  await done();
});

// ---- medications ----
const MAG = { name: 'Magnesium', kind: 'supplement', dose: '200 mg', timings: ['before_bed'], started_on: '2026-01-10', purpose: 'sleep', prescribed: false };

test('medications: add, change (new period), stop, start again; history is kept', async () => {
  const { app, done } = await setup();
  const added = await post(app, '/api/medications', MAG);
  assert.equal(added.statusCode, 201);
  const { id } = added.json();

  const changed = (await post(app, `/api/medications/${id}/changes`, { dose: '400 mg', timings: ['before_bed', 'morning'], effective_on: '2026-02-01' })).json();
  assert.deepEqual(changed.periods.map((p) => [p.dose, p.started_on, p.stopped_on]), [['200 mg', '2026-01-10', '2026-02-01'], ['400 mg', '2026-02-01', null]]);
  assert.deepEqual(changed.current.timings, ['before_bed', 'morning']);

  const stopped = (await post(app, `/api/medications/${id}/stop`, { stopped_on: '2026-03-01', reason: 'Vivid dreams' })).json();
  assert.equal(stopped.current, null);
  assert.equal(stopped.periods[1].stop_reason, 'Vivid dreams');

  const restarted = (await post(app, `/api/medications/${id}/start`, { dose: '200 mg', timings: ['before_bed'], started_on: '2026-03-05' })).json();
  assert.equal(restarted.periods.length, 3);
  assert.equal(restarted.current.started_on, '2026-03-05');

  const list = (await app.inject('/api/medications')).json();
  assert.deepEqual(list.map((m) => m.name), ['Magnesium']);
  await done();
});

test('medications: a change dated on the current start day corrects it instead of adding a period', async () => {
  const { app, done } = await setup();
  const { id } = (await post(app, '/api/medications', MAG)).json();
  const fixed = (await post(app, `/api/medications/${id}/changes`, { dose: '250 mg', timings: ['before_bed'], effective_on: '2026-01-10' })).json();
  assert.equal(fixed.periods.length, 1);
  assert.equal(fixed.current.dose, '250 mg');
  await done();
});

test('medications: notes and the during-workout slot', async () => {
  const { app, done } = await setup();
  const added = (await post(app, '/api/medications', { name: 'Electrolytes', kind: 'supplement', dose: '1 packet', timings: ['during_workout'], started_on: '2026-03-01', notes: '  With 500 ml water  ' })).json();
  assert.equal(added.notes, 'With 500 ml water');
  assert.deepEqual(added.current.timings, ['during_workout']);
  assert.equal((await put(app, `/api/medications/${added.id}`, { notes: 'Only on lifting days' })).json().notes, 'Only on lifting days');
  assert.equal((await put(app, `/api/medications/${added.id}`, { notes: null })).json().notes, null);

  const day = (await app.inject('/api/days/2026-03-09')).json().medications;
  assert.deepEqual(day.items[0].slots.map((s) => s.timing), ['during_workout']);

  // Re-adding a stopped one without notes leaves its other details alone.
  await post(app, `/api/medications/${added.id}/stop`, { stopped_on: '2026-03-05' });
  await put(app, `/api/medications/${added.id}`, { notes: 'Keep this' });
  const again = (await post(app, '/api/medications', { name: 'Electrolytes', kind: 'supplement', timings: ['during_workout'], started_on: '2026-03-08' })).json();
  assert.equal(again.notes, 'Keep this');
  await done();
});

test('medications: a correction fixes the current dose in place on any day and records no change', async () => {
  const { app, done } = await setup();
  const { id } = (await post(app, '/api/medications', { ...MAG, started_on: '2026-01-01', start_estimated: true })).json();
  const fixed = (await post(app, `/api/medications/${id}/changes`, { dose: '300 mg', timings: ['before_bed'], correction: true })).json();
  assert.deepEqual(fixed.periods.map((p) => [p.dose, p.started_on, p.stopped_on]), [['300 mg', '2026-01-01', null]]);
  assert.deepEqual((await app.inject('/api/medications/impact')).json(), []);
  assert.match((await post(app, `/api/medications/${id}/changes`, { dose: '400 mg', timings: ['before_bed'] })).json().error, /date the change took effect/);
  await done();
});

test('medications: duplicates, overlaps, bad dates and unknown timings are refused', async () => {
  const { app, done } = await setup();
  const { id } = (await post(app, '/api/medications', MAG)).json();
  assert.equal((await post(app, '/api/medications', { ...MAG, name: 'magnesium' })).statusCode, 409, 'names are case-insensitive');
  assert.equal((await post(app, '/api/medications', { ...MAG, name: 'X', timings: ['with lunch'] })).statusCode, 400);
  assert.equal((await post(app, '/api/medications', { ...MAG, name: 'X', timings: [] })).statusCode, 400);
  assert.match((await post(app, '/api/medications', { ...MAG, name: 'X', started_on: '2026-03-10' })).json().error, /future/);
  assert.match((await post(app, `/api/medications/${id}/changes`, { timings: ['daily'], effective_on: '2026-01-01' })).json().error, /before the current period/);
  assert.match((await post(app, `/api/medications/${id}/stop`, { stopped_on: '2026-01-01' })).json().error, /before it started/);
  assert.equal((await post(app, `/api/medications/${id}/start`, { timings: ['daily'], started_on: '2026-03-01' })).statusCode, 409);
  // A past course that overlaps the current one is refused; one before it is accepted.
  assert.equal((await post(app, '/api/medications', { ...MAG, started_on: '2025-12-01', stopped_on: '2026-01-15' })).statusCode, 409);
  const backfilled = (await post(app, '/api/medications', { ...MAG, started_on: '2025-10-01', stopped_on: '2025-11-01' })).json();
  assert.deepEqual(backfilled.periods.map((p) => p.started_on), ['2025-10-01', '2026-01-10']);
  await done();
});

test('medications: at most one open period per medication, enforced by the database', async () => {
  const { app, db, done } = await setup();
  const { id } = (await post(app, '/api/medications', MAG)).json();
  assert.throws(() => db.prepare("INSERT INTO medication_periods (medication_id, timings, started_on, created_at) VALUES (?, '[\"daily\"]', '2026-02-01', 'x')").run(id), /UNIQUE/);
  await done();
});

test('medications: details edit, delete removes all history, impact lists events newest first', async () => {
  const { app, db, done } = await setup();
  const { id } = (await post(app, '/api/medications', MAG)).json();
  await post(app, `/api/medications/${id}/changes`, { dose: '400 mg', timings: ['before_bed'], effective_on: '2026-02-05' });
  assert.equal((await put(app, `/api/medications/${id}`, { prescribed: true, purpose: 'sleep quality' })).json().prescribed, true);

  const impact = (await app.inject('/api/medications/impact')).json();
  assert.deepEqual(impact.map((e) => [e.date, e.type]), [['2026-02-05', 'change'], ['2026-01-10', 'start']]);
  assert.equal(impact[0].impact.status, 'pending', 'the after window runs to Mar 11, past today (Mar 9)');
  assert.equal(impact[1].impact.status, 'complete');
  assert.equal(impact[0].impact.overlapsWith.length, 1);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/medications/${id}` })).statusCode, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM medication_periods').get().n, 0);
  assert.equal((await post(app, `/api/medications/${id}/stop`, { stopped_on: '2026-03-01' })).statusCode, 404);
  await done();
});

test('medications: an unknown start counts as active from that date but creates no start event', async () => {
  const { app, done } = await setup();
  const { id } = (await post(app, '/api/medications', { ...MAG, started_on: '2026-01-01', start_estimated: true })).json();
  const [med] = (await app.inject('/api/medications')).json();
  assert.equal(med.current.start_estimated, true);
  assert.deepEqual((await app.inject('/api/medications/impact')).json(), []);
  await post(app, `/api/medications/${id}/changes`, { dose: '400 mg', timings: ['before_bed'], effective_on: '2026-02-05' });
  assert.deepEqual((await app.inject('/api/medications/impact')).json().map((e) => e.type), ['change'], 'later changes are real events');
  await done();
});

test('daily check-off: lists slots in effect, saves taken and skipped, clears back to not logged', async () => {
  const { app, done } = await setup();
  const mag = (await post(app, '/api/medications', { ...MAG, timings: ['morning', 'before_bed'] })).json();
  const rx = (await post(app, '/api/medications', { name: 'Sample Rx', kind: 'medication', timings: ['morning'], started_on: '2026-03-08', prescribed: true })).json();

  let day = (await app.inject('/api/days/2026-03-07')).json().medications;
  assert.deepEqual(day.items.map((m) => m.name), ['Magnesium'], 'not yet started on Mar 7');
  day = (await app.inject('/api/days/2026-03-09')).json().medications;
  assert.equal(day.saved, false);
  assert.deepEqual(day.items.map((m) => [m.name, m.slots.map((s) => [s.timing, s.taken])]), [
    ['Sample Rx', [['morning', null]]],
    ['Magnesium', [['morning', null], ['before_bed', null]]],
  ]);

  const saved = (await put(app, '/api/doses/2026-03-09', { doses: [
    { medication_id: mag.id, timing: 'morning', taken: true },
    { medication_id: mag.id, timing: 'before_bed', taken: false },
    { medication_id: rx.id, timing: 'morning', taken: true },
  ] })).json();
  assert.equal(saved.saved, true);
  assert.deepEqual(saved.items[1].slots.map((s) => s.taken), [true, false]);

  assert.equal((await put(app, '/api/doses/2026-03-07', { doses: [{ medication_id: rx.id, timing: 'morning', taken: true }] })).statusCode, 400, 'not in effect that day');
  assert.equal((await put(app, '/api/doses/2026-03-09', { doses: [{ medication_id: mag.id, timing: 'afternoon', taken: true }] })).statusCode, 400, 'not one of its slots');
  assert.equal((await put(app, '/api/doses/2026-03-10', { doses: [] })).statusCode, 400, 'no future days');

  assert.equal((await app.inject({ method: 'DELETE', url: '/api/doses/2026-03-09' })).statusCode, 204);
  assert.equal((await app.inject('/api/days/2026-03-09')).json().medications.saved, false);
  await done();
});

test('labs: add results in the app (new and existing tests), edit, delete; sheet results are read-only here', async () => {
  const { app, db, done } = await setup();
  const created = await post(app, '/api/labs/results', { name: 'Homocysteine', panel: 'OTHER', unit: 'umol/L', drawn_on: '2026-03-01', value: '9.5' });
  assert.equal(created.statusCode, 201);
  assert.deepEqual([created.json().value, created.json().value_text, created.json().source], [9.5, '9.5', 'ui']);
  const testId = created.json().test_id;

  assert.equal((await post(app, '/api/labs/results', { test_id: testId, drawn_on: '2026-03-01', value: '10' })).statusCode, 409, 'one result per test and date');
  const text = (await post(app, '/api/labs/results', { test_id: testId, drawn_on: '2026-02-01', value: '<5' })).json();
  assert.deepEqual([text.value, text.value_text], [null, '<5']);
  assert.equal((await post(app, '/api/labs/results', { test_id: testId, drawn_on: '2026-03-10', value: '1' })).statusCode, 400, 'no future dates');

  assert.equal((await put(app, `/api/labs/results/${text.id}`, { value: '6.1' })).json().value, 6.1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/labs/results/${text.id}` })).statusCode, 204);

  db.prepare("INSERT INTO lab_results (test_id, drawn_on, value, value_text, source, updated_at) VALUES (?, '2025-12-01', 8, '8', 'sheet', 'x')").run(testId);
  const sheetId = db.prepare("SELECT id FROM lab_results WHERE source = 'sheet'").get().id;
  assert.match((await app.inject({ method: 'DELETE', url: `/api/labs/results/${sheetId}` })).json().error, /return on the next sync/);
  assert.equal((await post(app, '/api/labs/results', { test_id: testId, drawn_on: '2025-12-01', value: '1' })).json().error.includes('Google Sheet'), true);
  const corrected = (await put(app, `/api/labs/results/${sheetId}`, { value: '7.5' })).json();
  assert.deepEqual([corrected.value, corrected.source, corrected.corrected_from, corrected.corrected_from_date], [7.5, 'ui', '8', '2025-12-01']);
  const again = (await put(app, `/api/labs/results/${sheetId}`, { value: '7.6' })).json();
  assert.equal(again.corrected_from, '8', 'a second correction keeps the original sheet value');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/labs/results/${sheetId}` })).statusCode, 204, 'undo the correction');
  assert.deepEqual(db.prepare('SELECT value_text, source, corrected_from FROM lab_results WHERE id = ?').get(sheetId), { value_text: '8', source: 'sheet', corrected_from: null });

  assert.equal((await put(app, `/api/labs/tests/${testId}`, { unit: 'µmol/L' })).json().unit, 'µmol/L');
  const labs = (await app.inject('/api/labs')).json();
  assert.deepEqual(labs.draws, ['2026-03-01', '2025-12-01']);
  assert.deepEqual(labs.panels.map((p) => [p.panel, p.tests.map((t) => [t.name, t.results.length])]), [['OTHER', [['Homocysteine', 2]]]]);
  await done();
});

test('training: each view returns its bars, totals and breakdowns; planned sets are left out; unknown views are refused', async () => {
  const { app, db, done } = await setup();
  const ex = db.prepare("INSERT INTO strength_exercises (tab_year, row_no, date, exercise) VALUES (2026, ?, ?, ?)");
  const set = db.prepare('INSERT INTO strength_sets (exercise_id, set_no, weight_lbs, per_hand, reps, reps_text) VALUES (?, 1, ?, ?, ?, ?)');
  set.run(ex.run(2, '2026-03-09', 'Squat').lastInsertRowid, 100, 0, 5, '5'); // today
  set.run(ex.run(3, '2026-03-05', 'DB Press').lastInsertRowid, 50, 1, 10, '10');
  set.run(ex.run(4, '2026-03-10', 'Squat').lastInsertRowid, 120, 0, null, null); // planned, after today

  const week = (await app.inject('/api/training?view=week')).json();
  assert.equal(week.buckets.length, 7);
  assert.deepEqual([week.range.from, week.range.to], ['2026-03-03', '2026-03-09']);
  assert.equal(week.totals.volumeLbs, 500 + 1000);
  assert.deepEqual(week.byExercise.map((e) => e.exercise), ['DB Press', 'Barbell Squat']);
  assert.equal((await app.inject('/api/training?view=month')).json().buckets.length, 30);
  assert.equal((await app.inject('/api/training?view=year')).json().buckets.length, 52);
  assert.equal((await app.inject('/api/training?view=2y')).json().buckets.length, 24);
  assert.equal((await app.inject('/api/training?view=5y')).json().buckets.length, 60);
  const all = (await app.inject('/api/training?view=all')).json();
  assert.deepEqual([all.range.from, all.buckets.length, all.previous], ['2026-03-01', 1, null]);
  assert.equal((await app.inject('/api/training?view=decade')).statusCode, 400);
  await done();
});

test('VO2 max: each view returns its points and tiles; unknown views are refused', async () => {
  const { app, db, done } = await setup();
  const add = db.prepare("INSERT INTO daily_metrics (date, vo2max, updated_at) VALUES (?, ?, 'x')");
  add.run('2025-03-05', 40); add.run('2026-03-01', 44); add.run('2026-03-02', 45); add.run('2026-03-10', 99); // last is after today
  db.prepare("INSERT INTO daily_metrics (date, hrv_ms, updated_at) VALUES ('2026-03-03', 50, 'x')").run(); // no VO2 that day

  const y1 = (await app.inject('/api/vo2max?view=1y')).json();
  assert.deepEqual([y1.bucket, y1.points.length, y1.latest, y1.best.value], ['reading', 2, { date: '2026-03-02', value: 45 }, 45]);
  assert.deepEqual(y1.change1y, { value: 5, from: { date: '2025-03-05', value: 40 } });
  assert.equal(y1.change90d, null);
  assert.equal((await app.inject('/api/vo2max?view=2y')).json().bucket, 'week');
  const all = (await app.inject('/api/vo2max?view=all')).json();
  assert.deepEqual([all.bucket, all.range.from, all.points.length], ['month', '2025-03-01', 2]);
  assert.equal((await app.inject('/api/vo2max?view=week')).statusCode, 400);
  assert.equal((await app.inject('/api/vo2max')).statusCode, 400);
  await done();
});

test('status reports today and the last sync run', async () => {
  const { app, db, done } = await setup();
  db.prepare("INSERT INTO runs (name, status, started_at, finished_at, summary) VALUES ('sync', 'ok', '2026-03-09T12:00:00Z', '2026-03-09T12:00:03Z', '{\"counts\":{}}')").run();
  const status = (await app.inject('/api/status')).json();
  assert.equal(status.today, '2026-03-09');
  assert.equal(status.lastSync.status, 'ok');
  await done();
});
