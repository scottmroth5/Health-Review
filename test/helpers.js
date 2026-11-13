// Shared test helpers. Synthetic data only.
import { scopeStore } from '../db/scope.js';
import { openHealthStore } from '../db/store.js';
import { OWNER_ID } from '../db/users.js';

const EPOCH_MS = Date.UTC(1899, 11, 30);

/** Sheets serial for a local wall-clock time: serial('2026-03-02', 3) is 03:00 that day. */
export function serial(date, hours = 0, minutes = 0, seconds = 0) {
  const [y, m, d] = date.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - EPOCH_MS) / 864e5 + (hours * 3600 + minutes * 60 + seconds) / 86400;
}

/**
 * In-memory stand-in for createSheetsSource. tabs: { [source]: { [tab]: values } }.
 * Records every read so tests can check what was fetched.
 */
export function fakeSource(tabs) {
  const reads = [];
  return {
    tabs,
    reads,
    has: (source) => source in tabs,
    async listTabs(source) {
      return Object.keys(tabs[source] ?? {});
    },
    async readRows(source, tab, fromRow = 2) {
      reads.push({ source, tab, fromRow });
      const values = tabs[source]?.[tab];
      if (!values) throw new Error(`fake: no tab ${source}/${tab}`);
      const start = Math.max(2, fromRow);
      return { header: values[0] ?? [], rows: values.slice(start - 1), firstRowNumber: start };
    },
    // Health Auto Export files: exports = [{ folder, id, name, modifiedTime, values (Sheets files) or json (JSON
    // workouts) }]; kind follows the file name, as in the real source, so a file of the other kind in a folder is left out.
    exports: [],
    async listExports(folderId, kind) {
      const { exportKind } = await import('../ingest/sheets.js');
      return this.exports.filter((f) => f.folder === folderId && exportKind(f.name, kind) === kind)
        .map(({ values: _, folder: __, json: ___, ...f }) => ({ ...f, kind })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async readFileRows(fileId) {
      reads.push({ file: fileId });
      const f = this.exports.find((x) => x.id === fileId);
      if (!f) throw new Error(`fake: no export file ${fileId}`);
      return { header: f.values[0] ?? [], rows: f.values.slice(1), firstRowNumber: 2 };
    },
    async readFileJson(fileId) {
      reads.push({ file: fileId });
      const f = this.exports.find((x) => x.id === fileId);
      if (!f) throw new Error(`fake: no export file ${fileId}`);
      return structuredClone(f.json);
    },
  };
}

/** A fake Anthropic SDK client: the same create for the plain and beta Messages endpoints (fallbacks use the beta one). */
export const fakeClaudeClient = (create) => ({ messages: { create }, beta: { messages: { create } } });

/**
 * One Health Auto Export JSON workout (Export Version 2 shape). Times are local wall clock, "YYYY-MM-DD HH:MM:SS";
 * hr: per-minute average bpm from the start minute on.
 */
export function jsonWorkout(name, start, end, { duration, avgHr = null, maxHr = null, activeKcal = null, distanceMi = null, hr = [] } = {}) {
  const at = (t) => `${t} -0400`;
  const q = (qty, units) => (qty === null ? undefined : { qty, units });
  const t0 = Date.parse(`${start.replace(' ', 'T')}Z`);
  const minute = (i) => new Date(t0 + i * 60000).toISOString().slice(0, 19).replace('T', ' ');
  return {
    name, start: at(start), end: at(end), duration: duration ?? (Date.parse(`${end.replace(' ', 'T')}Z`) - t0) / 1000,
    avgHeartRate: q(avgHr, 'bpm'), maxHeartRate: q(maxHr, 'bpm'), activeEnergyBurned: q(activeKcal, 'kcal'), distance: q(distanceMi, 'mi'),
    heartRateData: hr.map((bpm, i) => ({ date: at(minute(i)), Avg: bpm, Min: bpm - 2, Max: bpm + 2, units: 'bpm', source: 'Sample Watch' })),
  };
}

export const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

/** The engine the suite runs on: TEST_DB=postgres (with DATABASE_URL) runs it on PostgreSQL, else SQLite in memory. */
export const TEST_ENGINE = process.env.TEST_DB === 'postgres' ? 'postgres' : 'sqlite';
if (TEST_ENGINE === 'postgres' && !process.env.DATABASE_URL) throw new Error('TEST_DB=postgres needs DATABASE_URL');

/**
 * A new migrated store on the test engine, unscoped like openHealthStore(":memory:"): SQLite in memory, or a fresh
 * PostgreSQL database (test/pg.js). close() is async on PostgreSQL; await it.
 */
export async function openTestStore() {
  if (TEST_ENGINE === 'sqlite') return openHealthStore(':memory:');
  const { freshPgStore } = await import('./pg.js');
  return freshPgStore();
}

/** openTestStore scoped to the owner, like openOwnerStore(":memory:"). */
export async function ownerStore() {
  return scopeStore(await openTestStore(), OWNER_ID);
}

/**
 * A test store scoped to one user (the owner unless uid is given, which is added as an approved user): db and tx, the
 * syncDb on SQLite only, shared (the unscoped store), and close.
 */
export async function memoryStore({ uid = OWNER_ID } = {}) {
  const shared = await openTestStore();
  if (uid !== OWNER_ID) {
    await shared.db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES (?, ?, 'user', 'approved', 'x')").run(uid, `${uid}@example.com`);
  }
  return { ...scopeStore(shared, uid), shared, close: () => shared.close() };
}

/**
 * A store holding the demo's made-up data for today (demo/generate.js), unscoped, on the test engine: built on SQLite,
 * then copied row for row into PostgreSQL when the suite runs there (test/copy-rows.js).
 */
export async function demoStore({ today } = {}) {
  const { refreshDemoDatabase } = await import('../demo/generate.js');
  const built = openHealthStore(':memory:');
  await refreshDemoDatabase(built, { today });
  if (TEST_ENGINE === 'sqlite') return built;
  const { copyRows } = await import('./copy-rows.js');
  const store = await openTestStore();
  try {
    await copyRows(built, store);
  } finally {
    built.close();
  }
  return store;
}
