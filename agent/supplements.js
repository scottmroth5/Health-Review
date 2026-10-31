// Supplement suggestions (owner's choice, 2026-10-30): opt in per user (settings supplement_advice, the time they
// accepted the statement). With it on, the weekly review, the Next program chat and Help may recommend adding,
// changing or stopping a supplement, with reasons and precautions, under SUPPLEMENT_DISCLAIMER, which code adds word
// for word. Prescription medications are never recommended, and amounts are checked against config/supplement-limits.json.
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';
import { EMERGENCY_LINE } from './emergency.js';
import { loadMedications, medicationNames } from '../metrics/load.js';
import { medicationsWeek } from '../metrics/medications.js';
import { labsSummary, loadLabRanges } from '../metrics/labs.js';

export const SUPPLEMENTS_TITLE = 'Supplement suggestions';

export const SUPPLEMENT_DISCLAIMER = '**These are recommendations only, not medical advice.** They are generated automatically by AI from your data '
  + 'and have not been reviewed by a physician, pharmacist or dietitian. They are not a diagnosis, treatment or prescription. You alone decide '
  + 'whether to act on any of them, and you accept full responsibility for that decision and for any result. Health Review and the person who '
  + 'runs it accept no responsibility or liability for any decision you make, any action you take, or any outcome. Supplements can interact '
  + 'with medications and health conditions: check with your physician or pharmacist before starting, changing or stopping any supplement, '
  + `especially if you take medication, are pregnant or nursing, or have a medical condition. ${EMERGENCY_LINE}`;

export const ACTIONS = ['add', 'change', 'stop'];

/** When the user accepted the statement and turned suggestions on (ISO text), or null: off. */
export function supplementAdviceSince(db) {
  return db.prepare("SELECT value FROM settings WHERE user_id = @uid AND key = 'supplement_advice'").pluck().get() ?? null;
}

/**
 * What the chat adds when the setting is on (owner's choice, 2026-10-30): current supplements with their amounts,
 * medication names without doses (for interaction precautions), and the latest labs with range status (a reason).
 */
export function supplementContext(db, today) {
  const { medications, medication_periods: periods } = loadMedications(db);
  const current = medicationsWeek(medications, periods, [], [], today).current.filter((m) => m.kind === 'supplement')
    .map((m) => ({ name: m.name, dose: m.dose, ingredients: m.ingredients, timings: m.timings, since: m.since, purpose: m.purpose }));
  const tests = db.prepare('SELECT id, name, panel, unit, position, ref_low, ref_high, ref_set FROM lab_tests WHERE user_id = @uid').all();
  const results = db.prepare('SELECT test_id, drawn_on, value, value_text FROM lab_results WHERE user_id = @uid AND drawn_on <= ?').all(today);
  const labs = labsSummary(tests, results, today, loadLabRanges()).results
    .map((r) => ({ test: r.test, unit: r.unit, latest: r.latest, range: r.range ?? null, rangeStatus: r.rangeStatus ?? null }));
  return { supplements: current, medicationNames: medicationNames(db), labs };
}

const SUGGESTION = {
  type: 'object',
  additionalProperties: false,
  required: ['supplement', 'action', 'amount', 'reasons', 'precautions'],
  properties: {
    supplement: { type: 'string' },
    action: { type: 'string', enum: ACTIONS },
    amount: { type: 'string' },
    reasons: { type: 'string' },
    precautions: { type: 'string' },
  },
};

/** A structured-output schema with supplementSuggestions added (only when the user turned them on). */
export function withSuggestions(schema) {
  return { ...schema, required: [...schema.required, 'supplementSuggestions'],
    properties: { ...schema.properties, supplementSuggestions: { type: 'array', items: SUGGESTION } } };
}

const RULES_BODY = `- "supplementSuggestions": recommendations to add, change (amount or timing) or stop a supplement, only where the data gives a reason. Leave it empty rather than pad it; at most three.
- "supplement": the supplement's common name. "action": add, change or stop. "amount": the new daily total with its unit ("2,000 IU a day", "5 g a day"), or "" for stop or when no amount is recommended; never above the adult tolerable upper intake level.
- "reasons": detailed reasons in plain sentences, naming the data behind them (numbers copied exactly from the input), the owner's goals, and what the change is expected to do. Lab values and their range status may be a reason (say below or above range; never normal or abnormal). Do not name medications or symptoms here.
- "precautions": every precaution that applies: interactions with each of the owner's current medications by name (or that none are known), conditions and situations where it should be avoided (such as pregnancy, kidney or liver disease), the adult upper intake level for this supplement (or that none is established), common side effects, and when to stop and see a physician.
- Never recommend, start, stop or change a prescription medication or its dose, and never suggest a supplement in place of one. Never present a suggestion as a diagnosis or a treatment.
- Code shows a statement above the suggestions that they are recommendations only and the owner alone is responsible for decisions; do not write your own version of it.`;

/** Rules appended to the review's or the chat's system prompt when the setting is on (never to CONTRACT, which stays cached). */
export const SUPPLEMENT_RULES = `# Supplement suggestions (the owner turned these on)

These rules replace the rule that supplements may be discussed only observationally. Supplement observations may still appear in the sections; recommendations go only in "supplementSuggestions":
${RULES_BODY}`;

/** Help's version: general information only, as Help never sees the user's data. */
export const HELP_SUPPLEMENT_RULES = `The user turned on supplement suggestions. For a question about supplements you may give general recommendations: what a supplement is commonly used for, reasons for and against adding, changing or stopping it, typical adult amounts never above the tolerable upper intake level, and precautions (interactions with medications, conditions to avoid it with, side effects, when to see a physician). You do not know their data, medications or labs, so say that their physician or pharmacist should check it against them. Never recommend a prescription medication or its dose. Set "supplementAdvice" to true when the answer recommends anything about a supplement; code then shows a statement that it is a recommendation only.`;

const UNIT = { mcg: 'mcg', µg: 'mcg', ug: 'mcg', mg: 'mg', g: 'g', iu: 'IU' };
const toBase = (amount, unit) => (unit === 'g' ? { amount: amount * 1000, unit: 'mg' } : { amount, unit });
const sameScale = (a, b) => {
  if (a.unit === b.unit) return [a.amount, b.amount];
  if (a.unit === 'mg' && b.unit === 'mcg') return [a.amount * 1000, b.amount];
  if (a.unit === 'mcg' && b.unit === 'mg') return [a.amount, b.amount * 1000];
  return null;
};

/** The first amount with a unit in "2,000 IU a day" ({ amount: 2000, unit: 'IU' }), or null. */
export function parseAmount(text) {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(mcg|µg|ug|mg|g|iu)\b/i.exec(String(text ?? ''));
  return m ? toBase(Number(m[1].replace(/,/g, '')), UNIT[m[2].toLowerCase()]) : null;
}

let limitsFile;
const limitsConfig = () => (limitsFile ??= JSON.parse(readFileSync(repoPath('config', 'supplement-limits.json'), 'utf8')));

/** The config entry for a supplement name (its name or an alias as whole words, longest first), or null. */
export function limitEntry(name, config = limitsConfig()) {
  const text = ` ${String(name).toLowerCase().replace(/[^a-z0-9']+/g, ' ')} `;
  const candidates = config.supplements.flatMap((s) => [s.name, ...s.aliases].map((n) => ({ s, n: n.toLowerCase().replace(/[^a-z0-9']+/g, ' ') })))
    .sort((a, b) => b.n.length - a.n.length);
  return candidates.find(({ n }) => text.includes(` ${n} `))?.s ?? null;
}

/** The upper limits that apply at an age (an unknown age takes the lowest band). */
function limitsAt(entry, age) {
  if (entry.limits) return entry.limits;
  const band = age === null ? null : entry.bands.find((b) => age >= b.ages[0] && age <= b.ages[1]);
  return band?.limits ?? entry.bands.flatMap((b) => b.limits).sort((a, b) => a.amount - b.amount).slice(0, 1);
}

/** Over the upper limit: { limit } when the amount is comparable and above it; null when within it or not checkable. */
export function overLimit(suggestion, { age = null, config = limitsConfig() } = {}) {
  const entry = limitEntry(suggestion.supplement, config);
  const amount = parseAmount(suggestion.amount);
  if (!entry || !amount) return null;
  for (const l of limitsAt(entry, age)) {
    const pair = sameScale(amount, toBase(l.amount, l.unit));
    if (pair && pair[0] > pair[1]) return { limit: `${l.amount.toLocaleString('en-US')} ${l.unit}`, name: entry.name };
  }
  return null;
}

const ACTION_WORDS = { add: 'Add', change: 'Change', stop: 'Stop' };

/** The suggestions as Markdown, the statement first. Empty when there are none. */
export function renderSuggestions(items = []) {
  if (!items.length) return '';
  // A bold line, then two bullets: the app's Markdown subset has no nested lists.
  const item = (s) => `**${ACTION_WORDS[s.action] ?? s.action}: ${s.supplement.trim()}${s.amount?.trim() ? `, ${s.amount.trim()}` : ''}**\n`
    + `- **Why:** ${s.reasons.trim()}\n- **Precautions:** ${s.precautions.trim()}`;
  return `## ${SUPPLEMENTS_TITLE}\n${SUPPLEMENT_DISCLAIMER}\n\n${items.map(item).join('\n\n')}`;
}
