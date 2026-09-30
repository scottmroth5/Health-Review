// One-time import of the v1 prompt sections (data/v1-export/prompts/PROMPT_NN_NAME.txt) into the
// prompt_sections table. Prints names and sizes only, never prompt text. Existing names are skipped
// unless --replace is given. MEDICAL and GENETICS sections are marked sensitive.
//   npm run prompts:import-v1
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoPath } from '../tools/paths.js';
import { openHealthStore } from '../db/store.js';
import { listSections, createSection, updateSection } from '../server/queries.js';

const DIR = repoPath('data', 'v1-export', 'prompts');
const FILE = /^PROMPT_(\d+)_([A-Za-z0-9_]+)\.txt$/;
const SENSITIVE = /MEDICAL|GENETIC/i;

function main() {
  if (!existsSync(DIR)) throw new Error(`No v1 prompt export at ${DIR}`);
  const replace = process.argv.includes('--replace');
  const store = openHealthStore();
  try {
    const existing = new Map(listSections(store.db).map((s) => [s.name, s]));
    for (const file of readdirSync(DIR).sort()) {
      const m = FILE.exec(file);
      if (!m) continue;
      const section = {
        position: Number(m[1]),
        name: m[2].toLowerCase().replaceAll('_', '-'),
        text: readFileSync(join(DIR, file), 'utf8').trim(),
        sensitive: SENSITIVE.test(m[2]),
      };
      const label = `${section.name} (position ${section.position}, ${section.text.length.toLocaleString()} characters${section.sensitive ? ', sensitive' : ''})`;
      const current = existing.get(section.name);
      if (current && !replace) {
        console.log(`skipped ${label}: already exists (use --replace to overwrite; the old text is kept as a version)`);
      } else if (current) {
        updateSection(store.db, current.id, section);
        console.log(`replaced ${label}`);
      } else {
        createSection(store.db, section);
        console.log(`imported ${label}`);
      }
    }
  } finally {
    store.close();
  }
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
