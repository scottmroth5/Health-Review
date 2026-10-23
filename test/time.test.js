// The owner's time zone (tools/time.js): every date the app computes uses OWNER_TZ, never the host's zone, so the
// results below are the same whether the suite runs under TZ=UTC or TZ=America/New_York (CI runs both).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerTz, zonedParts, localDate, localStamp, DEFAULT_TZ } from '../tools/time.js';
import { lastWeekEnd } from '../metrics/stats.js';
import { openHealthStore } from '../db/store.js';
import { buildApp } from '../server/app.js';
import { parseWorkoutJson, localStamp as fileStamp } from '../ingest/parsers.js';
import { partialDays } from '../metrics/dataquality.js';

const NY = 'America/New_York';

test('owner time zone: OWNER_TZ, default New York; an unknown zone is refused', () => {
  assert.equal(DEFAULT_TZ, NY);
  assert.equal(ownerTz({}), NY);
  assert.equal(ownerTz({ OWNER_TZ: 'America/Los_Angeles' }), 'America/Los_Angeles');
  assert.throws(() => ownerTz({ OWNER_TZ: 'Mars/Olympus' }), RangeError);
});

test('owner time zone: wall clock across both daylight saving changes', () => {
  // Spring forward, Sun Mar 8 2026: 1:59 EST, then 3:00 EDT.
  assert.equal(localStamp('2026-03-08T06:59:00Z', NY), '2026-03-08T01:59');
  assert.equal(localStamp('2026-03-08T07:00:00Z', NY), '2026-03-08T03:00');
  // Fall back, Sun Nov 1 2026: 1:30 happens twice.
  assert.equal(localStamp('2026-11-01T05:30:00Z', NY), '2026-11-01T01:30');
  assert.equal(localStamp('2026-11-01T06:30:00Z', NY), '2026-11-01T01:30');
  assert.deepEqual(zonedParts('2026-10-25T03:30:00Z', NY), { year: 2026, month: 10, day: 24, hour: 23, minute: 30, second: 0, weekday: 6 });
  assert.equal(localDate('2026-01-01T04:59:00Z', NY), '2025-12-31');
});

test('a Saturday 11:30 pm New York event lands in that review week on a host running in UTC', async () => {
  // Sat Oct 24 2026 23:30 EDT is already Sunday Oct 25 03:30 in UTC.
  const instant = new Date('2026-10-25T03:30:00Z');
  const today = localDate(instant, NY);
  assert.equal(today, '2026-10-24');
  assert.equal(lastWeekEnd(today), '2026-10-17', 'Saturday is still in progress, so the review week is the one before');
  assert.equal(lastWeekEnd(localDate(new Date('2026-10-25T13:00:00Z'), NY)), '2026-10-24', 'Sunday morning reviews the week that just ended');

  // The server's "today" follows the owner's zone, not the host's.
  const store = openHealthStore(':memory:');
  const app = await buildApp({ store, clock: () => instant });
  assert.equal((await app.inject('/api/status')).json().today, '2026-10-24');
  await app.close();

  // A workout exported then keeps its Saturday wall clock, and a file written then marks Saturday partial.
  const { records } = parseWorkoutJson({ data: { workouts: [{ name: 'Outdoor Walk', start: '2026-10-24 23:30:00 -0400', end: '2026-10-24 23:55:00 -0400', duration: 1500 }] } });
  assert.equal(records[0].start, '2026-10-24T23:30:00');
  assert.equal(fileStamp('2026-10-25T03:30:00Z'), '2026-10-24T23:30');
  assert.deepEqual(partialDays([{ date: '2026-10-24', steps: 9000, exported_through: fileStamp('2026-10-25T03:30:00Z') }], '2026-10-24', '2026-10-24'), ['2026-10-24']);
  store.close();
});
