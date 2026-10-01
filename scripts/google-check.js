// Confirms the Google sign-in can read each configured spreadsheet. Prints only tab names
// and row counts (never cell contents).
//   npm run google:check
import { sheets as sheetsApi } from '@googleapis/sheets';
import { getGoogleAuth } from '../tools/google/auth.js';
import { SHEET_ENV } from '../ingest/sheets.js';

const SHEET_ENV_KEYS = Object.values(SHEET_ENV);

async function main() {
  const configured = SHEET_ENV_KEYS.filter((key) => process.env[key]);
  const missing = SHEET_ENV_KEYS.filter((key) => !process.env[key]);
  if (!configured.length) throw new Error(`No sheet IDs in .env. Add: ${SHEET_ENV_KEYS.join(', ')}`);

  const api = sheetsApi({ version: 'v4', auth: getGoogleAuth() });
  let failed = 0;
  for (const key of configured) {
    try {
      const { data } = await api.spreadsheets.get({
        spreadsheetId: process.env[key],
        fields: 'sheets.properties(title,gridProperties.rowCount)',
      });
      const tabs = (data.sheets ?? []).map((s) => `${s.properties.title} (${s.properties.gridProperties?.rowCount ?? 0} rows)`);
      console.log(`${key}: ok, tabs: ${tabs.join(', ')}`);
    } catch (err) {
      failed += 1;
      const status = err.response?.status ?? err.code;
      console.error(`${key}: failed${status ? ` (${status})` : ''}: ${err.message}`);
      if (/invalid_grant/.test(err.message)) throw new Error('The saved sign-in is no longer valid. Run "npm run google:login".');
      if (status === 403 || status === 404) {
        console.error('  Check the ID and that you signed in with the account that owns or can view this sheet.');
      }
    }
  }
  if (missing.length) console.log(`Not set in .env (skipped): ${missing.join(', ')}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Google check failed: ${err.message}`);
  process.exitCode = 1;
});
