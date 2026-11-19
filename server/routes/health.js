// One day (check-ins and drinks), history, VO2 max, cardio zones, targets, profile and settings (moved from
// server/app.js, v3 Phase 2 step 2, docs/adr/0012). register(app, ctx) adds these routes; ctx is what buildApp shares
// with every route module (server/app.js).
import * as q from '../queries.js';
import { VO2_VIEWS } from '../../metrics/vo2max.ts';
import { loadTargets, loadProfile } from '../../metrics/load.ts';
import { loadTargetConfig } from '../../metrics/targets.ts';
import { maxHrFor, upperTops, zone2Default, zoneOrderProblem } from '../public/zone-defaults.js';
import { nullable, anyObject, dateParams, checkinBody, drinkingBody, badRequest } from './schemas.js';

/** @param {import('fastify').FastifyInstance} app @param {object} ctx  shared state and helpers from buildApp */
export async function register(app, ctx) {
  const { clock, db, requireDate, requireNotFuture, targetConfig } = ctx;
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
    return settingsView(await q.saveSettings(db, req.body, { check }));
  });

  // ---- prompt sections ----
}
