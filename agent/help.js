// Help's Ask (multi-user, phase 6): a question about using the app, answered from the app's own guides
// (docs/guides/*.md). Sends the guides and the question only, never any of the user's data, on the user's own AI. The
// answer is returned, not stored; the run keeps metadata only (model, lengths, cost).
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';
import { startUserRun } from '../db/users.js';
import { stripDashes } from './validate.js';

export const HELP_MODEL = 'claude-sonnet-5-5';
export const HELP_GUIDES = ['using-the-app', 'health-auto-export', 'workout-log', 'manual-entry', 'programs', 'claude-key'];
export const MAX_QUESTION_CHARS = 1000;
const MAX_TOKENS = 1500;

/** The help text: every guide, with {{SITE}} filled in. */
export function helpText(site) {
  return HELP_GUIDES.map((g) => readFileSync(repoPath('docs', 'guides', `${g}.md`), 'utf8').replace(/\{\{SITE\}\}/g, site)).join('\n\n---\n\n');
}

const SYSTEM = (guides) => `You answer questions about using Health Review, a personal health and training log app, for one of its users.
Answer only from the guides below. If the guides do not cover it, say so briefly and suggest the guide or screen closest to it.
Never give medical, nutrition or training advice, and never interpret anyone's health data: for questions about health, symptoms, medications or lab results, say that Health Review does not give advice and suggest asking their physician.
You have no access to the user's data or account, so never claim to know or change anything in it.
Be short and plain: a few sentences or a short list, naming the screens and buttons as the guides do. No headings.
Write without em dashes, en dashes or double hyphens.

<guides>
${guides}
</guides>`;

/**
 * @param {{ store: object, claude: { send: Function }, question: string, site: string, model?: string, logger?: object }} o
 * @returns {Promise<{ answer: string }>}
 */
export async function askHelp({ store, claude, question, site, model = HELP_MODEL, logger }) {
  const run = startUserRun(store, 'help-ask', { model, questionChars: question.length }, logger);
  try {
    const result = await claude.send({ model, maxTokens: MAX_TOKENS, system: SYSTEM(helpText(site)), prompt: question, trace: run, label: 'help-ask' });
    const answer = stripDashes({ sections: [{ title: '', body: String(result.text ?? '').trim() }], physicianDiscussion: [] }).sections[0].body;
    run.finish('ok', { model: result.model, answerChars: answer.length });
    return { answer };
  } catch (err) {
    run.finish('error', { error: err.name });
    throw err;
  }
}
