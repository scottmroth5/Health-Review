// Help's Ask (multi-user, phase 6): a question about using the app, answered from the app's own guides
// (docs/guides/*.md). Sends the guides and the question only, never any of the user's data, on the user's own AI. The
// answer is returned, not stored; the run keeps metadata only (model, lengths, cost).
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';
import { startUserRun } from '../db/users.js';
import { stripDashes } from './validate.js';
import { EMERGENCY_LINE } from './emergency.js';
import { HELP_SUPPLEMENT_RULES, SUPPLEMENT_DISCLAIMER, limitEntry, supplementAdviceSince } from './supplements.js';

export const HELP_MODEL = 'claude-sonnet-5-5';
export const HELP_GUIDES = ['using-the-app', 'health-auto-export', 'workout-log', 'manual-entry', 'programs', 'prompts', 'claude-key'];
export const MAX_QUESTION_CHARS = 1000;
const MAX_TOKENS = 1500;

/** The help text: every guide, with {{SITE}} filled in. */
export function helpText(site) {
  return HELP_GUIDES.map((g) => readFileSync(repoPath('docs', 'guides', `${g}.md`), 'utf8').replace(/\{\{SITE\}\}/g, site)).join('\n\n---\n\n');
}

const SYSTEM = (guides, supplements) => `You answer questions about using Health Review, a personal health and training log app, for one of its users.
Answer only from the guides below. If the guides do not cover it, say so briefly and suggest the guide or screen closest to it.
Never give medical, nutrition or training advice${supplements ? ' (supplements excepted, as below)' : ''}, and never interpret anyone's health data: for questions about health, symptoms, medications or lab results, say that Health Review does not give advice and suggest asking their physician. When the question describes something that could be urgent (such as chest pain or tightness, fainting, or trouble breathing), end the answer with this sentence, word for word: "${EMERGENCY_LINE}"
You have no access to the user's data or account, so never claim to know or change anything in it.
Be short and plain: a few sentences or a short list, naming the screens and buttons as the guides do. No headings.
Write without em dashes, en dashes or double hyphens.${supplements ? `
${HELP_SUPPLEMENT_RULES}` : ''}

<guides>
${guides}
</guides>`;

/** With supplement suggestions on, the answer says whether it recommends anything, so code can add the statement. */
const HELP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answer', 'supplementAdvice'],
  properties: { answer: { type: 'string' }, supplementAdvice: { type: 'boolean' } },
};

/**
 * @param {{ store: object, claude: { send: Function }, question: string, site: string, model?: string, logger?: object }} o
 * @returns {Promise<{ answer: string, statement?: string }>}  statement: the supplement statement, shown with the answer
 */
export async function askHelp({ store, claude, question, site, model = HELP_MODEL, logger }) {
  // Supplement suggestions (Settings, off by default): general recommendations only, as Help never sees the user's data.
  const supplements = Boolean(supplementAdviceSince(store.db));
  const run = startUserRun(store, 'help-ask', { model, questionChars: question.length, supplements }, logger);
  try {
    const result = await claude.send({ model, maxTokens: MAX_TOKENS, system: SYSTEM(helpText(site), supplements), prompt: question, trace: run, label: 'help-ask',
      ...(supplements ? { schema: HELP_SCHEMA } : {}) });
    const text = supplements ? result.data.answer : result.text;
    const answer = stripDashes({ sections: [{ title: '', body: String(text ?? '').trim() }], physicianDiscussion: [] }).sections[0].body;
    // The statement also follows any answer naming supplements, should the model not flag it.
    const advised = supplements && (result.data.supplementAdvice === true || /\bsupplements?\b/i.test(answer) || Boolean(limitEntry(answer)));
    run.finish('ok', { model: result.model, answerChars: answer.length, supplementAdvice: advised });
    return advised ? { answer, statement: SUPPLEMENT_DISCLAIMER } : { answer };
  } catch (err) {
    run.finish('error', { error: err.name });
    throw err;
  }
}
