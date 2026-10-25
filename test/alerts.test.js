// Emails to the administrator when something needs attention (server/alerts.js): at most one per kind a day, data
// checks once until they clear, and again after recovery. A fake mailer; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { createAlerts } from '../server/alerts.js';

function setup() {
  const store = openHealthStore(':memory:');
  const mail = [];
  let now = new Date('2026-10-25T16:00:00Z');
  const alerts = createAlerts({ db: store.db, mailer: { send: async (m) => { mail.push(m); return true; } }, adminEmail: () => 'owner@example.com',
    appUrl: () => 'https://app.example.com', clock: () => now, log: { info() {} } });
  return { alerts, mail, later: (hours) => { now = new Date(now.getTime() + hours * 3600_000); } };
}

test('a job failure emails once a day, and again after it recovers', async () => {
  const { alerts, mail, later } = setup();
  assert.equal(await alerts.alert('backup', 'the backup failed', 'The scheduled backup failed (Error).'), true);
  assert.equal(await alerts.alert('backup', 'the backup failed', 'again'), false, 'once a day');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'owner@example.com');
  assert.equal(mail[0].subject, 'Health Review: the backup failed');
  assert.match(mail[0].text, /#activity/);
  later(24);
  assert.equal(await alerts.alert('backup', 'the backup failed', 'next day'), true, 'still failing the next day: one more');
  alerts.recovered('backup');
  assert.equal(await alerts.alert('backup', 'the backup failed', 'failed again'), true, 'a fresh failure after recovery');
  assert.equal(await alerts.alert('sync:a', 'x', 'y'), true, 'kinds are separate');
});

test('data checks: the owner\'s stale export emails once until it clears; info checks and others never', async () => {
  const { alerts, mail, later } = setup();
  const stale = [{ source: 'data_check', kind: 'export_stale', severity: 'warn', detail: 'No health export since 2026-10-23' },
    { source: 'data_check', kind: 'partial_day', severity: 'warn', detail: 'x' }, { source: 'data_check', kind: 'workouts_missing', severity: 'info', detail: 'y' }];
  await alerts.dataChecks(stale);
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /Health Auto Export automation stopped/);
  assert.match(mail[0].text, /2026-10-23/);
  later(48);
  await alerts.dataChecks(stale);
  assert.equal(mail.length, 1, 'not again while it stays stale');
  await alerts.dataChecks([]);
  await alerts.dataChecks(stale);
  assert.equal(mail.length, 2, 'stale again after it cleared');
});
