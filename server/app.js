// The Health Review API and UI. Every route has a JSON schema; /api/openapi.json is the contract
// the UI (and any future backend) follows.
import { existsSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth.js';
import { registerSecurityHeaders, registerRateLimits, errorReply, DEMO_REQUEST_LIMIT, analyticsConfig, siteHostname } from './security.js';
import * as q from './queries.js';
import { TIMINGS } from '../metrics/medications.js';
import { VIEWS } from '../metrics/volume.js';
import { addDays } from '../metrics/stats.js';
import { VO2_VIEWS } from '../metrics/vo2max.js';
import { repoPath } from '../tools/paths.js';
import { loadCatalog } from '../metrics/catalog.js';
import { loadDictionary } from '../metrics/dictionary.js';
import { loadGoals, loadSubstitutions, loadTargets, loadProfile, loadUserPrograms, userCatalog } from '../metrics/load.js';
import { loadTargetConfig } from '../metrics/targets.js';
import { loadLabRanges } from '../metrics/labs.js';
import { GOALS, MAX_WEIGHT } from '../metrics/advisor.js';
import { confirmBlocks, currentProgram, listBlocks, refreshPhases, ReviewError } from '../ingest/program-blocks.js';
import { ProgramError, SOURCES, deleteProgram, exportPrograms, importPrograms, saveProgram } from '../ingest/user-programs.js';
import { MAX_PDF_BYTES, extractProgram, isPdf } from '../agent/extract-program.js';
import { WorkoutError, deleteWorkout, listWorkouts, saveWorkout, workoutSuggestions } from '../ingest/app-workouts.js';
import { MAX_UPLOAD_BYTES, TEMPLATE_NAME, UploadError, ingestWorkbook, workoutTemplate } from '../ingest/excel-upload.js';
import { XLSX_TYPE, XlsxError } from '../tools/xlsx.js';
import { askAdvisor, clearChat, deleteChatNote, listChat, MAX_NOTE_CHARS } from '../agent/advisor-chat.js';
// agent-core prices calls but does not export its price table yet; import it by path until a release exports it.
import { costFromUsage } from '../node_modules/@scottmroth5/agent-core/src/pricing.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRateLimiter } from './security.js';
import { parseHealthJson } from '../ingest/health-json.js';
import { parseWorkoutJson } from '../ingest/parsers.js';
import { applyHealthDays, applyWorkouts } from '../ingest/apply.js';
import { DEFAULT_TZ, isTimeZone, localDate as zonedDate, localStamp, ownerTz, withTimeZone } from '../tools/time.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { scopeDatabase } from '../db/scope.js';
import { HEALTH_CONSENT_VERSION, OWNER_ID, clearIngestToken, getUser, newIngestToken, recordHealthConsent, setClaudeKey, setGoogleToken, setUserFeeds, startUserRun, syncOwnerEmail, timeZoneOf, userByEmail, userByIngestToken } from '../db/users.js';
import { createPendingUser, deleteUserData, exportUserData, listFeedback, listUsers, newFeedbackCount, setFeedbackStatus, setMapsShared, setOwnerKey, setUserStatus, usageByWeek, usageTotals } from './admin-queries.js';
import { createUsageTotals, hostnameOrNull } from './usage-totals.js';
import { GOALS as GOAL_LABELS, GOAL_KEYS, LAYOUT_ITEMS, TILES, cleanGoals } from './public/goals.js';
import { MAX_ANSWER_CHARS, SECTION_KINDS, builderSpec, claudeDraft, templateDraft } from '../agent/prompt-draft.js';
import { askHelp, MAX_QUESTION_CHARS } from '../agent/help.js';
import { SUPPLEMENT_DISCLAIMER, supplementAdviceSince } from '../agent/supplements.js';
import { maxHrFor, upperTops, zone2Default, zoneOrderProblem } from './public/zone-defaults.js';
import { SESSION_COOKIE, cookie } from './session.js';
import { OWNER_KEY_CAP, clearCapNotice, spentThisMonth } from './ai-access.js';
import { createMailer } from '../tools/mail.js';
import { boxKey, seal } from '../tools/secret-box.js';
import { addDefaultPromptSections } from '../agent/default-prompts.js';
import { policyPage, supportEmailFrom } from './pages.js';
import { SETUP_STEPS, loadSetupFacts, setupSteps } from './setup.js';
import { BLOCKED_PAGE, geoBlocker } from './geo.js';

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
export async function buildApp({ store, services = {}, publicDir, authMode = 'none', auth = {}, ingest = {}, trustProxy = false, clock = () => new Date(), logger = false, log = console, schedule = () => [], catalog, dictionary, substitutions, features = {}, instance = 'main', evalDir = null, price = costFromUsage, targetConfig, labRanges, mailer = createMailer({ env: {} }), keyCheck = anthropicKeyCheck, keyBox, requestAccessUrl = null, geo = {}, supportEmail = null, analytics = null, personalSite = null, usage = null }) {
  // Demo analytics (server/public/analytics.js): only in the demo, with an https host and a PostHog project token.
  const demoAnalytics = authMode === 'demo' ? analyticsConfig({ ...analytics, site: personalSite }) : null;
  // The published support address (SUPPORT_EMAIL), never written in the repo; null shows "the administrator".
  const support = supportEmailFrom(supportEmail);
  const supportLine = support ? `\nQuestions or problems: ${support}\n` : '';
  const app = Fastify({ logger, trustProxy });
  // US-only access (server/geo.js): refused before anything else runs; ingest posts and the health check always pass.
  const blocked = geoBlocker(geo);
  const blockedPage = support ? BLOCKED_PAGE.replace('</p></body>', `</p><p>Questions: <a href="mailto:${support}">${support}</a></p></body>`) : BLOCKED_PAGE;
  app.addHook('onRequest', async (req, reply) => {
    if (blocked(req)) return reply.code(403).type('text/html').header('Cache-Control', 'no-store').send(blockedPage);
  });
  // Every route's method and path, so tests can check each write route (demo mode refuses them all).
  const routeList = [];
  app.addHook('onRoute', (r) => { for (const method of [r.method].flat()) routeList.push({ method, url: r.url }); });
  app.decorate('routeList', routeList);
  // Every request runs as one user (multi-user, phase 1): `db` below is that user's view of the database (db/scope.js),
  // set for the request in preHandler. Local (none) and the demo are the owner; google mode is the signed-in user, and a
  // request without one (open routes) has no database at all, so nothing can read across users by mistake.
  // Every request runs on the async handle (docs/adr/0006; v3 Phase 1B slice 4b): db and adb are the same user's view.
  const requestDb = new AsyncLocalStorage();
  const currentHandles = () => {
    const scoped = requestDb.getStore();
    if (!scoped) throw new Error('No user for this request');
    return scoped;
  };
  const currentDb = () => currentHandles().adb;
  const db = new Proxy({}, { get: (_, prop) => Reflect.get(currentDb(), prop) });
  const adb = db;
  // The store as the request's user sees it, for code that takes a store (the chat); tx and atx are the shared ones.
  const userStore = () => ({ ...store, db: currentDb(), adb: currentDb() });
  const uidOf = (req) => req.uid ?? (authMode === 'google' ? null : OWNER_ID);
  // Per user: one sync, one manual review and one chat question at a time for each user (never shared between users).
  const syncing = new Set();
  // The manual review run per user: in the background; the last failure is kept as its error name only.
  const reviewRuns = new Map();
  const reviewRunOf = (req) => {
    const uid = uidOf(req);
    if (!reviewRuns.has(uid)) reviewRuns.set(uid, { running: false, weekEnd: null, error: null });
    return reviewRuns.get(uid);
  };

  await app.register(swagger, {
    openapi: { info: { title: 'Health Review API', version: '1.0.0', description: 'Local health tracking and weekly review' } },
  });
  // Security headers always; rate limits once the server can be reached from outside (sign-in, refused requests, and every
  // request in the public demo); then the sign-in check (server/auth.js).
  registerSecurityHeaders(app, { https: String(auth.settings?.publicUrl ?? '').startsWith('https://'), connectExtra: demoAnalytics?.host });
  // A ceiling on every route per address (@fastify/rate-limit): far above normal use (a screen makes about 15 requests),
  // it stops floods and scripted abuse. The deploy check is exempt. Tighter limits for sign-in, refused requests, ingest
  // posts and the demo follow (server/security.js).
  await app.register(fastifyRateLimit, {
    global: true,
    max: authMode === 'none' ? 6000 : 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/api/health',
    errorResponseBuilder: (req, ctx) => ({ statusCode: 429, error: 'Too many requests from this address. Try again later.', retryAfter: Math.ceil(ctx.ttl / 1000) }),
  });
  if (authMode !== 'none') registerRateLimits(app, { all: authMode === 'demo' ? DEMO_REQUEST_LIMIT : null, now: auth.now });
  // Google sign-in maps an address to its users row; the first allowed address is the owner (user 1) until registration.
  if (authMode === 'google' && auth.settings?.allowed?.[0]) syncOwnerEmail(store.raw ?? store.db, { OWNER_EMAIL: auth.settings.allowed[0] });
  const adminEmail = async () => process.env.ADMIN_EMAIL || (await getUser(store.adb, OWNER_ID))?.email;
  const appUrl = () => auth.settings?.publicUrl || 'http://localhost:5188';
  // A registration: a pending user, and an email to the admin (names and addresses only).
  const registerUser = async ({ email, name, feeds, healthConsent = false }) => {
    // Exists, then create, in one transaction (the email is UNIQUE besides); the email goes after it.
    const created = await store.adb.tx(async () => {
      if (await userByEmail(store.adb, email)) return false;
      const u = await createPendingUser(store.adb, { id: randomUUID(), email, name, healthConsentVersion: healthConsent ? HEALTH_CONSENT_VERSION : null });
      if (feeds) await setUserFeeds(store.adb, u.id, JSON.stringify(feeds));
      return true;
    });
    if (!created) return;
    log.info('[users] new registration');
    await mailer.send({ to: await adminEmail(), subject: 'New Health Review registration',
      text: `${name ?? 'Someone'} <${email}> asked for access to Health Review.\n\nApprove or reject on the Users tile: ${appUrl()}/#users\n` });
  };
  // A user's own Google Sheets permission (read only): the refresh token is sealed to them; never logged or shown.
  const connectSheets = async ({ email, refreshToken }) => {
    const u = await userByEmail(store.adb, email);
    if (!u) return;
    await setGoogleToken(store.adb, u.id, seal(refreshToken, u.id, keyBox ?? boxKey()));
    log.info('[users] Google Sheets connected');
  };
  // "Create my Workout Log": a new sheet in their Drive (services.createWorkoutSheet, ingest/create-sheet.js), saved as
  // their Workout Log. Never the owner, whose Workout Log comes from the server's settings.
  const createSheet = async ({ email }) => {
    const u = await userByEmail(store.adb, email);
    if (!u || u.id === OWNER_ID || u.status !== 'approved') throw new Error('not for this account');
    if (typeof services.createWorkoutSheet !== 'function') throw new Error('not available');
    const { id } = await services.createWorkoutSheet(u.id);
    const upsert = scopeDatabase(store.adb, u.id).prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    await upsert.run('workout_log_sheet_id', id, clock().toISOString());
    // Remembered so each January's sync can add the new year's tab to this sheet (and only this one).
    await upsert.run('workout_log_created', id, clock().toISOString());
    log.info('[users] a Workout Log sheet was created');
  };
  // Deleting an account (Settings, or the one-time consent step): everything stored for them, and an email to the admin.
  const deleteAccount = async (uid) => {
    const u = await getUser(store.adb, uid);
    // The role is checked again inside deleteUserData's transaction (null: an administrator, or already gone).
    if (!u || u.role === 'admin' || !(await deleteUserData(store.adb, u.id))) return;
    log.info('[users] a user deleted their account');
    await mailer.send({ to: await adminEmail(), subject: 'Health Review: a user deleted their account',
      text: `${u.name || u.email} (${u.email}) deleted their Health Review account and its data. Encrypted backups keep a copy until they age out.\n` });
  };
  const recordConsent = async (uid) => {
    await recordHealthConsent(store.adb, uid, clock());
    log.info('[users] health data consent given');
  };
  // Usage totals (server/usage-totals.js): the signed-in app only, never the demo or local mode. A signed-in browser
  // visit (the auth hook marked it; the app page or an API call, not files) counts once per account per owner day by
  // device and location; an arrival on the app page or the sign-in page counts by source. Only counts are kept, and a
  // failure here never touches the response.
  const counter = authMode === 'google' ? createUsageTotals({
    db: store.adb, place: usage?.place ?? null, tz: process.env.OWNER_TZ || DEFAULT_TZ, now: clock,
    siteHost: hostnameOrNull(usage?.siteHost), demoHost: hostnameOrNull(usage?.demoHost),
    appHost: (() => { try { return new URL(auth.settings.publicUrl).hostname.toLowerCase(); } catch { return null; } })(),
  }) : null;
  if (counter) {
    app.addHook('onResponse', async (req, reply) => {
      try {
        const [path, query = ''] = req.url.split('?');
        if (req.browserSession && reply.statusCode < 400 && (path === '/' || path.startsWith('/api/'))) await counter.visit(req, req.uid);
        const signInPage = path === '/auth/login' && new URLSearchParams(query).get('go') !== '1';
        if (req.method === 'GET' && reply.statusCode === 200 && (path === '/' || signInPage)) await counter.arrival(req);
      } catch { /* counting never affects a request */ }
    });
  }
  registerAuth(app, { supportEmail: support, mode: authMode, settings: auth.settings, exchange: auth.exchange, now: auth.now, findUser: (email) => userByEmail(store.adb, email), registerUser,
    sheetsExchange: auth.sheetsExchange, connectSheets, createSheet, recordConsent, deleteAccount });
  // The privacy policy and terms, readable before signing in.
  // {{PERSONAL_SITE}}: the operator's website (PERSONAL_SITE), named only at render time so the repo never holds it.
  app.get('/privacy', { schema: { hide: true } }, async (req, reply) => reply.type('text/html').send(policyPage('PRIVACY.md', { SUPPORT: support, PERSONAL_SITE: siteHostname(personalSite) ?? "the operator's website" })));
  app.get('/terms', { schema: { hide: true } }, async (req, reply) => reply.type('text/html').send(policyPage('TERMS.md', { SUPPORT: support })));
  app.get('/consumer-health-data', { schema: { hide: true } }, async (req, reply) => reply.type('text/html').send(policyPage('CONSUMER-HEALTH-DATA.md', { SUPPORT: support })));
  // Setup guides for each data feed (docs/guides), readable before signing in.
  const GUIDES = ['using-the-app', 'health-auto-export', 'workout-log', 'manual-entry', 'programs', 'prompts', 'claude-key'];
  // The demo's guides are its copy of the real ones: a banner says so and links to Request access, and the addresses in
  // them are the main app's (from its Request access link), since nothing can be set up against the demo.
  const demoGuides = instance === 'demo' || authMode === 'demo';
  const accessUrl = (() => { try { const u = new URL(requestAccessUrl ?? ''); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; } })();
  const mainOrigin = accessUrl?.origin ?? null;
  const guideNotice = demoGuides ? { notice: { text: "This is the demo's copy of the guide, for reading only. To set it up with your own data,",
    linkText: 'request access to Health Review', href: accessUrl?.href ?? '/' } } : {};
  app.get('/guides/:name', { schema: { hide: true } }, async (req, reply) => (GUIDES.includes(req.params.name)
    ? reply.type('text/html').send(policyPage(`docs/guides/${req.params.name}.md`, { SITE: (demoGuides && mainOrigin) || appUrl(), SUPPORT: support }, guideNotice))
    : reply.code(404).type('text/html').send(policyPage('docs/guides/index.md', { SUPPORT: support }))));
  app.get('/guides', { schema: { hide: true } }, async (req, reply) => reply.type('text/html').send(policyPage('docs/guides/index.md', { SUPPORT: support })));
  app.addHook('preHandler', (req, reply, done) => {
    const uid = uidOf(req);
    if (!uid) return done();
    // The request runs as its user: their scoped database and their own time zone (tools/time.js withTimeZone).
    // done runs inside both, so the handler and later hooks keep the user's zone and database.
    timeZoneOf(store.adb, uid).then((tz) => withTimeZone(tz, () => requestDb.run({ adb: scopeDatabase(store.adb, uid) }, done)), done);
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

  // ---- one day ----
  app.get('/api/days/:date', { schema: { summary: 'Check-in and drinks for a day', params: dateParams, response: { 200: anyObject } } },
    async (req) => await q.getDay(db, requireDate(req.params.date)));

  app.put('/api/checkins/:date', { schema: { summary: 'Save a daily check-in', params: dateParams, body: checkinBody, response: { 200: anyObject } } },
    async (req) => {
      const date = requireNotFuture(requireDate(req.params.date));
      const hasValue = Object.entries(req.body).some(([, v]) => v !== null && v !== '' && v !== undefined);
      if (!hasValue) throw badRequest('Nothing to save: fill in at least one field, or delete the check-in');
      return await q.saveCheckin(db, date, req.body);
    });

  app.delete('/api/checkins/:date', { schema: { summary: 'Delete a check-in', params: dateParams } }, async (req, reply) => {
    if (!(await q.deleteCheckin(db, requireDate(req.params.date)))) return reply.code(404).send({ error: 'No check-in for that day' });
    return reply.code(204).send();
  });

  app.put('/api/drinking/:date', { schema: { summary: 'Save drinks for a day (all zeros means no drinks)', params: dateParams, body: drinkingBody, response: { 200: anyObject } } },
    async (req) => await q.saveDrinking(db, requireNotFuture(requireDate(req.params.date)), req.body));

  app.delete('/api/drinking/:date', { schema: { summary: 'Delete a drinking day', params: dateParams } }, async (req, reply) => {
    if (!(await q.deleteDrinking(db, requireDate(req.params.date)))) return reply.code(404).send({ error: 'No drinks logged for that day' });
    return reply.code(204).send();
  });

  // ---- training volume ----
  app.get('/api/training', {
    schema: {
      summary: 'Training volume (reps x total load) for the last 7 days, 30 days, 52 weeks, or all history',
      querystring: { type: 'object', required: ['view'], properties: { view: { type: 'string', enum: VIEWS } } },
      response: { 200: anyObject },
    },
  }, async (req) => await q.trainingDashboard(db, req.query.view, q.localDate(clock())));

  // The MAPS catalog is read per request when not injected, so edits to data/maps/programs.json show without a restart.
  // The program catalog a request may use (metrics/load.js userCatalog): the user's own programs (phase 5), then the
  // owner's (MAPS) for the owner and for users the owner shares it with (users.maps_shared); theirs win a name clash.
  const ownerCatalog = () => (catalog === undefined ? loadCatalog() : catalog);
  const sharedCatalog = async (req) => {
    const uid = uidOf(req);
    return uid === OWNER_ID || (await getUser(store.adb, uid))?.maps_shared ? ownerCatalog() : null;
  };
  const programCatalog = async (req) => userCatalog(db, await sharedCatalog(req));
  app.get('/api/program', {
    schema: {
      summary: 'The confirmed in-progress program block: week, phase, deload or failure week, expected end (program is null when none)',
      response: { 200: { type: 'object', properties: { program: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] } } } },
    },
  }, async (req) => ({ program: await currentProgram(db, q.localDate(clock()), await programCatalog(req)) }));

  // The dictionary and substitutions are committed config, read per request (like the catalog) unless injected.
  const goalWeight = { type: 'integer', minimum: 0, maximum: MAX_WEIGHT, default: 1 };
  app.get('/api/advisor', {
    schema: {
      summary: 'Program Advisor ranking for the next block: goal scores (0 to 1), total, reasons and flags per program; '
        + 'weights 0 to 3 per goal (default 1) change the total; available false without the MAPS catalog',
      querystring: { type: 'object', properties: Object.fromEntries(GOALS.map((g) => [g, goalWeight])) },
      response: { 200: anyObject },
    },
  }, async (req) => await q.advisor(db, q.localDate(clock()), {
    catalog: await programCatalog(req),
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
    const result = await q.programAdherence(db, q.localDate(clock()), {
      catalog: await programCatalog(req), dictionary: dictionary ?? loadDictionary(), substitutions: substitutions ?? loadSubstitutions(), blockId: req.query.block,
    });
    if (result === null) return reply.code(404).send({ error: 'No such confirmed block' });
    return result;
  });

  // ---- Next program chat (computed training facts and the owner's notes go to Claude; see agent/advisor-chat.js) ----
  // AI per user (server/ai-access.js): the owner's key, a user's own key, the owner's key under a monthly cap, or none
  // (then no AI, and the screens say why: aiReason no_key, cap or paused).
  const aiAccessOf = async (req) => {
    if (services.aiAccess) return await services.aiAccess(uidOf(req));
    const on = !services.hasAi || await services.hasAi(uidOf(req));
    return { source: on ? 'owner' : null, reason: on ? null : 'no_key' };
  };
  const aiOn = async (req) => (await aiAccessOf(req)).source !== null;
  const aiReason = async (req) => (await aiAccessOf(req)).reason ?? null;
  const NO_AI = {
    no_key: 'No AI is used until you add your Claude API key in Settings',
    cap: "This month's AI allowance is used up; add your own Claude API key in Settings to keep going",
    paused: 'Your account is paused by the administrator',
    consent: 'No AI is used until you agree to the health data consent',
  };
  const noAi = (reply, reason) => reply.code(503).send({ error: NO_AI[reason] ?? NO_AI.no_key, needsKey: true, aiReason: reason ?? 'no_key' });
  const isPaused = async (req) => (await getUser(store.adb, uidOf(req)))?.status === 'paused';
  const chatOn = async (req) => features.chat !== false && typeof services.claude === 'function' && await aiOn(req);
  const chatThread = { 200: { type: 'object', properties: { enabled: { type: 'boolean' }, needsKey: { type: 'boolean' }, aiReason: { type: ['string', 'null'] }, notes: { type: 'array', items: anyObject } } } };
  app.get('/api/advisor/chat', { schema: { summary: 'The Next program chat thread, oldest first, and whether the chat is on', response: chatThread } },
    async (req) => { const reason = await aiReason(req); return { enabled: await chatOn(req), needsKey: reason !== null, aiReason: reason, notes: await listChat(db) }; });
  const chatting = new Set();
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
    const reason = await aiReason(req);
    if (reason) return noAi(reply, reason);
    if (!(await chatOn(req))) return reply.code(503).send({ error: 'The chat is off in this instance' });
    if (!req.body.text.trim()) throw badRequest('text must not be blank');
    if (chatting.has(uidOf(req))) return reply.code(409).send({ error: 'A question is already being answered' });
    const cat = await programCatalog(req);
    if (!cat) return reply.code(503).send({ error: 'The chat needs a program catalog' });
    chatting.add(uidOf(req));
    try {
      return await askAdvisor({
        store: userStore(), claude: await services.claude(uidOf(req)), text: req.body.text.trim(), today: q.localDate(clock()), catalog: cat,
        dictionary: dictionary ?? loadDictionary(), substitutions: substitutions ?? loadSubstitutions(), weights: req.body.weights,
        logger: { info() {}, warn() {}, error() {} },
      });
    } finally {
      chatting.delete(uidOf(req));
    }
  });
  app.delete('/api/advisor/chat/:id', {
    schema: { summary: 'Delete one note or reply from the thread', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } }, response: { 200: anyObject } },
  }, async (req, reply) => ((await deleteChatNote(db, req.params.id)) ? { deleted: 1 } : reply.code(404).send({ error: 'Not found' })));
  app.delete('/api/advisor/chat', { schema: { summary: 'Clear the whole thread', response: { 200: anyObject } } },
    async () => ({ deleted: await clearChat(db) }));

  // ---- a user's own programs (multi-user, phase 5; ingest/user-programs.js): built here, imported as JSON, or drafted
  // by Claude from a PDF (never stored). The shared catalog (the owner's MAPS) shows by name only, never its contents.
  const programsView = async (req) => {
    const own = await loadUserPrograms(db);
    const names = new Set(own.map((r) => r.name));
    return {
      programs: own,
      shared: ((await sharedCatalog(req))?.programs ?? []).map((p) => p.name).filter((n) => !names.has(n)),
      canExtract: typeof services.claude === 'function',
      owner: uidOf(req) === OWNER_ID,
    };
  };
  const programError = (reply, err) => {
    if (err instanceof ProgramError) return reply.code(400).send({ error: err.message, problems: err.problems });
    throw err;
  };
  const programWrite = (req) => ({ today: q.localDate(clock()), catalog: () => programCatalog(req), now: clock() });
  const programBody = {
    type: 'object', additionalProperties: false, required: ['program'],
    properties: { program: anyObject, match: { type: 'string', maxLength: 200 }, source: { type: 'string', enum: SOURCES } },
  };
  const programIdParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } };
  app.get('/api/programs', { schema: { summary: 'Your own programs in full, and the names of the shared catalog\'s programs', response: { 200: anyObject } } },
    async (req) => await programsView(req));
  app.post('/api/programs', { schema: { summary: 'Add a program of your own (checked like a catalog entry; problems listed)', body: programBody, response: { 200: anyObject } } },
    async (req, reply) => {
      try { await saveProgram(adb, { ...req.body, ...programWrite(req) }); } catch (err) { return programError(reply, err); }
      return await programsView(req);
    });
  app.put('/api/programs/:id', { schema: { summary: 'Replace one of your programs', params: programIdParams, body: programBody, response: { 200: anyObject } } },
    async (req, reply) => {
      try { await saveProgram(adb, { id: req.params.id, ...req.body, ...programWrite(req) }); } catch (err) { return programError(reply, err); }
      return await programsView(req);
    });
  app.delete('/api/programs/:id', { schema: { summary: 'Delete one of your programs', params: programIdParams, response: { 200: anyObject } } },
    async (req, reply) => ((await deleteProgram(adb, req.params.id, programWrite(req))) ? await programsView(req) : reply.code(404).send({ error: 'No such program' })));
  app.post('/api/programs/import', { schema: { summary: 'Import one program or a catalog of programs, all or nothing', body: anyObject, response: { 200: anyObject } } },
    async (req, reply) => {
      let added;
      try { added = await importPrograms(adb, req.body, programWrite(req)); } catch (err) { return programError(reply, err); }
      return { added, ...(await programsView(req)) };
    });
  app.get('/api/programs/export', { schema: { summary: 'Your own programs as a catalog file (never the shared catalog)', response: { 200: anyObject } } },
    async (req, reply) => reply.header('Content-Disposition', 'attachment; filename="my-programs.json"').send(await exportPrograms(db)));
  // Claude reads a PDF the user uploaded, on their own AI; the draft comes back to check in the builder, nothing saved.
  app.post('/api/programs/extract', {
    bodyLimit: Math.ceil(MAX_PDF_BYTES * 1.4),
    schema: {
      summary: 'Draft a program from a PDF you have the right to use (Claude reads it with your AI; the PDF is never stored)',
      body: { type: 'object', additionalProperties: false, required: ['pdf', 'rightToUse'], properties: {
        pdf: { type: 'string', minLength: 8, maxLength: Math.ceil(MAX_PDF_BYTES * 1.37) }, rightToUse: { type: 'boolean' }, filename: { type: 'string', maxLength: 200 } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    if (typeof services.claude !== 'function') return reply.code(503).send({ error: 'Reading PDFs is not available in this server' });
    const reason = await aiReason(req);
    if (reason) return noAi(reply, reason);
    if (req.body.rightToUse !== true) throw badRequest('Confirm that you own this program or have the right to use it');
    const pdf = Buffer.from(req.body.pdf, 'base64');
    if (!isPdf(pdf)) throw badRequest('That file is not a PDF');
    if (pdf.length > MAX_PDF_BYTES) throw badRequest('The PDF is over 20 MB');
    try {
      return await extractProgram({ store: userStore(), claude: await services.claude(uidOf(req)), pdf, logger: { info() {}, warn() {}, error() {} } });
    } catch (err) {
      log.warn(`[programs] reading a PDF failed: ${err.name}`);
      return reply.code(502).send({ error: err.status === 400 ? 'Claude could not read that PDF (it may be over 100 pages or protected)' : 'Claude could not read the PDF; try again' });
    }
  });
  // ---- workouts logged in the app (ingest/app-workouts.js; tab_year 0, never touched by the Sheets sync) ----
  const workoutCtx = (req) => ({ today: q.localDate(clock()), now: clock(), dictionary: dictionary ?? loadDictionary(), catalog: () => programCatalog(req) });
  const workoutError = (reply, err) => {
    if (err instanceof WorkoutError) return reply.code(400).send({ error: err.message });
    throw err;
  };
  const dateOnly = { type: 'object', required: ['date'], properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } };
  app.get('/api/workouts', {
    schema: { summary: 'Days with workouts, newest first: app-logged ones (editable) and Workout Log sheet ones (read only); default the last 30 days',
      querystring: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } }, response: { 200: { type: 'array', items: anyObject } } },
  }, async (req) => {
    const today = q.localDate(clock());
    const to = req.query.to ? requireDate(req.query.to) : today;
    const from = req.query.from ? requireDate(req.query.from) : addDays(to, -29);
    if (from > to) throw badRequest('from must not be after to');
    return await listWorkouts(db, { from, to });
  });
  app.get('/api/workouts/suggest', { schema: { summary: 'Exercise names (yours, then the dictionary) and your own programs\' workouts to start from', response: { 200: anyObject } } },
    async () => await workoutSuggestions(db, { dictionary: dictionary ?? loadDictionary(), ownPrograms: (await loadUserPrograms(db)).map((r) => r.program) }));
  const setItem = { type: 'object', additionalProperties: false, properties: { weight: { type: ['string', 'null'], maxLength: 40 }, reps: { type: ['string', 'null'], maxLength: 40 } } };
  app.put('/api/workouts/:date', {
    schema: {
      summary: "Save the day's workout logged in the app (replaces that day's app workout; sheet rows are left alone)",
      params: dateOnly,
      body: { type: 'object', additionalProperties: false, required: ['exercises'], properties: {
        workout: { type: ['string', 'null'], maxLength: 200 },
        exercises: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['name'], properties: {
          name: { type: 'string', maxLength: 120 }, comment: { type: ['string', 'null'], maxLength: 500 }, sets: { type: 'array', maxItems: 8, items: setItem } } } },
      } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    try { return await saveWorkout(adb, requireDate(req.params.date), req.body, workoutCtx(req)); } catch (err) { return workoutError(reply, err); }
  });
  app.delete('/api/workouts/:date', { schema: { summary: "Delete the day's workout logged in the app", params: dateOnly, response: { 200: anyObject } } },
    async (req, reply) => ((await deleteWorkout(adb, requireDate(req.params.date), workoutCtx(req))) ? { deleted: true } : reply.code(404).send({ error: 'No workout logged in the app that day' })));

  // ---- the Excel Workout Log (ingest/excel-upload.js, tools/xlsx.js): a template to download, and uploading it ----
  // Only .xlsx is accepted: this content type (any other gets 415 before anything is read), a name ending .xlsx, up to
  // 5 MB; the workbook itself is checked by tools/xlsx.js (a real zip, no macros, no legacy .xls, no external links,
  // no DOCTYPE, size and row limits). Read in memory, never stored or logged; never in the demo.
  app.addContentTypeParser(XLSX_TYPE, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (req, body, done) => done(null, body));
  app.get('/api/workout-log/template.xlsx', { schema: { summary: 'The Excel Workout Log to download: a tab for this year with the Workout Log columns, and How to use' } },
    async (req, reply) => reply.type(XLSX_TYPE).header('Content-Disposition', `attachment; filename="${TEMPLATE_NAME}"`).send(workoutTemplate(q.localDate(clock()).slice(0, 4))));
  const uploadTimes = new Map(); // uid -> this hour's upload times
  const UPLOADS_PER_HOUR = 10;
  app.post('/api/workout-log/upload', {
    bodyLimit: MAX_UPLOAD_BYTES,
    schema: { summary: 'Upload your Excel Workout Log (.xlsx only, up to 5 MB): each tab named with a year replaces that year\'s rows', response: { 200: anyObject } },
  }, async (req, reply) => {
    if (authMode === 'demo' || instance === 'demo') return reply.code(403).send({ error: 'Uploads are turned off in the demo' });
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith(XLSX_TYPE)) return reply.code(415).send({ error: 'Upload an Excel workbook (.xlsx)' });
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')); } catch { name = ''; }
    if (!/\.xlsx$/i.test(name) || name.length > 200) return reply.code(415).send({ error: 'Upload an Excel workbook (.xlsx); other files are not accepted' });
    const uid = uidOf(req);
    if (uid === OWNER_ID) return reply.code(409).send({ error: "The owner's Workout Log comes from the server's Google Sheet" });
    if (await isPaused(req)) return reply.code(403).send({ error: NO_AI.paused });
    if (await db.prepare("SELECT 1 FROM settings WHERE user_id = @uid AND key = 'workout_log_sheet_id'").get()) {
      return reply.code(409).send({ error: 'You sync a Google Sheet Workout Log. Disconnect Google Sheets in Settings to upload Excel instead.' });
    }
    const hourAgo = clock().getTime() - 3600_000;
    const recent = (uploadTimes.get(uid) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= UPLOADS_PER_HOUR) return reply.code(429).send({ error: `At most ${UPLOADS_PER_HOUR} uploads an hour; try again later` });
    uploadTimes.set(uid, [...recent, clock().getTime()]);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).send({ error: 'The file is empty' });
    const run = startUserRun(userStore(), 'workout-upload', { bytes: req.body.length }, { info() {}, warn() {}, error() {} });
    let result;
    try {
      result = await ingestWorkbook(adb, req.body, workoutCtx(req));
    } catch (err) {
      if (!(err instanceof XlsxError || err instanceof UploadError)) { run.finish('error', { error: err.name }); throw err; }
      run.finish('error', { error: 'not_accepted' });
      return reply.code(400).send({ error: err.message });
    }
    run.finish('ok', { years: result.years.length, exercises: result.exercises, sets: result.sets, notes: result.notes });
    log.info(`[upload] workout log ok years=${result.years.length} exercises=${result.exercises} sets=${result.sets}`);
    return result;
  });

  // Program blocks for a user to confirm in the app (the owner also has npm run programs:review for edits, merges and splits).
  app.get('/api/program/blocks', { schema: { summary: 'Your program blocks, detected and confirmed, oldest first', response: { 200: { type: 'array', items: anyObject } } } },
    async () => await listBlocks(db));
  app.post('/api/program/blocks/:id/confirm', { schema: { summary: 'Confirm a detected program block (phases and progress then follow it)', params: programIdParams, response: { 200: anyObject } } },
    async (req, reply) => {
      try {
        await confirmBlocks(adb, req.params.id, { today: q.localDate(clock()), now: clock() });
      } catch (err) {
        if (err instanceof ReviewError) return reply.code(409).send({ error: err.message });
        throw err;
      }
      await refreshPhases(adb, await programCatalog(req));
      return { blocks: await listBlocks(db) };
    });

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
  }, async (req) => await q.vo2max(db, req.query.view, q.localDate(clock())));

  app.get('/api/cardio-zones', {
    schema: {
      summary: 'Cardio minutes by heart rate zone over 30 days, 90 days or 1 year, by day, week (Sunday to Saturday) or calendar month (default: days for 30d and 90d, weeks for 1y): minutes per zone from per-minute heart rate, minutes with no heart rate detail, and the zone bounds',
      querystring: { type: 'object', required: ['view'], properties: { view: { type: 'string', enum: Object.keys(q.CARDIO_ZONE_VIEWS) }, group: { type: 'string', enum: q.CARDIO_ZONE_GROUPS } } },
      response: { 200: anyObject },
    },
  }, async (req) => await q.cardioZoneView(db, req.query.view, q.localDate(clock()), req.query.group));

  // ---- Health Auto Export REST ingest (the server: APPLE_SOURCE=rest) ----
  // Open to the internet without a Google session (server/auth.js), so each post carries Authorization: Bearer
  // INGEST_TOKEN, compared in constant time. JSON only, 5 MB at most, 30 posts per 15 minutes per address. The data goes
  // through the same parsers and writers as the Drive files (ingest/apply.js); ingest_log keeps metadata only.
  const ingestLimiter = createRateLimiter(INGEST_RATE_LIMIT);
  const tokenHash = ingest.token ? createHash('sha256').update(ingest.token).digest() : null;
  // Whose post it is (multi-user, phase 3): INGEST_TOKEN is the owner's; any other token is an approved user's own
  // (Settings, stored as its SHA-256 only). A pending, rejected or paused user's token is refused like a wrong one.
  const ingestGuard = async (req, reply) => {
    const r = ingestLimiter.hit(req.ip);
    if (!r.allowed) return reply.code(429).header('retry-after', String(r.retryAfterSeconds)).send({ error: 'Too many posts from this address. Try again later.' });
    const given = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    const owner = tokenHash && timingSafeEqual(createHash('sha256').update(given).digest(), tokenHash);
    const user = owner ? null : await userByIngestToken(store.adb, given);
    if (!owner && !user) {
      if (!tokenHash) return reply.code(503).send({ error: 'Ingest is not set up on this server (INGEST_TOKEN).' });
      return reply.code(401).send({ error: 'Missing or wrong ingest token.' });
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return reply.code(415).send({ error: 'Send JSON (Content-Type: application/json).' });
    req.uid = owner ? OWNER_ID : user.id;
  };
  const logIngest = (...values) => db.prepare('INSERT INTO ingest_log (user_id, id, received_at, route, result, counts, error) VALUES (@uid, ?, ?, ?, ?, ?, ?)').run(...values);
  const ingestRoute = (route, summary, apply) => app.post(`/api/ingest/${route}`, {
    bodyLimit: INGEST_BODY_LIMIT,
    onRequest: ingestGuard,
    schema: { summary, body: { type: 'object' }, response: { 200: anyObject } },
  }, async (req, reply) => {
    const received = clock();
    try {
      const counts = await apply(req.body, received);
      await logIngest(randomUUID(), received.toISOString(), route, 'ok', JSON.stringify(counts), null);
      log.info(`[ingest] ${route} ok ${JSON.stringify(counts)}`);
      return { ok: true, ...counts };
    } catch (err) {
      await logIngest(randomUUID(), received.toISOString(), route, 'error', null, err.name);
      log.warn(`[ingest] ${route} error ${err.name}`);
      return reply.code(400).send({ error: err.message });
    }
  });
  ingestRoute('health', "Health Auto Export's health metrics (JSON, Version 2, grouped by day; Apple Stand Hour grouped by hour), stored like the Drive files", async (body, received) => {
    const parsed = parseHealthJson(body, { file: 'post' });
    const at = localStamp(received); // received now: a day posted before it ended is partial
    let result;
    await store.atx(async () => {
      result = await applyHealthDays(adb, { records: parsed.records, exportedThrough: new Map(parsed.records.map((r) => [r.date, at])), standHours: parsed.standHours }, received.toISOString());
    });
    return { days: result.days.length, standHours: parsed.standHours.length, warnings: parsed.warnings.length };
  });
  ingestRoute('workouts', "Health Auto Export's workouts (JSON, Version 2, with per-minute heart rate), stored like the Drive files", async (body, received) => {
    const parsed = parseWorkoutJson(body, { file: 'post' });
    await store.atx(() => applyWorkouts(adb, parsed.records, parsed.samples, received.toISOString()));
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
    return await q.history(db, from, to);
  });

  app.get('/api/reviews', { schema: { summary: 'Weekly reviews, newest first', response: { 200: { type: 'array', items: anyObject } } } },
    async () => await q.listReviews(db));

  const reviewState = async (req) => {
    const status = await q.reviewStatus(db, q.localDate(clock()), clock());
    const access = typeof services.review === 'function' ? await aiAccessOf(req) : null;
    return {
      ...status,
      running: reviewRunOf(req).running,
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
      summary: "Write last week's review now (syncs first; refused while Apple Health days are missing unless force). Returns 202 and runs in the background",
      body: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } },
      response: { 202: anyObject },
    },
  }, async (req, reply) => {
    if (typeof services.review !== 'function') return reply.code(503).send({ error: 'Writing reviews is not available in this server' });
    const access = await aiAccessOf(req);
    if (access.source === null) return noAi(reply, access.reason ?? null);
    const reviewRun = reviewRunOf(req);
    const uid = uidOf(req);
    if (reviewRun.running) return reply.code(409).send({ error: 'A review is already being written' });
    reviewRun.running = true;
    reviewRun.error = null;
    try {
      if (services.sync && !syncing.has(uid)) {
        syncing.add(uid);
        try { await services.sync({ uid }); } catch { /* review the data already stored, as npm run review does */ } finally { syncing.delete(uid); }
      }
      const status = await q.reviewStatus(db, q.localDate(clock()), clock());
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
    async () => await q.listMedications(db));

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
    return reply.code(201).send(await q.addMedication(adb, req.body));
  });

  app.put('/api/medications/:id', {
    schema: { summary: 'Edit name, type, purpose, prescribed or notes', params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: medDetails }, response: { 200: anyObject } },
  }, async (req) => await q.updateMedicationDetails(adb, req.params.id, req.body));

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
  }, async (req) => await q.changeMedication(adb, req.params.id, {
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
  }, async (req) => await q.stopMedication(adb, req.params.id, { ...req.body, stopped_on: pastDate(req.body.stopped_on) }));

  app.post('/api/medications/:id/start', {
    schema: {
      summary: 'Start taking it again',
      params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['timings', 'started_on'], properties: { dose, ingredients, timings, started_on: dateField } },
      response: { 200: anyObject },
    },
  }, async (req) => await q.startMedication(adb, req.params.id, { ...req.body, started_on: pastDate(req.body.started_on) }));

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
  }, async (req) => await q.combineMedications(adb, req.body));

  app.delete('/api/medications/:id', { schema: { summary: 'Remove an entry added by mistake, with all its history', params: idParams } }, async (req, reply) => {
    if (!(await q.deleteMedication(db, req.params.id))) return reply.code(404).send({ error: 'Medication not found' });
    return reply.code(204).send();
  });

  app.put('/api/doses/:date', {
    schema: {
      summary: "Save the day's check-off: each slot sent is recorded taken or skipped (slots not sent stay not logged), with optional one-day dose and slot adjustments",
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
  }, async (req) => await q.saveDoses(adb, pastDate(req.params.date), req.body.doses));

  app.delete('/api/doses/:date', { schema: { summary: "Clear the day's check-off (back to not logged)", params: dateParams } }, async (req, reply) => {
    if (!(await q.clearDoses(db, requireDate(req.params.date)))) return reply.code(404).send({ error: 'Nothing saved for that day' });
    return reply.code(204).send();
  });

  app.get('/api/medications/checkoffs', {
    schema: {
      summary: 'Daily check-offs by week for each current item: taken out of logged slots, weeks ending Saturday (the last is this week so far); a week with nothing logged has logged 0',
      querystring: { type: 'object', additionalProperties: false, properties: { weeks: { type: 'integer', minimum: 4, maximum: 52, default: 12 } } },
      response: { 200: anyObject },
    },
  }, async (req) => await q.medicationCheckoffs(db, q.localDate(clock()), req.query.weeks));

  app.get('/api/medications/impact', {
    schema: { summary: 'Each start, change and stop with before and after averages (observational, not cause)', response: medList },
  }, async () => await q.medicationImpact(db, q.localDate(clock())));

  // ---- labs ----
  const labValueField = { type: ['string', 'number'], maxLength: 50 };
  app.get('/api/labs', { schema: { summary: 'Lab tests by panel with their results, newest first', response: { 200: anyObject } } },
    async () => await q.listLabs(db, labRanges ?? loadLabRanges()));

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
  }, async (req, reply) => reply.code(201).send(await q.addLabResult(adb, { ...req.body, drawn_on: pastDate(req.body.drawn_on) })));

  app.put('/api/labs/results/:id', {
    schema: {
      summary: 'Correct a result (a sheet result becomes an app correction that sync keeps)',
      params: idParams,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { drawn_on: dateField, value: labValueField } },
      response: { 200: anyObject },
    },
  }, async (req) => await q.updateLabResult(adb, req.params.id, { ...req.body, drawn_on: req.body.drawn_on ? pastDate(req.body.drawn_on) : undefined }));

  app.delete('/api/labs/results/:id', { schema: { summary: 'Delete a result added in the app, or undo a correction (restores the sheet value)', params: idParams } }, async (req, reply) => {
    await q.deleteLabResult(adb, req.params.id);
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
  }, async (req) => await q.updateLabTest(adb, req.params.id, req.body));

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
    return { profile: await loadProfile(db, today), targets: await loadTargets(db, today, targetsConfig()) };
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
    await db.prepare(`INSERT INTO health_targets (user_id, metric, target, updated_at) VALUES (@uid, ?, ?, ?)
      ON CONFLICT (user_id, metric) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`).run(metric, req.body.target, new Date().toISOString());
    return (await loadTargets(db, q.localDate(clock()), targetsConfig())).find((t) => t.metric === metric);
  });
  app.delete('/api/targets/:metric', { schema: { summary: 'Go back to the suggested target', params: metricParams, response: { 200: anyObject } } }, async (req) => {
    const metric = knownMetric(req.params.metric);
    await db.prepare('DELETE FROM health_targets WHERE user_id = @uid AND metric = ?').run(metric);
    return (await loadTargets(db, q.localDate(clock()), targetsConfig())).find((t) => t.metric === metric);
  });
  // ---- account: the signed-in user's own settings (multi-user, phase 2) ----
  const accountView = async (req) => {
    const uid = uidOf(req);
    const u = await getUser(store.adb, uid);
    const access = await aiAccessOf(req);
    const setting = async (key) => (await db.prepare('SELECT value FROM settings WHERE user_id = @uid AND key = ?').pluck().get(key)) ?? null;
    const json = (text) => { try { return JSON.parse(text ?? 'null'); } catch { return null; } };
    return {
      email: u?.email ?? null, name: u?.name ?? req.userName ?? null, role: u?.role ?? 'user', owner: uid === OWNER_ID, status: u?.status ?? 'approved',
      // Never the key: where it comes from and when it was saved.
      claudeKey: uid === OWNER_ID ? { source: 'server' } : u?.claude_key_enc ? { source: 'yours', setAt: u.claude_key_set_at } : null,
      ai: access.source !== null,
      aiReason: access.reason ?? null,
      // The zone this account runs in: its own (Settings), else the server default; the owner's is always the default.
      timeZone: { zone: ownerTz(), own: Boolean(await timeZoneOf(store.adb, uid)), fromServer: uid === OWNER_ID },
      // Training goals (Settings) and the Home tile order the user arranged (null: the goals' default).
      goals: await loadGoals(db),
      tileOrder: json(await setting('tile_order')),
      layouts: await (async () => {
        const out = {};
        for (const area of Object.keys(LAYOUT_ITEMS)) out[area] = json(await setting(`layout_${area}`));
        return out;
      })(),
      // Home's setup checklist was hidden (Settings brings it back).
      setupHidden: Boolean(await db.prepare("SELECT 1 FROM settings WHERE user_id = @uid AND key = 'setup_hidden'").get()),
      // Supplement suggestions (off by default): when the statement was accepted, and the statement itself.
      supplementAdvice: { since: await supplementAdviceSince(db), statement: SUPPLEMENT_DISCLAIMER },
      pausedBySelf: u?.status === 'paused' && Boolean(await db.prepare("SELECT 1 FROM settings WHERE user_id = @uid AND key = 'paused_by_self'").get()),
      // The administrator's key with its monthly cap (until the user adds their own): the cap and this month's spend.
      ownerKey: uid !== OWNER_ID && u?.uses_owner_key && !u.claude_key_enc
        ? { cap: u.owner_key_cap_usd, spent: Math.round((await spentThisMonth(store.adb, uid, clock())) * 100) / 100 } : null,
      feeds: await feedsView(req, u),
    };
  };
  // ---- data feeds (multi-user, phase 3): Health Auto Export by REST, the Workout Log in Google Sheets, entering in the app ----
  const FEEDS = ['appleHealth', 'workoutLog', 'manual'];
  const feedsView = async (req, u) => {
    const uid = uidOf(req);
    const owner = uid === OWNER_ID;
    let chosen = {};
    try { chosen = JSON.parse(u?.feeds ?? '{}') ?? {}; } catch { chosen = {}; }
    const lastPost = (await db.prepare("SELECT MAX(received_at) FROM ingest_log WHERE user_id = @uid AND result = 'ok'").pluck().get()) ?? null;
    const lastSync = (await db.prepare("SELECT MAX(finished_at) FROM runs WHERE user_id = @uid AND name = 'sync' AND status = 'ok'").pluck().get()) ?? null;
    const sheetId = (await db.prepare("SELECT value FROM settings WHERE user_id = @uid AND key = 'workout_log_sheet_id'").pluck().get()) ?? null;
    const sheetSet = Boolean(sheetId);
    return {
      chosen: Object.fromEntries(FEEDS.map((f) => [f, chosen[f] ?? (owner || f === 'manual')])),
      // The owner's feeds come from the server's settings (INGEST_TOKEN, WORKOUT_LOG_SHEET_ID and the Google files).
      fromServer: owner,
      appleHealth: { token: owner ? Boolean(ingest.token) : Boolean(u?.ingest_token_hash), lastPost,
        urls: { health: `${appUrl()}/api/ingest/health`, workouts: `${appUrl()}/api/ingest/workouts` } },
      workoutLog: { connected: owner || Boolean(u?.google_refresh_enc), sheetSet: owner || sheetSet, lastSync, canConnect: authMode === 'google',
        // Their own sheet's link, for them only (never on the admin screens).
        sheetUrl: !owner && sheetId ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit` : null,
        canCreate: authMode === 'google' && typeof services.createWorkoutSheet === 'function' },
    };
  };
  app.put('/api/account/feeds', {
    schema: { summary: 'Which data feeds you use (Apple Health, Workout Log, entering in the app)', body: { type: 'object', additionalProperties: false, properties: Object.fromEntries(FEEDS.map((f) => [f, { type: 'boolean' }])) }, response: { 200: anyObject } },
  }, async (req) => {
    await setUserFeeds(store.adb, uidOf(req), JSON.stringify(req.body));
    return accountView(req);
  });
  app.post('/api/account/ingest-token', { schema: { summary: 'A new Health Auto Export token for your account, shown once (replaces any earlier one)', response: { 200: anyObject } } }, async (req, reply) => {
    if (uidOf(req) === OWNER_ID) return reply.code(409).send({ error: "The owner's posts use INGEST_TOKEN from the server's settings" });
    const token = await newIngestToken(store.adb, uidOf(req));
    log.info('[users] an ingest token was created');
    // The status first, then the token itself (the status's own token field is only true or false).
    return { ...(await feedsView(req, await getUser(store.adb, uidOf(req)))).appleHealth, token };
  });
  app.delete('/api/account/ingest-token', { schema: { summary: 'Turn off your Health Auto Export token', response: { 200: anyObject } } }, async (req) => {
    await clearIngestToken(store.adb, uidOf(req));
    return accountView(req);
  });
  app.put('/api/account/workout-sheet', {
    schema: { summary: 'Your Workout Log sheet: its link or ID, checked for year tabs with your Google permission', body: { type: 'object', additionalProperties: false, required: ['sheet'], properties: { sheet: { type: 'string', minLength: 10, maxLength: 500 } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    const uid = uidOf(req);
    if (uid === OWNER_ID) return reply.code(409).send({ error: "The owner's Workout Log comes from the server's settings" });
    const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(req.body.sheet)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(req.body.sheet.trim()) ? req.body.sheet.trim() : null);
    if (!id) return reply.code(400).send({ error: 'Paste the link to your Google Sheet (or its ID)' });
    if (!(await getUser(store.adb, uid))?.google_refresh_enc) return reply.code(409).send({ error: 'Connect Google Sheets first' });
    let tabs;
    try {
      tabs = await services.sheetTabs(uid, id);
    } catch (err) {
      return reply.code(400).send({ error: "That sheet couldn't be opened with your Google permission. Check the link and that this Google account can see it." });
    }
    const years = tabs.filter((t) => /^\d{4}$/.test(t));
    if (!years.length) return reply.code(400).send({ error: 'That sheet has no year tabs (a tab named like 2026); see the Workout Log guide' });
    await db.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'workout_log_sheet_id', ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(id, new Date().toISOString());
    return { ...(await accountView(req)), yearTabs: years };
  });
  app.delete('/api/account/google', { schema: { summary: 'Disconnect Google Sheets: forgets your permission and your sheet', response: { 200: anyObject } } }, async (req) => {
    await setGoogleToken(store.adb, uidOf(req), null);
    await db.prepare("DELETE FROM settings WHERE user_id = @uid AND key IN ('workout_log_sheet_id', 'workout_log_created')").run();
    return accountView(req);
  });
  app.get('/api/account', { schema: { summary: "The signed-in user's account: name, email, role, and whether a Claude key is set (never the key)", response: { 200: anyObject } } },
    async (req) => accountView(req));

  // ---- Home (UX roadmap phase 2): the setup checklist for new users, then a summary of where things stand ----
  const setupOf = async (req) => {
    const uid = uidOf(req);
    const u = await getUser(store.adb, uid);
    const feeds = await feedsView(req, u);
    const facts = await loadSetupFacts(db, { owner: uid === OWNER_ID, chosen: feeds.chosen, ai: (await aiAccessOf(req)).source !== null,
      appleToken: feeds.appleHealth.token, sheetConnected: feeds.workoutLog.connected });
    return { facts, feeds, setup: setupSteps(facts, { today: q.localDate(clock()) }) };
  };
  /** The newest review's opening: the first two bullets of its first section, as plain text. */
  const reviewOpening = async () => {
    const latest = await db.prepare('SELECT week_ending, report_md FROM reviews WHERE user_id = @uid ORDER BY week_ending DESC LIMIT 1').get();
    if (!latest) return null;
    const first = String(latest.report_md).split(/^## /m)[1] ?? '';
    const lines = first.split('\n').filter((l) => /^\s*[-*] /.test(l)).slice(0, 2)
      .map((l) => l.replace(/^\s*[-*] /, '').replace(/\*\*|__|`/g, '').trim());
    return { weekEnding: latest.week_ending, section: first.split('\n')[0].trim() || null, lines };
  };
  app.get('/api/home', { schema: { summary: 'Home: the setup checklist (goals, profile, how data comes in, AI, first result) and a summary: today\'s check-in, current program, the latest review\'s opening, each feed\'s freshness, data issue count', response: { 200: anyObject } } }, async (req) => {
    const today = q.localDate(clock());
    const { facts, setup } = await setupOf(req);
    const chosen = facts.chosen ?? {};
    const program = await (async () => { try { return await currentProgram(db, today, await programCatalog(req)); } catch { return null; } })();
    const feedRows = [
      chosen.appleHealth || facts.owner ? { feed: 'appleHealth', latest: facts.apple.lastPost ?? facts.apple.latestDay ?? null, latestDay: facts.apple.latestDay } : null,
      chosen.workoutLog || facts.owner ? { feed: 'workoutLog', latest: facts.sheet.lastSync, problem: setup.steps.find((s) => s.id === 'data').ways.workoutLog.problem } : null,
      chosen.manual !== false ? { feed: 'manual', latest: facts.manual.lastCheckin } : null,
    ].filter(Boolean);
    return {
      setup,
      summary: {
        today,
        checkin: { done: Boolean(await db.prepare('SELECT 1 FROM checkins WHERE user_id = @uid AND date = ?').get(today)) },
        program: program ? { program: program.program, phase: program.phase ?? null, week: program.week ?? null, programWeeks: program.programWeeks ?? null } : null,
        latestReview: await reviewOpening(),
        feeds: feedRows,
        dataIssues: (await q.dataCheckWarnings(db, today, { apple: ingest.apple ?? 'drive', now: clock() })).length,
      },
    };
  });
  app.put('/api/account/setup', {
    schema: {
      summary: 'The setup checklist: skip or bring back a step, or hide the checklist',
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
        hidden: { type: 'boolean' }, dismiss: { type: 'string', enum: SETUP_STEPS }, restore: { type: 'string', enum: SETUP_STEPS } } },
      response: { 200: anyObject },
    },
  }, async (req) => {
    // Read the skipped steps and write them back in one transaction, so two changes at once keep both.
    await db.tx(async () => {
      const saved = await db.prepare("SELECT value FROM settings WHERE user_id = @uid AND key = 'setup_dismissed'").pluck().get();
      let list = [];
      try { list = JSON.parse(saved ?? '[]') ?? []; } catch { list = []; }
      const dismissed = new Set(list.filter((s) => SETUP_STEPS.includes(s)));
      if (req.body.dismiss) dismissed.add(req.body.dismiss);
      if (req.body.restore) dismissed.delete(req.body.restore);
      await putSetting('setup_dismissed', dismissed.size ? JSON.stringify([...dismissed]) : null);
      if (req.body.hidden !== undefined) await putSetting('setup_hidden', req.body.hidden ? '1' : null);
    });
    return { setup: (await setupOf(req)).setup };
  });
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
    await setClaudeKey(store.adb, uid, seal(req.body.key, uid, keyBox ?? boxKey()));
    log.info('[users] a Claude key was saved');
    return accountView(req);
  });
  // Your training goals: a primary and an optional secondary; they order the pages and frame the review (public/goals.js).
  const putSetting = (key, value) => (value === null
    ? db.prepare('DELETE FROM settings WHERE user_id = @uid AND key = ?').run(key)
    : db.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, clock().toISOString()));
  const goalValue = { type: ['string', 'null'], enum: [...GOAL_KEYS, null] };
  app.put('/api/account/goals', {
    schema: { summary: 'Your training goals: primary and an optional secondary (strength, cardio, weight, endurance, health), or null', body: { type: 'object', additionalProperties: false, required: ['primary'], properties: { primary: goalValue, secondary: goalValue } }, response: { 200: anyObject } },
  }, async (req) => {
    const g = cleanGoals(req.body);
    await db.tx(async () => {
      await putSetting('goal_primary', g.primary);
      await putSetting('goal_secondary', g.secondary);
    });
    return accountView(req);
  });
  // Supplement suggestions in the review, the chat and Help: on only with the statement accepted; a paused account may
  // turn them off but not on (the demo refuses every change).
  app.put('/api/account/supplement-advice', {
    schema: { summary: 'Turn supplement suggestions on (accept: true, after reading the statement) or off', body: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean' }, accept: { type: 'boolean' } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    if (req.body.on) {
      if (req.body.accept !== true) return reply.code(400).send({ error: 'Read and accept the statement to turn supplement suggestions on' });
      if (await isPaused(req)) return reply.code(403).send({ error: NO_AI.paused });
      await putSetting('supplement_advice', clock().toISOString());
    } else await putSetting('supplement_advice', null);
    return accountView(req);
  });

  // Your Home tile order (Arrange on Home); null goes back to the default.
  app.put('/api/account/tile-order', {
    schema: { summary: 'Your Home tile order (view names), or null for the default', body: { type: 'object', additionalProperties: false, required: ['tiles'], properties: { tiles: { type: ['array', 'null'], maxItems: 30, items: { type: 'string', enum: TILES } } } }, response: { 200: anyObject } },
  }, async (req) => {
    await putSetting('tile_order', req.body.tiles ? JSON.stringify([...new Set(req.body.tiles)]) : null);
    return accountView(req);
  });

  // The Training and Health tabs' order (Arrange on each tab): training cards, health cards, or health charts; null resets.
  app.put('/api/account/layout', {
    schema: {
      summary: 'Your order of the Training cards, the Health cards or the Health charts, or null for the default',
      body: { type: 'object', additionalProperties: false, required: ['area', 'order'], properties: {
        area: { type: 'string', enum: Object.keys(LAYOUT_ITEMS) }, order: { type: ['array', 'null'], maxItems: 40, items: { type: 'string', maxLength: 40 } } } },
      response: { 200: anyObject },
    },
  }, async (req) => {
    const { area, order } = req.body;
    if (order && order.some((x) => !LAYOUT_ITEMS[area].includes(x))) throw badRequest(`Unknown item for ${area}`);
    await putSetting(`layout_${area}`, order ? JSON.stringify([...new Set(order)]) : null);
    return accountView(req);
  });

  // ---- feedback, enhancement requests and bug reports (Help): kept for the administrator and emailed to them ----
  const FEEDBACK_KINDS = { feedback: 'Feedback', enhancement: 'Enhancement request', bug: 'Bug report' };
  // The administrator check is defined with the user administration below; this calls it when a request arrives.
  const adminOnlyHook = (req, reply) => adminOnly(req, reply);
  const feedbackTimes = new Map();
  const FEEDBACK_PER_HOUR = 5;
  app.get('/api/feedback', { schema: { summary: 'What you have sent, newest first, with its status', response: { 200: { type: 'array', items: anyObject } } } },
    async () => await db.prepare('SELECT id, kind, subject, status, created_at FROM feedback WHERE user_id = @uid ORDER BY created_at DESC LIMIT 50').all());
  app.post('/api/feedback', {
    schema: {
      summary: 'Send feedback, an enhancement request or a bug report to the administrator',
      body: { type: 'object', additionalProperties: false, required: ['kind', 'subject', 'body'], properties: {
        kind: { type: 'string', enum: Object.keys(FEEDBACK_KINDS) }, subject: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', minLength: 1, maxLength: 5000 },
        doing: { type: 'string', maxLength: 1000 }, screen: { type: 'string', maxLength: 40, pattern: '^[a-z-]*$' } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    if (authMode === 'demo') return reply.code(403).send({ error: 'Feedback is turned off in the demo' });
    if (await isPaused(req)) return reply.code(403).send({ error: 'Your account is paused; email the administrator instead' });
    const uid = uidOf(req);
    // A subject is one line: control characters (line breaks, tabs) become spaces, so it can never add an email header.
    const subject = req.body.subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    const body = req.body.body.trim();
    if (!subject || !body) throw badRequest('Add a subject and the details');
    const hourAgo = clock().getTime() - 3600_000;
    const recent = (feedbackTimes.get(uid) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= FEEDBACK_PER_HOUR) return reply.code(429).send({ error: `At most ${FEEDBACK_PER_HOUR} an hour; try again later` });
    feedbackTimes.set(uid, [...recent, clock().getTime()]);
    const context = { screen: req.body.screen || null, version: process.env.APP_VERSION || VERSION, browser: String(req.headers['user-agent'] ?? '').slice(0, 300) || null };
    const doing = req.body.doing?.trim() || null;
    const id = randomUUID();
    await db.prepare(`INSERT INTO feedback (user_id, id, kind, subject, body, context, status, created_at) VALUES (@uid, ?, ?, ?, ?, ?, 'new', ?)`)
      .run(id, req.body.kind, subject, doing ? `${body}\n\nWhat I was doing: ${doing}` : body, JSON.stringify(context), clock().toISOString());
    const u = await getUser(store.adb, uid);
    log.info(`[feedback] ${req.body.kind} received`);
    await mailer.send({ to: await adminEmail(), replyTo: u?.email, subject: `Health Review [${req.body.kind}] ${subject}`,
      text: `${FEEDBACK_KINDS[req.body.kind]} from ${u?.name || u?.email || 'a user'} <${u?.email ?? 'unknown'}>\n\n${subject}\n\n${body}${doing ? `\n\nWhat they were doing: ${doing}` : ''}\n\nScreen: ${context.screen ?? 'not given'} | App: ${context.version} | Browser: ${context.browser ?? 'unknown'}\n\nReply to this email to answer them. All feedback: ${appUrl()}/#users\n` });
    return { sent: true, id };
  });
  app.get('/api/admin/feedback', { onRequest: adminOnlyHook, schema: { summary: 'All feedback, newest first (administrators)', response: { 200: anyObject } } },
    async () => ({ items: await listFeedback(store.adb), newCount: await newFeedbackCount(store.adb) }));
  app.post('/api/admin/feedback/:id/status', {
    onRequest: adminOnlyHook,
    schema: { summary: 'Mark feedback new or done (administrators)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
      body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['new', 'done'] } } }, response: { 200: anyObject } },
  }, async (req, reply) => ((await setFeedbackStatus(store.adb, req.params.id, req.body.status)) ? { ok: true } : reply.code(404).send({ error: 'Not found' })));

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
  app.put('/api/account/time-zone', {
    schema: { summary: 'Set your time zone (an IANA name such as America/Chicago), or null for the server default', body: { type: 'object', additionalProperties: false, required: ['timeZone'], properties: { timeZone: { type: ['string', 'null'], maxLength: 64 } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    if (uidOf(req) === OWNER_ID) return reply.code(409).send({ error: "The owner's time zone comes from the server's settings (OWNER_TZ)" });
    const tz = req.body.timeZone;
    if (tz !== null && !isTimeZone(tz)) throw badRequest('Unknown time zone');
    if (tz === null) await db.prepare("DELETE FROM settings WHERE user_id = @uid AND key = 'time_zone'").run();
    else {
      await db.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'time_zone', ?, ?)
        ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(tz, clock().toISOString());
    }
    // This request began in the old zone; answer in the new one.
    return withTimeZone(tz ?? process.env.OWNER_TZ, () => accountView(req));
  });
  app.delete('/api/account/claude-key', { schema: { summary: 'Remove your Claude API key (no AI is used without one)', response: { 200: anyObject } } }, async (req) => {
    await setClaudeKey(store.adb, uidOf(req), null);
    return accountView(req);
  });

  // ---- your account (multi-user, phase 6): export, pause and resume yourself, delete ----
  const selfFlag = (uid) => scopeDatabase(store.adb, uid);
  const setSelfPaused = async (uid, on) => {
    const sdb = selfFlag(uid);
    if (on) {
      await sdb.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'paused_by_self', '1', ?)
        ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(clock().toISOString());
    } else {
      await sdb.prepare("DELETE FROM settings WHERE user_id = @uid AND key = 'paused_by_self'").run();
    }
  };
  const notOwner = async (req, reply, what) => {
    if (uidOf(req) !== OWNER_ID && await getUser(store.adb, uidOf(req))) return true;
    reply.code(409).send({ error: `The owner's account cannot be ${what} here` });
    return false;
  };
  app.get('/api/account/export', { schema: { summary: 'Everything stored for you, as one JSON file (never your sealed key, tokens or Google permission)', response: { 200: anyObject } } },
    async (req, reply) => {
      const data = await exportUserData(store.adb, uidOf(req), { now: clock() });
      if (!data) return reply.code(404).send({ error: 'No such account' });
      return reply.header('Content-Disposition', `attachment; filename="health-review-export-${q.localDate(clock())}.json"`).send(data);
    });
  app.post('/api/account/pause', { schema: { summary: 'Pause your account: posts, syncs and AI stop until you resume; your data stays', response: { 200: anyObject } } },
    async (req, reply) => {
      if (!(await notOwner(req, reply, 'paused'))) return reply;
      // The status check and both writes in one transaction, so a pause racing an administrator's change cannot mix them.
      const paused = await store.adb.tx(async () => {
        if ((await getUser(store.adb, uidOf(req)))?.status !== 'approved') return false;
        await setUserStatus(store.adb, uidOf(req), 'paused');
        await setSelfPaused(uidOf(req), true);
        return true;
      });
      if (!paused) return reply.code(409).send({ error: 'Your account is not active' });
      return accountView(req);
    });
  app.post('/api/account/resume', { schema: { summary: 'Resume your account after pausing it yourself (a pause by the administrator stays)', response: { 200: anyObject } } },
    async (req, reply) => {
      if (!(await notOwner(req, reply, 'resumed'))) return reply;
      // Paused by themselves (status paused and the flag set), checked and undone in one transaction.
      const resumed = await store.adb.tx(async () => {
        if ((await getUser(store.adb, uidOf(req)))?.status !== 'paused') return false;
        if (!(await selfFlag(uidOf(req)).prepare("SELECT 1 FROM settings WHERE user_id = @uid AND key = 'paused_by_self'").get())) return false;
        await setSelfPaused(uidOf(req), false);
        await setUserStatus(store.adb, uidOf(req), 'approved');
        return true;
      });
      if (!resumed) return reply.code(409).send({ error: 'Only the administrator can resume this account' });
      return accountView(req);
    });
  app.post('/api/account/delete', {
    schema: { summary: 'Delete your account and everything stored for you (confirm with your email); signs you out',
      body: { type: 'object', additionalProperties: false, required: ['confirmEmail'], properties: { confirmEmail: { type: 'string', maxLength: 320 } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    if (!(await notOwner(req, reply, 'deleted'))) return reply;
    const u = await getUser(store.adb, uidOf(req));
    if (String(req.body.confirmEmail).trim().toLowerCase() !== u.email) throw badRequest('Type your email exactly to confirm');
    await deleteAccount(u.id);
    reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure: appUrl().startsWith('https:') }));
    return { deleted: true };
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

  // ---- user administration (admin only, multi-user phase 4): account facts, never keys, tokens, sheet IDs or health data ----
  // Checked on request, after sign-in and before body validation, so a non-admin learns nothing about these routes.
  const isAdmin = (req) => authMode !== 'demo' && (req.role === 'admin' || (authMode === 'none' && uidOf(req) === OWNER_ID));
  const adminOnly = async (req, reply) => { if (!isAdmin(req)) return reply.code(403).send({ error: 'Administrators only' }); };
  // Weekly usage totals across all users (counts only: no user, entry date, value or text), the Users screen's card.
  // The response schema lists every field (additionalProperties false), so nothing else can be sent.
  const count = { type: 'integer' };
  const strict = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  const valueCounts = { type: 'array', items: strict({ value: { type: 'string' }, count }) };
  const usageSchema = strict({
    weeks: { type: 'array', items: strict({
      weekEnding: { type: 'string' }, activeUsers: count, reviews: strict({ completed: count, failed: count, skipped: count }),
      checkins: count, liftingDays: count, syncs: strict({ completed: count, failed: count }), spendUsd: { type: 'number' }, feedback: count,
    }) },
    visits: strict({ device: valueCounts, browser: valueCounts, location: strict({ countries: valueCounts, states: valueCounts, cities: valueCounts }) }),
    arrivals: valueCounts,
  });
  app.get('/api/admin/usage', {
    onRequest: adminOnly,
    schema: { summary: 'Usage totals across users (counts only): weekly activity, and for the same period visits by device and location and arrivals by source',
      querystring: { type: 'object', additionalProperties: false, properties: { weeks: { type: 'integer', minimum: 4, maximum: 52, default: 12 } } },
      response: { 200: usageSchema } },
  }, async (req) => {
    const weeks = await usageByWeek(store.adb, { weeks: req.query.weeks, now: clock() });
    const today = zonedDate(clock(), process.env.OWNER_TZ || DEFAULT_TZ);
    return { weeks, ...(await usageTotals(store.adb, { from: addDays(weeks.at(-1).weekEnding, -6), to: today })) };
  });
  app.get('/api/admin/users', { onRequest: adminOnly, schema: { summary: 'Every user (account facts only, never keys or health data), pending first', response: { 200: { type: 'array', items: anyObject } } } },
    async () => await listUsers(store.adb, { now: clock() }));
  const userIdParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } };
  app.post('/api/admin/users/:id/approve', { onRequest: adminOnly, schema: { summary: 'Approve a user: they get in, start from the default prompt sections, and get an email', params: userIdParams, response: { 200: anyObject } } }, async (req, reply) => {
    const u = await setUserStatus(store.adb, req.params.id, 'approved');
    if (!u) return reply.code(404).send({ error: 'No such user' });
    // Count, then add, in one transaction (agent/default-prompts.js adds only to an empty list).
    await store.adb.tx(() => addDefaultPromptSections(scopeDatabase(store.adb, u.id)));
    await mailer.send({ to: u.email, subject: "You're in: Health Review",
      text: `Your Health Review account is approved.\n\nOpen ${appUrl()} and sign in with this Google account. To use the AI weekly review and chat, add your own Claude API key in Settings (see https://docs.claude.com/en/api/getting-started). Everything else works without one.\n${supportLine}` });
    return await adminUser(u.id);
  });
  app.post('/api/admin/users/:id/reject', { onRequest: adminOnly, schema: { summary: 'Reject a pending user (or end access)', params: userIdParams, response: { 200: anyObject } } }, async (req, reply) => {
    const u = await setUserStatus(store.adb, req.params.id, 'rejected');
    if (!u) return reply.code(404).send({ error: 'No such user' });
    // Ending access also ends the owner's key for them, so approving them again never quietly restores it.
    if (u.uses_owner_key) { await setOwnerKey(store.adb, u.id, { on: false }); await clearCapNotice(store.adb, u.id); }
    return await adminUser(u.id);
  });
  // One user as the Users screen lists them (the same facts as GET /api/admin/users).
  const adminUser = async (id) => (await listUsers(store.adb, { now: clock() })).find((u) => u.id === id) ?? null;
  // A user these switches may change: exists, not an administrator, and in one of the given statuses. Sends the refusal
  // and returns null otherwise.
  const changeable = async (reply, id, statuses = ['approved', 'paused']) => {
    const u = await getUser(store.adb, id);
    const refuse = (code, error) => { reply.code(code).send({ error }); return null; };
    if (!u) return refuse(404, 'No such user');
    if (u.role === 'admin') return refuse(409, "An administrator's account is not changed here");
    if (!statuses.includes(u.status)) return refuse(409, `Not for a ${u.status} user`);
    return u;
  };
  // Pause: they can still sign in and see their data, but posts, syncs and AI stop. Resume turns them back on.
  for (const [action, from, to] of [['pause', 'approved', 'paused'], ['resume', 'paused', 'approved']]) {
    const summary = action === 'pause' ? 'Pause a user: posts, syncs, reviews and chat stop; they can still sign in and see their data' : 'Resume a paused user';
    app.post(`/api/admin/users/:id/${action}`, { onRequest: adminOnly, schema: { summary, params: userIdParams, response: { 200: anyObject } } }, async (req, reply) => {
      if (!(await changeable(reply, req.params.id, [from]))) return reply;
      await store.adb.tx(async () => {
        await setUserStatus(store.adb, req.params.id, to);
        await setSelfPaused(req.params.id, false); // the administrator's pause or resume: only the administrator resumes it
      });
      log.info(`[users] a user was ${to === 'paused' ? 'paused' : 'resumed'}`);
      return await adminUser(req.params.id);
    });
  }
  // Delete a user and everything stored for them, confirmed with their email (for a user who asks the administrator).
  app.post('/api/admin/users/:id/delete', {
    onRequest: adminOnly,
    schema: { summary: "Delete a user's account and all of their data (confirm with their email)", params: userIdParams,
      body: { type: 'object', additionalProperties: false, required: ['confirmEmail'], properties: { confirmEmail: { type: 'string', maxLength: 320 } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    const u = await getUser(store.adb, req.params.id);
    if (!u) return reply.code(404).send({ error: 'No such user' });
    if (u.role === 'admin') return reply.code(409).send({ error: "An administrator's account is not deleted here" });
    if (String(req.body.confirmEmail).trim().toLowerCase() !== u.email) throw badRequest("Type the user's email exactly to confirm");
    // The role is checked again inside the deletion's transaction.
    if (!(await deleteUserData(store.adb, u.id))) return reply.code(409).send({ error: "An administrator's account is not deleted here" });
    log.info('[users] a user and their data were deleted by the administrator');
    return { deleted: true };
  });
  // The administrator's Claude key for a user without their own: turned on only with their email typed to confirm and a
  // monthly cap in dollars; off in one step. The user gets an email either way.
  app.post('/api/admin/users/:id/owner-key', {
    onRequest: adminOnly,
    schema: {
      summary: "Pay for a user's AI with your Claude key up to a monthly cap (confirm with their email), or stop",
      params: userIdParams,
      body: { type: 'object', additionalProperties: false, required: ['on'], properties: {
        on: { type: 'boolean' }, cap: { type: 'number', minimum: OWNER_KEY_CAP.min, maximum: OWNER_KEY_CAP.max }, confirmEmail: { type: 'string', maxLength: 320 } } },
      response: { 200: anyObject },
    },
  }, async (req, reply) => {
    // Revoking is always allowed (any status, even rejected); turning it on needs an approved or paused user.
    const u = await changeable(reply, req.params.id, req.body.on ? ['approved', 'paused'] : ['pending', 'approved', 'paused', 'rejected']);
    if (!u) return reply;
    const { on, confirmEmail } = req.body;
    const cap = req.body.cap === undefined ? null : Math.round(req.body.cap * 100) / 100;
    if (on) {
      if (cap === null) throw badRequest(`A monthly cap from $${OWNER_KEY_CAP.min} to $${OWNER_KEY_CAP.max} is required`);
      if (String(confirmEmail ?? '').trim().toLowerCase() !== u.email) throw badRequest("Type the user's email exactly to confirm");
    }
    await setOwnerKey(store.adb, u.id, { on, cap: on ? cap : null });
    await clearCapNotice(store.adb, u.id);
    log.info(`[users] the owner's key was turned ${on ? 'on' : 'off'} for a user`);
    await mailer.send({ to: u.email, subject: on ? 'Health Review: AI turned on for you' : 'Health Review: AI allowance ended',
      text: on ? `The administrator turned on the AI weekly review and chat for you, up to $${cap.toFixed(2)} a month. Open ${appUrl()} to use them. If you add your own Claude API key in Settings, it is used instead.\n${supportLine}`
        : `The administrator's AI allowance for you has ended. To keep using the AI weekly review and chat, add your own Claude API key in Settings at ${appUrl()}.\n${supportLine}` });
    return await adminUser(u.id);
  });
  // Share the owner's MAPS catalog (family): their Advisor, phases and called-for comparisons use it; only computed facts
  // reach them, never the catalog's text.
  app.post('/api/admin/users/:id/maps', {
    onRequest: adminOnly,
    schema: { summary: 'Share your MAPS program catalog with a user, or stop', params: userIdParams,
      body: { type: 'object', additionalProperties: false, required: ['shared'], properties: { shared: { type: 'boolean' } } }, response: { 200: anyObject } },
  }, async (req, reply) => {
    const u = await changeable(reply, req.params.id);
    if (!u) return reply;
    await setMapsShared(store.adb, u.id, req.body.shared);
    log.info(`[users] the MAPS catalog was ${req.body.shared ? 'shared with' : 'unshared from'} a user`);
    return await adminUser(u.id);
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
    await db.tx(async () => {
      for (const [k, v] of Object.entries(req.body)) await (v === null ? remove.run(k) : upsert.run(k, String(v), new Date().toISOString()));
    });
    return loadProfile(db, today);
  });

  // The heart rate zone tops with the age defaults beside them (null without a birth year): Zone 2 at 60% to 70% of the
  // estimated maximum, and Zones 3 and 4 split from the saved Zone 2 top (or that default).
  const settingsView = async (s) => {
    const today = q.localDate(clock());
    const { birthYear, age } = await loadProfile(db, today);
    const maxHr = maxHrFor(birthYear, Number(today.slice(0, 4)));
    if (!maxHr) return { ...s, defaults: null };
    const z2 = zone2Default(maxHr);
    const zone2High = s.zone2_high_bpm ?? z2.high;
    const own = upperTops({ maxHr, zone2High });
    const z4 = upperTops({ maxHr, zone2High, zone3High: s.zone3_high_bpm });
    return { ...s, defaults: { age, maxHr, zone2_low_bpm: z2.low, zone2_high_bpm: z2.high, zone3_high_bpm: own.zone3High, zone4_high_bpm: z4.zone4High } };
  };

  app.get('/api/settings', { schema: { summary: 'Personal settings used by the metrics, with the age defaults of the heart rate zones', response: { 200: anyObject } } },
    async () => settingsView(await q.getSettings(db)));

  app.put('/api/settings', {
    schema: {
      summary: 'Update personal settings (null clears one; a cleared Zone 3 or 4 top takes its age default)',
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { zone2_low_bpm: bpm, zone2_high_bpm: bpm, zone3_high_bpm: bpm, zone4_high_bpm: bpm } },
      response: { 200: anyObject },
    },
  }, async (req) => {
    // Each zone's top above the one before, so every zone holds at least one bpm and none overlap (no gaps by design);
    // checked inside the save's transaction, so two saves at once cannot pass it together.
    const check = (next) => {
      const problem = zoneOrderProblem({ zone2Low: next.zone2_low_bpm, zone2High: next.zone2_high_bpm, zone3High: next.zone3_high_bpm, zone4High: next.zone4_high_bpm });
      if (problem) throw badRequest(problem);
    };
    return settingsView(await q.saveSettings(adb, req.body, { check }));
  });

  // ---- prompt sections ----
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
      const section = await q.updateSection(adb, req.params.id, req.body);
      return section ?? reply.code(404).send({ error: 'Section not found' });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw Object.assign(new Error('A section with that name already exists'), { statusCode: 409 });
      throw err;
    }
  });

  app.delete('/api/prompt/sections/:id', { schema: { summary: 'Delete a prompt section (a copy is kept)', params: idParams } }, async (req, reply) => {
    if (!(await q.deleteSection(adb, req.params.id))) return reply.code(404).send({ error: 'Section not found' });
    return reply.code(204).send();
  });

  app.get('/api/prompt/preview', { schema: { summary: 'The weekly review instructions as the model would receive them', response: { 200: anyObject } } },
    async () => await q.previewInstructions(db, q.localDate(clock())));

  if (publicDir && existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
  }
  return app;
}
