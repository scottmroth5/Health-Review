// The few SQL expressions that cannot be written once for both engines (v3 Phase 1C slice 3, docs/adr/0007). Callers
// never branch on the engine themselves; they ask here. Everything else is one SQL text.
//
// Each takes a database from the async interface (db/database.ts) or a scoped one (db/scope.js); both carry engine.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (name) => {
  if (!IDENT.test(name)) throw new TypeError(`Not a plain identifier: ${name}`);
  return name;
};

/**
 * A SQL expression for a top-level string field of a JSON text column, compared as text: json_extract on SQLite,
 * ->> on PostgreSQL (the columns are text there too, so it is cast first).
 */
export function jsonText(db, column, key) {
  ident(column);
  ident(key);
  return db.engine === 'postgres' ? `(${column}::jsonb ->> '${key}')` : `json_extract(${column}, '$.${key}')`;
}

/** Whether a statement failed on a unique or primary key constraint (SQLite's code, or PostgreSQL's SQLSTATE 23505). */
export const isUniqueViolation = (err) => err?.code === '23505' || err?.code === 'SQLITE_CONSTRAINT_UNIQUE'
  || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';

/** The app's tables, by name (SQLite's own and schema_migrations included, as on each engine's catalog). */
export async function listTables(db) {
  return db.engine === 'postgres'
    ? db.prepare("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename").pluck().all()
    : db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all();
}

/** A table's column names, in order. */
export async function tableColumns(db, table) {
  ident(table);
  return db.engine === 'postgres'
    ? db.prepare(`SELECT attname FROM pg_attribute WHERE attrelid = ?::regclass AND attnum > 0 AND NOT attisdropped
        ORDER BY attnum`).pluck().all(`public.${table}`)
    : (await db.prepare(`PRAGMA table_info("${table}")`).all()).map((c) => c.name);
}

/**
 * A table's columns in order with their kind (integer, real or text, by SQLite's affinity rules or PostgreSQL's type)
 * and NOT NULL: what db/transfer.js normalizes and audits by.
 * @returns {Promise<Array<{ name: string, kind: 'integer'|'real'|'text', notNull: boolean }>>}
 */
export async function columnKinds(db, table) {
  ident(table);
  if (db.engine === 'postgres') {
    const rows = await db.prepare(`SELECT attname AS name, format_type(atttypid, atttypmod) AS type, CASE WHEN attnotnull THEN 1 ELSE 0 END AS nn
        FROM pg_attribute WHERE attrelid = ?::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`).all(`public.${table}`);
    const kind = (t) => (['bigint', 'integer', 'smallint'].includes(t) ? 'integer' : ['double precision', 'real', 'numeric'].includes(t) ? 'real' : 'text');
    return rows.map((r) => ({ name: r.name, kind: kind(r.type), notNull: r.nn === 1 }));
  }
  const kind = (declared) => {
    const t = String(declared).toUpperCase();
    return t.includes('INT') ? 'integer' : /REAL|FLOA|DOUB/.test(t) ? 'real' : 'text';
  };
  return (await db.prepare(`PRAGMA table_info("${table}")`).all()).map((c) => ({ name: c.name, kind: kind(c.type), notNull: c.notnull === 1 || c.pk > 0 }));
}

/** The tables a table's foreign keys point at (itself left out), by name. */
export async function foreignKeyParents(db, table) {
  ident(table);
  const parents = db.engine === 'postgres'
    ? await db.prepare(`SELECT p.relname FROM pg_constraint c JOIN pg_class p ON p.oid = c.confrelid
        WHERE c.conrelid = ?::regclass AND c.contype = 'f' ORDER BY p.relname`).pluck().all(`public.${table}`)
    : (await db.prepare(`PRAGMA foreign_key_list("${table}")`).all()).map((f) => f.table);
  return [...new Set(parents)].filter((p) => p !== table);
}

/** A table's primary key columns, in key order. */
export async function primaryKey(db, table) {
  ident(table);
  if (db.engine === 'postgres') {
    return db.prepare(`SELECT a.attname FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indrelid = ?::regclass AND i.indisprimary ORDER BY k.ord`).pluck().all(`public.${table}`);
  }
  return (await db.prepare(`PRAGMA table_info("${table}")`).all()).filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
}
