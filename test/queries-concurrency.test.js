// Read-then-write sequences in server/queries.js under concurrent calls (v3 Phase 1B slice 4a, docs/adr/0006): each runs
// in one transaction on the async handle, so two requests at once never interleave. Made-up rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLabResult, addMedication, changeMedication, deleteLabResult, saveDoses, saveSettings, stopMedication, updateLabResult } from '../server/queries.js';
import { memoryStore } from './helpers.js';

const MED = { name: 'Sample Statin', kind: 'medication', dose: '5 mg', timings: ['morning', 'evening'], started_on: '2026-03-01' };

/** Every period of the item, oldest first: never two open, never overlapping. */
async function assertValidHistory(adb, id) {
  const periods = await adb.prepare('SELECT started_on, stopped_on FROM medication_periods WHERE user_id = @uid AND medication_id = ? ORDER BY started_on').all(id);
  assert.ok(periods.filter((p) => p.stopped_on === null).length <= 1, 'at most one open period');
  for (let i = 1; i < periods.length; i++) assert.ok(periods[i - 1].stopped_on !== null && periods[i - 1].stopped_on <= periods[i].started_on, 'periods do not overlap');
  return periods;
}

test('two dose saves for one day at once leave one of the two sets, never a mix', async () => {
  const store = await memoryStore();
  try {
    const { db: adb } = store;
    const { id } = await addMedication(adb, MED);
    const a = [{ medication_id: id, timing: 'morning', taken: true }];
    const b = [{ medication_id: id, timing: 'evening', taken: false }, { medication_id: id, timing: 'morning', taken: false }];
    await Promise.all([saveDoses(adb, '2026-03-05', a), saveDoses(adb, '2026-03-05', b)]);
    const rows = await adb.prepare('SELECT timing, taken FROM medication_doses WHERE user_id = @uid AND date = ? ORDER BY timing').all('2026-03-05');
    const asRows = (set) => set.map((d) => ({ timing: d.timing, taken: d.taken ? 1 : 0 })).sort((x, y) => x.timing.localeCompare(y.timing));
    assert.ok([JSON.stringify(asRows(a)), JSON.stringify(asRows(b))].includes(JSON.stringify(rows)), `one save's set: ${JSON.stringify(rows)}`);
  } finally {
    await store.close();
  }
});

test('two dose changes on one medication at once never leave two open periods', async () => {
  const store = await memoryStore();
  try {
    const { db: adb } = store;
    const { id } = await addMedication(adb, MED);
    const results = await Promise.allSettled([
      changeMedication(adb, id, { dose: '10 mg', timings: MED.timings, effective_on: '2026-03-10' }),
      changeMedication(adb, id, { dose: '20 mg', timings: MED.timings, effective_on: '2026-03-12' }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
    const periods = await assertValidHistory(adb, id);
    assert.deepEqual(periods.map((p) => p.started_on), ['2026-03-01', '2026-03-10', '2026-03-12']);
  } finally {
    await store.close();
  }
});

test('a stop racing a change leaves a valid history; the loser is refused, not half-applied', async () => {
  const store = await memoryStore();
  try {
    const { db: adb } = store;
    const { id } = await addMedication(adb, MED);
    const [stop, change] = await Promise.allSettled([
      stopMedication(adb, id, { stopped_on: '2026-03-15', reason: 'made up' }),
      changeMedication(adb, id, { dose: '10 mg', timings: MED.timings, effective_on: '2026-03-10' }),
    ]);
    assert.equal(stop.status, 'fulfilled');
    assert.equal(change.status, 'rejected');
    assert.equal(change.reason.statusCode, 409, 'no longer taken once stopped');
    const periods = await assertValidHistory(adb, id);
    assert.deepEqual(periods, [{ started_on: '2026-03-01', stopped_on: '2026-03-15' }]);
  } finally {
    await store.close();
  }
});

test('a lab correction racing a delete leaves the result corrected or gone, never half-done', async () => {
  const store = await memoryStore();
  try {
    const { db: adb } = store;
    const { id } = await addLabResult(adb, { name: 'Sample Marker', drawn_on: '2026-03-05', value: '5' });
    const [update, remove] = await Promise.allSettled([updateLabResult(adb, id, { value: '6' }), deleteLabResult(adb, id)]);
    const row = await adb.prepare('SELECT value_text, source FROM lab_results WHERE user_id = @uid AND id = ?').get(id);
    assert.equal(update.status, 'fulfilled');
    assert.equal(remove.status, 'fulfilled');
    assert.equal(row, undefined, 'corrected, then deleted');
    const [removeFirst, updateAfter] = await Promise.allSettled([
      deleteLabResult(adb, (await addLabResult(adb, { name: 'Sample Marker', drawn_on: '2026-03-06', value: '5' })).id),
      updateLabResult(adb, id, { value: '7' }),
    ]);
    assert.equal(removeFirst.status, 'fulfilled');
    assert.equal(updateAfter.reason?.statusCode, 404, 'a deleted result is not found, never recreated');
  } finally {
    await store.close();
  }
});

test('two zone saves at once cannot pass the order check together', async () => {
  const store = await memoryStore();
  try {
    const { db: adb } = store;
    await saveSettings(adb, { zone2_low_bpm: 110, zone2_high_bpm: 125, zone3_high_bpm: 140 });
    // Each is fine against the stored zones; together they would put Zone 2's top above Zone 3's.
    const ordered = (next) => { if (next.zone2_high_bpm >= next.zone3_high_bpm) throw Object.assign(new Error('out of order'), { statusCode: 400 }); };
    const results = await Promise.allSettled([
      saveSettings(adb, { zone2_high_bpm: 135 }, { check: ordered }),
      saveSettings(adb, { zone3_high_bpm: 130 }, { check: ordered }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
    const s = await adb.prepare("SELECT key, value FROM settings WHERE user_id = @uid AND key LIKE 'zone%' ORDER BY key").all();
    assert.deepEqual(Object.fromEntries(s.map((r) => [r.key, Number(r.value)])), { zone2_high_bpm: 135, zone2_low_bpm: 110, zone3_high_bpm: 140 });
  } finally {
    await store.close();
  }
});
