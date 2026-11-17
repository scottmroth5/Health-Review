// Activity (runs, jobs, status), spend, sync now, and Help (moved from server/app.js, v3 Phase 2 step 2,
// docs/adr/0012). register(app, ctx) adds these routes; ctx is what buildApp shares with every route module
// (server/app.js).
import * as q from '../queries.js';
import { OWNER_ID } from '../../db/users.ts';
import { askHelp, MAX_QUESTION_CHARS } from '../../agent/help.js';
import { anyObject, idParams, badRequest } from './schemas.js';

/** @param {import('fastify').FastifyInstance} app @param {object} ctx  shared state and helpers from buildApp */
export async function register(app, ctx) {
  const {
    NO_AI, aiOn, aiReason, appUrl, authMode, clock, db, demoAnalytics, evalDir, ingest, instance, isPaused, log, noAi,
    price, requestAccessUrl, schedule, services, support, syncing, uidOf, userStore,
  } = ctx;
  // ---- activity ----
  app.get('/api/runs', {
    schema: {
      summary: 'Recent syncs, reviews and other runs, newest first (metadata only)',
      querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } },
      response: { 200: { type: 'array', items: anyObject } },
    },
  }, async (req) => await q.listRuns(db, req.query.limit));

  app.get('/api/runs/:id', {
    schema: { summary: 'One run with its counts and Claude calls (metadata only)', params: idParams, response: { 200: anyObject } },
  }, async (req, reply) => (await q.getRun(db, req.params.id)) ?? reply.code(404).send({ error: 'Run not found' }));

  app.get('/api/jobs', {
    schema: {
      summary: "Each scheduled job's last runs (sync, review, backup, restore test) and the last Health Auto Export posts: status, times and counts only",
      response: { 200: anyObject },
    },
  }, async () => ({ ...(await q.jobsActivity(db)), schedule: schedule() }));

  app.get('/api/status', { schema: { summary: 'Today, the last sync, and data check warnings as of today (stale or missing Apple Health days, partial days, impossible values)', response: { 200: anyObject } } }, async () => {
    const today = q.localDate(clock());
    return { today, instance, readOnly: authMode === 'demo', sync: typeof services.sync === 'function', lastSync: await q.lastSync(db), dataChecks: await q.dataCheckWarnings(db, today, { apple: ingest.apple ?? 'drive', now: clock() }),
      // The demo's "Request access" link to the main app (REQUEST_ACCESS_URL; none when unset).
      ...(authMode === 'demo' && requestAccessUrl ? { requestAccessUrl } : {}),
      // The demo's anonymous visit counts (DEMO_ANALYTICS_TOKEN; none when unset, and never outside the demo).
      ...(demoAnalytics ? { analytics: demoAnalytics } : {}),
      // The published support address, for Help and the demo's Request access card.
      supportEmail: support };
  });


  // ---- spend ----
  app.get('/api/spend', {
    schema: { summary: 'Estimated Claude API spend by month and year (reviews, chat, evals) at list prices', response: { 200: anyObject } },
  }, async (req) => await q.spend(db, { evalDir: uidOf(req) === OWNER_ID ? evalDir : null, price, today: q.localDate(clock()) }));

  // ---- sync ----
  app.post('/api/sync', { schema: { summary: 'Copy new rows from the Google Sheets now', response: { 200: anyObject } } }, async (req, reply) => {
    if (!services.sync) return reply.code(503).send({ error: 'Sync is not available in this server' });
    if (await isPaused(req)) return reply.code(403).send({ error: NO_AI.paused });
    const uid = uidOf(req);
    if (syncing.has(uid)) return reply.code(409).send({ error: 'A sync is already running' });
    syncing.add(uid);
    try {
      const { counts, warnings } = await services.sync({ uid: uidOf(req) });
      log.info(`[sync] ok ${JSON.stringify(counts)} warnings=${warnings.length}`);
      return { counts, warnings: warnings.length };
    } finally {
      syncing.delete(uid);
    }
  });


  // ---- help (phase 6): the guides, and Ask on the user's own AI (the guides and the question only, never their data) ----
  const asks = new Map(); // uid -> times of this hour's questions
  const ASKS_PER_HOUR = 20;
  app.get('/api/help', { schema: { summary: 'Whether Ask is on for you, and why not', response: { 200: anyObject } } },
    async (req) => ({ ask: typeof services.claude === 'function' && await aiOn(req), aiReason: typeof services.claude === 'function' ? await aiReason(req) : null }));
  app.post('/api/help/ask', {
    schema: { summary: 'Ask a question about using the app (answered from the guides with your AI; nothing of your data is sent or the answer kept)',
      body: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_CHARS } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    if (typeof services.claude !== 'function') return reply.code(503).send({ error: 'Ask is not available in this server' });
    const reason = await aiReason(req);
    if (reason) return noAi(reply, reason);
    const question = req.body.question.trim();
    if (!question) throw badRequest('question must not be blank');
    const uid = uidOf(req);
    const hourAgo = clock().getTime() - 3600_000;
    const recent = (asks.get(uid) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= ASKS_PER_HOUR) return reply.code(429).send({ error: `At most ${ASKS_PER_HOUR} questions an hour; try again later` });
    asks.set(uid, [...recent, clock().getTime()]);
    try {
      return await askHelp({ store: userStore(), claude: await services.claude(uid), question, site: appUrl(), logger: { info() {}, warn() {}, error() {} } });
    } catch (err) {
      log.warn(`[help] ask failed: ${err.name}`);
      return reply.code(502).send({ error: 'Claude could not answer just now; try again' });
    }
  });
}
