// The Health Review API and UI. Every route has a JSON schema; /api/openapi.json is the contract
// the UI (and any future backend) follows.
// Routes live in server/routes/<domain>.js (v3 Phase 2 step 2, docs/adr/0012); buildApp sets up the app, its hooks and
// sign-in, then hands each route module the shared state and helpers in ctx.
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth.js';
import { registerSecurityHeaders, registerRateLimits, errorReply, DEMO_REQUEST_LIMIT, analyticsConfig, siteHostname } from './security.js';
import * as q from './queries.js';
import { loadCatalog } from '../metrics/catalog.js';
import { userCatalog } from '../metrics/load.js';
import { costFromUsage } from '@scottmroth5/agent-core/pricing';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TZ, withTimeZone } from '../tools/time.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { scopeDatabase } from '../db/scope.js';
import { HEALTH_CONSENT_VERSION, OWNER_ID, getUser, recordHealthConsent, setGoogleToken, setUserFeeds, syncOwnerEmail, timeZoneOf, userByEmail } from '../db/users.js';
import { createPendingUser, deleteUserData } from './admin-queries.js';
import { createUsageTotals, hostnameOrNull } from './usage-totals.js';
import { createMailer } from '../tools/mail.js';
import { boxKey, seal } from '../tools/secret-box.js';
import { policyPage, supportEmailFrom } from './pages.js';
import { BLOCKED_PAGE, geoBlocker } from './geo.js';
import { VERSION, badRequest } from './routes/schemas.js';
import { register as platformRoutes } from './routes/platform.js';
import { register as healthRoutes } from './routes/health.js';
import { register as trainingRoutes } from './routes/training.js';
import { register as ingestRoutes } from './routes/ingest.js';
import { register as reviewsRoutes } from './routes/reviews.js';
import { register as healthRecordsRoutes } from './routes/health-records.js';
import { register as identityRoutes } from './routes/identity.js';
import { register as adminRoutes } from './routes/admin.js';

export { INGEST_BODY_LIMIT, INGEST_RATE_LIMIT } from './routes/schemas.js';

/**
 * /api/v1 (v3 Phase 2 step 3): the stable, versioned prefix for the same API. Fastify's rewriteUrl runs before routing
 * and before every hook, so a /api/v1 request is the /api request in every check (sign-in, same origin, the geo block,
 * rate limits, the demo's write refusal, usage totals, the user's scope): they all read the rewritten req.url.
 * Health Auto Export's ingest keeps its one permanent URL, /api/ingest/*, so /api/v1/ingest/* is not rewritten (404).
 * @param {{ url?: string }} req
 */
export function apiV1Alias(req) {
  const url = req.url ?? '/';
  if (!url.startsWith('/api/v1/') || url.startsWith('/api/v1/ingest/')) return url;
  return `/api/${url.slice('/api/v1/'.length)}`;
}

export const API_DESCRIPTION = 'Health tracking and a weekly review. Every path below is also served under /api/v1/ '
  + '(the stable, versioned prefix: /api/v1/status is /api/status), except Health Auto Export\'s ingest, which stays at '
  + '/api/ingest/*. Contract changes are listed in docs/api/CHANGELOG.md.';

/** Checks a Claude API key with Anthropic's free model list (the key goes only to Anthropic; nothing is logged). */
export async function anthropicKeyCheck(key) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    return r.ok;
  } catch {
    return false;
  }
}

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
  const app = Fastify({ logger, trustProxy, rewriteUrl: apiV1Alias });
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
  const requestDb = new AsyncLocalStorage();
  const currentHandles = () => {
    const scoped = requestDb.getStore();
    if (!scoped) throw new Error('No user for this request');
    return scoped;
  };
  const currentDb = () => currentHandles().db;
  const db = new Proxy({}, { get: (_, prop) => Reflect.get(currentDb(), prop) });
  // The store as the request's user sees it, for code that takes a store (the chat); tx is the shared one.
  const userStore = () => ({ ...store, db: currentDb() });
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
    openapi: { info: { title: 'Health Review API', version: '1.0.0', description: API_DESCRIPTION } },
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
  if (authMode === 'google' && auth.settings?.allowed?.[0]) await syncOwnerEmail(store.db, { OWNER_EMAIL: auth.settings.allowed[0] });
  const adminEmail = async () => process.env.ADMIN_EMAIL || (await getUser(store.db, OWNER_ID))?.email;
  const appUrl = () => auth.settings?.publicUrl || 'http://localhost:5188';
  // A registration: a pending user, and an email to the admin (names and addresses only).
  const registerUser = async ({ email, name, feeds, healthConsent = false }) => {
    // Exists, then create, in one transaction (the email is UNIQUE besides); the email goes after it.
    const created = await store.db.tx(async () => {
      if (await userByEmail(store.db, email)) return false;
      const u = await createPendingUser(store.db, { id: randomUUID(), email, name, healthConsentVersion: healthConsent ? HEALTH_CONSENT_VERSION : null });
      if (feeds) await setUserFeeds(store.db, u.id, JSON.stringify(feeds));
      return true;
    });
    if (!created) return;
    log.info('[users] new registration');
    await mailer.send({ to: await adminEmail(), subject: 'New Health Review registration',
      text: `${name ?? 'Someone'} <${email}> asked for access to Health Review.\n\nApprove or reject on the Users tile: ${appUrl()}/#users\n` });
  };
  // A user's own Google Sheets permission (read only): the refresh token is sealed to them; never logged or shown.
  const connectSheets = async ({ email, refreshToken }) => {
    const u = await userByEmail(store.db, email);
    if (!u) return;
    await setGoogleToken(store.db, u.id, seal(refreshToken, u.id, keyBox ?? boxKey()));
    log.info('[users] Google Sheets connected');
  };
  // "Create my Workout Log": a new sheet in their Drive (services.createWorkoutSheet, ingest/create-sheet.js), saved as
  // their Workout Log. Never the owner, whose Workout Log comes from the server's settings.
  const createSheet = async ({ email }) => {
    const u = await userByEmail(store.db, email);
    if (!u || u.id === OWNER_ID || u.status !== 'approved') throw new Error('not for this account');
    if (typeof services.createWorkoutSheet !== 'function') throw new Error('not available');
    const { id } = await services.createWorkoutSheet(u.id);
    const upsert = scopeDatabase(store.db, u.id).prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    await upsert.run('workout_log_sheet_id', id, clock().toISOString());
    // Remembered so each January's sync can add the new year's tab to this sheet (and only this one).
    await upsert.run('workout_log_created', id, clock().toISOString());
    log.info('[users] a Workout Log sheet was created');
  };
  // Deleting an account (Settings, or the one-time consent step): everything stored for them, and an email to the admin.
  const deleteAccount = async (uid) => {
    const u = await getUser(store.db, uid);
    // The role is checked again inside deleteUserData's transaction (null: an administrator, or already gone).
    if (!u || u.role === 'admin' || !(await deleteUserData(store.db, u.id))) return;
    log.info('[users] a user deleted their account');
    await mailer.send({ to: await adminEmail(), subject: 'Health Review: a user deleted their account',
      text: `${u.name || u.email} (${u.email}) deleted their Health Review account and its data. The server's update copies and disk snapshots keep a copy for up to 14 days, and the encrypted backups until they age out (about two months).\n` });
  };
  const recordConsent = async (uid) => {
    await recordHealthConsent(store.db, uid, clock());
    log.info('[users] health data consent given');
  };
  // Usage totals (server/usage-totals.js): the signed-in app only, never the demo or local mode. A signed-in browser
  // visit (the auth hook marked it; the app page or an API call, not files) counts once per account per owner day by
  // device and location; an arrival on the app page or the sign-in page counts by source. Only counts are kept, and a
  // failure here never touches the response.
  const counter = authMode === 'google' ? createUsageTotals({
    db: store.db, place: usage?.place ?? null, tz: process.env.OWNER_TZ || DEFAULT_TZ, now: clock,
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
  // Settles once the usage counts in flight are written: they run after the response is sent (the tests wait on it).
  app.decorate('usageIdle', async () => { await counter?.idle(); });
  registerAuth(app, { supportEmail: support, mode: authMode, settings: auth.settings, exchange: auth.exchange, now: auth.now, findUser: (email) => userByEmail(store.db, email), registerUser,
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
    timeZoneOf(store.db, uid).then((tz) => withTimeZone(tz, () => requestDb.run({ db: scopeDatabase(store.db, uid) }, done)), done);
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


  // ---- helpers more than one route module uses ----
  // The program catalog a request may use (metrics/load.js userCatalog): the user's own programs (phase 5), then the
  // owner's (MAPS) for the owner and for users the owner shares it with (users.maps_shared); theirs win a name clash.
  const ownerCatalog = () => (catalog === undefined ? loadCatalog() : catalog);
  const sharedCatalog = async (req) => {
    const uid = uidOf(req);
    return uid === OWNER_ID || (await getUser(store.db, uid))?.maps_shared ? ownerCatalog() : null;
  };
  const programCatalog = async (req) => userCatalog(db, await sharedCatalog(req));
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
  const isPaused = async (req) => (await getUser(store.db, uidOf(req)))?.status === 'paused';
  const selfFlag = (uid) => scopeDatabase(store.db, uid);
  const setSelfPaused = async (uid, on) => {
    const sdb = selfFlag(uid);
    if (on) {
      await sdb.prepare(`INSERT INTO settings (user_id, key, value, updated_at) VALUES (@uid, 'paused_by_self', '1', ?)
        ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(clock().toISOString());
    } else {
      await sdb.prepare("DELETE FROM settings WHERE user_id = @uid AND key = 'paused_by_self'").run();
    }
  };

  // What every route module may use (server/routes/<domain>.js register(app, ctx)).
  const ctx = {
    NO_AI, adminEmail, aiAccessOf, aiOn, aiReason, appUrl, authMode, clock, db, deleteAccount, demoAnalytics,
    dictionary, evalDir, features, ingest, instance, isPaused, keyBox, keyCheck, labRanges, log, mailer, noAi, price,
    programCatalog, requestAccessUrl, requireDate, requireNotFuture, reviewRunOf, schedule, selfFlag, services,
    setSelfPaused, sharedCatalog, store, substitutions, support, supportLine, syncing, targetConfig, uidOf, userStore,
  };
  await platformRoutes(app, ctx);
  await healthRoutes(app, ctx);
  await trainingRoutes(app, ctx);
  await ingestRoutes(app, ctx);
  await reviewsRoutes(app, ctx);
  await healthRecordsRoutes(app, ctx);
  await identityRoutes(app, ctx);
  await adminRoutes(app, ctx);

  if (publicDir && existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
  }
  return app;
}
