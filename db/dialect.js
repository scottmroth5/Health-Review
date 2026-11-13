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
