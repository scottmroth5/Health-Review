// The Prompt tab's "Help me write a section": a few guided questions per kind of section, then a draft the user reviews
// and saves. "Build without AI" fills a template from the answers; "Draft with Claude" sends only the answers and the
// section's guidance (never the user's data) on the user's own AI. Nothing is saved here; the run keeps lengths and
// cost only. Guidance with examples: docs/guides/prompts.md.
import { startUserRun } from '../db/users.js';
import { stripDashes } from './validate.js';

export const DRAFT_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 1200;
export const MAX_ANSWER_CHARS = 600;

const q = (key, label, placeholder = '') => ({ key, label, placeholder });
/** Each kind of section: its usual name, what it is for, the questions, and the no-AI template. */
export const SECTION_KINDS = {
  about: {
    name: 'About me',
    guidance: 'Who the owner is and what they want: age range, goals for the next few months, schedule, and anything the review should keep in mind (travel, a new job, an event to train for).',
    questions: [q('age', 'Your age (or range)', 'e.g. late 40s'), q('goals', 'What you want in the next few months', 'e.g. squat 300 lb, lose 10 lb, sleep 7 hours'),
      q('schedule', 'Your week', 'e.g. desk job, lift 4 mornings, kids on weekends'), q('context', 'Anything to keep in mind', 'e.g. half marathon in May; travel every other week')],
    template: (a) => [a.age && `I am ${a.age}.`, a.goals && `My goals for the next few months: ${a.goals}.`, a.schedule && `My week: ${a.schedule}.`, a.context && `Keep in mind: ${a.context}.`],
  },
  coaching: {
    name: 'Coaching style',
    guidance: 'How the review should talk to the owner: tone, length, structure, and what to lead with.',
    questions: [q('tone', 'Tone', 'e.g. direct and encouraging; no fluff'), q('length', 'Length', 'e.g. short, under 600 words'),
      q('structure', 'How to organize it', 'e.g. wins first, then what to watch, then 3 things for next week'), q('avoid', 'Anything to avoid', 'e.g. repeating the numbers back without meaning')],
    template: (a) => [a.tone && `Tone: ${a.tone}.`, a.length && `Length: ${a.length}.`, a.structure && `Organize it this way: ${a.structure}.`, a.avoid && `Avoid: ${a.avoid}.`],
  },
  training: {
    name: 'Training',
    guidance: 'How the owner lifts: days a week, equipment, current program, lifts to focus on, and exercises to avoid.',
    questions: [q('days', 'Days a week you lift', 'e.g. 4'), q('equipment', 'Your equipment', 'e.g. home gym: barbell, dumbbells, bands, no machines'),
      q('focus', 'Lifts or areas to focus on', 'e.g. squat and deadlift; upper back'), q('avoid', 'Exercises to avoid', 'e.g. overhead barbell press (shoulder)')],
    template: (a) => [a.days && `I lift ${a.days} days a week.`, a.equipment && `Equipment: ${a.equipment}.`, a.focus && `Focus on: ${a.focus}.`, a.avoid && `Avoid suggesting: ${a.avoid}.`],
  },
  cardio: {
    name: 'Cardio and endurance',
    guidance: 'The owner\'s cardio: what they do, how often, any event, and what to watch (Zone 2 minutes, VO2 max, resting heart rate).',
    questions: [q('what', 'What cardio you do', 'e.g. rowing and walking'), q('often', 'How often and how long', 'e.g. 3 times a week, 30 to 45 minutes'),
      q('event', 'An event or target', 'e.g. 10k in June'), q('watch', 'What the review should watch', 'e.g. Zone 2 minutes and VO2 max')],
    template: (a) => [a.what && `My cardio: ${a.what}.`, a.often && `How often: ${a.often}.`, a.event && `Training for: ${a.event}.`, a.watch && `Watch: ${a.watch}.`],
  },
  weight: {
    name: 'Weight and nutrition',
    guidance: 'Body composition goals and eating habits the review should keep in mind (no medical details).',
    questions: [q('goal', 'Your weight or body composition goal', 'e.g. lose 10 lb while keeping muscle'), q('eating', 'How you eat', 'e.g. high protein, two meals, weekend treats'),
      q('watch', 'What the review should watch', 'e.g. weekly weight trend, drinks, steps'), q('tone', 'How to talk about it', 'e.g. focus on trends, not single days')],
    template: (a) => [a.goal && `My goal: ${a.goal}.`, a.eating && `How I eat: ${a.eating}.`, a.watch && `Watch: ${a.watch}.`, a.tone && `How to talk about it: ${a.tone}.`],
  },
  sleep: {
    name: 'Sleep and recovery',
    guidance: 'Sleep habits and recovery: bedtime, what helps or hurts, and what to watch (sleep hours, HRV, resting heart rate).',
    questions: [q('habits', 'Your sleep habits', 'e.g. bed at 10:30, up at 6'), q('affects', 'What helps or hurts', 'e.g. late workouts and drinks hurt'),
      q('watch', 'What the review should watch', 'e.g. sleep under 7 hours, HRV dips'), q('goal', 'Your goal', 'e.g. 7.5 hours most nights')],
    template: (a) => [a.habits && `My sleep: ${a.habits}.`, a.affects && `What affects it: ${a.affects}.`, a.watch && `Watch: ${a.watch}.`, a.goal && `My goal: ${a.goal}.`],
  },
  custom: {
    name: '',
    guidance: 'A section of the owner\'s own: what the review should know or do about one topic.',
    questions: [q('topic', 'The topic', 'e.g. Mobility'), q('details', 'What the review should know or do about it', 'e.g. I do 10 minutes of hips daily; nudge me when I skip')],
    template: (a) => [a.details && `${a.details}`],
  },
};

const clean = (answers = {}) => Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, String(v ?? '').trim().slice(0, MAX_ANSWER_CHARS)]).filter(([, v]) => v));
const tidy = (text) => stripDashes({ sections: [{ title: '', body: text }], physicianDiscussion: [] }).sections[0].body.replace(/\.\.+/g, '.');

/** The builder's questions, for the Prompt tab. */
export const builderSpec = () => Object.entries(SECTION_KINDS).map(([kind, s]) => ({ kind, name: s.name, guidance: s.guidance, questions: s.questions }));

/** A section from the answers with no AI: the template's sentences. */
export function templateDraft(kind, answers) {
  const s = SECTION_KINDS[kind];
  const a = clean(answers);
  return { name: s.name || a.topic || 'My section', text: tidy(s.template(a).filter(Boolean).join(' ')) };
}

const SYSTEM = `You help someone write one section of the instructions that a weekly health review follows. The review is written by an AI from computed summaries of their health and training data; these instructions tell it about the person and how to write.
Write the section from their answers only: in their own voice where it is about them ("I lift 4 days a week"), and as plain instructions where it is about the review ("Lead with what went well").
Keep it short and specific: 40 to 150 words, plain sentences, no headings, no lists unless the answers are a list. Do not invent facts they did not give.
Never include medication names, doses, lab values or diagnoses, even if the answers mention them: those come from the app's Meds and Labs tabs. If the answers had any, leave them out.
Write without em dashes, en dashes or double hyphens. Reply with the section text only.`;

/**
 * Drafts a section with Claude from the answers (the user's own AI). Returns { name, text }.
 * @param {{ store: object, claude: { send: Function }, kind: string, answers: object, goals?: string[], logger?: object }} o
 */
export async function claudeDraft({ store, claude, kind, answers, goals = [], logger }) {
  const s = SECTION_KINDS[kind];
  const a = clean(answers);
  const prompt = `Section: ${s.name || a.topic || 'their own topic'}\nWhat this section is for: ${s.guidance}\n${goals.length ? `Their training goals: ${goals.join(', ')}\n` : ''}\nTheir answers:\n${s.questions.map((x) => (a[x.key] ? `- ${x.label}: ${a[x.key]}` : null)).filter(Boolean).join('\n') || '(none)'}`;
  const run = startUserRun(store, 'prompt-draft', { model: DRAFT_MODEL, kind, answerChars: Object.values(a).join('').length }, logger);
  try {
    const result = await claude.send({ model: DRAFT_MODEL, maxTokens: MAX_TOKENS, system: SYSTEM, prompt, trace: run, label: 'prompt-draft' });
    const text = tidy(String(result.text ?? '').trim());
    run.finish('ok', { model: result.model, draftChars: text.length });
    return { name: s.name || a.topic || 'My section', text };
  } catch (err) {
    run.finish('error', { error: err.name });
    throw err;
  }
}
