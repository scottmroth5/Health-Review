// Schema pieces and constants the route modules share (moved from server/app.js, v3 Phase 2 step 2, docs/adr/0012).
import { readFileSync } from 'node:fs';
import * as q from '../queries.js';
import { repoPath } from '../../tools/paths.js';

/** Health Auto Export's posts: the largest daily workout file is about 165 KB, so 5 MB holds weeks of them. */
export const INGEST_BODY_LIMIT = 5 * 1024 * 1024;
export const INGEST_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 30 };

export const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
export const scale = nullable({ type: 'integer', minimum: 1, maximum: 10 });
export const count = { type: 'integer', minimum: 0, maximum: 50 };
export const text = (maxLength) => nullable({ type: 'string', maxLength });
export const anyObject = { type: 'object', additionalProperties: true };
export const dateParams = { type: 'object', required: ['date'], properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } };
export const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

export const checkinBody = {
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

export const drinkingBody = {
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

export const sectionFields = {
  position: { type: 'integer', minimum: 0, maximum: 999 },
  name: { type: 'string', minLength: 1, maxLength: 60, pattern: '^[A-Za-z0-9 _-]+$' },
  text: { type: 'string', maxLength: 50000 },
  sensitive: { type: 'boolean' },
};

export const VERSION = JSON.parse(readFileSync(repoPath('package.json'), 'utf8')).version;

export const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
