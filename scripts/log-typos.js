// Exercise names that look like typos of each other, for you to confirm. Prints names and set counts only; local only
// (nothing is sent anywhere). Nothing changes unless you name the pairs.
//   npm run log:typos                       numbered list: dictionary pairs, then unmapped logged names
//   npm run log:typos -- --merge 1,3,5      fold those into the exercise they look like, then re-apply the dictionary
//   npm run log:typos -- --distinct 2,7     record those as different exercises (never offered again)
// The numbers come from the list printed with no arguments; run it again after a merge, since numbers shift.
import { readFileSync, writeFileSync } from 'node:fs';
import { openOwnerStore } from '../db/store.js';
import { DICTIONARY_PATH, createDictionary } from '../metrics/dictionary.js';
import { typoCandidates, applyTypoMerges, markDistinct } from '../metrics/name-typos.js';
import { canonicalSetCounts, normalizeAll, unmappedNames } from '../ingest/normalize.js';

const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const numbers = (text) => (text ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const json = JSON.parse(readFileSync(DICTIONARY_PATH, 'utf8'));
const store = openOwnerStore();
try {
  const found = typoCandidates({ dictionary: json, unmapped: unmappedNames(store.db), setCounts: canonicalSetCounts(store.db) });
  const all = [...found.entries, ...found.unmapped];
  const merge = numbers(arg('--merge'));
  const distinct = numbers(arg('--distinct'));

  if (!merge.length && !distinct.length) {
    if (!all.length) {
      console.log('No exercise names look like typos.');
    } else {
      let n = 0;
      if (found.entries.length) console.log('Dictionary exercises that look like the same one (the second is kept):');
      for (const c of found.entries) console.log(`${String(++n).padStart(3)}. "${c.dropName}" (${plural(c.dropSets, 'set')}) looks like "${c.keepName}" (${plural(c.keepSets, 'set')})`);
      if (found.unmapped.length) console.log('Logged names with no entry that look like a dictionary exercise:');
      for (const c of found.unmapped) {
        const also = c.alternatives.length ? `; also close to ${c.alternatives.map((a) => `"${a}"`).join(', ')}` : '';
        console.log(`${String(++n).padStart(3)}. "${c.spellings.join('" / "')}" (${plural(c.sets, 'set')}) looks like "${c.keepName}"${also}`);
      }
      console.log('Merge with: npm run log:typos -- --merge 1,2   Mark as different: npm run log:typos -- --distinct 3');
    }
  } else {
    const pick = (list) => list.map((i) => {
      if (!all[i - 1]) throw new Error(`There is no number ${i}; run npm run log:typos to see the list.`);
      return all[i - 1];
    });
    let next = json;
    if (distinct.length) {
      next = markDistinct(next, pick(distinct).map((c) => [c.keepId, c.kind === 'entry' ? c.dropId : `key:${c.key}`]));
    }
    if (merge.length) next = applyTypoMerges(next, pick(merge.filter((i) => !distinct.includes(i))));
    const dictionary = createDictionary(next); // refuses (listing every problem) before anything is written
    writeFileSync(DICTIONARY_PATH, `${JSON.stringify(next, null, 2)}\n`);
    if (distinct.length) console.log(`Marked ${plural(distinct.length, 'pair')} as different exercises.`);
    if (merge.length) {
      const c = normalizeAll(store.db, dictionary);
      console.log(`Merged ${plural(merge.length, 'name')} into their exercises and re-applied the dictionary: ${c.mappedSets} of ${c.sets} sets mapped (${c.mappedPct}%).`);
    }
    console.log('Run npm run log:typos again to see what is left.');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  store.close();
}
