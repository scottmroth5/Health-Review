// Applies the exercise dictionary to the Workout Log: writes canonical exercise, implement, movement
// pattern, primary flag and map status next to each raw row. Raw values are never changed, every run
// rewrites the normalized columns in place (no rows are added), and sync calls this after replacing a
// year's rows, so rerunning is always safe. Async (docs/adr/0006): normalizeAll opens a transaction, so it takes the async
// handle; the counts run on either.
import { baseKey } from '../metrics/exercises.ts';
import type { Dictionary } from '../metrics/dictionary.ts';
import type { Row } from '../metrics/stats.ts';
import type { UserDb } from './types.ts';

/**
 * db: scoped. Returns coverage counts (no names or values).
 */
export async function normalizeAll(db: UserDb, dictionary: Dictionary, { now = new Date() }: { now?: Date } = {}) {
  const stamp = now.toISOString();
  const names = (await db.prepare('SELECT DISTINCT exercise FROM strength_exercises WHERE user_id = @uid').all()).map((r: Row): string => r.exercise);
  const update = db.prepare(`UPDATE strength_exercises SET canonical_id = ?, implement = ?, movement_pattern = ?,
    is_primary = ?, map_status = ?, normalized_at = ? WHERE user_id = @uid AND exercise = ?`);
  await db.tx(async () => {
    for (const name of names) {
      const m = dictionary.lookup(name);
      await update.run(m.id, m.implement, m.pattern, m.primary ? 1 : 0, m.status, stamp, name);
    }
  });
  return await coverage(db);
}

/** Sets and exercise rows by map status, and the share of sets mapped to a canonical exercise. */
export async function coverage(db: UserDb) {
  const rows = await db.prepare(`SELECT e.map_status AS status, COUNT(DISTINCT e.id) AS exercises, COUNT(s.exercise_id) AS sets
    FROM strength_exercises e LEFT JOIN strength_sets s ON s.exercise_id = e.id AND s.user_id = e.user_id WHERE e.user_id = @uid GROUP BY e.map_status`).all();
  const byStatus: Record<string, { exercises: number, sets: number }> = Object.fromEntries(rows.map((r: Row) => [r.status, { exercises: r.exercises, sets: r.sets }]));
  const sets: number = rows.reduce((a: number, r: Row) => a + r.sets, 0);
  const mapped = byStatus.mapped?.sets ?? 0;
  return { sets, mappedSets: mapped, mappedPct: sets ? Math.round((mapped / sets) * 1000) / 10 : 0, byStatus };
}

/**
 * Names still needing a dictionary entry (unmapped and inferred), grouped by lookup key, most sets first.
 * Each group lists the spellings as typed, so one dictionary entry can cover them all.
 */
/** Logged sets per canonical exercise id, for the typo finder's keeper choice. Counts only. */
export async function canonicalSetCounts(db: UserDb): Promise<Map<string, number>> {
  return new Map((await db.prepare(`SELECT e.canonical_id AS id, COUNT(s.exercise_id) AS sets FROM strength_exercises e
    LEFT JOIN strength_sets s ON s.exercise_id = e.id AND s.user_id = e.user_id WHERE e.user_id = @uid AND e.canonical_id IS NOT NULL GROUP BY e.canonical_id`).all()).map((r: Row): [string, number] => [r.id, r.sets]));
}

export async function unmappedNames(db: UserDb) {
  // Rows of one name share a status and implement (normalization goes by name); MIN picks it on both engines, where
  // PostgreSQL refuses a bare column outside GROUP BY.
  const rows = await db.prepare(`SELECT e.exercise AS name, MIN(e.map_status) AS status, MIN(e.implement) AS implement, COUNT(s.exercise_id) AS sets,
      MIN(e.tab_year) AS first, MAX(e.tab_year) AS last
    FROM strength_exercises e LEFT JOIN strength_sets s ON s.exercise_id = e.id AND s.user_id = e.user_id
    WHERE e.user_id = @uid AND e.map_status IN ('unmapped', 'inferred', 'pending') GROUP BY e.exercise`).all();
type NameGroup = { key: string, spellings: string[], status: string, implement: string | null, sets: number, first: number, last: number };
  const groups = new Map<string, NameGroup>();
  for (const r of rows) {
    const key = baseKey(r.name);
    const g: NameGroup = groups.get(key) ?? { key, spellings: [], status: r.status, implement: r.implement, sets: 0, first: r.first, last: r.last };
    g.spellings.push(r.name.trim());
    g.sets += r.sets;
    g.first = Math.min(g.first, r.first);
    g.last = Math.max(g.last, r.last);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.sets - a.sets || a.key.localeCompare(b.key));
}
