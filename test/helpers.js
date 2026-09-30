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
  };
}

export const silentLogger = { info() {}, warn() {}, error() {}, log() {} };
