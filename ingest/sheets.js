import { sheets as sheetsApi } from '@googleapis/sheets';

// Env var holding each source spreadsheet's ID.
export const SHEET_ENV = {
  health_metrics: 'HEALTH_METRICS_SHEET_ID',
  workout_sessions: 'WORKOUT_SESSIONS_SHEET_ID',
  workout_log: 'WORKOUT_LOG_SHEET_ID',
  drinking_log: 'DRINKING_LOG_SHEET_ID',
  weekly_checkin: 'WEEKLY_CHECKIN_SHEET_ID',
  lab_results: 'LAB_RESULTS_SHEET_ID',
};

/**
 * Thin read-only Sheets client (easy to fake in tests). Values come back unformatted with
 * dates as serial numbers, so parsing never depends on how a cell is displayed.
 *
 * @returns {{
 *   listTabs: (source: string) => Promise<string[]>,
 *   readRows: (source: string, tab: string, fromRow?: number) => Promise<{ header: any[], rows: any[][], firstRowNumber: number }>
 * }}
 */
export function createSheetsSource(auth, env = process.env) {
  const api = sheetsApi({ version: 'v4', auth });
  const idOf = (source) => {
    const id = env[SHEET_ENV[source]];
    if (!id) throw new Error(`${SHEET_ENV[source]} is not set in .env`);
    return id;
  };
  const values = async (source, range) =>
    (await api.spreadsheets.values.get({
      spreadsheetId: idOf(source),
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    })).data.values ?? [];

  return {
    /** Whether a spreadsheet ID is configured for this source (optional sources are skipped without one). */
    has: (source) => Boolean(env[SHEET_ENV[source]]),
    async listTabs(source) {
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
  };
}
