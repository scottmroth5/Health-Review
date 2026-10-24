// The Health Review API and UI. Every route has a JSON schema; /api/openapi.json is the contract
// the UI (and any future backend) follows.
import { existsSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth.js';
import { registerSecurityHeaders, registerRateLimits, errorReply, DEMO_REQUEST_LIMIT } from './security.js';
import * as q from './queries.js';
import { TIMINGS } from '../metrics/medications.js';
import { VIEWS } from '../metrics/volume.js';
import { VO2_VIEWS } from '../metrics/vo2max.js';
import { repoPath } from '../tools/paths.js';
import { loadCatalog } from '../metrics/catalog.js';
import { loadDictionary } from '../metrics/dictionary.js';
import { loadSubstitutions, loadTargets, loadProfile } from '../metrics/load.js';
import { loadTargetConfig } from '../metrics/targets.js';
import { loadLabRanges } from '../metrics/labs.js';
import { GOALS, MAX_WEIGHT } from '../metrics/advisor.js';
import { currentProgram } from '../ingest/program-blocks.js';
import { askAdvisor, clearChat, deleteChatNote, listChat, MAX_NOTE_CHARS } from '../agent/advisor-chat.js';
// agent-core prices calls but does not export its price table yet; import it by path until a release exports it.
import { costFromUsage } from '../node_modules/@scottmroth5/agent-core/src/pricing.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRateLimiter } from './security.js';
import { parseHealthJson } from '../ingest/health-json.js';
import { parseWorkoutJson } from '../ingest/parsers.js';
import { applyHealthDays, applyWorkouts } from '../ingest/apply.js';
import { localStamp } from '../tools/time.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { scopeDb } from '../db/scope.js';
import { OWNER_ID, getUser, setClaudeKey, syncOwnerEmail, userByEmail } from '../db/users.js';
import { createPendingUser, listUsers, setUserStatus } from './admin-queries.js';
import { createMailer } from '../tools/mail.js';
import { boxKey, seal } from '../tools/secret-box.js';
import { addDefaultPromptSections } from '../agent/default-prompts.js';
import { policyPage } from './pages.js';

/** Checks a Claude API key with Anthropic's free model list (the key goes only to Anthropic; nothing is logged). */
export async function anthropicKeyCheck(key) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    return r.ok;
  } catch {
    return false;
  }
}

/** Health Auto Export's posts: the largest daily workout file is about 165 KB, so 5 MB holds weeks of them. */
export const INGEST_BODY_LIMIT = 5 * 1024 * 1024;
export const INGEST_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 30 };

const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
const scale = nullable({ type: 'integer', minimum: 1, maximum: 10 });
const count = { type: 'integer', minimum: 0, maximum: 50 };
const text = (maxLength) => nullable({ type: 'string', maxLength });
const anyObject = { type: 'object', additionalProperties: true };
const dateParams = { type: 'object', required: ['date'], properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

const checkinBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(q.SCALE_FIELDS.map((f) => [f, scale])),
    weight_lbs: nullable({ type: 'number', minimum: 50, maximum: 700 }),
    body_fat_pct: nullable({ type: 'number', minimum: 1, maximum: 75 }),
    muscle_mass_lbs: nullable({ type: 'number', minimum: 20, maximum: 400 }),
    visceral_fat: nullable({ type: 'number', minimum: 1, maximum: 59 }),
    notes: text(2000),
  },
};

const drinkingBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(q.DRINK_COUNT_FIELDS.map((f) => [f, count])),
    setting: text(200),
    mood_before: scale,
    mood_after: scale,
    notes: text(2000),
  },
};

const sectionFields = {
  position: { type: 'integer', minimum: 0, maximum: 999 },
  name: { type: 'string', minLength: 1, maxLength: 60, pattern: '^[A-Za-z0-9 _-]+$' },
  text: { type: 'string', maxLength: 50000 },
  sensitive: { type: 'boolean' },
};

const VERSION = JSON.parse(readFileSync(repoPath('package.json'), 'utf8')).version;

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * @param {object} ctx
 * @param {{ db: import('better-sqlite3').Database }} ctx.store
 * @param {{ sync?: () => Promise<object>, claude?: () => { send: Function }, review?: (o: { weekEnd: string, today: string }) => Promise<object> }} [ctx.services]
 *   claude: the chat's client, made on first use; review: writes and saves one weekly review (the manual run)
 * @param {'main'|'demo'} [ctx.instance]  'demo' marks the made-up-data instance (the UI shows a banner)
 * @param {{ chat?: boolean }} [ctx.features]  chat false turns the Next program chat off (the demo instance)
 * @param {string} [ctx.publicDir]   static UI to serve; skipped when missing
 * @param {string} [ctx.authMode]  none (default), google or demo (server/auth.js)
 * @param {{ settings?: object, exchange?: Function, now?: () => number }} [ctx.auth]  google mode's settings (authSettings) and,
 *   in tests, a fake Google exchange
 * @param {{ token?: string|null, apple?: 'drive'|'rest' }} [ctx.ingest]  INGEST_TOKEN for POST /api/ingest/* (none: those
 *   routes answer 503) and where Apple data comes from (APPLE_SOURCE), which the "export stopped" check follows
 * @param {boolean|number|string} [ctx.trustProxy]  Fastify trustProxy: set behind Caddy so req.ip is the client's address
 * @param {() => Date} [ctx.clock]
 * @param {{ info: Function, warn: Function }} [ctx.log]  one line per event on stdout (counts and names only; never health,
 *   prompt or report text), so docker compose logs shows what ran
 * @param {string|null} [ctx.evalDir]  the review eval's results folder, priced into GET /api/spend (main instance only)
 */
export async function buildApp({ store, services = {}, publicDir, authMode = 'none', auth = {}, ingest = {}, trustProxy = false, clock = () => new Date(), logger = false, log = console, schedule = () => [], catalog, dictionary, substitutions, features = {}, instance = 'main', evalDir = null, price = costFromUsage, targetConfig, labRanges, mailer = createMailer({ env: {} }), keyCheck = anthropicKeyCheck, keyBox }) {
  const app = Fastify({ logger, trustProxy });
  // Every route's method and path, so tests can check each write route (demo mode refuses them all).
  const routeList = [];
  app.addHook('onRoute', (r) => { for (const method of [r.method].flat()) routeList.push({ method, url: r.url }); });
  app.decorate('routeList', routeList);
  // Every request runs as one user (multi-user, phase 1): `db` below is that user's view of the database (db/scope.js),
  // set for the request in preHandler. Local (none) and the demo are the owner; google mode is the signed-in user, and a
  // request without one (open routes) has no database at all, so nothing can read across users by mistake.
  const requestDb = new AsyncLocalStorage();
  const currentDb = () => {
    const scoped = requestDb.getStore();
    if (!scoped) throw new Error('No user for this request');
    return scoped;
  };
  const db = new Proxy({}, { get: (_, prop) => Reflect.get(currentDb(), prop) });
  // The store as the request's user sees it, for code that takes a store (the chat); tx is the shared one.
  const userStore = () => ({ ...store, db: currentDb() });
  const uidOf = (req) => req.uid ?? (authMode === 'google' ? null : OWNER_ID);
  let syncing = false;
  // The manual review run: one at a time, in the background; the last failure is kept as its error name only.
  const reviewRun = { running: false, weekEnd: null, error: null };

  await app.register(swagger, {
    openapi: { info: { title: 'Health Review API', version: '1.0.0', description: 'Local health tracking and weekly review' } },
  });
  // Security headers always; rate limits once the server can be reached from outside (sign-in, refused requests, and every
  // request in the public demo); then the sign-in check (server/auth.js).
  registerSecurityHeaders(app, { https: String(auth.settings?.publicUrl ?? '').startsWith('https://') });
  if (authMode !== 'none') registerRateLimits(app, { all: authMode === 'demo' ? DEMO_REQUEST_LIMIT : null, now: auth.now });
  // Google sign-in maps an address to its users row; the first allowed address is the owner (user 1) until registration.
  if (authMode === 'google' && auth.settings?.allowed?.[0]) syncOwnerEmail(store.db, { OWNER_EMAIL: auth.settings.allowed[0] });
  const adminEmail = () => process.env.ADMIN_EMAIL || getUser(store.db, OWNER_ID)?.email;
  const appUrl = () => auth.settings?.publicUrl || 'http://localhost:5188';
  // A registration: a pending user, and an email to the admin (names and addresses only).
  const registerUser = async ({ email, name }) => {
    if (userByEmail(store.db, email)) return;
    createPendingUser(store.db, { id: randomUUID(), email, name });
    log.info('[users] new registration');
    await mailer.send({ to: adminEmail(), subject: 'New Health Review registration',
      text: `${name ?? 'Someone'} <${email}> asked for access to Health Review.\n\nApprove or reject on the Users tile: ${appUrl()}/#users\n` });
  };
  registerAuth(app, { mode: authMode, settings: auth.settings, exchange: auth.exchange, now: auth.now, findUser: (email) => userByEmail(store.db, email), registerUser });
  // The privacy policy and terms, readable before signing in.
  app.get('/privacy', { schema: { hide: true } }, async (req, reply) => reply.type('text/html').send(policyPage('PRIVACY.md')));
  app.get('/terms', { schema: { hide: true } }, async (req, reply) => reply.type('text/html').send(policyPage('TERMS.md')));
  app.addHook('preHandler', (req, reply, done) => {
    const uid = uidOf(req);
    if (!uid) return done();
    requestDb.run(scopeDb(store.db, uid), done);
  });

  // The deploy health check: open in every mode, status and version only.
  app.get('/api/health', {
    schema: { summary: 'Health check for the deploy (no sign-in needed): status and version only', response: { 200: { type: 'object', properties: { status: { type: 'string' }, version: { type: 'string' } } } } },
  }, async () => ({ status: 'ok', version: VERSION }));

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = errorReply(err, req);
    reply.code(status).send(body);
  });

  const requireDate = (date) => {
    if (!q.isValidDate(date)) throw badRequest(`Not a real date: ${date}`);
    return date;
  };
  const requireNotFuture = (date) => {
    if (date > q.localDate(clock())) throw badRequest('Entries cannot be dated in the future');
    return date;
  };

  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // ---- activity ----
  app.get('/api/runs', {
    schema: {
      summary: 'Recent syncs, reviews and other runs, newest first (metadata only)',
      querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } },
      response: { 200: { type: 'array', items: anyObject } },
    },
  }, async (req) => q.listRuns(db, req.query.limit));

  app.get('/api/runs/:id', {
    schema: { summary: 'One run with its counts and Claude calls (metadata only)', params: idParams, response: { 200: anyObject } },
  }, async (req, reply) => q.getRun(db, req.params.id) ?? reply.code(404).send({ error: 'Run not found' }));

  app.get('/api/jobs', {
    schema: {
      summary: "Each scheduled job's last runs (sync, review, backup, restore test) and the last Health Auto Export posts: status, times and counts only",
      response: { 200: anyObject },
    },
  }, async () => ({ ...q.jobsActivity(db), schedule: schedule() }));

  app.get('/api/status', { schema: { summary: 'Today, the last sync, and data check warnings as of today (stale or missing Apple Health days, partial days, impossible values)', response: { 200: anyObject } } }, async () => {
    const today = q.localDate(clock());
    return { today, instance, readOnly: authMode === 'demo', sync: typeof services.sync === 'function', lastSync: q.lastSync(db), dataChecks: q.dataCheckWarnings(db, today, { apple: ingest.apple ?? 'drive', now: clock() }) };
  });

  // ---- one day ----
  app.get('/api/days/:date', { schema: { summary: 'Check-in and drinks for a day', params: dateParams, response: { 200: anyObject } } },
    async (req) => q.getDay(db, requireDate(req.params.date)));

  app.put('/api/checkins/:date', { schema: { summary: 'Save a daily check-in', params: dateParams, body: checkinBody, response: { 200: anyObject } } },
    async (req) => {
      const date = requireNotFuture(requireDate(req.params.date));
      const hasValue = Object.entries(req.body).some(([, v]) => v !== null && v !== '' && v !== undefined);
      if (!hasValue) throw badRequest('Nothing to save: fill in at least one field, or delete the check-in');
      return q.saveCheckin(db, date, req.body);
    });

  app.delete('/api/checkins/:date', { schema: { summary: 'Delete a check-in', params: dateParams } }, async (req, reply) => {
    if (!q.deleteCheckin(db, requireDate(req.params.date))) return reply.code(404).send({ error: 'No check-in for that day' });
    return reply.code(204).send();
  });

  app.put('/api/drinking/:date', { schema: { summary: 'Save drinks for a day (all zeros means no drinks)', params: dateParams, body: drinkingBody, response: { 200: anyObject } } },
    async (req) => q.saveDrinking(db, requireNotFuture(requireDate(req.params.date)), req.body));

  app.delete('/api/drinking/:date', { schema: { summary: 'Delete a drinking day', params: dateParams } }, async (req, reply) => {
    if (!q.deleteDrinking(db, requireDate(req.params.date))) return reply.code(404).send({ error: 'No drinks logged for that day' });
    return reply.code(204).send();
  });

  // ---- training volume ----
  app.get('/api/training', {
    schema: {
      summary: 'Training volume (reps x total load) for the last 7 days, 30 days, 52 weeks, or all history',
      querystring: { type: 'object', required: ['view'], properties: { view: { type: 'string', enum: VIEWS } } },
      response: { 200: anyObject },
    },
  }, async (req) => q.trainingDashboard(db, req.query.view, q.localDate(clock())));

  // The MAPS catalog is read per request when not injected, so edits to data/maps/programs.json show without a restart.
  // The program catalog a request may use: the owner's (MAPS) for the owner and for users the owner shares it with
  // (users.maps_shared); others have none until they add their own (multi-user, phase 5).
  const ownerCatalog = () => (catalog === undefined ? loadCatalog() : catalog);
  const programCatalog = (req) => {
    const uid = uidOf(req);
    return uid === OWNER_ID || getUser(store.db, uid)?.maps_shared ? ownerCatalog() : null;
  };
  app.get('/api/program', {
    schema: {
      summary: 'The confirmed in-progress program block: week, phase, deload or failure week, expected end (program is null when none)',
      response: { 200: { type: 'object', properties: { program: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] } } } },
    },
  }, async (req) => ({ program: currentProgram(db, q.localDate(clock()), programCatalog(req)) }));

  // The dictionary and substitutions are committed config, read per request (like the catalog) unless injected.
  const goalWeight = { type: 'integer', minimum: 0, maximum: MAX_WEIGHT, default: 1 };
  app.get('/api/advisor', {
    schema: {
      summary: 'Program Advisor ranking for the next block: goal scores (0 to 1), total, reasons and flags per program; '
        + 'weights 0 to 3 per goal (default 1) change the total; available false without the MAPS catalog',
      querystring: { type: 'object', properties: Object.fromEntries(GOALS.map((g) => [g, goalWeight])) },
      response: { 200: anyObject },
    },
  }, async (req) => q.advisor(db, q.localDate(clock()), {
    catalog: programCatalog(req),
    dictionary: dictionary ?? loadDictionary(),
    substitutions: substitutions ?? loadSubstitutions(),
    weights: Object.fromEntries(GOALS.map((g) => [g, req.query[g]])),
  }));

  app.get('/api/program/adherence', {
    schema: {
      summary: 'What the program calls for against what was logged, per lifting day of a confirmed block (default: the one in progress, else the latest): '
        + 'each exercise as called for, swapped, changed, skipped or added, sets, the usual changes, and the blocks to choose from; available false without the MAPS catalog',
      querystring: { type: 'object', properties: { block: { type: 'string', minLength: 1, maxLength: 64 } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    const result = q.programAdherence(db, q.localDate(clock()), {
      catalog: programCatalog(req), dictionary: dictionary ?? loadDictionary(), substitutions: substitutions ?? loadSubstitutions(), blockId: req.query.block,
    });
    if (result === null) return reply.code(404).send({ error: 'No such confirmed block' });
    return result;
  });

  // ---- Next program chat (computed training facts and the owner's notes go to Claude; see agent/advisor-chat.js) ----
  // AI per user: the owner's key, a user's own key, or none (then no AI, and the screens say so).
  const aiOn = (req) => (services.hasAi ? services.hasAi(uidOf(req)) : true);
  const chatOn = (req) => features.chat !== false && typeof services.claude === 'function' && aiOn(req);
  const needsKey = (req) => !aiOn(req);
  const chatThread = { 200: { type: 'object', properties: { enabled: { type: 'boolean' }, needsKey: { type: 'boolean' }, notes: { type: 'array', items: anyObject } } } };
  app.get('/api/advisor/chat', { schema: { summary: 'The Next program chat thread, oldest first, and whether the chat is on', response: chatThread } },
    async (req) => ({ enabled: chatOn(req), needsKey: needsKey(req), notes: listChat(db) }));
  let chatting = false;
  app.post('/api/advisor/chat', {
    schema: {
      summary: 'Ask Claude about the next program: saves the note, sends computed training facts plus the note and recent thread, saves the checked reply',
      body: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_NOTE_CHARS },
          weights: { type: 'object', additionalProperties: false, properties: Object.fromEntries(GOALS.map((g) => [g, { type: 'integer', minimum: 0, maximum: MAX_WEIGHT }])) },
        },
      },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    if (needsKey(req)) return reply.code(503).send({ error: 'No AI is used until you add your Claude API key in Settings', needsKey: true });
    if (!chatOn(req)) return reply.code(503).send({ error: 'The chat is off in this instance' });
    if (!req.body.text.trim()) throw badRequest('text must not be blank');
    if (chatting) return reply.code(409).send({ error: 'A question is already being answered' });
    const cat = programCatalog(req);
    if (!cat) return reply.code(503).send({ error: 'The chat needs a program catalog' });
    chatting = true;
    try {
      return await askAdvisor({
        store: userStore(), claude: services.claude(uidOf(req)), text: req.body.text.trim(), today: q.localDate(clock()), catalog: cat,
        dictionary: dictionary ?? loadDictionary(), substitutions: substitutions ?? loadSubstitutions(), weights: req.body.weights,
        logger: { info() {}, warn() {}, error() {} },
      });
    } finally {
      chatting = false;
    }
  });
  app.delete('/api/advisor/chat/:id', {
    schema: { summary: 'Delete one note or reply from the thread', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } }, response: { 200: anyObject } },
  }, async (req, reply) => (deleteChatNote(db, req.params.id) ? { deleted: 1 } : reply.code(404).send({ error: 'Not found' })));
  app.delete('/api/advisor/chat', { schema: { summary: 'Clear the whole thread', response: { 200: anyObject } } },
    async () => ({ deleted: clearChat(db) }));

  app.get('/api/lifts', {
    schema: {
      summary: 'Plateau status of each primary lift (last 42 days against the 84 before, within one rep range), with trend points',
      response: { 200: { type: 'array', items: anyObject } },
    },
  }, async () => q.lifts(db, q.localDate(clock())));

  app.get('/api/vo2max', {
    schema: {
      summary: 'VO2 max readings (90 days, 1 year) or weekly and monthly averages (2 years, 5 years, all), with latest, changes and best',
      querystring: { type: 'object', required: ['view'], properties: { view: { type: 'string', enum: VO2_VIEWS } } },
      response: { 200: anyObject },
    },
  }, async (req) => q.vo2max(db, req.query.view, q.localDate(clock())));

  app.get('/api/cardio-zones', {
    schema: {
      summary: 'Cardio minutes by heart rate zone over 30 days, 90 days or 1 year, by day, week (Sunday to Saturday) or calendar month (default: days for 30d and 90d, weeks for 1y): minutes per zone from per-minute heart rate, minutes with no heart rate detail, and the zone bounds',
      querystring: { type: 'object', required: ['view'], properties: { view: { type: 'string', enum: Object.keys(q.CARDIO_ZONE_VIEWS) }, group: { type: 'string', enum: q.CARDIO_ZONE_GROUPS } } },
      response: { 200: anyObject },
    },
  }, async (req) => q.cardioZoneView(db, req.query.view, q.localDate(clock()), req.query.group));

  // ---- Health Auto Export REST ingest (the server: APPLE_SOURCE=rest) ----
  // Open to the internet without a Google session (server/auth.js), so each post carries Authorization: Bearer
  // INGEST_TOKEN, compared in constant time. JSON only, 5 MB at most, 30 posts per 15 minutes per address. The data goes
  // through the same parsers and writers as the Drive files (ingest/apply.js); ingest_log keeps metadata only.
  const ingestLimiter = createRateLimiter(INGEST_RATE_LIMIT);
  const tokenHash = ingest.token ? createHash('sha256').update(ingest.token).digest() : null;
  const ingestGuard = async (req, reply) => {
    if (!tokenHash) return reply.code(503).send({ error: 'Ingest is not set up on this server (INGEST_TOKEN).' });
    const r = ingestLimiter.hit(req.ip);
    if (!r.allowed) return reply.code(429).header('retry-after', String(r.retryAfterSeconds)).send({ error: 'Too many posts from this address. Try again later.' });
    const given = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    if (!timingSafeEqual(createHash('sha256').update(given).digest(), tokenHash)) return reply.code(401).send({ error: 'Missing or wrong ingest token.' });
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return reply.code(415).send({ error: 'Send JSON (Content-Type: application/json).' });
    // INGEST_TOKEN is the owner's (each user's own token comes with per-user feeds, phase 3).
    req.uid = OWNER_ID;
  };
  const logIngest = (...values) => db.prepare('INSERT INTO ingest_log (user_id, id, received_at, route, result, counts, error) VALUES (@uid, ?, ?, ?, ?, ?, ?)').run(...values);
  const ingestRoute = (route, summary, apply) => app.post(`/api/ingest/${route}`, {
    bodyLimit: INGEST_BODY_LIMIT,
    onRequest: ingestGuard,
    schema: { summary, body: { type: 'object' }, response: { 200: anyObject } },
  }, async (req, reply) => {
    const received = clock();
    try {
      const counts = apply(req.body, received);
      logIngest(randomUUID(), received.toISOString(), route, 'ok', JSON.stringify(counts), null);
      log.info(`[ingest] ${route} ok ${JSON.stringify(counts)}`);
      return { ok: true, ...counts };
    } catch (err) {
      logIngest(randomUUID(), received.toISOString(), route, 'error', null, err.name);
      log.warn(`[ingest] ${route} error ${err.name}`);
      return reply.code(400).send({ error: err.message });
    }
  });
  ingestRoute('health', "Health Auto Export's health metrics (JSON, Version 2, grouped by day; Apple Stand Hour grouped by hour), stored like the Drive files", (body, received) => {
    const parsed = parseHealthJson(body, { file: 'post' });
    const at = localStamp(received); // received now: a day posted before it ended is partial
    let result;
    store.tx(() => {
      result = applyHealthDays(db, { records: parsed.records, exportedThrough: new Map(parsed.records.map((r) => [r.date, at])), standHours: parsed.standHours }, received.toISOString());
    });
    return { days: result.days.length, standHours: parsed.standHours.length, warnings: parsed.warnings.length };
  });
  ingestRoute('workouts', "Health Auto Export's workouts (JSON, Version 2, with per-minute heart rate), stored like the Drive files", (body, received) => {
    const parsed = parseWorkoutJson(body, { file: 'post' });
    store.tx(() => applyWorkouts(db, parsed.records, parsed.samples, received.toISOString()));
    return { workouts: parsed.records.length, hrSamples: parsed.samples.length, warnings: parsed.warnings.length };
  });

  // ---- history, reviews ----
  app.get('/api/history', {
    schema: {
      summary: 'Daily metrics, check-ins and drinks between two dates',
      querystring: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
      response: { 200: anyObject },
    },
  }, async (req) => {
    const { from, to } = req.query;
    requireDate(from);
    requireDate(to);
    if (from > to) throw badRequest('from must not be after to');
    return q.history(db, from, to);
  });

  app.get('/api/reviews', { schema: { summary: 'Weekly reviews, newest first', response: { 200: { type: 'array', items: anyObject } } } },
    async () => q.listReviews(db));

  const reviewState = (req) => ({
    ...q.reviewStatus(db, q.localDate(clock()), clock()),
    running: reviewRun.running,
    error: reviewRun.error,
    canRun: typeof services.review === 'function' && aiOn(req),
    needsKey: typeof services.review === 'function' && !aiOn(req),
  });

  app.get('/api/reviews/status', {
    schema: { summary: "Last week's review: whether it exists, the last run, and Apple Health days missing or partial (dates only)", response: { 200: anyObject } },
  }, async (req) => reviewState(req));

  app.post('/api/reviews/run', {
    schema: {
      summary: "Write last week's review now (syncs first; refused while Apple Health days are missing unless force). Returns 202 and runs in the background",
      body: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } },
      response: { 202: anyObject },
    },
  }, async (req, reply) => {
    if (typeof services.review !== 'function') return reply.code(503).send({ error: 'Writing reviews is not available in this server' });
    if (!aiOn(req)) return reply.code(503).send({ error: 'No AI is used until you add your Claude API key in Settings', needsKey: true });
    if (reviewRun.running) return reply.code(409).send({ error: 'A review is already being written' });
    reviewRun.running = true;
    reviewRun.error = null;
    try {
      if (services.sync && !syncing) {
        syncing = true;
        try { await services.sync({ uid: uidOf(req) }); } catch { /* review the data already stored, as npm run review does */ } finally { syncing = false; }
      }
      const status = q.reviewStatus(db, q.localDate(clock()), clock());
      if (!status.ready && !req.body?.force) {
        reviewRun.running = false;
        return reply.code(409).send({ error: 'Apple Health data is incomplete for the week', missingDays: status.missingDays, partialDays: status.partialDays });
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

  // ---- spend ----
  app.get('/api/spend', {
    schema: { summary: 'Estimated Claude API spend by month and year (reviews, chat, evals) at list prices', response: { 200: anyObject } },
  }, async (req) => q.spend(db, { evalDir: uidOf(req) === OWNER_ID ? evalDir : null, price, today: q.localDate(clock()) }));

  // ---- sync ----
  app.post('/api/sync', { schema: { summary: 'Copy new rows from the Google Sheets now', response: { 200: anyObject } } }, async (req, reply) => {
    if (!services.sync) return reply.code(503).send({ error: 'Sync is not available in this server' });
    if (syncing) return reply.code(409).send({ error: 'A sync is already running' });
    syncing = true;
    try {
      const { counts, warnings } = await services.sync({ uid: uidOf(req) });
      log.info(`[sync] ok ${JSON.stringify(counts)} warnings=${warnings.length}`);
      return { counts, warnings: warnings.length };
    } finally {
      syncing = false;
    }
  });

  // ---- medications and supplements ----
  const dateField = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
  const timings = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: TIMINGS } };
  const dose = text(100);
  // An item lists its ingredients instead of one dose (a compounded pill, a blend); never both.
  const ingredients = nullable({
    type: 'array', minItems: 1, maxItems: 20,
    items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, dose: text(100) } },
  });
  const medDetails = {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    kind: { type: 'string', enum: ['medication', 'supplement'] },
    purpose: text(200),
    notes: text(1000),
    prescribed: { type: 'boolean' },
  };
  const medList = { 200: { type: 'array', items: anyObject } };
  const pastDate = (d) => requireNotFuture(requireDate(d));

  app.get('/api/medications', { schema: { summary: 'Medications and supplements: current first, then stopped', response: medList } },
    async () => q.listMedications(db));

  app.post('/api/medications', {
    schema: {
      summary: 'Add a medication or supplement (a stop date records a past course)',
      body: {
        type: 'object', additionalProperties: false, required: ['name', 'kind', 'timings', 'started_on'],
        properties: {
          ...medDetails, dose, ingredients, timings, started_on: dateField, stopped_on: nullable(dateField), stop_reason: text(200),
          start_estimated: { type: 'boolean', description: 'Real start unknown: taken since at least started_on, with no start event' },
        },
      },
      response: { 201: anyObject },
    },
  }, async (req, reply) => {
    pastDate(req.body.started_on);
    if (req.body.stopped_on) pastDate(req.body.stopped_on);
    return reply.code(201).send(q.addMedication(db, req.body));
  });

  app.put('/api/medications/:id', {
    schema: { summary: 'Edit name, type, purpose, prescribed or notes', params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: medDetails }, response: { 200: anyObject } },
  }, async (req) => q.updateMedicationDetails(db, req.params.id, req.body));

  app.post('/api/medications/:id/changes', {
    schema: {
      summary: 'Change dose or timing from a date (starts a new period), or correct the current one in place',
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, required: ['timings'],
        properties: {
          dose, ingredients, timings, effective_on: dateField,
          correction: { type: 'boolean', description: 'Fix a mistake in the current dose or timing; no change is recorded' },
        },
      },
      response: { 200: anyObject },
    },
  }, async (req) => q.changeMedication(db, req.params.id, {
    ...req.body,
    effective_on: req.body.effective_on ? pastDate(req.body.effective_on) : undefined,
  }));

  app.post('/api/medications/:id/stop', {
    schema: {
      summary: 'Stop taking it',
      params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['stopped_on'], properties: { stopped_on: dateField, reason: text(200) } },
      response: { 200: anyObject },
    },
  }, async (req) => q.stopMedication(db, req.params.id, { ...req.body, stopped_on: pastDate(req.body.stopped_on) }));

  app.post('/api/medications/:id/start', {
    schema: {
      summary: 'Start taking it again',
      params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['timings', 'started_on'], properties: { dose, ingredients, timings, started_on: dateField } },
      response: { 200: anyObject },
    },
  }, async (req) => q.startMedication(db, req.params.id, { ...req.body, started_on: pastDate(req.body.started_on) }));

  app.post('/api/medications/combine', {
    schema: {
      summary: 'Combine items taken as one pill into one item with ingredients, for past history and from now on (preview: the plan, nothing changed)',
      body: {
        type: 'object', additionalProperties: false, required: ['ids', 'name', 'timing'],
        properties: {
          ids: { type: 'array', minItems: 2, maxItems: 20, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
          name: { type: 'string', minLength: 1, maxLength: 100 },
          timing: { type: 'string', enum: TIMINGS },
          preview: { type: 'boolean' },
        },
      },
      response: { 200: anyObject },
    },
  }, async (req) => q.combineMedications(db, req.body));

  app.delete('/api/medications/:id', { schema: { summary: 'Remove an entry added by mistake, with all its history', params: idParams } }, async (req, reply) => {
    if (!q.deleteMedication(db, req.params.id)) return reply.code(404).send({ error: 'Medication not found' });
    return reply.code(204).send();
  });

  app.put('/api/doses/:date', {
    schema: {
      summary: "Save the day's check-off: every listed slot is recorded taken or not, with optional one-day dose and slot adjustments",
      params: dateParams,
      body: {
        type: 'object', additionalProperties: false, required: ['doses'],
        properties: {
          doses: {
            type: 'array', maxItems: 200,
            items: {
              type: 'object', additionalProperties: false, required: ['medication_id', 'timing', 'taken'],
              properties: {
                medication_id: { type: 'integer', minimum: 1 }, timing: { type: 'string', enum: TIMINGS }, taken: { type: 'boolean' },
                // One-day adjustments (null or absent: the default from the Meds tab).
                dose: { type: ['string', 'null'], maxLength: 100 }, moved_to: { type: ['string', 'null'], enum: [...TIMINGS, null] },
              },
            },
          },
        },
      },
      response: { 200: anyObject },
    },
  }, async (req) => q.saveDoses(db, pastDate(req.params.date), req.body.doses));

  app.delete('/api/doses/:date', { schema: { summary: "Clear the day's check-off (back to not logged)", params: dateParams } }, async (req, reply) => {
    if (!q.clearDoses(db, requireDate(req.params.date))) return reply.code(404).send({ error: 'Nothing saved for that day' });
    return reply.code(204).send();
  });

  app.get('/api/medications/checkoffs', {
    schema: {
      summary: 'Daily check-offs by week for each current item: taken out of logged slots, weeks ending Saturday (the last is this week so far); a week with nothing logged has logged 0',
      querystring: { type: 'object', additionalProperties: false, properties: { weeks: { type: 'integer', minimum: 4, maximum: 52, default: 12 } } },
      response: { 200: anyObject },
    },
  }, async (req) => q.medicationCheckoffs(db, q.localDate(clock()), req.query.weeks));

  app.get('/api/medications/impact', {
    schema: { summary: 'Each start, change and stop with before and after averages (observational, not cause)', response: medList },
  }, async () => q.medicationImpact(db, q.localDate(clock())));

  // ---- labs ----
  const labValueField = { type: ['string', 'number'], maxLength: 50 };
  app.get('/api/labs', { schema: { summary: 'Lab tests by panel with their results, newest first', response: { 200: anyObject } } },
    async () => q.listLabs(db, labRanges ?? loadLabRanges()));

  app.post('/api/labs/results', {
    schema: {
      summary: 'Add a result entered in the app (existing test, or a new test by name)',
      body: {
        type: 'object', additionalProperties: false, required: ['drawn_on', 'value'],
        properties: {
          test_id: { type: 'integer', minimum: 1 }, name: { type: 'string', maxLength: 100 }, panel: text(100), unit: text(40),
          drawn_on: dateField, value: labValueField,
        },
      },
      response: { 201: anyObject },
    },
  }, async (req, reply) => reply.code(201).send(q.addLabResult(db, { ...req.body, drawn_on: pastDate(req.body.drawn_on) })));

  app.put('/api/labs/results/:id', {
    schema: {
      summary: 'Correct a result (a sheet result becomes an app correction that sync keeps)',
      params: idParams,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { drawn_on: dateField, value: labValueField } },
      response: { 200: anyObject },
    },
  }, async (req) => q.updateLabResult(db, req.params.id, { ...req.body, drawn_on: req.body.drawn_on ? pastDate(req.body.drawn_on) : undefined }));

  app.delete('/api/labs/results/:id', { schema: { summary: 'Delete a result added in the app, or undo a correction (restores the sheet value)', params: idParams } }, async (req, reply) => {
    q.deleteLabResult(db, req.params.id);
    return reply.code(204).send();
  });

  app.put('/api/labs/tests/:id', {
    schema: {
      summary: "Set a test's unit, panel, or reference range (your lab report's; reset_range goes back to the typical one)",
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          unit: text(40), panel: text(100),
          ref_low: { type: ['number', 'null'], minimum: -100000, maximum: 1000000 },
          ref_high: { type: ['number', 'null'], minimum: -100000, maximum: 1000000 },
          reset_range: { type: 'boolean' },
        },
      },
      response: { 200: anyObject },
    },
  }, async (req) => q.updateLabTest(db, req.params.id, req.body));

  // ---- settings ----
  const bpm = nullable({ type: 'integer', minimum: 40, maximum: 220 });
  // ---- Health tab targets: suggested from norms for the owner's sex and age and their own data, editable ----
  const targetsConfig = () => targetConfig ?? loadTargetConfig();
  const metricParams = { type: 'object', required: ['metric'], properties: { metric: { type: 'string', pattern: '^[a-z0-9_]{1,40}$' } } };
  const knownMetric = (metric) => {
    if (!targetsConfig().metrics[metric]) throw badRequest(`Unknown metric ${metric}`);
    return metric;
  };
  app.get('/api/targets', {
    schema: { summary: 'Each Health tab metric: current (90-day average or latest), suggested target, the target in effect (yours or suggested), healthy level, reason and source', response: { 200: anyObject } },
  }, async () => {
    const today = q.localDate(clock());
    return { profile: loadProfile(db, today), targets: loadTargets(db, today, targetsConfig()) };
  });
  app.put('/api/targets/:metric', {
    schema: {
      summary: 'Set your own target for a metric (replaces the suggestion until reset)',
      params: metricParams,
      body: { type: 'object', additionalProperties: false, required: ['target'], properties: { target: { type: 'number', minimum: 0, maximum: 100000 } } },
      response: { 200: anyObject },
    },
  }, async (req) => {
    const metric = knownMetric(req.params.metric);
    db.prepare(`INSERT INTO health_targets (user_id, metric, target, updated_at) VALUES (@uid, ?, ?, ?)
      ON CONFLICT (user_id, metric) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`).run(metric, req.body.target, new Date().toISOString());
    return loadTargets(db, q.localDate(clock()), targetsConfig()).find((t) => t.metric === metric);
  });
  app.delete('/api/targets/:metric', { schema: { summary: 'Go back to the suggested target', params: metricParams, response: { 200: anyObject } } }, async (req) => {
    const metric = knownMetric(req.params.metric);
    db.prepare('DELETE FROM health_targets WHERE user_id = @uid AND metric = ?').run(metric);
    return loadTargets(db, q.localDate(clock()), targetsConfig()).find((t) => t.metric === metric);
  });
  // ---- account: the signed-in user's own settings (multi-user, phase 2) ----
  const accountView = (req) => {
    const uid = uidOf(req);
    const u = getUser(store.db, uid);
    return {
      email: u?.email ?? null, name: u?.name ?? req.userName ?? null, role: u?.role ?? 'user', owner: uid === OWNER_ID,
      // Never the key: where it comes from and when it was saved.
      claudeKey: uid === OWNER_ID ? { source: 'server' } : u?.claude_key_enc ? { source: 'yours', setAt: u.claude_key_set_at } : null,
      ai: aiOn(req),
    };
  };
  app.get('/api/account', { schema: { summary: "The signed-in user's account: name, email, role, and whether a Claude key is set (never the key)", response: { 200: anyObject } } },
    async (req) => accountView(req));
  app.put('/api/account/claude-key', {
    schema: {
      summary: 'Save your Claude API key: checked with Anthropic (free), stored encrypted, never shown again',
      body: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', minLength: 20, maxLength: 300, pattern: '^sk-ant-[A-Za-z0-9_-]+$' } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    const uid = uidOf(req);
    if (uid === OWNER_ID) return reply.code(409).send({ error: "The owner's key comes from the server's settings" });
    if (!(await keyCheck(req.body.key))) return reply.code(400).send({ error: 'Anthropic did not accept that key. Check it and try again.' });
    setClaudeKey(store.db, uid, seal(req.body.key, uid, keyBox ?? boxKey()));
    log.info('[users] a Claude key was saved');
    return accountView(req);
  });
  app.delete('/api/account/claude-key', { schema: { summary: 'Remove your Claude API key (no AI is used without one)', response: { 200: anyObject } } }, async (req) => {
    setClaudeKey(store.db, uidOf(req), null);
    return accountView(req);
  });

  // ---- user administration (admin only; the full screen is phase 4) ----
  const isAdmin = (req) => authMode !== 'demo' && (req.role === 'admin' || (authMode === 'none' && uidOf(req) === OWNER_ID));
  const adminOnly = async (req, reply) => { if (!isAdmin(req)) return reply.code(403).send({ error: 'Administrators only' }); };
  app.get('/api/admin/users', { preHandler: adminOnly, schema: { summary: 'Every user (account facts only, never keys or health data), pending first', response: { 200: { type: 'array', items: anyObject } } } },
    async () => listUsers(store.db));
  const userIdParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } };
  app.post('/api/admin/users/:id/approve', { preHandler: adminOnly, schema: { summary: 'Approve a user: they get in, start from the default prompt sections, and get an email', params: userIdParams, response: { 200: anyObject } } }, async (req, reply) => {
    const u = setUserStatus(store.db, req.params.id, 'approved');
    if (!u) return reply.code(404).send({ error: 'No such user' });
    addDefaultPromptSections(scopeDb(store.db, u.id));
    await mailer.send({ to: u.email, subject: "You're in: Health Review",
      text: `Your Health Review account is approved.\n\nOpen ${appUrl()} and sign in with this Google account. To use the AI weekly review and chat, add your own Claude API key in Settings (see https://docs.claude.com/en/api/getting-started). Everything else works without one.\n` });
    return { ...u, claude_key_enc: undefined };
  });
  app.post('/api/admin/users/:id/reject', { preHandler: adminOnly, schema: { summary: 'Reject a pending user (or end access)', params: userIdParams, response: { 200: anyObject } } }, async (req, reply) => {
    const u = setUserStatus(store.db, req.params.id, 'rejected');
    return u ? { ...u, claude_key_enc: undefined } : reply.code(404).send({ error: 'No such user' });
  });

  app.put('/api/profile', {
    schema: {
      summary: 'Birth year, sex and height for age-based targets (null clears one)',
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          birth_year: { type: ['integer', 'null'], minimum: 1900, maximum: 2100 },
          sex: { type: ['string', 'null'], enum: ['male', 'female', null] },
          height_in: { type: ['number', 'null'], minimum: 36, maximum: 96 },
        },
      },
      response: { 200: anyObject },
    },
  }, async (req) => {
    const today = q.localDate(clock());
    if (req.body.birth_year && req.body.birth_year > Number(today.slice(0, 4))) throw badRequest('Birth year is in the future');
    const upsert = db.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    const remove = db.prepare('DELETE FROM settings WHERE user_id = @uid AND key = ?');
    for (const [k, v] of Object.entries(req.body)) (v === null ? remove.run(k) : upsert.run(k, String(v), new Date().toISOString()));
    return loadProfile(db, today);
  });

  app.get('/api/settings', { schema: { summary: 'Personal settings used by the metrics', response: { 200: anyObject } } },
    async () => q.getSettings(db));

  app.put('/api/settings', {
    schema: {
      summary: 'Update personal settings (null clears one)',
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { zone2_low_bpm: bpm, zone2_high_bpm: bpm } },
      response: { 200: anyObject },
    },
  }, async (req) => {
    const next = { ...q.getSettings(db), ...req.body };
    if (next.zone2_low_bpm != null && next.zone2_high_bpm != null && next.zone2_low_bpm >= next.zone2_high_bpm) {
      throw badRequest('The Zone 2 low end must be below the high end');
    }
    return q.saveSettings(db, req.body);
  });

  // ---- prompt sections ----
  app.get('/api/prompt/sections', { schema: { summary: 'Prompt sections in order', response: { 200: { type: 'array', items: anyObject } } } },
    async () => q.listSections(db));

  app.post('/api/prompt/sections', {
    schema: {
      summary: 'Add a prompt section',
      body: { type: 'object', additionalProperties: false, required: ['position', 'name', 'text'], properties: sectionFields },
      response: { 201: anyObject },
    },
  }, async (req, reply) => {
    try {
      return reply.code(201).send(q.createSection(db, req.body));
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw Object.assign(new Error('A section with that name already exists'), { statusCode: 409 });
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
      const section = q.updateSection(db, req.params.id, req.body);
      return section ?? reply.code(404).send({ error: 'Section not found' });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw Object.assign(new Error('A section with that name already exists'), { statusCode: 409 });
      throw err;
    }
  });

  app.delete('/api/prompt/sections/:id', { schema: { summary: 'Delete a prompt section (a copy is kept)', params: idParams } }, async (req, reply) => {
    if (!q.deleteSection(db, req.params.id)) return reply.code(404).send({ error: 'Section not found' });
    return reply.code(204).send();
  });

  app.get('/api/prompt/preview', { schema: { summary: 'The weekly review instructions as the model would receive them', response: { 200: anyObject } } },
    async () => q.previewInstructions(db, q.localDate(clock())));

  if (publicDir && existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
  }
  return app;
}
