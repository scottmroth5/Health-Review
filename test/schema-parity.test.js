// The PostgreSQL schema (db/pg/migrate.js) matches the SQLite one (db/store.js), table by table: column names and order,
// types (INTEGER bigint, REAL double precision, TEXT text, NOCASE citext, a rowid key an identity), NOT NULL, defaults,
// primary keys, uniques, foreign keys, checks (their columns and values) and indexes. A later SQLite migration with no
// PostgreSQL twin fails here. Made-up schema only, no rows. Skipped without DATABASE_URL (test/pg.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHealthStore } from '../db/store.js';
import { MIGRATIONS } from '../db/migrations.js';
import { BASELINE_THROUGH, PG_MIGRATIONS, migratePostgres, openPostgresStore } from '../db/pg/migrate.js';
import { createPostgresPool } from '../db/postgres.ts';
import { freshPgDatabase, pgSkip } from './pg.js';

// ---- normalizing both sides to one shape ----

const SQLITE_TYPES = { INTEGER: 'bigint', REAL: 'double precision', TEXT: 'text' };
const normDefault = (d) => (d == null ? null : String(d).replace(/::[a-z ]+$/i, '').replace(/^\((.*)\)$/, '$1'));
const normPredicate = (p) => (p == null ? null : p.replace(/[()]/g, '').replace(/\s+/g, ' ').trim().toLowerCase());

/** A check's signature: the table's columns it names and the values it lists, sorted, so wording may differ. */
function checkSignature(text, columns) {
  const strings = [...text.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]).sort();
  const rest = text.replace(/'(?:[^']|'')*'/g, ' ').replace(/::[a-z ]+?(?=[\s,)\]])/gi, ' ');
  const cols = [...new Set((rest.match(/[a-z_][a-z0-9_]*/gi) ?? []).filter((w) => columns.includes(w)))].sort();
  const numbers = (rest.match(/(?<![a-z_])\d+(?:\.\d+)?/gi) ?? []).sort();
  return `${cols.join(',')} | ${strings.join(',')} | ${numbers.join(',')}`;
}

/** The CHECK (...) bodies in a SQLite CREATE TABLE statement. */
function sqliteChecks(sql) {
  const out = [];
  const re = /\bCHECK\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < sql.length && depth; i += 1) depth += sql[i] === '(' ? 1 : sql[i] === ')' ? -1 : 0;
    out.push(sql.slice(re.lastIndex, i - 1));
  }
  return out;
}

function sqliteSchema(raw) {
  const tables = {};
  const all = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name, sql } of all) {
    const info = raw.prepare(`PRAGMA table_xinfo("${name}")`).all();
    const nocase = new Set([...sql.matchAll(/(\w+)\s+TEXT\b[^,]*?COLLATE\s+NOCASE/gi)].map((m) => m[1]));
    const pk = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const rowidKey = pk.length === 1 && info.find((c) => c.name === pk[0]).type === 'INTEGER' ? pk[0] : null;
    const columnNames = info.map((c) => c.name);
    const columns = info.map((c) => ({
      name: c.name,
      type: c.name === rowidKey ? 'identity' : nocase.has(c.name) ? 'citext' : SQLITE_TYPES[c.type] ?? `? ${c.type}`,
      notNull: Boolean(c.notnull || c.pk),
      default: normDefault(c.dflt_value),
    }));
    const fks = Object.values(Object.groupBy(raw.prepare(`PRAGMA foreign_key_list("${name}")`).all(), (f) => f.id))
      .map((parts) => `(${parts.map((p) => p.from).join(', ')}) -> ${parts[0].table}(${parts.map((p) => p.to).join(', ')}) ` +
        `on delete ${parts[0].on_delete.toLowerCase()}`).sort();
    const indexes = raw.prepare(`PRAGMA index_list("${name}")`).all().filter((ix) => ix.origin !== 'pk').map((ix) => {
      const cols = raw.prepare(`PRAGMA index_info("${ix.name}")`).all().map((c) => c.name).join(', ');
      if (ix.origin === 'u') return `unique (${cols})`;
      const where = ix.partial
        ? ` where ${normPredicate(raw.prepare('SELECT sql FROM sqlite_master WHERE name = ?').pluck().get(ix.name).split(/\bWHERE\b/i)[1])}`
        : '';
      return `${ix.unique ? 'unique ' : ''}index ${ix.name} (${cols})${where}`;
    }).sort();
    const checks = sqliteChecks(sql).map((c) => checkSignature(c, columnNames)).sort();
    tables[name] = { columns, primaryKey: pk, foreignKeys: fks, indexes, checks };
  }
  return tables;
}

async function postgresSchema(db) {
  const tables = {};
  const names = await db.prepare("SELECT tablename FROM pg_tables WHERE schemaname = 'public'").pluck().all();
  for (const name of names) {
    const rel = `public.${name}`;
    const info = await db.prepare(`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
             a.attidentity AS identity, pg_get_expr(d.adbin, d.adrelid) AS dflt
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = ?::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`).all(rel);
    const columnNames = info.map((c) => c.name);
    const columns = info.map((c) => ({
      name: c.name,
      type: c.identity ? (c.type === 'bigint' ? 'identity' : `? identity ${c.type}`) : c.type,
      notNull: c.not_null,
      default: normDefault(c.dflt),
    }));
    const primaryKey = await db.prepare(`
      SELECT a.attname FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indrelid = ?::regclass AND i.indisprimary ORDER BY k.ord`).pluck().all(rel);
    const constraints = await db.prepare(
      'SELECT contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = ?::regclass').all(rel);
    const foreignKeys = constraints.filter((c) => c.contype === 'f').map((c) => {
      const m = /^FOREIGN KEY \(([^)]*)\) REFERENCES (\w+)\(([^)]*)\)(?: ON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT))?/.exec(c.def);
      assert.ok(m, `unexpected foreign key form: ${c.def}`);
      return `(${m[1]}) -> ${m[2]}(${m[3]}) on delete ${(m[4] ?? 'no action').toLowerCase()}`;
    }).sort();
    const checks = constraints.filter((c) => c.contype === 'c').map((c) => checkSignature(c.def, columnNames)).sort();
    const indexes = (await db.prepare(`
      SELECT c.relname AS name, i.indisunique AS uniq, pg_get_expr(i.indpred, i.indrelid) AS pred,
             EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype = 'u') AS constraint_backed,
             (SELECT string_agg(pg_get_indexdef(i.indexrelid, n, true), ', ' ORDER BY n)
                FROM generate_series(1, i.indnkeyatts) AS n) AS cols
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = ?::regclass AND NOT i.indisprimary`).all(rel)).map((ix) => {
      if (ix.constraint_backed) return `unique (${ix.cols})`;
      return `${ix.uniq ? 'unique ' : ''}index ${ix.name} (${ix.cols})${ix.pred ? ` where ${normPredicate(ix.pred)}` : ''}`;
    }).sort();
    tables[name] = { columns, primaryKey, foreignKeys, indexes, checks };
  }
  return tables;
}

// ---- the tests ----

test('the PostgreSQL schema matches the SQLite schema, table by table', { skip: pgSkip }, async () => {
  const sqlite = openHealthStore(':memory:', { log: {} });
  const fresh = await freshPgDatabase();
  const pg = await openPostgresStore(fresh.url);
  try {
    const want = sqliteSchema(sqlite.raw);
    const got = await postgresSchema(pg.db);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'the same tables');
    for (const table of Object.keys(want)) assert.deepEqual(got[table], want[table], `table ${table}`);
    assert.ok(Object.keys(want).length >= 32, 'the comparison saw the whole schema');
    // The rows a new database starts with (timestamps aside): the owner as user 1.
    const seeded = async (db) => {
      const out = {};
      for (const t of Object.keys(want).filter((n) => n !== 'schema_migrations')) {
        const rows = await db.prepare(`SELECT * FROM "${t}"`).all();
        if (rows.length) out[t] = rows.map(({ created_at: _c, approved_at: _a, ...rest }) => rest);
      }
      return out;
    };
    assert.deepEqual(await seeded(pg.db), await seeded(sqlite.db));
    assert.deepEqual(Object.keys(await seeded(pg.db)), ['users']);
  } finally {
    sqlite.close();
    await pg.close();
    await fresh.drop();
  }
});

test('every SQLite migration after the baseline has a PostgreSQL twin with the same id', () => {
  const sqliteIds = MIGRATIONS.map((m) => m.id);
  const at = sqliteIds.indexOf(BASELINE_THROUGH);
  assert.ok(at >= 0, `BASELINE_THROUGH ${BASELINE_THROUGH} is a SQLite migration`);
  const pgIds = PG_MIGRATIONS.map((m) => m.id);
  assert.equal(pgIds[0], '000-baseline');
  assert.deepEqual(pgIds.slice(1), sqliteIds.slice(at + 1),
    'write each new SQLite migration for PostgreSQL too (db/pg/migrate.js), in the same order');
});

test('the runner applies each migration once, also when two processes open the database at the same time', { skip: pgSkip }, async () => {
  const fresh = await freshPgDatabase();
  try {
    const [a, b] = await Promise.all([openPostgresStore(fresh.url), openPostgresStore(fresh.url)]);
    assert.deepEqual([...a.applied, ...b.applied], ['000-baseline'], 'one of them applied it, the other found it done');
    await Promise.all([a.close(), b.close()]);
    const again = await openPostgresStore(fresh.url);
    assert.deepEqual(again.applied, []);
    assert.deepEqual(await again.db.prepare('SELECT app, id FROM schema_migrations').all(),
      [{ app: 'health-review', id: '000-baseline' }]);
    await again.close();
  } finally {
    await fresh.drop();
  }
});

test('a failing migration rolls back whole and is not recorded; the ones before it stay', { skip: pgSkip }, async () => {
  const fresh = await freshPgDatabase();
  const pool = createPostgresPool(fresh.url);
  try {
    const bad = { id: '999-bad', up: 'CREATE TABLE half_done (a bigint); SELECT no_such_column FROM half_done' };
    await assert.rejects(migratePostgres(pool, [...PG_MIGRATIONS, bad]), /migration health-review:999-bad failed and was rolled back/);
    const { rows } = await pool.query("SELECT to_regclass('half_done') AS t, (SELECT array_agg(id) FROM schema_migrations) AS ids");
    assert.deepEqual(rows[0], { t: null, ids: ['000-baseline'] });
    await assert.rejects(migratePostgres(pool, [PG_MIGRATIONS[0], PG_MIGRATIONS[0]]), /duplicate migration id/);
  } finally {
    await pool.end();
    await fresh.drop();
  }
});

test('the store refuses a database that sorts or folds text unlike SQLite', { skip: pgSkip }, async () => {
  const fresh = await freshPgDatabase({ options: "TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'und' LC_COLLATE 'C' LC_CTYPE 'C'" });
  try {
    await assert.rejects(openPostgresStore(fresh.url), /sorts or folds text unlike SQLite.*LC_COLLATE 'C'/);
  } finally {
    await fresh.drop();
  }
});

test('names in citext columns compare and stay unique ignoring ASCII case, as NOCASE does on SQLite', { skip: pgSkip }, async () => {
  const fresh = await freshPgDatabase();
  const pg = await openPostgresStore(fresh.url);
  try {
    const { db } = pg;
    await db.prepare("INSERT INTO users (id, email, role, status, created_at) VALUES ('u1', 'a@example.test', 'admin', 'approved', 'x')").run();
    await db.prepare("INSERT INTO medications (user_id, name, kind, created_at) VALUES ('u1', 'Test Item', 'supplement', 'x')").run();
    assert.equal(await db.prepare("SELECT name FROM medications WHERE name = 'test ITEM'").pluck().get(), 'Test Item');
    await assert.rejects(db.prepare("INSERT INTO medications (user_id, name, kind, created_at) VALUES ('u1', 'TEST item', 'supplement', 'x')").run(),
      /duplicate key value/);
    // Only ASCII folds, as with NOCASE: an accented capital is a different name.
    await db.prepare("INSERT INTO medications (user_id, name, kind, created_at) VALUES ('u1', 'É Item', 'supplement', 'x')").run();
    await db.prepare("INSERT INTO medications (user_id, name, kind, created_at) VALUES ('u1', 'é Item', 'supplement', 'x')").run();
    assert.equal(await db.prepare('SELECT COUNT(*) FROM medications').pluck().get(), 3);
    assert.deepEqual(await db.prepare('INSERT INTO lab_tests (user_id, name, created_at) VALUES (?, ?, ?) RETURNING id, position').get('u1', 'Test Lab', 'x'),
      { id: 1, position: 9999 });
  } finally {
    await pg.close();
    await fresh.drop();
  }
});
