// Feedback (yours and the administrator's list), user administration and usage (moved from server/app.js, v3 Phase 2
// step 2, docs/adr/0012). register(app, ctx) adds these routes; ctx is what buildApp shares with every route module
// (server/app.js).
import { addDays } from '../../metrics/stats.ts';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TZ, localDate as zonedDate } from '../../tools/time.ts';
import { scopeDatabase } from '../../db/scope.ts';
import { OWNER_ID, getUser } from '../../db/users.ts';
import { deleteUserData, listFeedback, listUsers, newFeedbackCount, setFeedbackStatus, setMapsShared, setOwnerKey, setUserStatus, usageByWeek, usageTotals } from '../admin-queries.js';
import { OWNER_KEY_CAP, clearCapNotice } from '../ai-access.js';
import { addDefaultPromptSections } from '../../agent/default-prompts.js';
import { VERSION, anyObject, badRequest } from './schemas.js';

/** @param {import('fastify').FastifyInstance} app @param {object} ctx  shared state and helpers from buildApp */
export async function register(app, ctx) {
  const {
    adminEmail, appUrl, authMode, clock, db, isPaused, log, mailer, setSelfPaused, store, supportLine, uidOf,
  } = ctx;
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
    const u = await getUser(store.db, uid);
    log.info(`[feedback] ${req.body.kind} received`);
    await mailer.send({ to: await adminEmail(), replyTo: u?.email, subject: `Health Review [${req.body.kind}] ${subject}`,
      text: `${FEEDBACK_KINDS[req.body.kind]} from ${u?.name || u?.email || 'a user'} <${u?.email ?? 'unknown'}>\n\n${subject}\n\n${body}${doing ? `\n\nWhat they were doing: ${doing}` : ''}\n\nScreen: ${context.screen ?? 'not given'} | App: ${context.version} | Browser: ${context.browser ?? 'unknown'}\n\nReply to this email to answer them. All feedback: ${appUrl()}/#users\n` });
    return { sent: true, id };
  });
  app.get('/api/admin/feedback', { onRequest: adminOnlyHook, schema: { summary: 'All feedback, newest first (administrators)', response: { 200: anyObject } } },
    async () => ({ items: await listFeedback(store.db), newCount: await newFeedbackCount(store.db) }));
  app.post('/api/admin/feedback/:id/status', {
    onRequest: adminOnlyHook,
    schema: { summary: 'Mark feedback new or done (administrators)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } },
      body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['new', 'done'] } } }, response: { 200: anyObject } },
  }, async (req, reply) => ((await setFeedbackStatus(store.db, req.params.id, req.body.status)) ? { ok: true } : reply.code(404).send({ error: 'Not found' })));


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
    const weeks = await usageByWeek(store.db, { weeks: req.query.weeks, now: clock() });
    const today = zonedDate(clock(), process.env.OWNER_TZ || DEFAULT_TZ);
    return { weeks, ...(await usageTotals(store.db, { from: addDays(weeks.at(-1).weekEnding, -6), to: today })) };
  });
  app.get('/api/admin/users', { onRequest: adminOnly, schema: { summary: 'Every user (account facts only, never keys or health data), pending first', response: { 200: { type: 'array', items: anyObject } } } },
    async () => await listUsers(store.db, { now: clock() }));
  const userIdParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } };
  app.post('/api/admin/users/:id/approve', { onRequest: adminOnly, schema: { summary: 'Approve a user: they get in, start from the default prompt sections, and get an email', params: userIdParams, response: { 200: anyObject } } }, async (req, reply) => {
    const u = await setUserStatus(store.db, req.params.id, 'approved');
    if (!u) return reply.code(404).send({ error: 'No such user' });
    // Count, then add, in one transaction (agent/default-prompts.js adds only to an empty list).
    await store.db.tx(() => addDefaultPromptSections(scopeDatabase(store.db, u.id)));
    await mailer.send({ to: u.email, subject: "You're in: Health Review",
      text: `Your Health Review account is approved.\n\nOpen ${appUrl()} and sign in with this Google account. To use the AI weekly review and chat, add your own Claude API key in Settings (see https://docs.claude.com/en/api/getting-started). Everything else works without one.\n${supportLine}` });
    return await adminUser(u.id);
  });
  app.post('/api/admin/users/:id/reject', { onRequest: adminOnly, schema: { summary: 'Reject a pending user (or end access)', params: userIdParams, response: { 200: anyObject } } }, async (req, reply) => {
    const u = await setUserStatus(store.db, req.params.id, 'rejected');
    if (!u) return reply.code(404).send({ error: 'No such user' });
    // Ending access also ends the owner's key for them, so approving them again never quietly restores it.
    if (u.uses_owner_key) { await setOwnerKey(store.db, u.id, { on: false }); await clearCapNotice(store.db, u.id); }
    return await adminUser(u.id);
  });
  // One user as the Users screen lists them (the same facts as GET /api/admin/users).
  const adminUser = async (id) => (await listUsers(store.db, { now: clock() })).find((u) => u.id === id) ?? null;
  // A user these switches may change: exists, not an administrator, and in one of the given statuses. Sends the refusal
  // and returns null otherwise.
  const changeable = async (reply, id, statuses = ['approved', 'paused']) => {
    const u = await getUser(store.db, id);
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
      await store.db.tx(async () => {
        await setUserStatus(store.db, req.params.id, to);
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
    const u = await getUser(store.db, req.params.id);
    if (!u) return reply.code(404).send({ error: 'No such user' });
    if (u.role === 'admin') return reply.code(409).send({ error: "An administrator's account is not deleted here" });
    if (String(req.body.confirmEmail).trim().toLowerCase() !== u.email) throw badRequest("Type the user's email exactly to confirm");
    // The role is checked again inside the deletion's transaction.
    if (!(await deleteUserData(store.db, u.id))) return reply.code(409).send({ error: "An administrator's account is not deleted here" });
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
    await setOwnerKey(store.db, u.id, { on, cap: on ? cap : null });
    await clearCapNotice(store.db, u.id);
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
    await setMapsShared(store.db, u.id, req.body.shared);
    log.info(`[users] the MAPS catalog was ${req.body.shared ? 'shared with' : 'unshared from'} a user`);
    return await adminUser(u.id);
  });
}
