// Medications and supplements, doses, check-offs, impact, and labs (moved from server/app.js, v3 Phase 2 step 2,
// docs/adr/0012). register(app, ctx) adds these routes; ctx is what buildApp shares with every route module
// (server/app.js).
import * as q from '../queries.js';
import { TIMINGS } from '../../metrics/medications.js';
import { loadLabRanges } from '../../metrics/labs.js';
import { nullable, text, anyObject, dateParams, idParams } from './schemas.js';

/** @param {import('fastify').FastifyInstance} app @param {object} ctx  shared state and helpers from buildApp */
export async function register(app, ctx) {
  const { clock, db, labRanges, requireDate, requireNotFuture } = ctx;
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
    return reply.code(201).send(await q.addMedication(db, req.body));
  });

  app.put('/api/medications/:id', {
    schema: { summary: 'Edit name, type, purpose, prescribed or notes', params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: medDetails }, response: { 200: anyObject } },
  }, async (req) => await q.updateMedicationDetails(db, req.params.id, req.body));

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
  }, async (req) => await q.changeMedication(db, req.params.id, {
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
  }, async (req) => await q.stopMedication(db, req.params.id, { ...req.body, stopped_on: pastDate(req.body.stopped_on) }));

  app.post('/api/medications/:id/start', {
    schema: {
      summary: 'Start taking it again',
      params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['timings', 'started_on'], properties: { dose, ingredients, timings, started_on: dateField } },
      response: { 200: anyObject },
    },
  }, async (req) => await q.startMedication(db, req.params.id, { ...req.body, started_on: pastDate(req.body.started_on) }));

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
  }, async (req) => await q.combineMedications(db, req.body));

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
  }, async (req) => await q.saveDoses(db, pastDate(req.params.date), req.body.doses));

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
  }, async (req, reply) => reply.code(201).send(await q.addLabResult(db, { ...req.body, drawn_on: pastDate(req.body.drawn_on) })));

  app.put('/api/labs/results/:id', {
    schema: {
      summary: 'Correct a result (a sheet result becomes an app correction that sync keeps)',
      params: idParams,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { drawn_on: dateField, value: labValueField } },
      response: { 200: anyObject },
    },
  }, async (req) => await q.updateLabResult(db, req.params.id, { ...req.body, drawn_on: req.body.drawn_on ? pastDate(req.body.drawn_on) : undefined }));

  app.delete('/api/labs/results/:id', { schema: { summary: 'Delete a result added in the app, or undo a correction (restores the sheet value)', params: idParams } }, async (req, reply) => {
    await q.deleteLabResult(db, req.params.id);
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
  }, async (req) => await q.updateLabTest(db, req.params.id, req.body));
}
