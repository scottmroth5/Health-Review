// Moving the whole database between engines (v3 Phase 1E, docs/adr/0008): SQLite to PostgreSQL at cutover, and back to a
// new SQLite file during the rollback window. Both directions run on the async interface (db/database.ts), so one copy
// and one fingerprint serve both. Nothing here prints or returns a stored value, a user id or an email: findings and
// reports carry table and column names, counts, and pass or fail only.
import { createHash } from 'node:crypto';
import { columnKinds, foreignKeyParents, listTables, primaryKey, tableColumns } from './dialect.js';
import { BASELINE_THROUGH, PG_MIGRATIONS } from './pg/migrate.js';
import { OWNER_ID } from './users.js';

const APP = 'health-review';
/** Bind parameters per INSERT (PostgreSQL allows 65,535 and SQLite 32,766). */
const MAX_PARAMS = 30000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Every table but schema_migrations, parents before the tables whose foreign keys name them. */
export async function tableOrder(db) {
  const tables = (await listTables(db)).filter((t) => t !== 'schema_migrations');
  const parents = new Map();
  for (const t of tables) parents.set(t, await foreignKeyParents(db, t));
  const done = new Set();
  const out = [];
  const visit = (t, path) => {
    if (done.has(t)) return;
    if (path.has(t)) throw new Error(`Foreign key cycle at ${t}`);
    path.add(t);
    for (const p of parents.get(t) ?? []) if (parents.has(p)) visit(p, path);
    path.delete(t);
    done.add(t);
    out.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return out;
}

/** The newest schema a database is at, named by the SQLite migration id (PostgreSQL's baseline stands for BASELINE_THROUGH). */
async function schemaVersion(db) {
  const ids = await db.prepare('SELECT id FROM schema_migrations WHERE app = ? ORDER BY id').pluck().all(APP);
  if (db.engine !== 'postgres') return ids.at(-1) ?? null;
  const known = PG_MIGRATIONS.map((m) => m.id).filter((id) => ids.includes(id));
  const last = known.at(-1);
  return last === '000-baseline' ? BASELINE_THROUGH : last ?? null;
}

/**
 * Refuses unless both databases hold the same tables with the same columns in the same order, at the same migration.
 * Names tables and columns only.
 */
export async function checkSameSchema(source, target) {
  const [va, vb] = [await schemaVersion(source.db), await schemaVersion(target.db)];
  if (!va || va !== vb) throw new Error(`The two databases are at different migrations (${va ?? 'none'} and ${vb ?? 'none'}); bring both to the same one first`);
  const [ta, tb] = [await tableOrder(source.db), await tableOrder(target.db)];
  const missing = ta.filter((t) => !tb.includes(t)).concat(tb.filter((t) => !ta.includes(t)));
  if (missing.length) throw new Error(`Tables on one side only: ${missing.sort().join(', ')}`);
  for (const t of ta) {
    const [ca, cb] = [await tableColumns(source.db, t), await tableColumns(target.db, t)];
    if (ca.join() !== cb.join()) throw new Error(`${t} has columns ${ca.join(', ')} on one side and ${cb.join(', ')} on the other`);
  }
}

/** Every identity column's next value past the largest id in its table (PostgreSQL; SQLite's rowid does this itself). */
export async function resetSequences(db) {
  if (db.engine !== 'postgres') return;
  const cols = await db.prepare(`SELECT table_name AS t, column_name AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND is_identity = 'YES' ORDER BY table_name`).all();
  for (const { t, c } of cols) {
    await db.prepare(`SELECT setval(pg_get_serial_sequence(?, ?), (SELECT COALESCE(MAX("${c}"), 0) + 1 FROM "${t}"), false)`).get(t, c);
  }
}

const orderBy = async (db, t) => (await primaryKey(db, t)).map((c) => `"${c}"`).join(', ');

/** A table's rows in primary key order, as arrays in column order. */
async function rowsOf(db, table, cols) {
  const order = await orderBy(db, table);
  const rows = await db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"${order ? ` ORDER BY ${order}` : ''}`).all();
  return rows.map((r) => cols.map((c) => r[c]));
}

/**
 * Copies every row of source into target, which must be a freshly migrated database (only the owner row its migrations
 * seed, which is replaced): never a merge into live data. One transaction on the target; sequences reset after.
 * @param {{ db: import('./database.ts').Database }} source  unscoped
 * @param {{ db: import('./database.ts').Database }} target  unscoped
 * @returns {Promise<Record<string, number>>} rows copied per table
 */
export async function copyAll(source, target) {
  const tables = await tableOrder(target.db);
  /** @type {Record<string, number>} */
  const counts = {};
  await target.db.tx(async () => {
    for (const t of tables) {
      const n = await target.db.prepare(`SELECT COUNT(*) FROM "${t}"`).pluck().get();
      const onlyOwner = t === 'users' && n <= 1 && (n === 0 || (await target.db.prepare('SELECT id FROM users').pluck().get()) === OWNER_ID);
      if (n && !onlyOwner) throw new Error(`The target already holds rows in ${t}; copy only into a new, empty database`);
    }
    await target.db.prepare('DELETE FROM users').run();
    for (const t of tables) {
      const cols = await tableColumns(source.db, t);
      const rows = await rowsOf(source.db, t, cols);
      const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
      const list = cols.map((c) => `"${c}"`).join(', ');
      const one = `(${cols.map(() => '?').join(', ')})`;
      for (let i = 0; i < rows.length; i += per) {
        const batch = rows.slice(i, i + per);
        try {
          await target.db.prepare(`INSERT INTO "${t}" (${list}) VALUES ${batch.map(() => one).join(', ')}`).run(batch.flat());
        } catch (err) {
          // A database's message can quote the value it refused (PostgreSQL's "invalid input syntax ... "): the table and
          // the error code only, so a value never reaches a log or the screen.
          throw new Error(`Copying ${t} failed (${err.code ?? err.name}); nothing was kept`, { cause: err });
        }
      }
      counts[t] = rows.length;
    }
    await resetSequences(target.db);
  });
  return counts;
}

/**
 * What would not survive the move to PostgreSQL, counted per table and column: never a value. Reads the SQLite file
 * itself (better-sqlite3's handle), since SQLite's typeof() is the only place a stored value's real type shows.
 * - fail: an INTEGER column holding text, real or blob, or an integer past 2^53 (JavaScript would round it); a REAL
 *   column holding text or blob; a TEXT column holding a blob or a NUL character; NULL in a NOT NULL or key column.
 * - warn: a TEXT column holding numbers (stored as their text on PostgreSQL; the fingerprint compares them as text).
 * @param {import('better-sqlite3').Database} raw
 * @returns {Array<{ table: string, column: string, kind: string, severity: 'fail'|'warn', count: number }>}
 */
export function audit(raw) {
  /** @type {Array<{ table: string, column: string, kind: string, severity: 'fail'|'warn', count: number }>} */
  const findings = [];
  const tables = /** @type {string[]} */ (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name").pluck().all());
  for (const t of tables) {
    const columns = /** @type {Array<{ name: string, type: string, notnull: number, pk: number }>} */ (raw.prepare(`PRAGMA table_info("${t}")`).all());
    for (const c of columns) {
      const type = String(c.type).toUpperCase();
      const kind = type.includes('INT') ? 'integer' : /REAL|FLOA|DOUB/.test(type) ? 'real' : 'text';
      const col = `"${c.name}"`;
      const checks = [];
      if (kind === 'integer') {
        checks.push(['not an integer', 'fail', `typeof(${col}) IN ('text', 'real', 'blob')`]);
        checks.push(['integer past 2^53', 'fail', `typeof(${col}) = 'integer' AND (${col} > ${MAX_SAFE} OR ${col} < -${MAX_SAFE})`]);
      } else if (kind === 'real') {
        checks.push(['not a number', 'fail', `typeof(${col}) IN ('text', 'blob')`]);
      } else {
        checks.push(['binary value', 'fail', `typeof(${col}) = 'blob'`]);
        checks.push(['NUL character', 'fail', `typeof(${col}) = 'text' AND instr(${col}, char(0)) > 0`]);
        checks.push(['number in a text column', 'warn', `typeof(${col}) IN ('integer', 'real')`]);
      }
      if (c.notnull || c.pk) checks.push(['NULL in a required column', 'fail', `${col} IS NULL`]);
      for (const [label, severity, where] of /** @type {Array<[string, 'fail'|'warn', string]>} */ (checks)) {
        const count = Number(raw.prepare(`SELECT COUNT(*) FROM "${t}" WHERE ${where}`).pluck().get());
        if (count) findings.push({ table: t, column: c.name, kind: label, severity, count });
      }
    }
  }
  return findings;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Row counts per table, and a SHA-256 per (table, user) over the rows in primary key order, each value normalized by
 * its column's kind (numbers as numbers, text as text, null as null) so both engines hash alike. Group keys are hashes
 * of the user id (or "all" for tables without one), so a report never names a user.
 * @returns {Promise<Record<string, { rows: number, groups: Record<string, string> }>>}
 */
export async function fingerprint(db) {
  /** @type {Record<string, { rows: number, groups: Record<string, string> }>} */
  const out = {};
  for (const t of await tableOrder(db)) {
    const kinds = await columnKinds(db, t);
    const cols = kinds.map((k) => k.name);
    const uidAt = cols.indexOf('user_id');
    const norm = kinds.map((k) => (k.kind === 'text' ? (v) => (v === null || v === undefined ? null : String(v)) : (v) => (v === null || v === undefined ? null : Number(v))));
    const hashes = new Map();
    const rows = await rowsOf(db, t, cols);
    for (const row of rows) {
      const group = uidAt >= 0 ? sha(`user:${row[uidAt]}`).slice(0, 16) : 'all';
      if (!hashes.has(group)) hashes.set(group, createHash('sha256'));
      hashes.get(group).update(`${JSON.stringify(row.map((v, i) => norm[i](v)))}\n`);
    }
    out[t] = { rows: rows.length, groups: Object.fromEntries([...hashes].map(([g, h]) => [g, h.digest('hex')])) };
  }
  return out;
}

/** Table by table: row counts on each side and how many user groups differ. */
export function compare(a, b) {
  const tables = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const rows = tables.map((t) => {
    const ga = a[t]?.groups ?? {};
    const gb = b[t]?.groups ?? {};
    const keys = new Set([...Object.keys(ga), ...Object.keys(gb)]);
    const differing = [...keys].filter((k) => ga[k] !== gb[k]).length;
    const ok = Boolean(a[t] && b[t]) && a[t].rows === b[t].rows && differing === 0;
    return { table: t, rowsA: a[t]?.rows ?? null, rowsB: b[t]?.rows ?? null, differingGroups: differing, ok };
  });
  return { ok: rows.every((r) => r.ok), tables: rows };
}

/**
 * The whole move: same schema, copy, then the fingerprints of both sides compared.
 * @returns {Promise<{ ok: boolean, counts: Record<string, number>, tables: ReturnType<typeof compare>['tables'] }>}
 */
export async function transfer(source, target) {
  await checkSameSchema(source, target);
  const counts = await copyAll(source, target);
  const result = compare(await fingerprint(source.db), await fingerprint(target.db));
  return { ok: result.ok, counts, tables: result.tables };
}

/** Report lines for the scripts: names, counts, pass or fail; never a value or an id. */
export function reportLines({ findings = [], result = null } = {}) {
  const lines = [];
  for (const f of findings) lines.push(`audit ${f.severity}: ${f.table}.${f.column}: ${f.kind} (${f.count} rows)`);
  if (findings.length === 0) lines.push('audit: clean');
  if (result) {
    for (const r of result.tables) {
      lines.push(`${r.ok ? 'ok  ' : 'FAIL'} ${r.table}: ${r.rowsA ?? '-'} rows -> ${r.rowsB ?? '-'}${r.differingGroups ? `, ${r.differingGroups} user groups differ` : ''}`);
    }
    lines.push(result.ok ? 'PASS: every table copied and verified' : 'FAIL: see the tables above');
  }
  return lines;
}
