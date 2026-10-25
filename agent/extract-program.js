// Reading a training program from a PDF the user uploaded (multi-user, phase 5): one structured-output call with the
// PDF as a document block, on the user's own AI (their key, or the owner's within their cap). Claude returns the
// program's structure only (name, weeks, phases, workouts, exercises with sets and reps); the result is a draft that the
// user checks in the builder, and nothing is saved here. The PDF is held in memory for this call only: never stored,
// logged or put in the run record, which keeps metadata only (size, model, counts, cost).
import { startUserRun } from '../db/users.js';
import { programProblems } from '../metrics/catalog.js';

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TOKENS = 32000;
export const EXTRACT_MODEL = 'claude-opus-5-5';

const str = { type: 'string' };
const int = { type: 'integer' };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const DRAFT_SCHEMA = obj({
  name: str,
  weeks: int,
  focus: str,
  phases: { type: 'array', items: obj({
    name: str, first_week: int, last_week: int, workouts_per_week: int,
    deload_weeks: { type: 'array', items: int }, failure_weeks: { type: 'array', items: int },
    workouts: { type: 'array', items: obj({ name: str, exercises: { type: 'array', items: obj({ name: str, sets: str, reps: str }) } }) },
  }) },
  notes: { type: 'array', items: str },
});

const SYSTEM = `You read a strength training program from the document and return its structure for a training log app.
Return only what the document states; never invent exercises, weeks or numbers. If something is unclear, leave it out and say so in notes (short, plain sentences).
- name: the program's name as the document gives it. weeks: its total length in weeks.
- focus: one plain sentence on what the program trains, in your own words.
- phases: in order, covering weeks 1 to weeks with no gaps or overlaps. Name them "Phase 1", "Phase 2", ... unless the document names them, then use its names. A program with no phases is one phase over all its weeks.
- deload_weeks and failure_weeks: program week numbers inside that phase, when the document names them; otherwise empty.
- workouts: each workout of the phase, named as in the document (such as "Workout A" or "Day 1"), with its exercises in order.
- exercises: the exercise name as written; sets as a number or range ("4", "3-4"); reps as a number or range ("8", "8-12"), or seconds for timed holds ("30s", "30-60s"). Use "" for sets or reps the document does not give.
- If the document holds several programs, read the main one and name the others in notes.
Write without em dashes, en dashes or double hyphens.`;

/** A draft from Claude in the catalog's format (metrics/catalog.js), dropping blank sets and reps. */
export function draftToProgram(d) {
  const blank = (v) => (String(v ?? '').trim() ? String(v).trim() : undefined);
  return {
    name: String(d.name ?? '').trim(),
    weeks: d.weeks,
    profile: d.focus?.trim() ? { focus: d.focus.trim() } : undefined,
    phases: (d.phases ?? []).map((ph) => ({
      name: ph.name,
      weeks: [ph.first_week, ph.last_week],
      ...(ph.workouts_per_week > 0 ? { workouts_per_week: ph.workouts_per_week } : {}),
      ...(ph.deload_weeks?.length || ph.failure_weeks?.length ? { special_weeks: { deload: ph.deload_weeks ?? [], failure: ph.failure_weeks ?? [] } } : {}),
      workouts: (ph.workouts ?? []).map((wo) => ({
        name: wo.name,
        exercises: (wo.exercises ?? []).map((ex) => Object.fromEntries(Object.entries({ name: ex.name, sets: blank(ex.sets), reps: blank(ex.reps) }).filter(([, v]) => v !== undefined))),
      })),
    })),
  };
}

/** Whether a buffer is a PDF file (its header). */
export const isPdf = (buf) => buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

/**
 * Drafts a program from a PDF. Saves nothing.
 * @param {{ store: object, claude: { send: Function }, pdf: Buffer, model?: string, logger?: object }} o  store: the user's scoped store
 * @returns {Promise<{ program: object, problems: string[], notes: string[] }>}
 */
export async function extractProgram({ store, claude, pdf, model = EXTRACT_MODEL, logger }) {
  const run = startUserRun(store, 'program-extract', { model, bytes: pdf.length }, logger);
  try {
    const result = await claude.send({
      model, maxTokens: MAX_TOKENS, system: SYSTEM, schema: DRAFT_SCHEMA, effort: 'medium', trace: run, label: 'program-extract',
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
        { type: 'text', text: 'Read the training program in this document.' },
      ] }],
    });
    const program = draftToProgram(result.data);
    const problems = programProblems(program);
    run.finish('ok', { model: result.model, phases: program.phases.length, problems: problems.length });
    return { program, problems, notes: (result.data.notes ?? []).map(String) };
  } catch (err) {
    run.finish('error', { error: err.name });
    throw err;
  }
}
