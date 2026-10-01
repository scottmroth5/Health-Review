// Copies the Google Sheets into the local database, adding only what is new.
//  - Health metrics and workout sessions: the whole first tab (the v1 scripts' consolidated tab,
//    whatever it is named) is read every sync and upserted by natural key. Health days merge field
//    by field (later non-empty values win), which removes v1's partial-day duplicates. Rows the
//    owner archives off that tab stay in the database.
//  - Workout Log: one tab per year. A tab is replaced only when its content hash changed, so
//    edits and deletions in the sheet are picked up. Normal syncs read the current year (and
//    last year during January); backfill reads every year tab.
//  - Drinking log and weekly check-in are imported only on backfill: the UI owns them after
//    that, and rows entered in the UI are never overwritten.
import { createHash } from 'node:crypto';
import { createTracer } from '@scottmroth5/agent-core';
import {
  HEALTH_METRIC_COLUMNS,
  parseHealthMetrics,
  parseWorkoutSessions,
  parseWorkoutLogTab,
  parseDrinkingLog,
  parseWeeklyCheckins,
  parseLabSheet,
} from './parsers.js';

const V1_SOURCE = 'v1-sheet';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * @param {object} options
 * @param {{ db: import('better-sqlite3').Database, tx: Function }} options.store  from openHealthStore()
 * @param {ReturnType<import('./sheets.js').createSheetsSource>} options.source
 * @param {boolean} [options.backfill]   read everything and import the drinking log and check-ins
 * @param {Date} [options.now]
 * @param {object} [options.logger]
 * @returns {Promise<{ counts: object, warnings: object[] }>}
 */
export async function runSync({ store, source, backfill = false, now = new Date(), logger = console }) {
  const run = createTracer({ store, logger }).startRun('sync', { backfill });
  const counts = {};
  const warnings = [];
  const stamp = now.toISOString();
  try {
    counts.health_metrics = await syncWholeTab({
      store, source, key: 'health_metrics', parse: parseHealthMetrics, warnings,
      write: upsertDailyMetrics(store.db, stamp),
    });
    counts.workout_sessions = await syncWholeTab({
      store, source, key: 'workout_sessions', parse: parseWorkoutSessions, warnings,
      write: upsertWorkoutSessions(store.db, stamp),
    });
    counts.workout_log = await syncWorkoutLog({ store, source, backfill, now, warnings });
    counts.lab_results = await syncLabs({ store, source, warnings, stamp });
    if (backfill) {
      counts.drinking_log = await importOnce({ store, source, key: 'drinking_log', parse: parseDrinkingLog, write: upsertDrinkingDays(store.db, stamp), warnings });
      counts.weekly_checkin = await importOnce({ store, source, key: 'weekly_checkin', parse: parseWeeklyCheckins, write: upsertCheckins(store.db, stamp), warnings });
    }
    run.finish('ok', { counts, warnings: warnings.length });
    return { counts, warnings };
  } catch (err) {
    run.finish('error', { counts, error: err.message });
    throw err;
  }
}

function getState(db, sourceKey, tab) {
  return db.prepare('SELECT * FROM sync_state WHERE source = ? AND tab = ?').get(sourceKey, tab) ?? null;
}

function setState(db, sourceKey, tab, { rowCount, headerHash = null, contentHash = null }) {
  db.prepare(`INSERT INTO sync_state (source, tab, row_count, header_hash, content_hash, synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, tab) DO UPDATE SET row_count = excluded.row_count, header_hash = excluded.header_hash,
      content_hash = excluded.content_hash, synced_at = excluded.synced_at`)
    .run(sourceKey, tab, rowCount, headerHash, contentHash, new Date().toISOString());
}

// The data is on each sheet's first tab (the v1 consolidation scripts write there), whatever it is named.
async function dataTab(source, key) {
  const [first] = await source.listTabs(key);
  if (!first) throw new Error(`${key}: the sheet has no tabs`);
  return first;
}

// Records what was read and drops state left under an earlier tab name.
function saveState(db, key, tab, data) {
  db.prepare('DELETE FROM sync_state WHERE source = ? AND tab <> ?').run(key, tab);
  setState(db, key, tab, { rowCount: data.firstRowNumber - 1 + data.rows.length, headerHash: hash(data.header) });
}

// The consolidated tabs are trimmed into an Archive tab from time to time, so a row-number watermark
// could skip rows after the tab shrinks and grows again. Reading the whole tab is cheap and the
// upserts are idempotent.
async function syncWholeTab({ store, source, key, parse, write, warnings }) {
  const tab = await dataTab(source, key);
  const data = await source.readRows(key, tab);
  const { records, warnings: w } = parse({ ...data, tab });
  warnings.push(...w);
  store.tx(() => {
    for (const r of records) write(r);
    saveState(store.db, key, tab, data);
  });
  return { rowsRead: data.rows.length, upserted: records.length };
}

async function syncWorkoutLog({ store, source, backfill, now, warnings }) {
  const yearTabs = (await source.listTabs('workout_log')).filter((t) => /^\d{4}$/.test(t)).sort();
  const year = now.getFullYear();
  const inJanuary = now.getMonth() === 0 && now.getDate() <= 28;
  const wanted = backfill ? yearTabs : yearTabs.filter((t) => Number(t) === year || (inJanuary && Number(t) === year - 1));
  const result = { tabsRead: wanted.length, tabsReplaced: 0, exercises: 0, sets: 0, notes: 0 };

  const insertExercise = store.db.prepare(`INSERT INTO strength_exercises
    (tab_year, row_no, date, workout, prime, exercise, post, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSet = store.db.prepare(`INSERT INTO strength_sets
    (exercise_id, set_no, weight_text, weight_lbs, per_hand, band, bodyweight, reps_text, reps, duration_sec, distance_yd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertNote = store.db.prepare('INSERT INTO workout_log_notes (tab_year, row_no, date, text) VALUES (?, ?, ?, ?)');

  for (const tab of wanted) {
    const data = await source.readRows('workout_log', tab);
    const contentHash = hash([data.header, data.rows]);
    if (getState(store.db, 'workout_log', tab)?.content_hash === contentHash) continue;
    const { records, notes, warnings: w } = parseWorkoutLogTab({ ...data, tab });
    warnings.push(...w);
    store.tx(() => {
      store.db.prepare('DELETE FROM strength_exercises WHERE tab_year = ?').run(Number(tab));
      store.db.prepare('DELETE FROM workout_log_notes WHERE tab_year = ?').run(Number(tab));
      for (const e of records) {
        const id = insertExercise.run(e.tab_year, e.row_no, e.date, e.workout, e.prime, e.exercise, e.post, e.comment).lastInsertRowid;
        for (const s of e.sets) {
          insertSet.run(id, s.set_no, s.weight_text, s.weight_lbs, s.per_hand, s.band, s.bodyweight, s.reps_text, s.reps, s.duration_sec, s.distance_yd);
        }
        result.sets += e.sets.length;
      }
      for (const n of notes) insertNote.run(n.tab_year, n.row_no, n.date, n.text);
      setState(store.db, 'workout_log', tab, { rowCount: data.firstRowNumber - 1 + data.rows.length, contentHash });
    });
    result.tabsReplaced += 1;
    result.exercises += records.length;
    result.notes += notes.length;
  }
  return result;
}

/**
 * The lab sheet is small, so it is read whole every time and only written when its content changed.
 * Sheet results are replaced together (edits and removed columns are picked up); results entered
 * in the app are never touched, and the app's value wins when both have the same test and date.
 */
async function syncLabs({ store, source, warnings, stamp }) {
  if (!source.has?.('lab_results')) return { skipped: 'no lab sheet (labs are entered in the app)' };
  // The tab whose A1 is "Lab Test", else the first tab.
  let tab = null;
  let data = null;
  for (const t of await source.listTabs('lab_results')) {
    const d = await source.readRows('lab_results', t);
    if (!data) [tab, data] = [t, d];
    if (cleanCell(d.header[0]) === 'lab test') {
      [tab, data] = [t, d];
      break;
    }
  }
  if (!data) return { skipped: 'the lab spreadsheet has no tabs' };
  const contentHash = hash([data.header, data.rows]);
  if (getState(store.db, 'lab_results', tab)?.content_hash === contentHash) return { tab, changed: false };

  const { tests, results, warnings: w } = parseLabSheet({ ...data, tab });
  warnings.push(...w);
  const { db } = store;
  let keptFromApp = 0;
  store.tx(() => {
    const findTest = db.prepare('SELECT id FROM lab_tests WHERE name = ?');
    const insertTest = db.prepare('INSERT INTO lab_tests (name, panel, position, created_at) VALUES (?, ?, ?, ?)');
    const updateTest = db.prepare('UPDATE lab_tests SET panel = ?, position = ? WHERE id = ?');
    const ids = new Map();
    for (const t of tests) {
      const found = findTest.get(t.name);
      if (found) updateTest.run(t.panel, t.position, found.id);
      ids.set(t.name.toLowerCase(), found?.id ?? Number(insertTest.run(t.name, t.panel, t.position, stamp).lastInsertRowid));
    }
    db.prepare("DELETE FROM lab_results WHERE source = 'sheet'").run();
    // An app row wins: one added in the app on the same date, or a correction of this sheet result
    // (found by its original date, since a correction may have moved it).
    const fromApp = db.prepare(`SELECT value_text, corrected_from_date FROM lab_results WHERE test_id = @test AND source = 'ui'
      AND (drawn_on = @date OR corrected_from_date = @date)`);
    const insert = db.prepare("INSERT INTO lab_results (test_id, drawn_on, value, value_text, source, updated_at) VALUES (?, ?, ?, ?, 'sheet', ?)");
    for (const r of results) {
      const testId = ids.get(r.test.toLowerCase());
      const app = fromApp.get({ test: testId, date: r.drawn_on });
      if (app) {
        keptFromApp += 1;
        // Corrections are expected to differ from the sheet; only a disagreeing app-added value is worth a warning.
        if (!app.corrected_from_date && app.value_text !== r.value_text) {
          warnings.push({ source: 'lab_results', tab, kind: 'app value kept over a different sheet value', detail: `${r.test} on ${r.drawn_on}` });
        }
        continue;
      }
      try {
        insert.run(testId, r.drawn_on, r.value, r.value_text, stamp);
      } catch (err) {
        // A correction moved another result onto this date; the app's row stays.
        if (!/UNIQUE/.test(err.message)) throw err;
        keptFromApp += 1;
      }
    }
    setState(db, 'lab_results', tab, { rowCount: data.firstRowNumber - 1 + data.rows.length, contentHash });
  });
  return { tab, changed: true, tests: tests.length, draws: new Set(results.map((r) => r.drawn_on)).size, results: results.length - keptFromApp, keptFromApp };
}

const cleanCell = (v) => String(v ?? '').trim().toLowerCase();

async function importOnce({ store, source, key, parse, write, warnings }) {
  const tab = await dataTab(source, key);
  const data = await source.readRows(key, tab);
  const { records, warnings: w } = parse({ ...data, tab });
  warnings.push(...w);
  let written = 0;
  store.tx(() => {
    for (const r of records) written += write(r);
    saveState(store.db, key, tab, data);
  });
  return { rowsRead: data.rows.length, imported: written, keptFromUi: records.length - written };
}

// ---- writers: each returns a function(record) ----

function upsertDailyMetrics(db, stamp) {
  const cols = HEALTH_METRIC_COLUMNS;
  const stmt = db.prepare(`INSERT INTO daily_metrics (date, ${cols.join(', ')}, updated_at)
    VALUES (@date, ${cols.map((c) => `@${c}`).join(', ')}, @updated_at)
    ON CONFLICT (date) DO UPDATE SET ${cols.map((c) => `${c} = COALESCE(excluded.${c}, daily_metrics.${c})`).join(', ')},
      updated_at = excluded.updated_at`);
  return (r) => stmt.run({ ...r, updated_at: stamp });
}

function upsertWorkoutSessions(db, stamp) {
  const cols = ['duration_sec', 'total_energy_kcal', 'active_energy_kcal', 'max_hr', 'avg_hr', 'distance_mi', 'avg_speed_mph',
    'step_count', 'step_cadence_spm', 'swim_stroke_count', 'swim_stroke_cadence_spm', 'flights_climbed', 'elevation_up_ft', 'elevation_down_ft'];
  const stmt = db.prepare(`INSERT INTO workout_sessions (type, start, end, ${cols.join(', ')}, updated_at)
    VALUES (@type, @start, @end, ${cols.map((c) => `@${c}`).join(', ')}, @updated_at)
    ON CONFLICT (type, start, end) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`);
  return (r) => stmt.run({ ...r, updated_at: stamp });
}

// Imported rows never replace a day entered in the UI. Returns 1 when written, 0 when kept.
function upsertDrinkingDays(db, stamp) {
  const stmt = db.prepare(`INSERT INTO drinking_days
    (date, beers, wine, bourbon, other, setting, mood_before, mood_after, notes, source, updated_at)
    VALUES (@date, @beers, @wine, @bourbon, @other, @setting, @mood_before, @mood_after, @notes, '${V1_SOURCE}', @updated_at)
    ON CONFLICT (date) DO UPDATE SET beers = excluded.beers, wine = excluded.wine, bourbon = excluded.bourbon,
      other = excluded.other, setting = excluded.setting, mood_before = excluded.mood_before, mood_after = excluded.mood_after,
      notes = excluded.notes, updated_at = excluded.updated_at
    WHERE drinking_days.source = '${V1_SOURCE}'`);
  return (r) => stmt.run({ ...r, updated_at: stamp }).changes;
}

function upsertCheckins(db, stamp) {
  const cols = ['cadence', 'readiness', 'energy', 'mood', 'stress', 'nutrition', 'weight_lbs', 'body_fat_pct', 'muscle_mass_lbs',
    'visceral_fat', 'body_measured_on', 'notes'];
  const stmt = db.prepare(`INSERT INTO checkins (date, ${cols.join(', ')}, source, updated_at)
    VALUES (@date, ${cols.map((c) => `@${c}`).join(', ')}, '${V1_SOURCE}', @updated_at)
    ON CONFLICT (date) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at
    WHERE checkins.source = '${V1_SOURCE}'`);
  return (r) => stmt.run({ ...r, updated_at: stamp }).changes;
}
