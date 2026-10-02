// Optional assist for the exercise dictionary: asks Claude where unmapped exercise names belong. The request
// holds exercise names only (the unmapped names and the dictionary's existing names), never weights, dates,
// set counts or anything else from the log (hard rule). Proposals go to a local file; nothing reaches the
// dictionary until the owner keeps them and runs log:unmapped -- --accept.
import { IMPLEMENTS, PATTERNS } from '../metrics/dictionary.js';

export const SUGGEST_MODEL = 'claude-sonnet-5-5';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'action', 'existing_id', 'new_exercise', 'reason'],
        properties: {
          name: { type: 'string' },
          action: { type: 'string', enum: ['existing', 'new', 'ignore', 'unsure'] },
          existing_id: { type: ['string', 'null'] },
          new_exercise: {
            anyOf: [{ type: 'null' }, {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name', 'implement', 'pattern', 'primary'],
              properties: {
                id: { type: 'string' }, name: { type: 'string' }, implement: { type: 'string', enum: IMPLEMENTS },
                pattern: { type: 'string', enum: PATTERNS }, primary: { type: 'boolean' },
              },
            }],
          },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `You map exercise names from a personal strength training log to a canonical exercise dictionary.
For each name: "existing" with existing_id when it is the same exercise as a dictionary entry with the same implement
(barbell and dumbbell versions are different exercises); "new" with a new_exercise when it is a real exercise not in
the dictionary (id is lowercase words joined by hyphens; primary is false unless it is a main barbell lift);
"ignore" when it is a note rather than an exercise; "unsure" when you cannot tell, especially when the implement is
not clear from the name. Never guess an implement: prefer "unsure". Keep reason to one short sentence.`;

/** The exact request payload: exercise names only. Exported so tests can check nothing else is sent. */
export function suggestionPayload(names, dictionary) {
  return {
    unmapped_names: names,
    dictionary: dictionary.exercises.map((e) => ({ id: e.id, name: e.name, implement: e.implement })),
    implements: IMPLEMENTS,
    patterns: PATTERNS,
  };
}

/**
 * @param {{ claude: ReturnType<import('./claude.js').createReviewClaude>, names: string[], dictionary: object, model?: string }} opts
 * @returns {Promise<Array<object>>} one suggestion per name
 */
export async function suggestMappings({ claude, names, dictionary, model = SUGGEST_MODEL }) {
  const result = await claude.send({
    model,
    maxTokens: 16000,
    system: SYSTEM,
    prompt: JSON.stringify(suggestionPayload(names, dictionary)),
    schema: SCHEMA,
    effort: 'low',
    label: 'exercise-suggestions',
  });
  return result.data.suggestions;
}

/**
 * Applies kept suggestions to a dictionary object (returns a new one): "existing" adds the name as a variant,
 * "new" adds an entry, "ignore" adds it to ignore. "unsure" ones are skipped.
 */
export function applySuggestions(json, suggestions) {
  const out = structuredClone(json);
  const byId = new Map(out.exercises.map((e) => [e.id, e]));
  out.ignore ??= [];
  for (const s of suggestions) {
    if (s.action === 'existing' && byId.has(s.existing_id)) {
      const e = byId.get(s.existing_id);
      e.variants = [...(e.variants ?? []), s.name];
    } else if (s.action === 'new' && s.new_exercise && !byId.has(s.new_exercise.id)) {
      const e = { ...s.new_exercise, variants: s.new_exercise.name === s.name ? undefined : [s.name] };
      if (!e.variants) delete e.variants;
      out.exercises.push(e);
      byId.set(e.id, e);
    } else if (s.action === 'ignore') {
      out.ignore.push(s.name);
    }
  }
  return out;
}
