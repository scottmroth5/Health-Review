// Multi-user guard (phase 1): every SQL statement in the code that reads or writes a user table names user_id, so it is
// scoped to one user (db/scope.js binds @uid). Only server/admin-queries.js and the migrations may query across users.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoPath } from '../tools/paths.js';
import { USER_TABLES } from '../db/migrations-users.js';

const FOLDERS = ['server', 'metrics', 'ingest', 'agent', 'jobs', 'tools', 'demo', 'scripts', 'db', 'evals'];
const EXEMPT = new Set(['db/migrations.js', 'db/migrations-users.js', 'server/admin-queries.js']);

/** Every string literal in JavaScript source (template literals whole, with their ${} expressions). */
export function stringLiterals(src) {
  const out = [];
  let i = 0;
  const readQuoted = (q) => {
    const start = i;
    i += 1;
    while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    i += 1;
    return src.slice(start, i);
  };
  const readTemplate = () => {
    const start = i;
    i += 1;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        let depth = 1;
        while (i < src.length && depth) {
          const c = src[i];
          if (c === '`') { readTemplate(); continue; }
          if (c === '\'' || c === '"') { readQuoted(c); continue; }
          if (c === '{') depth += 1;
          if (c === '}') depth -= 1;
          i += 1;
        }
        continue;
      }
      i += 1;
    }
    i += 1;
    return src.slice(start, i);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; if (i < 2) break; continue; }
    if (c === '\'' || c === '"') { out.push(readQuoted(c)); continue; }
    if (c === '`') { out.push(readTemplate()); continue; }
    i += 1;
  }
  return out;
}

const files = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'node_modules' || name === 'public' || name === 'fixtures') return [];
  return statSync(path).isDirectory() ? files(path) : name.endsWith('.js') || name.endsWith('.mjs') ? [path] : [];
});

// runs (agent-core's) carries a nullable user_id: each user's run history is theirs too.
const tableRef = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+"?(${[...USER_TABLES, 'runs'].join('|')})\\b`, 'gi');

// Each user table a statement reads or writes needs its own user_id condition (a subquery or join too), so a statement
// names user_id at least as often as it names user tables: "FROM a JOIN b ON b.a_id = a.id" also says b.user_id = a.user_id.
test('every query on a user table names user_id once per user table (except admin queries and migrations)', () => {
  const misses = [];
  for (const folder of FOLDERS) {
    for (const path of files(repoPath(folder))) {
      const rel = relative(repoPath(), path).replace(/\\/g, '/');
      if (EXEMPT.has(rel)) continue;
      for (const lit of stringLiterals(readFileSync(path, 'utf8'))) {
        if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(lit)) continue;
        const refs = [...lit.matchAll(tableRef)].map((m) => m[2]);
        const scoped = (lit.match(/\buser_id\b/g) ?? []).length;
        if (refs.length && scoped < refs.length) misses.push(`${rel}: ${refs.join('+')} (${scoped} user_id): ${lit.replace(/\s+/g, ' ').slice(0, 110)}`);
      }
    }
  }
  assert.deepEqual(misses, [], `${misses.length} unscoped queries:\n${misses.join('\n')}`);
});

test('the string scanner finds nested template literals whole', () => {
  const lits = stringLiterals("const a = `SELECT ${cols.map((c) => `${c} = 1`).join(', ')} FROM t`; // 'x'\nconst b = 'y';");
  assert.equal(lits.length, 2);
  assert.match(lits[0], /FROM t`$/);
  assert.equal(lits[1], "'y'");
});
