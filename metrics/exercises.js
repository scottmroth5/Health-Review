// One name per lift. Sets normalized against the exercise dictionary (metrics/dictionary.js) carry a
// canonical_id and canonical_name, and metrics group by those; barbell and dumbbell versions are separate
// canonical exercises, so they are never combined. Sets with no dictionary entry fall back to baseKey,
// which merges spelling, plural, hyphen, typo and word-order variants only. The database keeps names as typed.

const TYPOS = { dumbell: 'dumbbell', ketlebell: 'kettlebell', barell: 'barbell', romain: 'roman' };
const JOINED = [[/\bpull ?ups?\b/g, 'pull up'], [/\bchin ?ups?\b/g, 'chin up'], [/\bsit ?ups?\b/g, 'sit up'],
  [/\bpush ?ups?\b/g, 'push up'], [/\bpull ?downs?\b/g, 'pull down'], [/\bget ?ups?\b/g, 'get up']];

function singular(word) {
  if (word.endsWith('ss')) return word;
  if (/(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (/(ie|ye)s$/.test(word)) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Spelling, plural, hyphen, typo and word-order normalized key for a name as typed. */
export const baseKey = (name) => {
  let text = String(name ?? '').toLowerCase().replace(/\bw\//g, 'with ').replace(/[^a-z0-9]+/g, ' ');
  for (const [re, to] of JOINED) text = text.replace(re, to);
  return text.split(' ').filter(Boolean).map(singular).map((w) => TYPOS[w] ?? w).sort().join(' ');
};

/** The grouping key for a set: its canonical exercise when normalized, otherwise its spelling key. */
export function exerciseKey(set) {
  return set.canonical_id ? `id:${set.canonical_id}` : baseKey(set.exercise);
}

/**
 * The name shown for one group of sets: the dictionary name when normalized, otherwise the spelling
 * used most (ties go to the one used most recently, then to the first one seen).
 * @param {Array<{exercise: string, date: string, canonical_name?: string}>} sets
 */
export function exerciseName(sets) {
  const canonical = sets.find((s) => s.canonical_name)?.canonical_name;
  if (canonical) return canonical;
  const seen = new Map();
  for (const s of sets) {
    const name = s.exercise.trim().replace(/\s+/g, ' ');
    const e = seen.get(name) ?? { name, n: 0, last: '' };
    e.n += 1;
    if (s.date > e.last) e.last = s.date;
    seen.set(name, e);
  }
  return [...seen.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last))[0]?.name ?? ''; // stable: first seen wins a tie
}
