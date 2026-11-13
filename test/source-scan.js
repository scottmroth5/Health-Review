// The source the static guards read (test/user-scope.test.js, test/sql-postgres.test.js): every JavaScript and
// TypeScript file in the code folders, and the string literals in each.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoPath } from '../tools/paths.js';

export const FOLDERS = ['server', 'metrics', 'ingest', 'agent', 'jobs', 'tools', 'demo', 'scripts', 'db', 'evals'];
// Source files the guard reads: JavaScript and TypeScript (v3 moves code to .ts; a guard that skipped it would pass silently).
export const SOURCE = /\.(m?js|[mc]?ts)$/;

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
  return statSync(path).isDirectory() ? files(path) : SOURCE.test(name) && !name.endsWith('.d.ts') ? [path] : [];
});

/** Every file the guard scans, repo-relative with forward slashes. */
export const scannedFiles = () => FOLDERS.flatMap((folder) => files(repoPath(folder)))
  .map((path) => relative(repoPath(), path).replace(/\\/g, '/'));
