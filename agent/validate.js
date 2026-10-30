// Checks on the review model's output, run in code. Each returns a list of problems; the review is
// retried once with the problems listed, and anything left is saved with the report as warnings.

const DASHES = /[–—]|--/;

/** The report's opening: highlights and next steps (absent on reports written before them). */
const opening = (report) => [
  ...(report.highlights ?? []).map((text, i) => ({ where: `highlight ${i + 1}`, text })),
  ...(report.nextSteps ?? []).map((text, i) => ({ where: `next step ${i + 1}`, text })),
];

/** Em dashes, en dashes and double hyphens, by where they appear. */
export function findDashes(report) {
  const problems = [];
  for (const o of opening(report)) if (DASHES.test(o.text)) problems.push(`dash in ${o.where}`);
  for (const s of report.sections) if (DASHES.test(s.title) || DASHES.test(s.body)) problems.push(`dash in "${s.title}"`);
  for (const p of report.physicianDiscussion) if (DASHES.test(p.topic) || DASHES.test(p.detail)) problems.push(`dash in physician item "${p.topic}"`);
  return problems;
}

/** Last resort after the retry: replace dashes with commas so the rule still holds. */
export function stripDashes(report) {
  const fix = (t) => t.replace(/\s*(?:[–—]|--)\s*/g, ', ');
  return {
    highlights: (report.highlights ?? []).map(fix),
    nextSteps: (report.nextSteps ?? []).map(fix),
    sections: report.sections.map((s) => ({ title: fix(s.title), body: fix(s.body) })),
    physicianDiscussion: report.physicianDiscussion.map((p) => ({ topic: fix(p.topic), detail: fix(p.detail) })),
  };
}

// A number not glued to a word before it (CoQ10, A1C, D3 are names, not values). Thousands commas
// and decimals are part of the number; units may follow directly ("7.3h", "8am").
const NUMBER = /(?<![\w.,])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?!\.?\d)/g;
const ALWAYS_OK = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 28, 34, 90, 100];

const toNumber = (text) => Math.abs(Number(text.replace(/,/g, '')));

/** Every number the report may use: all values in the summary and instructions, plus small counts and window lengths. */
export function allowedNumbers(summary, instructions = '') {
  const allowed = new Set(ALWAYS_OK);
  const addText = (t) => {
    for (const m of String(t).match(/\d+(?:\.\d+)?/g) ?? []) allowed.add(Number(m));
  };
  const walk = (v) => {
    if (typeof v === 'number') allowed.add(Math.abs(v));
    else if (typeof v === 'string') addText(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(summary);
  addText(instructions);
  return allowed;
}

// Calendar dates (8/31, 3/23/2026) are not data values. Month 1-12 and day 1-31 only, so ratios
// such as 20/120 are still checked.
const DATE = /(?<![\w/])(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])(?:\/\d{2,4})?(?![\w/])/g;
// Suggested targets are allowed when introduced by the word "target" ("target 75 sec",
// "target of 130 or higher", "target 6 to 8 rounds"); the instructions tell the model to write them so.
const TARGET = /\btargets?(?:\s+of)?\s+(?:about\s+|~)?-?\d[\d,]*(?:\.\d+)?(?:\s*(?:to|-)\s*\d[\d,]*(?:\.\d+)?)?/gi;

const withoutExemptNumbers = (text) => text.replace(DATE, ' ').replace(TARGET, ' ');

/** Numbers in the report that appear nowhere in the summary or instructions (dates and marked targets excepted). */
export function ungroundedNumbers(report, allowed) {
  const texts = [
    ...opening(report).map((o) => o.text),
    ...report.sections.flatMap((s) => [s.title, s.body]),
    ...report.physicianDiscussion.flatMap((p) => [p.topic, p.detail]),
  ];
  const missing = new Set();
  for (const t of texts) {
    for (const m of withoutExemptNumbers(t).match(NUMBER) ?? []) {
      const n = toNumber(m);
      if (!allowed.has(n)) missing.add(m.replace(/^-/, ''));
    }
  }
  return [...missing];
}

const SYMPTOMS = /\b(sick|illness|ill|injur(?:y|ies|ed)|pain(?:ful)?|symptoms?|dizz(?:y|iness)|nause(?:a|ous)|headaches?|fever|flu|covid)\b/i;
// "Prescribed" is left out: training programs prescribe sets ("hit every prescribed 5x5").
const MEDICATION_WORDS = /\b(medications?|prescriptions?)\b/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Short all-caps names (ALT, BUN, MCV) match case-sensitively; others ignore case. */
const nameMatcher = (name) => {
  const short = name.length <= 4 && name === name.toUpperCase();
  return new RegExp(`(?<![\\w])${escape(name)}(?![\\w])`, short ? '' : 'i');
};

/** A lab name followed within the same clause (up to 25 characters) by a number. */
const labValueMatcher = (name) => {
  const short = name.length <= 4 && name === name.toUpperCase();
  return new RegExp(`(?<![\\w])${escape(name)}(?![\\w])[^.;\\n\\d]{0,25}\\d`, short ? '' : 'i');
};

/** Range wording: where a lab value sits against its reference range, which is interpretation (physicianDiscussion only). */
const RANGE_PHRASES = '(?:(?:above|below|outside|out of|within|in) (?:the |its |your )?(?:reference |normal )?range|abnormal)';
const LEVEL_WORDS = '(?:elevated|high|low|normal)';

/**
 * A lab name with range wording: a range phrase ("above range", "abnormal") in the same clause up to 40 characters
 * either side, or a level word right before the name ("elevated ALT") or a few words after it ("HDL was high"), so
 * "steps were high and HDL tracking began" is not caught.
 */
const labRangeMatcher = (name) => {
  const short = name.length <= 4 && name === name.toUpperCase();
  const n = `(?<![\\w])${escape(name)}(?![\\w])`;
  const phrase = `\\b${RANGE_PHRASES}\\b`;
  const level = `\\b${LEVEL_WORDS}\\b`;
  return new RegExp([
    `${n}[^.;\\n]{0,40}?${phrase}`, `${phrase}[^.;\\n]{0,40}?${n}`,
    `${level}\\s+${n}`, `${n}(?:\\s+\\w+){0,3}?\\s+${level}`,
  ].join('|'), short ? '' : 'i');
};

/**
 * Medication names, lab values, lab range wording, and symptom words outside physicianDiscussion.
 * @param {{ medicationNames: string[], labNames: string[] }} names
 */
export function misroutedTopics(report, { medicationNames = [], labNames = [] }) {
  const matchers = [
    ...medicationNames.map((n) => ({ what: `medication "${n}"`, re: nameMatcher(n) })),
    // A lab name alone can be context ("sleep timing matters for glucose regulation"); a lab name
    // with a value next to it ("Glucose 101", "ALT of 62") is a lab result and must be routed.
    ...labNames.map((n) => ({ what: `lab value "${n}"`, re: labValueMatcher(n) })),
    // "LDL was above range", "elevated ALT": a lab name with range wording is interpretation too.
    ...labNames.map((n) => ({ what: `lab range "${n}"`, re: labRangeMatcher(n) })),
    { what: 'medication wording', re: MEDICATION_WORDS },
    { what: 'symptom wording', re: SYMPTOMS },
  ];
  const problems = [];
  for (const o of opening(report)) {
    for (const { what, re } of matchers) if (re.test(o.text)) problems.push(`${what} in ${o.where} (belongs in physicianDiscussion)`);
  }
  for (const s of report.sections) {
    for (const { what, re } of matchers) {
      if (re.test(s.body) || re.test(s.title)) problems.push(`${what} in "${s.title}" (belongs in physicianDiscussion)`);
    }
  }
  return problems;
}

/** The owner's rules ask for under 2,000 words; the check allows a wide margin, because a retry roughly doubles a
 * review's cost and the eval showed drafts of up to about 2,540 words that were otherwise clean (raised from 2,200 to 3,000 by the owner). */
export const MAX_WORDS = 3000;

export const countWords = (report) =>
  [...opening(report).map((o) => o.text), ...report.sections.map((s) => s.body), ...report.physicianDiscussion.map((p) => `${p.topic} ${p.detail}`)]
    .join(' ').split(/\s+/).filter(Boolean).length;

/** At most this many highlights and next steps (the schema can't hold a count limit). */
export const MAX_OPENING_ITEMS = 3;

/**
 * All checks; [] when the report passes. opening (the weekly review; not the chat) also requires 1 to 3 highlights and
 * at most 3 next steps.
 */
export function checkReport(report, { allowed, medicationNames, labNames, maxWords = MAX_WORDS, opening: needsOpening = false }) {
  const problems = [];
  if (!report.sections.length) problems.push('no sections');
  if (needsOpening) {
    const highlights = report.highlights ?? [];
    const nextSteps = report.nextSteps ?? [];
    if (!highlights.length) problems.push('no highlights (give the week\'s biggest changes, at most 3)');
    if (highlights.length > MAX_OPENING_ITEMS) problems.push(`too many highlights: ${highlights.length} (at most ${MAX_OPENING_ITEMS})`);
    if (nextSteps.length > MAX_OPENING_ITEMS) problems.push(`too many next steps: ${nextSteps.length} (at most ${MAX_OPENING_ITEMS})`);
  }
  const words = countWords(report);
  if (words > maxWords) problems.push(`too long: ${words} words (keep it under 2,000; the limit is ${maxWords})`);
  problems.push(...findDashes(report));
  const numbers = ungroundedNumbers(report, allowed);
  if (numbers.length) problems.push(`numbers not in the summary: ${numbers.join(', ')}`);
  problems.push(...misroutedTopics(report, { medicationNames, labNames }));
  return problems;
}
