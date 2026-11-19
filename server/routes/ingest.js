// Workouts logged in the app, the Excel Workout Log, and Health Auto Export REST ingest (moved from server/app.js, v3
// Phase 2 step 2, docs/adr/0012). register(app, ctx) adds these routes; ctx is what buildApp shares with every route
// module (server/app.js).
import * as q from '../queries.js';
import { addDays } from '../../metrics/stats.ts';
import { loadDictionary } from '../../metrics/dictionary.ts';
import { loadUserPrograms } from '../../metrics/load.ts';
import { WorkoutError, deleteWorkout, listWorkouts, saveWorkout, workoutSuggestions } from '../../ingest/app-workouts.js';
import { MAX_UPLOAD_BYTES, TEMPLATE_NAME, UploadError, ingestWorkbook, workoutTemplate } from '../../ingest/excel-upload.js';
import { XLSX_TYPE, XlsxError } from '../../tools/xlsx.ts';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRateLimiter } from '../security.js';
import { parseHealthJson } from '../../ingest/health-json.js';
import { parseWorkoutJson } from '../../ingest/parsers.js';
import { applyHealthDays, applyWorkouts } from '../../ingest/apply.js';
import { localStamp } from '../../tools/time.ts';
import { OWNER_ID, startUserRun, userByIngestToken } from '../../db/users.ts';
import { INGEST_BODY_LIMIT, INGEST_RATE_LIMIT, anyObject, badRequest } from './schemas.js';

/** @param {import('fastify').FastifyInstance} app @param {object} ctx  shared state and helpers from buildApp */
export async function register(app, ctx) {
  const {
    NO_AI, authMode, clock, db, dictionary, ingest, instance, isPaused, log, programCatalog, requireDate, store,
    uidOf, userStore,
  } = ctx;
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
    try { return await saveWorkout(db, requireDate(req.params.date), req.body, workoutCtx(req)); } catch (err) { return workoutError(reply, err); }
  });
  app.delete('/api/workouts/:date', { schema: { summary: "Delete the day's workout logged in the app", params: dateOnly, response: { 200: anyObject } } },
    async (req, reply) => ((await deleteWorkout(db, requireDate(req.params.date), workoutCtx(req))) ? { deleted: true } : reply.code(404).send({ error: 'No workout logged in the app that day' })));

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
    const run = await startUserRun(userStore(), 'workout-upload', { bytes: req.body.length }, { info() {}, warn() {}, error() {} });
    let result;
    try {
      result = await ingestWorkbook(db, req.body, workoutCtx(req));
    } catch (err) {
      if (!(err instanceof XlsxError || err instanceof UploadError)) { await run.finish('error', { error: err.name }); throw err; }
      await run.finish('error', { error: 'not_accepted' });
      return reply.code(400).send({ error: err.message });
    }
    await run.finish('ok', { years: result.years.length, exercises: result.exercises, sets: result.sets, notes: result.notes });
    log.info(`[upload] workout log ok years=${result.years.length} exercises=${result.exercises} sets=${result.sets}`);
    return result;
  });

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
    const user = owner ? null : await userByIngestToken(store.db, given);
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
    await store.tx(async () => {
      result = await applyHealthDays(db, { records: parsed.records, exportedThrough: new Map(parsed.records.map((r) => [r.date, at])), standHours: parsed.standHours }, received.toISOString());
    });
    return { days: result.days.length, standHours: parsed.standHours.length, warnings: parsed.warnings.length };
  });
  ingestRoute('workouts', "Health Auto Export's workouts (JSON, Version 2, with per-minute heart rate), stored like the Drive files", async (body, received) => {
    const parsed = parseWorkoutJson(body, { file: 'post' });
    await store.tx(() => applyWorkouts(db, parsed.records, parsed.samples, received.toISOString()));
    return { workouts: parsed.records.length, hrSamples: parsed.samples.length, warnings: parsed.warnings.length };
  });
}
