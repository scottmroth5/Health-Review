// Every SQL statement written out in the code prepares on PostgreSQL against the baseline schema (db/pg), so SQL that only
// SQLite accepts (INSERT OR, a two-argument MAX, an unquoted "end", a bare GROUP BY column, json_extract, rowid) fails
// here, before it can fail on the server. PostgreSQL plans each statement without running it, so this needs no rows.
// A statement also may not return a boolean: SQLite returns 1 and 0 where PostgreSQL returns true and false.
//
// Not covered here: statements built with ${} (the full suite runs them on PostgreSQL, slice 4), statements naming
// SQLite's own tables (sqlite_master, sqlite_sequence: the backup, restore test, demo refresh and baseline script stay on
// SQLite until 1G, and db/dialect.js gives the PostgreSQL side), and the files in SQLITE_ONLY. Skipped without
// DATABASE_URL (test/pg.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { repoPath } from '../tools/paths.js';
import { toPositional } from '../db/placeholders.ts';
import { openPostgresStore } from '../db/pg/migrate.js';
import { freshPgDatabase, pgSkip } from './pg.js';
import { scannedFiles, stringLiterals } from './source-scan.js';

/** Files that refuse PostgreSQL or never meet it: SQLite's migrations and runner, and a one-off keyed on rowid. */
const SQLITE_ONLY = new Set(['db/migrations.js', 'db/migrations-users.js', 'db/migrate.js', 'db/store.js',
  'ingest/session-times.js']);
const STATEMENT = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\s/; // upper case, as the code writes SQL (help text is not)
const SQLITE_CATALOG = /\bsqlite_(master|sequence)\b/;

/** The literal's text, as the program sees it. */
function unquote(lit) {
  const body = lit.slice(1, -1);
  return lit[0] === '`' ? body : body.replace(/\\(['"\\])/g, '$1');
}

/** Statements to check, with where they are. */
function statements() {
  const out = [];
  for (const rel of scannedFiles()) {
    if (SQLITE_ONLY.has(rel) || rel.startsWith('db/pg/')) continue;
    for (const lit of stringLiterals(readFileSync(repoPath(rel), 'utf8'))) {
      const sql = unquote(lit);
      if (!STATEMENT.test(sql) || SQLITE_CATALOG.test(sql) || (lit[0] === '`' && sql.includes('${'))) continue;
      out.push({ rel, sql });
    }
  }
  return out;
}

test('every SQL statement in the code prepares on PostgreSQL and returns no booleans', { skip: pgSkip }, async () => {
  const fresh = await freshPgDatabase();
  const store = await openPostgresStore(fresh.url);
  await store.close();
  const client = new pg.Client({ connectionString: fresh.url });
  await client.connect();
  const found = statements();
  const problems = [];
  try {
    for (const { rel, sql } of found) {
      const where = `${rel}: ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`;
      try {
        await client.query(`PREPARE checked AS ${toPositional(sql).text}`);
      } catch (err) {
        problems.push(`${where}\n    ${err.message}`);
        continue;
      }
      const { rows: [p] } = await client.query("SELECT result_types::text[] AS types FROM pg_prepared_statements WHERE name = 'checked'");
      if (p.types?.includes('boolean')) problems.push(`${where}\n    returns a boolean (true or false on PostgreSQL, 1 or 0 on SQLite)`);
      await client.query('DEALLOCATE checked');
    }
  } finally {
    await client.end();
    await fresh.drop();
  }
  assert.ok(found.length >= 300, `the check read ${found.length} statements, fewer than expected: is the scan still finding them?`);
  assert.deepEqual(problems, [], `${problems.length} statements would fail on PostgreSQL:\n${problems.join('\n')}`);
});
