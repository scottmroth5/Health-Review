// The personal-data and secrets check (scripts/check-personal.js). Fake secrets are built at run time, so this file
// never matches the check itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPersonalHits, findSecretShapes, envValues, termsFile, isForbiddenPath, maskTerm } from '../scripts/check-personal.js';

test('private terms: case-insensitive, whole words, and allow terms blanked first', () => {
  const text = 'line one\nSee Dr Sample Clinic here\nsampleclinicx is a handle\nPat Example wrote this';
  assert.deepEqual(findPersonalHits(text, ['sample clinic']), [{ line: 2, term: 0 }]);
  assert.deepEqual(findPersonalHits(text, ['pat']), [{ line: 4, term: 0 }]);
  assert.deepEqual(findPersonalHits('github.com/patexample/repo', ['pat']), [], 'not inside a word');
  assert.deepEqual(findPersonalHits('by Pat Example', ['pat'], ['Pat Example']), [], 'allowed text is skipped');
  assert.equal(maskTerm('abcdefghij'), 'ab***j (10 chars)');
});

test('.env values: app options and comments skipped; short values ignored; quotes removed', () => {
  const env = ['OWNER_TZ=America/New_York', 'SCHEDULE_SYNC=daily 07:00', 'AUTH_MODE=google', '# SECRET_X=commented-out-value',
    'SESSION_SECRET="a-long-secret-value"', 'PORT=5188', 'SHORT=abc', 'SHEET_ID=1AbCdEfGhIjKlMn'].join('\n');
  assert.deepEqual(envValues(env), ['a-long-secret-value', '1AbCdEfGhIjKlMn']);
});

test('the owner terms file: one per line, allow lines, comments skipped', () => {
  assert.deepEqual(termsFile('# my terms\nSample Clinic\n\nallow: Sample Clinic Way\nDr Example\n'),
    { terms: ['Sample Clinic', 'Dr Example'], allowTerms: ['Sample Clinic Way'] });
});

test('forbidden paths: data/, .env files, health exports, keys, tokens and backups', () => {
  for (const f of ['data/health.db', 'data/ssh/key', '.env', 'deploy/.env.local', 'export.csv', 'apple/export.xml',
    'key.pem', 'health-2026-10-05.hrbk', 'token.json', 'tools/google/client_secret_123.json']) assert.ok(isForbiddenPath(f), f);
  for (const f of ['server/app.js', 'deploy/cloud.env.example', 'config/health-targets.json', 'evals/fixtures/metrics/zones.json']) assert.ok(!isForbiddenPath(f), f);
});

test('secret shapes are caught; near misses are not', () => {
  const x = (n) => 'x1Y2'.repeat(n);
  const secrets = [
    `key=${'sk-' + 'ant-'}${x(8)}`,
    `${'AI' + 'za'}${'A'.repeat(35)}`,
    `${'GOC' + 'SPX-'}${x(6)}`,
    `${'gh' + 'p_'}${x(9)}`,
    `${'github' + '_pat_'}${x(9)}`,
    `${'-----BEGIN'} OPENSSH ${'PRIVATE KEY-----'}`,
  ];
  for (const s of secrets) assert.equal(findSecretShapes(s).length, 1, s.slice(0, 12));
  for (const s of ['sk-ant-short', 'AIza too short', 'ghp_short', 'BEGIN PUBLIC KEY', 'the GOCSPX prefix']) {
    assert.equal(findSecretShapes(s).length, 0, s);
  }
});
