// Moving the database between engines (db/transfer.js, scripts/migrate-to-postgres.js, scripts/export-to-sqlite.js;
// v3 Phase 1E): the audit, table order, the schema check, the empty-target rule, the fingerprint, and the full rehearsal
// on the demo's made-up data (SQLite to PostgreSQL and back). Made-up rows only; the rehearsal needs DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHealthStore } from '../db/store.js';
import { foreignKeyParents } from '../db/dialect.js';
import { OWNER_ID } from '../db/users.js';
import { audit, checkSameSchema, compare, copyAll, fingerprint, reportLines, tableOrder } from '../db/transfer.js';
import { refreshDemoDatabase } from '../demo/generate.js';
import { migrateToPostgres } from '../scripts/migrate-to-postgres.js';
import { exportToSqlite } from '../scripts/export-to-sqlite.js';
import { openTestStore } from './helpers.js';
import { freshPgDatabase, pgSkip } from './pg.js';

const quiet = { info() {} };
const BAD_TEXT = 'made-up-not-a-number';
const NUL_TEXT = 'made-up\u0000value';

/** A SQLite store holding one of each value PostgreSQL would refuse. */
function badStore() {
  const store = openHealthStore(':memory:');
  const ins = store.raw.prepare("INSERT INTO checkins (user_id, date, cadence, energy, source, updated_at) VALUES (?, ?, 'daily', ?, 'ui', 'x')");
  ins.run(OWNER_ID, '2026-01-01', BAD_TEXT); // text in an INTEGER column
  ins.run(OWNER_ID, '2026-01-02', 9007199254740993n); // past 2^53
  ins.run(OWNER_ID, '2026-01-03', 7); // fine
  store.raw.prepare("INSERT INTO daily_metrics (user_id, date, hrv_ms, updated_at) VALUES (?, '2026-01-01', ?, 'x')").run(OWNER_ID, BAD_TEXT);
  const set = store.raw.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, 'x')");
  set.run(OWNER_ID, 'nul', NUL_TEXT);
  set.run(OWNER_ID, 'blob', Buffer.from('made-up-bytes'));
  return store;
}

test('audit: counts what PostgreSQL would refuse, by table and column, and never shows a value', () => {
  const store = badStore();
  try {
    const findings = audit(store.raw);
    const got = Object.fromEntries(findings.map((f) => [`${f.table}.${f.column}: ${f.kind}`, [f.severity, f.count]]));
    assert.deepEqual(got['checkins.energy: not an integer'], ['fail', 1]);
    assert.deepEqual(got['checkins.energy: integer past 2^53'], ['fail', 1]);
    assert.deepEqual(got['daily_metrics.hrv_ms: not a number'], ['fail', 1]);
    assert.deepEqual(got['settings.value: NUL character'], ['fail', 1]);
    assert.deepEqual(got['settings.value: binary value'], ['fail', 1]);
    assert.equal(findings.length, 5, 'nothing else is flagged');
    const text = reportLines({ findings }).join('\n');
    for (const leak of [BAD_TEXT, 'made-up', '9007199254740993', OWNER_ID]) assert.ok(!text.includes(leak), leak);
    assert.match(text, /audit fail: checkins\.energy: not an integer \(1 rows\)/);
    assert.deepEqual(reportLines({ findings: audit(openHealthStore(':memory:').raw) }), ['audit: clean']);
  } finally {
    store.close();
  }
});

test('table order: every table comes after the tables its foreign keys name, on the test engine', async () => {
  const store = await openTestStore();
  try {
    const order = await tableOrder(store.db);
    assert.ok(order.includes('users') && !order.includes('schema_migrations'));
    for (const t of order) for (const p of await foreignKeyParents(store.db, t)) assert.ok(order.indexOf(p) < order.indexOf(t), `${p} before ${t}`);
  } finally {
    await store.close();
  }
});

test('the schema check refuses another migration, a missing column or another column order; the copy refuses a target with rows', async () => {
  const fresh = () => openHealthStore(':memory:');
  const [a, b] = [fresh(), fresh()];
  await checkSameSchema(a, b);
  b.raw.exec('ALTER TABLE settings DROP COLUMN updated_at');
  await assert.rejects(checkSameSchema(a, b), /settings has columns/);
  const c = fresh();
  c.raw.exec("DELETE FROM schema_migrations WHERE id = (SELECT MAX(id) FROM schema_migrations WHERE app = 'health-review')");
  await assert.rejects(checkSameSchema(a, c), /different migrations/);
  const d = fresh();
  d.raw.prepare("INSERT INTO checkins (user_id, date, cadence, source, updated_at) VALUES (?, '2026-01-01', 'daily', 'ui', 'x')").run(OWNER_ID);
  await assert.rejects(copyAll(a, d), /already holds rows in checkins/);
  for (const s of [a, b, c, d]) s.close();
});

test('fingerprint: one changed value changes it; the order rows were written in does not', async () => {
  const fill = (store, dates) => {
    for (const d of dates) store.raw.prepare("INSERT INTO daily_metrics (user_id, date, steps, updated_at) VALUES (?, ?, 1000, 'x')").run(OWNER_ID, d);
  };
  const [a, b] = [openHealthStore(':memory:'), openHealthStore(':memory:')];
  // Each new store stamps its owner row with its own creation time: make them the same row first.
  for (const s of [a, b]) s.raw.prepare("UPDATE users SET created_at = 'x', approved_at = 'x'").run();
  fill(a, ['2026-01-01', '2026-01-02', '2026-01-03']);
  fill(b, ['2026-01-03', '2026-01-01', '2026-01-02']);
  assert.equal(compare(await fingerprint(a.db), await fingerprint(b.db)).ok, true);
  b.raw.prepare("UPDATE daily_metrics SET steps = 1001 WHERE date = '2026-01-02'").run();
  const diff = compare(await fingerprint(a.db), await fingerprint(b.db));
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.tables.filter((t) => !t.ok).map((t) => [t.table, t.rowsA, t.rowsB, t.differingGroups]), [['daily_metrics', 3, 3, 1]]);
  const text = reportLines({ result: diff }).join('\n');
  assert.match(text, /FAIL daily_metrics: 3 rows -> 3, 1 user groups differ/);
  assert.ok(!text.includes(OWNER_ID) && !text.includes('1001'));
  a.close();
  b.close();
});

test('the migrate script stops on audit failures before touching PostgreSQL, naming columns only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-transfer-audit-'));
  try {
    const path = join(dir, 'bad.db');
    const store = openHealthStore(path, { snapshot: false, log: quiet });
    store.raw.prepare("INSERT INTO checkins (user_id, date, cadence, energy, source, updated_at) VALUES (?, '2026-01-01', 'daily', ?, 'ui', 'x')").run(OWNER_ID, BAD_TEXT);
    store.close();
    const lines = [];
    assert.equal(await migrateToPostgres({ from: path, url: 'postgres://never-used.invalid/x', log: (l) => lines.push(l) }), 2);
    assert.ok(lines.some((l) => l.includes('checkins.energy')));
    assert.ok(!lines.join('\n').includes(BAD_TEXT));
    assert.equal(await migrateToPostgres({ from: path, auditOnly: true, log: () => {} }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a value PostgreSQL refuses (the audit skipped) fails the copy naming the table and code, never the value', { skip: pgSkip }, async () => {
  const source = openHealthStore(':memory:');
  source.raw.prepare("INSERT INTO checkins (user_id, date, cadence, energy, source, updated_at) VALUES (?, '2026-01-01', 'daily', ?, 'ui', 'x')").run(OWNER_ID, BAD_TEXT);
  const { freshPgStore } = await import('./pg.js');
  const target = await freshPgStore();
  try {
    await assert.rejects(copyAll(source, target), (err) => /^Copying checkins failed \(22P02\)/.test(err.message) && !err.message.includes(BAD_TEXT));
    assert.equal(await target.db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 1, 'rolled back: the owner row is still there');
  } finally {
    source.close();
    await target.close();
  }
});

test('rehearsal: the demo data to PostgreSQL and back to a new SQLite file, verified both ways; nothing but counts printed', { skip: pgSkip, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hr-transfer-'));
  const pg = await freshPgDatabase();
  try {
    const from = join(dir, 'demo.db');
    const built = openHealthStore(from, { snapshot: false, log: quiet });
    await refreshDemoDatabase(built, { today: '2026-10-07' });
    built.close();
    const before = readFileSync(from);

    const lines = [];
    assert.equal(await migrateToPostgres({ from, auditOnly: true, log: (l) => lines.push(l) }), 0);
    assert.deepEqual(lines, ['audit: clean']);
    lines.length = 0;
    assert.equal(await migrateToPostgres({ from, url: pg.url, log: (l) => lines.push(l) }), 0);
    assert.equal(lines.at(-1), 'PASS: every table copied and verified');
    assert.ok(lines.some((l) => /^ok {3}strength_sets: \d{4,} rows -> \d{4,}$/.test(l)));
    assert.ok(readFileSync(from).equals(before), 'the source file is never written');
    // A second run refuses: the target is no longer empty.
    await assert.rejects(migrateToPostgres({ from, url: pg.url, log: () => {} }), /already holds rows/);
    // New rows after the copy get fresh ids (sequences reset).
    const { rows: [m] } = await pg.pool.query('SELECT MAX(id) AS max FROM medications');
    const { rows: [n] } = await pg.pool.query("INSERT INTO medications (user_id, name, kind, created_at) VALUES ($1, 'Made-up Later', 'supplement', 'x') RETURNING id", [OWNER_ID]);
    assert.ok(Number(n.id) > Number(m.max));
    await pg.pool.query("DELETE FROM medications WHERE name = 'Made-up Later'");

    const out = join(dir, 'back.db');
    const back = [];
    assert.equal(await exportToSqlite({ url: pg.url, out, log: (l) => back.push(l) }), 0);
    assert.equal(back.at(-1), 'PASS: every table copied and verified');
    // The round trip holds exactly what the original did.
    const [a, b] = [openHealthStore(from, { snapshot: false, log: quiet }), openHealthStore(out, { snapshot: false, log: quiet })];
    const round = compare(await fingerprint(a.db), await fingerprint(b.db));
    a.close();
    b.close();
    assert.equal(round.ok, true, JSON.stringify(round.tables.filter((t) => !t.ok)));
    // An existing file is never touched.
    writeFileSync(join(dir, 'exists.db'), 'keep me');
    await assert.rejects(exportToSqlite({ url: pg.url, out: join(dir, 'exists.db'), log: () => {} }), /already exists/);
    assert.equal(readFileSync(join(dir, 'exists.db'), 'utf8'), 'keep me');

    const printed = [...lines, ...back].join('\n');
    for (const leak of ['Sample Creatine', 'Sample Fish Oil', 'Sample review', 'Sample note', '@', OWNER_ID, 'postgres://']) assert.ok(!printed.includes(leak), leak);
    assert.ok(existsSync(out));
  } finally {
    await pg.drop();
    rmSync(dir, { recursive: true, force: true });
  }
});
