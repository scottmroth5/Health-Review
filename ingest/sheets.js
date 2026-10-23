import { sheets as sheetsApi } from '@googleapis/sheets';

// Env var holding each source spreadsheet's ID. Apple Health comes from Health Auto Export's files instead (the v1
// consolidated health and workout sheets are retired).
export const SHEET_ENV = {
  workout_log: 'WORKOUT_LOG_SHEET_ID',
  drinking_log: 'DRINKING_LOG_SHEET_ID',
  weekly_checkin: 'WEEKLY_CHECKIN_SHEET_ID',
  lab_results: 'LAB_RESULTS_SHEET_ID',
};

/** Google allows 60 Sheets read requests a minute per user; reads are spaced at least this far apart (about 54 a minute). */
export const SHEETS_READ_GAP_MS = 1100;

/**
 * Spaces calls at least minGapMs apart, in call order (concurrent callers each get their own slot).
 * @returns {() => Promise<void>} await it before each request
 */
export function createPacer(minGapMs, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let next = 0;
  return async () => {
    const t = now();
    const wait = Math.max(0, next - t);
    next = Math.max(t, next) + minGapMs;
    if (wait) await sleep(wait);
  };
}

/**
 * Thin read-only Sheets client (easy to fake in tests). Values come back unformatted with
 * dates as serial numbers, so parsing never depends on how a cell is displayed.
 *
 * @returns {{
 *   listTabs: (source: string) => Promise<string[]>,
 *   readRows: (source: string, tab: string, fromRow?: number) => Promise<{ header: any[], rows: any[][], firstRowNumber: number }>
 * }}
 */
export function createSheetsSource(auth, env = process.env, { minGapMs = SHEETS_READ_GAP_MS, pacer } = {}) {
  const api = sheetsApi({ version: 'v4', auth });
  // Every Sheets read shares one pace, so export files, the Workout Log and labs together stay under Google's limit.
  const pace = pacer ?? createPacer(minGapMs);
  const idOf = (source) => {
    const id = env[SHEET_ENV[source]];
    if (!id) throw new Error(`${SHEET_ENV[source]} is not set in .env`);
    return id;
  };
  const values = async (source, range) => {
    await pace();
    return (await api.spreadsheets.values.get({
      spreadsheetId: idOf(source),
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    })).data.values ?? [];
  };

  return {
    /** Whether a spreadsheet ID is configured for this source (optional sources are skipped without one). */
    has: (source) => Boolean(env[SHEET_ENV[source]]),
    async listTabs(source) {
      await pace();
      const { data } = await api.spreadsheets.get({ spreadsheetId: idOf(source), fields: 'sheets.properties.title' });
      return (data.sheets ?? []).map((s) => s.properties.title);
    },
    /** Header row plus rows from fromRow (1-based sheet row, default 2) to the last row with data. */
    async readRows(source, tab, fromRow = 2) {
      const quoted = `'${tab.replaceAll("'", "''")}'`;
      if (fromRow <= 2) {
        const [header = [], ...rows] = await values(source, quoted);
        return { header, rows, firstRowNumber: 2 };
      }
      const [[header = []], rows] = await Promise.all([values(source, `${quoted}!1:1`), values(source, `${quoted}!A${fromRow}:ZZ`)]);
      return { header, rows, firstRowNumber: fromRow };
    },
    /**
     * Health Auto Export's own export files of one kind in a Drive folder, oldest name first: kind, id, name and
     * modified time. 'health' files are Google Sheets (read with readFileRows); 'workouts' files are JSON (Workouts
     * export, Version 2; read with readFileJson). Files of another kind are left out. Metadata only.
     */
    async listExports(folderId, kind) {
      const files = [];
      let pageToken;
      const mime = kind === 'health' ? 'application/vnd.google-apps.spreadsheet' : 'application/json';
      do {
        const params = new URLSearchParams({
          q: `'${folderId.replaceAll("'", "\\'")}' in parents and mimeType = '${mime}' and trashed = false`,
          fields: 'nextPageToken, files(id, name, modifiedTime)',
          pageSize: '1000',
          orderBy: 'name',
          ...(pageToken ? { pageToken } : {}),
        });
        const { data } = await auth.request({ url: `https://www.googleapis.com/drive/v3/files?${params}` });
        for (const f of data.files ?? []) {
          if (exportKind(f.name, kind) === kind) files.push({ kind, id: f.id, name: f.name, modifiedTime: f.modifiedTime });
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
      return files.sort((a, b) => a.name.localeCompare(b.name));
    },
    /** One export file's first tab: header row plus every row, unformatted with serial dates. */
    async readFileRows(fileId) {
      await pace();
      const values = (await api.spreadsheets.values.get({
        spreadsheetId: fileId, range: 'A1:ZZ', valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER',
      })).data.values ?? [];
      const [header = [], ...rows] = values;
      return { header, rows, firstRowNumber: 2 };
    },
    /** One JSON export file, parsed (drive.readonly; the caller only passes ids listed from its configured folder). */
    async readFileJson(fileId) {
      await pace();
      const { data } = await auth.request({ url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, responseType: 'json' });
      return typeof data === 'string' ? JSON.parse(data) : data;
    },
  };
}

/** Which Health Auto Export file a name is, or null: health metrics (Google Sheets) or JSON workouts (one file a day). */
export function exportKind(name, wanted = null) {
  if (/Apple Health Metrics-HealthMetrics/i.test(name)) return 'health';
  if (/^HealthAutoExport-\d{4}-\d{2}-\d{2}\.json$/i.test(name)) return 'workouts';
  // Health metrics as JSON are named after their automation ("Apple Health Metrics-DATE.json", "Stand Hours-DATE.json"),
  // so in a health folder any dated JSON file counts; the parser checks its shape (data.metrics).
  if (wanted === 'health_json' && /-\d{4}-\d{2}-\d{2}\.json$/i.test(name)) return 'health_json';
  return null;
}
