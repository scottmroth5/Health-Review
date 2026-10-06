// Validates data/maps/programs.json and prints each program's structure for the owner to check against the
// calendars: weeks, phases with week ranges, deload and failure weeks, workouts, and how many blueprint exercise
// names map to the exercise dictionary.
//   npm run programs:catalog                 the summary
//   npm run programs:catalog -- --unmapped   also list blueprint exercise names with no dictionary entry
import { CATALOG_PATH, loadCatalog, phaseStats } from '../metrics/catalog.js';
import { loadDictionary } from '../metrics/dictionary.js';

let catalog;
try {
  catalog = loadCatalog();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (!catalog) {
  console.log(`No catalog yet at ${CATALOG_PATH}.`);
  process.exit(0);
}

const dictionary = loadDictionary();
const unmapped = new Map();
for (const p of catalog.programs) {
  let names = 0;
  let mapped = 0;
  const lines = p.phases.map((ph) => {
    const special = [
      ...(ph.special_weeks?.deload ?? []).map((w) => `deload wk ${w}`),
      ...(ph.special_weeks?.failure ?? []).map((w) => `failure wk ${w}`),
    ];
    const workouts = ph.workouts ?? [];
    for (const wo of workouts) {
      for (const ex of wo.exercises ?? []) {
        names += 1;
        if (dictionary.lookup(ex.name).status === 'mapped') mapped += 1;
        else unmapped.set(ex.name, [...(unmapped.get(ex.name) ?? []), p.name]);
      }
    }
    const rx = [ph.sets && `${ph.sets} sets`, ph.reps && `${ph.reps} reps`, ph.rest && `rest ${ph.rest}`].filter(Boolean).join(', ');
    const st = phaseStats(ph, (n) => dictionary.lookup(n));
    const work = st.workouts
      ? `\n${' '.repeat(17)}~${st.setsPerWorkout} sets/workout${st.setsPerWeek ? `, ~${st.setsPerWeek} sets/week` : ''}; heavy sets (5 reps or fewer) ${st.heavyPct}%, arm isolation ${st.armIsolationPct}%, one side at a time ${st.unilateralPct}%`
      : '';
    return `    ${ph.name.padEnd(12)} weeks ${ph.weeks[0]}-${ph.weeks[1]}${ph.workouts_per_week ? `, ${ph.workouts_per_week}/week` : ''}`
      + `${rx ? `, ${rx}` : ''}, ${workouts.length} workouts${special.length ? ` (${special.join(', ')})` : ''}${work}`;
  });
  console.log(`${p.name}: ${p.weeks} weeks${p.equipment?.length ? `, equipment ${p.equipment.join(', ')}` : ''}; exercises mapped ${mapped}/${names}`);
  console.log(lines.join('\n'));
}
if (process.argv.includes('--unmapped')) {
  console.log(`\nBlueprint exercise names with no dictionary entry (${unmapped.size}):`);
  for (const [name, programs] of [...unmapped].sort()) console.log(`  ${name}  (${[...new Set(programs)].join(', ')})`);
} else if (unmapped.size) {
  console.log(`\n${unmapped.size} blueprint exercise names have no dictionary entry; run with -- --unmapped to list them.`);
}
