// Read-then-write sequences outside server/queries.js under concurrent calls (v3 Phase 1B slice 4b, docs/adr/0006):
// account deletion, the AI cap email and the administrator's alerts each run in one transaction on the async handle, so
// two requests at once never interleave. Made-up rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { scopeDatabase } from '../db/scope.js';
import { USER_TABLES } from '../db/migrations-users.js';
import { deleteUserData } from '../server/admin-queries.js';
import { createAiAccess } from '../server/ai-access.js';
import { createAlerts } from '../server/alerts.js';
import { saveCheckin } from '../server/queries.js';

const NOW = new Date('2026-10-24T16:00:00Z');

function storeWithLee({ cap = null } = {}) {
  const store = openHealthStore(':memory:');
  store.db.prepare(`INSERT INTO users (id, email, name, role, status, created_at, health_consent_at, uses_owner_key, owner_key_cap_usd)
    VALUES ('lee', 'lee@example.com', 'Lee', 'user', 'approved', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', ?, ?)`).run(cap ? 1 : 0, cap);
  return store;
}

/** Rows of a user left anywhere: every user table, plus the users row. */
async function leftovers(adb, uid) {
  let rows = 0;
  for (const t of USER_TABLES) rows += await adb.prepare(`SELECT COUNT(*) FROM "${t}" WHERE user_id = ?`).pluck().get(uid);
  return rows + await adb.prepare('SELECT COUNT(*) FROM users WHERE id = ?').pluck().get(uid);
}

test('an account deletion racing a check-in save leaves nothing of theirs, whichever starts first', async () => {
  for (const deleteFirst of [true, false]) {
    const store = storeWithLee();
    try {
      const lee = scopeDatabase(store.adb, 'lee');
      await saveCheckin(lee, '2026-10-20', { energy: 6 });
      const save = () => saveCheckin(lee, '2026-10-21', { energy: 7, notes: 'made up' });
      const remove = () => deleteUserData(store.adb, 'lee');
      const [first, second] = await Promise.allSettled(deleteFirst ? [remove(), save()] : [save(), remove()]);
      const deleted = deleteFirst ? first : second;
      assert.equal(deleted.status, 'fulfilled');
      assert.ok(deleted.value, 'deleted');
      // Whichever statement runs first, a save that lands before the deletion is deleted with the rest.
      assert.equal(await leftovers(store.adb, 'lee'), 0, `nothing left (delete called first: ${deleteFirst})`);
      // One that arrives after it fails on the users foreign key, never left behind.
      await assert.rejects(save(), /FOREIGN KEY/);
      assert.equal(await leftovers(store.adb, 'lee'), 0);
    } finally {
      store.close();
    }
  }
});

test('two requests at the AI cap at once send one pair of emails', async () => {
  const store = storeWithLee({ cap: 1 });
  try {
    store.db.prepare("INSERT INTO runs (name, status, started_at, cost_usd, user_id) VALUES ('advisor-chat', 'ok', ?, 1.5, 'lee')").run(NOW.toISOString());
    const mail = [];
    const ai = createAiAccess({ db: store.adb, mailer: { send: async (m) => { mail.push(m.to); return true; } }, adminEmail: async () => 'owner@example.com',
      appUrl: () => 'http://localhost:5188', clock: () => NOW, log: { info() {} } });
    const results = await Promise.all([ai.check('lee'), ai.check('lee'), ai.check('lee')]);
    assert.deepEqual(results.map((r) => r.reason), ['cap', 'cap', 'cap']);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(mail.sort(), ['lee@example.com', 'owner@example.com'], 'the user and the administrator, once each');
  } finally {
    store.close();
  }
});

test('two alerts of one kind on one day at once send one email', async () => {
  const store = openHealthStore(':memory:');
  try {
    const mail = [];
    const alerts = createAlerts({ db: store.adb, mailer: { send: async (m) => { mail.push(m.subject); return true; } }, adminEmail: async () => 'owner@example.com',
      clock: () => NOW, log: { info() {} } });
    const sent = await Promise.all([alerts.alert('sync:made-up', 'a made-up failure', 'details'), alerts.alert('sync:made-up', 'a made-up failure', 'details')]);
    assert.deepEqual(sent.sort(), [false, true]);
    assert.equal(mail.length, 1);
  } finally {
    store.close();
  }
});
