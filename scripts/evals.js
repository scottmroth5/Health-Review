// Evals for the weekly review.
//   npm run evals                        free: metric regression fixtures, then a summary of saved
//                                        review eval results (data/evals/review), if any
//   npm run evals -- --live [runner args] paid: runs the review contract eval (evals/run-review-eval.mjs),
//                                        e.g. --cases real-2026-09-26,synthetic-symptom-note --variant v1
// The first live run (and any run after the eval harness changes) stops until you approve the
// harness yourself by adding --approve-harness.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoPath } from '../tools/paths.js';

const FLOW = repoPath('data', 'evals', 'review');
const STATE = {
  metrics: [
    { id: 'first_clean', label: '1st draft ok', kind: 'binary' },
    { id: 'final_clean', label: 'Final ok', kind: 'binary' },
    { id: 'sections', label: 'Sections', kind: 'binary' },
    { id: 'no_dashes', label: 'No dashes', kind: 'binary' },
    { id: 'grounded', label: 'Grounded', kind: 'binary' },
    { id: 'routing', label: 'Routing', kind: 'binary' },
    { id: 'physician', label: 'Physician', kind: 'binary' },
    { id: 'length_ok', label: 'Length', kind: 'binary' },
  ],
  perf_fields: [
    { id: 'cost_usd', label: 'Cost', unit: '$' },
    { id: 'latency_s', label: 'Time', unit: 's' },
    { id: 'attempts', label: 'Attempts' },
    { id: 'words', label: 'Words' },
  ],
  // The harness gate covers the runner plus everything that shapes the review.
  harness_paths: ['evals/review-cases.json', 'evals/grade-review.js', 'agent/review.js', 'agent/instructions.js', 'agent/validate.js', 'agent/summary.js', 'agent/claude.js'],
};

function ensureState() {
  mkdirSync(FLOW, { recursive: true });
  const path = join(FLOW, '_state.json');
  if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(STATE, null, 2)}\n`);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Per-variant headline (first-draft clean rate with a 95% interval) and the failing cases. Counts only. */
function summarize() {
  if (!existsSync(FLOW)) return console.log('\nNo review eval results yet (run with --live).');
  const variants = readdirSync(FLOW).filter((d) => /^(baseline|v\d+)$/.test(d)).sort();
  for (const v of variants) {
    const rows = readJsonl(join(FLOW, v, 'results.jsonl'));
    // A failed attempt is superseded once the same (case, rep) has a result row.
    const scored = new Set(rows.map((r) => `${r.prompt_id}\0${r.rep}`));
    const errors = readJsonl(join(FLOW, v, 'errors.jsonl')).filter((e) => !scored.has(`${e.prompt_id}\0${e.rep}`));
    if (!rows.length && !errors.length) continue;
    const n = rows.length;
    const pass = rows.filter((r) => r.grade?.first_clean === 1).length;
    const p = n ? pass / n : 0;
    const half = n ? 1.96 * Math.sqrt((p * (1 - p)) / n) : 0;
    console.log(`\n[${v}] first draft clean: ${pass}/${n} (${Math.round(p * 100)}% ± ${Math.round(half * 100)} points), `
      + `final clean: ${rows.filter((r) => r.grade?.final_clean === 1).length}/${n}, errors: ${errors.length}`);
    for (const m of STATE.metrics.slice(2)) {
      const failing = rows.filter((r) => r.grade?.[m.id] === 0).map((r) => r.prompt_id);
      if (failing.length) console.log(`  ${m.label}: failed on ${failing.join(', ')}`);
    }
  }
  console.log(`\nPer-case grades and explanations: ${join(FLOW, '<variant>', 'results.jsonl')}; transcripts in traces/.`);
}

/**
 * Re-applies the current checks to the drafts already saved in a variant's traces: free, no API
 * calls. Shows how a change to the checks alone moves the scores. Prints grades only.
 */
async function regrade(variant) {
  const { gradeDraft, SPEC } = await import('../evals/grade-review.js');
  const { allowedNumbers, checkReport, stripDashes, findDashes } = await import('../agent/validate.js');
  const { openHealthStore } = await import('../db/store.js');
  const store = openHealthStore();
  const names = {
    medicationNames: store.db.prepare("SELECT name FROM medications WHERE kind = 'medication'").pluck().all(),
    labNames: store.db.prepare('SELECT name FROM lab_tests').pluck().all(),
  };
  store.close();
  const rows = readJsonl(join(FLOW, variant, 'results.jsonl'));
  let before = 0;
  let after = 0;
  for (const r of rows.sort((a, b) => a.prompt_id.localeCompare(b.prompt_id))) {
    const trace = JSON.parse(readFileSync(join(FLOW, variant, 'traces', `${r.prompt_id}_rep${r.rep}.json`), 'utf8'));
    const system = trace.find((t) => t.role === 'system').content;
    const summaryText = /```json\n([\s\S]*?)\n```/.exec(trace.find((t) => t.role === 'user').content)[1];
    const drafts = trace.filter((t) => t.role === 'assistant').map((t) => JSON.parse(t.content));
    const checks = { allowed: allowedNumbers(JSON.parse(summaryText), system), ...names };
    let final = drafts[drafts.length - 1];
    if (findDashes(final).length) final = stripDashes(final);
    const input = SPEC.cases.find((c) => c.id === r.prompt_id) ?? {};
    const { grade, explanation } = gradeDraft(input, drafts[0], checkReport(final, checks), checks);
    before += r.grade.first_clean;
    after += grade.first_clean;
    const reasons = explanation.first_clean ?? Object.entries(explanation).filter(([k]) => k !== 'final_clean').map(([, v]) => v).join('; ');
    console.log(`${r.prompt_id}: first draft ${r.grade.first_clean ? 'clean' : 'failed'} -> ${grade.first_clean ? 'clean' : `failed (${reasons})`}`);
  }
  console.log(`\n[${variant}] re-graded with the current checks: first draft clean ${before}/${rows.length} -> ${after}/${rows.length}`);
}

const args = process.argv.slice(2);
if (args.includes('--regrade')) {
  await regrade(args[args.indexOf('--regrade') + 1] ?? 'baseline');
} else if (args.includes('--live')) {
  ensureState();
  const runnerArgs = args.filter((a) => a !== '--live');
  const r = spawnSync(process.execPath, ['--env-file=.env', 'evals/run-review-eval.mjs', '--flow', FLOW, ...runnerArgs],
    { cwd: repoPath(), stdio: 'inherit' });
  summarize();
  process.exitCode = r.status ?? 1;
} else {
  console.log('Metric regression fixtures:');
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'test/metrics.test.js'], { cwd: repoPath(), encoding: 'utf8' });
  const lines = (r.stdout ?? '').split('\n').filter((l) => /^\s*[✔✖]|^ℹ (tests|pass|fail)/.test(l));
  console.log(lines.join('\n'));
  summarize();
  process.exitCode = r.status ?? 1;
}
