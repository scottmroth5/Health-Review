// Starts the Health Review UI: npm start, then open http://localhost:5188
// Local only (AUTH_MODE=none binds to 127.0.0.1). Google sign-in loads on the first sync.
import { openHealthStore } from '../db/store.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { repoPath } from '../tools/paths.js';
import { createSheetsSource } from '../ingest/sheets.js';
import { runSync } from '../ingest/sync.js';
import { buildApp } from './app.js';
import { createReviewClaude, DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_EFFORT } from '../agent/claude.js';
import { runReview } from '../agent/review.js';
import { assertSafeBinding } from './auth.js';

const demo = process.env.HEALTH_INSTANCE === 'demo';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? (demo ? 5189 : 5188));
const authMode = process.env.AUTH_MODE ?? 'none';
assertSafeBinding({ host, mode: authMode });

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
    store, services: {}, publicDir: repoPath('server', 'public'), authMode, instance: 'demo', features: { chat: false },
    catalog: loadDemoCatalog(), substitutions: JSON.parse(readFileSync(DEMO_SUBSTITUTIONS_PATH, 'utf8')), logDir: repoPath('data', 'demo', 'logs'),
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
  app = await buildApp({ store, services, publicDir: repoPath('server', 'public'), authMode, evalDir: repoPath('data', 'evals', 'review') });
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
