// Copies Apple Health and the Google Sheets into the local database, adding only what is new.
//  - Health metrics and workouts: Health Auto Export's own day files in their two Drive folders, only files new or
//    changed since last read. Health metrics (HEALTH_EXPORT_FOLDER_ID) are Google Sheets files; each day is merged with
//    the stored day, so a partial export never lowers a full one. Workouts (WORKOUT_JSON_FOLDER_ID) are JSON files
//    (Workouts export, Version 2) with each workout's per-minute heart rate. The v1 consolidated sheets are retired
//    (2026-10-16) and never read; a missing folder variable skips that kind with a warning.
//  - Workout Log: one tab per year. A tab is replaced only when its content hash changed, so
//    edits and deletions in the sheet are picked up. Normal syncs read the current year (and
//    last year during January); backfill reads every year tab.
//  - Drinking log and weekly check-in are imported only on backfill: the UI owns them after
//    that, and rows entered in the UI are never overwritten.
import { dataChecks } from '../metrics/dataquality.ts';
import { loadDataCheckInput, userCatalog } from '../metrics/load.ts';
import { createHash } from 'node:crypto';
import {
  parseHealthMetrics,
  localStamp,
  parseWorkoutJson,
  parseWorkoutLogTab,
  parseDrinkingLog,
  parseWeeklyCheckins,
  parseLabSheet,
} from './parsers.ts';
import { canonicalSetCounts, normalizeAll, unmappedNames } from './normalize.ts';
import { typoCandidates } from '../metrics/name-typos.ts';
import { assignForward, refreshPhases } from './program-blocks.ts';
import { DICTIONARY_PATH, loadDictionary } from '../metrics/dictionary.ts';
import { existsSync } from 'node:fs';
import { localDate, zonedParts } from '../tools/time.ts';
import { applyHealthDays, applyWorkouts } from './apply.ts';
import { parseHealthJson } from './health-json.ts';
import { startUserRun } from '../db/users.ts';
import type { Catalog } from '../metrics/catalog.ts';
import type { Dictionary } from '../metrics/dictionary.ts';
import type { Row } from '../metrics/stats.ts';
import type { HrSample, ParsedRecord, ParseWarning, TabInput } from './parsers.ts';
import type { ExportFile, SheetData, SheetsSource } from './sheets.ts';
import type { Logger, SyncWarning, UserDb, UserStore } from './types.ts';

/** Health Auto Export's Drive folders (a kind without one is skipped). */
export interface ExportFolders { health?: string | null, workouts?: string | null, stand?: string | null }

/** Where Apple Health comes from: drive (Health Auto Export's files, this computer) or rest (its posts, the server). */
export const appleSource = (env: Record<string, string | undefined> = process.env): 'drive' | 'rest' => (env.APPLE_SOURCE === 'rest' ? 'rest' : 'drive');

const V1_SOURCE = 'v1-sheet';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * store: a scoped store (db/scope.ts scopeStore); the whole sync runs on its async handle (docs/adr/0006), each write
 *   group in one tx.
 * backfill: read everything and import the drinking log and check-ins.
 * catalog: MAPS program catalog; defaults to data/maps/programs.json when present.
 * dictionary: exercise dictionary; defaults to config/exercise-dictionary.json when present.
 * exportFolders: Health Auto Export's Drive folders (HEALTH_EXPORT_FOLDER_ID, WORKOUT_JSON_FOLDER_ID, and
 *   STAND_EXPORT_FOLDER_ID for the hour-grouped stand hours); a kind without one is skipped with a warning (stand hours
 *   quietly).
 * apple: rest (APPLE_SOURCE=rest, the server): Apple data arrives through POST /api/ingest/*, so the sync reads no Drive
 *   folder.
 */
export async function runSync({ store, source, backfill = false, now = new Date(), logger = console, dictionary, catalog,
  apple = appleSource(), exportFolders = { health: process.env.HEALTH_EXPORT_FOLDER_ID || null, workouts: process.env.WORKOUT_JSON_FOLDER_ID || null, stand: process.env.STAND_EXPORT_FOLDER_ID || null } }: {
  store: UserStore, source: SheetsSource, backfill?: boolean, now?: Date, logger?: Logger, dictionary?: Dictionary | null,
  catalog?: Catalog | null, apple?: 'drive' | 'rest', exportFolders?: ExportFolders,
}): Promise<{ counts: Record<string, any>, warnings: SyncWarning[] }> {
  const run = await startUserRun(store, 'sync', { backfill }, logger);
  const counts: Record<string, any> = {};
  const warnings: SyncWarning[] = [];
  const stamp = now.toISOString();
  try {
    // Apple Health: on this computer from Health Auto Export's files, one Drive folder per kind; on the server
    // (APPLE_SOURCE=rest) it arrives through POST /api/ingest/* instead, so no folder is read.
    if (apple === 'drive') {
      if (exportFolders.health) {
        // The health folder holds the Sheets-format files and, since the JSON switch, JSON files (one parser for both ways in).
        const sheets = await syncExports({ store, source, kind: 'health', folderId: exportFolders.health, warnings, stamp });
        const json = await syncExports({ store, source, kind: 'health_json', folderId: exportFolders.health, warnings, stamp });
        counts.health_exports = { filesRead: sheets.filesRead + json.filesRead, filesLeft: sheets.filesLeft + json.filesLeft, healthDays: sheets.healthDays + json.healthDays };
      } else {
        warnings.push({ source: 'health_exports', kind: 'folder not set', detail: 'HEALTH_EXPORT_FOLDER_ID is not set, so Apple Health metrics were not synced', severity: 'warn' });
      }
      if (exportFolders.workouts) counts.workout_exports = await syncExports({ store, source, kind: 'workouts', folderId: exportFolders.workouts, warnings, stamp });
      else warnings.push({ source: 'workout_exports', kind: 'folder not set', detail: 'WORKOUT_JSON_FOLDER_ID is not set, so Apple Watch workouts were not synced', severity: 'warn' });
      if (exportFolders.stand) counts.stand_exports = await syncExports({ store, source, kind: 'health_json', folderId: exportFolders.stand, warnings, stamp });
    }
    counts.workout_log = await syncWorkoutLog({ store, source, backfill, now, warnings });
    if (counts.workout_log.tabsReplaced) {
      counts.normalized = await normalizeLog(store.db, dictionary, now, warnings);
      counts.sessions = await assignForward(store.db, localDay(now), { now });
      try { await refreshPhases(store.db, catalog === undefined ? await userCatalog(store.db) : catalog); } catch (err: any) {
        warnings.push({ source: 'program_catalog', kind: 'invalid catalog, phases not updated', detail: err.problems?.length ? `${err.problems.length} problems; run npm run programs:catalog` : err.message });
      }
    }
    counts.lab_results = await syncLabs({ store, source, warnings, stamp });
    if (backfill) {
      counts.drinking_log = await importOnce({ store, source, key: 'drinking_log', parse: parseDrinkingLog, write: upsertDrinkingDays(store.db, stamp), warnings });
      counts.weekly_checkin = await importOnce({ store, source, key: 'weekly_checkin', parse: parseWeeklyCheckins, write: upsertCheckins(store.db, stamp), warnings });
    }
    // Data checks (stale or missing Apple Health days, an export automation that stopped, partial days, workouts not exported, impossible values).
    const checks = dataChecks(await loadDataCheckInput(store.db, localDay(now), { apple, now, lookedAt: apple === 'drive' && exportFolders.health ? stamp : null, workoutsLookedAt: apple === 'drive' && exportFolders.workouts ? stamp : null }));
    for (const c of checks) warnings.push({ source: 'data_check', kind: c.kind, detail: c.message, severity: c.severity });
    counts.data_checks = { warn: checks.filter((c) => c.severity === 'warn').length, info: checks.filter((c) => c.severity === 'info').length };
    const typos = await typoCount(store.db, dictionary);
    if (typos) warnings.push({ source: 'exercise_names', kind: 'likely typos', detail: `${typos === 1 ? '1 exercise name looks like a typo' : `${typos} exercise names look like typos`}; see npm run log:typos`, severity: 'info' });
    await run.finish('ok', { counts, warnings: warnings.length });
    return { counts, warnings };
  } catch (err: any) {
    await run.finish('error', { counts, error: err.message });
    throw err;
  }
}

async function getState(db: UserDb, sourceKey: string, tab: string | null): Promise<Row | null> {
  return (await db.prepare('SELECT * FROM sync_state WHERE user_id = @uid AND source = ? AND tab = ?').get(sourceKey, tab)) ?? null;
}

async function setState(db: UserDb, sourceKey: string, tab: string | null, { rowCount, headerHash = null, contentHash = null }: {
  rowCount: number, headerHash?: string | null, contentHash?: string | null,
}) {
  await db.prepare(`INSERT INTO sync_state (user_id, source, tab, row_count, header_hash, content_hash, synced_at)
    VALUES (@uid, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, source, tab) DO UPDATE SET row_count = excluded.row_count, header_hash = excluded.header_hash,
      content_hash = excluded.content_hash, synced_at = excluded.synced_at`)
    .run(sourceKey, tab, rowCount, headerHash, contentHash, new Date().toISOString());
}

// The data is on each sheet's first tab (the v1 consolidation scripts write there), whatever it is named.
async function dataTab(source: SheetsSource, key: string): Promise<string> {
  const [first] = await source.listTabs(key);
  if (!first) throw new Error(`${key}: the sheet has no tabs`);
  return first;
}

// Records what was read and drops state left under an earlier tab name.
async function saveState(db: UserDb, key: string, tab: string, data: SheetData) {
  await db.prepare('DELETE FROM sync_state WHERE user_id = @uid AND source = ? AND tab <> ?').run(key, tab);
  await setState(db, key, tab, { rowCount: data.firstRowNumber - 1 + data.rows.length, headerHash: hash(data.header) });
}

/** Export files read per folder per sync at most; at Google's paced read rate that is about 2 minutes a folder. */
export const EXPORT_FILES_PER_SYNC = 100;
/** Export files saved together; a failure later in the sync keeps the groups already saved. */
export const EXPORT_SAVE_EVERY = 25;

const isRateLimit = (err: any): boolean => (err?.response?.status ?? err?.status ?? err?.code) === 429;

/**
 * Health Auto Export files of one kind from its Drive folder: only files new or changed since they were last read
 * (drive_exports), oldest first, saved every 25 files. A health day from the files is merged with the day already
 * stored by mergeHealthDays (the fullest row wins, gaps filled from the others), so a partial export read after the full
 * day never lowers it. JSON workouts upsert on type, start and end (a stored workout of the same type starting within a
 * minute is the same one: its fields fill gaps and it is replaced), and each workout's per-minute heart rate is replaced
 * whole. If Google still answers "too many requests"
 * (reads are paced in the source), the folder stops there and the rest waits for the next sync.
 */
async function syncExports({ store, source, kind, folderId, warnings, stamp, limit = EXPORT_FILES_PER_SYNC }: {
  store: UserStore, source: SheetsSource, kind: string, folderId: string, warnings: SyncWarning[], stamp: string, limit?: number,
}): Promise<Record<string, number>> {
  const db = store.db;
  const known = new Map((await db.prepare('SELECT file_id, modified_time FROM drive_exports WHERE user_id = @uid').all()).map((r: Row): [string, string] => [r.file_id, r.modified_time]));
  const todo = (await source.listExports(folderId, kind)).filter((f) => known.get(f.id) !== f.modifiedTime);
  const batch = todo.slice(0, limit);
  const health = kind !== 'workouts'; // 'health' (Sheets files) or 'health_json'
  const label = health ? 'health' : 'workout';
  const record = db.prepare(`INSERT INTO drive_exports (user_id, file_id, kind, name, modified_time, rows, synced_at) VALUES (@uid, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (file_id) DO UPDATE SET name = excluded.name, modified_time = excluded.modified_time, rows = excluded.rows, synced_at = excluded.synced_at`);

  let filesRead = 0;
  const healthDays = new Set<string>();
  let workouts = 0;
  let hrSamples = 0;
  let limited = false;
  for (let i = 0; i < batch.length && !limited; i += EXPORT_SAVE_EVERY) {
    const read: (ExportFile & { rows: number })[] = [];
    const healthRecords: ParsedRecord[] = [];
    const standHours: { date: string, hour: number }[] = [];
    const workoutRecords: ParsedRecord[] = [];
    const hrRecords: HrSample[] = [];
    const exportedThrough = new Map<string, string>(); // date -> latest local file time among this batch's files
    for (const f of batch.slice(i, i + EXPORT_SAVE_EVERY)) {
      let data: any;
      try {
        data = kind === 'health' ? await source.readFileRows(f.id) : await source.readFileJson(f.id);
      } catch (err) {
        if (!isRateLimit(err)) throw err;
        limited = true;
        break;
      }
      if (health) {
        const parsed: { records: ParsedRecord[], warnings: SyncWarning[], standHours?: { date: string, hour: number }[] } = kind === 'health' ? parseHealthMetrics({ ...data, tab: f.name }) : parseHealthJson(data, { file: f.name });
        warnings.push(...parsed.warnings);
        healthRecords.push(...parsed.records);
        standHours.push(...(parsed.standHours ?? []));
        const at = localStamp(f.modifiedTime);
        // An unset day compares false, as before.
        for (const r of parsed.records) if (!((exportedThrough.get(r.date) as string) > at)) exportedThrough.set(r.date, at);
        read.push({ ...f, rows: kind === 'health' ? data.rows.length : parsed.records.length + (parsed.standHours?.length ?? 0) });
      } else {
        const parsed = parseWorkoutJson(data, { file: f.name });
        warnings.push(...parsed.warnings);
        workoutRecords.push(...parsed.records);
        hrRecords.push(...parsed.samples);
        read.push({ ...f, rows: parsed.records.length });
      }
    }
    // The shared writers (ingest/apply.ts), the same ones the REST ingest uses.
    let days: string[] = [];
    await store.tx(async () => {
      if (health) ({ days } = await applyHealthDays(db, { records: healthRecords, exportedThrough, standHours }, stamp));
      await applyWorkouts(db, workoutRecords, hrRecords, stamp);
      for (const f of read) await record.run(f.id, kind, f.name, f.modifiedTime, f.rows, stamp);
    });
    filesRead += read.length;
    for (const d of days) healthDays.add(d);
    workouts += workoutRecords.length;
    hrSamples += hrRecords.length;
  }

  const filesLeft = todo.length - filesRead;
  if (limited) {
    warnings.push({ source: `${label}_exports`, kind: 'read limit reached', detail: `Google's read limit reached; ${filesLeft} ${label} export files left for the next sync`, severity: 'info' });
  } else if (filesLeft) {
    warnings.push({ source: `${label}_exports`, kind: 'files still to read', detail: `${filesLeft} ${label} export files still to read; the next syncs continue`, severity: 'info' });
  }
  const result = { filesRead, filesLeft };
  return health ? { ...result, healthDays: healthDays.size } : { ...result, workouts, hrSamples };
}

async function syncWorkoutLog({ store, source, backfill, now, warnings }: {
  store: UserStore, source: SheetsSource, backfill: boolean, now: Date, warnings: SyncWarning[],
}) {
  const yearTabs = (await source.listTabs('workout_log')).filter((t) => /^\d{4}$/.test(t)).sort();
  const { year, month, day } = zonedParts(now);
  const inJanuary = month === 1 && day <= 28;
  const wanted = backfill ? yearTabs : yearTabs.filter((t) => Number(t) === year || (inJanuary && Number(t) === year - 1));
  const result = { tabsRead: wanted.length, tabsReplaced: 0, exercises: 0, sets: 0, notes: 0 };

  const db = store.db;
  const insertExercise = db.prepare(`INSERT INTO strength_exercises
    (user_id, tab_year, row_no, date, workout, prime, exercise, post, comment) VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`);
  const insertSet = db.prepare(`INSERT INTO strength_sets
    (user_id, exercise_id, set_no, weight_text, weight_lbs, per_hand, band, bodyweight, reps_text, reps, duration_sec, distance_yd)
    VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertNote = db.prepare('INSERT INTO workout_log_notes (user_id, tab_year, row_no, date, text) VALUES (@uid, ?, ?, ?, ?)');

  for (const tab of wanted) {
    const data = await source.readRows('workout_log', tab);
    const contentHash = hash([data.header, data.rows]);
    if ((await getState(db, 'workout_log', tab))?.content_hash === contentHash) continue;
    const { records, notes, warnings: w } = parseWorkoutLogTab({ ...data, tab });
    warnings.push(...w);
    await store.tx(async () => {
      await db.prepare('DELETE FROM strength_exercises WHERE user_id = @uid AND tab_year = ?').run(Number(tab));
      await db.prepare('DELETE FROM workout_log_notes WHERE user_id = @uid AND tab_year = ?').run(Number(tab));
      for (const e of records) {
        const id = (await insertExercise.get(e.tab_year, e.row_no, e.date, e.workout, e.prime, e.exercise, e.post, e.comment)).id;
        for (const s of e.sets) {
          await insertSet.run(id, s.set_no, s.weight_text, s.weight_lbs, s.per_hand, s.band, s.bodyweight, s.reps_text, s.reps, s.duration_sec, s.distance_yd);
        }
        result.sets += e.sets.length;
      }
      for (const n of notes) await insertNote.run(n.tab_year, n.row_no, n.date, n.text);
      await setState(db, 'workout_log', tab, { rowCount: data.firstRowNumber - 1 + data.rows.length, contentHash });
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
async function syncLabs({ store, source, warnings, stamp }: { store: UserStore, source: SheetsSource, warnings: SyncWarning[], stamp: string }) {
  if (!source.has?.('lab_results')) return { skipped: 'no lab sheet (labs are entered in the app)' };
  // The tab whose A1 is "Lab Test", else the first tab.
  let tab: string | null = null;
  let data: SheetData | null = null;
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
  const db = store.db;
  if ((await getState(db, 'lab_results', tab))?.content_hash === contentHash) return { tab, changed: false };

  const { tests, results, warnings: w } = parseLabSheet({ ...data, tab: tab as string });
  warnings.push(...w);
  let keptFromApp = 0;
  await store.tx(async () => {
    const findTest = db.prepare('SELECT id FROM lab_tests WHERE user_id = @uid AND name = ?');
    const insertTest = db.prepare('INSERT INTO lab_tests (user_id, name, panel, position, created_at) VALUES (@uid, ?, ?, ?, ?) RETURNING id');
    const updateTest = db.prepare('UPDATE lab_tests SET panel = ?, position = ? WHERE user_id = @uid AND id = ?');
    const ids = new Map<string, number>();
    for (const t of tests) {
      const found = await findTest.get(t.name);
      if (found) await updateTest.run(t.panel, t.position, found.id);
      ids.set(t.name.toLowerCase(), found?.id ?? (await insertTest.get(t.name, t.panel, t.position, stamp)).id);
    }
    await db.prepare("DELETE FROM lab_results WHERE user_id = @uid AND source = 'sheet'").run();
    // An app row wins: one added in the app on the same date, or a correction of this sheet result
    // (found by its original date, since a correction may have moved it).
    const fromApp = db.prepare(`SELECT value_text, corrected_from_date FROM lab_results WHERE user_id = @uid AND test_id = @test AND source = 'ui'
      AND (drawn_on = @date OR corrected_from_date = @date)`);
    // A correction may have moved another result onto a date the sheet has: the app's row stays (ON CONFLICT, not a
    // caught error, since a failed statement ends a PostgreSQL transaction).
    const insert = db.prepare(`INSERT INTO lab_results (user_id, test_id, drawn_on, value, value_text, source, updated_at) VALUES (@uid, ?, ?, ?, ?, 'sheet', ?)
      ON CONFLICT (test_id, drawn_on) DO NOTHING`);
    for (const r of results) {
      const testId = ids.get(r.test.toLowerCase());
      const app = await fromApp.get({ test: testId, date: r.drawn_on });
      if (app) {
        keptFromApp += 1;
        // Corrections are expected to differ from the sheet; only a disagreeing app-added value is worth a warning.
        if (!app.corrected_from_date && app.value_text !== r.value_text) {
          warnings.push({ source: 'lab_results', tab: tab as string, kind: 'app value kept over a different sheet value', detail: `${r.test} on ${r.drawn_on}` });
        }
        continue;
      }
      if (!(await insert.run(testId, r.drawn_on, r.value, r.value_text, stamp)).changes) keptFromApp += 1;
    }
    await setState(db, 'lab_results', tab, { rowCount: (data as SheetData).firstRowNumber - 1 + (data as SheetData).rows.length, contentHash });
  });
  return { tab, changed: true, tests: tests.length, draws: new Set(results.map((r) => r.drawn_on)).size, results: results.length - keptFromApp, keptFromApp };
}

const cleanCell = (v: unknown): string => String(v ?? '').trim().toLowerCase();

async function importOnce({ store, source, key, parse, write, warnings }: {
  store: UserStore, source: SheetsSource, key: string, parse: (input: TabInput) => { records: ParsedRecord[], warnings: ParseWarning[] },
  write: (r: ParsedRecord) => Promise<number>, warnings: SyncWarning[],
}) {
  const tab = await dataTab(source, key);
  const data = await source.readRows(key, tab);
  const { records, warnings: w } = parse({ ...data, tab });
  warnings.push(...w);
  let written = 0;
  await store.tx(async () => {
    for (const r of records) written += await write(r);
    await saveState(store.db, key, tab, data);
  });
  return { rowsRead: data.rows.length, imported: written, keptFromUi: records.length - written };
}

/** The owner's date of an instant (OWNER_TZ), whatever the host's zone. */
const localDay = (d: Date): string => localDate(d);

// Replaced Workout Log rows lose their normalized columns, so they are rewritten from the dictionary.
// A missing or broken dictionary is a warning, never a failed sync.
async function normalizeLog(db: UserDb, dictionary: Dictionary | null | undefined, now: Date, warnings: SyncWarning[]) {
  let dict = dictionary;
  if (dict === undefined) {
    if (!existsSync(DICTIONARY_PATH)) return { skipped: 'no exercise dictionary' };
    try { dict = loadDictionary(); } catch (err: any) {
      warnings.push({ source: 'exercise_dictionary', kind: 'invalid dictionary, normalization skipped', detail: err.problems?.length ? `${err.problems.length} problems; run npm run log:normalize` : err.message });
      return { skipped: 'invalid exercise dictionary' };
    }
  }
  if (!dict) return { skipped: 'no exercise dictionary' };
  const { sets, mappedPct } = await normalizeAll(db, dict, { now });
  return { sets, mappedPct };
}

/** How many exercise names look like typos (metrics/name-typos.ts), for an info line; 0 without a valid dictionary. */
async function typoCount(db: UserDb, dictionary: Dictionary | null | undefined): Promise<number> {
  let dict = dictionary;
  try {
    if (dict === undefined) dict = existsSync(DICTIONARY_PATH) ? loadDictionary() : null;
  } catch {
    return 0; // an invalid dictionary is reported by normalizeLog
  }
  if (!dict) return 0;
  const found = typoCandidates({ dictionary: dict, unmapped: await unmappedNames(db), setCounts: await canonicalSetCounts(db) });
  return found.entries.length + found.unmapped.length;
}

// ---- writers: each returns a function(record) ----

// Imported rows never replace a day entered in the UI. Returns 1 when written, 0 when kept.
function upsertDrinkingDays(db: UserDb, stamp: string) {
  const stmt = db.prepare(`INSERT INTO drinking_days
    (user_id, date, beers, wine, bourbon, other, setting, mood_before, mood_after, notes, source, updated_at)
    VALUES (@uid, @date, @beers, @wine, @bourbon, @other, @setting, @mood_before, @mood_after, @notes, '${V1_SOURCE}', @updated_at)
    ON CONFLICT (user_id, date) DO UPDATE SET beers = excluded.beers, wine = excluded.wine, bourbon = excluded.bourbon,
      other = excluded.other, setting = excluded.setting, mood_before = excluded.mood_before, mood_after = excluded.mood_after,
      notes = excluded.notes, updated_at = excluded.updated_at
    WHERE drinking_days.source = '${V1_SOURCE}'`);
  return async (r: ParsedRecord) => (await stmt.run({ ...r, updated_at: stamp })).changes;
}

function upsertCheckins(db: UserDb, stamp: string) {
  const cols = ['cadence', 'readiness', 'energy', 'mood', 'stress', 'nutrition', 'weight_lbs', 'body_fat_pct', 'muscle_mass_lbs',
    'visceral_fat', 'body_measured_on', 'notes'];
  const stmt = db.prepare(`INSERT INTO checkins (user_id, date, ${cols.join(', ')}, source, updated_at)
    VALUES (@uid, @date, ${cols.map((c) => `@${c}`).join(', ')}, '${V1_SOURCE}', @updated_at)
    ON CONFLICT (user_id, date) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at
    WHERE checkins.source = '${V1_SOURCE}'`);
  return async (r: ParsedRecord) => (await stmt.run({ ...r, updated_at: stamp })).changes;
}
