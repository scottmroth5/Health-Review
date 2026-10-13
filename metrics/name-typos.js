// Likely typos among exercise names, for the owner to confirm (npm run log:typos). Pure; never merges anything.
// Two names are a likely typo pair when their spelling keys (baseKey: case, hyphens, plurals and word order already
// handled) differ in exactly one word, and those two words are 1 or 2 letters apart (at most half the longer word;
// words of 3 or more letters). Dictionary pairs must also share implement and movement pattern, so "Ball Leg Curls"
// and "Band Leg Curls" are not offered. Pairs the owner marked distinct in the dictionary are never offered again.
import { baseKey } from './exercises.js';

const MAX_LETTERS = 2;

/** Levenshtein distance between two words. */
export function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length];
}

/** The two words that differ when two spelling keys differ in exactly one word and look like a typo, else null. */
export function typoWords(keyA, keyB) {
  if (!keyA || !keyB || keyA === keyB) return null;
  const a = keyA.split(' ');
  const b = keyB.split(' ');
  if (a.length !== b.length) return null;
  const onlyA = a.filter((w) => !b.includes(w));
  const onlyB = b.filter((w) => !a.includes(w));
  if (onlyA.length !== 1 || onlyB.length !== 1) return null;
  const [x, y] = [onlyA[0], onlyB[0]];
  const longer = Math.max(x.length, y.length);
  const d = editDistance(x, y);
  return longer >= 3 && d <= MAX_LETTERS && d <= longer / 2 ? [x, y] : null;
}

/**
 * @param {object} input
 * @param {{ exercises: Array<{id, name, implement, pattern, variants?}>, distinct?: string[][] }} input.dictionary  the dictionary JSON
 * @param {Array<{key: string, spellings: string[], sets: number}>} [input.unmapped]  unmappedNames groups
 * @param {Map<string, number>|Record<string, number>} [input.setCounts]  logged sets per canonical id
 * @returns {{ entries: Array<object>, unmapped: Array<object> }} each sorted most sets first
 */
export function typoCandidates({ dictionary, unmapped = [], setCounts = {} }) {
  const sets = (id) => (setCounts instanceof Map ? setCounts.get(id) : setCounts[id]) ?? 0;
  const distinct = new Set((dictionary.distinct ?? []).map((p) => [...p].sort().join('|')));
  const names = dictionary.exercises.flatMap((e) => [e.name, ...(e.variants ?? [])].map((n) => ({ e, key: baseKey(n) })));
  // How often each word appears across the dictionary: the correctly spelled side of a typo is usually the common one
  // ("single" against "sing"), so it decides the keeper before set counts do.
  const wordCount = new Map();
  for (const n of names) for (const w of new Set(n.key.split(' '))) wordCount.set(w, (wordCount.get(w) ?? 0) + 1);
  const common = (w) => wordCount.get(w) ?? 0;

  const entries = new Map();
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      if (a.e.id === b.e.id || a.e.implement !== b.e.implement || a.e.pattern !== b.e.pattern) continue;
      const pairKey = [a.e.id, b.e.id].sort().join('|');
      if (distinct.has(pairKey) || entries.has(pairKey)) continue;
      const words = typoWords(a.key, b.key);
      if (!words) continue;
      // Keep the side whose differing word is more common in the dictionary, then the one logged more, then the one
      // listed first.
      const [wa, wb] = words;
      const bFirst = common(wb) !== common(wa) ? common(wb) > common(wa) : sets(b.e.id) > sets(a.e.id);
      const [keep, drop] = bFirst ? [b.e, a.e] : [a.e, b.e];
      entries.set(pairKey, {
        kind: 'entry', keepId: keep.id, keepName: keep.name, keepSets: sets(keep.id),
        dropId: drop.id, dropName: drop.name, dropSets: sets(drop.id), words,
      });
    }
  }

  const near = [];
  for (const g of unmapped) {
    const matches = new Map();
    for (const n of names) {
      if (distinct.has([n.e.id, `key:${g.key}`].sort().join('|'))) continue;
      const words = typoWords(g.key, n.key);
      if (words && !matches.has(n.e.id)) matches.set(n.e.id, { id: n.e.id, name: n.e.name, sets: sets(n.e.id), words });
    }
    if (!matches.size) continue;
    // The closest match is the one logged most; others are listed as alternatives.
    const [best, ...others] = [...matches.values()].sort((x, y) => y.sets - x.sets || x.name.localeCompare(y.name));
    near.push({ kind: 'unmapped', key: g.key, spellings: g.spellings, sets: g.sets, keepId: best.id, keepName: best.name, keepSets: best.sets, words: best.words,
      alternatives: others.map((o) => o.name) });
  }

  const bySets = (x, y) => (y.dropSets ?? y.sets) - (x.dropSets ?? x.sets) || (x.dropName ?? x.spellings[0]).localeCompare(y.dropName ?? y.spellings[0]);
  return { entries: [...entries.values()].sort((x, y) => y.keepSets - x.keepSets || bySets(x, y)), unmapped: near.sort(bySets) };
}

/**
 * The dictionary with the chosen candidates applied: an entry pair folds the other exercise (its name and variants)
 * into the keeper and removes it; an unmapped name's spellings become variants of the matched exercise. Pure; the
 * caller validates (createDictionary) before writing.
 */
export function applyTypoMerges(dictionary, chosen) {
  const next = structuredClone(dictionary);
  const byId = new Map(next.exercises.map((e) => [e.id, e]));
  const removed = new Set();
  for (const c of chosen) {
    const keep = byId.get(c.keepId);
    if (!keep) throw new Error(`Unknown exercise ${c.keepId}`);
    const adding = c.kind === 'entry' ? [byId.get(c.dropId)?.name, ...(byId.get(c.dropId)?.variants ?? [])] : c.spellings;
    if (c.kind === 'entry') removed.add(c.dropId);
    const have = new Set([keep.name, ...(keep.variants ?? [])].map((n) => n.toLowerCase()));
    keep.variants = [...(keep.variants ?? []), ...adding.filter((n) => n && !have.has(n.toLowerCase()))];
  }
  next.exercises = next.exercises.filter((e) => !removed.has(e.id));
  // A removed id no longer needs a distinct mark.
  if (next.distinct) next.distinct = next.distinct.filter((p) => !p.some((id) => removed.has(id)));
  return next;
}

/** The dictionary with these pairs marked as different exercises. */
export function markDistinct(dictionary, pairs) {
  const next = structuredClone(dictionary);
  const have = new Set((next.distinct ?? []).map((p) => [...p].sort().join('|')));
  for (const p of pairs) {
    const key = [...p].sort().join('|');
    if (!have.has(key)) (next.distinct ??= []).push([...p].sort());
    have.add(key);
  }
  return next;
}
