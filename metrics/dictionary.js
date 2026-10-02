// The canonical exercise dictionary (config/exercise-dictionary.json): every logged name variant maps to one
// canonical exercise with an implement, a movement pattern and whether it is a primary lift. Barbell and
// dumbbell versions of a lift are separate entries and are never compared. Names match by baseKey, so one
// entry covers spelling, plural, hyphen, typo and word-order variants. A name with no entry is never guessed:
// it is 'inferred' when exactly one implement word names its implement (canonical exercise still unknown),
// otherwise 'unmapped'. Names listed under "ignore" are notes typed into the exercise column.
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';
import { baseKey } from './exercises.js';

export const IMPLEMENTS = ['barbell', 'dumbbell', 'machine', 'cable', 'landmine', 'bodyweight', 'kettlebell', 'band', 'suspension', 'other'];
export const PATTERNS = ['squat', 'hinge', 'horizontal press', 'incline press', 'vertical press', 'horizontal pull', 'vertical pull',
  'arms', 'core', 'carry', 'mobility', 'other'];
export const DICTIONARY_PATH = repoPath('config', 'exercise-dictionary.json');

// Words that name the implement outright, including the log's usual typos and plurals.
const IMPLEMENT_WORDS = [
  ['barbell', /\b(barbells?|barells?|bb|ez bar|trap bar)\b/], ['dumbbell', /\b(dumbb?ells?|db)\b/],
  ['kettlebell', /\b(kettle ?bells?|ketlebells?|kb)\b/], ['landmine', /\blandmines?\b/], ['cable', /\bcables?\b/],
  ['machine', /\b(machines?|smith)\b/], ['band', /\b(bands?|banded)\b/], ['suspension', /\b(suspension|trx)\b/],
  ['bodyweight', /\bbody ?weight\b/],
];

/** The implement named in an exercise name, or null when none or more than one is named. */
export function implementFromName(name) {
  const text = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const found = IMPLEMENT_WORDS.filter(([, re]) => re.test(text)).map(([k]) => k);
  return found.length === 1 ? found[0] : null;
}

function fail(problems) {
  const err = new Error(`Exercise dictionary is invalid:\n  ${problems.join('\n  ')}`);
  err.problems = problems;
  return err;
}

/**
 * Validates a parsed dictionary and builds its lookup. Throws listing every problem.
 * @param {{version: number, exercises: Array<object>, ignore?: string[]}} json
 */
export function createDictionary(json) {
  const problems = [];
  if (json?.version !== 1) problems.push('version must be 1');
  const exercises = Array.isArray(json?.exercises) ? json.exercises : (problems.push('exercises must be a list'), []);
  const byKey = new Map();
  const ids = new Set();
  const claim = (name, owner) => {
    const key = baseKey(name);
    if (!key) return problems.push(`${owner}: empty name`);
    const prev = byKey.get(key);
    if (prev && prev !== owner) problems.push(`"${name}" matches both ${prev} and ${owner}`);
    else byKey.set(key, owner);
  };
  for (const [i, e] of exercises.entries()) {
    const at = e?.id ? `exercise ${e.id}` : `exercise #${i + 1}`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e?.id ?? '')) problems.push(`${at}: id must be lowercase words joined by hyphens`);
    else if (ids.has(e.id)) problems.push(`${at}: duplicate id`);
    else ids.add(e.id);
    if (!e?.name?.trim()) problems.push(`${at}: name is required`);
    if (!IMPLEMENTS.includes(e?.implement)) problems.push(`${at}: implement must be one of ${IMPLEMENTS.join(', ')}`);
    if (!PATTERNS.includes(e?.pattern)) problems.push(`${at}: pattern must be one of ${PATTERNS.join(', ')}`);
    if (typeof e?.primary !== 'boolean') problems.push(`${at}: primary must be true or false`);
    if (e?.variants !== undefined && !Array.isArray(e.variants)) problems.push(`${at}: variants must be a list`);
    if (e?.id && e?.name) for (const n of [e.name, ...(e.variants ?? [])]) claim(n, e.id);
  }
  for (const n of json?.ignore ?? []) claim(n, 'ignore');
  if (problems.length) throw fail(problems);

  const entries = new Map(exercises.map((e) => [e.id, e]));
  return {
    exercises,
    /**
     * @returns {{status: 'mapped'|'inferred'|'unmapped'|'ignored', id: string|null, name: string|null,
     *   implement: string|null, pattern: string|null, primary: boolean, lift: string|null}}
     */
    lookup(rawName) {
      const owner = byKey.get(baseKey(rawName));
      if (owner === 'ignore') return { status: 'ignored', id: null, name: null, implement: null, pattern: null, primary: false, lift: null };
      if (owner) {
        const e = entries.get(owner);
        return { status: 'mapped', id: e.id, name: e.name, implement: e.implement, pattern: e.pattern, primary: e.primary, lift: e.lift ?? null };
      }
      const implement = implementFromName(rawName);
      return { status: implement ? 'inferred' : 'unmapped', id: null, name: null, implement, pattern: null, primary: false, lift: null };
    },
  };
}

/** Reads and validates the dictionary file. */
export function loadDictionary(path = DICTIONARY_PATH) {
  return createDictionary(JSON.parse(readFileSync(path, 'utf8')));
}
