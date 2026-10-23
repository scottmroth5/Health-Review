// Shared test helpers. Synthetic data only.
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
