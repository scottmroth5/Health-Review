// Checks on the review model's output, run in code. Each returns a list of problems; the review is
// retried once with the problems listed, and anything left is saved with the report as warnings.

const DASHES = /[–—]|--/;

/** Em dashes, en dashes and double hyphens, by where they appear. */
export function findDashes(report) {
  const problems = [];
  for (const s of report.sections) if (DASHES.test(s.title) || DASHES.test(s.body)) problems.push(`dash in "${s.title}"`);
  for (const p of report.physicianDiscussion) if (DASHES.test(p.topic) || DASHES.test(p.detail)) problems.push(`dash in physician item "${p.topic}"`);
  return problems;
}

/** Last resort after the retry: replace dashes with commas so the rule still holds. */
export function stripDashes(report) {
  const fix = (t) => t.replace(/\s*(?:[–—]|--)\s*/g, ', ');
  return {
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

/** Numbers in the report that appear nowhere in the summary or instructions. */
export function ungroundedNumbers(report, allowed) {
  const texts = [
    ...report.sections.flatMap((s) => [s.title, s.body]),
    ...report.physicianDiscussion.flatMap((p) => [p.topic, p.detail]),
  ];
  const missing = new Set();
  for (const t of texts) {
    for (const m of t.match(NUMBER) ?? []) {
      const n = toNumber(m);
      if (!allowed.has(n)) missing.add(m.replace(/^-/, ''));
    }
  }
  return [...missing];
}

const SYMPTOMS = /\b(sick|illness|ill|injur(?:y|ies|ed)|pain(?:ful)?|symptoms?|dizz(?:y|iness)|nause(?:a|ous)|headaches?|fever|flu|covid)\b/i;
const MEDICATION_WORDS = /\b(medications?|prescri(?:bed|ption)s?)\b/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Short all-caps names (ALT, BUN, MCV) match case-sensitively; others ignore case. */
const nameMatcher = (name) => {
  const short = name.length <= 4 && name === name.toUpperCase();
  return new RegExp(`(?<![\\w])${escape(name)}(?![\\w])`, short ? '' : 'i');
};

/**
 * Medication names, lab test names, and symptom words outside physicianDiscussion.
 * @param {{ medicationNames: string[], labNames: string[] }} names
 */
export function misroutedTopics(report, { medicationNames = [], labNames = [] }) {
  const matchers = [
    ...medicationNames.map((n) => ({ what: `medication "${n}"`, re: nameMatcher(n) })),
    ...labNames.map((n) => ({ what: `lab test "${n}"`, re: nameMatcher(n) })),
    { what: 'medication wording', re: MEDICATION_WORDS },
    { what: 'symptom wording', re: SYMPTOMS },
  ];
  const problems = [];
  for (const s of report.sections) {
    for (const { what, re } of matchers) {
      if (re.test(s.body) || re.test(s.title)) problems.push(`${what} in "${s.title}" (belongs in physicianDiscussion)`);
    }
  }
  return problems;
}

/** All checks; [] when the report passes. */
export function checkReport(report, { allowed, medicationNames, labNames }) {
  const problems = [];
  if (!report.sections.length) problems.push('no sections');
  problems.push(...findDashes(report));
  const numbers = ungroundedNumbers(report, allowed);
  if (numbers.length) problems.push(`numbers not in the summary: ${numbers.join(', ')}`);
  problems.push(...misroutedTopics(report, { medicationNames, labNames }));
  return problems;
}
