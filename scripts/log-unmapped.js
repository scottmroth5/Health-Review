// Lists exercise names with no dictionary entry, grouped by spelling variants, most sets first.
// Prints names, set counts and years only; never weights or dates.
//   npm run log:unmapped                       every group
//   npm run log:unmapped -- --top 50           the 50 groups with the most sets
//   npm run log:unmapped -- --suggest [--top N]  ask Claude for mappings (sends exercise names only, after you
//                                              say yes); proposals go to data/exercise-proposals.json
//   npm run log:unmapped -- --accept data/exercise-proposals.json   add the proposals you kept to the dictionary
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { openHealthStore } from '../db/store.js';
import { unmappedNames } from '../ingest/normalize.js';
import { DICTIONARY_PATH, createDictionary, loadDictionary } from '../metrics/dictionary.js';
import { applySuggestions, suggestMappings, SUGGEST_MODEL } from '../agent/suggest-exercises.js';
import { createReviewClaude } from '../agent/claude.js';
import { repoPath } from '../tools/paths.js';

const PROPOSALS = repoPath('data', 'exercise-proposals.json');
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
const top = arg('--top') ? Number(arg('--top')) : Infinity;

if (process.argv.includes('--accept')) {
  const file = arg('--accept') ?? PROPOSALS;
  const { suggestions } = JSON.parse(readFileSync(file, 'utf8'));
  const current = JSON.parse(readFileSync(DICTIONARY_PATH, 'utf8'));
  const next = applySuggestions(current, suggestions);
  createDictionary(next); // refuses (with every problem listed) before anything is written
  writeFileSync(DICTIONARY_PATH, `${JSON.stringify(next, null, 2)}\n`);
  const kept = suggestions.filter((s) => s.action !== 'unsure').length;
  console.log(`Added ${kept} proposal(s) to config/exercise-dictionary.json (unsure ones skipped). Run npm run log:normalize next.`);
  process.exit(0);
}

const store = openHealthStore();
let groups;
try {
  groups = unmappedNames(store.db);
} finally {
  store.close();
}

if (!groups.length) {
  console.log('Every exercise name is mapped or ignored.');
  process.exit(0);
}

if (!process.argv.includes('--suggest')) {
  const total = groups.reduce((a, g) => a + g.sets, 0);
  console.log(`${groups.length} names to map, covering ${total} sets (inferred = implement read from the name, exercise still unknown):`);
  for (const g of groups.slice(0, top)) {
    const years = g.first === g.last ? `${g.first}` : `${g.first}-${g.last}`;
    const status = g.status === 'inferred' ? `inferred ${g.implement}` : g.status;
    console.log(`${String(g.sets).padStart(5)} sets  ${years}  [${status}]  ${g.spellings.join(' | ')}`);
  }
  process.exit(0);
}

// --suggest: one spelling per group, names only.
const names = groups.slice(0, top).map((g) => g.spellings[0]);
console.log(`These ${names.length} exercise names (and the dictionary's own exercise names) would be sent to Claude (${SUGGEST_MODEL}).`);
console.log('Nothing else from the log is sent.\n');
console.log(names.join('\n'));
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('\nSend them? Type yes to continue: ')).trim().toLowerCase();
rl.close();
if (answer !== 'yes') {
  console.log('Nothing sent.');
  process.exit(0);
}
const suggestions = await suggestMappings({ claude: createReviewClaude(), names, dictionary: loadDictionary() });
writeFileSync(PROPOSALS, `${JSON.stringify({ created: new Date().toISOString(), model: SUGGEST_MODEL, suggestions }, null, 2)}\n`);
const counts = suggestions.reduce((a, s) => ({ ...a, [s.action]: (a[s.action] ?? 0) + 1 }), {});
console.log(`\nProposals written to data/exercise-proposals.json: ${JSON.stringify(counts)}.`);
console.log('Delete any you do not want (or change their action to "unsure"), then run npm run log:unmapped -- --accept');
