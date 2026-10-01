// One name per lift. The Workout Log spells the same exercise many ways ("Pullups", "Pull-ups", "Pull ups"),
// so metrics group sets by exerciseKey rather than by the text as typed; the database keeps the names as typed.
// Spelling, plural, hyphen, typo and word-order variants merge automatically. Lifts that differ by a word
// ("Bench Press" and "Barbell Bench") merge only when listed in MERGES: add new same-lift names there.

export const MERGES = [
  ['Barbell Bench Press', ['Bench Press', 'Barbell Bench']],
  ['Barbell Squat', ['Barbell Back Squat', 'Squat']],
  ['Barbell Deadlift', ['Deadlift']],
  ['Barbell Z Press', ['Z Press']],
  ['Incline Barbell Bench Press', ['Incline Bench', 'Incline Bench Press', 'Incline Barbell Bench', 'Incline Barbell Press', 'Incline Press', 'Incline Barbell Chest Press']],
];

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

const baseKey = (name) => {
  let text = String(name ?? '').toLowerCase().replace(/\bw\//g, 'with ').replace(/[^a-z0-9]+/g, ' ');
  for (const [re, to] of JOINED) text = text.replace(re, to);
  return text.split(' ').filter(Boolean).map(singular).map((w) => TYPOS[w] ?? w).sort().join(' ');
};

const MERGED = new Map();
for (const [display, variants] of MERGES) for (const n of [display, ...variants]) MERGED.set(baseKey(n), baseKey(display));
const DISPLAY = new Map(MERGES.map(([display]) => [baseKey(display), display]));

/** The grouping key for an exercise name: variants of one lift share a key. */
export function exerciseKey(name) {
  const key = baseKey(name);
  return MERGED.get(key) ?? key;
}

/**
 * The name shown for one group of sets: the MERGES name if listed, otherwise the spelling used most
 * (ties go to the one used most recently, then to the first one seen).
 * @param {string} key
 * @param {Array<{exercise: string, date: string}>} sets
 */
export function exerciseName(key, sets) {
  if (DISPLAY.has(key)) return DISPLAY.get(key);
  const seen = new Map();
  for (const s of sets) {
    const name = s.exercise.trim().replace(/\s+/g, ' ');
    const e = seen.get(name) ?? { name, n: 0, last: '' };
    e.n += 1;
    if (s.date > e.last) e.last = s.date;
    seen.set(name, e);
  }
  return [...seen.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last))[0]?.name ?? key; // stable: first seen wins a tie
}
