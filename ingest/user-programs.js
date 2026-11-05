// A user's own program catalog (multi-user, phase 5): programs in the MAPS catalog's format (metrics/catalog.js), each
// with the words that tie Workout Log names to it, built in the app, imported as JSON or drafted by Claude from a PDF.
// Every write re-runs block detection (confirmed blocks are never touched) and refreshes phases, as the matchers and
// phase lengths may have changed. Takes a scoped database (db/scope.js): the async handle (docs/adr/0006) for the writes,
// which open transactions; either for exportPrograms.
import { randomUUID } from 'node:crypto';
import { programProblems } from '../metrics/catalog.js';
import { loadUserPrograms } from '../metrics/load.js';
import { detect, writeDetected, refreshPhases } from './program-blocks.js';

export const SOURCES = ['manual', 'import', 'pdf'];
const MAX_MATCH = 200;
export class ProgramError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.problems = problems;
  }
}

/** The fields a stored program keeps (anything else in a submitted program is dropped). */
function clean(p) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => [k, o[k]]));
  const profile = pick(p.profile, ['focus', 'conditioning', 'mobility', 'extra_minutes_per_week', 'standalone']);
  return {
    name: String(p.name ?? '').trim(),
    weeks: p.weeks,
    ...(Object.keys(profile).length ? { profile } : {}),
    phases: (p.phases ?? []).map((ph) => ({
      ...pick(ph, ['name', 'weeks', 'workouts_per_week', 'sets', 'reps', 'rest', 'special_weeks']),
      workouts: (ph.workouts ?? []).map((wo) => ({
        name: wo.name,
        exercises: (wo.exercises ?? []).map((ex) => pick(ex, ['name', 'sets', 'reps', 'rest', 'notes'])),
      })),
    })),
  };
}

/** Checks a program and its match words; throws a ProgramError listing every problem. Returns the cleaned program. */
export function checkProgram(program, match) {
  const p = clean(program ?? {});
  const problems = programProblems(p);
  if (String(match ?? '').length > MAX_MATCH) problems.push(`match words: at most ${MAX_MATCH} characters`);
  if (problems.length) throw new ProgramError(`${p.name || 'The program'} is not valid`, problems);
  return p;
}

/** After any change: detect blocks again (detected ones only) and refresh phases with the user's catalog. */
async function refresh(db, today, catalog, now) {
  await writeDetected(db, await detect(db, today), { now });
  await refreshPhases(db, await catalog());
}

/**
 * Saves a new program or replaces one (by id). Names are unique per user.
 * @param {{ id?: string, program: object, match?: string, source?: string, today: string, catalog: () => object|null, now?: Date }} o
 * @returns the stored row
 */
export async function saveProgram(db, { id, program, match, source = 'manual', today, catalog, now = new Date() }) {
  const p = checkProgram(program, match);
  const words = String(match ?? '').trim() || p.name;
  const stamp = now.toISOString();
  const clash = await db.prepare('SELECT id FROM user_programs WHERE user_id = @uid AND name = ? AND id <> ?').get(p.name, id ?? '');
  if (clash) throw new ProgramError(`You already have a program named ${p.name}`);
  await db.tx(async () => {
    if (id) {
      const changed = (await db.prepare('UPDATE user_programs SET name = ?, match = ?, program = ?, updated_at = ? WHERE user_id = @uid AND id = ?')
        .run(p.name, words, JSON.stringify(p), stamp, id)).changes;
      if (!changed) throw new ProgramError('No such program');
    } else {
      id = randomUUID();
      await db.prepare(`INSERT INTO user_programs (user_id, id, name, match, program, source, created_at, updated_at)
        VALUES (@uid, ?, ?, ?, ?, ?, ?, ?)`).run(id, p.name, words, JSON.stringify(p), SOURCES.includes(source) ? source : 'manual', stamp, stamp);
    }
    await refresh(db, today, catalog, now);
  });
  return (await loadUserPrograms(db)).find((r) => r.id === id);
}

/** Deletes one program; returns whether it existed. */
export async function deleteProgram(db, id, { today, catalog, now = new Date() }) {
  let gone = false;
  await db.tx(async () => {
    gone = (await db.prepare('DELETE FROM user_programs WHERE user_id = @uid AND id = ?').run(id)).changes > 0;
    if (gone) await refresh(db, today, catalog, now);
  });
  return gone;
}

/**
 * Imports one program or a catalog ({ version: 1, programs: [...] }), all or nothing: every program must be valid and
 * none may share a name with another in the file or with one the user already has. Each may carry match words (match).
 * @returns {number} programs added
 */
export async function importPrograms(db, json, { today, catalog, now = new Date() }) {
  const list = Array.isArray(json?.programs) ? json.programs : json && typeof json === 'object' && json.name ? [json] : null;
  if (!list?.length) throw new ProgramError('Expected a program, or a catalog with a programs list');
  if (list.length > 50) throw new ProgramError('At most 50 programs at a time');
  const problems = [];
  const have = new Set((await loadUserPrograms(db)).map((r) => r.name));
  const seen = new Set();
  const checked = list.map((raw, i) => {
    try {
      const p = checkProgram(raw, raw?.match);
      if (have.has(p.name)) problems.push(`${p.name}: you already have a program with this name`);
      if (seen.has(p.name)) problems.push(`${p.name}: listed twice`);
      seen.add(p.name);
      return { p, match: String(raw.match ?? '').trim() || p.name };
    } catch (err) {
      if (!(err instanceof ProgramError)) throw err;
      problems.push(...(err.problems.length ? err.problems : [`program #${i + 1}: ${err.message}`]));
      return null;
    }
  });
  if (problems.length) throw new ProgramError('Nothing was imported', problems);
  const stamp = now.toISOString();
  const insert = db.prepare(`INSERT INTO user_programs (user_id, id, name, match, program, source, created_at, updated_at)
    VALUES (@uid, ?, ?, ?, ?, 'import', ?, ?)`);
  await db.tx(async () => {
    for (const { p, match } of checked) await insert.run(randomUUID(), p.name, match, JSON.stringify(p), stamp, stamp);
    await refresh(db, today, catalog, now);
  });
  return checked.length;
}

/** The user's own programs as a catalog file (with their match words), never anyone else's. */
export async function exportPrograms(db) {
  return { version: 1, programs: (await loadUserPrograms(db)).map((r) => ({ ...r.program, match: r.match })) };
}
