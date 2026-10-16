import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { runSync } from '../ingest/sync.js';
import { buildApp } from '../server/app.js';
import { fakeSource, serial, silentLogger } from './helpers.js';

const HEALTH = ['Date/Time', 'Heart Rate Variability (ms)', 'Resting Heart Rate (bpm)', 'Step Count (steps)'];
const SESSIONS = ['Type', 'Start', 'End', 'Duration', 'Avg Heart Rate (bpm)'];
const LOG = ['Date', 'Prime', 'Exercise', 'Weight 1', 'Set 1', 'Weight 2', 'Set 2', 'Post', 'Workout', 'Comment'];
const DRINKS = ['Date', 'Number of Beers', 'Number of glasses of wine', 'Number of glasses of bourbon', 'Other Mixed Drink', 'Total Drinks', 'Setting', 'Mood before Drinking (1-10)', 'Mood After Drinking (1-10)', 'Notes'];
const CHECKIN = ['Week Ending (Saturday) ', 'Morning Readiness (1-10)', 'Avg Energy (1-10)', 'Avg Mood (1-10)', 'Stress Level (1-10)', 'Nutrition Quality (1-10)', 'Notes'];

const day = (d, hrv, rhr, steps) => [serial(d, 3), hrv, rhr, steps];
const NOW = new Date(2026, 2, 9, 7, 0); // local 2026-03-09
// The sparse fake data trips the post-sync data checks (their own tests are below); most tests look at import warnings only.
// Data checks and the exercise-name typo count run after every import; tests of the import itself leave them out.
const importWarnings = (warnings) => warnings.filter((w) => w.source !== 'data_check' && w.source !== 'exercise_names');

// Apple Health comes from Health Auto Export's files in two Drive folders (HEALTH_EXPORT_FOLDER_ID, WORKOUT_EXPORT_FOLDER_ID).
const HF = 'health-folder';
const WF = 'workout-folder';
const healthFile = (id, name, values, modifiedTime = '2026-03-02T09:00:00Z') => ({ folder: HF, id, name: `Apple Health Metrics-HealthMetrics-${name}`, modifiedTime, values });
const workoutFile = (id, name, values, modifiedTime = '2026-03-02T09:00:00Z') => ({ folder: WF, id, name: `Workout session metrics-${name}`, modifiedTime, values });
const walk = [SESSIONS, ['Outdoor Walk', serial('2026-03-02', 18), serial('2026-03-02', 18, 30), 30 / 1440, 110]];
const both = { health: HF, workouts: WF };
const RUN = ['Outdoor Run', serial('2026-03-02', 6, 15), serial('2026-03-02', 6, 52, 30), 37.5 / 1440, 148];

/** The Google Sheets that are still read: the Workout Log, and the drinking log and check-ins (backfill only). */
function sheets() {
  return {
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

/** The sheets plus two health day files and one workout file. */
function source(data = sheets()) {
  const s = fakeSource(data);
  s.exports = [
    healthFile('d1', '2026-03-01', [HEALTH, day('2026-03-01', 45, 56, 7000)]),
    healthFile('d2', '2026-03-02', [HEALTH, day('2026-03-02', 48, 55, 8000)]),
    workoutFile('r1', '2026-03-02', [SESSIONS, RUN]),
  ];
  return s;
}

const open = () => openHealthStore(':memory:');
const sync = (store, src, opts = {}) => runSync({ store, source: src, now: NOW, logger: silentLogger, catalog: null, exportFolders: both, ...opts });
const count = (store, table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('backfill imports every source, all year tabs, and skips filtered and backup tabs', async () => {
  const store = open();
  const { counts, warnings } = await sync(store, source(), { backfill: true });
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

test('a normal sync reads only new or changed export files; the drinking log is read on backfill only', async () => {
  const store = open();
  const src = source();
  await sync(store, src, { backfill: true });
  src.exports.push(healthFile('d3', '2026-03-03', [HEALTH, day('2026-03-03', 50, 54, 9000)], '2026-03-04T09:00:00Z'));
  src.reads.length = 0;
  const { counts } = await sync(store, src);
  assert.deepEqual(src.reads.filter((r) => r.file), [{ file: 'd3' }]);
  assert.deepEqual([counts.health_exports.filesRead, counts.workout_exports.filesRead], [1, 0]);
  assert.equal(store.db.prepare("SELECT hrv_ms FROM daily_metrics WHERE date = '2026-03-03'").get().hrv_ms, 50);
  assert.equal(counts.drinking_log, undefined, 'drinking log is only read on backfill');
  store.close();
});

test('the retired consolidated sheets are never read; a missing folder variable skips that kind with a warning', async () => {
  const store = open();
  const src = source();
  const { counts, warnings } = await sync(store, src, { exportFolders: { health: HF, workouts: null } });
  assert.equal(counts.health_exports.filesRead, 2);
  assert.equal(counts.workout_exports, undefined);
  assert.equal(count(store, 'workout_sessions'), 0);
  assert.deepEqual(importWarnings(warnings).map((w) => [w.source, w.detail, w.severity]),
    [['workout_exports', 'WORKOUT_EXPORT_FOLDER_ID is not set, so Apple Watch workouts were not synced', 'warn']]);
  const none = await sync(store, src, { exportFolders: {} });
  assert.deepEqual(importWarnings(none.warnings).map((w) => w.detail), [
    'HEALTH_EXPORT_FOLDER_ID is not set, so Apple Health metrics were not synced',
    'WORKOUT_EXPORT_FOLDER_ID is not set, so Apple Watch workouts were not synced',
  ]);
  assert.ok(!src.reads.some((r) => r.source === 'health_metrics' || r.source === 'workout_sessions'));
  store.close();
});

test('after a sync, data checks flag stale Apple Health data', async () => {
  const store = open();
  const { counts, warnings } = await sync(store, source()); // health days end on 2026-03-02; the sync runs on 2026-03-09
  const stale = warnings.find((w) => w.kind === 'health_stale');
  assert.equal(stale.source, 'data_check');
  assert.equal(stale.detail, 'No Apple Health data after Mar 2 (6 days missing so far). Check the Health Auto Export automation.');
  assert.ok(counts.data_checks.warn >= 1);
  store.close();
});

test('exact duplicate workout sessions are stored once', async () => {
  const store = open();
  const src = source();
  src.exports.push(workoutFile('r2', '2026-03-02-again', [SESSIONS, [...RUN]]));
  await sync(store, src, { backfill: true });
  assert.equal(count(store, 'workout_sessions'), 1);
  store.close();
});

test('Workout Log: unchanged tabs are skipped, edited tabs replaced, deleted rows removed', async () => {
  const store = open();
  const data = sheets();
  const src = source(data);
  await sync(store, src, { backfill: true });

  let { counts } = await sync(store, src);
  assert.deepEqual([counts.workout_log.tabsRead, counts.workout_log.tabsReplaced], [1, 0], 'only the current year is read, and it is unchanged');

  data.workout_log['2026'][1][3] = 190; // edit a weight
  data.workout_log['2026'].pop(); // delete the plank row
  ({ counts } = await sync(store, src));
  assert.equal(counts.workout_log.tabsReplaced, 1);
  const rows = store.db.prepare('SELECT e.exercise, s.set_no, s.weight_lbs FROM strength_exercises e JOIN strength_sets s ON s.exercise_id = e.id WHERE e.tab_year = 2026 ORDER BY s.set_no').all();
  assert.deepEqual(rows, [{ exercise: 'Squat', set_no: 1, weight_lbs: 190 }, { exercise: 'Squat', set_no: 2, weight_lbs: 205 }]);
  assert.equal(count(store, 'strength_sets'), 3, 'the plank set is gone and 2025 is untouched');
  store.close();
});

test('Workout Log: in January the previous year tab is synced too', async () => {
  const store = open();
  const { counts } = await sync(store, source(), { now: new Date(2026, 0, 10) });
  assert.equal(counts.workout_log.tabsRead, 2);
  store.close();
});

test('backfill never overwrites drinking days or check-ins entered in the UI', async () => {
  const store = open();
  store.db.prepare("INSERT INTO drinking_days (date, beers, source, updated_at) VALUES ('2026-03-06', 5, 'ui', 'x')").run();
  store.db.prepare("INSERT INTO checkins (date, cadence, readiness, source, updated_at) VALUES ('2026-03-07', 'daily', 9, 'ui', 'x')").run();
  const { counts } = await sync(store, source(), { backfill: true });
  assert.equal(store.db.prepare("SELECT beers FROM drinking_days WHERE date = '2026-03-06'").get().beers, 5);
  assert.equal(store.db.prepare("SELECT readiness FROM checkins WHERE date = '2026-03-07'").get().readiness, 9);
  assert.deepEqual([counts.drinking_log.imported, counts.drinking_log.keptFromUi], [1, 1]);
  assert.deepEqual([counts.weekly_checkin.imported, counts.weekly_checkin.keptFromUi], [0, 1]);
  store.close();
});

test('each sync is recorded as a run with counts only', async () => {
  const store = open();
  await sync(store, source(), { backfill: true });
  const run = store.db.prepare("SELECT name, status, meta, summary FROM runs WHERE name = 'sync'").get();
  assert.equal(run.status, 'ok');
  assert.deepEqual(JSON.parse(run.meta), { backfill: true });
  const summary = JSON.parse(run.summary);
  assert.deepEqual(summary.counts.health_exports, { filesRead: 2, filesLeft: 0, healthDays: 2 });
  assert.doesNotMatch(run.summary, /Dinner|Squat|fine/, 'no cell text in the run record');
  store.close();
});

test('a failed sync is recorded as an error run and rethrown', async () => {
  const store = open();
  const src = source();
  src.exports[0].values[0] = ['When', 'HRV'];
  await assert.rejects(sync(store, src, { backfill: true }), /no "Date\/Time" column/);
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
  const src = source(withLabs(LAB()));
  const { counts } = await sync(store, src);
  assert.deepEqual(counts.lab_results, { tab: 'Labs', changed: true, tests: 3, draws: 2, results: 6, keptFromApp: 0 });
  assert.deepEqual(store.db.prepare('SELECT name, panel, position FROM lab_tests ORDER BY position').all().map((t) => [t.name, t.panel, t.position]), [
    ['Cholesterol', 'LIPID PANEL', 1], ['LDL Calculated', 'LIPID PANEL', 2], ['PSA', 'OTHER', 3],
  ]);
  assert.deepEqual((await sync(store, src)).counts.lab_results, { tab: 'Labs', changed: false });
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
  const { counts } = await sync(store, source());
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

test('after a sync, an info line counts exercise names that look like typos (npm run log:typos)', async () => {
  const { createDictionary } = await import('../metrics/dictionary.js');
  const dictionary = createDictionary({ version: 1, exercises: [
    { id: 'single-arm-row', name: 'Single-Arm Row', implement: 'dumbbell', pattern: 'horizontal pull', primary: false },
    { id: 'sing-arm-row', name: 'Sing-Arm Row', implement: 'dumbbell', pattern: 'horizontal pull', primary: false },
  ] });
  const store = open();
  const { warnings } = await sync(store, source(), { dictionary });
  const line = warnings.find((w) => w.source === 'exercise_names');
  assert.deepEqual([line.detail, line.severity], ['1 exercise name looks like a typo; see npm run log:typos', 'info']);
  store.close();
});

// ---- Health Auto Export files read straight from Drive (HEALTH_EXPORT_FOLDER_ID, WORKOUT_EXPORT_FOLDER_ID) ----

test('export files: with both folders set, health and workouts come from the files; neither consolidated sheet is read', async () => {
  const store = open();
  const src = fakeSource(sheets());
  src.exports = [healthFile('h1', '2026-03-02', [HEALTH, day('2026-03-02', 50, 54, 9000)]), workoutFile('w1', '2026-03-02', walk)];
  const { counts } = await sync(store, src, { exportFolders: both });
  assert.deepEqual(counts.health_exports, { filesRead: 1, filesLeft: 0, healthDays: 1 });
  assert.deepEqual(counts.workout_exports, { filesRead: 1, filesLeft: 0, workouts: 1 });
  assert.equal(counts.health_metrics, undefined);
  assert.equal(counts.workout_sessions, undefined);
  assert.ok(!src.reads.some((r) => r.source === 'health_metrics' || r.source === 'workout_sessions'), 'consolidated sheets untouched');
  assert.equal(store.db.prepare("SELECT steps FROM daily_metrics WHERE date = '2026-03-02'").get().steps, 9000);
  assert.equal(store.db.prepare("SELECT duration_sec FROM workout_sessions WHERE type = 'Outdoor Walk'").get().duration_sec, 1800);

  // A second sync reads nothing new; a changed file is read again.
  assert.equal((await sync(store, src, { exportFolders: both })).counts.health_exports.filesRead, 0);
  src.exports[0].modifiedTime = '2026-03-03T09:00:00Z';
  const again = (await sync(store, src, { exportFolders: both })).counts;
  assert.deepEqual([again.health_exports.filesRead, again.workout_exports.filesRead], [1, 0]);
  store.close();
});

test('export files: a day whose file was written before the day ended is partial until a later file arrives', async () => {
  const store = open();
  const src = fakeSource(sheets());
  // Mid-day UTC times, so the local date is the same in any US time zone.
  src.exports = [healthFile('h1', '2026-03-02', [HEALTH, day('2026-03-02', 50, 54, 9000)], '2026-03-02T15:00:00Z')];
  await sync(store, src, { exportFolders: { health: HF, workouts: null } });
  const through = () => store.db.prepare("SELECT exported_through FROM daily_metrics WHERE date = '2026-03-02'").pluck().get();
  assert.match(through(), /^2026-03-02T\d\d:\d\d$/);
  const partial = async () => (await buildApp({ store, clock: () => new Date(2026, 2, 5, 12) }))
    .inject('/api/history?from=2026-03-01&to=2026-03-04').then((r) => r.json().partialDays);
  assert.deepEqual(await partial(), ['2026-03-02']);

  src.exports[0].modifiedTime = '2026-03-04T15:00:00Z'; // the full day, exported later
  await sync(store, src, { exportFolders: { health: HF, workouts: null } });
  assert.match(through(), /^2026-03-04T/);
  assert.deepEqual(await partial(), []);

  src.exports.push(healthFile('h0', '2026-03-02-old', [HEALTH, day('2026-03-02', 50, 54, 4000)], '2026-03-02T16:00:00Z'));
  await sync(store, src, { exportFolders: { health: HF, workouts: null } }); // an older file read later never lowers it
  assert.match(through(), /^2026-03-04T/);
  store.close();
});

test('export files: a sync that finds nothing newer than 26 hours warns that the export automation stopped', async () => {
  const store = open();
  const src = fakeSource(sheets());
  src.exports = [healthFile('h1', '2026-03-02', [HEALTH, day('2026-03-02', 50, 54, 9000)], '2026-03-02T12:00:00Z')];
  const stale = async (now) => (await sync(store, src, { now, exportFolders: { health: HF, workouts: null } }))
    .warnings.find((w) => w.kind === 'export_stale') ?? null;
  assert.equal(await stale(new Date('2026-03-03T13:00:00Z')), null); // 25 hours
  const w = await stale(new Date('2026-03-03T16:00:00Z')); // 28 hours
  assert.match(w.detail, /^No new Apple Health export since Mar 2, .* \(28 hours before the last sync\)/);
  // Without the export folder there is nothing to judge.
  assert.equal((await sync(store, src, { now: new Date('2026-03-05T16:00:00Z'), exportFolders: { health: null, workouts: null } }))
    .warnings.find((x) => x.kind === 'export_stale'), undefined);
  store.close();
});


test('export files: a file of the other kind in a folder is ignored', async () => {
  const store = open();
  const src = fakeSource(sheets());
  src.exports = [healthFile('h1', 'a', [HEALTH, day('2026-03-02', 50, 54, 9000)]), { ...workoutFile('stray', 'a', walk), folder: HF }];
  const { counts } = await sync(store, src, { exportFolders: { health: HF, workouts: null } });
  assert.equal(counts.health_exports.filesRead, 1);
  assert.ok(!src.reads.some((r) => r.file === 'stray'));
  store.close();
});

test('export files: a partial export read after the full day never lowers it; its extra fields fill gaps', async () => {
  const store = open();
  const src = fakeSource(sheets());
  src.exports = [healthFile('h1', 'a', [HEALTH, [serial('2026-03-02', 3), 48, null, 8000]])];
  await sync(store, src, { exportFolders: both });
  src.exports.push(healthFile('h2', 'b', [HEALTH, [serial('2026-03-02', 3), 60, 52, 340]]));
  await sync(store, src, { exportFolders: both });
  assert.deepEqual(store.db.prepare("SELECT hrv_ms, resting_hr, steps FROM daily_metrics WHERE date = '2026-03-02'").get(),
    { hrv_ms: 48, resting_hr: 52, steps: 8000 });
  store.close();
});

test('export files: at most 200 per folder per sync, oldest first; the rest wait with an info line', async () => {
  const { EXPORT_FILES_PER_SYNC } = await import('../ingest/sync.js');
  const store = open();
  const src = fakeSource(sheets());
  const n = EXPORT_FILES_PER_SYNC + 5;
  src.exports = [
    ...Array.from({ length: n }, (_, i) => healthFile(`h${i}`, String(i).padStart(4, '0'), [HEALTH, day('2026-03-01', 40, 55, 1000 + i)])),
    workoutFile('w1', 'a', walk),
  ];
  const first = await sync(store, src, { exportFolders: both });
  assert.equal(first.counts.health_exports.filesRead, EXPORT_FILES_PER_SYNC);
  assert.equal(first.counts.workout_exports.filesRead, 1, 'the cap is per folder');
  assert.equal(first.warnings.find((w) => w.source === 'health_exports').detail, '5 health export files still to read; the next syncs continue');
  const second = await sync(store, src, { exportFolders: both });
  assert.deepEqual([second.counts.health_exports.filesRead, second.counts.health_exports.filesLeft], [5, 0]);
  assert.equal(store.db.prepare("SELECT steps FROM daily_metrics WHERE date = '2026-03-01'").get().steps, 1000 + n - 1);
  store.close();
});


test('export files: if Google still says too many requests, what was read is saved and the rest waits; the sync succeeds', async () => {
  const { EXPORT_SAVE_EVERY } = await import('../ingest/sync.js');
  const store = open();
  const src = fakeSource(sheets());
  const n = EXPORT_SAVE_EVERY + 10;
  src.exports = Array.from({ length: n }, (_, i) => healthFile(`h${i}`, String(i).padStart(4, '0'),
    [HEALTH, day(`2026-02-${String(1 + (i % 28)).padStart(2, '0')}`, 40, 55, 2000 + i)]));
  const failAt = EXPORT_SAVE_EVERY + 5; // the 31st read is refused
  const realRead = src.readFileRows.bind(src);
  let calls = 0;
  src.readFileRows = async (id) => {
    calls += 1;
    if (calls === failAt) throw Object.assign(new Error('Quota exceeded'), { response: { status: 429 } });
    return realRead(id);
  };
  const { counts, warnings } = await sync(store, src, { exportFolders: { health: HF, workouts: null } });
  assert.deepEqual([counts.health_exports.filesRead, counts.health_exports.filesLeft], [failAt - 1, n - failAt + 1]);
  assert.equal(count(store, 'drive_exports'), failAt - 1, 'the full group of 25 and the 4 read after it are saved');
  assert.equal(warnings.find((w) => w.kind === 'read limit reached').detail, `Google's read limit reached; ${n - failAt + 1} health export files left for the next sync`);
  assert.equal(store.db.prepare("SELECT status FROM runs WHERE name = 'sync' ORDER BY id DESC LIMIT 1").get().status, 'ok');

  src.readFileRows = realRead; // the next sync picks up the rest
  const next = await sync(store, src, { exportFolders: { health: HF, workouts: null } });
  assert.deepEqual([next.counts.health_exports.filesRead, next.counts.health_exports.filesLeft], [n - failAt + 1, 0]);
  store.close();
});

test('export files: any other read error still fails the sync', async () => {
  const store = open();
  const src = fakeSource(sheets());
  src.exports = [healthFile('h1', 'a', [HEALTH, day('2026-03-02', 50, 54, 9000)])];
  src.readFileRows = async () => { throw Object.assign(new Error('Not found'), { response: { status: 404 } }); };
  await assert.rejects(sync(store, src, { exportFolders: { health: HF, workouts: null } }), /Not found/);
  store.close();
});
