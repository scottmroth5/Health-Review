// Every GET route's status and body for one store (the demo's made-up data), keyed by URL: compared across engines
// (test/cross-engine.test.js) and across database roles under row-level security (test/rls.test.js).
import { buildApp } from '../server/app.js';
import { loadDemoCatalog } from '../demo/generate.js';

export const TODAY = '2026-10-07';
export const PARAMS = { date: '2026-10-06', id: '1', metric: 'hrv_ms' };
export const QUERIES = {
  '/api/history': `?from=2024-01-01&to=${TODAY}`, '/api/training': '?view=all', '/api/vo2max': '?view=all',
  '/api/cardio-zones': '?view=1y', '/api/runs': '?limit=100', '/api/medications/checkoffs': '?weeks=52',
};
// Each view of the routes that take one, so every query behind them runs.
export const VIEWS = {
  '/api/training': ['week', 'month', '3m', '6m', 'year', '2y', '5y', 'all'].map((v) => `?view=${v}`),
  '/api/vo2max': ['90d', '1y', '2y', '5y', 'all'].map((v) => `?view=${v}`),
  '/api/cardio-zones': ['30d', '90d', '1y'].flatMap((v) => ['day', 'week', 'month'].map((g) => `?view=${v}&group=${g}`)),
};

/**
 * @param {object} store
 * @param {{ prefix?: string, onAnswer?: (route: { method: string, url: string }, url: string, res: object) => void }} [o]
 *   prefix: what replaces /api/ in each request (/api/v1/ for the versioned prefix); answers stay keyed by the /api/ URL.
 *   onAnswer: sees each route, the URL asked and the response (the contract test checks bodies against the document).
 */
export async function answers(store, { prefix = '/api/', onAnswer } = {}) {
  const catalog = loadDemoCatalog();
  const app = await buildApp({ store, clock: () => new Date(`${TODAY}T16:00:00Z`), catalog, log: { info() {}, warn() {}, error() {} } });
  const out = {};
  try {
    const gets = app.routeList.filter((r) => r.method === 'GET' && r.url.startsWith('/api/')).sort((a, b) => a.url.localeCompare(b.url));
    for (const r of gets) {
      for (const q of VIEWS[r.url] ?? [QUERIES[r.url] ?? '']) {
        const url = r.url.replace(/:(\w+)/g, (_, k) => PARAMS[k] ?? '1') + q;
        const res = await app.inject({ url: prefix + url.slice('/api/'.length), headers: { host: 'localhost:5188' } });
        onAnswer?.(r, url, res);
        out[url] = `${res.statusCode} ${res.body}`;
      }
    }
  } finally {
    await app.close();
  }
  return out;
}
