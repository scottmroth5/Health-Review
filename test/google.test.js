import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGoogleAuth, loadClientCredentials } from '../tools/google/auth.js';

test('client credentials and refresh token come from env first, then files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-review-'));
  try {
    const secretPath = join(dir, 'client_secret.json');
    const tokenPath = join(dir, 'token.json');
    writeFileSync(secretPath, JSON.stringify({ installed: { client_id: 'file-id', client_secret: 'file-secret' } }));
    assert.deepEqual(loadClientCredentials({ path: secretPath, env: {} }), { clientId: 'file-id', clientSecret: 'file-secret' });
    assert.deepEqual(
      loadClientCredentials({ path: secretPath, env: { GOOGLE_CLIENT_ID: 'env-id', GOOGLE_CLIENT_SECRET: 'env-secret' } }),
      { clientId: 'env-id', clientSecret: 'env-secret' },
    );

    assert.throws(() => getGoogleAuth({ clientSecretPath: secretPath, tokenPath, env: {} }), /google:login/);
    writeFileSync(tokenPath, JSON.stringify({ refresh_token: 'file-refresh' }));
    assert.equal(getGoogleAuth({ clientSecretPath: secretPath, tokenPath, env: {} }).credentials.refresh_token, 'file-refresh');
    const fromEnv = getGoogleAuth({ clientSecretPath: secretPath, tokenPath, env: { GOOGLE_REFRESH_TOKEN: 'env-refresh' } });
    assert.equal(fromEnv.credentials.refresh_token, 'env-refresh');

    assert.throws(() => loadClientCredentials({ path: join(dir, 'missing.json'), env: {} }), /Desktop-app/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export files: Health Auto Export names map to their kind; anything else is ignored', async () => {
  const { exportKind } = await import('../ingest/sheets.js');
  assert.equal(exportKind('HealthAutoExport-2026-03-02 Apple Health Metrics-HealthMetrics-2026-03-02'), 'health');
  assert.equal(exportKind('HealthAutoExport-2026-03-02.json'), 'workouts'); // JSON workouts, one file a day
  assert.equal(exportKind('Workout session metrics-2026-03-02'), null); // the Sheets-format workout export, retired
  assert.equal(exportKind('Consolidated Apple Workout Sessions'), null);
});

test('reads are paced: each waits until the gap since the one before has passed, in call order', async () => {
  const { createPacer } = await import('../ingest/sheets.js');
  let t = 1000;
  const waits = [];
  const pace = createPacer(1100, { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  await pace(); // first: no wait
  await pace(); // right after: waits the full gap
  t += 5000;
  await pace(); // long after: no wait
  await Promise.all([pace(), pace()]); // two at once: the second waits one gap more
  assert.deepEqual(waits, [1100, 1100, 1100]);
});
