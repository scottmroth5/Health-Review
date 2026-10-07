// The Health Review API and UI. Every route has a JSON schema; /api/openapi.json is the contract
// the UI (and any future backend) follows.
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth.js';
import * as q from './queries.js';
import { TIMINGS } from '../metrics/medications.js';
import { VIEWS } from '../metrics/volume.js';
import { VO2_VIEWS } from '../metrics/vo2max.js';
import { repoPath } from '../tools/paths.js';
import { loadCatalog } from '../metrics/catalog.js';
import { loadDictionary } from '../metrics/dictionary.js';
import { loadSubstitutions } from '../metrics/load.js';
import { GOALS, MAX_WEIGHT } from '../metrics/advisor.js';
import { currentProgram } from '../ingest/program-blocks.js';

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

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * @param {object} ctx
 * @param {{ db: import('better-sqlite3').Database }} ctx.store
 * @param {{ sync?: () => Promise<object> }} [ctx.services]
 * @param {string} [ctx.publicDir]   static UI to serve; skipped when missing
 * @param {string} [ctx.authMode]
 * @param {() => Date} [ctx.clock]
 */
export async function buildApp({ store, services = {}, publicDir, authMode = 'none', clock = () => new Date(), logger = false, catalog, dictionary, substitutions, logDir = repoPath('data', 'logs') }) {
  const app = Fastify({ logger });
  const { db } = store;
  let syncing = false;

  await app.register(swagger, {
    openapi: { info: { title: 'Health Review API', version: '1.0.0', description: 'Local health tracking and weekly review' } },
  });
  registerAuth(app, { mode: authMode });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? (err.validation ? 400 : 500);
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 ? 'Server error' : err.message });
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

  app.get('/api/logs/:name', {
    schema: {
      summary: 'The last lines of a scheduled task log (sync, review or backup)',
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string', enum: q.LOG_NAMES } } },
      querystring: { type: 'object', properties: { lines: { type: 'integer', minimum: 1, maximum: 2000, default: 200 } } },
      response: { 200: { type: 'object', properties: { name: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } } } } },
    },
  }, async (req) => ({ name: req.params.name, lines: q.readLog(logDir, req.params.name, req.query.lines) }));

  app.get('/api/status', { schema: { summary: 'Today, the last sync, and data check warnings as of today (stale or missing Apple Health days, partial days, impossible values)', response: { 200: anyObject } } }, async () => {
    const today = q.localDate(clock());
    return { today, lastSync: q.lastSync(db), dataChecks: q.dataCheckWarnings(db, today) };
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
  const programCatalog = () => (catalog === undefined ? loadCatalog() : catalog);
  app.get('/api/program', {
    schema: {
      summary: 'The confirmed in-progress program block: week, phase, deload or failure week, expected end (program is null when none)',
      response: { 200: { type: 'object', properties: { program: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] } } } },
    },
  }, async () => ({ program: currentProgram(db, q.localDate(clock()), programCatalog()) }));

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
    catalog: programCatalog(),
    dictionary: dictionary ?? loadDictionary(),
    substitutions: substitutions ?? loadSubstitutions(),
    weights: Object.fromEntries(GOALS.map((g) => [g, req.query[g]])),
  }));

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

  // ---- sync ----
  app.post('/api/sync', { schema: { summary: 'Copy new rows from the Google Sheets now', response: { 200: anyObject } } }, async (req, reply) => {
    if (!services.sync) return reply.code(503).send({ error: 'Sync is not available in this server' });
    if (syncing) return reply.code(409).send({ error: 'A sync is already running' });
    syncing = true;
    try {
      const { counts, warnings } = await services.sync();
      return { counts, warnings: warnings.length };
    } finally {
      syncing = false;
    }
  });

  // ---- medications and supplements ----
  const dateField = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
  const timings = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: TIMINGS } };
  const dose = text(100);
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
          ...medDetails, dose, timings, started_on: dateField, stopped_on: nullable(dateField), stop_reason: text(200),
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
          dose, timings, effective_on: dateField,
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
      body: { type: 'object', additionalProperties: false, required: ['timings', 'started_on'], properties: { dose, timings, started_on: dateField } },
      response: { 200: anyObject },
    },
  }, async (req) => q.startMedication(db, req.params.id, { ...req.body, started_on: pastDate(req.body.started_on) }));

  app.delete('/api/medications/:id', { schema: { summary: 'Remove an entry added by mistake, with all its history', params: idParams } }, async (req, reply) => {
    if (!q.deleteMedication(db, req.params.id)) return reply.code(404).send({ error: 'Medication not found' });
    return reply.code(204).send();
  });

  app.put('/api/doses/:date', {
    schema: {
      summary: "Save the day's check-off: every listed slot is recorded taken or not",
      params: dateParams,
      body: {
        type: 'object', additionalProperties: false, required: ['doses'],
        properties: {
          doses: {
            type: 'array', maxItems: 200,
            items: {
              type: 'object', additionalProperties: false, required: ['medication_id', 'timing', 'taken'],
              properties: { medication_id: { type: 'integer', minimum: 1 }, timing: { type: 'string', enum: TIMINGS }, taken: { type: 'boolean' } },
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

  app.get('/api/medications/impact', {
    schema: { summary: 'Each start, change and stop with before and after averages (observational, not cause)', response: medList },
  }, async () => q.medicationImpact(db, q.localDate(clock())));

  // ---- labs ----
  const labValueField = { type: ['string', 'number'], maxLength: 50 };
  app.get('/api/labs', { schema: { summary: 'Lab tests by panel with their results, newest first', response: { 200: anyObject } } },
    async () => q.listLabs(db));

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
      summary: "Set a test's unit or panel",
      params: idParams,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { unit: text(40), panel: text(100) } },
      response: { 200: anyObject },
    },
  }, async (req) => q.updateLabTest(db, req.params.id, req.body));

  // ---- settings ----
  const bpm = nullable({ type: 'integer', minimum: 40, maximum: 220 });
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
