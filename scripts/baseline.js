// The v3 baseline (Phase 0): how big the database is and how long things take today, so later phases can be compared
// with it. Counts and milliseconds only: every query's result is thrown away, and nothing read from a row is kept
// except table and run names. Opens the database read-only (never openHealthStore, so no migration or copy runs).
//   node scripts/baseline.js        on the server: docker compose exec app node scripts/baseline.js
// Writes data/baseline/baseline-<owner time>.json (the data folder, gitignored) and prints the same.
import Database from 'better-sqlite3';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB_PATH } from '../db/store.js';
import { createSqliteDatabase } from '../db/database.ts';
import { scopeDatabase } from '../db/scope.js';
import { OWNER_ID } from '../db/users.js';
import { computeWeek } from '../metrics/index.js';
import { loadMetricSettings, loadWeekData } from '../metrics/load.js';
import { addDays, lastWeekEnd } from '../metrics/stats.js';
import { cardioZoneView, history, reviewStatus, trainingDashboard, vo2max } from '../server/queries.js';
import { dataPath } from '../tools/paths.js';
import { localDate, localStamp } from '../tools/time.js';

const RUNS = 5;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : null; };

/** Median milliseconds of fn (sync or async) over RUNS calls (one untimed warm-up first); the result is discarded. */
async function timeIt(fn) {
  await fn();
  const ms = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  return Math.round(median(ms) * 10) / 10;
}

/**
 * The baseline for a database (read-only). Across users for sizes and run durations, as the owner for query timings.
 * Sizes, row counts and pragmas are SQLite's own, read on the raw handle; the timings run on the async handle, as
 * requests do (docs/adr/0006).
 * @param {import('better-sqlite3').Database} db  the raw database, opened read-only
 */
export async function baseline(db, { now = new Date(), fileBytes = null } = {}) {
  const today = localDate(now);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all();
  const rowCounts = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) FROM "${t.replaceAll('"', '""')}"`).pluck().get()]));

  // Run durations by kind over 90 days, every user (metadata only: name, status and duration). A skipped run (the review's
  // data gate, a user with no AI) is counted apart and left out of the durations; failed is any other status but ok.
  const since = new Date(now.getTime() - 90 * 86400000).toISOString();
  const byName = new Map();
  for (const r of db.prepare("SELECT name, status, duration_ms FROM runs WHERE started_at >= ? AND duration_ms IS NOT NULL").all(since)) {
    const k = byName.get(r.name) ?? { ms: [], failed: 0, skipped: 0 };
    if (r.status === 'skipped') {
      k.skipped += 1;
    } else {
      k.ms.push(r.duration_ms);
      if (r.status !== 'ok') k.failed += 1;
    }
    byName.set(r.name, k);
  }
  const runs = Object.fromEntries([...byName].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, k]) => [name, { count: k.ms.length + k.skipped, failed: k.failed, skipped: k.skipped, medianMs: median(k.ms), p95Ms: p95(k.ms) }]));

  // The functions behind the busiest screens and the weekly review, as the owner.
  const owner = scopeDatabase(createSqliteDatabase(db), OWNER_ID);
  const weekEnd = lastWeekEnd(today);
  const queriesMs = {
    'history 90d (Health tab)': await timeIt(() => history(owner, addDays(today, -89), today)),
    'trainingDashboard month': await timeIt(() => trainingDashboard(owner, 'month', today)),
    'trainingDashboard year': await timeIt(() => trainingDashboard(owner, 'year', today)),
    'vo2max 1y': await timeIt(() => vo2max(owner, '1y', today)),
    'cardioZoneView 90d': await timeIt(() => cardioZoneView(owner, '90d', today)),
    'reviewStatus': await timeIt(() => reviewStatus(owner, today, now)),
    'computeWeek last week': await timeIt(async () => computeWeek(await loadWeekData(owner, weekEnd), { weekEnd, ...(await loadMetricSettings(owner)) })),
  };

  const pragma = (name) => db.pragma(name, { simple: true });
  return {
    takenAt: localStamp(now),
    node: process.version,
    database: { fileBytes, pageCount: pragma('page_count'), pageSize: pragma('page_size'), tables: tables.length },
    rowCounts,
    runs90d: runs,
    queriesMs,
    timingRuns: RUNS,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.env.HEALTH_DB_PATH || DEFAULT_DB_PATH;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = await baseline(db, { fileBytes: statSync(path).size });
    const dir = dataPath('baseline');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `baseline-${result.takenAt.replace(':', '')}.json`);
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
    console.log(`baseline: written to ${file}`);
  } finally {
    db.close();
  }
}
