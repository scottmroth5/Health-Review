// Module boundaries (v3 Phase 2, docs/adr/0012): which folder may import which, read from every relative import in the
// code (static, re-export and dynamic), so a new import that points the wrong way fails here before it lands. The layers
// are today's folders; the domain modules in the ADR come in later steps, and these rules move with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { repoPath } from '../tools/paths.ts';
import { scannedFiles } from './source-scan.js';

// Pure modules the browser loads as they are (no build step), so they live in server/public; any layer may import them.
const SHARED = new Set(['server/public/goals.js', 'server/public/zone-defaults.js']);

/** Each file's layer: its top folder, with tools/backup (platform operations) and the shared modules apart. */
export function layerOf(file) {
  if (SHARED.has(file)) return 'shared';
  if (file.startsWith('tools/backup/')) return 'tools/backup';
  return file.split('/')[0];
}

// Who may import whom. A layer may always import itself. scripts are entry points and import anything.
const ALLOWED = {
  shared: [],
  tools: [],
  'tools/backup': ['tools', 'db'],
  db: ['tools'],
  metrics: ['tools', 'shared'],
  ingest: ['metrics', 'db', 'tools', 'shared'],
  agent: ['metrics', 'db', 'tools', 'shared'],
  jobs: ['agent', 'ingest', 'metrics', 'db', 'tools', 'tools/backup', 'shared'],
  demo: ['agent', 'ingest', 'metrics', 'db', 'tools', 'shared'],
  server: ['agent', 'ingest', 'jobs', 'metrics', 'db', 'tools', 'tools/backup', 'shared'],
  evals: ['agent', 'metrics', 'db', 'tools', 'demo', 'shared'],
  scripts: null,
};
// The composition root starts the demo instance (refreshDemoDatabase); no other server file may.
const ROOT_ONLY = { 'server/index.js': ['demo'] };

// Imports that still point the wrong way, each with what removes it. The test fails when one of these stops occurring,
// so the list never keeps an exception nobody needs.
const EXCEPTIONS = [
  {
    from: 'evals/run-review-eval.mjs', to: 'server/queries.js',
    why: 'medication writes for its synthetic cases; the runner is under the review eval harness gate, so it moves with '
      + 'the health-records data module and the owner\'s re-approval',
  },
  {
    from: 'evals/run-safety-eval.mjs', to: 'server/queries.js',
    why: 'the same medication writes; moves with the review eval runner to the health-records data module',
  },
];

// Metrics is the pure library: no SQL. metrics/load.ts is the data access that still lives there (it moves out with the
// agent files it serves, under the same harness gate).
const SQL_IN_METRICS = new Set(['metrics/load.ts']);

const IMPORT_FLOOR = 500; // 519 on 2026-11-17 after the route modules
const IMPORT = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every relative import in the code: { from, to } as repository paths. */
function imports() {
  const out = [];
  // The scanner skips the browser code (server/public); the shared modules are read too, as both sides load them.
  for (const from of [...scannedFiles(), ...SHARED]) {
    const src = readFileSync(repoPath(from), 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec.startsWith('.')) continue;
      out.push({ from, to: posix.normalize(posix.join(dirname(from).split('\\').join('/'), spec)) });
    }
  }
  return out;
}

test('every import follows the layer rules (docs/adr/0012)', () => {
  const all = imports();
  // A floor on what the guard sees (519 on 2026-11-17; raise it as code grows, never lower it to let a change pass), like the user-scope guard: a reader that quietly stops matching would pass everything.
  assert.ok(all.length >= IMPORT_FLOOR, `the guard reads ${all.length} imports, under its floor of ${IMPORT_FLOOR}`);
  const misses = [];
  const seen = new Set();
  for (const { from, to } of all) {
    const a = layerOf(from);
    const b = layerOf(to);
    if (a === b || ALLOWED[a] === null || ALLOWED[a]?.includes(b) || ROOT_ONLY[from]?.includes(b)) continue;
    const exception = EXCEPTIONS.find((e) => e.from === from && e.to === to);
    if (exception) { seen.add(exception); continue; }
    misses.push(`${from} -> ${to} (${a} may not import ${b})`);
  }
  assert.deepEqual(misses, [], `imports against the layer rules:\n${misses.join('\n')}`);
  const stale = EXCEPTIONS.filter((e) => !seen.has(e)).map((e) => `${e.from} -> ${e.to}`);
  assert.deepEqual(stale, [], 'listed exceptions that no longer occur: remove them from EXCEPTIONS');
});

test('every code folder has a layer, and the shared modules import only each other', () => {
  const all = imports();
  const layers = new Set(scannedFiles().map(layerOf));
  assert.deepEqual([...layers].filter((l) => !(l in ALLOWED)), [], 'a folder with no layer rule: add it to ALLOWED and the ADR');
  assert.ok(all.some((i) => SHARED.has(i.to)), 'the shared modules are imported (the names are current)');
  const outside = all.filter((i) => SHARED.has(i.from) && !SHARED.has(i.to));
  assert.deepEqual(outside, [], 'a shared module must stay pure and loadable in the browser');
});

test('metrics holds no SQL outside its one data access file', () => {
  const withSql = scannedFiles().filter((f) => f.startsWith('metrics/') && /\.prepare\(/.test(readFileSync(repoPath(f), 'utf8')));
  assert.deepEqual(withSql.filter((f) => !SQL_IN_METRICS.has(f)), [], 'database access belongs outside metrics');
  assert.deepEqual(withSql.filter((f) => SQL_IN_METRICS.has(f)), [...SQL_IN_METRICS], 'the exception still applies (remove it once the file moves)');
});
