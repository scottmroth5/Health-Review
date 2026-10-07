import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { runSync } from '../ingest/sync.js';
import { fakeSource, serial, silentLogger } from './helpers.js';

const HEALTH = ['Date/Time', 'Heart Rate Variability (ms)', 'Resting Heart Rate (bpm)', 'Step Count (steps)'];
const SESSIONS = ['Type', 'Start', 'End', 'Duration', 'Avg Heart Rate (bpm)'];
const LOG = ['Date', 'Prime', 'Exercise', 'Weight 1', 'Set 1', 'Weight 2', 'Set 2', 'Post', 'Workout', 'Comment'];
const DRINKS = ['Date', 'Number of Beers', 'Number of glasses of wine', 'Number of glasses of bourbon', 'Other Mixed Drink', 'Total Drinks', 'Setting', 'Mood before Drinking (1-10)', 'Mood After Drinking (1-10)', 'Notes'];
const CHECKIN = ['Week Ending (Saturday) ', 'Morning Readiness (1-10)', 'Avg Energy (1-10)', 'Avg Mood (1-10)', 'Stress Level (1-10)', 'Nutrition Quality (1-10)', 'Notes'];

const day = (d, hrv, rhr, steps) => [serial(d, 3), hrv, rhr, steps];
const NOW = new Date(2026, 2, 9, 7, 0); // local 2026-03-09
// The sparse fake sheets trip the post-sync data checks (their own tests are below); most tests look at import warnings only.
const importWarnings = (warnings) => warnings.filter((w) => w.source !== 'data_check');

function sheets() {
  return {
    health_metrics: { Sheet1: [HEALTH, day('2026-03-01', 45, 56, 7000), day('2026-03-02', 48, 55, 8000)], Last7Days: [HEALTH] },
    workout_sessions: { Sheet1: [SESSIONS, ['Outdoor Run', serial('2026-03-02', 6, 15), serial('2026-03-02', 6, 52, 30), 37.5 / 1440, 148]] },
    workout_log: {
      2025: [LOG, [serial('2025-12-29'), '', 'Squat', 135, 5]],
      2026: [LOG, [serial('2026-03-02'), 'A1', 'Squat', 185, 5, 205, 3, '', 'Legs A'], ['', 'A2', 'Plank', '', ':45']],
      Last28Days: [LOG],
      backup: [LOG, [serial('2026-01-01'), '', 'Old', 1, 1]],
    },
    drinking_log: { Sheet1: [DRINKS, [serial('2026-03-06'), 2, 1, 0, 0, 3, 'Dinner', 7, 8, ''], [serial('2026-03-07'), 0, 0, 0, 0, 0]] },
    weekly_checkin: { Sheet1: [CHECKIN, [serial('2026-03-07'), 7, 6, 8, 4, 7, 'fine']] },
  };
}

const open = () => openHealthStore(':memory:');
const sync = (store, source, opts = {}) => runSync({ store, source, now: NOW, logger: silentLogger, catalog: null, ...opts });
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('backfill imports every source, all year tabs, and skips filtered and backup tabs', async () => {
  const store = open();
  const { counts, warnings } = await sync(store, fakeSource(sheets()), { backfill: true });
  assert.deepEqual(importWarnings(warnings), []);
  assert.equal(count(store, 'daily_metrics'), 2);
  assert.equal(count(store, 'workout_sessions'), 1);
  assert.deepEqual(store.db.prepare('SELECT tab_year, COUNT(*) AS n FROM strength_exercises GROUP BY tab_year').all(), [
    { tab_year: 2025, n: 1 }, { tab_year: 2026, n: 2 },
  ]);
  assert.equal(count(store, 'strength_sets'), 4);
  assert.equal(count(store, 'drinking_days'), 2);
  assert.equal(count(store, 'checkins'), 1);
  assert.equal(counts.workout_log.tabsRead, 2);
  store.close();
});

test('every sync reads the whole first tab, so new rows anywhere are picked up', async () => {
  const store = open();
  const data = sheets();
  const source = fakeSource(data);
  await sync(store, source, { backfill: true });

  data.health_metrics.Sheet1.push(day('2026-03-03', 50, 54, 9000));
  source.reads.length = 0;
  const { counts } = await sync(store, source);

  assert.deepEqual(source.reads.find((r) => r.source === 'health_metrics'), { source: 'health_metrics', tab: 'Sheet1', fromRow: 2 });
  assert.equal(counts.health_metrics.rowsRead, 3);
  assert.equal(store.db.prepare("SELECT hrv_ms FROM daily_metrics WHERE date = '2026-03-03'").get().hrv_ms, 50);
  assert.equal(counts.drinking_log, undefined, 'drinking log is only read on backfill');
  store.close();
});

test('duplicate health days: the row with the most steps is kept, its gaps filled from the other rows', async () => {
  const store = open();
  const data = sheets();
  data.health_metrics.Sheet1.push([serial('2026-03-03', 3), 44, '', 3200]); // the only row with steps
  data.health_metrics.Sheet1.push([serial('2026-03-03', 3), 49, 54, '']); // later export missing steps
  await sync(store, fakeSource(data), { backfill: true });
  assert.deepEqual(store.db.prepare("SELECT hrv_ms, resting_hr, steps FROM daily_metrics WHERE date = '2026-03-03'").get(), { hrv_ms: 44, resting_hr: 54, steps: 3200 });
  assert.equal(count(store, 'daily_metrics'), 3);
  store.close();
});

test('a partial export appended after the full day never replaces it (v1 duplicate rows)', async () => {
  const store = open();
  const data = sheets();
  data.health_metrics.Sheet1.push(day('2026-03-03', 47, 55, 6000)); // the full day
  data.health_metrics.Sheet1.push(day('2026-03-03', 52, 58, 400)); // a run made early in the day, appended later
  await sync(store, fakeSource(data));
  assert.deepEqual(store.db.prepare("SELECT hrv_ms, resting_hr, steps FROM daily_metrics WHERE date = '2026-03-03'").get(), { hrv_ms: 47, resting_hr: 55, steps: 6000 });
  // When the full day only arrives on a later sync, it replaces the partial one stored before.
  data.health_metrics.Sheet1.push(day('2026-03-04', 50, 56, 4000));
  await sync(store, fakeSource(data));
  data.health_metrics.Sheet1.push(day('2026-03-04', 49, 55, 11000));
  await sync(store, fakeSource(data));
  assert.equal(store.db.prepare("SELECT steps FROM daily_metrics WHERE date = '2026-03-04'").get().steps, 11000);
  store.close();
});

test('after a sync, data checks flag stale Apple Health data; days with several rows are noted by date', async () => {
  const store = open();
  const data = sheets(); // health rows end on 2026-03-02; the sync runs on 2026-03-09
  data.health_metrics.Sheet1.push(day('2026-03-02', 52, 58, 400));
  const { counts, warnings } = await sync(store, fakeSource(data));
  const stale = warnings.find((w) => w.kind === 'health_stale');
  assert.equal(stale.source, 'data_check');
  assert.equal(stale.detail, 'No Apple Health data after Mar 2 (6 days missing so far). Check the Health Auto Export automation.');
  assert.ok(counts.data_checks.warn >= 1);
  const several = warnings.find((w) => w.kind === 'several rows for one day');
  assert.equal(several.detail, '1 day(s) had more than one row (the app keeps the fullest): 2026-03-02');
  store.close();
});

test('backfill reads the Archive tab too, so a day split across it and the data tab keeps the full row', async () => {
  const store = open();
  const data = sheets();
  data.health_metrics.Archive = [HEALTH, day('2026-02-20', 46, 55, 15000)];
  data.health_metrics.Sheet1.push(day('2026-02-20', 51, 57, 9000));
  await sync(store, fakeSource(data)); // the daily sync reads the data tab only
  assert.equal(store.db.prepare("SELECT steps FROM daily_metrics WHERE date = '2026-02-20'").get().steps, 9000);
  await sync(store, fakeSource(data), { backfill: true });
  assert.equal(store.db.prepare("SELECT steps FROM daily_metrics WHERE date = '2026-02-20'").get().steps, 15000);
  store.close();
});

test('exact duplicate workout sessions are stored once', async () => {
  const store = open();
  const data = sheets();
  data.workout_sessions.Sheet1.push([...data.workout_sessions.Sheet1[1]]);
  await sync(store, fakeSource(data), { backfill: true });
  assert.equal(count(store, 'workout_sessions'), 1);
  store.close();
});

test('rows archived off the tab stay in the database; a trimmed tab that grows again loses nothing', async () => {
  const store = open();
  const data = sheets();
  for (let i = 3; i <= 20; i++) data.health_metrics.Sheet1.push(day(`2026-02-${String(i).padStart(2, '0')}`, 40 + i, 60, 5000));
  const source = fakeSource(data);
  await sync(store, source, { backfill: true });
  const before = count(store, 'daily_metrics');

  // Archived down to one row, then refilled past the old length before the next sync.
  data.health_metrics.Sheet1 = [HEALTH, day('2026-03-05', 51, 53, 9500)];
  for (let i = 1; i <= 25; i++) data.health_metrics.Sheet1.push(day(`2026-04-${String(i).padStart(2, '0')}`, 45, 55, 6000));
  await sync(store, source);

  assert.equal(count(store, 'daily_metrics'), before + 26);
  assert.equal(store.db.prepare("SELECT hrv_ms FROM daily_metrics WHERE date = '2026-03-05'").get().hrv_ms, 51);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM daily_metrics WHERE date LIKE '2026-02-%'").get().n, 18, 'archived days kept');
  store.close();
});

test('Workout Log: unchanged tabs are skipped, edited tabs replaced, deleted rows removed', async () => {
  const store = open();
  const data = sheets();
  const source = fakeSource(data);
  await sync(store, source, { backfill: true });

  let { counts } = await sync(store, source);
  assert.deepEqual([counts.workout_log.tabsRead, counts.workout_log.tabsReplaced], [1, 0], 'only the current year is read, and it is unchanged');

  data.workout_log['2026'][1][3] = 190; // edit a weight
  data.workout_log['2026'].pop(); // delete the plank row
  ({ counts } = await sync(store, source));
  assert.equal(counts.workout_log.tabsReplaced, 1);
  const rows = store.db.prepare('SELECT e.exercise, s.set_no, s.weight_lbs FROM strength_exercises e JOIN strength_sets s ON s.exercise_id = e.id WHERE e.tab_year = 2026 ORDER BY s.set_no').all();
  assert.deepEqual(rows, [{ exercise: 'Squat', set_no: 1, weight_lbs: 190 }, { exercise: 'Squat', set_no: 2, weight_lbs: 205 }]);
  assert.equal(count(store, 'strength_sets'), 3, 'the plank set is gone and 2025 is untouched');
  store.close();
});

test('Workout Log: in January the previous year tab is synced too', async () => {
  const store = open();
  const source = fakeSource(sheets());
  const { counts } = await sync(store, source, { now: new Date(2026, 0, 10) });
  assert.equal(counts.workout_log.tabsRead, 2);
  store.close();
});

test('backfill never overwrites drinking days or check-ins entered in the UI', async () => {
  const store = open();
  store.db.prepare("INSERT INTO drinking_days (date, beers, source, updated_at) VALUES ('2026-03-06', 5, 'ui', 'x')").run();
  store.db.prepare("INSERT INTO checkins (date, cadence, readiness, source, updated_at) VALUES ('2026-03-07', 'daily', 9, 'ui', 'x')").run();
  const { counts } = await sync(store, fakeSource(sheets()), { backfill: true });
  assert.equal(store.db.prepare("SELECT beers FROM drinking_days WHERE date = '2026-03-06'").get().beers, 5);
  assert.equal(store.db.prepare("SELECT readiness FROM checkins WHERE date = '2026-03-07'").get().readiness, 9);
  assert.deepEqual([counts.drinking_log.imported, counts.drinking_log.keptFromUi], [1, 1]);
  assert.deepEqual([counts.weekly_checkin.imported, counts.weekly_checkin.keptFromUi], [0, 1]);
  store.close();
});

test('each sync is recorded as a run with counts only', async () => {
  const store = open();
  await sync(store, fakeSource(sheets()), { backfill: true });
  const run = store.db.prepare("SELECT name, status, meta, summary FROM runs WHERE name = 'sync'").get();
  assert.equal(run.status, 'ok');
  assert.deepEqual(JSON.parse(run.meta), { backfill: true });
  const summary = JSON.parse(run.summary);
  assert.equal(summary.counts.health_metrics.upserted, 2);
  assert.doesNotMatch(run.summary, /Dinner|Squat|fine/, 'no cell text in the run record');
  store.close();
});

test('a failed sync is recorded as an error run and rethrown', async () => {
  const store = open();
  const data = sheets();
  data.health_metrics.Sheet1[0] = ['When', 'HRV'];
  await assert.rejects(sync(store, fakeSource(data), { backfill: true }), /no "Date\/Time" column/);
  assert.equal(store.db.prepare("SELECT status FROM runs WHERE name = 'sync'").get().status, 'error');
  store.close();
});

// ---- labs ----
const LAB = () => [
  ['Lab Test', serial('2026-03-23'), serial('2025-09-15')],
  ['LIPID PANEL'],
  ['Cholesterol', 165, 180],
  ['LDL Calculated', 84, 95],
  [],
  ['OTHER'],
  ['PSA', 0.6, 0.7],
];
const withLabs = (lab) => ({ ...sheets(), lab_results: { Notes: [['Something else']], Labs: lab } });

test('labs: imported from the tab headed "Lab Test"; unchanged sheets are not rewritten', async () => {
  const store = open();
  const source = fakeSource(withLabs(LAB()));
  const { counts } = await sync(store, source);
  assert.deepEqual(counts.lab_results, { tab: 'Labs', changed: true, tests: 3, draws: 2, results: 6, keptFromApp: 0 });
  assert.deepEqual(store.db.prepare('SELECT name, panel, position FROM lab_tests ORDER BY position').all().map((t) => [t.name, t.panel, t.position]), [
    ['Cholesterol', 'LIPID PANEL', 1], ['LDL Calculated', 'LIPID PANEL', 2], ['PSA', 'OTHER', 3],
  ]);
  assert.deepEqual((await sync(store, source)).counts.lab_results, { tab: 'Labs', changed: false });
  store.close();
});

test('labs: edits and removed draw columns are reflected; app results are kept and win a clash', async () => {
  const store = open();
  const data = withLabs(LAB());
  const source = fakeSource(data);
  await sync(store, source);
  const psa = store.db.prepare("SELECT id FROM lab_tests WHERE name = 'PSA'").get().id;
  store.db.prepare("INSERT INTO lab_results (test_id, drawn_on, value, value_text, source, updated_at) VALUES (?, '2026-06-01', 0.9, '0.9', 'ui', 'x')").run(psa);
  store.db.prepare("UPDATE lab_results SET value = 5, value_text = '5', source = 'ui' WHERE test_id = ? AND drawn_on = '2026-03-23'").run(psa);

  data.lab_results.Labs = LAB().map((row) => row.slice(0, 2)); // drop the 2025 column
  data.lab_results.Labs[2][1] = 170; // edit cholesterol
  const { counts, warnings } = await sync(store, source);
  assert.equal(counts.lab_results.keptFromApp, 1);
  assert.deepEqual(importWarnings(warnings).map((w) => w.kind), ['app value kept over a different sheet value']);
  const rows = store.db.prepare('SELECT t.name, r.drawn_on, r.value, r.source FROM lab_results r JOIN lab_tests t ON t.id = r.test_id ORDER BY t.position, r.drawn_on').all();
  assert.deepEqual(rows.map((r) => [r.name, r.drawn_on, r.value, r.source]), [
    ['Cholesterol', '2026-03-23', 170, 'sheet'],
    ['LDL Calculated', '2026-03-23', 84, 'sheet'],
    ['PSA', '2026-03-23', 5, 'ui'],
    ['PSA', '2026-06-01', 0.9, 'ui'],
  ]);
  store.close();
});

test('labs: without a lab sheet ID the sync skips labs and carries on', async () => {
  const store = open();
  const { counts } = await sync(store, fakeSource(sheets()));
  assert.match(counts.lab_results.skipped, /no lab sheet/);
  assert.equal(count(store, 'daily_metrics'), 2);
  store.close();
});

test('labs: a sheet result corrected in the app (value or date) is kept by sync, with no duplicate and no warning', async () => {
  const store = open();
  const data = withLabs(LAB());
  const source = fakeSource(data);
  await sync(store, source);
  const { updateLabResult, deleteLabResult } = await import('../server/queries.js');
  const row = (name, date) => store.db.prepare('SELECT r.* FROM lab_results r JOIN lab_tests t ON t.id = r.test_id WHERE t.name = ? AND r.drawn_on = ?').get(name, date);

  updateLabResult(store.db, row('PSA', '2026-03-23').id, { value: '0.9' }); // value fix
  updateLabResult(store.db, row('Cholesterol', '2025-09-15').id, { drawn_on: '2025-09-16' }); // date fix
  data.lab_results.Labs[2][1] = 171; // the sheet changes, so sync runs
  const { counts, warnings } = await sync(store, source);
  assert.deepEqual(importWarnings(warnings), []);
  assert.equal(counts.lab_results.keptFromApp, 2);
  assert.deepEqual([row('PSA', '2026-03-23').value_text, row('PSA', '2026-03-23').corrected_from], ['0.9', '0.6']);
  assert.equal(row('Cholesterol', '2025-09-15'), undefined, 'the sheet copy is not re-added under the old date');
  assert.equal(row('Cholesterol', '2025-09-16').corrected_from_date, '2025-09-15');

  // Undoing a correction brings the sheet value back on the next sync.
  deleteLabResult(store.db, row('PSA', '2026-03-23').id);
  data.lab_results.Labs[2][1] = 165;
  await sync(store, source);
  assert.deepEqual([row('PSA', '2026-03-23').value_text, row('PSA', '2026-03-23').source], ['0.6', 'sheet']);
  store.close();
});

test('raw sheets sync from the first tab, whatever it is named; other tabs are ignored', async () => {
  const store = open();
  const data = sheets();
  data.health_metrics = {
    'Consolidated Health': [HEALTH, day('2026-03-01', 45, 56, 7000), day('2026-03-02', 48, 55, 8000)],
    Archive: [HEALTH, day('2025-01-01', 30, 70, 100)],
    Last7Days: [HEALTH],
  };
  const source = fakeSource(data);
  await sync(store, source);
  assert.deepEqual([...new Set(source.reads.filter((r) => r.source === 'health_metrics').map((r) => r.tab))], ['Consolidated Health']);
  assert.deepEqual(store.db.prepare('SELECT date FROM daily_metrics ORDER BY date').all().map((r) => r.date), ['2026-03-01', '2026-03-02']);
  store.close();
});

test('a renamed first tab duplicates nothing and replaces the old sync state', async () => {
  const store = open();
  const data = sheets();
  for (let i = 3; i <= 20; i++) data.health_metrics.Sheet1.push(day(`2026-02-${String(i).padStart(2, '0')}`, 40 + i, 60, 5000));
  const source = fakeSource(data);
  await sync(store, source, { backfill: true });
  const daysBefore = count(store, 'daily_metrics');
  const sessionsBefore = count(store, 'workout_sessions');

  // The owner renames the data tabs and adds an archive after them.
  const rename = (s, name) => { data[s] = { [name]: data[s].Sheet1, Archive: [data[s].Sheet1[0]] }; };
  rename('health_metrics', 'Consolidated Health');
  rename('workout_sessions', 'Consolidated Sessions');
  data.health_metrics['Consolidated Health'].push(day('2026-03-03', 50, 54, 9000));

  await sync(store, source);
  await sync(store, source);
  assert.equal(count(store, 'daily_metrics'), daysBefore + 1);
  assert.equal(count(store, 'workout_sessions'), sessionsBefore);
  assert.deepEqual(store.db.prepare("SELECT tab FROM sync_state WHERE source IN ('health_metrics', 'workout_sessions') ORDER BY source").all().map((r) => r.tab),
    ['Consolidated Health', 'Consolidated Sessions']);
  store.close();
});
