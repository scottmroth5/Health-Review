// The engine helpers (db/dialect.js) and store opening (db/store.js openStore) give the same answers on SQLite and
// PostgreSQL. Made-up rows only; the PostgreSQL half is skipped without DATABASE_URL (test/pg.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore, openStore } from '../db/store.js';
import { isUniqueViolation, jsonText, listTables, primaryKey, tableColumns } from '../db/dialect.js';
import { OWNER_ID } from '../db/users.js';
import { scopeStore } from '../db/scope.js';
import { listChat } from '../agent/advisor-chat.js';
import { fixSessionTimes } from '../ingest/session-times.js';
import { freshPgDatabase, pgSkip } from './pg.js';

const quiet = { info() {} };

/** Runs body against a SQLite store and, with a server, a PostgreSQL one. */
function onBothEngines(name, body) {
  test(`${name} (SQLite)`, async () => {
    const store = openHealthStore(':memory:', { log: quiet });
    try { await body(store, 'sqlite'); } finally { store.close(); }
  });
  test(`${name} (PostgreSQL)`, { skip: pgSkip }, async () => {
    const fresh = await freshPgDatabase();
    const store = await openStore({ url: fresh.url });
    try { await body(store, 'postgres'); } finally { await store.close(); await fresh.drop(); }
  });
}

onBothEngines('jsonText reads a string field of a JSON text column', async ({ db }) => {
  await db.prepare("INSERT INTO runs (name, meta, started_at, user_id) VALUES ('review', ?, 'x', ?)").run(JSON.stringify({ weekEnd: '2026-01-03', n: 1 }), OWNER_ID);
  await db.prepare("INSERT INTO runs (name, meta, started_at, user_id) VALUES ('review', ?, 'x', ?)").run(JSON.stringify({ weekEnd: '2026-01-10' }), OWNER_ID);
  assert.deepEqual(await db.prepare(`SELECT id FROM runs WHERE ${jsonText(db, 'meta', 'weekEnd')} = ?`).pluck().all('2026-01-10'), [2]);
  assert.throws(() => jsonText(db, 'meta', "x') OR 1=1 --"), /Not a plain identifier/);
});

onBothEngines('listTables, tableColumns and primaryKey read the schema', async ({ db }, engine) => {
  const tables = await listTables(db);
  for (const t of ['users', 'runs', 'daily_metrics', 'medication_doses', 'usage_totals', 'schema_migrations']) assert.ok(tables.includes(t), t);
  assert.equal(tables.some((t) => t.startsWith('sqlite_')), false);
  assert.deepEqual(tables, [...tables].sort());
  assert.deepEqual(await tableColumns(db, 'settings'), ['user_id', 'key', 'value', 'updated_at']);
  assert.deepEqual(await primaryKey(db, 'medication_doses'), ['date', 'medication_id', 'timing']);
  assert.deepEqual(await primaryKey(db, 'runs'), ['id']);
  await assert.rejects(async () => tableColumns(db, 'users; DROP TABLE users'), /Not a plain identifier/);
  assert.ok(engine);
});

onBothEngines('isUniqueViolation knows a duplicate key on either engine, and nothing else', async ({ db }) => {
  const add = () => db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, 'k', 'v', 'x')").run(OWNER_ID);
  await add();
  const dup = await add().then(() => null, (err) => err);
  assert.ok(isUniqueViolation(dup), `a duplicate key: ${dup?.code}`);
  const missingParent = await db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES ('nobody', 'k', 'v', 'x')").run().then(() => null, (err) => err);
  assert.ok(missingParent);
  assert.equal(isUniqueViolation(missingParent), false);
  assert.equal(isUniqueViolation(new Error('UNIQUE')), false);
});

onBothEngines('the chat thread is oldest first, and on a tie the owner\'s note comes before the reply', async (store) => {
  const { db } = scopeStore(store, OWNER_ID);
  const add = (id, at, role) => db.prepare("INSERT INTO advisor_notes (user_id, id, created_at, role, text) VALUES (@uid, ?, ?, ?, 't')").run(id, at, role);
  await add('b', '2026-01-01T10:00:00.000Z', 'claude');
  await add('a', '2026-01-01T10:00:00.000Z', 'owner');
  await add('c', '2026-01-01T09:00:00.000Z', 'owner');
  assert.deepEqual((await listChat(db)).map((n) => n.id), ['c', 'a', 'b']);
});

onBothEngines('the one-off workout time fix runs on SQLite only', async (store, engine) => {
  const owner = scopeStore(store, OWNER_ID);
  if (engine === 'sqlite') assert.equal((await fixSessionTimes(owner)).applied, false);
  else await assert.rejects(fixSessionTimes(owner), /SQLite only/);
});

test('openStore opens SQLite without a url and brings the owner email in step with the environment', async () => {
  const before = process.env.OWNER_EMAIL;
  process.env.OWNER_EMAIL = 'owner@example.test';
  try {
    const store = await openStore({ url: '', path: ':memory:', log: quiet });
    try {
      assert.equal(store.db.engine, 'sqlite');
      assert.equal(await store.db.prepare('SELECT email FROM users WHERE id = ?').pluck().get(OWNER_ID), 'owner@example.test');
    } finally {
      store.close();
    }
  } finally {
    if (before === undefined) delete process.env.OWNER_EMAIL;
    else process.env.OWNER_EMAIL = before;
  }
});

test('openStore opens PostgreSQL with a url, with the owner as user 1', { skip: pgSkip }, async () => {
  const fresh = await freshPgDatabase();
  const store = await openStore({ url: fresh.url });
  try {
    assert.equal(store.db.engine, 'postgres');
    assert.equal(store.raw, null);
    assert.equal(store.syncDb, null);
    assert.equal(await store.db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 1, 'the owner row');
  } finally {
    await store.close();
    await fresh.drop();
  }
});
