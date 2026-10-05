// Review detected program blocks: confirm, edit, merge, split, or mark days unassigned. Blocks can be named by
// the first characters of their id (shown by list). Prints programs, dates and counts only.
//   npm run programs:review -- list [--unconfirmed]
//   npm run programs:review -- confirm <id|all-detected>
//   npm run programs:review -- edit <id> [--program "MAPS Anabolic"] [--phase "Phase 2"] [--start YYYY-MM-DD]
//                                         [--end YYYY-MM-DD] [--status completed|abandoned|in_progress] [--notes "..."]
//   npm run programs:review -- merge <id> <id>        the second block joins the first
//   npm run programs:review -- split <id> <date>      sessions from <date> on become a new block
//   npm run programs:review -- unassign <date> [<to date>]
import { openHealthStore } from '../db/store.js';
import {
  ReviewError, blockStatus, confirmBlocks, editBlock, listBlocks, mergeBlocks, refreshPhases, sessionCoverage, splitBlock, unassignDays,
} from '../ingest/program-blocks.js';
import { loadCatalog } from '../metrics/catalog.js';
import { localDate } from '../server/queries.js';

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  else args.push(rest[i]);
}

const today = localDate();
const opts = { today };
const store = openHealthStore();
const db = store.db;
const catalog = loadCatalog();
const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function printList(unconfirmed) {
  const blocks = listBlocks(db, { unconfirmed });
  for (const b of blocks) {
    const end = b.end_date ?? 'in progress';
    const st = blockStatus(db, b, today, catalog);
    const finish = st.earliest_finish
      ? `, finish ~${shortDate(st.earliest_finish)}${st.pace_finish && st.pace_finish !== st.earliest_finish ? ` to ${shortDate(st.pace_finish)}` : ''}` : '';
    const progress = !st.program_weeks ? ''
      : b.status === 'in_progress'
        ? `  [${st.phase ?? 'phase unknown'}${st.phase_started ? ` (since ${shortDate(st.phase_started)})` : ''}${st.estimated ? ' (calendar estimate)' : ''}`
          + `${st.week ? `, week ${st.week} of ${st.program_weeks}` : ''}${st.deload_week ? ', deload week' : ''}${st.failure_week ? ', failure week' : ''}${finish}]`
        : `  [${st.program_weeks}-week program, reached ${st.percent ?? '?'}%]`;
    console.log(`${b.id.slice(0, 8)}  ${b.source === 'confirmed' ? 'confirmed' : 'detected '}  ${b.start_date} to ${end.padEnd(11)}  `
      + `${String(b.sessions).padStart(3)} sessions  ${b.status.padEnd(11)}  ${b.program}${b.phase ? ` ${b.phase}` : ''}${progress}${b.notes ? `  (${b.notes})` : ''}`);
  }
  if (!blocks.length) console.log(unconfirmed ? 'No detected blocks left to review.' : 'No blocks yet. Run npm run programs:detect -- --write first.');
}

function printCoverage() {
  const c = sessionCoverage(db, today);
  console.log(`Lifting days: ${c.liftingDays}. In confirmed blocks ${c.confirmed}, unassigned ${c.unassigned}, `
    + `in detected blocks (to review) ${c.detected}, not detected yet ${c.missing}.`);
}

try {
  switch (command) {
    case 'list':
      printList(Boolean(flags.unconfirmed));
      break;
    case 'confirm':
      console.log(`Confirmed ${confirmBlocks(db, args[0], opts)} block(s).`);
      break;
    case 'edit': {
      const b = editBlock(db, args[0], { program: flags.program, phase: flags.phase, start: flags.start, end: flags.end, status: flags.status, notes: flags.notes }, opts);
      console.log(`Updated ${b.id.slice(0, 8)}: ${b.program}, ${b.start_date} to ${b.end_date ?? 'in progress'}, ${b.status}.`);
      break;
    }
    case 'merge': {
      const b = mergeBlocks(db, args[0], args[1], opts);
      console.log(`Merged into ${b.id.slice(0, 8)}: ${b.program}, ${b.start_date} to ${b.end_date ?? 'in progress'}.`);
      break;
    }
    case 'split':
      console.log(`Split; the new block is ${splitBlock(db, args[0], args[1], opts).slice(0, 8)}.`);
      break;
    case 'unassign':
      console.log(`Marked ${unassignDays(db, args[0], args[1] ?? args[0], opts)} lifting day(s) unassigned.`);
      break;
    default:
      console.log('Commands: list [--unconfirmed] | confirm <id|all-detected> | edit <id> --field value | merge <id> <id> | split <id> <date> | unassign <date> [<to date>]');
      process.exitCode = command ? 1 : 0;
  }
  if (command && command !== 'list') {
    refreshPhases(db, catalog);
    printCoverage();
  }
} catch (err) {
  if (!(err instanceof ReviewError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  store.close();
}
