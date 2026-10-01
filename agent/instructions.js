// The review's system prompt: a fixed contract written in code (how to read the summary, and the hard
// rules), followed by the owner's prompt sections from the Prompt tab. Kept stable so it caches.
import { buildInstructions, WEEKLY_INCLUDES_SENSITIVE } from './prompts.js';

export const CONTRACT = `You write a weekly health review from a computed summary.

How to read the input:
- The user message holds one JSON summary for the review week. It replaces the raw data sources that the instructions below describe; there are no raw rows.
- Every number was computed in code. Copy numbers exactly as they appear in the summary; do not calculate new ones (no sums, averages, percentages or differences of your own). A null value means no data: say "no data" rather than estimating.
- Calendar dates are fine. When you suggest a new target (for example a protocol progression or a heart rate to hold), introduce the number with the word "target": "target 75 sec easy intervals", "target of 130 bpm or higher". Every other number must come from the summary or the instructions.
- "notes" are the owner's own words from the week. Use them for life context.
- "medications" holds the current medications and supplements, how many logged doses were taken, and recent changes with before and after averages. Those averages are observational; never present them as cause.
- "labs" holds the latest lab values and the change since each test's previous draw. There are no reference ranges.
- Qualitative context you know (for example how a VO2 max compares for someone's age) may be described in words, but never as a number.

Hard rules:
- Never write an em dash, an en dash, or a double hyphen. Use commas, colons, parentheses or separate sentences.
- Never recommend starting, stopping or changing a medication or its dose, and never interpret a lab value as high, low, normal or abnormal. Any point about medications, lab values, or symptoms (illness, injury, pain) goes only in physicianDiscussion, phrased as something to discuss with a physician. Do not mention medication names, lab results (a lab test with its value) or symptoms in any other section; a lab name without a value may appear as context.
- Supplements may be discussed in the sections, observationally, without telling the owner to start or stop one.

Keep the whole report under 2,000 words.

Output: the structured format requested. One entry in "sections" per report section named in the instructions, in that order, with the exact section title. Each body is Markdown: short paragraphs, "- " bullets and **bold**; no headings inside a body.`;

/**
 * @param {Array<{position, name, text, sensitive}>} sections  prompt_sections rows
 * @param {string} today
 * @returns {{ system: string, sensitiveSent: string[] }}
 */
export function buildSystem(sections, today) {
  const owner = buildInstructions(sections, today, { includeSensitive: WEEKLY_INCLUDES_SENSITIVE });
  return {
    system: `${CONTRACT}\n\n# The owner's instructions\n\n${owner}`,
    sensitiveSent: WEEKLY_INCLUDES_SENSITIVE ? sections.filter((s) => s.sensitive).map((s) => s.name) : [],
  };
}

/** Structured output. Kept to plain types (no length or count limits, which the API rejects). */
export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections', 'physicianDiscussion'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body'],
        properties: { title: { type: 'string' }, body: { type: 'string' } },
      },
    },
    physicianDiscussion: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'detail'],
        properties: { topic: { type: 'string' }, detail: { type: 'string' } },
      },
    },
  },
};

export const PHYSICIAN_TITLE = 'Discuss with your physician';

/** The stored and displayed report. */
export function renderReport(report) {
  const parts = report.sections.map((s) => `## ${s.title.trim()}\n${s.body.trim()}`);
  if (report.physicianDiscussion.length) {
    parts.push(`## ${PHYSICIAN_TITLE}\n${report.physicianDiscussion.map((p) => `- **${p.topic.trim()}**: ${p.detail.trim()}`).join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}
