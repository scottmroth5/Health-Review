// Lab reference ranges through the API: typical by default, your own from the lab report, reset, and validation.
// Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOwnerStore } from '../db/store.js';
import { buildApp } from '../server/app.js';

const TODAY = new Date(2026, 2, 9, 12, 0);

test('lab ranges: typical until you set your own; results marked below, within or above; reset and validation', async () => {
  const store = openOwnerStore(':memory:');
  const app = await buildApp({ store, clock: () => TODAY });
  const req = (method, url, payload) => app.inject({ method, url, payload });
  await req('POST', '/api/labs/results', { name: 'Hemoglobin', panel: 'CBC', drawn_on: '2026-03-02', value: '12.9' });
  await req('POST', '/api/labs/results', { name: 'Sample Marker', panel: 'Other', drawn_on: '2026-03-02', value: '5' });
  const find = async (name) => (await app.inject('/api/labs')).json().panels.flatMap((p) => p.tests).find((t) => t.name === name);

  let hgb = await find('Hemoglobin');
  assert.deepEqual(hgb.range, { low: 13.5, high: 17.5, source: 'typical' });
  assert.equal(hgb.results[0].rangeStatus, 'below');
  const other = await find('Sample Marker');
  assert.equal(other.range, null);
  assert.equal(other.results[0].rangeStatus, null);

  assert.equal((await req('PUT', `/api/labs/tests/${hgb.id}`, { ref_low: 12.5, ref_high: 17 })).statusCode, 200);
  hgb = await find('Hemoglobin');
  assert.deepEqual([hgb.range, hgb.results[0].rangeStatus], [{ low: 12.5, high: 17, source: 'yours' }, 'within']);
  assert.deepEqual(hgb.typicalRange.low, 13.5);

  await req('PUT', `/api/labs/tests/${other.id}`, { ref_low: null, ref_high: 4 }); // one-sided
  assert.equal((await find('Sample Marker')).results[0].rangeStatus, 'above');

  await req('PUT', `/api/labs/tests/${hgb.id}`, { reset_range: true });
  assert.equal((await find('Hemoglobin')).range.source, 'typical');
  assert.equal((await req('PUT', `/api/labs/tests/${hgb.id}`, { ref_low: 20, ref_high: 10 })).statusCode, 400);
  assert.equal((await req('PUT', `/api/labs/tests/${hgb.id}`, { ref_low: 'x' })).statusCode, 400);
  await app.close();
  store.close();
});
