// Copies every row of a SQLite store into a fresh store on the test engine (v3 Phase 1C slice 4): how the suite gets the
// demo's made-up data onto PostgreSQL, and the start of 1E's migration script. Tests only; made-up rows only.
import { listTables, tableColumns } from '../db/dialect.js';

/** Bind parameters per INSERT (PostgreSQL allows 65,535; SQLite 32,766). */
const MAX_PARAMS = 30000;

/** Tables ordered so each comes after the tables its foreign keys name (read from the SQLite source). */
function fkOrder(raw, tables) {
  const deps = new Map(tables.map((t) => [t, raw.prepare(`PRAGMA foreign_key_list("${t}")`).all().map((f) => f.table).filter((p) => p !== t)]));
  const done = new Set();
  const out = [];
  const visit = (t, path = new Set()) => {
    if (done.has(t)) return;
    if (path.has(t)) throw new Error(`copyRows: foreign key cycle at ${t}`);
    path.add(t);
    for (const p of deps.get(t) ?? []) visit(p, path);
    done.add(t);
    out.push(t);
  };
  tables.forEach((t) => visit(t));
  return out;
}

/**
 * Sets each identity column's next value past the largest id in its table, as SQLite's rowid does on its own; needed
 * after rows are written with explicit ids. Nothing to do on SQLite.
 * @param {import('../db/database.ts').Database} db  unscoped
 */
export async function resetSequences(db) {
  if (db.engine !== 'postgres') return;
  const cols = await db.prepare(`SELECT table_name AS t, column_name AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND is_identity = 'YES' ORDER BY table_name`).all();
  for (const { t, c } of cols) {
    await db.prepare(`SELECT setval(pg_get_serial_sequence(?, ?), (SELECT COALESCE(MAX("${c}"), 0) + 1 FROM "${t}"), false)`).get(t, c);
  }
}

/**
 * Copies every table's rows (schema_migrations aside) from a SQLite store into target, replacing the target's rows
 * (a fresh store holds only the owner row), in one transaction.
 * @param {{ raw: import('better-sqlite3').Database, db: import('../db/database.ts').Database }} source  unscoped SQLite
 * @param {{ db: import('../db/database.ts').Database }} target  unscoped, freshly migrated
 * @returns {Promise<Record<string, number>>} rows copied per table
 */
export async function copyRows(source, target) {
  const tables = fkOrder(source.raw, (await listTables(source.db)).filter((t) => t !== 'schema_migrations'));
  const counts = {};
  await target.db.tx(async () => {
    for (const t of [...tables].reverse()) await target.db.prepare(`DELETE FROM "${t}"`).run();
    for (const t of tables) {
      const cols = await tableColumns(source.db, t);
      const theirs = await tableColumns(target.db, t);
      if (cols.join() !== theirs.join()) throw new Error(`copyRows: ${t} has columns ${cols.join()} here and ${theirs.join()} there`);
      const rows = source.raw.prepare(`SELECT * FROM "${t}"`).raw().all();
      const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
      const list = cols.map((c) => `"${c}"`).join(', ');
      const one = `(${cols.map(() => '?').join(', ')})`;
      for (let i = 0; i < rows.length; i += per) {
        const batch = rows.slice(i, i + per);
        await target.db.prepare(`INSERT INTO "${t}" (${list}) VALUES ${batch.map(() => one).join(', ')}`).run(batch.flat());
      }
      counts[t] = rows.length;
    }
    await resetSequences(target.db);
  });
  return counts;
}
