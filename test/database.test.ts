// The async database interface (db/database.ts) and its scoping (db/scope.js scopeDatabase). Made-up rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteDatabase, guardSyncDatabase, TransactionConflictError } from '../db/database.ts';
import { scopeDatabase } from '../db/scope.js';
import { OWNER_ID } from '../db/users.js';
import { openHealthStore } from '../db/store.js';
import { memoryStore } from './helpers.js';

const deferred = () => {
  let resolve!: (v?: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));

// The SQLite adapter itself (its sync handle and raw), so a SQLite store on either test engine.
function scratch() {
  const store = openHealthStore(':memory:');
  store.raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
  return store;
}

test('statements: get, all, run and pluck give what better-sqlite3 gives, as promises', async () => {
  const store = scratch();
  try {
    const { db: adb, raw } = store;
    const inserted = await adb.prepare('INSERT INTO t (name, n) VALUES (?, ?) RETURNING id').get('a', 1);
    assert.deepEqual(inserted, { id: 1 });
    await adb.prepare('INSERT INTO t (name, n) VALUES (@name, @n)').run({ name: 'b', n: 2 });
    assert.deepEqual(await adb.prepare('SELECT name, n FROM t ORDER BY id').all(), raw.prepare('SELECT name, n FROM t ORDER BY id').all());
    assert.deepEqual(await adb.prepare('SELECT * FROM t WHERE id = ?').get(2), raw.prepare('SELECT * FROM t WHERE id = ?').get(2));
    assert.equal(await adb.prepare('SELECT COUNT(*) FROM t').pluck().get(), 2);
    assert.deepEqual(await adb.prepare('SELECT name FROM t ORDER BY id').pluck().all(), ['a', 'b']);
    assert.deepEqual(await adb.prepare('UPDATE t SET n = n + 1').run(), { changes: 2 });
    assert.equal(await adb.prepare('SELECT * FROM t WHERE id = 99').get(), undefined);
    await assert.rejects(adb.prepare('SELECT * FROM t WHERE id = ?').get(), /Too few parameter/);
    await adb.exec('DELETE FROM t');
    assert.equal(raw.prepare('SELECT COUNT(*) FROM t').pluck().get(), 0);
    assert.equal(createSqliteDatabase(raw), store.db, 'one interface per connection');
  } finally {
    store.close();
  }
});

test('tx: commits on resolve, rolls back on throw, and a nested tx is a savepoint that rolls back alone', async () => {
  const store = scratch();
  try {
    const { db: adb } = store;
    const insert = (name: string) => adb.prepare('INSERT INTO t (name) VALUES (?)').run(name);
    const names = () => adb.prepare('SELECT name FROM t ORDER BY id').pluck().all();

    assert.equal(await adb.tx(async () => { await insert('kept'); return 'done'; }), 'done');
    await assert.rejects(adb.tx(async () => { await insert('dropped'); throw new Error('stop'); }), /stop/);
    assert.deepEqual(await names(), ['kept']);

    await adb.tx(async () => {
      await insert('outer');
      await assert.rejects(adb.tx(async () => { await insert('inner'); throw new Error('inner fails'); }));
      await adb.tx(async () => { await insert('inner kept'); });
    });
    assert.deepEqual(await names(), ['kept', 'outer', 'inner kept']);
    assert.equal(store.raw.inTransaction, false);
  } finally {
    store.close();
  }
});

test('tx: concurrent transactions never interleave, so read then write loses no update', async () => {
  const store = scratch();
  try {
    const { db: adb } = store;
    await adb.prepare("INSERT INTO t (id, name, n) VALUES (1, 'counter', 0)").run();
    const bump = () => adb.tx(async () => {
      const n = await adb.prepare('SELECT n FROM t WHERE id = 1').pluck().get();
      await tick(); // another request would run here
      await adb.prepare('UPDATE t SET n = ? WHERE id = 1').run(n + 1);
    });
    await Promise.all(Array.from({ length: 20 }, bump));
    assert.equal(await adb.prepare('SELECT n FROM t WHERE id = 1').pluck().get(), 20);
  } finally {
    store.close();
  }
});

test('tx: a statement from outside waits for the open transaction and never sees its uncommitted rows', async () => {
  const store = scratch();
  try {
    const { db: adb } = store;
    const opened = deferred();
    const finish = deferred();
    const order: string[] = [];
    const writer = adb.tx(async () => {
      await adb.prepare("INSERT INTO t (name) VALUES ('pending')").run();
      opened.resolve();
      await finish.promise;
      order.push('commit');
    });
    await opened.promise;
    const reader = adb.prepare('SELECT COUNT(*) FROM t').pluck().get().then((n) => { order.push('read'); return n; });
    await tick();
    assert.deepEqual(order, [], 'the read waits');
    finish.resolve();
    await writer;
    assert.equal(await reader, 1, 'it reads after the commit');
    assert.deepEqual(order, ['commit', 'read']);
  } finally {
    store.close();
  }
});

test('tx: the lock is released when the body throws and when the transaction is already gone', async () => {
  const store = scratch();
  try {
    const { db: adb, raw } = store;
    await assert.rejects(adb.tx(async () => { raw.exec('ROLLBACK'); throw new Error('ended early'); }), /ended early/);
    await assert.rejects(adb.tx(async () => { raw.exec('COMMIT'); }), /no transaction is active/);
    assert.equal(raw.inTransaction, false);
    await adb.tx(async () => { await adb.prepare("INSERT INTO t (name) VALUES ('after')").run(); });
    assert.equal(await adb.prepare('SELECT COUNT(*) FROM t').pluck().get(), 1);
  } finally {
    store.close();
  }
});

test('the sync handle throws during another context\'s transaction, and works inside its own', async () => {
  const store = scratch();
  try {
    const { db: adb, syncDb: db } = store;
    const opened = deferred();
    const finish = deferred();
    const writer = adb.tx(async () => {
      db.prepare("INSERT INTO t (name) VALUES ('sync inside')").run(); // the owning context: fine
      opened.resolve();
      await finish.promise;
    });
    await opened.promise;
    assert.throws(() => db.prepare('SELECT COUNT(*) FROM t').pluck().get(), TransactionConflictError);
    assert.throws(() => db.prepare("INSERT INTO t (name) VALUES ('x')").run(), TransactionConflictError);
    assert.throws(() => store.syncDb.transaction(() => {})(), TransactionConflictError);
    assert.throws(() => db.exec('DELETE FROM t'), TransactionConflictError);
    finish.resolve();
    await writer;
    assert.equal(db.prepare('SELECT COUNT(*) FROM t').pluck().get(), 1, 'free again once it ends');
    assert.equal(guardSyncDatabase(store.raw).prepare('SELECT 1').pluck().get(), 1);
  } finally {
    store.close();
  }
});

// Why the guard never fires in the app (ADR 0006): on SQLite every awaited statement settles at once, so a transaction
// that awaits only statements runs to its end in the microtask queue, before any other request (its own event-loop task).
test('a transaction that awaits only statements finishes before a sync-handle read queued beside it', async () => {
  const store = scratch();
  try {
    const { db: adb, syncDb: db } = store;
    const seen: unknown[] = [];
    const reader = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        try { seen.push(db.prepare('SELECT COUNT(*) FROM t').pluck().get()); resolve(); } catch (err) { reject(err as Error); }
      });
    });
    const insert = adb.prepare('INSERT INTO t (name, n) VALUES (?, ?)');
    await adb.tx(async () => {
      for (let i = 0; i < 2000; i++) await insert.run(`row ${i}`, i);
    });
    await reader;
    assert.deepEqual(seen, [2000], 'no TransactionConflictError, and the committed rows');
  } finally {
    store.close();
  }
});

test('scopeDatabase binds @uid, never reads another user\'s rows, and fails unscoped', async () => {
  const store = await memoryStore({ uid: 'user-b' });
  try {
    const owner = store.shared.db;
    await owner.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, 'k', 'owner', 'x')").run(OWNER_ID);
    const b = store.db;
    await b.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, 'x')").run('k', 'mine');
    assert.deepEqual(await b.prepare('SELECT value FROM settings WHERE user_id = @uid').pluck().all(), ['mine']);
    assert.deepEqual(await b.prepare('SELECT CAST(? AS INTEGER) AS a, CAST(@x AS INTEGER) AS x, @uid AS u').get(7, { x: 8 }), { a: 7, x: 8, u: 'user-b' });
    assert.equal(b.uid, 'user-b');
    assert.equal(scopeDatabase(b, 'other').unscoped, owner, 'a scoped database is unwrapped first');
    await assert.rejects(owner.prepare('SELECT value FROM settings WHERE user_id = @uid').all(), /Missing named parameter/);
    await b.tx(async () => { await b.prepare("UPDATE settings SET value = 'changed' WHERE user_id = @uid").run(); });
    assert.equal(await owner.prepare("SELECT value FROM settings WHERE user_id = ?").pluck().get(OWNER_ID), 'owner');
  } finally {
    await store.close();
  }
});
