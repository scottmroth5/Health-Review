// Applies the exercise dictionary to the Workout Log: writes canonical exercise, implement, movement
// pattern, primary flag and map status next to each raw row. Raw values are never changed, every run
// rewrites the normalized columns in place (no rows are added), and sync calls this after replacing a
// year's rows, so rerunning is always safe. Async (docs/adr/0006): normalizeAll opens a transaction, so it takes the async
// handle; the counts run on either.
import { baseKey } from '../metrics/exercises.js';

/**
 * @param {import('../db/database.ts').Database} db  (scoped)
 * @param {ReturnType<import('../metrics/dictionary.js').createDictionary>} dictionary
 * @returns coverage counts (no names or values)
 */
export async function normalizeAll(db, dictionary, { now = new Date() } = {}) {
  const stamp = now.toISOString();
  const names = (await db.prepare('SELECT DISTINCT exercise FROM strength_exercises WHERE user_id = @uid').all()).map((r) => r.exercise);
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
export async function coverage(db) {
  const rows = await db.prepare(`SELECT e.map_status AS status, COUNT(DISTINCT e.id) AS exercises, COUNT(s.exercise_id) AS sets
    FROM strength_exercises e LEFT JOIN strength_sets s ON s.exercise_id = e.id AND s.user_id = e.user_id WHERE e.user_id = @uid GROUP BY e.map_status`).all();
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, { exercises: r.exercises, sets: r.sets }]));
  const sets = rows.reduce((a, r) => a + r.sets, 0);
  const mapped = byStatus.mapped?.sets ?? 0;
  return { sets, mappedSets: mapped, mappedPct: sets ? Math.round((mapped / sets) * 1000) / 10 : 0, byStatus };
}

/**
 * Names still needing a dictionary entry (unmapped and inferred), grouped by lookup key, most sets first.
 * Each group lists the spellings as typed, so one dictionary entry can cover them all.
 */
/** Logged sets per canonical exercise id, for the typo finder's keeper choice. Counts only. */
export async function canonicalSetCounts(db) {
  return new Map((await db.prepare(`SELECT e.canonical_id AS id, COUNT(s.exercise_id) AS sets FROM strength_exercises e
    LEFT JOIN strength_sets s ON s.exercise_id = e.id AND s.user_id = e.user_id WHERE e.user_id = @uid AND e.canonical_id IS NOT NULL GROUP BY e.canonical_id`).all()).map((r) => [r.id, r.sets]));
}

export async function unmappedNames(db) {
  const rows = await db.prepare(`SELECT e.exercise AS name, e.map_status AS status, e.implement, COUNT(s.exercise_id) AS sets,
      MIN(e.tab_year) AS first, MAX(e.tab_year) AS last
    FROM strength_exercises e LEFT JOIN strength_sets s ON s.exercise_id = e.id AND s.user_id = e.user_id
    WHERE e.user_id = @uid AND e.map_status IN ('unmapped', 'inferred', 'pending') GROUP BY e.exercise`).all();
  const groups = new Map();
  for (const r of rows) {
    const key = baseKey(r.name);
    const g = groups.get(key) ?? { key, spellings: [], status: r.status, implement: r.implement, sets: 0, first: r.first, last: r.last };
    g.spellings.push(r.name.trim());
    g.sets += r.sets;
    g.first = Math.min(g.first, r.first);
    g.last = Math.max(g.last, r.last);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.sets - a.sets || a.key.localeCompare(b.key));
}
