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
    // Health Auto Export files: exports = [{ kind, id, name, modifiedTime, values }].
    exports: [],
    async listExports() {
      return this.exports.map(({ values: _, ...f }) => f).sort((a, b) => a.name.localeCompare(b.name));
    },
    async readFileRows(fileId) {
      reads.push({ file: fileId });
      const f = this.exports.find((x) => x.id === fileId);
      if (!f) throw new Error(`fake: no export file ${fileId}`);
      return { header: f.values[0] ?? [], rows: f.values.slice(1), firstRowNumber: 2 };
    },
  };
}

export const silentLogger = { info() {}, warn() {}, error() {}, log() {} };
