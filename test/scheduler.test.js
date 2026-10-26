// The in-app scheduler (server/scheduler.js) and the weekly review job (jobs/review.js). Times are given as instants and
// read in the owner's zone (America/New_York), so these pass whatever the host's zone is (CI runs UTC and New York).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openOwnerStore } from '../db/store.js';
import { createScheduler, lastRun, nextRun, parseSchedule, schedulesFromEnv, CATCH_UP_HOURS } from '../server/scheduler.js';
import { jobRunsLookup as runsLookup } from '../server/admin-queries.js';
import { weeklyReview } from '../jobs/review.js';

const NY = 'America/New_York';
const ny = (iso) => new Date(`${iso}-04:00`); // a New York wall-clock time in daylight saving time
const tick = () => new Promise((r) => setImmediate(r));
const noRuns = { lastRanAt: () => null, isRunning: () => false };

test('schedule specs: day names, groups, monthly days and times; mistakes are errors, not silently off', () => {
  const s = parseSchedule('Sun,Mon,Tue 08:00');
  assert.deepEqual([[...s.days].sort(), s.hour, s.minute], [[0, 1, 2], 8, 0]);
  assert.deepEqual([...parseSchedule('weekdays 7:30').days].sort(), [1, 2, 3, 4, 5]);
  assert.equal(parseSchedule('daily 23:00').days.size, 7);
  assert.deepEqual([parseSchedule('monthly 1 05:00').monthDay, parseSchedule('monthly 1 05:00').hour], [1, 5]);
  for (const bad of ['Mon 25:00', 'Funday 06:00', '06:00', 'daily', '', 'monthly 31 05:00', 'monthly 0 05:00']) {
    assert.throws(() => parseSchedule(bad), /schedule|time|day/, bad);
  }
  const env = { SCHEDULE_SYNC: 'daily 07:00', SCHEDULE_REVIEW: 'Sun,Mon,Tue 08:00', SCHEDULE_BACKUP: ' ', SCHEDULE_RESTORE_TEST: 'monthly 1 05:00' };
  assert.deepEqual(schedulesFromEnv(env).map((j) => j.name), ['sync', 'review', 'restore-test'], 'a missing or blank line is off');
  assert.deepEqual(schedulesFromEnv({}), [], 'no lines, no jobs (the local copy)');
  assert.throws(() => schedulesFromEnv({ SCHEDULE_BACKUP: 'nightly' }), /not a schedule/);
});

test('next and last run times on the owner clock, whatever the host zone, across daylight saving changes', () => {
  const sync = parseSchedule('daily 07:00');
  // 7:00 New York is 11:00 UTC in daylight time and 12:00 UTC in standard time.
  assert.equal(nextRun(sync, ny('2026-10-23T16:00:00'), NY).toISOString(), '2026-10-24T11:00:00.000Z');
  assert.equal(nextRun(sync, new Date('2026-11-01T05:00:00Z'), NY).toISOString(), '2026-11-01T12:00:00.000Z', 'the morning the clocks fall back');
  assert.equal(nextRun(sync, new Date('2026-03-08T06:00:00Z'), NY).toISOString(), '2026-03-08T11:00:00.000Z', 'the morning the clocks spring forward');
  const review = parseSchedule('Sun,Mon,Tue 08:00');
  // Saturday Oct 24, 11:30 pm New York (already Sunday in UTC): next is Sunday 8:00 New York; last was Tuesday Oct 20.
  assert.equal(nextRun(review, ny('2026-10-24T23:30:00'), NY).toISOString(), '2026-10-25T12:00:00.000Z');
  assert.equal(lastRun(review, ny('2026-10-24T23:30:00'), NY).toISOString(), '2026-10-20T12:00:00.000Z');
  // Exactly at the time: that is the last run, and the next is the following one.
  assert.equal(lastRun(review, ny('2026-10-25T08:00:00'), NY).toISOString(), '2026-10-25T12:00:00.000Z');
  assert.equal(nextRun(review, ny('2026-10-25T08:00:00'), NY).toISOString(), '2026-10-26T12:00:00.000Z');
  // Monthly: the 1st at 5:00, a month away.
  const restore = parseSchedule('monthly 1 05:00');
  assert.equal(nextRun(restore, ny('2026-10-23T12:00:00'), NY).toISOString(), '2026-11-01T10:00:00.000Z', 'Nov 1 is already standard time');
  assert.equal(lastRun(restore, ny('2026-10-23T12:00:00'), NY).toISOString(), '2026-10-01T09:00:00.000Z');
});

test('several times in one spec ("|"): the earliest next run and the latest last run of its parts', () => {
  const review = parseSchedule('Sun,Mon,Tue 08:00 | Sun 13:00');
  assert.equal(review.spec, 'Sun,Mon,Tue 08:00 | Sun 13:00');
  assert.equal(review.parts.length, 2);
  // Sunday Oct 25: after 8:00 the next run is 13:00 the same day; after 13:00 it is Monday 8:00.
  assert.equal(nextRun(review, ny('2026-10-25T08:00:00'), NY).toISOString(), '2026-10-25T17:00:00.000Z');
  assert.equal(nextRun(review, ny('2026-10-25T13:00:00'), NY).toISOString(), '2026-10-26T12:00:00.000Z');
  assert.equal(lastRun(review, ny('2026-10-25T14:00:00'), NY).toISOString(), '2026-10-25T17:00:00.000Z');
  assert.equal(lastRun(review, ny('2026-10-25T12:00:00'), NY).toISOString(), '2026-10-25T12:00:00.000Z');
  for (const bad of ['Sun 08:00 |', '| Sun 08:00', 'Sun 08:00 | Funday 13:00']) assert.throws(() => parseSchedule(bad), /schedule|day/, bad);
  assert.equal(schedulesFromEnv({ SCHEDULE_REVIEW: 'Sun,Mon,Tue 08:00 | Sun 13:00' })[0].schedule.parts.length, 2);
});

test('scheduler: runs a due job once, catches up a recently missed run, skips one already done', async () => {
  let clock = ny('2026-10-25T07:59:00');
  const ran = [];
  const runs = { lastRanAt: (name) => ({ review: ny('2026-10-20T08:00:05').toISOString(), backup: ny('2026-10-24T23:00:05').toISOString() })[name], isRunning: () => false };
  const scheduler = createScheduler({
    jobs: [
      { name: 'review', schedule: parseSchedule('Sun,Mon,Tue 08:00'), run: async () => ran.push('review') },
      { name: 'backup', schedule: parseSchedule('daily 23:00'), run: async () => ran.push('backup') },
    ],
    runs, now: () => clock, tz: NY, log: {}, every: () => null,
  });
  scheduler.start();
  await tick();
  assert.deepEqual(ran, [], "nothing missed: last night's backup ran, and the review ran Tuesday");
  clock = ny('2026-10-25T08:00:30');
  scheduler.tick();
  scheduler.tick();
  await tick();
  assert.deepEqual(ran, ['review'], 'due once, not twice');
  assert.equal(scheduler.status().find((j) => j.name === 'review').next, ny('2026-10-26T08:00:00').toISOString());

  // Back at 7:00 after a night off: last night's 23:00 backup was missed (within CATCH_UP_HOURS) and runs now.
  assert.ok(CATCH_UP_HOURS >= 8);
  const late = [];
  createScheduler({
    jobs: [{ name: 'backup', schedule: parseSchedule('daily 23:00'), run: async () => late.push('backup') }],
    runs: { lastRanAt: () => ny('2026-10-23T23:00:00').toISOString(), isRunning: () => false },
    now: () => ny('2026-10-25T07:00:00'), tz: NY, log: {}, every: () => null,
  }).start();
  await tick();
  assert.deepEqual(late, ['backup']);
});

test('scheduler: a job never overlaps itself, here or with a run marked running in the runs table', async () => {
  const store = openOwnerStore(':memory:');
  const lookup = runsLookup(store.db);
  const now = ny('2026-10-25T07:00:10');
  // A sync started 5 minutes ago (Sync now) is still running: the scheduled one is skipped.
  store.db.prepare("INSERT INTO runs (user_id, name, meta, status, started_at) VALUES (@uid, 'sync', '{}', 'running', ?)").run(new Date(now - 5 * 60_000).toISOString());
  assert.equal(lookup.isRunning('sync', now), true);
  assert.equal(lookup.isRunning('sync', new Date(now.getTime() + 40 * 60_000)), false, 'a run left marked running for 30+ minutes never blocks the job');
  const ran = [];
  const s = createScheduler({ jobs: [{ name: 'sync', schedule: parseSchedule('daily 07:00'), run: async () => ran.push('sync') }], runs: lookup, now: () => now, tz: NY, log: {}, every: () => null });
  s.start();
  await tick();
  assert.deepEqual(ran, []);

  // In this process: a slow run is never started twice.
  let release;
  const slow = [];
  const t = createScheduler({ jobs: [{ name: 'backup', schedule: parseSchedule('daily 23:00'), run: () => { slow.push(1); return new Promise((r) => { release = r; }); } }], runs: noRuns, now: () => ny('2026-10-24T23:00:30'), tz: NY, log: {}, every: () => null });
  t.start();
  t.start();
  await tick();
  assert.equal(slow.length, 1);
  release();
  store.close();
});

test('weekly review job: a scheduled catch-up does nothing once the review exists; an incomplete week is skipped with dates only', async () => {
  const store = openOwnerStore(':memory:');
  const claude = () => { throw new Error('no Claude call expected'); };
  store.db.prepare("INSERT INTO reviews (user_id, week_ending, summary_json, report_md, created_at) VALUES (@uid, '2026-10-24', '{}', 'x', 'x')").run();
  const exists = await weeklyReview({ store, claude, today: '2026-10-26', scheduled: true, sync: async () => { throw new Error('no sync expected'); } });
  assert.deepEqual(exists, { status: 'exists', weekEnd: '2026-10-24' });

  // A week with no data of any kind is never sent (no_data).
  const empty = await weeklyReview({ store, claude, today: '2026-10-19', scheduled: true });
  assert.equal(empty.status, 'skipped');
  assert.equal(empty.weekEnd, '2026-10-17');
  assert.equal(empty.reason, 'no_data');
  assert.deepEqual(empty.missingDays, []);

  // With Apple Health days, the missing ones are skipped by date.
  for (const d of ['2026-10-11', '2026-10-12', '2026-10-13']) store.db.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (@uid, ?, 8000, 'x')").run(d);
  const skipped = await weeklyReview({ store, claude, today: '2026-10-19', scheduled: true });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'incomplete');
  assert.deepEqual(skipped.missingDays, ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
  const run = store.db.prepare("SELECT status, summary FROM runs WHERE name = 'review' ORDER BY id DESC").get();
  assert.equal(run.status, 'skipped');
  assert.deepEqual(Object.keys(JSON.parse(run.summary)).sort(), ['missingDays', 'partialDays', 'reason', 'weekEnd']);
  store.close();
});
