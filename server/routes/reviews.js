// Weekly reviews (list, versions, status, run again), the prompt builder and prompt sections (moved from
// server/app.js, v3 Phase 2 step 2, docs/adr/0012). register(app, ctx) adds these routes; ctx is what buildApp shares
// with every route module (server/app.js).
import * as q from '../queries.js';
import { addDays, lastWeekEnd } from '../../metrics/stats.js';
import { loadGoals } from '../../metrics/load.js';
import { isUniqueViolation } from '../../db/dialect.ts';
import { GOALS as GOAL_LABELS } from '../public/goals.js';
import { MAX_ANSWER_CHARS, SECTION_KINDS, builderSpec, claudeDraft, templateDraft } from '../../agent/prompt-draft.js';
import { anyObject, idParams, sectionFields } from './schemas.js';

/** @param {import('fastify').FastifyInstance} app @param {object} ctx  shared state and helpers from buildApp */
export async function register(app, ctx) {
  const {
    aiAccessOf, aiOn, aiReason, authMode, clock, db, log, noAi, requireDate, reviewRunOf, services, syncing, uidOf,
    userStore,
  } = ctx;
  app.get('/api/reviews', { schema: { summary: 'Weekly reviews, newest first, each with its earlier versions (ids and dates)', response: { 200: { type: 'array', items: anyObject } } } },
    async () => await q.listReviews(db));
  app.get('/api/reviews/versions/:id', {
    schema: {
      summary: "An earlier version of a week's review, kept when the week was written again",
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => (await q.reviewVersion(db, req.params.id)) ?? reply.code(404).send({ error: 'No such earlier version' }));

  const reviewState = async (req) => {
    const status = await q.reviewStatus(db, q.localDate(clock()), clock());
    const access = typeof services.review === 'function' ? await aiAccessOf(req) : null;
    return {
      ...status,
      running: reviewRunOf(req).running,
      runningWeekEnd: reviewRunOf(req).running ? reviewRunOf(req).weekEnd ?? null : null,
      error: reviewRunOf(req).error,
      canRun: access !== null && access.source !== null,
      needsKey: access !== null && access.source === null,
      aiReason: access ? access.reason ?? null : null,
    };
  };

  app.get('/api/reviews/status', {
    schema: { summary: "Last week's review: whether it exists, the last run, and Apple Health days missing or partial (dates only)", response: { 200: anyObject } },
  }, async (req) => await reviewState(req));

  app.post('/api/reviews/run', {
    schema: {
      summary: "Write last week's review now, or write an earlier week's again (weekEnd; the review it replaces is kept as an earlier version). Syncs first; refused while Apple Health days are missing unless force. Returns 202 and runs in the background",
      body: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' }, weekEnd: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } },
      response: { 202: anyObject },
    },
  }, async (req, reply) => {
    if (typeof services.review !== 'function') return reply.code(503).send({ error: 'Writing reviews is not available in this server' });
    const access = await aiAccessOf(req);
    if (access.source === null) return noAi(reply, access.reason ?? null);
    const reviewRun = reviewRunOf(req);
    const uid = uidOf(req);
    if (reviewRun.running) return reply.code(409).send({ error: 'A review is already being written' });
    // An earlier week: a Saturday no later than last week's end, and one that already has a review to write again.
    const lastWeek = lastWeekEnd(q.localDate(clock()));
    const asked = req.body?.weekEnd ? requireDate(req.body.weekEnd) : null;
    if (asked !== null && asked !== lastWeek) {
      if (lastWeekEnd(addDays(asked, 1)) !== asked) return reply.code(400).send({ error: 'weekEnd must be a Saturday (the last day of a review week)' });
      if (asked > lastWeek) return reply.code(400).send({ error: 'That week has not ended yet' });
      if (!(await db.prepare('SELECT 1 AS found FROM reviews WHERE user_id = @uid AND week_ending = ?').get(asked))) {
        return reply.code(404).send({ error: 'No review for that week to write again' });
      }
    }
    reviewRun.running = true;
    reviewRun.error = null;
    try {
      if (services.sync && !syncing.has(uid)) {
        syncing.add(uid);
        try { await services.sync({ uid }); } catch { /* review the data already stored, as npm run review does */ } finally { syncing.delete(uid); }
      }
      // The data gate for the week asked (as of the Sunday after it, as jobs/review.js does for an explicit week).
      const status = await q.reviewStatus(db, asked && asked !== lastWeek ? addDays(asked, 1) : q.localDate(clock()), clock());
      if (!status.ready && !req.body?.force) {
        reviewRun.running = false;
        return reply.code(409).send({ error: status.reason === 'no_data' ? 'No data for that week yet' : 'Apple Health data is incomplete for the week', reason: status.reason, missingDays: status.missingDays, partialDays: status.partialDays });
      }
      reviewRun.weekEnd = status.weekEnd;
      services.review({ uid: uidOf(req), weekEnd: status.weekEnd, today: q.localDate(clock()) })
        .then(() => log.info(`[review] ok week ending ${status.weekEnd}`))
        .catch((err) => { reviewRun.error = err.name === 'Error' ? 'Review failed' : err.name; log.warn(`[review] failed week ending ${status.weekEnd}: ${err.name}`); })
        .finally(() => { reviewRun.running = false; });
      return reply.code(202).send({ started: true, weekEnd: status.weekEnd });
    } catch (err) {
      reviewRun.running = false;
      throw err;
    }
  });


  // ---- the Prompt tab's builder (agent/prompt-draft.js): guided questions, then a template or Claude's draft ----
  const draftTimes = new Map();
  app.get('/api/prompt/builder', { schema: { summary: 'The prompt builder: kinds of section with their questions, and whether Claude can draft', response: { 200: anyObject } } },
    async (req) => ({ kinds: builderSpec(), claude: typeof services.claude === 'function' && await aiOn(req), aiReason: typeof services.claude === 'function' ? await aiReason(req) : null }));
  app.post('/api/prompt/draft', {
    schema: {
      summary: 'Draft a prompt section from your answers: a template (no AI) or Claude with your AI (your answers only, never your data); nothing is saved',
      body: { type: 'object', additionalProperties: false, required: ['kind', 'answers'], properties: {
        kind: { type: 'string', enum: Object.keys(SECTION_KINDS) }, useClaude: { type: 'boolean' },
        answers: { type: 'object', maxProperties: 10, additionalProperties: { type: 'string', maxLength: MAX_ANSWER_CHARS } } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    if (authMode === 'demo') return reply.code(403).send({ error: 'Changes are turned off in the demo' });
    if (!req.body.useClaude) return templateDraft(req.body.kind, req.body.answers);
    if (typeof services.claude !== 'function') return reply.code(503).send({ error: 'Claude is not available in this server' });
    const reason = await aiReason(req);
    if (reason) return noAi(reply, reason);
    const uid = uidOf(req);
    const hourAgo = clock().getTime() - 3600_000;
    const recent = (draftTimes.get(uid) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= 20) return reply.code(429).send({ error: 'At most 20 drafts an hour; try again later' });
    draftTimes.set(uid, [...recent, clock().getTime()]);
    const g = await loadGoals(db);
    try {
      return await claudeDraft({ store: userStore(), claude: await services.claude(uid), kind: req.body.kind, answers: req.body.answers,
        goals: [g.primary, g.secondary].filter(Boolean).map((k) => GOAL_LABELS[k]), logger: { info() {}, warn() {}, error() {} } });
    } catch (err) {
      log.warn(`[prompt] draft failed: ${err.name}`);
      return reply.code(502).send({ error: 'Claude could not draft it just now; try again, or Build without AI' });
    }
  });

  // Your time zone: decides your "today", the review week and file times (tools/time.js). The owner's is OWNER_TZ.

  app.get('/api/prompt/sections', { schema: { summary: 'Prompt sections in order', response: { 200: { type: 'array', items: anyObject } } } },
    async () => await q.listSections(db));

  app.post('/api/prompt/sections', {
    schema: {
      summary: 'Add a prompt section',
      body: { type: 'object', additionalProperties: false, required: ['position', 'name', 'text'], properties: sectionFields },
      response: { 201: anyObject },
    },
  }, async (req, reply) => {
    try {
      return reply.code(201).send(await q.createSection(db, req.body));
    } catch (err) {
      if (isUniqueViolation(err)) throw Object.assign(new Error('A section with that name already exists'), { statusCode: 409 });
      throw err;
    }
  });

  app.put('/api/prompt/sections/:id', {
    schema: {
      summary: 'Edit a prompt section (the previous version is kept)',
      params: idParams,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: sectionFields },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    try {
      const section = await q.updateSection(db, req.params.id, req.body);
      return section ?? reply.code(404).send({ error: 'Section not found' });
    } catch (err) {
      if (isUniqueViolation(err)) throw Object.assign(new Error('A section with that name already exists'), { statusCode: 409 });
      throw err;
    }
  });

  app.delete('/api/prompt/sections/:id', { schema: { summary: 'Delete a prompt section (a copy is kept)', params: idParams } }, async (req, reply) => {
    if (!(await q.deleteSection(db, req.params.id))) return reply.code(404).send({ error: 'Section not found' });
    return reply.code(204).send();
  });

  app.get('/api/prompt/preview', { schema: { summary: 'The weekly review instructions as the model would receive them', response: { 200: anyObject } } },
    async () => await q.previewInstructions(db, q.localDate(clock())));
}
