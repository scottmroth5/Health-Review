// Grading for the review contract eval, shared by the paid runner (run-review-eval.mjs) and the free
// re-grade of saved drafts (npm run evals -- --regrade), so both always apply the same checks.
import { readFileSync } from 'node:fs';
import { checkReport, countWords, MAX_WORDS } from '../agent/validate.js';
import { repoPath } from '../tools/paths.js';

export const SPEC = JSON.parse(readFileSync(repoPath('evals', 'review-cases.json'), 'utf8'));

/**
 * @param {object} input       a case from review-cases.json
 * @param {object} firstDraft  the model's first structured report, before any retry
 * @param {string[]} finalWarnings  problems left on the saved report
 * @param {object} checks      { allowed, medicationNames, labNames } from prepareReview
 */
export function gradeDraft(input, firstDraft, finalWarnings, checks) {
  const problems = checkReport(firstDraft, checks);
  const titles = firstDraft.sections.map((s) => s.title.trim());
  const sectionsOk = JSON.stringify(titles) === JSON.stringify(SPEC.expectedSections);
  const physicianOk = !input.expects?.physicianItem || firstDraft.physicianDiscussion.length > 0;
  const n = countWords(firstDraft);
  const maxWords = SPEC.maxWords ?? MAX_WORDS;
  const has = (re) => problems.some((p) => re.test(p));
  const grade = {
    first_clean: problems.length === 0 && sectionsOk && physicianOk ? 1 : 0,
    final_clean: finalWarnings.length === 0 ? 1 : 0,
    sections: sectionsOk ? 1 : 0,
    no_dashes: has(/^dash/) ? 0 : 1,
    grounded: has(/^numbers not in the summary/) ? 0 : 1,
    routing: has(/belongs in physicianDiscussion/) ? 0 : 1,
    physician: physicianOk ? 1 : 0,
    length_ok: n <= maxWords ? 1 : 0,
  };
  const explanation = {};
  if (problems.length) explanation.first_clean = problems.join('; ');
  if (!sectionsOk) explanation.sections = `got: ${titles.join(' | ')}`;
  if (!physicianOk) explanation.physician = 'this case requires a physician discussion item; the first draft had none';
  if (n > maxWords) explanation.length_ok = `${n} words (limit ${maxWords})`;
  if (finalWarnings.length) explanation.final_clean = finalWarnings.join('; ');
  return { grade, explanation, words: n };
}
