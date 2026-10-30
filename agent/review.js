// The weekly review: summary in, one Claude call, checks in code, saved report out.
// Runs are traced with metadata only (model, tokens, cost, timing, which sensitive sections were
// sent by name); prompt and report text never go to logs.
import { computeWeek } from '../metrics/index.js';
import { loadWeekData, loadMetricSettings, loadWeekNotes, loadGoals, medicationNames } from '../metrics/load.js';
import { GOALS } from '../server/public/goals.js';
import { buildSummary } from './summary.js';
import { buildSystem, REPORT_SCHEMA, renderReport } from './instructions.js';
import { allowedNumbers, checkReport, findDashes, stripDashes } from './validate.js';
import { DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from './claude.js';
import { startUserRun } from '../db/users.js';

/** Names the review's lab-value check also routes to physicianDiscussion (the summary's nightBreathing block). */
export const NIGHT_BREATHING_NAMES = ['Blood Oxygen', 'SpO2', 'Oxygen Saturation', 'Breathing Disturbances'];

// Room for adaptive thinking plus a ~2,000-word report: high effort has used 9.5k to over 16k tokens on the same week.
const MAX_TOKENS = 32000;

const userMessage = (summary, problems = []) =>
  [
    problems.length
      ? `A previous draft broke these rules; this draft must not:\n${problems.map((p) => `- ${p}`).join('\n')}\n`
      : null,
    'Weekly summary (JSON):',
    '```json',
    JSON.stringify(summary),
    '```',
  ].filter(Boolean).join('\n');

/** Builds everything the call needs without calling anything (used by --dry-run and tests). */
export function prepareReview(db, { weekEnd, today, catalog }) {
  const settings = loadMetricSettings(db);
  // catalog: the user's program catalog (null: none); left out, the owner's MAPS catalog file is read.
  const week = computeWeek(loadWeekData(db, weekEnd, catalog === undefined ? {} : { catalog }), { weekEnd, ...settings });
  const summary = buildSummary(week, loadWeekNotes(db, weekEnd), { today });
  // The owner's training goals (Settings), as labels only: the review opens with them.
  const goals = loadGoals(db);
  if (goals.primary) summary.goals = { primary: GOALS[goals.primary], secondary: goals.secondary ? GOALS[goals.secondary] : null };
  const sections = db.prepare('SELECT position, name, text, sensitive FROM prompt_sections WHERE user_id = @uid ORDER BY position, name').all();
  const { system, sensitiveSent } = buildSystem(sections, today);
  return {
    summary,
    system,
    sensitiveSent,
    sectionNames: sections.map((s) => s.name),
    checks: {
      opening: true, // highlights and next steps
      allowed: allowedNumbers(summary, system),
      medicationNames: medicationNames(db),
      // Blood oxygen and breathing disturbances are checked like lab values: a number next to them only in physicianDiscussion.
      labNames: [...db.prepare('SELECT name FROM lab_tests WHERE user_id = @uid').pluck().all(), ...NIGHT_BREATHING_NAMES],
    },
  };
}

/**
 * @param {object} options
 * @param {{ db: import('better-sqlite3').Database }} options.store
 * @param {{ send: Function }} options.claude   from createReviewClaude()
 * @param {string} options.weekEnd
 * @param {string} options.today
 * @param {string} [options.model]
 * @param {string} [options.effort]
 * @param {object} [options.logger]
 */
export async function runReview({ store, claude, weekEnd, today, catalog, model = DEFAULT_REVIEW_MODEL, effort = DEFAULT_REVIEW_EFFORT, logger = console }) {
  const { db } = store;
  const prep = prepareReview(db, { weekEnd, today, catalog });
  const run = startUserRun(store, 'review', { weekEnd, model, effort, sensitiveSections: prep.sensitiveSent }, logger);

  try {
    const ask = (problems) => claude.send({
      model,
      maxTokens: MAX_TOKENS,
      system: prep.system,
      prompt: userMessage(prep.summary, problems),
      schema: REPORT_SCHEMA,
      effort,
      trace: run,
      label: problems.length ? 'review-retry' : 'review',
    });

    let result = await ask([]);
    let report = result.data;
    let problems = checkReport(report, prep.checks);
    let attempts = 1;
    if (problems.length) {
      attempts = 2;
      result = await ask(problems);
      report = result.data;
      problems = checkReport(report, prep.checks);
    }
    // Dashes are fixable in code; anything else stays visible as a warning with the report.
    if (findDashes(report).length) {
      report = stripDashes(report);
      problems = checkReport(report, prep.checks);
    }

    const reportMd = renderReport(report);
    db.prepare(`INSERT INTO reviews (user_id, week_ending, summary_json, report_md, run_id, created_at, model, warnings, sensitive_sections)
      VALUES (@uid, @week, @summary, @report, @run, @created, @model, @warnings, @sensitive)
      ON CONFLICT (user_id, week_ending) DO UPDATE SET summary_json = excluded.summary_json, report_md = excluded.report_md,
        run_id = excluded.run_id, created_at = excluded.created_at, model = excluded.model, warnings = excluded.warnings,
        sensitive_sections = excluded.sensitive_sections`).run({
      week: weekEnd,
      summary: JSON.stringify(prep.summary),
      report: reportMd,
      run: run.id,
      created: new Date().toISOString(),
      model: result.model,
      warnings: problems.length ? JSON.stringify(problems) : null,
      sensitive: JSON.stringify(prep.sensitiveSent),
    });
    const totals = run.finish('ok', { weekEnd, attempts, warnings: problems.length, model: result.model });
    return { weekEnd, attempts, warnings: problems, model: result.model, costUsd: totals.costUsd, highlights: report.highlights.length, nextSteps: report.nextSteps.length, sections: report.sections.length, physicianItems: report.physicianDiscussion.length };
  } catch (err) {
    run.finish('error', { weekEnd, error: err.name });
    throw err;
  }
}
