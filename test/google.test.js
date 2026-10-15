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
  assert.equal(exportKind('Workout session metrics-2026-03-02'), 'workouts');
  assert.equal(exportKind('Consolidated Apple Workout Sessions'), null);
});
