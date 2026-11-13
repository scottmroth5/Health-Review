// Multi-user guard (phase 1): every SQL statement in the code that reads or writes a user table names user_id, so it is
// scoped to one user (db/scope.js binds @uid). Only server/admin-queries.js and the migrations may query across users.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoPath } from '../tools/paths.js';
import { USER_TABLES } from '../db/migrations-users.js';
import { FOLDERS, SOURCE, scannedFiles, stringLiterals } from './source-scan.js';

// scripts/baseline.js reads run durations and row counts across users (counts and milliseconds only, like the admin's
// usage queries).
const EXEMPT = new Set(['db/migrations.js', 'db/migrations-users.js', 'server/admin-queries.js', 'scripts/baseline.js']);

// runs (agent-core's) carries a nullable user_id: each user's run history is theirs too.
const tableRef = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+"?(${[...USER_TABLES, 'runs'].join('|')})\\b`, 'gi');

// Each user table a statement reads or writes needs its own user_id condition (a subquery or join too), so a statement
// names user_id at least as often as it names user tables: "FROM a JOIN b ON b.a_id = a.id" also says b.user_id = a.user_id.
test('every query on a user table names user_id once per user table (except admin queries and migrations)', () => {
  const misses = [];
  for (const rel of scannedFiles()) {
    {
      if (EXEMPT.has(rel)) continue;
      for (const lit of stringLiterals(readFileSync(repoPath(rel), 'utf8'))) {
        if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(lit)) continue;
        const refs = [...lit.matchAll(tableRef)].map((m) => m[2]);
        const scoped = (lit.match(/\buser_id\b/g) ?? []).length;
        if (refs.length && scoped < refs.length) misses.push(`${rel}: ${refs.join('+')} (${scoped} user_id): ${lit.replace(/\s+/g, ' ').slice(0, 110)}`);
      }
    }
  }
  assert.deepEqual(misses, [], `${misses.length} unscoped queries:\n${misses.join('\n')}`);
});

// The guard only protects what it reads. A floor on the count catches a filter that quietly stops matching (as a .js-only
// filter would once code moves to .ts), and the walk below catches source in a folder the guard does not list.
const SCANNED_FLOOR = 107; // 115 on 2026-11-03: raise it as code grows, never lower it to let a change pass
const OUTSIDE = new Set(['node_modules', '.git', 'data', 'legacy', 'test', 'docs', '.github', '.githooks', 'deploy', 'config']);

test('the user-scope guard still reads all the code (a floor on its file count, TypeScript included)', () => {
  const scanned = scannedFiles();
  assert.ok(scanned.length >= SCANNED_FLOOR, `the guard scans ${scanned.length} files, under its floor of ${SCANNED_FLOOR}`);
  const unscanned = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(repoPath(), path).replace(/\\/g, '/');
      if (statSync(path).isDirectory()) {
        if (dir === repoPath() ? OUTSIDE.has(name) || FOLDERS.includes(name) : name === 'node_modules') continue;
        walk(path);
      } else if (SOURCE.test(name) && !name.endsWith('.d.ts') && dir !== repoPath()) unscanned.push(rel);
    }
  };
  walk(repoPath());
  assert.deepEqual(unscanned, [], 'source in a folder the user-scope guard does not read: add the folder to FOLDERS');
  assert.ok(SOURCE.test('server/routes.ts') && SOURCE.test('a.mts') && SOURCE.test('a.cts') && SOURCE.test('a.mjs'));
});

test('the string scanner finds nested template literals whole', () => {
  const lits = stringLiterals("const a = `SELECT ${cols.map((c) => `${c} = 1`).join(', ')} FROM t`; // 'x'\nconst b = 'y';");
  assert.equal(lits.length, 2);
  assert.match(lits[0], /FROM t`$/);
  assert.equal(lits[1], "'y'");
});
