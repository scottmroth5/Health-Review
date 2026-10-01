// The weekly review: summary in, one Claude call, checks in code, saved report out.
// Runs are traced with metadata only (model, tokens, cost, timing, which sensitive sections were
// sent by name); prompt and report text never go to logs.
import { createTracer } from '@scottmroth5/agent-core';
import { computeWeek } from '../metrics/index.js';
import { loadWeekData, loadMetricSettings, loadWeekNotes } from '../metrics/load.js';
import { buildSummary } from './summary.js';
import { buildSystem, REPORT_SCHEMA, renderReport } from './instructions.js';
import { allowedNumbers, checkReport, findDashes, stripDashes } from './validate.js';
import { DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from './claude.js';

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
export function prepareReview(db, { weekEnd, today }) {
  const settings = loadMetricSettings(db);
  const week = computeWeek(loadWeekData(db, weekEnd), { weekEnd, ...settings });
  const summary = buildSummary(week, loadWeekNotes(db, weekEnd), { today });
  const sections = db.prepare('SELECT position, name, text, sensitive FROM prompt_sections ORDER BY position, name').all();
  const { system, sensitiveSent } = buildSystem(sections, today);
  return {
    summary,
    system,
    sensitiveSent,
    sectionNames: sections.map((s) => s.name),
    checks: {
      allowed: allowedNumbers(summary, system),
      medicationNames: db.prepare("SELECT name FROM medications WHERE kind = 'medication'").pluck().all(),
      labNames: db.prepare('SELECT name FROM lab_tests').pluck().all(),
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
export async function runReview({ store, claude, weekEnd, today, model = DEFAULT_REVIEW_MODEL, effort = DEFAULT_REVIEW_EFFORT, logger = console }) {
  const { db } = store;
  const prep = prepareReview(db, { weekEnd, today });
  const run = createTracer({ store, logger }).startRun('review', { weekEnd, model, effort, sensitiveSections: prep.sensitiveSent });

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
    db.prepare(`INSERT INTO reviews (week_ending, summary_json, report_md, run_id, created_at, model, warnings, sensitive_sections)
      VALUES (@week, @summary, @report, @run, @created, @model, @warnings, @sensitive)
      ON CONFLICT (week_ending) DO UPDATE SET summary_json = excluded.summary_json, report_md = excluded.report_md,
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
    return { weekEnd, attempts, warnings: problems, model: result.model, costUsd: totals.costUsd, sections: report.sections.length, physicianItems: report.physicianDiscussion.length };
  } catch (err) {
    run.finish('error', { weekEnd, error: err.name });
    throw err;
  }
}
