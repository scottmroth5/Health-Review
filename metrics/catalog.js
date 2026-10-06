// The MAPS program catalog (data/maps/programs.json): each program's length, phases with week ranges, deload and
// failure weeks, and prescribed sets, reps, rest and workouts, transcribed from the owner's Mind Pump PDFs. It is
// copyrighted material, so it lives under data/ (gitignored) and only computed facts from it (program, phase,
// week) ever leave this machine. Everything works without it: phases are simply unknown.
import { existsSync, readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';
import { PROGRAMS } from './programs.js';

export const CATALOG_PATH = repoPath('data', 'maps', 'programs.json');
const PROGRAM_NAMES = PROGRAMS.map(([name]) => name);

/** "2-5" -> { min: 2, max: 5 }; "3" -> { min: 3, max: 3 }; anything else -> null. */
export function parseRange(text) {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : Number(m[2]);
  return max >= min ? { min, max } : null;
}

/** Prescribed reps: "8-12" -> { min: 8, max: 12, unit: 'reps' }; a timed hold "30-60s" -> unit 'seconds'. */
export function parseReps(text) {
  const timed = /^\s*(.+?)\s*s\s*$/.exec(String(text ?? ''));
  const r = parseRange(timed ? timed[1] : text);
  return r ? { ...r, unit: timed ? 'seconds' : 'reps' } : null;
}

/** The middle of a prescribed range, for estimates ("4-6" sets -> 5). */
export const midpoint = (text) => {
  const r = parseRange(text);
  return r ? (r.min + r.max) / 2 : null;
};

const isInt = (n) => Number.isInteger(n) && n > 0;

/**
 * Validates a parsed catalog (throws listing every problem) and builds its lookups.
 * @param {object} json
 * @param {{ programs?: string[] }} [options]  known program names (defaults to PROGRAMS in metrics/programs.js)
 */
export function createCatalog(json, { programs = PROGRAM_NAMES } = {}) {
  const problems = [];
  if (json?.version !== 1) problems.push('version must be 1');
  const list = Array.isArray(json?.programs) ? json.programs : (problems.push('programs must be a list'), []);
  const seen = new Set();
  for (const [i, p] of list.entries()) {
    const at = p?.name ? `${p.name}` : `program #${i + 1}`;
    if (!programs.includes(p?.name)) problems.push(`${at}: name must be one of the programs in metrics/programs.js`);
    if (seen.has(p?.name)) problems.push(`${at}: listed twice`);
    seen.add(p?.name);
    if (!isInt(p?.weeks)) problems.push(`${at}: weeks must be a whole number of weeks`);
    const phases = Array.isArray(p?.phases) ? p.phases : [];
    if (!phases.length) problems.push(`${at}: phases must be a non-empty list`);
    let next = 1;
    for (const ph of phases) {
      const [a, b] = Array.isArray(ph?.weeks) ? ph.weeks : [];
      const label = `${at} ${ph?.name ?? 'phase'}`;
      if (!ph?.name) problems.push(`${at}: every phase needs a name`);
      if (!isInt(a) || !isInt(b) || b < a) { problems.push(`${label}: weeks must be [first, last]`); continue; }
      if (a !== next) problems.push(`${label}: starts at week ${a}, expected ${next} (no gaps or overlaps)`);
      next = b + 1;
      for (const key of ['sets', 'reps']) if (ph[key] !== undefined && !parseRange(ph[key])) problems.push(`${label}: ${key} "${ph[key]}" is not a number or range`);
      for (const kind of ['deload', 'failure']) {
        for (const w of ph.special_weeks?.[kind] ?? []) if (!isInt(w) || w < a || w > b) problems.push(`${label}: ${kind} week ${w} is outside the phase`);
      }
      for (const wo of ph.workouts ?? []) {
        if (!wo?.name) problems.push(`${label}: every workout needs a name`);
        for (const ex of wo?.exercises ?? []) {
          if (!ex?.name) problems.push(`${label} ${wo?.name ?? ''}: every exercise needs a name`);
          if (ex?.sets !== undefined && !parseRange(ex.sets)) problems.push(`${label} ${ex.name}: sets "${ex.sets}" is not a number or range`);
          if (ex?.reps !== undefined && !parseReps(ex.reps)) problems.push(`${label} ${ex.name}: reps "${ex.reps}" is not a number, range, or seconds ("30-60s")`);
        }
      }
    }
    if (phases.length && isInt(p?.weeks) && next - 1 !== p.weeks) problems.push(`${at}: phases cover weeks 1-${next - 1}, but the program has ${p.weeks}`);
  }
  if (problems.length) {
    const err = new Error(`Program catalog is invalid:\n  ${problems.join('\n  ')}`);
    err.problems = problems;
    throw err;
  }

  const byName = new Map(list.map((p) => [p.name, p]));
  return {
    programs: list,
    find: (name) => byName.get(name) ?? null,
    programWeeks: (name) => byName.get(name)?.weeks ?? null,
    /** The phase for a week of a program: { phase, deload, failure }, { phase: null, beyond: true } past the end, or null. */
    phaseAt(name, week) {
      const p = byName.get(name);
      if (!p || !isInt(week)) return null;
      if (week > p.weeks) return { phase: null, beyond: true, deload: false, failure: false };
      const ph = p.phases.find((x) => week >= x.weeks[0] && week <= x.weeks[1]);
      return {
        phase: ph.name,
        beyond: false,
        deload: (ph.special_weeks?.deload ?? []).includes(week),
        failure: (ph.special_weeks?.failure ?? []).includes(week),
      };
    },
  };
}

const UNILATERAL = /\b(single|one[- ]arm|one[- ]leg|alternating|lunges?|split squats?|step[- ]?ups?|unilateral|bulgarian|suitcase|pistol|cossack)\b/i;

/**
 * Prescribed work in one phase, from its workouts (estimates use the middle of each range):
 * workouts, sets per workout, sets per week, and the share of heavy sets (5 reps or fewer; a range that straddles
 * 5 counts for the part of it at 5 or fewer, so "4-8" is 2 of 5 rep counts, 40% heavy),
 * on arm isolation (dictionary pattern "arms") and on one side at a time. Names with no dictionary entry are listed.
 * @param {object} phase  a catalog phase
 * @param {(name: string) => {status: string, pattern: string|null}} lookup  dictionary.lookup
 */
export function phaseStats(phase, lookup) {
  const workouts = phase.workouts ?? [];
  let sets = 0;
  let heavy = 0;
  let arms = 0;
  let unilateral = 0;
  const unmapped = new Set();
  for (const wo of workouts) {
    for (const ex of wo.exercises ?? []) {
      const n = midpoint(ex.sets ?? '1') ?? 1;
      const reps = parseReps(ex.reps ?? '');
      const m = lookup(ex.name);
      sets += n;
      if (reps?.unit === 'reps' && reps.min <= 5) heavy += n * ((Math.min(reps.max, 5) - reps.min + 1) / (reps.max - reps.min + 1));
      if (m.pattern === 'arms') arms += n;
      if (UNILATERAL.test(ex.name)) unilateral += n;
      if (m.status !== 'mapped') unmapped.add(ex.name);
    }
  }
  const perWorkout = workouts.length ? sets / workouts.length : 0;
  const share = (x) => (sets ? Math.round((x / sets) * 100) : 0);
  return {
    workouts: workouts.length,
    setsPerWorkout: Math.round(perWorkout),
    setsPerWeek: phase.workouts_per_week ? Math.round(perWorkout * phase.workouts_per_week) : null,
    heavyPct: share(heavy),
    armIsolationPct: share(arms),
    unilateralPct: share(unilateral),
    unmapped: [...unmapped],
  };
}

/** The catalog, or null when the file does not exist (an invalid file throws). */
export function loadCatalog(path = CATALOG_PATH) {
  if (!existsSync(path)) return null;
  return createCatalog(JSON.parse(readFileSync(path, 'utf8')));
}
