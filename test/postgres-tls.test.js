// In production a remote database must be reached over verified TLS (db/postgres.ts checkTls, v3 Phase 1G).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTls } from '../db/postgres.ts';

const prod = { NODE_ENV: 'production' };
const CA = 'sslrootcert=/app/certs/rds-global-bundle.pem';

test('checkTls: a remote host in production needs verify-full and a root certificate', () => {
  assert.throws(() => checkTls('postgres://u:p@db.example.com:5432/x', prod), /verify-full/);
  assert.throws(() => checkTls('postgres://u:p@db.example.com/x?sslmode=require', prod), /verify-full/);
  assert.throws(() => checkTls('postgres://u:p@db.example.com/x?sslmode=verify-full', prod), /sslrootcert/);
  assert.doesNotThrow(() => checkTls(`postgres://u:p@db.example.com/x?sslmode=verify-full&${CA}`, prod));
});

test('checkTls: loopback, Unix sockets and non-production are exempt; errors never echo the URL', () => {
  assert.doesNotThrow(() => checkTls('postgres://u:p@127.0.0.1:55432/x', prod));
  assert.doesNotThrow(() => checkTls('postgres://u:p@localhost/x', prod));
  assert.doesNotThrow(() => checkTls('postgres://u:p@%2Ftmp%2Fsock/x', prod));
  assert.doesNotThrow(() => checkTls('postgres://u:p@db.example.com/x', { NODE_ENV: 'test' }));
  assert.throws(() => checkTls('not a url secret-password', prod), (err) => !err.message.includes('secret-password'));
  assert.throws(() => checkTls('postgres://u:secret-password@db.example.com/x', prod), (err) => !err.message.includes('secret-password'));
});
