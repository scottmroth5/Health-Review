// Starts the Health Review UI: npm start, then open http://localhost:5188
// Locally AUTH_MODE=none binds to 127.0.0.1. On the server AUTH_MODE=google (or demo for the public demo) with HOST=0.0.0.0
// behind Caddy (TRUST_PROXY). Google sign-in for the sync loads on the first sync.
import { openHealthStore } from '../db/store.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { repoPath } from '../tools/paths.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { runSync, appleSource } from '../ingest/sync.js';
import { buildApp } from './app.js';
import { createReviewClaude, DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from '../agent/claude.js';
import { runReview } from '../agent/review.js';
import { assertSafeBinding, authSettings } from './auth.js';

const demo = process.env.HEALTH_INSTANCE === 'demo';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? (demo ? 5189 : 5188));
const settings = authSettings();
const authMode = settings.mode;
assertSafeBinding({ host, mode: authMode, settings });
// Behind Caddy: true, a hop count, or an address; unset means no proxy is trusted.
const trustProxy = (() => {
  const v = process.env.TRUST_PROXY;
  if (!v) return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : v;
})();
const auth = { settings };

const quiet = { info() {}, warn() {}, error() {} };
let store;
let app;
if (demo) {
  // The demo instance: made-up data in its own database (built from demo/generate.js when missing), the made-up
  // catalog and substitutions, its own log folder, and no Google sync, review or chat. Never opens data/health.db.
  const { DEMO_DB_PATH, buildDemoDatabase, loadDemoCatalog, DEMO_SUBSTITUTIONS_PATH } = await import('../demo/generate.js');
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(DEMO_DB_PATH)) buildDemoDatabase();
  store = openHealthStore(DEMO_DB_PATH);
  app = await buildApp({
    store, services: {}, publicDir: repoPath('server', 'public'), authMode, auth, trustProxy, instance: 'demo', features: { chat: false },
    catalog: loadDemoCatalog(), substitutions: JSON.parse(readFileSync(DEMO_SUBSTITUTIONS_PATH, 'utf8')),
  });
} else {
  store = openHealthStore();
  // The Claude client for the Next program chat and the manual review run, made on first use (needs ANTHROPIC_API_KEY in .env).
  const claude = (() => { let c; return () => (c ??= createReviewClaude()); })();
  const services = {
    sync: () => runSync({ store, source: createSheetsSource(getGoogleAuth()), logger: quiet }),
    claude,
    // The Reviews tab's "Run review now": the same call as npm run review, after the route's sync and data gate.
    review: ({ weekEnd, today }) => runReview({
      store, claude: claude(), weekEnd, today, logger: quiet,
      model: process.env.REVIEW_MODEL || DEFAULT_REVIEW_MODEL, effort: process.env.REVIEW_EFFORT || DEFAULT_REVIEW_EFFORT,
    }),
  };
  // Health Auto Export's posts (POST /api/ingest/*): on the server APPLE_SOURCE=rest and INGEST_TOKEN are set.
  const ingest = { token: process.env.INGEST_TOKEN || null, apple: appleSource() };
  app = await buildApp({ store, services, publicDir: repoPath('server', 'public'), authMode, auth, ingest, trustProxy, evalDir: repoPath('data', 'evals', 'review') });
}
await app.listen({ host, port });
console.log(`Health Review${demo ? ' (demo data)' : ''}: http://localhost:${port}  (API contract: http://localhost:${port}/api/openapi.json)`);

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
