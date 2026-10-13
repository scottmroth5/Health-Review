// Items with ingredients (a compounded pill, a blend) and combining items taken as one pill. Synthetic names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { dayMedications } from '../server/queries.js';
import { medicationNames } from '../metrics/load.js';

const TODAY = new Date(2026, 2, 9, 12, 0); // 2026-03-09

async function setup() {
  const store = openHealthStore(':memory:');
  const app = await buildApp({ store, clock: () => TODAY });
  return { app, db: store.db, done: async () => { await app.close(); store.close(); } };
}
const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });
const add = async (app, body) => {
  const res = await post(app, '/api/medications', body);
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
};

test('ingredients: saved and read back, shown as one line on the Today tab, and validated', async () => {
  const { app, db, done } = await setup();
  const m = await add(app, { name: 'Blend', kind: 'supplement', timings: ['morning'], started_on: '2026-03-01',
    ingredients: [{ name: ' Alpha ', dose: '5 mg' }, { name: 'Beta', dose: '10 mg' }] });
  assert.deepEqual(m.current.ingredients, [{ name: 'Alpha', dose: '5 mg' }, { name: 'Beta', dose: '10 mg' }]);
  assert.equal(m.current.dose, null);
  const [item] = dayMedications(db, '2026-03-05').items;
  assert.deepEqual(item.ingredients, [{ name: 'Alpha', dose: '5 mg' }, { name: 'Beta', dose: '10 mg' }]);
  assert.equal(item.slots[0].defaultDose, 'Alpha 5 mg + Beta 10 mg');

  const both = await post(app, '/api/medications', { name: 'Both', kind: 'supplement', timings: ['daily'], started_on: '2026-03-01', dose: '1 cap', ingredients: [{ name: 'Alpha' }] });
  assert.equal(both.statusCode, 400);
  const twice = await post(app, '/api/medications', { name: 'Twice', kind: 'supplement', timings: ['daily'], started_on: '2026-03-01', ingredients: [{ name: 'Alpha' }, { name: 'alpha' }] });
  assert.equal(twice.statusCode, 400);
  const many = Array.from({ length: 21 }, (_, i) => ({ name: `Part ${i}` }));
  assert.equal((await post(app, '/api/medications', { name: 'Many', kind: 'supplement', timings: ['daily'], started_on: '2026-03-01', ingredients: many })).statusCode, 400);
  await done();
});

test('ingredients: one ingredient changing dose is a dated change that names it; a correction records nothing', async () => {
  const { app, done } = await setup();
  const m = await add(app, { name: 'Pill', kind: 'medication', timings: ['daily'], started_on: '2026-01-05',
    ingredients: [{ name: 'Alpha', dose: '5 mg' }, { name: 'Beta', dose: '10 mg' }] });
  const changed = await post(app, `/api/medications/${m.id}/changes`, { timings: ['daily'], effective_on: '2026-02-01',
    ingredients: [{ name: 'Alpha', dose: '5 mg' }, { name: 'Beta', dose: '20 mg' }] });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().periods.length, 2);
  await post(app, `/api/medications/${m.id}/changes`, { timings: ['daily'], correction: true,
    ingredients: [{ name: 'Alpha', dose: '6 mg' }, { name: 'Beta', dose: '20 mg' }] });
  const events = (await app.inject('/api/medications/impact')).json();
  assert.deepEqual(events.map((e) => [e.date, e.type]), [['2026-02-01', 'change'], ['2026-01-05', 'start']]);
  // The correction rewrote the current period in place, so the 02-01 change now runs to the corrected doses.
  assert.deepEqual(events[0].ingredientChanges, [{ name: 'Alpha', from: '5 mg', to: '6 mg' }, { name: 'Beta', from: '10 mg', to: '20 mg' }]);
  await done();
});

test('medicationNames: medication names plus their ingredients, never supplements', async () => {
  const { app, db, done } = await setup();
  await add(app, { name: 'Pill', kind: 'medication', timings: ['daily'], started_on: '2026-01-05', ingredients: [{ name: 'Alpha', dose: '5 mg' }, { name: 'Beta' }] });
  await add(app, { name: 'Gamma', kind: 'medication', timings: ['daily'], started_on: '2026-01-05', dose: '1 mg' });
  await add(app, { name: 'Blend', kind: 'supplement', timings: ['daily'], started_on: '2026-01-05', ingredients: [{ name: 'Delta' }] });
  assert.deepEqual(medicationNames(db).sort(), ['Alpha', 'Beta', 'Gamma', 'Pill']);
  await done();
});

/** Alpha 10 mg daily since 01-01 (estimated), 20 mg from 02-10; Beta 5 mg before bed since 01-01 (estimated), stopped 03-01. */
async function twoItems(app) {
  const alpha = await add(app, { name: 'Alpha', kind: 'medication', prescribed: true, purpose: 'one', timings: ['daily'], dose: '10 mg', started_on: '2026-01-01', start_estimated: true });
  await post(app, `/api/medications/${alpha.id}/changes`, { timings: ['daily'], dose: '20 mg', effective_on: '2026-02-10' });
  const beta = await add(app, { name: 'Beta', kind: 'medication', purpose: 'two', timings: ['before_bed'], dose: '5 mg', started_on: '2026-01-01', start_estimated: true });
  await post(app, `/api/medications/${beta.id}/stop`, { stopped_on: '2026-03-01', reason: 'done' });
  const put = (date, doses) => app.inject({ method: 'PUT', url: `/api/doses/${date}`, payload: { doses } });
  await put('2026-02-20', [{ medication_id: alpha.id, timing: 'daily', taken: false }, { medication_id: beta.id, timing: 'before_bed', taken: true }]);
  await put('2026-02-21', [{ medication_id: alpha.id, timing: 'daily', taken: true, dose: '15 mg' }, { medication_id: beta.id, timing: 'before_bed', taken: true }]);
  await put('2026-03-02', [{ medication_id: alpha.id, timing: 'daily', taken: true }]);
  return [alpha.id, beta.id];
}

test('combine: the preview shows the plan and changes nothing', async () => {
  const { app, done } = await setup();
  const ids = await twoItems(app);
  const res = await post(app, '/api/medications/combine', { ids, name: 'Alpha + Beta', timing: 'daily', preview: true });
  assert.equal(res.statusCode, 200, res.body);
  const p = res.json();
  assert.equal(p.preview, true);
  assert.deepEqual(p.periods.map((s) => [s.started_on, s.stopped_on, s.ingredients.map((i) => `${i.name} ${i.dose}`).join(' + '), s.start_estimated]), [
    ['2026-01-01', '2026-02-10', 'Alpha 10 mg + Beta 5 mg', true],
    ['2026-02-10', '2026-03-01', 'Alpha 20 mg + Beta 5 mg', false],
    ['2026-03-01', null, 'Alpha 20 mg', false],
  ]);
  assert.equal(p.daysMerged, 3);
  assert.deepEqual(p.daysDisagreeing, ['2026-02-20']);
  assert.equal(p.adjustmentsDropped, 1);
  assert.deepEqual([p.kind, p.prescribed, p.purpose], ['medication', true, 'one; two']);
  assert.equal((await app.inject('/api/medications')).json().length, 2);
  await done();
});

test('combine: one item with the merged history, check-offs taken if any was taken, no false start event', async () => {
  const { app, db, done } = await setup();
  const ids = await twoItems(app);
  const res = await post(app, '/api/medications/combine', { ids, name: 'Alpha + Beta', timing: 'daily' });
  assert.equal(res.statusCode, 200, res.body);
  const list = (await app.inject('/api/medications')).json();
  assert.deepEqual(list.map((m) => m.name), ['Alpha + Beta']);
  assert.equal(list[0].periods.length, 3);
  assert.deepEqual(list[0].current.timings, ['daily']);

  const events = (await app.inject('/api/medications/impact')).json();
  assert.deepEqual(events.map((e) => [e.date, e.type]), [['2026-03-01', 'change'], ['2026-02-10', 'change']]);
  assert.deepEqual(events[0].ingredientChanges, [{ name: 'Beta', from: '5 mg', to: null }]);
  assert.deepEqual(events[1].ingredientChanges, [{ name: 'Alpha', from: '10 mg', to: '20 mg' }]);

  const day = (date) => dayMedications(db, date).items.map((i) => [i.name, i.slots.map((s) => [s.timing, s.taken, s.dose])]);
  assert.deepEqual(day('2026-02-20'), [['Alpha + Beta', [['daily', true, null]]]]);
  assert.deepEqual(day('2026-02-21'), [['Alpha + Beta', [['daily', true, null]]]]);
  assert.deepEqual(day('2026-03-02'), [['Alpha + Beta', [['daily', true, null]]]]);
  assert.equal(db.prepare('SELECT count(*) FROM medication_doses').pluck().get(), 3);
  await done();
});

test('combine: refuses a name used by another item, fewer than two items, and an unknown item', async () => {
  const { app, done } = await setup();
  const ids = await twoItems(app);
  await add(app, { name: 'Gamma', kind: 'supplement', timings: ['daily'], started_on: '2026-03-01', dose: '1 cap' });
  assert.equal((await post(app, '/api/medications/combine', { ids, name: 'gamma', timing: 'daily' })).statusCode, 409);
  assert.equal((await post(app, '/api/medications/combine', { ids: [ids[0]], name: 'X', timing: 'daily' })).statusCode, 400);
  assert.equal((await post(app, '/api/medications/combine', { ids: [ids[0], 999], name: 'X', timing: 'daily' })).statusCode, 404);
  assert.equal((await post(app, '/api/medications/combine', { ids, name: 'Alpha', timing: 'daily', preview: true })).statusCode, 200);
  assert.equal((await app.inject('/api/medications')).json().length, 3);
  await done();
});

test('check-offs by week: current items only, this week so far last, weeks bounded', async () => {
  const { app, done } = await setup(); // today is Monday 2026-03-09
  const a = await add(app, { name: 'Alpha', kind: 'supplement', timings: ['morning'], dose: '1 cap', started_on: '2026-02-01' });
  const b = await add(app, { name: 'Beta', kind: 'supplement', timings: ['morning'], dose: '1 cap', started_on: '2026-02-01' });
  await post(app, `/api/medications/${b.id}/stop`, { stopped_on: '2026-03-01' });
  const put = (date, taken) => app.inject({ method: 'PUT', url: `/api/doses/${date}`, payload: { doses: [{ medication_id: a.id, timing: 'morning', taken }] } });
  await put('2026-03-06', true);
  await put('2026-03-07', false);
  await put('2026-03-09', true);

  const r = (await app.inject('/api/medications/checkoffs?weeks=4')).json();
  assert.deepEqual(r.weekEnds, ['2026-02-21', '2026-02-28', '2026-03-07', '2026-03-14']);
  assert.deepEqual(r.items.map((i) => i.name), ['Alpha']);
  assert.deepEqual(r.items[0].weeks.map((w) => [w.taken, w.logged]), [[0, 0], [0, 0], [1, 2], [1, 1]]);
  assert.equal((await app.inject('/api/medications/checkoffs')).json().weekEnds.length, 12);
  assert.equal((await app.inject('/api/medications/checkoffs?weeks=3')).statusCode, 400);
  assert.equal((await app.inject('/api/medications/checkoffs?weeks=53')).statusCode, 400);
  await done();
});
