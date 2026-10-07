// The Next program chat: the owner types notes (a different mindset, an ailment, a preference) and Claude answers
// in light of the computed ranking. Sent: computed training facts only (the Advisor ranking at the owner's current
// weights, lift statuses, the current program and week, equipment and the avoid list) plus the owner's notes and the
// recent thread (owner's choice, 2026-10-07). Never sent: program focus text (derived from the copyrighted
// blueprints), raw logs, medications, labs or genetics. Replies get the review's checks: no dashes, numbers grounded
// in what was sent, and medication or symptom wording only in the physician list; one retry, then warnings.
// Runs are traced with metadata only; note and reply text stay in this database.
import { randomUUID } from 'node:crypto';
import { createTracer } from '@scottmroth5/agent-core';
import { recommendPrograms } from '../metrics/advisor.js';
import { liftsForReview } from '../metrics/plateau.js';
import { loadAdvisorInput, loadPrimarySets, loadSessionPhases, programForWeek } from '../metrics/load.js';
import { allowedNumbers, checkReport, findDashes, stripDashes } from './validate.js';
import { DEFAULT_REVIEW_MODEL } from './claude.js';

export const CHAT_EFFORT = 'medium';
export const THREAD_TURNS = 10;
export const MAX_NOTE_CHARS = 4000;
const MAX_TOKENS = 8000;
const MAX_WORDS = 800;

export const CHAT_CONTRACT = `You are a strength and conditioning coach helping the owner choose their next training program.

How to read the input:
- "context" holds facts computed in code: the Advisor ranking of the owner's programs at the goal weights they chose (each program's total, scores from 0 to 1 for strength, joint health and balance, time and VO2 max, the reasons, and flags for exercises the owner has paused), the programs left out and why, lift progress statuses, the current program and week, and the owner's home equipment.
- "thread" holds the earlier notes and replies; "note" is the owner's new note.

How to answer:
- The ranking was computed in code. Use the owner's note to weigh it: you may argue for a different program than the top one, and explain the trade-offs with the scores and reasons given. Never score or rank programs yourself, and only discuss programs in the context.
- Copy numbers exactly as they appear in the context or the note; do not calculate new ones. When you suggest a target (sessions a week, minutes, sets), introduce it with the word "target": "target 3 sessions a week".
- The owner trains at home: respect their equipment and the exercises they have paused.
- Keep the reply under 400 words: plain Markdown paragraphs and "- " bullets, no headings.

Hard rules:
- Never write an em dash, an en dash, or a double hyphen.
- You are not a physician. Anything about pain, injury, illness, symptoms or medication goes only in "physicianDiscussion", phrased as something to discuss with a physician; never diagnose or suggest treatment. In "reply" you may respect a limit the owner states (for example avoiding an exercise), without naming the condition.`;

export const CHAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'physicianDiscussion'],
  properties: {
    reply: { type: 'string' },
    physicianDiscussion: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['topic', 'detail'], properties: { topic: { type: 'string' }, detail: { type: 'string' } } },
    },
  },
};

/**
 * The computed training facts the chat may send. No focus text, raw logs, medications, labs or genetics.
 * @param {{ catalog: object, dictionary: object, substitutions: object, weights?: object }} options
 */
export function chatContext(db, today, { catalog, dictionary, substitutions = {}, weights }) {
  const ranked = recommendPrograms({ ...loadAdvisorInput(db, today, catalog), programs: catalog.programs, lookup: dictionary.lookup, substitutions, weights });
  const program = programForWeek(db, today, catalog);
  const nameOf = (id) => dictionary.exercises.find((e) => e.id === id)?.name ?? id;
  return {
    advisor: {
      weights: ranked.weights,
      ranking: ranked.ranking.map((r) => ({
        program: r.program, total: r.total, scores: r.scores, completionPct: r.completion, sessionsPerWeek: r.sessionsPerWeek,
        minutesPerSession: r.minutesPerSession, weeklyMinutes: r.weeklyMinutes, lessHistory: r.lessHistory, reasons: r.reasons, flags: r.flags,
      })),
      leftOut: ranked.excluded.map((x) => `${x.program} (${x.reason})`),
      addons: ranked.addons.map((r) => ({ program: r.program, total: r.total })),
    },
    lifts: liftsForReview(loadPrimarySets(db, today), today, { phases: new Map(Object.entries(loadSessionPhases(db))) })
      .map((l) => ({ name: l.name, status: l.status, range: l.range, changePct: l.changePct })),
    currentProgram: program ? { program: program.program, phase: program.phase, week: program.week, programWeeks: program.programWeeks } : null,
    equipment: { have: substitutions.equipment?.have ?? [], lack: substitutions.equipment?.lack ?? [] },
    pausedExercises: (substitutions.avoid ?? []).map((a) => nameOf(a.exercise)),
  };
}

const parse = (row) => ({ ...row, physician: row.physician ? JSON.parse(row.physician) : [], weights: row.weights ? JSON.parse(row.weights) : null,
  warnings: row.warnings ? JSON.parse(row.warnings) : [] });

/** The thread, oldest first. */
export function listChat(db) {
  return db.prepare('SELECT * FROM advisor_notes ORDER BY created_at, rowid').all().map(parse);
}

export function deleteChatNote(db, id) {
  return db.prepare('DELETE FROM advisor_notes WHERE id = ?').run(id).changes;
}

export function clearChat(db) {
  return db.prepare('DELETE FROM advisor_notes').run().changes;
}

const promptFor = (context, thread, note, problems) => [
  problems.length ? `A previous reply broke these rules; this reply must not:\n${problems.map((p) => `- ${p}`).join('\n')}\n` : null,
  'Input (JSON):',
  '```json',
  JSON.stringify({ context, thread, note }),
  '```',
].filter(Boolean).join('\n');

/**
 * Saves the owner's note, asks Claude, checks and saves the reply. The note is kept even when the call fails.
 * @param {object} options
 * @param {{ db: import('better-sqlite3').Database }} options.store
 * @param {{ send: Function }} options.claude  from createReviewClaude()
 */
export async function askAdvisor({ store, claude, text, today, catalog, dictionary, substitutions, weights, model = DEFAULT_REVIEW_MODEL,
  effort = CHAT_EFFORT, logger = console, now = () => new Date() }) {
  const { db } = store;
  const earlier = listChat(db).slice(-THREAD_TURNS).map((n) => ({ from: n.role, text: n.text }));
  const context = chatContext(db, today, { catalog, dictionary, substitutions, weights });
  const insert = db.prepare(`INSERT INTO advisor_notes (id, created_at, role, text, physician, weights, model, warnings)
    VALUES (@id, @created_at, @role, @text, @physician, @weights, @model, @warnings)`);
  const note = { id: randomUUID(), created_at: now().toISOString(), role: 'owner', text, physician: null, weights: JSON.stringify(context.advisor.weights), model: null, warnings: null };
  insert.run(note);

  const checks = {
    allowed: allowedNumbers({ context, earlier, text }, CHAT_CONTRACT),
    medicationNames: db.prepare("SELECT name FROM medications WHERE kind = 'medication'").pluck().all(),
    labNames: db.prepare('SELECT name FROM lab_tests').pluck().all(),
    maxWords: MAX_WORDS,
  };
  const asReport = (d) => ({ sections: [{ title: 'Reply', body: d.reply }], physicianDiscussion: d.physicianDiscussion });
  const run = createTracer({ store, logger }).startRun('advisor-chat', { model, effort, turns: earlier.length });
  try {
    const ask = (problems) => claude.send({
      model, maxTokens: MAX_TOKENS, system: CHAT_CONTRACT, prompt: promptFor(context, earlier, text, problems),
      schema: CHAT_SCHEMA, effort, trace: run, label: problems.length ? 'advisor-chat-retry' : 'advisor-chat',
    });
    let result = await ask([]);
    let report = asReport(result.data);
    let problems = checkReport(report, checks);
    let attempts = 1;
    if (problems.length) {
      attempts = 2;
      result = await ask(problems);
      report = asReport(result.data);
      problems = checkReport(report, checks);
    }
    if (findDashes(report).length) {
      report = stripDashes(report);
      problems = checkReport(report, checks);
    }
    const reply = { id: randomUUID(), created_at: now().toISOString(), role: 'claude', text: report.sections[0].body,
      physician: JSON.stringify(report.physicianDiscussion), weights: null, model: result.model, warnings: problems.length ? JSON.stringify(problems) : null };
    insert.run(reply);
    run.finish('ok', { attempts, warnings: problems.length, model: result.model });
    return { note: parse(note), reply: parse(reply) };
  } catch (err) {
    run.finish('error', { error: err.name });
    throw err;
  }
}
