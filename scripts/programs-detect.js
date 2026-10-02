// Proposes program blocks from the Workout Log history. Prints programs, dates and session counts only.
//   npm run programs:detect              show the proposal
//   npm run programs:detect -- --write   save it (replaces earlier detected blocks; confirmed ones are kept)
import { openHealthStore } from '../db/store.js';
import { detect, writeDetected, sessionCoverage } from '../ingest/program-blocks.js';
import { weekOf } from '../metrics/blocks.js';
import { localDate } from '../server/queries.js';

const write = process.argv.includes('--write');
const today = localDate();
const store = openHealthStore();
try {
  const d = detect(store.db, today);
  console.log(`${d.blocks.length} blocks detected (lifting days already in confirmed blocks are left out):\n`);
  for (const b of d.blocks) {
    const end = b.end_date ?? `${b.last_session}, in progress`;
    const weeks = weekOf(b.start_date, b.last_session);
    console.log(`${b.start_date} to ${end.padEnd(24)} ${String(b.sessions.length).padStart(4)} sessions ${String(weeks).padStart(3)} wk  ${b.program}${b.notes ? `  (${b.notes})` : ''}`);
  }
  console.log(`\n${d.unassigned.length} lifting days with no program would be marked unassigned.`);
  if (write) {
    writeDetected(store.db, d);
    const c = sessionCoverage(store.db, today);
    console.log(`Saved. Lifting days: ${c.liftingDays}; in confirmed blocks ${c.confirmed}, in detected blocks ${c.detected}, unassigned ${c.unassigned}, missing ${c.missing}.`);
    console.log('Next: npm run programs:review -- list');
  } else {
    console.log('Nothing saved. Run with -- --write to save these as detected blocks.');
  }
} finally {
  store.close();
}
